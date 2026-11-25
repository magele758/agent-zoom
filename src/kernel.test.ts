import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { OpcKernel } from "./kernel/index.ts";
import { isDigestOrNonActionableNoise } from "./kernel/admission-filter.ts";
import { extractJournalActionableItems } from "./domains/product/index.ts";
import { OpsDepartment } from "./domains/ops/index.ts";
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
  await assert.rejects(
    () => kernel.decisions.resolve(releasePkt2.id, { optionId: "ship", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" }),
    /审批单的内容已有更新/,
  );
  assert.equal(executed.length, 1);
  const resolved = await kernel.decisions.resolve(releasePkt2.id, {
    optionId: "ship",
    note: "核验通过，准予上线",
    actor: "founder",
    expectedUpdatedAt: viewed.updatedAt,
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

test("DecisionGateway.batchResolve: bulk reject/approve, redline two-step guard, and admission noise filtering", async () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);
  const actions: string[] = [];
  kernel.decisions.registerHandler("test.approve", ({ packet }) => {
    actions.push(`approve:${packet.id}`);
  });
  kernel.decisions.registerHandler("test.reject", ({ packet }) => {
    actions.push(`reject:${packet.id}`);
  });

  // 1. Digest noise detector blocks daily news headings and preserves real dev tasks
  assert.equal(isDigestOrNonActionableNoise("候选需求准入评估：三、 Twitter 双流其他高价值动态与行业风向").noisy, true);
  assert.equal(isDigestOrNonActionableNoise("午后增量更新（15:47 批次）").noisy, true);
  assert.equal(isDigestOrNonActionableNoise("GitHub Daily Trending 速览").noisy, true);
  assert.equal(isDigestOrNonActionableNoise("待观察").noisy, true);
  assert.equal(isDigestOrNonActionableNoise("新增 opc-commerce doctor 诊断命令与单元测试").noisy, false);
  assert.equal(isDigestOrNonActionableNoise("晨间构建增量失败重试").noisy, false);
  assert.equal(isDigestOrNonActionableNoise("修复周期性巡检误报").noisy, false);
  assert.equal(isDigestOrNonActionableNoise("1. 新增用户登录限流与单测").noisy, false);
  assert.equal(isDigestOrNonActionableNoise("1、新增 opc-commerce doctor 诊断命令与单元测试").noisy, false);
  assert.equal(isDigestOrNonActionableNoise("1. 数据概览").noisy, true);

  // 2. Journal extractor ignores news headings and only extracts explicit todos / action bullets
  const sampleJournal = [
    "## 一、 新增一手核心信号（相对 01:50 批次增量）",
    "- 行业动态速览",
    "## 三、 Twitter 双流其他高价值动态与行业风向",
    "- 某推特长文摘要",
    "## 行动项",
    "- [ ] 为 pagelens-interpret 增加离线字幕导出单测",
    "- [x] 已完成旧项",
  ].join("\n");
  const extracted = extractJournalActionableItems(sampleJournal);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].title, "为 pagelens-interpret 增加离线字幕导出单测");

  // 3. Create 2 medium feature_admission packets (one noisy!) + 1 redline production_release
  const p1 = await kernel.decisions.propose({
    dedupeKey: "batch:noise:1",
    domain: "product",
    kind: "feature_admission",
    riskLevel: "medium",
    title: "候选需求准入评估：GitHub Daily Trending 速览",
    backgroundSummary: "来源：journal:2026-11-19.md · 关联项目：default",
    options: [
      { id: "promote", label: "准入立项", outcome: "approved", handlerKey: "test.approve" },
      { id: "drop", label: "驳回丢弃", outcome: "rejected", handlerKey: "test.reject" },
    ],
    recommendedOptionId: "promote",
  });
  assert.ok(p1.admissionWarning, "legacy noisy feature_admission packet should expose admissionWarning");
  assert.equal(p1.recommendedOptionId, "drop", "warning packet recommendation should flip safely to reject/drop");

  const p2 = await kernel.decisions.propose({
    dedupeKey: "batch:real:2",
    domain: "product",
    kind: "feature_admission",
    riskLevel: "medium",
    projectOrAssetRef: "pagelens-interpret",
    title: "需求准入立项：新增离线字幕导出单测",
    backgroundSummary: "明确归属 pagelens-interpret 仓库",
    options: [
      { id: "promote", label: "准入立项", outcome: "approved", handlerKey: "test.approve" },
      { id: "drop", label: "驳回丢弃", outcome: "rejected", handlerKey: "test.reject" },
    ],
    recommendedOptionId: "promote",
  });
  assert.equal(p2.admissionWarning, null);
  assert.equal(p2.targetSummary?.assetName, "pagelens-interpret");

  const pRedline = await kernel.decisions.propose({
    dedupeKey: "batch:release:3",
    domain: "factory",
    kind: "production_release",
    riskLevel: "high",
    projectOrAssetRef: "pagelens-interpret",
    title: "生产发布审批：pagelens-interpret v1.0",
    backgroundSummary: "外部校验全绿",
    options: [
      { id: "merge", label: "批准合并", outcome: "approved", handlerKey: "test.approve" },
      { id: "reject", label: "驳回发布", outcome: "rejected", handlerKey: "test.reject" },
    ],
    recommendedOptionId: "merge",
  });

  // Batch approving including redline MUST fail with 409 without allowRedline
  await assert.rejects(
    () => kernel.decisions.batchResolve({ ids: [p2.id, pRedline.id], action: "approve" }),
    (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === "redline_confirmation_required",
  );

  // Batch rejecting noise does NOT require allowRedline
  const rejectRes = await kernel.decisions.batchResolve({
    ids: [p1.id],
    action: "reject",
    note: "资讯摘要噪音批量清理",
  });
  assert.equal(rejectRes.resolvedCount, 1);
  assert.equal(kernel.decisions.get(p1.id)?.status, "rejected");

  // Batch approving with explicit allowRedline=true succeeds for both p2 and pRedline
  const approveRes = await kernel.decisions.batchResolve({
    ids: [p2.id, pRedline.id],
    action: "approve",
    allowRedline: true,
    note: "审查确认通过",
  });
  assert.equal(approveRes.resolvedCount, 2);
  assert.equal(kernel.decisions.get(p2.id)?.status, "approved");
  assert.equal(kernel.decisions.get(pRedline.id)?.status, "approved");
  assert.equal(approveRes.counts.pending, 0);

  // 4. OpsDepartment auto-clears stale pending cli_auth_expired alert once live CLI auth is healthy
  await kernel.decisions.propose({
    dedupeKey: "ops:auth_expired:cursor",
    domain: "ops",
    kind: "cli_auth_expired",
    riskLevel: "medium",
    title: "AI CLI 登录态已失效：Cursor (cursor)",
    backgroundSummary: "旧告警",
    options: [
      { id: "ack_relogin", label: "已完成重新登录", outcome: "approved", handlerKey: "ops.acknowledge_incident" },
    ],
    recommendedOptionId: "ack_relogin",
  });
  const ops = new OpsDepartment({
    kernel,
    readHubFn: () => ({
      generatedAt: new Date().toISOString(),
      feesAvailable: false,
      fees: [],
      tools: [
        {
          tool: "cursor",
          name: "Cursor",
          plan: "ultra",
          applicable: true,
          balances: [],
          windows: [],
        },
      ],
    }),
  });
  const cycle = await ops.runWatchdogCycle();
  assert.deepEqual(cycle.expiredAuthTools, []);
  const cleared = kernel.decisions.list({ status: "all", domain: "ops" }).find((d) => d.dedupeKey === "ops:auth_expired:cursor");
  assert.equal(cleared?.status, "approved");
  assert.equal(cleared?.decidedBy, "ops-watchdog");

  db.close();
});

test("DecisionGateway bot-delegated resolution: hard redlines, verified release gate, and supersede", async () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);

  // Verify default bot policy columns & updatePolicy validation
  const initialPolicy = kernel.decisions.getPolicy();
  assert.equal(initialPolicy.botArbitrationMode, "off");
  assert.equal(initialPolicy.autoApproveVerifiedReleases, false);

  assert.throws(
    () => kernel.decisions.updatePolicy({ botArbitrationMode: "invalid" as never }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );

  // Setup minimal opc_releases + opc_agent_runs tables for authoritative DB gate checks
  db.exec(`
    CREATE TABLE opc_agent_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      project TEXT NOT NULL,
      protected_violations TEXT NOT NULL DEFAULT '[]',
      circuit_breaker_reason TEXT,
      verification_json TEXT
    );
    CREATE TABLE opc_releases (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      status TEXT NOT NULL
    );
  `);

  let executedHandlers: string[] = [];
  kernel.decisions.registerHandler("test.pricing", () => {
    executedHandlers.push("pricing");
  });
  kernel.decisions.registerHandler("test.security", () => {
    executedHandlers.push("security");
  });
  kernel.decisions.registerHandler("commercial.kill_switch_exempt", () => {
    executedHandlers.push("kill_exempt");
  });
  kernel.decisions.registerHandler("factory.release_merge_only", () => {
    executedHandlers.push("merge_only");
    return { status: "succeeded", mode: "merge_only" };
  });

  // 1. pricing_change, security_override, kill_switch exempt NEVER allowed for bot
  const pricingPkt = await kernel.decisions.propose({
    dedupeKey: "test:pricing:1",
    domain: "commercial",
    kind: "pricing_change",
    riskLevel: "critical",
    title: "调整订阅定价",
    backgroundSummary: "测试不可委托定价红线",
    options: [{ id: "ok", label: "批准涨价", outcome: "approved", handlerKey: "test.pricing" }],
  });
  const secPkt = await kernel.decisions.propose({
    dedupeKey: "test:security:1",
    domain: "ops",
    kind: "security_override",
    riskLevel: "critical",
    title: "例外放行安全门禁",
    backgroundSummary: "测试不可委托安全红线",
    options: [{ id: "ok", label: "例外放行", outcome: "approved", handlerKey: "test.security" }],
  });
  const killPkt = await kernel.decisions.propose({
    dedupeKey: "test:kill:1",
    domain: "commercial",
    kind: "kill_switch",
    riskLevel: "critical",
    title: "商业熔断",
    backgroundSummary: "测试不可委托豁免",
    options: [
      { id: "exempt", label: "豁免恢复", outcome: "rejected", handlerKey: "commercial.kill_switch_exempt" },
    ],
  });

  kernel.decisions.updatePolicy({ botArbitrationMode: "full_delegated", autoApproveVerifiedReleases: true });

  await assert.rejects(
    () => kernel.decisions.resolve(pricingPkt.id, { optionId: "ok", actor: "bot:super-bot", botDelegated: true }),
    (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "bot_delegation_forbidden",
  );
  await assert.rejects(
    () => kernel.decisions.resolve(secPkt.id, { optionId: "ok", actor: "bot:super-bot", botDelegated: true }),
    (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "bot_delegation_forbidden",
  );
  await assert.rejects(
    () => kernel.decisions.resolve(killPkt.id, { optionId: "exempt", actor: "bot:super-bot", botDelegated: true }),
    (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "bot_delegation_forbidden",
  );
  assert.deepEqual(executedHandlers, []);

  // 2. production_release with failed verification or protected violations blocked by DB check
  db.prepare(
    "INSERT INTO opc_agent_runs (id, status, project, protected_violations, verification_json) VALUES (?, ?, ?, ?, ?)",
  ).run("run_bad_test", "completed", "opc-gtm-kit", "[]", JSON.stringify({ passed: false, exitCode: 1 }));
  db.prepare("INSERT INTO opc_releases (id, run_id, status) VALUES (?, ?, ?)").run("rel_bad_test", "run_bad_test", "pending_approval");

  const badRelPkt = await kernel.decisions.propose({
    dedupeKey: "factory:production_release:rel_bad_test",
    domain: "factory",
    kind: "production_release",
    riskLevel: "high",
    title: "发布失败测试分支",
    backgroundSummary: "测试校验失败阻断",
    options: [
      {
        id: "approve_merge_only",
        label: "仅合并代码",
        outcome: "approved",
        handlerKey: "factory.release_merge_only",
        payload: { releaseId: "rel_bad_test", mode: "merge_only" },
      },
    ],
  });
  await assert.rejects(
    () =>
      kernel.decisions.resolve(badRelPkt.id, {
        optionId: "approve_merge_only",
        actor: "bot:rd-vp",
        botDelegated: true,
        // Even if caller tries to spoof botContext, DB verification is authoritative!
        botContext: { releaseVerificationPassed: true, protectedViolationsCount: 0, runStatus: "completed" },
      }),
    (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "bot_release_gate_failed",
  );

  // 3. production_release with verified green run succeeds for bot-delegated resolution
  db.prepare(
    "INSERT INTO opc_agent_runs (id, status, project, protected_violations, verification_json) VALUES (?, ?, ?, ?, ?)",
  ).run("run_good", "completed", "opc-gtm-kit", "[]", JSON.stringify({ passed: true, exitCode: 0 }));
  db.prepare("INSERT INTO opc_releases (id, run_id, status) VALUES (?, ?, ?)").run("rel_good", "run_good", "pending_approval");

  const goodRelPkt = await kernel.decisions.propose({
    dedupeKey: "factory:production_release:rel_good",
    domain: "factory",
    kind: "production_release",
    riskLevel: "high",
    title: "发布校验全绿分支",
    backgroundSummary: "测试全绿放行",
    options: [
      {
        id: "approve_merge_only",
        label: "仅合并代码",
        outcome: "approved",
        handlerKey: "factory.release_merge_only",
        payload: { releaseId: "rel_good", mode: "merge_only" },
      },
    ],
  });
  const resolved = await kernel.decisions.resolve(goodRelPkt.id, {
    optionId: "approve_merge_only",
    actor: "bot:rd-vp",
    note: "Bot 审查通过，执行 merge_only",
    autoApproved: true,
    botDelegated: true,
  });
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.decidedBy, "bot:rd-vp");
  assert.equal(resolved.autoApproved, true);
  assert.deepEqual(executedHandlers, ["merge_only"]);

  // 4. supersede cleanly transitions pending packet without invoking handlers
  const sup = kernel.decisions.supersede(badRelPkt.id, {
    note: "已被新版本覆盖",
    actor: "bot:arbitrator",
  });
  assert.equal(sup.status, "superseded");
  assert.equal(sup.decidedBy, "bot:arbitrator");
  assert.equal(sup.autoApproved, true);

  db.close();
});
