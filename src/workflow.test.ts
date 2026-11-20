import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { WorkflowDetail, WorkflowEvidence, WorkflowNode, WorkflowPlan } from "./workflow-types.ts";
import { openDatabase } from "./server/db.ts";
import { Store } from "./server/logic.ts";
import { createApp } from "./server/http.ts";
import type { ZoomMessage } from "./zoom-types.ts";
import type { ExecutionStatus, LaunchSpec, WorkflowExecutor } from "./server/workflow/executor.ts";
import { WorkflowService } from "./server/workflow/service.ts";
import { draftWorkflowPlan } from "./server/workflow/planner.ts";
import type { ModelAdapter } from "@ppeng/agent-loop";

class TestHost implements WorkflowExecutor {
  readonly name = "herdr";
  launched: LaunchSpec[] = [];
  terminals = new Map<string, ExecutionStatus>();
  cleaned: Array<{ runId: string; attemptIds: string[] }> = [];
  uncertain = false;

  async launch(spec: LaunchSpec) {
    this.launched.push(spec);
    if (this.uncertain) throw new Error("connection interrupted");
    this.terminals.set(spec.attemptId, { state: "running", terminal: `t${this.launched.length}` });
  }

  async status(attemptId: string) {
    return this.terminals.get(attemptId) ?? { state: "absent" };
  }

  async cleanup(runId: string, attemptIds: string[]) {
    this.cleaned.push({ runId, attemptIds });
    let removedTerminals = 0;
    for (const id of attemptIds) {
      if (this.terminals.delete(id)) removedTerminals++;
    }
    return { removedTerminals, closedSpace: removedTerminals > 0 };
  }
}

function fixture(t: TestContext, overrides: Partial<ConstructorParameters<typeof WorkflowService>[1]> = {},
  draft?: typeof draftWorkflowPlan) {
  const directory = mkdtempSync(join(tmpdir(), "kunlun-test-"));
  const workspace = join(directory, "project");
  execFileSync("git", ["init", "-q", workspace]);
  writeFileSync(join(workspace, "example.txt"), "baseline\n");
  execFileSync("git", ["-C", workspace, "add", "example.txt"]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]);
  const database = join(directory, "db");
  const host = new TestHost();
  const config = { workspace, attemptRoot: join(directory, "attempts"), backendKey: "test", boardUrl: "http://localhost",
    implement: ["/usr/bin/true", "implement"], review: ["/usr/bin/true", "review"], ...overrides };
  let db = openDatabase(database);
  let service = new WorkflowService(db, config, host, draft);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const restart = () => {
    db.close();
    db = openDatabase(database);
    service = new WorkflowService(db, config, host, draft);
    return service;
  };
  const peer = (settings: Partial<typeof config> = {}) => {
    const peerDb = openDatabase(database);
    t.after(() => peerDb.close());
    return new WorkflowService(peerDb, { ...config, ...settings }, host, draft);
  };
  return { service, host, restart, peer, db, claims: () => db.prepare("SELECT * FROM workflow_claims ORDER BY created_at").all() };
}

const request = { version: 1, requestId: "once", source: "agent-cli", context: "origin:42", goal: "fixed change" };
const node = (id: string, kind: WorkflowNode["kind"], ...dependsOn: string[]): WorkflowNode =>
  ({ id, kind, title: id, instruction: id, dependsOn });
const card = (run: WorkflowDetail, kind: "plan" | "final" | "gate") => {
  const current = run.cards.find(item => item.revision === run.summary.revision && item.kind === kind);
  assert.ok(current);
  return { cardId: current.id, revision: current.revision };
};
const receipt = (run: WorkflowDetail, id: string, outcome: WorkflowEvidence["outcome"] = "succeeded"): WorkflowEvidence => {
  const attempt = run.attempts.find(item => item.id === id);
  assert.ok(attempt);
  return { runId: run.id, nodeId: attempt.nodeId, attemptId: attempt.id, revision: attempt.revision, outcome,
    patch: "", summary: "verified output", checks: [{ name: "check", output: "", exitCode: outcome === "succeeded" ? 0 : 1 }], artifacts: [] };
};

test("Zoom projects the active plan, its human response, reconciliation and retry from the same run", async t => {
  const { service, db, host } = fixture(t);
  const store = new Store(db);
  const { app } = createApp(store, { workflow: { service, db, submitToken: "test-credential-only-for-agents" } });
  const cookie = "ac_session=" + store.session("消息读者").token;
  const messages = async (): Promise<ZoomMessage[]> => (await (await app.request("/api/zoom/messages", { headers: { cookie } })).json()).messages;
  const pending = async () => (await messages()).filter(message => message.pending);
  let run = service.submit({ ...request, folder: "项目/执行", stage: "development" });
  const oldPlan = (await pending())[0];
  assert.deepEqual(oldPlan.action, { kind: "decision", ...card(run, "plan") });
  assert.equal(oldPlan.folder, "项目/执行");
  assert.equal(oldPlan.stage, "development");
  assert.equal(oldPlan.context, request.context);
  run = service.revise(run.id, { baseRevision: 1, reason: "更新验收说明", plan: run.revisions[0].plan });
  assert.equal((await messages()).find(message => message.id === oldPlan.id)?.pending, false);
  const newPlan = (await pending())[0];
  assert.deepEqual(newPlan.action, { kind: "decision", ...card(run, "plan") });
  const post = (path: string, body: unknown) => app.request("/api/workflows/" + run.id + "/" + path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.ok((await post("mark", { action: "archive", through: run.events.length })).ok);
  assert.equal((await pending())[0].id, newPlan.id);
  assert.equal((await post("decisions", { ...card(run, "plan"), revision: 1, action: "approve" })).status, 409);
  await service.tick();
  assert.equal(host.launched.length, 0);
  assert.ok((await post("decisions", { ...card(run, "plan"), action: "approve", note: "可以执行" })).ok);
  const decision = (await messages()).find(message => message.replyTo === newPlan.id);
  assert.equal(decision?.actor, store.localUser().name);
  assert.match(decision!.body, /可以执行/);
  host.uncertain = true;
  await service.tick();
  run = service.get(run.id);
  const recovery = { revision: 2, attemptId: run.attempts[0].id, note: "核查原尝试" };
  const expected = { revision: recovery.revision, attemptId: recovery.attemptId };
  assert.deepEqual((await pending()).map(message => message.action), [{ kind: "recover", ...expected }]);
  assert.ok((await post("recover", recovery)).ok);
  assert.deepEqual((await pending()).map(message => message.action), [{ kind: "retry", ...expected }]);
  assert.ok((await post("retry", { ...recovery, note: "同一节点返工" })).ok);
  assert.deepEqual(await pending(), []);
  assert.equal(db.prepare("SELECT count(*) AS total FROM zoom_tasks").get()?.total, 0);
  const paused = createApp(store).app;
  const details = await (await paused.request("/api/workflows/" + run.id, { headers: { cookie } })).json();
  assert.equal(details.summary.readOnly, true);
  assert.equal(details.revisions.length, 2);
  assert.ok(details.events.find((event: { kind: string }) => event.kind === "decision_approve"));
  assert.equal((await paused.request("/api/workflows/" + run.id)).status, 401);
});

test("workflow rejects malformed, cyclic, unreviewed and disconnected drafts", t => {
  const { service } = fixture(t);
  for (const plan of [
    { nodes: [node("a", "implement", "r"), node("r", "review", "a")], acceptance: ["r"] },
    { nodes: [node("a", "implement"), node("r", "review", "missing")], acceptance: ["r"] },
    { nodes: [node("a", "implement"), node("r", "review", "a"), node("c", "implement")], acceptance: ["r"] },
    { nodes: [node("a", "implement"), node("r", "review", "a"), node("a", "gate")], acceptance: ["r"] },
  ]) assert.throws(() => service.submit({ ...request, plan }), { status: 400 });
  assert.equal(service.list().length, 0);
});

test("scope, durable cards, failed retry and immutable revision history", async t => {
  const fixtureData = fixture(t);
  const { host, restart } = fixtureData;
  let { service } = fixtureData;
  const plan: WorkflowPlan = {
    nodes: [node("a", "implement"), node("question", "gate"), node("b", "implement", "question"), node("r", "review", "a", "b")],
    acceptance: ["r"],
  };
  let run = service.submit({ ...request, plan });
  assert.equal(service.submit({ ...request, plan }).id, run.id);
  assert.throws(() => service.submit({ ...request, plan, goal: "different" }), { status: 409 });
  await service.tick();
  assert.deepEqual(host.launched, []);
  service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await service.tick();
  run = service.get(run.id);
  assert.equal(run.summary.turn, "human");
  assert.deepEqual(run.attempts.map(item => item.nodeId), ["a"]);
  const first = run.attempts[0];
  const gate = card(run, "gate");
  const amended = { ...plan, nodes: plan.nodes.map(item => item.id === "b" ? { ...item, instruction: "amended" } : item) };
  assert.throws(() => service.revise(run.id, { baseRevision: 1, reason: "invalid", plan: {
    ...plan, nodes: plan.nodes.map(item => item.id === "a" ? { ...item, dependsOn: ["question"] } : item),
  } }), { status: 409 });
  run = service.revise(run.id, { baseRevision: 1, reason: "clarify b", plan: amended });
  assert.equal(run.summary.phase, "execution");
  assert.equal(run.summary.turn, "human");
  assert.deepEqual(run.revisions[1].gatedNodes, ["b", "r"]);
  assert.throws(() => service.decide(run.id, { ...gate, action: "approve" }, "人"), { status: 409 });
  const failed = receipt(run, first.id, "failed");
  service.recordReceipt(run.id, failed);
  service.recordReceipt(run.id, failed);
  assert.throws(() => service.recordReceipt(run.id, { ...failed, revision: 2 }), { status: 409 });
  assert.throws(() => service.recordReceipt(run.id, { ...failed, outcome: "succeeded", checks: [{ name: "x", exitCode: 0, output: "" }] }), { status: 409 });
  service = restart();
  run = service.get(run.id);
  const retry = { revision: 2, attemptId: first.id, note: "use first output" };
  service.retry(run.id, retry, "人");
  service.retry(run.id, retry, "人");
  await service.tick();
  run = service.get(run.id);
  assert.deepEqual(run.attempts.map(item => item.nodeId), ["a", "a"]);
  assert.equal(run.attempts[1].revision, 1, "unchanged work continues under the approval it actually received");
  assert.throws(() => service.recordReceipt(run.id, failed), { status: 409 });
  service.recordReceipt(run.id, receipt(run, run.attempts[1].id));
  const currentGate = card(run, "gate");
  service.decide(run.id, { ...currentGate, action: "approve", note: "answer" }, "人");
  await service.tick();
  assert.equal(host.launched.length, 2);
  run = service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await service.tick();
  run = service.get(run.id);
  const b = run.attempts[2];
  assert.equal(b.nodeId, "b");
  assert.throws(() => service.revise(run.id, { baseRevision: 2, reason: "reorder", plan: {
    ...amended, nodes: [amended.nodes[2], amended.nodes[0], amended.nodes[1], amended.nodes[3]],
  } }), { status: 409 });
  service.recordReceipt(run.id, receipt(run, b.id));
  await service.tick();
  run = service.get(run.id);
  const review = run.attempts[3];
  assert.equal(review.nodeId, "r");
  run = service.recordReceipt(run.id, receipt(run, review.id));
  const final = { ...card(run, "final"), action: "changes", note: "再做一次独立审查" };
  run = service.decide(run.id, final, "人");
  assert.equal(run.summary.phase, "acceptance");
  assert.equal(run.summary.turn, "agent");
  assert.throws(() => service.revise(run.id, { baseRevision: 2, reason: "same", plan: amended }), { status: 409 });
  const rework = { nodes: [...amended.nodes, node("r2", "review", "a", "b")], acceptance: ["r2"] };
  run = service.revise(run.id, { baseRevision: 2, reason: "review again", plan: rework });
  service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await service.tick();
  run = service.get(run.id);
  run = service.recordReceipt(run.id, receipt(run, run.attempts[4].id));
  const acceptance = { ...card(run, "final"), action: "approve" };
  service.decide(run.id, acceptance, "人");
  run = service.decide(run.id, acceptance, "人");
  assert.equal(run.summary.phase, "complete");
  assert.equal(run.events.filter(event => event.kind === "retry").length, 1);
  assert.equal(run.attempts[0].evidence?.outcome, "failed");
  assert.equal(run.cards.find(item => item.id === final.cardId)?.note, final.note);
});

test("unknown launch reconciles after restart without duplicate dispatch", async t => {
  const fixtureData = fixture(t);
  const { host } = fixtureData;
  let { service } = fixtureData;
  host.uncertain = true;
  let run = service.submit(request);
  service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await service.tick();
  run = service.get(run.id);
  const attempt = run.attempts[0];
  assert.equal(attempt.state, "unknown");
  service = fixtureData.restart();
  await service.tick();
  assert.equal(host.launched.length, 1);
  assert.throws(() => service.retry(run.id, { revision: 1, attemptId: attempt.id, note: "retry" }, "人"), { status: 409 });
  host.terminals.set(attempt.id, { state: "running", terminal: "t1" });
  await service.tick();
  assert.equal(service.get(run.id).attempts[0].terminal, "t1");
  assert.equal(host.launched.length, 1);
  host.terminals.set(attempt.id, { state: "finished", terminal: "t1" });
  await service.tick();
  assert.equal(service.get(run.id).attempts[0].state, "unknown", "terminal exit alone cannot resolve a missing receipt");
  const reconcile = { revision: 1, attemptId: attempt.id, note: "核对终端已结束且无回执" };
  assert.throws(() => service.retry(run.id, reconcile, "人"), { status: 409 });
  await service.recover(run.id, reconcile, "人");
  await service.recover(run.id, reconcile, "人");
  assert.equal(service.get(run.id).attempts[0].state, "failed");
  assert.equal(fixtureData.claims()[0].state, "failed");
  assert.equal(host.launched.length, 1);
});

test("recovery fences an unclaimed dispatch before allowing a retry", async t => {
  const { service, host } = fixture(t);
  host.uncertain = true;
  let run = service.submit(request);
  service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await service.tick();
  run = service.get(run.id);
  const input = { revision: 1, attemptId: run.attempts[0].id, note: "verify lost launch" };
  run = await service.recover(run.id, input, "人");
  assert.equal(run.attempts[0].state, "failed");
  assert.throws(() => service.recordReceipt(run.id, receipt(run, input.attemptId)), { status: 409 });
  service.retry(run.id, input, "人");
  host.uncertain = false;
  await service.tick();
  run = service.get(run.id);
  assert.equal(host.launched.length, 2);
  assert.notEqual(run.attempts[0].worktree, run.attempts[1].worktree);
});

test("coordinator SDK generates a validated DAG once; approval remains pending across restarts", async t => {
  const plan = { nodes: [node("build", "implement"), node("audit", "review", "build")], acceptance: ["audit"] };
  let drafts = 0;
  const f = fixture(t, { planner: "coordinator" }, (request, capabilities) => {
    drafts++;
    let turn = 0;
    const adapter: ModelAdapter = {
      name: "workflow-planner-fixture", summarizeMessages: async () => "",
      runTurn: async () => ++turn === 1 ? { stopReason: "tool_use", assistantParts: [{
        type: "tool_call", toolCallId: "plan", name: "propose_workflow", input: plan,
      }] } : { stopReason: "end", assistantParts: [{ type: "text", text: "已提交" }] },
    };
    return draftWorkflowPlan(request, capabilities, () => ({ adapter, model: "fixture", source: "test" }));
  });
  const [a, b] = await Promise.all([f.service.submitPlanned(request), f.service.submitPlanned(request)]);
  assert.equal(a.id, b.id);
  assert.equal(drafts, 1);
  assert.deepEqual(a.revisions[0].plan, plan);
  assert.match(a.revisions[0].reason, /fixture/);
  const reopened = f.restart();
  assert.equal((await reopened.submitPlanned(request)).id, a.id);
  assert.equal(drafts, 1);
  await reopened.tick();
  assert.equal(f.host.launched.length, 0);
});

test("capability-selected workers share durable leases; review failure can produce a downstream repair and fresh review", async t => {
  const { service, host, claims } = fixture(t, { capabilities: { ui: ["fake-ui-runner"] } });
  const plan = { nodes: [{ ...node("build", "implement"), capability: "ui" }, node("audit", "review", "build")], acceptance: ["audit"] };
  for (const nodes of [
    [{ ...plan.nodes[0], capability: "missing" }, plan.nodes[1]],
    [plan.nodes[0], { ...plan.nodes[1], capability: "ui" }],
  ]) assert.throws(() => service.submit({ ...request, plan: { nodes, acceptance: plan.acceptance } }), { status: 400 });
  let run = service.submit({ ...request, plan });
  run = service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await service.tick();
  assert.deepEqual(JSON.parse(readFileSync(host.launched[0].payload, "utf8")).runner, ["fake-ui-runner"]);
  assert.equal(claims()[0].state, "active");
  run = service.get(run.id);
  assert.equal(run.attempts[0].leaseUntil, claims()[0].lease_until);
  run = service.recordReceipt(run.id, receipt(run, run.attempts[0].id));
  await service.tick();
  run = service.get(run.id);
  const failed = receipt(run, run.attempts[1].id, "failed");
  run = service.recordReceipt(run.id, failed);
  assert.deepEqual(claims().map(c => [c.role, c.state]), [["implementer", "succeeded"], ["reviewer", "failed"]]);
  const repair = { nodes: [...plan.nodes, node("fix", "implement", "build"), node("recheck", "review", "fix")], acceptance: ["recheck"] };
  run = service.revise(run.id, { baseRevision: 1, reason: "修复评审发现，再独立复测", plan: repair });
  await service.tick();
  assert.equal(host.launched.length, 2);
  run = service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await service.tick();
  run = service.get(run.id);
  const fix = JSON.parse(readFileSync(host.launched[2].payload, "utf8"));
  assert.equal(fix.node.id, "fix");
  assert.ok(fix.feedback.some((e: { attemptId: string }) => e.attemptId === failed.attemptId));
  assert.equal(fix.upstream[0].evidence.attemptId, run.attempts[0].id);
  assert.match(fix.upstream[0].handoff, /上一步/);
  run = service.recordReceipt(run.id, receipt(run, run.attempts[2].id));
  await service.tick();
  run = service.get(run.id);
  run = service.recordReceipt(run.id, receipt(run, run.attempts[3].id));
  assert.equal(run.summary.phase, "acceptance");
  run = service.decide(run.id, { ...card(run, "final"), action: "approve" }, "人");
  assert.equal(run.summary.phase, "complete");
  assert.deepEqual(run.attempts[1].evidence, failed);
});

test("two controllers reserve each parallel node once and reconcile receipts only from that attempt", async t => {
  const { service, peer, host, claims } = fixture(t);
  const other = peer();
  const plan = { nodes: [node("a", "implement"), node("b", "implement"), node("audit", "review", "a", "b")], acceptance: ["audit"] };
  let run = service.submit({ ...request, plan });
  assert.equal(other.submit({ ...request, plan }).id, run.id);
  service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await Promise.all([service.tick(), other.tick()]);
  run = service.get(run.id);
  assert.deepEqual(run.attempts.map(a => a.nodeId), ["a", "b"]);
  assert.equal(host.launched.length, 2);
  const [first, second] = run.attempts;
  writeFileSync(join(dirname(first.worktree), "receipt.json"), JSON.stringify(receipt(run, second.id)));
  await Promise.all([service.tick(), other.tick()]);
  run = service.get(run.id);
  assert.deepEqual(run.attempts.map(a => a.state), ["unknown", "running"]);
  assert.equal(host.launched.length, 2);
  writeFileSync(join(dirname(first.worktree), "receipt.json"), JSON.stringify(receipt(run, first.id)));
  writeFileSync(join(dirname(second.worktree), "receipt.json"), JSON.stringify(receipt(run, second.id)));
  await Promise.all([service.tick(), other.tick()]);
  run = service.get(run.id);
  assert.deepEqual(run.attempts.map(a => a.state), ["succeeded", "succeeded", "running"]);
  assert.equal(host.launched.length, 3);
  assert.deepEqual(claims().map(c => c.state), ["succeeded", "succeeded", "active"]);
});

test("old host-bound runs reconcile in-flight work and require a new approval before dispatching changed runners", async t => {
  const { service, host, db, claims, peer } = fixture(t, { backendKey: "old-host-key" });
  const plan = { nodes: [node("a", "implement"), node("b", "implement", "a"), node("audit", "review", "b")], acceptance: ["audit"] };
  let run = service.submit({ ...request, plan });
  service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  host.uncertain = true;
  await service.tick();
  run = service.get(run.id);
  const original = JSON.parse(String(db.prepare("SELECT snapshot FROM workflow_runs WHERE id=?").get(run.id)!.snapshot));
  delete original.attempts[0].claimOwner;
  original.attempts[0].leaseUntil = new Date(0).toISOString();
  db.prepare("UPDATE workflow_runs SET snapshot=? WHERE id=?").run(JSON.stringify(original), run.id);
  const revision = { baseRevision: 1, reason: "确认新执行器并保留已运行的定义", plan };
  const foreign = peer({ backendKey: "other", hostKey: "different-host" });
  assert.equal(foreign.get(run.id).summary.turn, "recovery");
  assert.throws(() => foreign.revise(run.id, revision), { status: 409 });

  const next = peer({ backendKey: "new-binding", hostKey: "old-host-key", implement: ["new-worker"] });
  assert.match(next.get(run.id).summary.blockedReason!, /执行器配置/);
  const first = run.attempts[0];
  host.terminals.set(first.id, { state: "running", terminal: "t1" });
  host.uncertain = false;
  await next.tick();
  run = next.get(run.id);
  assert.equal(run.attempts[0].state, "running");
  assert.equal(claims()[0].agent_id, "old-host-key");
  assert.equal(host.launched.length, 1);
  run = next.revise(run.id, revision);
  assert.equal(run.summary.blockedReason, undefined);
  assert.equal(run.attempts[0].claimOwner, "old-host-key");
  writeFileSync(join(dirname(first.worktree), "receipt.json"), JSON.stringify(receipt(run, first.id)));
  await next.tick();
  assert.equal(claims()[0].state, "succeeded");
  assert.equal(host.launched.length, 1);
  next.decide(run.id, { ...card(run, "plan"), action: "approve" }, "人");
  await next.tick();
  assert.equal(host.launched.length, 2);
  assert.equal(claims()[1].agent_id, "new-binding");
  assert.deepEqual(JSON.parse(readFileSync(host.launched[1].payload, "utf8")).runner, ["new-worker"]);
});

test("项目键固定到登记的仓库，更换绑定时原审批和调度必须暂停", async t => {
  const {service,peer,host}=fixture(t);
  const original=service.submit({...request,requestId:"legacy"});
  const other=join(dirname(original.workspace),"second");
  execFileSync("git",["clone","-q",original.workspace,other]);
  const mapped=peer({projectWorkspaces:{"产品/工具":other}});
  const submitted=mapped.submit({...request,projectKey:"产品/工具"});
  assert.equal(submitted.workspace,other);
  assert.throws(()=>mapped.submit({...request,requestId:"unknown",projectKey:"未登记"}),/项目/);
  const changed=peer({projectWorkspaces:{"产品/工具":original.workspace}});
  assert.equal(changed.get(submitted.id).summary.turn,"recovery");
  assert.throws(()=>changed.decide(submitted.id,{...card(submitted,"plan"),action:"approve"},"owner"),/工作区|执行/);
  await changed.tick();
  assert.equal(host.launched.length,0);
  mapped.decide(submitted.id,{...card(submitted,"plan"),action:"approve"},"owner");
  await mapped.tick();
  assert.equal(host.launched.length,1);
  assert.equal(mapped.get(original.id).workspace,original.workspace);
});

test("验收批准可自动清理终端与临时工作树，并保留回执、支持幂等与 CLI 显式清理", async t => {
  const { service, db, host } = fixture(t);
  const store = new Store(db);
  const token = "test-credential-only-for-agents";
  const { app } = createApp(store, { workflow: { service, db, submitToken: token } });
  const cookie = "ac_session=" + store.session("验收人").token;
  let run = service.submit({ ...request, requestId: "cleanup-auto" });
  service.decide(run.id, { ...card(run, "plan"), action: "approve" }, "验收人");
  await service.tick();
  run = service.get(run.id);
  const impl = run.attempts[0];
  assert.ok(existsSync(impl.worktree));
  await assert.rejects(() => service.cleanupRun(run.id, "验收人"), /运行中|待对账/);
  writeFileSync(join(dirname(impl.worktree), "receipt.json"), JSON.stringify(receipt(run, impl.id)));
  await service.tick();
  run = service.get(run.id);
  const rev = run.attempts[1];
  assert.ok(existsSync(rev.worktree));
  writeFileSync(join(dirname(rev.worktree), "receipt.json"), JSON.stringify(receipt(run, rev.id)));
  await service.tick();
  run = service.get(run.id);
  await assert.rejects(() => service.cleanupRun(run.id, "验收人"), /验收完成|已拒绝/);

  const approve = await app.request(`/api/workflows/${run.id}/decisions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...card(run, "final"), action: "approve", note: "验收通过", cleanup: true }),
  });
  assert.equal(approve.status, 200);
  const completed = await approve.json() as WorkflowDetail;
  assert.equal(completed.summary.phase, "complete");
  assert.ok(completed.cleanedAt);
  assert.equal(host.cleaned.length, 1);
  assert.deepEqual(host.cleaned[0], { runId: run.id, attemptIds: [impl.id, rev.id] });
  for (const attempt of completed.attempts) {
    assert.equal(existsSync(attempt.worktree), false);
    assert.equal(existsSync(join(dirname(attempt.worktree), "receipt.json")), true);
  }
  assert.equal(readFileSync(join(run.workspace, "example.txt"), "utf8"), "baseline\n");
  const worktrees = execFileSync("git", ["-C", run.workspace, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.equal(worktrees.split("\n").filter(line => line.startsWith("worktree ")).length, 1);

  const workerAttempt = await app.request(`/api/workflows/${run.id}/cleanup`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-kunlun-workflow-worker": "1" },
  });
  assert.equal(workerAttempt.status, 403);

  const repeat = await app.request(`/api/workflows/${run.id}/cleanup`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(repeat.status, 200);
  const repeated = await repeat.json() as WorkflowDetail;
  assert.equal(repeated.cleanedAt, completed.cleanedAt);
  assert.equal(host.cleaned.length, 1);
  assert.equal(repeated.events.filter(item => item.kind === "cleaned").length, 1);
});
