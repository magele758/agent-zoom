import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CapabilityIndex, CapabilityRequest, RepoCapability } from "./repo-capabilities-types.ts";
import type { Opportunity, OpportunityIndex } from "./autonomy-types.ts";
import type { ProjectProfile } from "./project-profile-types.ts";
import type { WorkflowDetail } from "./workflow-types.ts";
import { OpportunityStore } from "./server/autonomy.ts";
import type { ZoomMessage } from "./zoom-types.ts";
import { createApp } from "./server/http.ts";
import { openStore } from "./server/logic.ts";
import { WorkflowService } from "./server/workflow/service.ts";

const ownerProject = { product: "共用服务", project: "parser" },
  consumer = { product: "内容产品", project: "发布器" };
const root = "/api/opc/capabilities",
  repo = "example/parser";

async function fixture(t: TestContext, bound = true, otherBindings: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "opc-capabilities-"));
  const workspace = join(dir, "git");
  execFileSync("git", ["init", "-q", workspace]);
  writeFileSync(join(workspace, "README.md"), "parser --input text\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", [
    "-C",
    workspace,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "baseline",
  ]);
  const commit = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const token = "opc-local-capabilities-test-agent";
  const launches: string[] = [];
  let store = openStore(join(dir, "state.db"));
  function attach() {
    const service = new WorkflowService(
      store.db,
      {
        workspace,
        projectWorkspaces: Object.fromEntries([...(bound ? [repo] : []), ...otherBindings].map(key => [key, workspace])),
        capabilities: { extra: ["second-implementer"] },
        attemptRoot: join(dir, "attempts"),
        backendKey: "fixture",
        boardUrl: "http://localhost",
        implement: ["fixture"],
        review: ["fixture"],
      },
      {
        name: "local-demo",
        async launch(spec) {
          launches.push(spec.attemptId);
        },
        async status() {
          return { state: "absent" };
        },
      },
    );
    const { app } = createApp(store, { workflow: { db: store.db, service, submitToken: token } });
    return { app, service };
  }
  let state = attach();
  const owner = { cookie: "ac_session=" + store.session().token },
    agent = { authorization: "Bearer " + token };
  async function send(url: string, data: unknown, who: Record<string, string> = agent) {
    return state.app.request(url, {
      method: "POST",
      headers: { ...who, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  }
  async function result<T>(url: string, data: unknown, who?: Record<string, string>): Promise<T> {
    const response = await send(url, data, who);
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    return JSON.parse(raw) as T;
  }
  async function get<T>(url: string, who: Record<string, string> = agent): Promise<T> {
    const response = await state.app.request(url, { headers: who });
    assert.equal(response.status, 200);
    return response.json() as Promise<T>;
  }
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await result("/api/zoom/projects/sync", {
    name: ownerProject.product,
    repository: {
      owner: "example",
      fullName: repo,
      url: "https://github.com/" + repo,
      visibility: "public",
      fork: false,
      openIssues: 0,
      openPullRequests: 0,
      latestRelease: null,
      items: [],
      syncedAt: "2026-11-20T10:30:00.000Z",
    },
  });
  await result("/api/zoom/projects", { name: consumer.product });
  await result("/api/zoom/company/projects", { product: consumer.product, name: consumer.project });
  const form = {
    ...ownerProject,
    repo,
    name: "文本解析",
    version: commit,
    interfaceRef: "parser --input <text>",
    evidence: "https://github.com/" + repo + "/blob/" + commit + "/README.md",
  };
  const capability = await result<RepoCapability>(root, form);
  const draft = {
    ...consumer,
    capabilityId: capability.id,
    title: "解析混合文本",
    detail: "影响发布器的文本预览。验收要覆盖两种编码。",
    requestId: "capability-case",
    mode: "gap",
  };
  const restart = () => {
    store.db.close();
    store = openStore(join(dir, "state.db"));
    state = attach();
  };
  return {
    form,
    capability,
    draft,
    owner,
    agent,
    send,
    get,
    result,
    launches,
    restart,
    db: () => store.db,
    flow: () => state.service,
  };
}

test("仓库接口版本不可覆盖；多个项目直接复用进入各自档案，不生成工程任务", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.result<RepoCapability>(root, { ...f.form, repo: repo.toUpperCase() })).id,
    f.capability.id,
  );
  assert.equal((await f.send(root, { ...f.form, interfaceRef: "replace --target" })).status, 409);
  assert.equal((await f.send(root, { ...f.form, version: "latest" })).status, 409);
  assert.equal(
    (await f.send(root, { ...f.form, evidence: "https://github.com/example/other/blob/abc/README.md" })).status,
    409,
  );
  assert.equal((await f.send(root, { ...f.form, ...consumer })).status, 409);
  const first = { ...f.draft, mode: "reuse" };
  const saved = await f.result<CapabilityRequest>(root + "/requests", first);
  assert.equal(saved.status, "reused");
  assert.equal(saved.taskId, null);
  assert.equal(
    (await f.result<CapabilityRequest>(root + "/requests", { ...first, requestId: "another-key" })).id,
    saved.id,
  );
  assert.equal(
    (await f.send(root + "/requests", { ...first, requestId: "another-key", mode: "gap" })).status,
    409,
  );
  await f.result("/api/zoom/company/projects", { product: consumer.product, name: "预览工具" });
  await f.result(root + "/requests", { ...first, project: "预览工具", requestId: "second-consumer" });
  const profiles = await f.get<{ profiles: ProjectProfile[] }>("/api/opc/projects/profiles");
  assert.equal(
    profiles.profiles.filter((p) => p.uses.some((u) => u.reference.includes(f.form.version))).length,
    2,
  );
  assert.equal((await f.get<OpportunityIndex>("/api/opc/opportunities")).opportunities.length, 0);
  assert.equal((await f.get<CapabilityIndex>(root)).requests.length, 2);
  assert.equal(f.flow().list().length, 0);
});

test("标签凭据必须引用同标签；旧目录原样重放保留原记录", async (t) => {
  const f = await fixture(t);
  const prefix = "https://github.com/" + repo + "/";
  const tag = {...f.form,version:"v1.2"};
  for (const evidence of [f.form.evidence, prefix + "commit/v1.2", prefix + "tree/v1.20", prefix + "releases/tag/v1.3"]) {
    assert.equal((await f.send(root,{...tag,evidence})).status,409);
  }
  for (const [index, suffix] of ["releases/tag/v1.2","blob/v1.2/README.md","tree/v1.2"].entries()) {
    const form={...tag,name:"标签接口"+index,evidence:prefix+suffix};
    const saved=await f.result<RepoCapability>(root,form);
    assert.equal((await f.result<RepoCapability>(root,form)).id,saved.id);
  }
  // This combination could already exist under the previous verifier. Its immutable ID remains usable for retries.
  const legacyId=crypto.randomUUID(), old={...tag,name:"已有旧接口"};
  f.db().prepare("INSERT INTO opc_repo_capabilities VALUES(?,?,?,?,?,?,?,?)")
    .run(legacyId,old.product,old.project,old.repo,old.name,old.version,old.interfaceRef,old.evidence);
  f.restart();
  assert.equal((await f.result<RepoCapability>(root,old)).id,legacyId);
  assert.equal((await f.send(root,{...old,interfaceRef:"changed"})).status,409);
});

test("原仓需求批准绑定当前版本和维护仓，拒绝与修改保留历史；重启、重送和外部伪造不能重复派工", async (t) => {
  const f = await fixture(t);
  let req = await f.result<CapabilityRequest>(root + "/requests", f.draft);
  const accept = (r: CapabilityRequest) => ({
    revision: r.revision,
    questionId: r.questionId,
    action: "approve",
    note: "",
  });
  const decisions = root + "/requests/" + req.id + "/decisions",
    revisions = root + "/requests/" + req.id + "/revisions";
  assert.equal(req.status, "pending");
  assert.ok(req.taskId && req.questionId);
  await f.flow().tick();
  assert.equal(f.flow().list().length, 0);
  const zoom = await f.get<{ messages: ZoomMessage[] }>("/api/zoom/messages", f.owner);
  assert.ok(
    zoom.messages.some(
      (m) =>
        m.pending &&
        m.id === req.questionId &&
        m.folder === "共用服务/parser" &&
        m.capabilityRequest?.id === req.id,
    ),
  );
  const feedback = "/api/zoom/tasks/" + req.taskId + "/replies";
  assert.equal((await f.send(decisions, accept(req), f.agent)).status, 401);
  assert.equal((await f.send(feedback, { questionId: req.questionId, choice: "批准" }, f.agent)).status, 401);
  assert.equal(
    (
      await f.send("/api/zoom/tasks/" + req.taskId + "/messages", {
        eventId: "done",
        kind: "completed",
        body: "提前完成",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.send("/api/opc/opportunities", {
        project: repo,
        sourceId: "capability-gap/" + req.id + "/r1",
        kind: "feature",
        title: "提前",
        rationale: "跳过",
        evidence: ["a"],
      })
    ).status,
    409,
  );
  const old = accept(req);
  await f.result(feedback, { questionId: req.questionId, choice: "拒绝", body: "范围太大" }, f.owner);
  req = await f.result<CapabilityRequest>(revisions, {
    baseRevision: 1,
    title: "小范围文本兼容",
    detail: "验收覆盖两个单元测试用例。",
  });
  assert.equal((await f.send(decisions, old, f.owner)).status, 409);
  req = await f.result<CapabilityRequest>(
    decisions,
    { revision: 2, questionId: req.questionId, action: "changes", note: "再加边界样例" },
    f.owner,
  );
  assert.equal(req.status, "changes");
  const patch = {
    baseRevision: 2,
    title: "增加边界样例",
    detail: "维护方 parser 验收三类输入，消费方复测导入流程。",
  };
  req = await f.result<CapabilityRequest>(revisions, patch);
  assert.equal((await f.result<CapabilityRequest>(revisions, patch)).revision, 3);
  assert.equal((await f.send(revisions, { ...patch, repo: "example/fake" })).status, 400);
  assert.equal((await f.get<OpportunityIndex>("/api/opc/opportunities")).opportunities.length, 0);
  const target = accept(req),
    questionId = req.questionId;
  await f.result(feedback, { questionId, choice: "批准" }, f.owner);
  req = await f.get<CapabilityRequest>(root + "/requests/" + req.id);
  assert.equal(req.status, "approved");
  assert.deepEqual(
    req.revisions.map((v) => v.status),
    ["rejected", "changes", "approved"],
  );
  assert.ok(req.runId && req.opportunityId);
  assert.equal(req.capability.repo, repo);
  assert.equal(f.flow().get(req.runId).request.projectKey, repo);
  const runId = req.runId;
  assert.equal(f.flow().get(runId).summary.phase, "planning");
  await f.flow().tick();
  assert.deepEqual(f.launches, []);
  f.restart();
  assert.equal((await f.result<CapabilityRequest>(decisions, target, f.owner)).runId, runId);
  assert.equal((await f.result<CapabilityRequest>(root + "/requests", f.draft)).runId, runId);
  assert.equal((await f.send(decisions, { ...target, project: "other" }, f.owner)).status, 400);
  assert.equal((await f.send(revisions, { baseRevision: 3, title: "换目标", detail: "换仓" })).status, 409);
  assert.equal((await f.get<OpportunityIndex>("/api/opc/opportunities")).opportunities.length, 1);
  assert.equal(f.flow().list().length, 1);
});

test("原仓退回或拒绝后，使用方能明确改用已有版本并保留反馈", async t => {
  const f=await fixture(t);
  for (const action of ["changes","reject"] as const) {
    const project=consumer.product+"/"+consumer.project;
    const source=await f.result<{id:string}>("/api/opc/opportunities",{project,sourceId:action,kind:"feature",title:"采用文本能力",rationale:"试用现有接口",evidence:["fixture"],capabilityRefs:[f.capability.id]});
    const record=await f.result<CapabilityRequest>(root+"/requests",{...f.draft,requestId:action,sourceOpportunityId:source.id});
    const path=root+"/requests/"+record.id;
    const adoption={baseRevision:1,title:"现有接口已足够",detail:"接受格式限制，验证两种已支持输入"};
    assert.equal((await f.send(path+"/adopt",adoption)).status,409);
    await f.result(path+"/decisions",{revision:1,questionId:record.questionId,action,note:"本次保留原接口"},f.owner);
    const saved=await f.result<CapabilityRequest>(path+"/adopt",adoption);
    assert.deepEqual(saved.revisions.map(r=>r.status),[action==="reject"?"rejected":"changes","reused"]);
    assert.equal(saved.revisions[0].feedback,"本次保留原接口");
    assert.equal((await f.result<CapabilityRequest>(path+"/adopt",adoption)).revision,2);
    assert.equal((await f.send(path+"/revisions",adoption)).status,409);
    assert.equal(saved.opportunityId,null);
    assert.equal((await f.get<OpportunityIndex>("/api/opc/opportunities")).opportunities.find(i=>i.id===source.id)?.reuse?.status,"adopted");
  }
  assert.equal(f.flow().list().length,0);
});

test("原仓未绑定时批准留在维护方候选，不能回退到消费者工作区或全局工作区", async (t) => {
  const f = await fixture(t, false);
  const req = await f.result<CapabilityRequest>(root + "/requests", f.draft);
  const approved = await f.result<CapabilityRequest>(
    root + "/requests/" + req.id + "/decisions",
    { revision: 1, questionId: req.questionId, action: "approve" },
    f.owner,
  );
  assert.equal(approved.status, "approved");
  assert.ok(approved.opportunityId);
  assert.equal(approved.runId, null);
  assert.equal((await f.get<OpportunityIndex>("/api/opc/opportunities")).opportunities[0].project, repo);
  assert.equal(f.flow().list().length, 0);
});

test("消费候选的能力决策限定项目与原能力版本，不能用换项目或换方式重填", async (t) => {
  const f = await fixture(t);
  const lead = await f.result<{ id: string }>("/api/opc/opportunities", {
    project: consumer.product + "/" + consumer.project,
    kind: "feature",
    sourceId: "fixture-need",
    title: "测试采用能力",
    rationale: "核对消费项目的目标",
    evidence: ["fixture"],
  });
  const linked = { ...f.draft, sourceOpportunityId: lead.id, mode: "reuse" };
  assert.equal((await f.send(root + "/requests", { ...linked, ...ownerProject })).status, 409);
  const req = await f.result<CapabilityRequest>(root + "/requests", linked);
  assert.equal(req.sourceOpportunityId, lead.id);
  assert.equal((await f.send(root + "/requests", { ...linked, requestId: "switch", mode: "gap" })).status, 409);
  assert.equal((await f.get<CapabilityIndex>(root)).requests.length, 1);
  const wrongCommit = "a".repeat(40);
  assert.equal((await f.send(root, { ...f.form, version: wrongCommit })).status, 409);
  assert.equal(
    (await f.send(root, { ...f.form, evidence: "https://github.com/" + repo + "/blob/main/README.md" })).status,
    409,
  );
});

test("维护方起草工程计划失败后，已批准的原需求和队列仍可对账并恢复", async (t) => {
  const f = await fixture(t);
  const req = await f.result<CapabilityRequest>(root + "/requests", f.draft);
  const route = root + "/requests/" + req.id + "/decisions",
    choice = { revision: 1, questionId: req.questionId, action: "approve" };
  f.db().exec(
    "CREATE TRIGGER unavailable_workflow BEFORE INSERT ON workflow_runs BEGIN SELECT RAISE(ABORT,'temporary failure'); END",
  );
  const waiting = await f.result<CapabilityRequest>(route, choice, f.owner);
  assert.equal(waiting.status, "approved");
  assert.ok(waiting.opportunityId && waiting.planProblem);
  assert.equal(waiting.runId, null);
  f.db().exec("DROP TRIGGER unavailable_workflow");
  f.restart();
  const done = await f.result<CapabilityRequest>(route, choice, f.owner);
  assert.equal(done.opportunityId, waiting.opportunityId);
  assert.ok(done.runId);
  assert.equal(done.planProblem, null);
  assert.equal(f.flow().list().length, 1);
});

const consumerKey = consumer.product + "/" + consumer.project;
function candidate(sourceId: string, title: string) {
  return { project: consumerKey, kind: "feature", sourceId, title, rationale: "用户提出了具体需求",
    evidence: ["fixture/readme"], impact: 5 };
}

test("显式引用需先复用，刷新来源、冒用选题请求和直接修改计划不能绕过；无关的低分候选可推进", async t => {
  const f = await fixture(t, true, [consumerKey]);
  const add = (body: unknown) => f.result<Opportunity>("/api/opc/opportunities", body);
  const target = candidate("wanted", "重新实现 " + repo + " 供导入时使用");
  const pinned = await add(target);
  assert.deepEqual(pinned.capabilityRefs, [repo]);
  await add({ ...target, title: "导入时使用" });
  const other = await add({ ...candidate("unrelated", "调整表单边距"), impact: 1,
    evidence: ["https://github.com/" + repo + "/issues/1"] });
  const queue = new OpportunityStore(f.db(), f.flow());
  assert.equal(queue.select(consumerKey)?.id, other.id);
  const item = () => queue.list(consumerKey).opportunities.find(row => row.id === pinned.id)!;
  assert.equal(item().reuse?.status, "needs_decision");
  assert.equal(item().reuse?.capabilities[0].id, f.capability.id);
  const plain = { version: 1, requestId: "manual", context: "task/2", source: "CLI", goal: "搜索解析能力", constraints: [] };
  for (const input of [
    { ...plain, goal: "请开发 " + repo + " 替代品" },
    { ...plain, capabilityRefs: [f.capability.id] },
    { ...plain, capabilityRefs: ["unknown/repo"] },
    { ...plain, requestId: "opc-" + pinned.id },
    { opportunityId: pinned.id },
  ]) assert.equal((await f.send("/api/workflows", input)).status, 409);
  assert.equal((await f.send("/api/workflows", { opportunityId: pinned.id, ...plain })).status, 400);
  const response = await f.send("/api/workflows", { ...plain, goal: "更新文本解析的用户输入样例" });
  assert.equal(response.status, 202);
  const direct = await response.json() as WorkflowDetail;
  assert.match(direct.revisions[0].reuseCheck!.command, /capability list/);
  assert.match(direct.revisions[0].reuseCheck!.instruction, /capability discover/);
  assert.equal(direct.revisions[0].reuseCheck!.suggestions[0].id, f.capability.id);
  const plan = direct.revisions[0].plan;
  assert.throws(() => f.flow().revise(direct.id, { baseRevision: 1, reason: "变更目标",
    plan: { ...plan, nodes: plan.nodes.map((n, i) => i === 0 ? { ...n, instruction: "重造 " + repo } : n) } }), { status: 409 });
  assert.equal(f.flow().get(direct.id).revisions.length, 1);

  const unrelated = f.flow().get(queue.list(consumerKey).opportunities.find(o => o.id === other.id)!.runId!);
  f.flow().decide(unrelated.id, { revision: 1, cardId: unrelated.cards[0].id, action: "reject", note: "暂停" }, "test");
  await f.result(root + "/requests", { ...f.draft, mode: "reuse" });
  assert.equal(queue.select(consumerKey), null);
  await f.result(root + "/requests", { ...f.draft, requestId: "use-candidate", mode: "reuse", sourceOpportunityId: pinned.id });
  assert.equal(item().reuse?.status, "adopted");
  const linked = await f.send("/api/workflows", { opportunityId: pinned.id });
  assert.equal(linked.status, 202);
  const run = await linked.json() as WorkflowDetail;
  assert.equal(run.request.projectKey, consumerKey);
  assert.equal(run.reusePolicy, "adopted");
  assert.ok(run.request.constraints.join("\n").includes(f.form.evidence));
  assert.ok(run.request.constraints.join("\n").includes(f.form.interfaceRef));
  assert.ok(run.request.constraints.join("\n").includes(f.draft.detail));
  assert.ok(run.request.constraints.join("\n").includes("不构成操作授权"));
  assert.equal(run.revisions[0].plan.nodes[0].title, "接入原仓接口");
  assert.deepEqual(run.revisions[0].plan.nodes[1].dependsOn, ["implement"]);
  assert.throws(() => f.flow().revise(run.id, { baseRevision: 1, reason: "改到消费项目重做",
    plan: { nodes: plan.nodes, acceptance: plan.acceptance } }), { status: 409 });
  const switched = f.flow().selectRunner(run.id, { baseRevision: 1, cardId: run.cards[0].id, nodeId: "implement", capability: "extra" }, "测试");
  assert.equal(switched.revisions[1].plan.nodes[0].capability, "extra");
  assert.equal(f.flow().submit({ opportunityId: pinned.id }).id, run.id);
  await f.flow().tick();
  assert.deepEqual(f.launches, []);
  f.flow().decide(direct.id, {cardId: direct.cards[0].id, revision: 1, action: "approve"}, "测试");
  for (const nodeId of ["implement", "review"]) {
    await f.flow().tick();
    const attempt = f.flow().get(direct.id).attempts.find(a => a.nodeId === nodeId)!;
    const payload = JSON.parse(readFileSync(join(dirname(attempt.worktree), "payload.json"), "utf8"));
    assert.deepEqual(payload.reuseCheck, direct.revisions[0].reuseCheck);
    assert.ok(payload.reuseCatalog.some((c: RepoCapability) => c.repo === repo && c.version === f.form.version));
    f.flow().recordReceipt(direct.id, {runId:direct.id,nodeId,attemptId:attempt.id,revision:1,outcome:"succeeded",
      summary:"验证了目录交接",checks:[{name:"fixture",exitCode:0,output:"passed"}],artifacts:[],patch:""});
  }
});

test("原需求完整批准后在维护项目排队，后续同一能力新版本需要消费项目明确采用", async t => {
  const f = await fixture(t, true, [consumerKey]);
  const queue = new OpportunityStore(f.db(), f.flow());
  const lead = queue.add({ ...candidate("need-parser", "需要预览双编码文本"), capabilityRefs: [f.capability.id] });
  const old = queue.add({ ...candidate("busy-owner", "更新维护仓欢迎页"), project: repo });
  assert.equal(queue.select(repo)?.id, old.id);
  const detail = "原仓需保留兼容样例。".repeat(125) + "验收最后一项：支持混合编码。";
  const req = await f.result<CapabilityRequest>(root + "/requests", { ...f.draft, sourceOpportunityId: lead.id, detail });
  assert.equal(queue.select(consumerKey), null);
  const approved = await f.result<CapabilityRequest>(root + "/requests/" + req.id + "/decisions",
    { revision: 1, questionId: req.questionId, action: "approve" }, f.owner);
  assert.equal(approved.runId, null);
  const busy = f.flow().get(queue.list(repo).opportunities.find(o => o.id === old.id)!.runId!);
  f.flow().decide(busy.id, { revision: 1, cardId: busy.cards[0].id, action: "reject", note: "腾出维护安排" }, "test");
  f.restart();
  const recovered = new OpportunityStore(f.db(), f.flow());
  recovered.tick();
  const ownerItem = recovered.list(repo).opportunities.find(o => o.id === approved.opportunityId)!;
  const run = f.flow().get(ownerItem.runId!);
  assert.equal(run.request.projectKey, repo);
  assert.equal(run.reusePolicy, "upstream");
  assert.match(run.request.context, /已批准 r1/);
  assert.ok(run.request.context.includes("#capabilities?request=" + req.id));
  assert.ok(run.request.context.includes(consumerKey));
  assert.ok(run.request.context.includes(detail));
  assert.ok(run.request.constraints.join("\n").includes(f.form.evidence));
  assert.equal(recovered.select(consumerKey), null);
  const publish = (name: string, version: string) => f.result<RepoCapability>(root, { ...f.form, name, version,
    evidence: "https://github.com/" + repo + "/blob/" + version + "/README.md" });
  const workspace = run.workspace;
  execFileSync("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-qm", "provider added the approved mixed encoding case"]);
  const tip = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {encoding:"utf8"}).trim();
  const next = await publish(f.form.name, tip);
  const other = await publish("另一个接口", "c".repeat(40));
  assert.equal(recovered.select(consumerKey), null);
  const adopt = (capability: RepoCapability, satisfiesRequestId?: string) => f.result(root + "/requests", { ...f.draft,
    mode: "reuse", requestId: "adopt-" + capability.id + (satisfiesRequestId ?? ""), sourceOpportunityId: lead.id, capabilityId: capability.id, satisfiesRequestId }, f.owner);
  await adopt(other);
  assert.equal(recovered.select(consumerKey), null);
  await adopt(next);
  assert.equal(recovered.select(consumerKey), null);
  await adopt(next, req.id);
  const ready = recovered.trySelectLinked(lead.id);
  assert.ok(ready.runId);
  const integrated = f.flow().get(ready.runId);
  assert.equal(integrated.reusePolicy, "adopted");
  assert.ok(integrated.request.constraints.join("\n").includes(next.evidence));
  assert.ok(integrated.request.constraints.join("\n").includes("#capabilities?request=" + req.id));
  assert.ok(!integrated.request.constraints.join("\n").includes(f.form.version));
  assert.equal(integrated.request.projectKey, consumerKey);
  assert.equal(f.flow().submit({ opportunityId: lead.id }).id, integrated.id);
  assert.equal(f.flow().list().length, 3);
});

test("维护项目未绑定时可显式采用已验证的回移版本，审批与普通采用本身不会改动固定引用", async t => {
  const f = await fixture(t, false, [consumerKey]);
  const release = (version: string) => f.result<RepoCapability>(root, { ...f.form, version,
    evidence: "https://github.com/" + repo + "/releases/tag/" + version });
  const fixed = await release("v2.0.0"), backport = await release("v1.9.4");
  const queue = new OpportunityStore(f.db(), f.flow());
  const lead = queue.add({ ...candidate("pin-v2", "处理混合编码"), capabilityRefs: [fixed.id] });
  const gap = await f.result<CapabilityRequest>(root + "/requests", { ...f.draft,
    capabilityId: fixed.id, sourceOpportunityId: lead.id });
  await f.result(root + "/requests/" + gap.id + "/decisions", { revision: 1, questionId: gap.questionId, action: "approve" }, f.owner);
  const ordinary = { ...f.draft, mode: "reuse", requestId:"ordinary-backport", sourceOpportunityId:lead.id, capabilityId:backport.id };
  await f.result(root + "/requests", ordinary);
  assert.equal(queue.select(consumerKey), null);
  const confirm = { ...ordinary, requestId:"confirmed-backport", satisfiesRequestId:gap.id,
    detail:"维护仓 v1.9.4 的回移补丁已覆盖之前失败的两种编码，消费方复测通过。", deliveryEvidence:backport.evidence };
  assert.equal((await f.send(root + "/requests", confirm, f.agent)).status, 401);
  const confirmed = await f.result<CapabilityRequest>(root + "/requests", confirm, f.owner);
  assert.equal(confirmed.capabilityId, backport.id);
  const run = f.flow().submit({opportunityId:lead.id});
  assert.equal(run.reusePolicy, "adopted");
  assert.ok(run.request.constraints.join("\n").includes(backport.evidence));
  assert.ok(run.request.constraints.join("\n").includes(confirm.detail));
});

test("版本选择器只读目录；补登记验收保留原用途、原仓版本凭据、人工回执和幂等键", async t=>{
  const f=await fixture(t,false);
  const source=await f.result<{id:string}>("/api/opc/opportunities",{project:consumer.product+"/"+consumer.project,kind:"feature",
    sourceId:"linked-record",title:"读混合文本",rationale:"核对实际样例",evidence:["fixture"],capabilityRefs:[f.capability.id]});
  const gap=await f.result<CapabilityRequest>(root+"/requests",{...f.draft,sourceOpportunityId:source.id});
  const capsOnly=await f.get<{capabilities:RepoCapability[]}>(root+"/versions");
  assert.deepEqual(Object.keys(capsOnly),["capabilities"]);
  assert.deepEqual(capsOnly.capabilities,(await f.get<CapabilityIndex>(root)).capabilities);
  const sourceUrl="https://github.com/"+repo+"/blob/"+"d".repeat(40)+"/";
  const next=await f.result<RepoCapability>(root,{...f.form,version:"d".repeat(40),evidence:sourceUrl+"README.md"});
  const ordinary={...f.draft,sourceOpportunityId:source.id, mode:"reuse",requestId:"normal-adopt",title:"独立使用解析器",detail:"原采用用途",capabilityId:next.id};
  const adopted=await f.result<CapabilityRequest>(root+"/requests",ordinary);
  assert.equal(adopted.satisfiesRequestId,null);
  // Reopen an existing directory without the delivery-confirmation table.
  f.db().exec("DROP TABLE opc_capability_satisfaction");
  f.restart();
  assert.equal((await f.get<CapabilityRequest>(root+"/requests/"+adopted.id)).satisfiesRequestId,null);
  await assert.rejects(f.get(root+"/versions",{}),/401/);
  const proof={...ordinary,requestId:"proof-one",satisfiesRequestId:gap.id,title:"验收两个场景",detail:"对回移分支分别输入两种编码，输出逐字相符。",deliveryEvidence:sourceUrl+"tests/encoding.md"};
  assert.equal((await f.send(root+"/requests",proof,f.owner)).status,409);
  await f.result(root+"/requests/"+gap.id+"/decisions",{revision:1,questionId:gap.questionId,action:"approve"},f.owner);
  assert.equal((await f.send(root+"/requests",proof,f.agent)).status,401);
  assert.equal((await f.send(root+"/requests",{...proof,deliveryEvidence:f.form.evidence},f.owner)).status,409);
  const confirmed=await f.result<CapabilityRequest>(root+"/requests",proof,f.owner);
  assert.equal(confirmed.id,adopted.id);assert.equal(confirmed.detail,ordinary.detail);
  assert.equal(confirmed.satisfiesRequestId,gap.id); assert.equal(confirmed.satisfactionReference,proof.deliveryEvidence);
  assert.equal(confirmed.satisfactionEvidence,proof.detail); assert.ok(confirmed.satisfactionAt&&confirmed.satisfactionActor);
  f.restart();
  assert.deepEqual(await f.result<CapabilityRequest>(root+"/requests",{...proof,requestId:"same-proof-again"},f.owner),confirmed);
  assert.equal((await f.send(root+"/requests",{...proof,requestId:"new-proof",detail:"换个结论"},f.owner)).status,409);
  assert.equal((await f.get<CapabilityIndex>(root)).requests.filter(r=>r.capabilityId===next.id).length,1);
});
