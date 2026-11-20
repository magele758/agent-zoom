import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./server/db.ts";
import { OpportunityStore } from "./server/autonomy.ts";
import { BusinessStore } from "./server/business.ts";
import { ZoomStore } from "./server/zoom.ts";

test("经营线独立保存实验、财务凭据和原决定，跨线提案须明确指定证据与项目", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const queue = new OpportunityStore(db),
    company = new BusinessStore(db, queue),
    zoom = new ZoomStore(db);
  assert.equal(company.index().lines.length, 2);
  const spec = {
    name: "商店乙",
    goal: "验证草稿检查",
    mode: "experiment",
    steps: ["草稿检查", "人工核对"],
    assets: [{ kind: "plugin", name: "测试插件", reference: "插件 v1" }],
  };
  const line = company.create(spec);
  assert.equal(company.create(spec).id, line.id);
  const input = {
    requestId: "trial-1",
    title: "测试十份草稿",
    hypothesis: "减少漏填",
    scope: "仅检查测试草稿",
    metric: "漏填次数",
  };
  const trial = company.start(line.id, input);
  assert.equal(company.start(line.id, input).id, trial.id);
  company.update(line.id, { ...spec, revision: line.revision, assets: [] });
  assert.throws(() => company.update(line.id, { ...spec, revision: line.revision }), /已更新/);
  assert.deepEqual(company.index().trials[0].recipe.assets, spec.assets);
  assert.throws(() => company.review(trial.id), /先登记/);
  const event = {
    eventId: "payment",
    kind: "receipt",
    currency: "MXN",
    minor: 2500,
    note: "测试支付",
    reference: "demo/channel/order-1",
  };
  const saved = company.record(trial.id, event);
  assert.equal(company.record(trial.id, event).evidence.length, 1);
  assert.throws(() => company.record(trial.id, { ...event, minor: 1 }), /标识/);
  const second = company.start("shop", { ...input, requestId: "second" });
  assert.throws(() => company.record(second.id, event), /其他记录/);
  assert.throws(() => company.record(second.id, { ...event, currency: "MXN", minor: 1.25 }), /minor/);
  assert.equal(queue.list().opportunities.length, 0);
  const request = { project: "plugin-repository", evidenceId: saved.evidence[0].id, title: "增强字段检查" };
  assert.throws(() => company.refer(second.id, request), /这个实验/);
  const referred = company.refer(trial.id, request);
  assert.equal(referred.referrals[0].project, "plugin-repository");
  assert.equal(company.refer(trial.id, request).referrals.length, 1);
  assert.equal(queue.list().opportunities[0].state, "queued");
  const reviewed = company.review(trial.id);
  assert.equal(company.review(trial.id).questionId, reviewed.questionId);
  assert.throws(
    () => company.record(trial.id, { ...event, eventId: "late", reference: "later" }),
    /本轮证据已提交/,
  );
  const summary = company.catalog().find((row) => row.id === line.id)!;
  assert.deepEqual([summary.trials, summary.pendingReviews, summary.transactions], [1, 1, 1]);
  zoom.reply(trial.taskId, { questionId: reviewed.questionId, choice: "调整", body: "再试另一种草稿" }, "本机");
  assert.equal(company.index().trials.find((r) => r.id === trial.id)?.decision, "调整");
  assert.equal(company.catalog().find((row) => row.id === line.id)?.pendingReviews, 0);
  assert.equal(zoom.messages().filter((m) => m.pending).length, 0);
});

test("项目能按层级和领域保存，跨项目引用保留具体版本与采用方上下文", async (t) => {
  const { ProjectStore } = await import("./server/projects.ts");
  const { CompanyStore } = await import("./server/company.ts");
  const { ProjectProfiles } = await import("./server/project-profiles.ts");
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const catalog = new ProjectStore(db),
    company = new CompanyStore(db),
    profiles = new ProjectProfiles(db);
  catalog.create({ name: "插件" });
  catalog.create({ name: "网店" });
  company.createProject({ product: "插件", name: "检查规则" });
  company.createProject({ product: "网店", name: "上架" });
  const source = { product: "插件", project: "检查规则", reference: "v1.2", purpose: "验证草稿完整性" };
  const update = {
    product: "网店",
    project: "上架",
    layer: "业务应用",
    domain: "零售",
    revision: 0,
    uses: [source],
  };
  const saved = profiles.save(update);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.uses, [source]);
  assert.deepEqual(profiles.save(update), saved);
  assert.throws(() => profiles.save({ ...update, domain: "服务" }), /已经更新/);
  assert.throws(() => profiles.save({ ...saved, uses: [{ ...source, project: "不存在" }] }), /来源项目/);
  assert.deepEqual(
    profiles.all().find((row) => row.product === "网店"),
    saved,
  );
});
