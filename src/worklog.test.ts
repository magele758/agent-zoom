import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readHubDay, WorklogStore } from "./server/worklog.ts";

const day = "2026-11-18";
function report(title = "修复过滤条件", state = "doing") {
  const card = { key: "opaque/personal/path/1", title, project: "上游提示", desc: "private-message" };
  return { date: day, generated_by: "agent-hub", sessions: ["private-message"], taskboard: { date: day, mainlines: [
    { name: "公开项目", tasks: { [state]: [card, { ...card, key: "hidden", local_only: true }], other: [{ ...card, key: "other" }] } },
    { name: "private-message", local_only: true, tasks: { done: [card] } },
  ] } };
}
test("Hub 只读取所选日期公开摘要，拒绝异常来源、日期、重复标识和符号链接", async t => {
  const dir = await mkdtemp(join(tmpdir(), "opc-worklog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, day + ".json");
  const data = report();
  await writeFile(file, JSON.stringify(data));
  const result = await readHubDay(dir, day);
  assert.equal(result.records.length, 1);
  const [item] = result.records;
  assert.match(item.key, /^[a-f0-9]{64}$/);
  assert.deepEqual(item, { key: item.key, title: "修复过滤条件", mainline: "公开项目", projectHint: "上游提示", state: "doing" });
  assert.doesNotMatch(JSON.stringify(result), /private-message|personal.path/);
  for (const date of ["latest", "../2026-11-18", "2026-02-30", "2026-1-1"]) await assert.rejects(readHubDay(dir, date));
  await assert.rejects(readHubDay(dir, "2026-11-17"), { code: "hub_day_missing" });
  await symlink(file, join(dir, "2026-11-16.json"));
  await assert.rejects(readHubDay(dir, "2026-11-16"), { code: "hub_file" });
  await writeFile(file, JSON.stringify({ ...data, generated_by: "unexpected" }));
  await assert.rejects(readHubDay(dir, day), { code: "hub_format" });
  await writeFile(file, JSON.stringify({ ...data, taskboard: { ...data.taskboard, date: "2026-11-17" } }));
  await assert.rejects(readHubDay(dir, day), { code: "hub_format" });
  await writeFile(file, JSON.stringify({ ...data, taskboard: { date: day, mainlines: [data.taskboard.mainlines[0], data.taskboard.mainlines[0]] } }));
  await assert.rejects(readHubDay(dir, day), { code: "hub_duplicate" });
});
test("重读与重试沿用人工关联，每日记录可以显式改归属，无任务副作用", async t => {
  const dir = await mkdtemp(join(tmpdir(), "opc-worklog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, day + ".json");
  await writeFile(file, JSON.stringify(report()));
  const db = new DatabaseSync(join(dir, "store.db"));
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE company_projects(product TEXT, name TEXT, PRIMARY KEY(product,name));
    CREATE TABLE opc_lines(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY);
    INSERT INTO company_projects VALUES ('一个产品','研发'),('另一个产品','经营');
    INSERT INTO opc_lines VALUES ('store','店铺');`);
  const store = new WorklogStore(db, dir);
  const record = (await store.day(day)).records[0];
  const old = { product: "一个产品", project: "研发", lineId: null };
  const next = { product: "另一个产品", project: "经营", lineId: "store" };
  const source = { date: day, key: record.key };
  assert.equal(store.index().bindings.length, 0);
  await assert.rejects(store.bind({ ...source, ...next, project: "不自动创建" }), { code: "worklog_target" });
  const created = await store.bind({ ...source, ...old });
  assert.deepEqual(await store.bind({ ...source, ...old }), created);
  await writeFile(file, JSON.stringify(report("原看板已改标题", "done")));
  assert.equal((await store.day(day)).records[0].state, "done");
  const restarted = new WorklogStore(db, dir);
  assert.deepEqual(restarted.index().bindings, [created]);
  await assert.rejects(restarted.bind({ ...source, ...next }), { code: "worklog_stale" });
  const changed = await restarted.bind({ ...source, ...next, previous: old });
  assert.equal(changed.title, "修复过滤条件");
  assert.equal(changed.lineId, "store");
  assert.deepEqual(restarted.index().bindings, [changed]);
  assert.equal(restarted.index().hubOrigin, "http://127.0.0.1:28790");
  assert.equal(db.prepare("SELECT count(*) n FROM tasks").get()?.n, 0);
  await assert.rejects(store.bind({ ...source, key: "f".repeat(64), ...next }), { code: "hub_item_changed" });
  assert.throws(() => restarted.unbind({ ...source, previous: old }), { code: "worklog_stale" });
  assert.deepEqual(restarted.unbind({ ...source, previous: next }), { removed: true });
  assert.deepEqual(restarted.index().bindings, []);
  assert.deepEqual(restarted.unbind({ ...source, previous: next }), { removed: false });
});
