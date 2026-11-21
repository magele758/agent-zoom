import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { ApiError } from "./server/logic.ts";
import { currentReading } from "./resource-department-types.ts";
import { readHubResources, registerResourceDepartmentRoutes, ResourcePlanStore } from "./server/resource-department.ts";

test("套餐的零余额、未知值、不同单位和费用在重开后可核对；重复请求与冲突受控", t => {
  const dir = mkdtempSync(join(tmpdir(), "opc-resource-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.db");
  const db = new DatabaseSync(file);
  const store = new ResourcePlanStore(db);
  const id = randomUUID();
  const draft = {
    revision: 0, name: "测试套餐", window: "周", unit: "tokens", capacity: 1000,
    reportedRemaining: 0, observedAt: "2020-08-01T00:00:00Z", resetsAt: "2020-08-08T00:00:00Z",
    renewsOn: "2020-08-10", fee: 3.5, currency: "cny", billingCycle: "monthly",
  };
  const first = store.save(id, draft);
  assert.equal(first.revision, 1);
  assert.equal(first.currency, "CNY");
  assert.equal(first.fee, 3.5);
  assert.deepEqual(store.save(id, draft), first);
  assert.deepEqual(currentReading(first, Date.parse("2020-08-05")), { state: "observed", remaining: 0 });
  assert.deepEqual(currentReading(first, Date.parse("2020-08-08")), { state: "reset", remaining: null });
  const changed = { ...draft, revision: 1, reportedRemaining: null, unit: "CNY", capacity: null };
  const second = store.save(id, changed);
  assert.equal(second.revision, 2);
  assert.deepEqual(store.save(id, changed), second);
  assert.deepEqual(currentReading(second, Date.parse("2020-08-05")), { state: "unknown", remaining: null });
  assert.throws(() => store.save(id, { ...draft, revision: 1 }), { code: "resource_plan_conflict" });
  assert.throws(() => store.save(id, { ...draft, unit: "%", reportedRemaining: 101 }), { code: "resource_plan_capacity" });
  assert.throws(() => store.save(id, { ...draft, currency: null }), { code: "resource_plan_fee" });
  assert.throws(() => store.save(id, { ...draft, observedAt: null }), { code: "resource_plan_observation" });
  assert.throws(() => store.save(id, { ...draft, reportedRemaining: -1 }), { code: "resource_plan_input" });
  db.close();
  const reopened = new DatabaseSync(file);
  try { assert.deepEqual(new ResourcePlanStore(reopened).list(), [second]); }
  finally { reopened.close(); }
});

test("只投影 Hub 额度与费用快照；重置时将旧值移出余量，保留来源日期", t => {
  const dir = mkdtempSync(join(tmpdir(), "opc-hub-quota-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db");
  assert.deepEqual(readHubResources(file), { generatedAt: null, tools: [], fees: [], feesAvailable: false });
  assert.equal(existsSync(file), false);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)");
  const now = 1700000000;
  const snapshot = { generated_at: now, tools: [
    { name: "供应商", tool: "tool", plan: "新套餐", status: "ok", live: false, snapshot_at: now, reason: "private detail",
      windows: [{ name: "5h", remaining_pct: 0, resets_at: now + 7200, secret: "private detail" },
        { name: "月", remaining_pct: null, resets_at: now + 86400 }] },
    { name: "网关", tool: "gateway", status: "not_applicable", windows: [] },
  ] };
  const set = db.prepare("INSERT OR REPLACE INTO meta VALUES(?,?)");
  set.run("quota_latest", JSON.stringify(snapshot));
  set.run("cost_meta", JSON.stringify({ plans: [
    { tool: "tool", plan: "历史套餐名", monthly_usd: 15, paid: true, checked: "2020-01-02", note: "private detail" },
  ], unrelated: "private detail" }));
  const result = readHubResources(file);
  assert.equal(result.feesAvailable, true);
  assert.equal(result.fees[0].plan, "历史套餐名");
  assert.equal(result.tools[0].plan, "新套餐");
  assert.equal(result.tools[1].applicable, false);
  assert.doesNotMatch(JSON.stringify(result), /private detail/);
  const [reading, missing] = result.tools[0].windows;
  assert.deepEqual(currentReading(reading, now * 1000, true), { remaining: 0, state: "observed" });
  assert.deepEqual(currentReading(reading, (now + 3601) * 1000, true), { remaining: 0, state: "stale" });
  assert.deepEqual(currentReading(reading, (now + 7200) * 1000, true), { remaining: null, state: "reset" });
  assert.deepEqual(currentReading(missing, now * 1000, true), { remaining: null, state: "unknown" });
  const codex = { tool: "codex", name: "Codex", status: "ok", snapshot_at: now, windows: [] };
  function balances(extra: unknown, tool = "codex") {
    set.run("quota_latest", JSON.stringify({ generated_at: now, tools: [{ ...codex, tool, extra }] }));
    return readHubResources(file).tools[0].balances;
  }
  const [credits, resets] = balances({ credits_balance: "0", reset_credits_available: 2, note: "private detail" });
  assert.equal(credits.unit, "credits");
  assert.deepEqual(currentReading(credits, (now + 3601) * 1000, true), { remaining: 0, state: "stale" });
  assert.equal(resets.unit, "次");
  assert.deepEqual(currentReading(resets, now * 1000, true), { remaining: 2, state: "observed" });
  assert.deepEqual(balances({ credits_balance: " ", reset_credits_available: -1 }), []);
  assert.deepEqual(balances({ credits_balance: false, reset_credits_available: 1.5 }), []);
  assert.equal(balances({ credits_balance: "12.75" })[0].reportedRemaining, 12.75);
  assert.equal(balances({ reset_credits_available: 0 })[0].reportedRemaining, 0);
  assert.deepEqual(balances({ prepaid_balance: 80 }, "grok-build"), []);
  set.run("quota_latest", "bad json");
  assert.deepEqual(readHubResources(file).tools, []);
  assert.equal(readHubResources(file).fees.length, 1);
});

test("额度采集需要登录和明确的 JSON 操作，合并并发请求，预览和自定义库无法启动采集", async t => {
  const directory = mkdtempSync(join(tmpdir(), "opc-quota-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = ["KUNLUN_PREVIEW", "DEMO_MODE", "OPC_HUB_QUOTA_DB", "AGENT_HUB_HOME"];
  for (const key of env) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  process.env.AGENT_HUB_HOME = join(directory, "wrong-hub");
  const file = join(directory, "hub.db");
  const fixtures = new DatabaseSync(file);
  fixtures.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)");
  fixtures.close();
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  mkdirSync(join(directory, "bin"));
  const collector = join(directory, "bin", "agent-hub");
  const mode = join(directory, "mode");
  writeFileSync(collector, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.slice(2).join(",") !== "quota" || fs.realpathSync(process.env.AGENT_HUB_HOME) !== fs.realpathSync(process.cwd())) process.exit(2);
fs.appendFileSync("calls", "1");
console.error("private fixture details");
setTimeout(() => {
  const mode = fs.readFileSync("mode", "utf8");
  if (mode === "failure") process.exit(2);
  if (mode === "noop") return;
  const db = new (require("node:sqlite").DatabaseSync)("hub.db");
  const t = Date.now() / 1000;
  const tool = {name:"Plan",tool:"plan",status:"ok",snapshot_at:mode === "stale" ? t-86400:t,windows:[{name:"周",remaining_pct:0,resets_at:t+86400}]};
  db.prepare("INSERT OR REPLACE INTO meta VALUES('quota_latest',?)").run(JSON.stringify({generated_at:t,tools:[tool,{...tool,tool:"error",status:"error"}]}));
  db.close();
}, 100);
`, { mode: 0o700 });
  const base = "/api/opc/departments/resources";
  function instance() {
    const app = new Hono();
    app.onError((e, c) => e instanceof ApiError
      ? c.json({ error: e.code, message: e.message }, e.status as 400)
      : c.json({ error: "unexpected" }, 500));
    registerResourceDepartmentRoutes(app, db, c => {
      if (c.req.header("cookie") !== "session=fixture") throw new ApiError(401, "auth", "未登录");
    }, directory);
    return app;
  }
  const app = instance();
  const asUser = { cookie: "session=fixture" };
  const options = { method: "POST", body: "{}", headers: { ...asUser, "content-type": "application/json" } };
  assert.equal((await (await app.request(base, { headers: asUser })).json()).canCollect, true);
  assert.equal((await app.request(base + "/collect", { ...options, headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await app.request(base + "/collect", { ...options, headers: asUser })).status, 400);
  assert.equal((await app.request(base + "/collect", { ...options, body: '{"command":"custom"}' })).status, 400);
  assert.equal(existsSync(join(directory, "calls")), false);

  writeFileSync(mode, "fresh");
  const [one, two] = await Promise.all(Array.from({ length: 2 }, () => app.request(base + "/collect", options)));
  assert.equal(one.status, 200);
  const result = await one.json();
  assert.deepEqual(result, await two.json());
  assert.equal(result.snapshotUpdated, true);
  assert.equal(result.recentReadings, 1);
  assert.equal(result.hub.tools[0].windows[0].reportedRemaining, 0);
  assert.deepEqual(result.hub.tools[1].windows, []);
  assert.equal(readFileSync(join(directory, "calls"), "utf8"), "1");

  writeFileSync(mode, "noop");
  assert.equal((await (await app.request(base + "/collect", options)).json()).snapshotUpdated, false);
  writeFileSync(mode, "stale");
  const stale = await (await app.request(base + "/collect", options)).json();
  assert.equal(stale.snapshotUpdated, true);
  assert.equal(stale.recentReadings, 0);
  writeFileSync(mode, "failure");
  const failure = await app.request(base + "/collect", options);
  assert.equal(failure.status, 502);
  assert.doesNotMatch(await failure.text(), /private fixture/);
  const callsBefore = readFileSync(join(directory, "calls"), "utf8");
  process.env.KUNLUN_PREVIEW = "1";
  const preview = instance();
  delete process.env.KUNLUN_PREVIEW;
  process.env.OPC_HUB_QUOTA_DB = join(directory, "elsewhere.db");
  const custom = instance();
  for (const isolated of [preview, custom]) {
    assert.equal((await (await isolated.request(base, { headers: asUser })).json()).canCollect, false);
    assert.equal((await isolated.request(base + "/collect", options)).status, 409);
  }
  assert.equal(readFileSync(join(directory, "calls"), "utf8"), callsBefore);
});

test("实时采集暂不可用时自动回退 quota_snapshots 未过期窗口，推导月账期并脱敏归类诊断码", t => {
  const dir = mkdtempSync(join(tmpdir(), "opc-hub-fallback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE quota_snapshots(
      tool TEXT, window TEXT, snapshot_at REAL, collected_at REAL, kind TEXT,
      used_pct REAL, resets_at REAL, window_minutes INTEGER, plan TEXT, status TEXT, source TEXT, extra TEXT
    );
    CREATE TABLE sessions(agent TEXT, day TEXT, tokens INTEGER);
    CREATE TABLE cost_daily(day TEXT, tool TEXT, calls INTEGER);
    CREATE TABLE cost_platform_snapshots(tool TEXT, snapshot_at REAL, metric TEXT, value_usd REAL);
  `);
  const nowSec = Math.floor(Date.parse("2026-11-21T03:00:00Z") / 1000);
  db.prepare("INSERT INTO meta VALUES(?,?)").run("cost_meta", JSON.stringify({
    plans: [
      { tool: "cursor", plan: "Cursor Ultra", monthly_usd: 200, paid: true },
      { tool: "antigravity", plan: "Google AI Pro", monthly_usd: 19.99, paid: true },
    ],
  }));
  db.prepare("INSERT INTO meta VALUES(?,?)").run("quota_latest", JSON.stringify({
    generated_at: nowSec,
    tools: [
      { tool: "cursor", name: "Cursor", plan: "ultra", status: "error", reason: "usage-summary HTTP 401 secret-cookie-value", windows: [] },
      { tool: "antigravity", name: "Antigravity", status: "unavailable", reason: "language_server offline secret-path", windows: [] },
    ],
  }));

  const ins = db.prepare("INSERT INTO quota_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  // Antigravity: 1 unexpired weekly window + 1 expired 5h window
  ins.run("antigravity", "Gemini 周", nowSec - 7200, nowSec - 7200, "weekly", 12.01, nowSec + 5 * 86400, 10080, "Google AI Ultra", "ok", "ls", null);
  ins.run("antigravity", "Gemini 5h", nowSec - 7200, nowSec - 7200, "5h", 4.5, nowSec - 600, 300, "Google AI Ultra", "ok", "ls", null);
  // Cursor: last snapshot cycle ended 2 days ago (2026-11-19) -> should infer next monthly cycle 2026-12-19
  const prevCycleEnd = Math.floor(Date.parse("2026-11-19T02:19:53Z") / 1000);
  ins.run("cursor", "Auto / Cursor 模型池", prevCycleEnd - 20 * 86400, prevCycleEnd - 20 * 86400, "monthly", 45.1, prevCycleEnd, null, "ultra", "ok", "api", null);

  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run("antigravity", "2026-11-20", 2500000);
  db.prepare("INSERT INTO cost_daily VALUES(?,?,?)").run("2026-11-20", "antigravity", 120);
  db.prepare("INSERT INTO cost_daily VALUES(?,?,?)").run("2026-11-20", "cursor", 0);
  db.prepare("INSERT INTO cost_platform_snapshots VALUES(?,?,?,?)").run("cursor", prevCycleEnd - 86400, "usage_total", 1361.55);

  const hub = readHubResources(file, nowSec * 1000);
  assert.doesNotMatch(JSON.stringify(hub), /secret-cookie-value|secret-path/);
  const cursor = hub.tools.find(item => item.tool === "cursor")!;
  const agy = hub.tools.find(item => item.tool === "antigravity")!;

  assert.equal(cursor.diagnostic, "auth_expired");
  assert.deepEqual(cursor.windows, []);
  assert.equal(cursor.usage?.monthlyUsd, 200);
  assert.equal(cursor.usage?.cycleCalls, 0);
  assert.equal(cursor.usage?.lastCycleUsedUsd, 1361.55);
  assert.ok(cursor.usage?.cycleResetAt?.startsWith("2026-12-19"));

  assert.equal(agy.plan, "Google AI Ultra");
  assert.equal(agy.fromHistory, true);
  assert.equal(agy.diagnostic, "local_server_offline");
  assert.equal(agy.windows.length, 1);
  assert.equal(agy.windows[0].name, "Gemini 周");
  assert.equal(agy.windows[0].reportedRemaining, 87.99);
  assert.equal(agy.usage?.sessions7d, 1);
  assert.equal(agy.usage?.calls7d, 120);
});
