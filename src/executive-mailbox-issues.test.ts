import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutiveMailItem, ExecutiveReceiptTrace } from "./executive-bots-types.ts";
import { buildMailboxIssues } from "./executive-mailbox-issues.ts";
import type { DecisionPacket } from "./kernel/types.ts";
import type { ZoomMessage } from "./zoom-types.ts";

const firstAt = "2026-11-23T18:03:00.000Z";
const laterAt = "2026-11-24T00:03:00.000Z";
const laterStill = "2026-11-24T00:06:00.000Z";

function patrolPacket(id: string, taskIds: string[], overrides: Partial<DecisionPacket> = {}): DecisionPacket {
  return {
    id, dedupeKey: "product:patrol:2026-11-24", domain: "product", kind: "patrol_alert", riskLevel: "medium",
    mainlineId: null, productId: null, assetId: null, title: "任务巡检", backgroundSummary: "任务失败", whyRecommended: "重试",
    costEstimateUsd: null, diffOrEvidence: "", rollbackPlan: "", options: [{
      id: "requeue", label: "重新入队", outcome: "approved", handlerKey: "product.patrol_requeue", payload: { taskIds, patrolRunId: "ptr_" + id },
    }], recommendedOptionId: "requeue", tags: [], status: "pending", viewedAt: null, chosenOptionId: null,
    decisionNote: "", decidedBy: null, autoApproved: false, handlerResult: null, createdAt: laterAt, updatedAt: laterAt, decidedAt: null,
    ...overrides,
  };
}

function notice(id: string, overrides: Partial<ZoomMessage> = {}): ZoomMessage {
  return { id, origin: "external", kind: "question", taskId: "daily-patrol", taskTitle: "任务巡检", source: "OPC OS · 后台巡检卫士",
    folder: "公司/巡检告警", body: "巡检发现任务失败", at: laterAt, pending: true, action: { kind: "reply" }, ...overrides };
}

function trace(message: ZoomMessage, packet: DecisionPacket, ids: string[], overrides: Partial<ExecutiveReceiptTrace> = {}): ExecutiveReceiptTrace {
  return { status: "completed", background: "巡检告警", purpose: "调查原因", request: "核对任务", result: "任务失败", evidence: [],
    origin: { kind: "zoom", title: message.taskTitle, href: "#planning?tab=patrol", messageId: message.id, taskId: message.taskId, patrolRunId: "ptr_" + packet.id },
    decisionId: packet.id, decision: { kind: "kernel", id: packet.id, status: packet.status, href: "#mailbox?decision=" + packet.id,
      actionable: true, options: packet.options.map(({ id, label }) => ({ id, label })) },
    affectedTasks: ids.map(id => ({ id, project: "example", title: "相同标题", status: "failed", observedStatus: "failed", latestRunId: null })), ...overrides };
}

function receipt(id: string, overrides: Partial<ExecutiveMailItem> = {}): ExecutiveMailItem {
  return { id, source: "department_task", direction: "inbound", senderId: "bot", senderName: "Super Bot", senderRole: "总控 COO",
    subject: "请批准事项", excerpt: "请你批准", body: "请你批准", status: "completed", read: false, needsDecision: true, createdAt: laterStill, ...overrides };
}

test("repeated patrols with the same exact task IDs share one issue, linked receipts and resolved decisions remain in the timeline", () => {
  const archived = patrolPacket("old", ["task-b", "task-a"], { status: "approved", chosenOptionId: "requeue", decidedAt: firstAt, updatedAt: firstAt });
  const current = patrolPacket("new", ["task-a", "task-b"], { viewedAt: laterAt });
  const stale = patrolPacket("stale", ["task-a", "task-b"], { actionBlockReason: "任务已变化", updatedAt: laterStill });
  const a = notice("a", { at: firstAt, taskId: "prior-patrol" });
  const b = notice("b");
  const c = notice("c", { at: laterStill });
  const registration = notice("registered", { kind: "task", pending: false, action: undefined });
  const oldTrace = trace(a, archived, ["task-a", "task-b"]);
  const newTrace = trace(b, current, ["task-b", "task-a"], { decision: { ...trace(b, current, ["task-a", "task-b"]).decision!, actionable: false } });
  const staleTrace = trace(c, stale, ["task-a", "task-b"]);
  const items = [receipt("old-receipt", { trace: oldTrace }), receipt("new-receipt", { trace: newTrace, read: true }), receipt("stale-receipt", { trace: staleTrace })];
  const sourceTraces = { a: oldTrace, b: newTrace, c: staleTrace };
  const [issue, ...extra] = buildMailboxIssues({ decisions: [archived, current, stale], items,
    messages: [a, b, c, registration], sourceTraces });
  assert.equal(extra.length, 0);
  assert.equal(issue.id, 'issue:patrol:["task-a","task-b"]');
  assert.equal(issue.primaryId, "dec:new");
  assert.equal(issue.state, "pending");
  assert.deepEqual(issue.pendingDecisionIds, ["new"]);
  assert.equal(issue.records.length, 10);
  assert.ok(issue.aliases.includes("sys:a"));
  assert.ok(issue.aliases.includes("exec:old-receipt"));
  assert.ok(issue.aliases.includes("dec:stale"));
  assert.equal(issue.receipts.length, 3);
  assert.equal(issue.decisions.length, 3);
  assert.equal(issue.messages.length, 4);

  // Resolved packet and cached receipt previously requesting approval cannot
  // resurrect the issue. Read status and blocked old decisions are immaterial.
  const settled = { ...current, status: "approved" as const, decidedAt: laterStill, updatedAt: laterStill };
  const [done] = buildMailboxIssues({ decisions: [archived, settled, stale], items, messages: [a, b, c, registration], sourceTraces });
  assert.equal(done.id, issue.id);
  assert.equal(done.state, "archived");
  assert.equal(done.pending, false);
  assert.deepEqual(done.pendingDecisionIds, []);
});

test("different patrol scopes stay separate even with identical title and shared patrol Zoom task", () => {
  const first = patrolPacket("one", ["task-a"]);
  const second = patrolPacket("two", ["task-a", "task-b"]);
  const other = patrolPacket("other", ["task-c"]);
  const a = notice("a");
  const b = notice("b");
  const c = notice("c");
  const sourceTraces = { a: trace(a, first, ["task-a"]), b: trace(b, second, ["task-a", "task-b"]), c: trace(c, other, ["task-c"]) };
  const issues = buildMailboxIssues({ decisions: [first, second, other], items: [], messages: [a, b, c], sourceTraces });
  assert.equal(issues.length, 3);
  assert.equal(issues.filter(issue => issue.pending).length, 3);
  assert.ok(issues.every(issue => issue.records.length === 2));
  // Reused packet ID changed scope on a fresh patrol; an old cached trace may
  // contain the earlier association but must not incorrectly merge the scopes.
  const original = trace(a, first, ["task-a"]);
  const reused = { ...second, id: first.id };
  const separated = buildMailboxIssues({ decisions: [reused], items: [receipt("stale", { trace: original })], messages: [a], sourceTraces: { a: original } });
  assert.equal(separated.length, 2);
  assert.equal(separated.find(issue => issue.pending)?.records.length, 1);
});

test("a source workflow card stays actionable only once and old receipt cannot restore it after resolution", () => {
  const question: ZoomMessage = { ...notice("workflow:card:c"), origin: "workflow", source: "Antigravity", folder: "repo",
    taskId: "workflow-run", kind: "decision", action: { kind: "decision", cardId: "c", revision: 2 } };
  const linkedTrace: ExecutiveReceiptTrace = {
    status: "completed", request: "确认计划", purpose: "审批建议", background: "工作流", result: "建议批准", evidence: [], affectedTasks: [],
    origin: { kind: "workflow", taskId: question.taskId, messageId: question.id, title: "确认计划", href: "#workflows/workflow-run" },
    decision: { kind: "workflow", id: "c", status: "open", actionable: true, href: "#workflows/workflow-run", options: [] },
  };
  const response = receipt("linked", { trace: linkedTrace });
  const response2 = receipt("linked2", { trace: linkedTrace, read: true });
  const alert = notice("unknown-patrol");
  const unrelated = receipt("genuine-ask");
  const markedRead = receipt("read-ask", { read: true });
  const failed = receipt("failed", { status: "failed" });
  const working = receipt("working", { status: "working", direction: "outbound" });
  const items = [response, response2, unrelated, markedRead, failed, working];
  const issues = buildMailboxIssues({ decisions: [], items, messages: [question, alert] });
  assert.deepEqual(issues.filter(issue => issue.pending).map(issue => issue.primaryId).sort(), ["exec:genuine-ask", "sys:workflow:card:c"]);
  const workflow = issues.find(issue => issue.kind === "system" && issue.item.id === question.id)!;
  assert.equal(workflow.records.length, 3);
  assert.equal(issues.find(issue => issue.primaryId === "sys:unknown-patrol")?.state, "archived");
  assert.equal(issues.find(issue => issue.primaryId === "exec:working")?.state, "working");
  const answered = { ...question, pending: false, action: undefined };
  const done = buildMailboxIssues({ decisions: [], items, messages: [answered, alert] });
  assert.equal(done.find(issue => issue.id === workflow.id)?.state, "archived");
});

test("multiple still-actionable approval packets remain available inside the same grouped task", () => {
  const first = patrolPacket("one", ["task-a"], { updatedAt: firstAt });
  const second = patrolPacket("two", ["task-a"]);
  const [issue] = buildMailboxIssues({ decisions: [first, second], items: [], messages: [] });
  assert.equal(issue.primaryId, "dec:two");
  assert.deepEqual(issue.pendingDecisionIds, ["two", "one"]);
  assert.deepEqual(issue.decisions.map(packet => packet.id), ["two", "one"]);
});

test("historical working records do not keep a completed investigation active, and missing-source receipts do not imply a pending decision", () => {
  const packet = patrolPacket("done", ["task-a"], { status: "approved" });
  const alert = notice("alert");
  const baseTrace = trace(alert, packet, ["task-a"]);
  const workTrace = { ...baseTrace, origin: { ...baseTrace.origin!, workId: "work-1" } };
  const old = receipt("old", { status: "working", createdAt: firstAt, trace: workTrace });
  const latest = receipt("new", { status: "completed", createdAt: laterStill, trace: workTrace });
  const sourceTraces = { alert: baseTrace };
  const live = buildMailboxIssues({ decisions: [packet], messages: [alert], items: [old], sourceTraces });
  assert.equal(live[0].state, "working");
  const completed = buildMailboxIssues({ decisions: [packet], messages: [alert], items: [old, latest], sourceTraces });
  assert.equal(completed[0].state, "archived");

  const previousWorkflowAsk = receipt("no-longer-visible", { trace: {
    ...baseTrace, decisionId: undefined,
    origin: { kind: "workflow", title: "旧审批", href: "#workflows/old", messageId: "workflow:card:old", taskId: "old" },
    decision: { kind: "workflow", id: "old", href: "#workflows/old", status: "open", actionable: true, options: [] },
    affectedTasks: [],
  } });
  assert.equal(buildMailboxIssues({ decisions: [], messages: [], items: [previousWorkflowAsk] })[0].state, "archived");
});

test("conflicting routes cannot transitively merge incompatible patrol scopes", () => {
  const original = patrolPacket("original", ["a"]);
  const replacement = patrolPacket("replacement", ["a", "b"]);
  const oldNotice = notice("old");
  const newNotice = notice("new");
  const oldTrace = trace(oldNotice, original, ["a"]);
  const newTrace = trace(newNotice, replacement, ["a", "b"]);
  // Inconsistent cached association claims the old packet ID without a current
  // packet available. Both task scopes are verified, so the bridge is ignored.
  const inconsistent = { ...newTrace, decisionId: original.id };
  const result = buildMailboxIssues({ decisions: [], items: [receipt("old", { trace: oldTrace }), receipt("new", { trace: inconsistent })],
    messages: [oldNotice, newNotice], sourceTraces: { old: oldTrace, new: newTrace } });
  assert.equal(result.length, 2);
  assert.ok(result.every(issue => issue.id.startsWith("issue:patrol:")));
  assert.deepEqual(result.map(issue => issue.records.length), [2, 2]);
});

test("a commercial kill alert shares its exact approval without suppressing unrelated alerts", () => {
  const decision = patrolPacket("kill", [], { domain: "commercial", kind: "kill_switch", dedupeKey: "commercial:kill_switch:project-a",
    status: "approved", backgroundSummary: "项目连续亏损", options: [{ id: "freeze", label: "冻结", outcome: "approved",
      handlerKey: "commercial.kill_switch_freeze", payload: { project: "project-a" } }] });
  const matched = notice("kill-alert", { source: "OPC OS · 商业熔断卫士", folder: "project-a/经营", taskId: "kill-a", body: "项目连续亏损" });
  const unrelated = { ...matched, id: "kill-other", folder: "project-b/经营", taskId: "kill-b" };
  const issues = buildMailboxIssues({ decisions: [decision], items: [], messages: [matched, unrelated] });
  assert.equal(issues.length, 2);
  const exact = issues.find(issue => issue.aliases.includes("sys:kill-alert"));
  assert.equal(exact?.state, "archived");
  assert.deepEqual(exact?.decisions.map(packet => packet.id), [decision.id]);
  assert.equal(issues.find(issue => issue.primaryId === "sys:kill-other")?.state, "pending");
});

test("delegated opportunity recommendation remains pending while ordinary reconciliation needs no approval", () => {
  const base = { ...notice("delegation:opportunity"), source: "Super Bot", folder: "公司/委派", action: undefined,
    delegation: { id: "opportunity", sourceId: "opportunity:item", sourceHref: "#opportunities", workId: "work-opportunity",
      title: "机会立项", method: { via: "agent-home" as const, target: "Super Bot", instructions: "评估" }, status: "approval" as const,
      evidence: [], result: "建议立项", requiresApproval: true } };
  const unrelated = { ...base, id: "delegation:reconcile", taskId: "another-task", delegation: {
    ...base.delegation, sourceId: "missing-original", workId: "work-other", status: "reconcile" as const } };
  const issues = buildMailboxIssues({ decisions: [], items: [], messages: [base, unrelated] });
  assert.equal(issues.find(issue => issue.primaryId === "sys:delegation:opportunity")?.state, "pending");
  assert.equal(issues.find(issue => issue.primaryId === "sys:delegation:reconcile")?.state, "archived");
});
