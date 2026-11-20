import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { OpportunityStore } from "./server/autonomy.ts";
import { openDatabase } from "./server/db.ts";
import { createApp } from "./server/http.ts";
import { CompanyStore } from "./server/company.ts";
import { ProjectStore } from "./server/projects.ts";
import { Store } from "./server/logic.ts";
import type { WorkflowExecutor } from "./server/workflow/executor.ts";
import { WorkflowService } from "./server/workflow/service.ts";
import type { WorkflowDetail } from "./workflow-types.ts";

function example(sourceId: string, impact = 3) {
  return { project: "testproject", sourceId, kind: "feature", title: "改进" + sourceId,
    rationale: "来源提供了可复现的请求", evidence: ["fixture/README.md#request"], impact };
}

function fixture(t: TestContext, companyProject?: string) {
  const root = mkdtempSync(join(tmpdir(), "opc-opportunities-"));
  const workspace = join(root, "testproject");
  execFileSync("git", ["init", "-q", workspace]);
  writeFileSync(join(workspace, "README.md"), "request\n");
  execFileSync("git", ["-C", workspace, "add", "README.md"]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "baseline"]);
  const config = { workspace, attemptRoot: join(root, "attempts"), backendKey: "fixture", boardUrl: "http://localhost",
    implement: ["fixture-implementation"], review: ["fixture-review"],
    ...(companyProject && {projectWorkspaces:{[companyProject]:workspace}}) };
  const launches: string[] = [];
  const executor: WorkflowExecutor = { name: "local-demo", async launch(spec) { launches.push(spec.attemptId); },
    async status(id) { return launches.includes(id) ? { state: "running", terminal: id } : { state: "absent" }; } };
  const dbPath = join(root, "store.db");
  const db = openDatabase(dbPath);
  const flow = new WorkflowService(db, config, executor);
  const items = new OpportunityStore(db, flow);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, items, flow, launches, workspace, peer: () => {
    const other = openDatabase(dbPath);
    const service = new WorkflowService(other, config, executor);
    return { items: new OpportunityStore(other, service), close: () => other.close() };
  } };
}

function approve(flow: WorkflowService, run: WorkflowDetail, kind: "plan" | "final") {
  const card = run.cards.find(c => c.kind === kind && c.status === "open");
  assert.ok(card);
  return flow.decide(run.id, { revision: card.revision, cardId: card.id, action: "approve" }, "测试负责人");
}

test("sources are validated and deduplicated per project, ranked by evidence and preserved after skip", t => {
  const { items } = fixture(t);
  const first = example("upstream:4", 2);
  const a = items.add(first);
  assert.deepEqual(items.add(first), a);
  const refreshed = items.add({ ...first, impact: 5, effort: 1, confidence: 4 });
  assert.equal(refreshed.id, a.id);
  assert.equal(refreshed.score, 20);
  assert.match(refreshed.reason, /5 × 证据可信度 4/);
  assert.throws(() => items.import({ items: [example("good"), { ...example("bad"), evidence: [] }] }), { status: 400 });
  assert.equal(items.list().opportunities.length, 1);
  items.import({ items: [example("other"), { ...first, project: "second" }] });
  assert.equal(items.list("testproject").opportunities[0].id, a.id);
  assert.equal(items.list("second").opportunities.length, 1);
  assert.throws(() => items.policy({ project: "second", enabled: true }), { status: 409 });
  assert.throws(() => items.select("second"), { status: 409 });
  const skipped = items.skip(a.id);
  assert.equal(skipped.state, "skipped");
  assert.deepEqual(items.add(first), skipped);
  assert.deepEqual(items.skip(a.id), skipped);
});

test("automatic choice uses one existing workflow, survives restarts, and advances only after acceptance", async t => {
  const { items, flow, workspace, launches, peer } = fixture(t);
  const older = items.add(example("old", 1));
  const best = items.add(example("best", 5));
  items.tick();
  assert.equal(flow.list().length, 0);
  assert.equal(items.policy({ project: "testproject", enabled: true }).enabled, true);
  const selected = items.select("testproject")!;
  assert.equal(selected.id, best.id);
  assert.ok(selected.runId);
  let run = flow.get(selected.runId);
  assert.equal(run.workspace, workspace);
  assert.equal(run.request.projectKey, "testproject");
  assert.ok(run.request.constraints.some(c => c.includes("fixture/README.md")));
  assert.deepEqual(run.revisions[0].plan.acceptance, ["review"]);
  assert.deepEqual(run.revisions[0].plan.nodes[1].dependsOn, ["implement"]);
  assert.equal(items.add({ ...example("best", 2), evidence: ["changed"] }).score, selected.score);
  assert.throws(() => items.skip(selected.id), { status: 409 });
  assert.equal(flow.messages().filter(m => m.pending).length, 1);
  await flow.tick();
  assert.equal(launches.length, 0);
  const restarted = peer();
  try {
    restarted.items.tick();
    assert.equal(restarted.items.select("testproject")?.runId, selected.runId);
    assert.equal(restarted.items.list("testproject").projects[0].enabled, true);
  } finally { restarted.close(); }
  approve(flow, run, "plan");
  for (const nodeId of ["implement", "review"]) {
    await flow.tick();
    run = flow.get(run.id);
    const attempt = run.attempts.find(a => a.nodeId === nodeId)!;
    assert.ok(attempt);
    flow.recordReceipt(run.id, { runId: run.id, nodeId, attemptId: attempt.id, revision: attempt.revision,
      outcome: "succeeded", summary: "fixture verified", checks: [{ name: "check", exitCode: 0, output: "ok" }],
      artifacts: [], patch: "" });
    items.tick();
    assert.equal(flow.list().length, 1);
  }
  items.policy({ project: "testproject", enabled: false });
  approve(flow, flow.get(run.id), "final");
  items.tick();
  assert.equal(flow.list().length, 1);
  items.policy({ project: "testproject", enabled: true });
  assert.equal(items.select("testproject")?.id, older.id);
  assert.equal(flow.list().length, 2);
  assert.equal(launches.length, 2);
});

test("a rejected candidate can reopen only after the current project's selection releases the slot", t => {
  const { items, flow } = fixture(t);
  items.import({items:[example("A",5),example("B",3),example("C",1)]});
  const a = flow.get(items.select("testproject")!.runId!);
  const reject = (run: WorkflowDetail) => flow.decide(run.id, {
    revision: run.summary.revision, cardId: run.cards.at(-1)!.id, action: "reject", note: "暂缓",
  }, "测试");
  reject(a);
  const b = flow.get(items.select("testproject")!.runId!);
  assert.notEqual(a.id,b.id);
  const revision = {baseRevision:1,reason:"已补充来源",plan:a.revisions[0].plan};
  assert.throws(()=>flow.revise(a.id, revision), {code:"opc_project_busy"});
  assert.equal(flow.get(a.id).summary.revision,1);
  reject(b);
  const reopened = flow.revise(a.id, revision);
  assert.equal(reopened.summary.revision,2);
  items.policy({project:"testproject",enabled:true});
  assert.equal(items.select("testproject")!.runId,a.id);
  approve(flow,reopened,"plan");
  assert.throws(()=>flow.revise(b.id,revision),{code:"opc_project_busy"});
});

test("a planning failure rolls back the workflow and candidate together, retry uses the original candidate", t => {
  const { db, items, flow } = fixture(t);
  const item = items.add(example("recover"));
  db.exec("CREATE TRIGGER fail_link BEFORE UPDATE OF run_id ON opc_opportunities BEGIN SELECT RAISE(ABORT,'interrupted'); END");
  items.policy({ project: "testproject", enabled: true });
  assert.equal(flow.list().length, 0);
  assert.equal(items.list().opportunities[0].state, "queued");
  assert.ok(items.list().projects[0].problem);
  db.exec("DROP TRIGGER fail_link");
  items.tick();
  assert.equal(flow.list().length, 1);
  assert.equal(items.select("testproject")?.id, item.id);
  assert.equal(items.list().projects[0].problem, null);
});

test("agent CLI can import proposals while selection controls use the owner's existing session", async t => {
  const { db, flow } = fixture(t);
  const store = new Store(db);
  const token = "opc-test-credential-for-sources";
  const { app } = createApp(store, { workflow: { db, service: flow, submitToken: token } });
  const agent = { authorization: "Bearer " + token };
  const owner = { cookie: "ac_session=" + store.session().token };
  function post(path: string, body: unknown, headers: Record<string,string>) {
    return app.request("/api/opc/" + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  assert.equal((await app.request("/api/opc/opportunities")).status, 401);
  assert.equal((await post("opportunities/import", { items: [example("api")] }, agent)).status, 200);
  assert.equal((await post("select", { project: "testproject" }, agent)).status, 401);
  const response = await post("select", { project: "testproject" }, owner);
  assert.equal(response.status, 200);
  const selection = await response.json();
  assert.ok(selection.opportunity.runId);
  const details = await app.request("/api/workflows/" + selection.opportunity.runId, { headers: owner });
  assert.equal((await details.json()).summary.phase, "planning");
});

test("想法只填验证问题，提交指定项目后按原来源排队，推进真实计划且审批前不启动", async t => {
  const project = "工具/验收";
  const {db, items, flow, launches, peer} = fixture(t, project);
  new ProjectStore(db).create({name:"工具"});
  const company = new CompanyStore(db);
  const target = {product:"工具",name:"验收"};
  company.createProject(target);
  const source = {id:crypto.randomUUID(), title:"研究文章", body:"小步对照验证", reference:"daily-review-learning/2026-11-21.md"};
  company.addNote("research",source);
  const save = (body:string)=>company.addNote("idea",{id:crypto.randomUUID(),body,sources:[source.id]});
  const first = save("减少发布前人工检查");
  const second = save("评估证据摘要对定位问题的帮助。" + "补充验收条件".repeat(200) + "最后核对样本");
  const unrelated = items.add({...example("other",5),project,confidence:5,effort:1});
  assert.throws(()=>company.dispatch(first.id,{...target,name:"不存在"},items),{status:409});
  assert.deepEqual(company.index().ideas.find(x=>x.id===first.id)?.products,[]);
  const a = company.dispatch(first.id,target,items);
  assert.equal(a.status,"plan");
  assert.ok(a.runId);
  assert.equal(flow.get(a.runId).request.source,"信息与想法");
  const b = company.dispatch(second.id,target,items);
  assert.equal(b.status,"queue");
  assert.equal(company.dispatch(second.id,target,items).opportunityId,b.opportunityId);
  assert.ok(items.list(project).opportunities.find(item=>item.id===b.opportunityId)?.dispatchedAt);
  await flow.tick();
  assert.deepEqual(launches,[]);
  const card=flow.get(a.runId).cards.find(c=>c.kind==="plan" && c.status==="open")!;
  flow.decide(a.runId,{revision:card.revision,cardId:card.id,action:"reject",note:"这轮先暂停"},"负责人");
  const restart = peer();
  try {
    restart.items.tick();
    const next=restart.items.list(project).opportunities.find(item=>item.id===b.opportunityId)!;
    assert.ok(next.runId);
    assert.match(flow.get(next.runId).request.context,/最后核对样本/);
    assert.ok(flow.get(next.runId).request.constraints.some(c=>c.includes(source.reference)));
    assert.equal(restart.items.list(project).opportunities.find(item=>item.id===unrelated.id)?.state,"queued");
    assert.equal(company.dispatch(second.id,target,items).runId,next.runId);
    assert.equal(flow.list().length,2);
    await flow.tick();
    assert.deepEqual(launches,[]);
  } finally { restart.close(); }
});
