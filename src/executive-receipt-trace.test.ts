import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ExecutiveReceiptTracer, type TraceTask } from "./server/executive-receipt-trace.ts";
import type { ZoomMessage } from "./zoom-types.ts";

const day = "2026-11-24";
const observedUpdatedAt = "2026-11-23T02:00:00.000Z";
const original: ZoomMessage = {
  id: "question", taskId: "patrol-zoom", taskTitle: "巡检工单", origin: "external", kind: "question",
  source: "OPC OS · 后台巡检卫士", folder: "公司/巡检告警", at: day + "T00:03:12.810Z",
  body: "检查失败项并提交建议", pending: true, choices: ["已知悉"], action: { kind: "reply" },
};
const task: TraceTask = {
  id: "remote-task", targetBotId: "security", attempt: 1, input: "工单原文", status: "cancelled", result: "我先核对现场。",
  createdAt: day + "T00:03:15.000Z", updatedAt: day + "T00:04:00.000Z",
};
function options(taskIds: string[] = ["plan"], patrolRunId?: string) {
  return JSON.stringify(["requeue", "snooze", "archive"].map(id => ({
    id, label: id, handlerKey: "product.patrol_" + id, payload: { taskIds, patrolRunId },
  })));
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE stage_home_bindings(work_id TEXT, bot_id TEXT, connection TEXT, brief TEXT, receipt TEXT);
    CREATE TABLE stage_work(task_id TEXT, brief TEXT);
    CREATE TABLE opc_delegations(id TEXT,user_id TEXT,source_id TEXT,source TEXT,evidence TEXT,created_at TEXT,work_id TEXT);
    CREATE TABLE zoom_tasks(id TEXT,external_id TEXT,source TEXT,folder TEXT);
    CREATE TABLE zoom_messages(id TEXT,task_id TEXT,event_key TEXT,kind TEXT);
    CREATE TABLE opc_patrol_runs(id TEXT,created_at TEXT,alerts_json TEXT,notified_zoom INTEGER);
    CREATE TABLE opc_planning_tasks(id TEXT,title TEXT,project TEXT,status TEXT,latest_run_id TEXT,updated_at TEXT);
    CREATE TABLE opc_decision_packets(id TEXT,status TEXT,options_json TEXT,background_summary TEXT,domain TEXT,kind TEXT,dedupe_key TEXT);
    CREATE TABLE opc_home_chat_notices(connection TEXT,remote_room TEXT,remote_message_id TEXT,notice_key TEXT);
    CREATE TABLE workflow_runs(id TEXT,snapshot TEXT);
  `);
  db.prepare("INSERT INTO stage_home_bindings VALUES('work','security','home',?,?)").run(task.input, JSON.stringify({remoteId:task.id}));
  db.prepare("INSERT INTO stage_work VALUES('work',?)").run(JSON.stringify({title:"核查工单",goal:"排查失败原因",deliverable:"附证据"}));
  db.prepare("INSERT INTO opc_delegations VALUES('deleg','founder','question',?,'[]',?,'work')").run(
    JSON.stringify({id:"question",kind:"message",taskId:"patrol-zoom",title:"巡检工单"}), day + "T00:03:14.000Z");
  db.prepare("INSERT INTO zoom_tasks VALUES(?,?,?,?)").run(original.taskId,"patrol-" + day,original.source,original.folder);
  db.prepare("INSERT INTO zoom_messages VALUES(?,?,?,?)").run(original.id,original.taskId,"patrol-report-" + day + "-123","question");
  db.prepare("INSERT INTO opc_patrol_runs VALUES('ptr_abc',?,?,1)").run(day + "T00:03:12.792Z",
    JSON.stringify([{ taskId:"plan",title:"原始任务",project:"project",status:"failed",updatedAt:observedUpdatedAt }]));
  db.prepare("INSERT INTO opc_planning_tasks VALUES('plan','当前任务','project','todo','run-123',?)").run(observedUpdatedAt);
  db.prepare("INSERT INTO opc_decision_packets VALUES('dec-123','pending',?,'原始审批背景','product','patrol_alert',?)").run(options(),"product:patrol:" + day);
  return {db, trace: (source: ZoomMessage[] = [original]) => new ExecutiveReceiptTracer(db, "home", "founder", () => source)};
}

test("patrol receipt retains its request, partial result and exact historical decision after task state changes", () => {
  const {db,trace} = fixture();
  const result = trace().task(task);
  assert.equal(result.status, "cancelled");
  assert.equal(result.result, "我先核对现场。");
  assert.equal(result.request, original.body);
  assert.equal(result.background, "原始审批背景");
  assert.equal(result.purpose, "排查失败原因\n附证据");
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.affectedTasks, [{ id:"plan",title:"当前任务",project:"project",status:"todo",observedStatus:"failed",latestRunId:"run-123" }]);
  assert.equal(result.origin?.workId, "work");
  assert.equal(result.origin?.delegationId, "deleg");
  assert.equal(result.origin?.patrolRunId, "ptr_abc");
  assert.equal(result.origin?.href, "#planning?tab=patrol");
  assert.equal(result.decisionId, "dec-123");
  assert.equal(result.decision?.actionable, false);
  db.exec("UPDATE opc_planning_tasks SET status='failed'");
  assert.equal(trace().task(task).decision?.actionable, true);
  db.prepare("UPDATE opc_planning_tasks SET updated_at=?").run(day + "T00:08:00.000Z");
  assert.equal(trace().task(task).decision?.actionable, false);
  db.exec("UPDATE opc_decision_packets SET status='approved'");
  const decided = trace().task(task);
  assert.equal(decided.decisionId, "dec-123");
  assert.equal(decided.decision?.actionable, false);
  db.close();
});

test("original patrol notifications carry verified scope and decision history without any Bot task", () => {
  const { db, trace } = fixture();
  db.exec("DELETE FROM stage_home_bindings; DELETE FROM opc_delegations");
  const forged = {...original, id: "forged"};
  const registration = {...original, id: "registration", kind: "task" as const};
  db.exec("UPDATE opc_decision_packets SET status='approved'");
  const entries = trace([original, forged, registration]).sourceTraces();
  assert.deepEqual(Object.keys(entries), [original.id]);
  const alert = entries[original.id];
  assert.equal(alert.status, "reported");
  assert.equal(alert.result, "");
  assert.equal(alert.origin?.messageId, original.id);
  assert.equal(alert.origin?.taskId, original.taskId);
  assert.equal(alert.origin?.patrolRunId, "ptr_abc");
  assert.equal(alert.affectedTasks[0].id, "plan");
  assert.equal(alert.affectedTasks[0].status, "todo");
  assert.equal(alert.decisionId, "dec-123");
  assert.equal(alert.decision?.status, "approved");
  assert.equal(alert.decision?.actionable, false);

  db.exec("INSERT INTO opc_patrol_runs SELECT 'ptr_def',created_at,alerts_json,notified_zoom FROM opc_patrol_runs WHERE id='ptr_abc'");
  const ambiguous = trace().sourceTraces()[original.id];
  assert.equal(ambiguous.origin?.messageId, original.id);
  assert.equal(ambiguous.origin?.patrolRunId, undefined);
  assert.deepEqual(ambiguous.affectedTasks, []);
  assert.equal(ambiguous.decisionId, undefined);
  db.prepare("UPDATE zoom_messages SET event_key=?").run("patrol-report-" + day + "-ptr_abc");
  db.prepare("UPDATE opc_decision_packets SET options_json=?").run(options(["plan"],"ptr_abc"));
  assert.equal(trace().sourceTraces()[original.id].decisionId, "dec-123");
  db.close();
});

test("multiple historical patrols, a different authoritative scope, and crossed patrol IDs never expose an action", () => {
  const {db,trace} = fixture();
  db.exec("INSERT INTO opc_patrol_runs SELECT 'ptr_def',created_at,alerts_json,notified_zoom FROM opc_patrol_runs WHERE id='ptr_abc'");
  const ambiguous = trace().task(task);
  assert.equal(ambiguous.decision, undefined);
  assert.equal(ambiguous.origin?.patrolRunId, undefined);
  db.prepare("UPDATE zoom_messages SET event_key=?").run("patrol-report-" + day + "-ptr_abc");
  db.prepare("UPDATE opc_decision_packets SET options_json=?").run(options(["wrong"],"ptr_abc"));
  assert.equal(trace().task(task).decision, undefined);
  db.prepare("UPDATE opc_decision_packets SET options_json=?").run(options(["plan"],"ptr_def"));
  assert.equal(trace().task(task).decision, undefined);
  db.prepare("UPDATE opc_decision_packets SET options_json=?").run(options(["plan"],"ptr_abc"));
  assert.equal(trace().task(task).decisionId, "dec-123");
  db.close();
});

test("tracing requires the same user, Bot, immutable brief, remote ID and connection and rejects mismatched delivery evidence", () => {
  const {db,trace} = fixture();
  const receipt = {...task, result:"请批准任务 dec-123", delivery:{taskId:"other",attempt:1,report:"wrong",artifacts:[{id:"bogus"}]}};
  const unbound = new ExecutiveReceiptTracer(db,"other-home","founder");
  for (const t of [unbound.task(receipt),new ExecutiveReceiptTracer(db,"home","other-user").task(receipt),
    trace().task({...receipt,id:"other-task"}),trace().task({...receipt,targetBotId:"other-bot"}),trace().task({...receipt,input:"different"})]) {
    assert.equal(t.origin, undefined);
    assert.equal(t.decision, undefined);
    assert.equal(t.result, receipt.result);
    assert.deepEqual(t.evidence, []);
  }
  const differentAttempt = trace().task({...receipt,delivery:{...receipt.delivery,taskId:task.id,attempt:2}});
  assert.equal(differentAttempt.result,receipt.result);
  assert.deepEqual(differentAttempt.evidence,[]);
  const authoritative = trace().task({...receipt,delivery:{...receipt.delivery,taskId:task.id,report:"证据核对完毕"}});
  assert.equal(authoritative.result,"证据核对完毕");
  assert.deepEqual(authoritative.evidence,["bogus"]);
  assert.equal(trace([]).task(task).origin?.kind,"delegation");
  assert.equal(trace([]).task(task).decision,undefined);
  db.close();
});

test("a room reply follows its actual room turn and stored notice; workflow options follow the identified card and revision", () => {
  const {db,trace} = fixture();
  const card: ZoomMessage = {...original, origin:"workflow",kind:"decision",id:"workflow:card:gate",taskId:"run",
    action:{kind:"decision",cardId:"gate",revision:3}};
  db.prepare("INSERT INTO workflow_runs VALUES('run',?)").run(JSON.stringify({cards:[{id:"gate",revision:3,status:"open"}]}));
  db.prepare("INSERT INTO opc_home_chat_notices VALUES('home','room','notice',?)").run(card.id);
  const user = {id:"notice",roomId:"room",sender:{type:"user"},text:"请核对",createdAt:task.createdAt!};
  const reply = {id:"bot-reply",roomId:"room",turnId:"turn",sender:{type:"bot"},text:"请批准",createdAt:task.updatedAt};
  const turns = [{id:"turn",roomId:"room",messageId:"notice"}];
  const result = trace([card]).room("room",reply,[user,reply],turns);
  assert.equal(result?.origin?.kind,"workflow");
  assert.equal(result?.decision?.id,"gate");
  assert.equal(result?.decision?.actionable,true);
  assert.equal(result?.requestedAt,user.createdAt);
  assert.equal(result?.result,reply.text);
  assert.equal(trace([card]).room("room",{...reply,turnId:"other"},[user,reply],turns),undefined);
  assert.equal(trace([card]).room("other",reply,[user,reply],turns),undefined);
  db.prepare("UPDATE workflow_runs SET snapshot=?").run(JSON.stringify({cards:[{id:"gate",revision:4,status:"open"}]}));
  assert.equal(trace([card]).room("room",reply,[user,reply],turns)?.decision?.actionable,false);
  db.close();
});
