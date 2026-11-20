import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "./server/http.ts";
import { openStore } from "./server/logic.ts";
import { StageHomeService } from "./server/stage-home.ts";
import { StageHomeClient, type HomeTask } from "./server/stage-home-client.ts";
import { StageWorkStore } from "./server/stage-work.ts";

async function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kunlun-stage-home-"));
  const dbFile = join(directory, "test.db");
  const store = openStore(dbFile);
  const work = new StageWorkStore(store.db);
  const state = { failSend: "", denyBots: false, status: "queued", posts: 0, reads: 0, pages: 0 };
  const tasks = new Map<string, HomeTask>();
  const requests = new Map<string,string>();
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const reply = (status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    assert.equal(req.headers.authorization, "Bearer fixture-only");
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname === "/api/bot-work/status") {
      if (state.denyBots) return reply(403, {});
      return reply(200, { bots: [{ bot: { id: "bot-1", name: "研究员" }, control: {} },
        { bot: { id: "bot-2", name: "已暂停" }, control: { paused: true } },
        { bot: { id: "bot-3", name: "隐藏", hidden: true } }] });
    }
    if (url.pathname === "/api/bot-work/tasks" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      state.posts++;
      if (state.failSend === "before") return reply(503, {});
      let key = requests.get(input.idempotencyKey);
      if (!key) {
        key = "btask-" + (tasks.size + 1); requests.set(input.idempotencyKey, key);
        tasks.set(key, { id: key, targetBotId: input.targetBotId, input: input.input, status: state.status,
          attempt: 1, updatedAt: new Date().toISOString() });
      }
      if (state.failSend === "after") return reply(503, {});
      return reply(202, { task: tasks.get(key) });
    }
    if (url.pathname === "/api/bot-work/tasks") {
      state.pages++;
      return url.searchParams.has("cursor") ? reply(200, { tasks: [...tasks.values()], nextCursor: null, hasMore: false })
        : reply(200, { tasks: [], nextCursor: "second-page", hasMore: true });
    }
    state.reads++;
    const task = tasks.get(url.pathname.split("/").at(-1)!);
    return task ? reply(200, { task }) : reply(404, {});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const env = { PPENG_BASE_URL: "http://127.0.0.1:" + (server.address() as AddressInfo).port, PPENG_TOKEN: "fixture-only" };
  const client = new StageHomeClient(env);
  const service = new StageHomeService(store.db, work, client);
  const input = { requestId: "brief-1", product: "", stage: "research", templateId: "sources", title: "核对反馈",
    goal: "找到可追溯的市场反馈", inputs: "公开 issue", deliverable: "一页结果与来源", acceptance: "有来源可复查", target: "agent-home" };
  const id = work.create(input).work.id;
  return { work, store, service, id, tasks, state, env, input, client };
}

test("Home discovery limits the response to selectable bots; reads and stage creation never call dispatch", async t => {
  const h = await harness(t);
  assert.deepEqual(await h.service.bots(), { available: true, bots: [{ id: "bot-1", name: "研究员" }] });
  assert.equal(h.service.cached(h.id), null);
  assert.equal(await h.service.reconcile(h.id), null);
  assert.equal(h.state.posts, 0);
  const other = h.work.create({ ...h.input, requestId: "other", target: "coding-agent" });
  await assert.rejects(h.service.send(other.work.id, "bot-1"), /coding agent/);
  await assert.rejects(h.service.send(h.id, "bot-2"), /可接手/);
  assert.equal(h.work.get(h.id).status, "open");
  h.state.denyBots = true;
  assert.equal((await h.service.bots()).available, false);
  assert.throws(() => new StageHomeClient({ PPENG_BASE_URL: "https://example.com" }), /本机/);
  assert.equal(h.state.posts, 0);
});

test("concurrent Home submission binds once; recovery on a fresh service records evidence on the same work", async t => {
  const h = await harness(t);
  const submitted = await Promise.all([h.service.send(h.id, "bot-1"), h.service.send(h.id, "bot-1")]);
  assert.equal(submitted.filter(r => r.status === "queued").length >= 1, true);
  assert.equal(h.state.posts, 1);
  assert.equal(h.work.get(h.id).status, "active");
  const id = h.service.cached(h.id)!.remoteId!;
  const remote = h.tasks.get(id)!;
  assert.match(remote.input, /一页结果与来源/);
  assert.match(remote.input, /有来源可复查/);
  remote.status = "completed"; remote.result = "done";
  const restarted = new StageHomeService(h.store.db, new StageWorkStore(h.store.db), h.client);
  assert.equal((await restarted.reconcile(h.id))?.status, "needs_evidence");
  assert.equal(h.work.get(h.id).status, "active");
  remote.delivery = { taskId: remote.id, attempt: 1, executionStatus: "completed", sessionId: "session-1",
    report: "已核对原始记录。", artifacts: [{ id: "artifact-1", fileName: "sources.md" }], receipts: [] };
  const done = await restarted.reconcile(h.id);
  assert.equal(done?.status, "completed");
  assert.equal(h.work.get(h.id).status, "completed");
  assert.ok(h.work.get(h.id).evidence.some(x => x.includes("sources.md")));
  assert.deepEqual(await restarted.reconcile(h.id), done);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM zoom_messages WHERE task_id=? AND kind='completed'").get(h.id)!.n, 1);
  await assert.rejects(h.service.send(h.id, "bot-2"), /已绑定/);
  assert.equal(h.state.posts, 1);
});

test("ambiguous dispatch is reconciled from original receipt before any repeat; stale credentials cannot redispatch", async t => {
  const h = await harness(t);
  h.state.failSend = "after";
  assert.equal((await h.service.send(h.id, "bot-1")).status, "unknown");
  assert.equal((await h.service.send(h.id, "bot-1")).status, "unknown");
  assert.equal(h.state.posts, 1);
  const receipt = await h.service.reconcile(h.id);
  assert.equal(receipt?.remoteId, "btask-1");
  assert.equal(receipt?.status, "queued");
  assert.equal(h.state.pages, 2);
  assert.equal(h.state.posts, 1);
  const changed = new StageHomeService(h.store.db, h.work, new StageHomeClient({ ...h.env, PPENG_TOKEN: "changed" }));
  await assert.rejects(changed.reconcile(h.id), /原连接/);
  await assert.rejects(changed.send(h.id, "bot-1"), /原连接/);
});

test("explicit same-key retry requires a complete missing-receipt check; wrong task contents cannot close the local claim", async t => {
  const h = await harness(t);
  h.state.failSend = "before";
  await h.service.send(h.id, "bot-1");
  assert.equal((await h.service.reconcile(h.id))?.canRetry, true);
  h.state.failSend = "";
  assert.equal((await h.service.send(h.id, "bot-1")).status, "queued");
  assert.equal(h.state.posts, 2);
  assert.equal(h.tasks.size, 1);
  h.tasks.get("btask-1")!.input = "另一份工单";
  await assert.rejects(h.service.reconcile(h.id), /不一致/);
  assert.equal(h.work.get(h.id).status, "active");
});

test("Home paths require a local human session before accessing a work or calling the remote", async t => {
  const h = await harness(t);
  const { app } = createApp(h.store);
  for (const [suffix, method] of [["bots","GET"],[h.id,"GET"],[h.id + "/send","POST"],[h.id + "/reconcile","POST"]]) {
    const response = await app.request("/api/zoom/stage-home/" + suffix, { method });
    assert.equal(response.status, 401);
  }
});
