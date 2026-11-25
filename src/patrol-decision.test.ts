import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { ProductDepartment } from "./domains/product/index.ts";
import { StrategyDepartment } from "./domains/strategy/index.ts";
import { OpcKernel } from "./kernel/index.ts";
import { ApiError } from "./server/logic.ts";
import { TaskPlanningStore } from "./server/task-planning.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);
  const tasks = new TaskPlanningStore(db);
  new ProductDepartment({ kernel, taskPlanning: tasks, strategy: new StrategyDepartment(kernel) });
  const first = tasks.createTask({ project: "巡检项目", title: "第一次构建失败", status: "failed" });
  const second = tasks.createTask({ project: "巡检项目", title: "第二次构建失败", status: "failed" });
  const report = tasks.runPatrol();
  const [packet] = kernel.decisions.list({status: "pending"});
  assert.ok(packet);
  assert.equal(packet.actionBlockReason, undefined);
  return { db, kernel, tasks, first, second, packet, report };
}

test("task changes after a founder opens a patrol block the single and batch handlers before any task is changed", async t => {
  const { db, kernel, tasks, first, second, packet } = fixture();
  t.after(() => db.close());
  // A new attempt can fail again with exactly the same status and project.
  db.prepare("UPDATE opc_planning_tasks SET updated_at='2030-01-01T00:00:00.000Z' WHERE id=?").run(second.id);
  const reason = kernel.decisions.get(packet.id)?.actionBlockReason;
  assert.ok(reason?.includes(second.title));
  assert.equal(kernel.decisions.list({ status: "pending" })[0].actionBlockReason, reason);
  await assert.rejects(kernel.decisions.resolve(packet.id, { optionId: "archive", expectedUpdatedAt: packet.updatedAt }),
    {status: 409, code: "decision_action_blocked", message: reason});
  const batch = await kernel.decisions.batchResolve({ ids: [packet.id], action: "recommended" });
  assert.equal(batch.failedCount, 1);
  assert.equal(batch.results[0].reason, reason);
  assert.equal(kernel.decisions.get(packet.id)?.status, "pending");
  assert.equal(tasks.getTask(first.id).status, "failed");
  assert.equal(tasks.getTask(second.id).status, "failed");
  assert.equal(kernel.events.list({topic: "product.feature_ready"}).length, 0);
});

test("unique legacy scope can act, while extra reports, crossed ids, extraneous task ids and moved tasks block action", async t => {
  const { db, kernel, tasks, first, packet, report } = fixture();
  t.after(() => db.close());
  const setOptions = db.prepare("UPDATE opc_decision_packets SET options_json=? WHERE id=?");
  const legacy = packet.options.map(o => ({...o, payload: {taskIds: o.payload?.taskIds}}));
  setOptions.run(JSON.stringify(legacy), packet.id);
  assert.equal(kernel.decisions.get(packet.id)?.actionBlockReason, undefined);
  // A new report owns the same daily pending packet. Exact source IDs disambiguate the two runs.
  const secondReport = tasks.runPatrol();
  const exact = kernel.decisions.get(packet.id)!;
  assert.equal(exact.options[0].payload?.patrolRunId, secondReport.id);
  assert.equal(exact.actionBlockReason, undefined);
  setOptions.run(JSON.stringify(legacy), packet.id);
  assert.ok(kernel.decisions.get(packet.id)?.actionBlockReason);
  await assert.rejects(kernel.decisions.resolve(packet.id, {optionId: "snooze"}), {code: "decision_action_blocked"});
  const changed = exact.options.map((o, i) => i === 0 ? {...o, payload: {...o.payload, patrolRunId: report.id}} : o);
  setOptions.run(JSON.stringify(changed), packet.id);
  assert.ok(kernel.decisions.get(packet.id)?.actionBlockReason);
  const enlarged = exact.options.map(o => ({...o, payload: {...o.payload, taskId: "unrelated"}}));
  setOptions.run(JSON.stringify(enlarged), packet.id);
  assert.ok(kernel.decisions.get(packet.id)?.actionBlockReason);
  setOptions.run(JSON.stringify(exact.options), packet.id);
  db.prepare("UPDATE opc_planning_tasks SET project='别的项目' WHERE id=?").run(first.id);
  assert.ok(kernel.decisions.get(packet.id)?.actionBlockReason);
  db.prepare("UPDATE opc_planning_tasks SET project=?, status='todo' WHERE id=?").run(first.project, first.id);
  assert.ok(kernel.decisions.get(packet.id)?.actionBlockReason);
  db.prepare("UPDATE opc_planning_tasks SET status='failed' WHERE id=?").run(first.id);
  const settled = await kernel.decisions.resolve(packet.id, {optionId: "requeue", expectedUpdatedAt: exact.updatedAt});
  assert.equal(settled.status, "approved");
  assert.equal(settled.actionBlockReason, undefined);
  assert.equal(tasks.getTask(first.id).status, "todo");
});

test("exact decision GET authenticates, returns the requested packet, and keeps the policy route distinct", async t => {
  const {db, kernel, packet} = fixture();
  t.after(() => db.close());
  const app = new Hono();
  kernel.registerRoutes(app, c => {
    if (!c.req.header("authorization")) throw new ApiError(401, "unauthorized", "请登录");
    return {id: "founder", name: "founder"};
  });
  app.onError((err, c) => c.json({error: err.message}, err instanceof ApiError && err.status === 404 ? 404 : 401));
  const path = "/api/opc/kernel/decisions/";
  const headers = {authorization: "test"};
  assert.equal((await app.request(path + packet.id)).status, 401);
  assert.equal((await (await app.request(path + packet.id, {headers})).json()).packet.id, packet.id);
  assert.ok((await (await app.request(path + "policy", {headers})).json()).policy);
  assert.equal((await app.request(path + "missing", {headers})).status, 404);
});

test("batch actions keep the revision actually selected when a fresh patrol reuses the same pending packet id", async t => {
  const {db, kernel, tasks, packet} = fixture();
  t.after(() => db.close());
  const newTask = tasks.createTask({ project: "巡检项目", title: "新的告警范围", status: "failed" });
  tasks.runPatrol();
  const next = kernel.decisions.get(packet.id)!;
  assert.equal(next.actionBlockReason, undefined);
  assert.notEqual(packet.updatedAt, next.updatedAt);
  const request = {ids: [packet.id], action: "reject" as const};
  const stale = await kernel.decisions.batchResolve({...request, expectedUpdatedAtById: {[packet.id]: packet.updatedAt}});
  assert.equal(stale.skippedCount, 1);
  assert.match(stale.results[0].reason || "", /内容已有更新/);
  assert.equal(tasks.getTask(newTask.id).status, "failed");
  const current = await kernel.decisions.batchResolve({...request, expectedUpdatedAtById: {[packet.id]: next.updatedAt}});
  assert.equal(current.resolvedCount, 1);
  assert.equal(tasks.getTask(newTask.id).status, "archived");
});
