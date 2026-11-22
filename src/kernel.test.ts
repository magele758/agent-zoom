import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { OpcKernel } from "./kernel/index.ts";
import { ApiError } from "./server/logic.ts";

test("OpcKernel: canonical Mainline -> Product -> Asset registry, admission freeze, and kill-switch enforcement", () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);

  const tree = kernel.registry.portfolio();
  assert.ok(tree.mainlines.length >= 2, "should seed core mainlines");

  const resolved = kernel.registry.resolveCanonicalRef("PageLens/pagelens-interpret");
  assert.equal(resolved.product?.name, "PageLens");
  assert.equal(resolved.asset?.name, "pagelens-interpret");
  assert.equal(resolved.mainline?.slug, "flagship-monetization");

  // Default admission allowed
  assert.equal(kernel.registry.checkAdmission("PageLens/pagelens-interpret").allowed, true);

  // Enable freezeNonMainline on Agent Dark Factory mainline ONLY
  const otherMainline = kernel.registry.getMainlineBySlug("flagship-monetization")!;
  kernel.registry.upsertMainline({
    id: "ml_dark_factory",
    name: "Agent 暗工厂与一人公司中枢",
    freezeNonMainline: true,
  });

  // Unmapped side-project should now be blocked by mainline_frozen
  const blockedSide = kernel.registry.checkAdmission("random-toy-repo");
  assert.equal(blockedSide.allowed, false);
  assert.equal(blockedSide.code, "mainline_frozen");

  // Emergency bug bypasses freeze
  const emergencyBypass = kernel.registry.checkAdmission("random-toy-repo", { isEmergencyBug: true });
  assert.equal(emergencyBypass.allowed, true);

  // Reset freeze, test asset pause
  kernel.registry.upsertMainline({
    id: "ml_dark_factory",
    name: "Agent 暗工厂与一人公司中枢",
    freezeNonMainline: false,
  });
  assert.equal(otherMainline.status, "active");

  kernel.registry.upsertAsset({
    id: resolved.asset!.id,
    productId: resolved.product!.id,
    name: resolved.asset!.name,
    paused: true,
  });
  const pausedCheck = kernel.registry.checkAdmission("pagelens-interpret");
  assert.equal(pausedCheck.allowed, false);
  assert.equal(pausedCheck.code, "asset_paused");

  db.close();
});

test("DecisionGateway: deduplication, markViewed preserves pending, low-risk auto-approve, redline gate, and deterministic callbacks", async () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);

  const executed: Array<{ key: string; optionId: string; note: string }> = [];
  kernel.decisions.registerHandler("test.low_risk_run", ({ option, note }) => {
    executed.push({ key: "test.low_risk_run", optionId: option.id, note });
    return { dispatchedRun: "run_auto_1" };
  });
  kernel.decisions.registerHandler("test.prod_release", ({ option, note }) => {
    executed.push({ key: "test.prod_release", optionId: option.id, note });
    return { releasedVersion: "v1.2.0" };
  });

  // 1. Low-risk within cost ceiling ($0.5 <= $2.0) auto-approves immediately!
  const autoPkt = await kernel.decisions.propose({
    dedupeKey: "product:lint-fix:1",
    domain: "product",
    kind: "minor_maintenance",
    riskLevel: "low",
    projectOrAssetRef: "opc-os",
    title: "自动修复类型导出警告",
    backgroundSummary: "静态检查发现未使用类型导入，风险极低。",
    costEstimateUsd: 0.5,
    options: [
      {
        id: "go",
        label: "自动派发修复",
        outcome: "approved",
        handlerKey: "test.low_risk_run",
      },
    ],
    recommendedOptionId: "go",
  });
  assert.equal(autoPkt.status, "approved");
  assert.equal(autoPkt.autoApproved, true);
  assert.equal(executed.length, 1);
  assert.equal(autoPkt.handlerResult?.dispatchedRun, "run_auto_1");

  // 2. Redline kind ('production_release') NEVER auto-approves even if cost is $0.1
  const releasePkt1 = await kernel.decisions.propose({
    dedupeKey: "factory:release:pagelens-v1",
    domain: "factory",
    kind: "production_release",
    riskLevel: "low",
    projectOrAssetRef: "PageLens/pagelens-interpret",
    title: "发布 PageLens v1.2.0 到生产环境",
    backgroundSummary: "已完成外部跑测 verify_command (exit 0)。",
    whyRecommended: "全量单测通过，含回滚锚点。",
    costEstimateUsd: 0.1,
    diffOrEvidence: "3 files changed, +84 -12",
    rollbackPlan: "git reset --hard abc1234",
    options: [
      {
        id: "ship",
        label: "批准合入并发布",
        outcome: "approved",
        handlerKey: "test.prod_release",
      },
      {
        id: "reject",
        label: "暂缓发布",
        outcome: "rejected",
        handlerKey: "noop",
      },
    ],
    recommendedOptionId: "ship",
  });
  assert.equal(releasePkt1.status, "pending");
  assert.equal(releasePkt1.autoApproved, false);

  // 3. Re-proposing with same dedupeKey updates in place instead of duplicating pending items
  const releasePkt2 = await kernel.decisions.propose({
    dedupeKey: "factory:release:pagelens-v1",
    domain: "factory",
    kind: "production_release",
    riskLevel: "high",
    projectOrAssetRef: "PageLens/pagelens-interpret",
    title: "发布 PageLens v1.2.1 到生产环境",
    backgroundSummary: "更新了构建产物校验。",
    options: releasePkt1.options,
  });
  assert.equal(releasePkt2.id, releasePkt1.id);
  assert.equal(kernel.decisions.counts().pending, 1);

  // 4. Viewing the packet MUST NOT drop it out of pending!
  const viewed = kernel.decisions.markViewed(releasePkt2.id);
  assert.ok(viewed.viewedAt);
  assert.equal(viewed.status, "pending");
  assert.equal(kernel.decisions.counts().pending, 1);

  // 5. Resolving invokes deterministic handler and transitions status
  const resolved = await kernel.decisions.resolve(releasePkt2.id, {
    optionId: "ship",
    note: "核验通过，准予上线",
    actor: "founder",
  });
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.handlerResult?.releasedVersion, "v1.2.0");
  assert.equal(kernel.decisions.counts().pending, 0);

  // Double-resolve rejected with 409
  await assert.rejects(
    () => kernel.decisions.resolve(releasePkt2.id, { optionId: "ship" }),
    (err: unknown) => err instanceof ApiError && err.status === 409,
  );

  // HTTP routes smoke check
  const app = new Hono();
  kernel.registerRoutes(app, () => ({ id: "u1", name: "founder" }));
  const archRes = await app.request("/api/opc/kernel/architecture");
  assert.equal(archRes.status, 200);
  const arch = (await archRes.json()) as { departments: unknown[]; counts: { domainEvents: number } };
  assert.equal(arch.departments.length, 6);
  assert.ok(arch.counts.domainEvents >= 3);

  db.close();
});

test("GovernancePolicy: autonomyMode presets (assisted / semi_auto / full_auto), granular inference, and legacy table migration", async () => {
  // Simulate pre-migration opc_governance_policy table (without autonomy_mode & granular flags)
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE opc_governance_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      auto_approve_low_risk INTEGER NOT NULL DEFAULT 1,
      auto_approve_max_cost_usd REAL NOT NULL DEFAULT 2.0,
      redline_kinds_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO opc_governance_policy (singleton, auto_approve_low_risk, auto_approve_max_cost_usd, redline_kinds_json, updated_at)
    VALUES (1, 1, 2.0, '["production_release"]', '2026-11-21T00:00:00.000Z');
  `);

  const kernel = new OpcKernel(db);
  const initial = kernel.decisions.getPolicy();
  assert.equal(initial.autonomyMode, "full_auto");
  assert.equal(initial.autoApproveLowRisk, true);
  assert.equal(initial.autoPromoteSignals, true);
  assert.equal(initial.autoHarvestQuota, true);
  assert.equal(initial.autoHealOps, true);

  // Switch to assisted mode -> disables all 4 autonomous switches
  const assisted = kernel.decisions.updatePolicy({ autonomyMode: "assisted" });
  assert.equal(assisted.autonomyMode, "assisted");
  assert.equal(assisted.autoApproveLowRisk, false);
  assert.equal(assisted.autoPromoteSignals, false);
  assert.equal(assisted.autoHarvestQuota, false);
  assert.equal(assisted.autoHealOps, false);

  // Low-risk decision MUST stay pending in assisted mode
  kernel.decisions.registerHandler("test.noop", () => ({ ok: true }));
  const pkt = await kernel.decisions.propose({
    dedupeKey: "test:assisted-low-risk",
    domain: "product",
    kind: "minor_maintenance",
    riskLevel: "low",
    title: "人工协助模式下低风险也需人工拍板",
    backgroundSummary: "测试 assisted 模式拦截自动放行",
    costEstimateUsd: 0.2,
    options: [{ id: "ok", label: "批准", outcome: "approved", handlerKey: "test.noop" }],
    recommendedOptionId: "ok",
  });
  assert.equal(pkt.status, "pending");
  assert.equal(pkt.autoApproved, false);

  // Switch to semi_auto -> only autoHealOps is enabled
  const semi = kernel.decisions.updatePolicy({ autonomyMode: "semi_auto" });
  assert.equal(semi.autonomyMode, "semi_auto");
  assert.equal(semi.autoApproveLowRisk, false);
  assert.equal(semi.autoPromoteSignals, false);
  assert.equal(semi.autoHarvestQuota, false);
  assert.equal(semi.autoHealOps, true);

  // Toggling all remaining flags on infers full_auto
  const inferredFull = kernel.decisions.updatePolicy({
    autoApproveLowRisk: true,
    autoPromoteSignals: true,
    autoHarvestQuota: true,
  });
  assert.equal(inferredFull.autonomyMode, "full_auto");

  // Reject invalid autonomyMode
  assert.throws(
    () => kernel.decisions.updatePolicy({ autonomyMode: "bogus" as never }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );

  db.close();
});
