import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Hono } from "hono";
import { OpcKernel } from "./kernel/index.ts";
import {
  BotArbitratorService,
  parseBotVerdictJson,
  registerBotArbitratorRoutes,
  type BotArbitratorStatusResponse,
  type BotReviewRequest,
  type BotReviewVerdict,
} from "./server/bot-arbitrator.ts";
import { openDatabase } from "./server/db.ts";
import { ApiError } from "./server/logic.ts";
import { StageHomeClient } from "./server/stage-home-client.ts";
import type { ExecutionStatus, LaunchSpec, WorkflowExecutor } from "./server/workflow/executor.ts";
import { WorkflowService } from "./server/workflow/service.ts";
import { workflowMessages } from "./server/zoom-workflow.ts";

function setupReleaseTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opc_agent_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      project TEXT NOT NULL,
      protected_violations TEXT NOT NULL DEFAULT '[]',
      circuit_breaker_reason TEXT,
      verification_json TEXT,
      changed_files TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS opc_releases (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      task_id TEXT,
      project TEXT NOT NULL,
      repo_path TEXT NOT NULL DEFAULT '',
      source_branch TEXT NOT NULL DEFAULT 'agent/agy/test',
      target_branch TEXT NOT NULL DEFAULT 'main',
      mode TEXT NOT NULL DEFAULT 'merge_and_deploy',
      status TEXT NOT NULL DEFAULT 'pending_approval',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-11-24T10:00:00.000Z',
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS opc_executive_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT OR REPLACE INTO opc_executive_state (singleton, config, updated_at) VALUES (1, ?, ?)",
  ).run(
    JSON.stringify({
      superBotId: "super-bot",
      departmentBotIds: { rd: "bot_rd_vp" },
    }),
    new Date().toISOString(),
  );
}

function seedRelease(
  db: DatabaseSync,
  input: {
    releaseId: string;
    runId: string;
    project: string;
    runStatus?: string;
    verificationPassed?: boolean;
    protectedViolations?: string[];
    releaseStatus?: string;
    sourceBranch?: string;
  },
) {
  db.prepare(
    `INSERT OR REPLACE INTO opc_agent_runs
     (id, status, project, protected_violations, circuit_breaker_reason, verification_json, changed_files)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.runStatus ?? "completed",
    input.project,
    JSON.stringify(input.protectedViolations ?? []),
    (input.protectedViolations?.length ?? 0) > 0 ? "protected_path_violation" : null,
    JSON.stringify({
      command: "npm test",
      passed: input.verificationPassed ?? true,
      exitCode: input.verificationPassed === false ? 1 : 0,
    }),
    JSON.stringify(["src/index.ts", "src/index.test.ts"]),
  );

  db.prepare(
    `INSERT OR REPLACE INTO opc_releases
     (id, run_id, task_id, project, repo_path, source_branch, target_branch, mode, status)
     VALUES (?, ?, ?, ?, ?, ?, 'main', 'merge_and_deploy', ?)`,
  ).run(
    input.releaseId,
    input.runId,
    `tsk_${input.runId}`,
    input.project,
    "/tmp/repo",
    input.sourceBranch ?? `agent/agy/${input.runId}`,
    input.releaseStatus ?? "pending_approval",
  );
}

async function proposeReleasePacket(
  kernel: OpcKernel,
  releaseId: string,
  project: string,
  title = `生产发布审批：${project} · Add regression tests`,
) {
  return kernel.decisions.propose({
    dedupeKey: `factory:production_release:${releaseId}`,
    domain: "factory",
    kind: "production_release",
    riskLevel: "high",
    projectOrAssetRef: project,
    title,
    backgroundSummary: `验证通过的分支待合入 ${project}`,
    diffOrEvidence: "tests 12 pass 12 fail 0",
    rollbackPlan: "git reset --hard <prev>",
    recommendedOptionId: "approve_deploy",
    tags: ["production_release", "factory", project],
    options: [
      {
        id: "approve_deploy",
        label: "批准合并并上线部署",
        outcome: "approved",
        handlerKey: "factory.release_execute",
        payload: { releaseId, mode: "merge_and_deploy" },
      },
      {
        id: "approve_merge_only",
        label: "仅合并代码（暂不部署）",
        outcome: "approved",
        handlerKey: "factory.release_merge_only",
        payload: { releaseId, mode: "merge_only" },
      },
      {
        id: "reject_release",
        label: "驳回本次发布",
        outcome: "rejected",
        handlerKey: "factory.release_reject",
        payload: { releaseId },
      },
    ],
  });
}

class MockWorkflowExecutor implements WorkflowExecutor {
  readonly name = "herdr";
  async launch(_spec: LaunchSpec) {}
  async status(_attemptId: string): Promise<ExecutionStatus> {
    return { state: "absent" };
  }
}

function createWorkflowFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "opc-arb-wf-"));
  const workspace = join(dir, "repo");
  execFileSync("git", ["init", "-q", workspace]);
  writeFileSync(join(workspace, "README.md"), "# test\n");
  execFileSync("git", ["-C", workspace, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    workspace,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "init",
  ]);
  const db = openDatabase(join(dir, "db"));
  const workflow = new WorkflowService(
    db,
    {
      workspace,
      attemptRoot: join(dir, "attempts"),
      backendKey: "test-backend",
      hostKey: "test-host",
      boardUrl: "http://127.0.0.1:52328",
      implement: ["/usr/bin/true", "implement"],
      review: ["/usr/bin/true", "review"],
    },
    new MockWorkflowExecutor(),
  );
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, workflow, workspace };
}

test("parseBotVerdictJson extracts strict JSON from raw, fenced, and prose-wrapped replies", () => {
  const direct = parseBotVerdictJson('{"verdict":"approve","optionId":"approve_merge_only","reason":"校验全绿","nextStep":"合并"}');
  assert.deepEqual(direct, {
    verdict: "approve",
    optionId: "approve_merge_only",
    reason: "校验全绿",
    nextStep: "合并",
  });

  const fenced = parseBotVerdictJson(
    "审查结论如下：\n```json\n{\"verdict\":\"reject\",\"reason\":\"改动范围越界\",\"nextStep\":\"退回重写\"}\n```\n完成。",
  );
  assert.equal(fenced?.verdict, "reject");
  assert.equal(fenced?.reason, "改动范围越界");

  const embedded = parseBotVerdictJson(
    '经过核验，建议如下：{"verdict":"escalate","reason":"涉及核心逻辑需人工确认"} 谢谢。',
  );
  assert.equal(embedded?.verdict, "escalate");

  assert.equal(parseBotVerdictJson("没有 JSON 的纯文本回答"), null);
  assert.equal(parseBotVerdictJson('{"verdict":"bogus","reason":"x"}'), null);
});

test("BotArbitratorService: off mode skips, advisory logs without resolving, delegated_safe enforces release gates and merge_only", async () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);
  setupReleaseTables(db);

  const calls: Array<{ key: string; releaseId: string }> = [];
  kernel.decisions.registerHandler("factory.release_execute", ({ option }) => {
    calls.push({ key: "merge_and_deploy", releaseId: String(option.payload?.releaseId) });
    return { status: "succeeded", mode: "merge_and_deploy" };
  });
  kernel.decisions.registerHandler("factory.release_merge_only", ({ option }) => {
    calls.push({ key: "merge_only", releaseId: String(option.payload?.releaseId) });
    return { status: "succeeded", mode: "merge_only" };
  });
  kernel.decisions.registerHandler("factory.release_reject", ({ option }) => {
    calls.push({ key: "reject", releaseId: String(option.payload?.releaseId) });
    return { status: "rejected" };
  });

  const reviewedReqs: BotReviewRequest[] = [];
  const verdictQueue = new Map<string, BotReviewVerdict>();
  const service = new BotArbitratorService(db, {
    decisions: kernel.decisions,
    events: kernel.events,
    registry: kernel.registry,
    botReviewer: async (req) => {
      reviewedReqs.push(req);
      return (
        verdictQueue.get(req.targetId) ?? {
          verdict: "approve",
          optionId: "approve_deploy", // Deliberately try to request deploy while policy says merge_only!
          reason: "Diff 简洁且测试全绿，建议合入",
          nextStep: "合入 main 分支",
        }
      );
    },
  });

  // Seed verified release for allowlisted repo
  seedRelease(db, { releaseId: "rel_ok", runId: "run_ok", project: "opc-gtm-kit" });
  const pktOk = await proposeReleasePacket(kernel, "rel_ok", "opc-gtm-kit");

  // 1. Default mode is "off" -> arbitratePending({ dryRun: false }) skips without calling Bot
  const offReport = await service.arbitratePending();
  assert.equal(offReport.effectiveMode, "off");
  assert.equal(offReport.totalProcessed, 0);
  assert.equal(reviewedReqs.length, 0);
  assert.equal(kernel.decisions.get(pktOk.id)?.status, "pending");

  // 2. dryRun=true in off mode previews via advisory without executing or writing audit logs
  const previewReport = await service.arbitratePending({ dryRun: true });
  assert.equal(previewReport.effectiveMode, "advisory");
  assert.equal(previewReport.totalProcessed, 1);
  assert.equal(previewReport.executedCount, 0);
  assert.equal(previewReport.items[0].verdict, "approve");
  assert.equal(previewReport.items[0].optionId, "approve_merge_only");
  assert.equal(service.listLogs().length, 0);
  assert.equal(kernel.decisions.get(pktOk.id)?.status, "pending");

  // 3. Mode "advisory" writes structured log, does NOT resolve
  service.updatePolicy({ arbitrationMode: "advisory" });
  const advisoryRes = await service.arbitrateDecision(pktOk.id);
  assert.equal(advisoryRes.executed, false);
  assert.equal(advisoryRes.verdict, "approve");
  assert.equal(advisoryRes.optionId, "approve_merge_only");
  assert.equal(kernel.decisions.get(pktOk.id)?.status, "pending");
  assert.equal(service.listLogs().length, 1);
  assert.equal(calls.length, 0);

  // 4. Mode "delegated_safe" with autoApproveVerifiedReleases=false -> escalates release
  service.updatePolicy({ arbitrationMode: "delegated_safe", autoApproveVerifiedReleases: false });
  const blockedByFlag = await service.arbitrateDecision(pktOk.id);
  assert.equal(blockedByFlag.executed, false);
  assert.equal(blockedByFlag.escalated, true);
  assert.equal(blockedByFlag.deterministicGate, "auto_release_disabled");
  assert.equal(kernel.decisions.get(pktOk.id)?.status, "pending");

  // 5. Enable autoApproveVerifiedReleases=true (releaseMergeMode="merge_only" default) ->
  //    Even though Bot requested "approve_deploy", service strictly enforces "approve_merge_only"!
  service.updatePolicy({ autoApproveVerifiedReleases: true, releaseMergeMode: "merge_only" });
  const approvedRes = await service.arbitrateDecision(pktOk.id);
  assert.equal(approvedRes.executed, true);
  assert.equal(approvedRes.verdict, "approve");
  assert.equal(approvedRes.optionId, "approve_merge_only");
  assert.equal(approvedRes.actor, "bot:rd-vp");
  assert.equal(approvedRes.botId, "bot_rd_vp");
  assert.deepEqual(calls, [{ key: "merge_only", releaseId: "rel_ok" }]);

  const updatedPacket = kernel.decisions.get(pktOk.id)!;
  assert.equal(updatedPacket.status, "approved");
  assert.equal(updatedPacket.decidedBy, "bot:rd-vp");
  assert.equal(updatedPacket.autoApproved, true);
  assert.match(updatedPacket.decisionNote, /Bot 代理拍板/);

  // Verify kernel event emitted
  const resolvedEvents = kernel.events.list({ topic: "arbitrator.item_resolved" });
  assert.equal(resolvedEvents.length, 1);
  assert.equal(resolvedEvents[0].payload.targetId, pktOk.id);

  // 6. Safety blocks: failed tests, protected violations, unallowlisted project, blocked project, Bot escalate/reject
  seedRelease(db, { releaseId: "rel_fail_test", runId: "run_fail_test", project: "opc-gtm-kit", verificationPassed: false });
  const pktFail = await proposeReleasePacket(kernel, "rel_fail_test", "opc-gtm-kit");
  const failRes = await service.arbitrateDecision(pktFail.id);
  assert.equal(failRes.executed, false);
  assert.equal(failRes.escalated, true);
  assert.equal(failRes.deterministicGate, "verification_not_passed");

  seedRelease(db, { releaseId: "rel_viol", runId: "run_viol", project: "opc-ops-kit", protectedViolations: [".env.prod"] });
  const pktViol = await proposeReleasePacket(kernel, "rel_viol", "opc-ops-kit");
  const violRes = await service.arbitrateDecision(pktViol.id);
  assert.equal(violRes.executed, false);
  assert.equal(violRes.escalated, true);
  assert.equal(violRes.deterministicGate, "protected_path_violation");

  seedRelease(db, { releaseId: "rel_other", runId: "run_other", project: "sensitive-core-repo" });
  const pktOther = await proposeReleasePacket(kernel, "rel_other", "sensitive-core-repo");
  const otherRes = await service.arbitrateDecision(pktOther.id);
  assert.equal(otherRes.executed, false);
  assert.equal(otherRes.escalated, true);
  assert.equal(otherRes.deterministicGate, "project_not_allowlisted");

  // Even with allowedReleaseProjects=["*"], blockedReleaseProjects still blocks!
  service.updatePolicy({ allowedReleaseProjects: ["*"], blockedReleaseProjects: ["sensitive-core-repo"] });
  const blockedProjRes = await service.arbitrateDecision(pktOther.id);
  assert.equal(blockedProjRes.executed, false);
  assert.equal(blockedProjRes.escalated, true);
  assert.equal(blockedProjRes.deterministicGate, "project_blocked");

  // Bot returns "escalate" on verified release -> MUST NOT approve
  seedRelease(db, { releaseId: "rel_bot_esc", runId: "run_bot_esc", project: "opc-commerce-kit" });
  const pktBotEsc = await proposeReleasePacket(kernel, "rel_bot_esc", "opc-commerce-kit");
  verdictQueue.set(pktBotEsc.id, {
    verdict: "escalate",
    reason: "发现潜在边界回归风险，建议人工复核",
    nextStep: "请创始人检查 diff",
  });
  const escRes = await service.arbitrateDecision(pktBotEsc.id);
  assert.equal(escRes.executed, false);
  assert.equal(escRes.escalated, true);
  assert.equal(kernel.decisions.get(pktBotEsc.id)?.status, "pending");

  // Bot returns "reject" on verified release -> executes reject_release cleanly
  seedRelease(db, { releaseId: "rel_bot_rej", runId: "run_bot_rej", project: "opc-commerce-kit" });
  const pktBotRej = await proposeReleasePacket(kernel, "rel_bot_rej", "opc-commerce-kit");
  verdictQueue.set(pktBotRej.id, {
    verdict: "reject",
    reason: "代码包含调试日志残留，打回修改",
    nextStep: "清理日志后重提",
  });
  const rejRes = await service.arbitrateDecision(pktBotRej.id);
  assert.equal(rejRes.executed, true);
  assert.equal(rejRes.verdict, "reject");
  assert.equal(kernel.decisions.get(pktBotRej.id)?.status, "rejected");

  // Duplicate release for an already-succeeded run -> deterministically superseded without calling Bot
  seedRelease(db, {
    releaseId: "rel_prior_done",
    runId: "run_shared_1",
    project: "opc-ops-kit",
    releaseStatus: "succeeded",
    sourceBranch: "agent/agy/shared",
  });
  seedRelease(db, {
    releaseId: "rel_dup_pending",
    runId: "run_shared_1",
    project: "opc-ops-kit",
    releaseStatus: "pending_approval",
    sourceBranch: "agent/agy/shared",
  });
  const pktDup = await proposeReleasePacket(kernel, "rel_dup_pending", "opc-ops-kit");
  const prevReviews = reviewedReqs.length;
  const dupRes = await service.arbitrateDecision(pktDup.id);
  assert.equal(dupRes.executed, true);
  assert.equal(dupRes.verdict, "supersede");
  assert.equal(dupRes.deterministicGate, "already_merged");
  assert.equal(reviewedReqs.length, prevReviews, "duplicate merged release should not call Bot");
  assert.equal(kernel.decisions.get(pktDup.id)?.status, "superseded");

  db.close();
});

test("BotArbitratorService: non-delegable redlines, feature_admission noise filter, and patrol_alert handling", async () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);

  const actions: string[] = [];
  kernel.decisions.registerHandler("product.signal_promote", () => {
    actions.push("promote");
  });
  kernel.decisions.registerHandler("product.signal_drop", () => {
    actions.push("drop");
  });
  kernel.decisions.registerHandler("product.patrol_snooze", () => {
    actions.push("snooze");
  });
  kernel.decisions.registerHandler("test.pricing", () => {
    actions.push("pricing");
  });

  let botCallCount = 0;
  const service = new BotArbitratorService(db, {
    decisions: kernel.decisions,
    events: kernel.events,
    registry: kernel.registry,
    botReviewer: async (req) => {
      botCallCount++;
      if (req.itemKind === "patrol_alert") {
        return { verdict: "snooze", optionId: "snooze", reason: "非核心任务延后 7 天", nextStep: "下周复查" };
      }
      return { verdict: "approve", reason: "贴合主线且范围明确", nextStep: "入队等待派工" };
    },
  });

  service.updatePolicy({ arbitrationMode: "full_delegated" });

  // 1. pricing_change ALWAYS escalated even in full_delegated
  const pricingPkt = await kernel.decisions.propose({
    dedupeKey: "arb:pricing:1",
    domain: "commercial",
    kind: "pricing_change",
    riskLevel: "critical",
    title: "调整 Pro 套餐价格",
    backgroundSummary: "调价需人工确认",
    options: [{ id: "ok", label: "批准", outcome: "approved", handlerKey: "test.pricing" }],
  });

  // 2. Noisy feature_admission rejected deterministically without calling Bot
  const noisePkt = await kernel.decisions.propose({
    dedupeKey: "arb:noise:1",
    domain: "product",
    kind: "feature_admission",
    riskLevel: "medium",
    title: "候选需求准入评估：GitHub Daily Trending 速览",
    backgroundSummary: "日报摘要",
    options: [
      { id: "promote", label: "准入立项", outcome: "approved", handlerKey: "product.signal_promote" },
      { id: "drop", label: "驳回丢弃", outcome: "rejected", handlerKey: "product.signal_drop" },
    ],
  });

  // 3. Clean feature_admission approved via Bot
  const cleanPkt = await kernel.decisions.propose({
    dedupeKey: "arb:clean:1",
    domain: "product",
    kind: "feature_admission",
    riskLevel: "medium",
    projectOrAssetRef: "pagelens-interpret",
    title: "新增离线字幕导出回归测试",
    backgroundSummary: "明确归属 pagelens-interpret 仓库",
    options: [
      { id: "promote", label: "准入立项", outcome: "approved", handlerKey: "product.signal_promote" },
      { id: "drop", label: "驳回丢弃", outcome: "rejected", handlerKey: "product.signal_drop" },
    ],
  });

  // 4. patrol_alert snoozed via Bot
  const patrolPkt = await kernel.decisions.propose({
    dedupeKey: "arb:patrol:1",
    domain: "product",
    kind: "patrol_alert",
    riskLevel: "medium",
    title: "任务巡检告警：2 项滞留",
    backgroundSummary: "两项非主线任务滞留超过 7 天",
    options: [
      { id: "snooze", label: "延后 7 天", outcome: "snoozed", handlerKey: "product.patrol_snooze" },
    ],
  });

  const report = await service.arbitratePending();
  assert.equal(report.totalProcessed, 4);
  assert.equal(report.escalatedCount, 1);
  assert.equal(report.rejectedCount, 1);
  assert.equal(report.approvedCount, 1);
  assert.equal(report.snoozedCount, 1);
  assert.equal(botCallCount, 2, "only clean feature and patrol should call Bot; pricing & noise handled deterministically");
  assert.equal(kernel.decisions.get(pricingPkt.id)?.status, "pending");
  assert.equal(kernel.decisions.get(noisePkt.id)?.status, "rejected");
  assert.equal(kernel.decisions.get(cleanPkt.id)?.status, "approved");
  assert.equal(kernel.decisions.get(patrolPkt.id)?.status, "snoozed");
  assert.deepEqual(actions.sort(), ["drop", "promote", "snooze"]);

  db.close();
});

test("BotArbitratorService: stale workflow cards auto-close, fresh cards Bot-reviewed, and zoom-workflow labels render clearly", async (t) => {
  const { db, workflow } = createWorkflowFixture(t);
  const kernel = new OpcKernel(db);

  let nowMs = Date.parse("2026-11-24T15:00:00.000Z");

  const staleRun = workflow.submit({
    version: 1,
    requestId: "req_stale_1",
    source: "agent-cli",
    context: "old context",
    goal: "旧计划返修任务",
    constraints: [],
  });
  // Backdate the stale run events & createdAt to 48h ago
  const oldIso = new Date(nowMs - 48 * 3_600_000).toISOString();
  const staleSnap = JSON.parse(
    String((db.prepare("SELECT snapshot FROM workflow_runs WHERE id = ?").get(staleRun.id) as { snapshot: string }).snapshot),
  );
  staleSnap.createdAt = oldIso;
  staleSnap.events = staleSnap.events.map((e: Record<string, unknown>) => ({ ...e, at: oldIso }));
  db.prepare("UPDATE workflow_runs SET created_at = ?, snapshot = ? WHERE id = ?").run(
    oldIso,
    JSON.stringify(staleSnap),
    staleRun.id,
  );

  const freshRun = workflow.submit({
    version: 1,
    requestId: "req_fresh_1",
    source: "agent-cli",
    context: "fresh context",
    goal: "新增单元测试并验证回归",
    constraints: ["保持零破坏性变更"],
  });
  // Set fresh run timestamp to 1h ago
  const freshIso = new Date(nowMs - 1 * 3_600_000).toISOString();
  const freshSnap = JSON.parse(
    String((db.prepare("SELECT snapshot FROM workflow_runs WHERE id = ?").get(freshRun.id) as { snapshot: string }).snapshot),
  );
  freshSnap.createdAt = freshIso;
  freshSnap.events = freshSnap.events.map((e: Record<string, unknown>) => ({ ...e, at: freshIso }));
  db.prepare("UPDATE workflow_runs SET created_at = ?, snapshot = ? WHERE id = ?").run(
    freshIso,
    JSON.stringify(freshSnap),
    freshRun.id,
  );

  const service = new BotArbitratorService(db, {
    decisions: kernel.decisions,
    events: kernel.events,
    workflow,
    nowFn: () => nowMs,
    botReviewer: async () => ({
      verdict: "approve",
      reason: "两步计划含独立 review 节点，范围清晰可执行",
      nextStep: "放行进入实现阶段",
    }),
  });
  service.updatePolicy({ arbitrationMode: "delegated_safe", autoCloseStaleWorkflowHours: 24 });

  const statusBefore = service.getStatus();
  assert.equal(statusBefore.pendingWorkflows.length, 2);
  assert.equal(statusBefore.counts.staleWorkflows, 1);

  const report = await service.arbitratePending({ scope: "workflows" });
  assert.equal(report.totalProcessed, 2);
  assert.equal(report.closedStaleCount, 1);
  assert.equal(report.approvedCount, 1);

  // Verify zoom-workflow.ts labels!
  const staleMessages = workflowMessages(workflow.get(staleRun.id));
  const staleReply = staleMessages.find((m) => m.kind === "reply");
  assert.ok(staleReply);
  assert.match(staleReply.body, /Bot 已代拍板/);
  assert.match(staleReply.body, /已过期自动收敛/);

  const freshMessages = workflowMessages(workflow.get(freshRun.id));
  const freshReply = freshMessages.find((m) => m.kind === "reply");
  assert.ok(freshReply);
  assert.match(freshReply.body, /Bot 已代拍板/);
  assert.match(freshReply.body, /已批准/);

  // Status after should have 0 pending workflows
  assert.equal(service.getStatus().pendingWorkflows.length, 0);
});

test("BotArbitratorService: StageHomeClient polling integration and graceful fallback when offline", async (t) => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);
  kernel.decisions.registerHandler("test.approve", () => ({ ok: true }));

  let pollCount = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/bot-work/tasks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          task: {
            id: "ah_task_1",
            targetBotId: "super-bot",
            input: "prompt",
            status: "running",
            attempt: 1,
            updatedAt: new Date().toISOString(),
          },
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/bot-work/tasks/ah_task_1") {
      pollCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          task: {
            id: "ah_task_1",
            targetBotId: "super-bot",
            input: "prompt",
            status: pollCount >= 2 ? "completed" : "running",
            attempt: 1,
            updatedAt: new Date().toISOString(),
            delivery:
              pollCount >= 2
                ? {
                    taskId: "ah_task_1",
                    attempt: 1,
                    sessionId: "sess_1",
                    executionStatus: "completed",
                    report: '```json\n{"verdict":"approve","optionId":"ok","reason":"风险极低准予执行","nextStep":"执行完成"}\n```',
                    artifacts: [],
                    receipts: [],
                  }
                : undefined,
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  t.after(() => {
    server.close();
    db.close();
  });

  const pkt1 = await kernel.decisions.propose({
    dedupeKey: "ah:test:1",
    domain: "ops",
    kind: "cli_auth_expired",
    riskLevel: "medium",
    title: "测试 Agent Home 轮询评审",
    backgroundSummary: "测试上下文",
    options: [{ id: "ok", label: "确认", outcome: "approved", handlerKey: "test.approve" }],
  });

  const service = new BotArbitratorService(db, {
    decisions: kernel.decisions,
    events: kernel.events,
    stageHomeClient: new StageHomeClient({ PPENG_BASE_URL: `http://127.0.0.1:${port}` }),
    pollIntervalMs: 50,
    botTimeoutMs: 5_000,
  });
  service.updatePolicy({ arbitrationMode: "delegated_safe" });

  const res1 = await service.arbitrateDecision(pkt1.id);
  assert.equal(res1.executed, true);
  assert.equal(res1.verdict, "approve");
  assert.equal(res1.botTaskId, "ah_task_1");
  assert.ok(pollCount >= 2);

  // Now close Agent Home server -> graceful escalation without throwing
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const pkt2 = await kernel.decisions.propose({
    dedupeKey: "ah:test:2",
    domain: "ops",
    kind: "cli_auth_expired",
    riskLevel: "medium",
    title: "测试 Agent Home 离线降级",
    backgroundSummary: "测试离线降级",
    options: [{ id: "ok", label: "确认", outcome: "approved", handlerKey: "test.approve" }],
  });

  const res2 = await service.arbitrateDecision(pkt2.id);
  assert.equal(res2.executed, false);
  assert.equal(res2.escalated, true);
  assert.equal(res2.verdict, "escalate");
  assert.equal(kernel.decisions.get(pkt2.id)?.status, "pending");
});

test("registerBotArbitratorRoutes: HTTP endpoints, auth, policy patch, and single/batch arbitration", async () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);
  kernel.decisions.registerHandler("test.ok", () => ({ done: true }));

  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    return c.json({ error: "internal", message: err.message }, 500);
  });

  const submitToken = "test-submit-token-for-bot-arbitrator-123456";
  let authed = false;
  registerBotArbitratorRoutes(app, db, {
    decisions: kernel.decisions,
    events: kernel.events,
    registry: kernel.registry,
    submitToken,
    requireUser: () => {
      if (!authed) throw new ApiError(401, "unauthorized", "需要登录");
      return { id: "u1", name: "founder" };
    },
    botReviewer: async () => ({
      verdict: "approve",
      optionId: "ok",
      reason: "HTTP 路由测试通过",
      nextStep: "完成",
    }),
  });

  // Unauthenticated blocked
  const unauthRes = await app.request("/api/opc/arbitrator/status");
  assert.equal(unauthRes.status, 401);

  // Authenticated with Bearer submitToken works
  const headers = {
    authorization: `Bearer ${submitToken}`,
    "content-type": "application/json",
  };
  const pkt = await kernel.decisions.propose({
    dedupeKey: "http:test:1",
    domain: "product",
    kind: "feature_admission",
    riskLevel: "medium",
    projectOrAssetRef: "pagelens-interpret",
    title: "新增端到端冒烟验证脚本",
    backgroundSummary: "归属 pagelens-interpret 仓库",
    options: [{ id: "ok", label: "准入", outcome: "approved", handlerKey: "test.ok" }],
  });

  const statusRes = await app.request("/api/opc/arbitrator/status", { headers });
  assert.equal(statusRes.status, 200);
  const statusBody = (await statusRes.json()) as BotArbitratorStatusResponse;
  assert.equal(statusBody.policy.arbitrationMode, "off");
  assert.equal(statusBody.pendingDecisions.length, 1);

  // PATCH policy
  const patchRes = await app.request("/api/opc/arbitrator/policy", {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      arbitrationMode: "delegated_safe",
      autoApproveVerifiedReleases: true,
      releaseMergeMode: "merge_only",
    }),
  });
  assert.equal(patchRes.status, 200);
  const patchBody = (await patchRes.json()) as { policy: { arbitrationMode: string; autoApproveVerifiedReleases: boolean } };
  assert.equal(patchBody.policy.arbitrationMode, "delegated_safe");
  assert.equal(patchBody.policy.autoApproveVerifiedReleases, true);
  assert.equal(kernel.decisions.getPolicy().botArbitrationMode, "delegated_safe");

  // POST single decision arbitration
  const decRes = await app.request(`/api/opc/arbitrator/decisions/${pkt.id}`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(decRes.status, 200);
  const decBody = (await decRes.json()) as { result: { executed: boolean; verdict: string } };
  assert.equal(decBody.result.executed, true);
  assert.equal(decBody.result.verdict, "approve");

  // POST batch run (now 0 pending)
  authed = true;
  const runRes = await app.request("/api/opc/arbitrator/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "all" }),
  });
  assert.equal(runRes.status, 200);
  const runBody = (await runRes.json()) as { totalProcessed: number };
  assert.equal(runBody.totalProcessed, 0);

  // POST missing workflow returns 404
  const wf404 = await app.request("/api/opc/arbitrator/workflows/does-not-exist", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(wf404.status, 404);

  // PATCH policy also accepts `mode` alias cleanly
  const aliasRes = await app.request("/api/opc/arbitrator/policy", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "advisory" }),
  });
  assert.equal(aliasRes.status, 200);
  const aliasBody = (await aliasRes.json()) as { policy: { arbitrationMode: string } };
  assert.equal(aliasBody.policy.arbitrationMode, "advisory");

  db.close();
});

test("BotArbitratorService: real git ancestry check supersedes already-merged branches and reviews unmerged ones", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opc-arb-git-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]);

  // Branch 1: already merged into main (ahead=0)
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/agy/merged"]);
  writeFileSync(join(repo, "merged.txt"), "ok\n");
  execFileSync("git", ["-C", repo, "add", "merged.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "merged work"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
  execFileSync("git", ["-C", repo, "merge", "--ff-only", "-q", "agent/agy/merged"]);

  // Branch 2: 1 commit ahead of main (unmerged)
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/agy/unmerged"]);
  writeFileSync(join(repo, "unmerged.txt"), "new\n");
  execFileSync("git", ["-C", repo, "add", "unmerged.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "unmerged work"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);

  const db = new DatabaseSync(":memory:");
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const kernel = new OpcKernel(db);
  setupReleaseTables(db);
  const mergedHandled: string[] = [];
  kernel.decisions.registerHandler("factory.release_merge_only", ({ option }) => {
    mergedHandled.push(String(option.payload?.releaseId));
    return { status: "succeeded", mode: "merge_only" };
  });

  // Insert both releases pointing to the real temp git repo
  seedRelease(db, { releaseId: "rel_git_merged", runId: "run_gm", project: "opc-gtm-kit", sourceBranch: "agent/agy/merged" });
  seedRelease(db, { releaseId: "rel_git_unmerged", runId: "run_gu", project: "pagelens-interpret", sourceBranch: "agent/agy/unmerged" });
  db.prepare("UPDATE opc_releases SET repo_path = ?").run(repo);

  const pktMerged = await proposeReleasePacket(kernel, "rel_git_merged", "opc-gtm-kit");
  const pktUnmerged = await proposeReleasePacket(kernel, "rel_git_unmerged", "pagelens-interpret");

  const botReviewed: BotReviewRequest[] = [];
  const service = new BotArbitratorService(db, {
    decisions: kernel.decisions,
    events: kernel.events,
    botReviewer: async (req) => {
      botReviewed.push(req);
      return { verdict: "approve", reason: "未合并分支单测全绿，准予 merge_only", nextStep: "合入 main" };
    },
  });
  service.updatePolicy({
    arbitrationMode: "delegated_safe",
    autoApproveVerifiedReleases: true,
    releaseMergeMode: "merge_only",
  });

  const report = await service.arbitratePending();
  assert.equal(report.closedStaleCount, 1);
  assert.equal(report.approvedCount, 1);
  assert.equal(kernel.decisions.get(pktMerged.id)?.status, "superseded");
  assert.equal(kernel.decisions.get(pktUnmerged.id)?.status, "approved");
  assert.deepEqual(
    botReviewed.map((r) => r.targetId),
    [pktUnmerged.id],
    "already-merged branch should not invoke Bot",
  );
  assert.deepEqual(mergedHandled, ["rel_git_unmerged"]);

  // Verify the release review prompt includes changedFiles, live git diff --stat, delegated auth context, and stays <= 3400 chars
  const prompt = botReviewed[0].prompt;
  assert.ok(prompt.length <= 3400, `prompt length ${prompt.length} must stay <= 3400`);
  assert.match(prompt, /创始人代理拍板授权/);
  assert.match(prompt, /autoApproveVerifiedReleases=true/);
  assert.match(prompt, /变更文件 \(2\)/);
  assert.match(prompt, /src\/index\.test\.ts/);
  assert.match(prompt, /Git Diff 统计/);
  assert.match(prompt, /unmerged\.txt/);
  assert.match(prompt, /可选动作:/);
});

test("BotArbitratorService: release prompt caps cleanly <= 3400 chars even with 40 changed files and huge evidence stdout", async () => {
  const db = new DatabaseSync(":memory:");
  const kernel = new OpcKernel(db);
  setupReleaseTables(db);

  const manyFiles = Array.from({ length: 40 }, (_, i) => `tests/regression/suite_${String(i).padStart(2, "0")}_very_long_filename.test.ts`);
  seedRelease(db, { releaseId: "rel_big", runId: "run_big", project: "pagelens-interpret" });
  db.prepare("UPDATE opc_agent_runs SET changed_files = ? WHERE id = ?").run(JSON.stringify(manyFiles), "run_big");

  const hugeStdout = "PASS test line ".repeat(600);
  const pktBig = await kernel.decisions.propose({
    dedupeKey: "factory:production_release:rel_big",
    domain: "factory",
    kind: "production_release",
    riskLevel: "high",
    projectOrAssetRef: "pagelens-interpret",
    title: "生产发布审批：pagelens-interpret · Large regression suite",
    backgroundSummary: "大量单测回归补充 ".repeat(80),
    diffOrEvidence: `### 外部确定性校验 (PASSED)\n${hugeStdout}\n\n### Git Diff 统计\n 40 files changed, 800 insertions(+)`,
    recommendedOptionId: "approve_deploy",
    tags: ["production_release", "factory", "pagelens-interpret"],
    options: [
      { id: "approve_deploy", label: "批准合并并上线部署", outcome: "approved", handlerKey: "factory.release_execute", payload: { releaseId: "rel_big" } },
      { id: "approve_merge_only", label: "仅合并代码（暂不部署）", outcome: "approved", handlerKey: "factory.release_merge_only", payload: { releaseId: "rel_big" } },
      { id: "reject_release", label: "驳回本次发布", outcome: "rejected", handlerKey: "factory.release_reject", payload: { releaseId: "rel_big" } },
    ],
  });

  let capturedPrompt = "";
  const service = new BotArbitratorService(db, {
    decisions: kernel.decisions,
    events: kernel.events,
    botReviewer: async (req) => {
      capturedPrompt = req.prompt;
      return { verdict: "approve", optionId: "approve_merge_only", reason: "仅测试文件，安全", nextStep: "合并" };
    },
  });
  service.updatePolicy({ arbitrationMode: "advisory", autoApproveVerifiedReleases: true });

  await service.arbitrateDecision(pktBig.id);
  assert.ok(capturedPrompt.length > 0 && capturedPrompt.length <= 3400, `prompt length ${capturedPrompt.length} must be <= 3400`);
  assert.match(capturedPrompt, /变更文件 \(40\)/);
  assert.match(capturedPrompt, /suite_00_very_long_filename\.test\.ts/);
  assert.match(capturedPrompt, /40 files changed, 800 insertions/);
  assert.match(capturedPrompt, /可选动作:/);
  assert.match(capturedPrompt, /approve_merge_only/);

  db.close();
});
