import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { PlanningConversation, registerPlanningConversation } from "./server/planning-conversation.ts";
import { ApiError } from "./server/logic.ts";
import { TaskPlanningStore } from "./server/task-planning.ts";
import { StageHomeClient, type HomeTask } from "./server/stage-home-client.ts";

test("the preview planning chat exposes history without permitting real sends or runner dispatch", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const app = new Hono();
  const previous = process.env.KUNLUN_PREVIEW;
  process.env.KUNLUN_PREVIEW = "1";
  try {
    registerPlanningConversation(app, db, new TaskPlanningStore(db, undefined), () => ({ id: "founder" }));
  } finally {
    if (previous === undefined) delete process.env.KUNLUN_PREVIEW;
    else process.env.KUNLUN_PREVIEW = previous;
  }
  app.onError((err, c) => c.text(err.message, err instanceof ApiError ? err.status as 403 : 500));
  const path = "/api/opc/planning/conversation";
  assert.deepEqual(await (await app.request(path)).json(), { project: "", turns: [] });
  assert.equal((await app.request(path + "/messages", { method: "POST" })).status, 403);
  assert.equal((await app.request(path + "/confirm", { method: "POST" })).status, 403);
});

test("a scoped Super Bot conversation persists across rounds and proposes a real task; only confirmation creates and dispatches", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let admitted = false;
  const dispatches = new Set<string>();
  const board = new TaskPlanningStore(db, undefined, {
    listAgents: () => [{ id: "reviewer", name: "审查执行者", status: "idle", capabilities: [] }],
    dispatchToAgent: async (_task, _agent, autoPr, key) => {
      assert.equal(autoPr, false);
      assert.ok(key);
      if (!admitted) throw new Error("项目尚未准入");
      dispatches.add(key);
      return { runId: "run_" + key, status: "queued" };
    },
  });
  board.createTask({ project: "项目甲", title: "已有任务" });
  const remote = new Map<string, HomeTask>();
  let dispatchRequests = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/bot-work/default") return res.end(JSON.stringify({ bot: { id: "super", name: "Super Bot" } }));
    if (req.method === "POST" && req.url === "/api/bot-work/tasks") {
      dispatchRequests++;
      let buffer = "";
      for await (const chunk of req) buffer += chunk;
      const body = JSON.parse(buffer);
      assert.equal(body.targetBotId, "super");
      assert.ok(body.input.length <= 3500);
      const key = body.idempotencyKey;
      const task = remote.get(key) ?? { id: "bot-" + key.split("/")[1], targetBotId: "super", input: body.input,
        status: "running", attempt: 1, updatedAt: new Date().toISOString() };
      remote.set(key, task);
      return res.end(JSON.stringify({ task }));
    }
    const id = req.url?.split("/").at(-1);
    const task = [...remote.values()].find(item => item.id === id);
    res.statusCode = task ? 200 : 404;
    res.end(JSON.stringify({ task }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const home = new StageHomeClient({ PPENG_BASE_URL: "http://127.0.0.1:" + (server.address() as AddressInfo).port });
  const chat = new PlanningConversation(db, board, home);
  assert.deepEqual(await chat.view("founder", ""), { project: "", turns: [] });
  const first = { project: "", id: randomUUID(), text: "讨论权限巡检" };
  await chat.send("founder", first);
  const firstTask = [...remote.values()][0];
  firstTask.status = "completed";
  firstTask.result = JSON.stringify({ reply: "要覆盖哪个项目？", proposal: null });
  assert.equal((await chat.view("founder", "")).turns[0].reply, "要覆盖哪个项目？");
  const restored = new PlanningConversation(db, board, home);
  const second = { project: "", id: randomUUID(), text: "在项目甲，先检查权限差异。" };
  const open = await restored.send("founder", second);
  assert.equal(open.turns[1].status, "pending");
  const secondTask = [...remote.values()][1];
  assert.ok(secondTask.input.includes(first.text));
  assert.ok(secondTask.input.includes("要覆盖哪个项目？"));
  assert.deepEqual(await restored.view("other", ""), { project: "", turns: [] });
  assert.deepEqual(await restored.view("founder", "项目甲"), { project: "项目甲", turns: [] });
  // A restart can occur after Agent Home accepts a request and before OPC saves the remote id.
  db.prepare("UPDATE opc_planning_chat_turns SET remote_id=NULL WHERE id=?").run(second.id);
  await restored.view("founder", "", true);
  assert.equal(dispatchRequests, 2);
  await restored.view("founder", "");
  assert.equal(dispatchRequests, 3);
  assert.equal(remote.size, 2);
  secondTask.status = "completed";
  const proposal = { project: "项目甲", title: "核对权限", description: "列出变更并核对回归测试", agentId: "reviewer" };
  secondTask.result = JSON.stringify({ reply: "请确认任务。", proposal });
  assert.deepEqual((await restored.view("founder", "")).turns[1].proposal, proposal);
  assert.equal(board.listTasks({ project: "项目甲" }).length, 1);
  const confirm = { project: "", turnId: second.id, dispatch: true };
  await assert.rejects(restored.confirm("other", confirm), { code: "planning_chat_conflict" });
  const blocked = (await restored.confirm("founder", confirm)).turns[1];
  assert.ok(blocked.taskId && !blocked.runId);
  assert.match(blocked.error, /尚未准入/);
  assert.equal(dispatches.size, 0);
  admitted = true;
  const [sent, retry] = await Promise.all([restored.confirm("founder", confirm), restored.confirm("founder", confirm)]);
  assert.deepEqual(sent.turns[1], retry.turns[1]);
  assert.equal(sent.turns[1].taskId, blocked.taskId);
  assert.equal(sent.turns[1].runId, "run_" + second.id);
  assert.equal(sent.turns[1].error, "");
  assert.equal(board.getTask(blocked.taskId!).status, "in_progress");
  assert.equal(dispatches.size, 1);
  assert.equal(board.listTasks({ project: "项目甲" }).length, 2);
  await assert.rejects(restored.confirm("founder", { ...confirm, turnId: first.id }), { code: "planning_chat_conflict" });
});
