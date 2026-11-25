import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { ProductDepartment } from "./domains/product/index.ts";
import { ResourcesDepartment } from "./domains/resources/index.ts";
import { StrategyDepartment } from "./domains/strategy/index.ts";
import { isDigestOrNonActionableNoise } from "./kernel/admission-filter.ts";
import { OpcKernel } from "./kernel/index.ts";
import { DarkFactoryStore } from "./server/dark-factory.ts";
import { ApiError } from "./server/logic.ts";
import { ProvidersStore } from "./server/providers.ts";
import { TaskPlanningStore } from "./server/task-planning.ts";
import {
  buildBotTriagePrompt,
  MAX_BOT_TRIAGE_PROMPT_CHARS,
  parseCodeCheckFromText,
  parseTriageVerdictsFromText,
  registerTaskTriageRoutes,
  splitTasksIntoPromptBatches,
  TaskTriageService,
} from "./server/task-triage.ts";
import {
  extractTaskTriage,
  getTaskTriageStatus,
  type TriageConfig,
  type TriageRunReport,
  type TriageStatusResponse,
} from "./task-planning-types.ts";

test("1. Layer 0 expanded noise filter catches digest headings while preserving real actionable tasks", () => {
  const noiseSamples = [
    "五、 技术学习补记（01:50 批次）",
    "三、 技术学习补记（Agent Runtime & 推理基础设施层）",
    "三、 行业与生态要闻速递",
    "今日核心新变量与深度增补",
    "今日主题判断（增量补完）",
    "今日产物与飞书公开数字花园链接",
    "08:15 每日大模型信息收集与摘要（官方验证认证与顶会增量）",
    "二、 重点精读与深度拆解 (Top 6)",
    "跨源共振与再次提醒 (Cross-Source Reinforcement)",
    "一、 一手规格与论文机制增量（Delta）",
    "四、 GitHub Daily Trending 热门开源代码库梳理 (77 库精选)",
    "六、 开源项目精选汇总",
  ];

  for (const title of noiseSamples) {
    const res = isDigestOrNonActionableNoise(title);
    assert.equal(res.noisy, true, `Expected noise to be caught: ${title}`);
  }

  const realSamples = [
    "修复 Safari 剪贴板权限异常",
    "Add in-flight deduplication guard to DarkFactoryStore.dispatch",
    "优化 AGENTS.md 与验收判据并补充回归单测",
    "[Build] 实现 @opc/password-one 独立仓库、加密金库与盲执行网关",
    "[A/B 降级 P0] 去重正则漏掉句末点号导致噪声洪水与摘要膨胀 4x",
    "新增 opc-commerce doctor 诊断命令与单元测试",
  ];

  for (const title of realSamples) {
    const res = isDigestOrNonActionableNoise(title);
    assert.equal(res.noisy, false, `Expected real task NOT to be filtered: ${title}`);
  }
});

test("2. Layer 0 runDeterministicSweep archives noise, flags paused/missing signal repos, and never touches done/published/archived", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "opc-triage-sweep-"));
  const activeRepo = join(tmpRoot, "active-repo");
  mkdirSync(activeRepo, { recursive: true });

  const db = new DatabaseSync(":memory:");
  try {
    const kernel = new OpcKernel(db);
    const taskPlanning = new TaskPlanningStore(db);

    // Configure assets: one active on disk, one paused, one missing on disk
    kernel.registry.upsertAsset({
      id: "asset_active_ok",
      productId: "prod_opc_os",
      name: "active-ok-repo",
      slug: "active-ok-repo",
      localRepoPath: activeRepo,
      paused: false,
    });
    kernel.registry.upsertAsset({
      id: "asset_paused_one",
      productId: "prod_opc_os",
      name: "paused-repo",
      slug: "paused-repo",
      localRepoPath: activeRepo,
      paused: true,
    });
    kernel.registry.upsertAsset({
      id: "asset_missing_path",
      productId: "prod_opc_os",
      name: "missing-path-repo",
      slug: "missing-path-repo",
      localRepoPath: join(tmpRoot, "does-not-exist"),
      paused: false,
    });

    const noiseTodo = taskPlanning.createTask({
      project: "active-ok-repo",
      title: "五、 技术学习补记（09:50 批次）",
      sourceRef: "signal://sig_noise_1",
    });
    const pausedSignalTodo = taskPlanning.createTask({
      project: "paused-repo",
      assetId: "asset_paused_one",
      title: "修复 paused-repo 日志格式问题",
      sourceRef: "signal://sig_paused_1",
    });
    const missingPathSignalTodo = taskPlanning.createTask({
      project: "missing-path-repo",
      assetId: "asset_missing_path",
      title: "优化 missing-path-repo 构建脚本",
      sourceRef: "signal://sig_missing_1",
    });
    const validSignalTodo = taskPlanning.createTask({
      project: "active-ok-repo",
      assetId: "asset_active_ok",
      title: "修复 active-ok-repo WebSocket 断线重连异常",
      sourceRef: "signal://sig_valid_1",
    });
    const doneNoise = taskPlanning.createTask({
      project: "active-ok-repo",
      title: "重点精读",
      status: "done",
    });
    const publishedNoise = taskPlanning.createTask({
      project: "active-ok-repo",
      title: "今日主题判断",
      status: "published",
    });

    const service = new TaskTriageService(db, {
      taskPlanning,
      registry: kernel.registry,
    });

    // Dry-run must NOT mutate DB
    const dryReport = service.runDeterministicSweep({ dryRun: true });
    assert.equal(dryReport.dryRun, true);
    assert.equal(dryReport.noiseArchivedCount, 1);
    assert.equal(dryReport.needsScopeCount, 2);
    assert.equal(taskPlanning.getTask(noiseTodo.id).status, "todo");
    assert.equal(getTaskTriageStatus(taskPlanning.getTask(pausedSignalTodo.id)), "unreviewed");

    // Live sweep mutates todo noise & paused/missing repos only
    const realReport = service.runDeterministicSweep({ dryRun: false });
    assert.equal(realReport.noiseArchivedCount, 1);
    assert.equal(realReport.needsScopeCount, 2);

    const afterNoise = taskPlanning.getTask(noiseTodo.id);
    assert.equal(afterNoise.status, "archived");
    assert.equal(getTaskTriageStatus(afterNoise), "noise_archived");

    const afterPaused = taskPlanning.getTask(pausedSignalTodo.id);
    assert.equal(afterPaused.status, "todo");
    assert.equal(getTaskTriageStatus(afterPaused), "needs_scope");

    const afterMissing = taskPlanning.getTask(missingPathSignalTodo.id);
    assert.equal(afterMissing.status, "todo");
    assert.equal(getTaskTriageStatus(afterMissing), "needs_scope");

    // Valid signal remains unreviewed for Layer 1 Bot triage
    assert.equal(getTaskTriageStatus(taskPlanning.getTask(validSignalTodo.id)), "unreviewed");

    // Already done / published tasks must remain untouched
    assert.equal(taskPlanning.getTask(doneNoise.id).status, "done");
    assert.equal(taskPlanning.getTask(publishedNoise.id).status, "published");
  } finally {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("3. Layer 1 Bot triage + Layer 1.5 agy read-only code check + deduped company_notes idea demotion", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "opc-triage-bot-"));
  const repoDir = join(tmpRoot, "opc-repo");
  mkdirSync(repoDir, { recursive: true });

  const db = new DatabaseSync(":memory:");
  try {
    const kernel = new OpcKernel(db);
    const taskPlanning = new TaskPlanningStore(db);

    kernel.registry.upsertAsset({
      id: "asset_opc_repo",
      productId: "prod_opc_os",
      name: "opc-repo",
      slug: "opc-repo",
      localRepoPath: repoDir,
      verifyCommand: "npm test",
      paused: false,
    });

    // Seed executive state so RD Bot ID discovery works
    db.exec(`CREATE TABLE IF NOT EXISTS opc_executive_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO opc_executive_state(singleton, config, updated_at) VALUES(1, ?, ?)").run(
      JSON.stringify({
        superBotId: "super-bot",
        departmentBotIds: { rd: "bot_rd_vp_001" },
      }),
      new Date().toISOString(),
    );

    const tNoiseHigh = taskPlanning.createTask({ project: "opc-repo", title: "无关行业新闻条目 A", priority: 10 });
    const tNoiseLowConf = taskPlanning.createTask({ project: "opc-repo", title: "疑似噪音但置信度不足", priority: 9 });
    const tIdea = taskPlanning.createTask({
      project: "opc-repo",
      title: "**试水 Genie 4 世界模型与本地视频加速**",
      description: "值得先记录到想法库",
      sourceRef: "signal://sig_idea_1",
      priority: 8,
    });
    const tIdeaDup = taskPlanning.createTask({
      project: "opc-repo",
      title: "试水 Genie 4 世界模型与本地视频加速",
      description: "重复线索测试去重",
      sourceRef: "signal://sig_idea_2",
      priority: 8,
    });
    const tDone = taskPlanning.createTask({ project: "opc-repo", title: "给 dark-factory 加孤儿回收", priority: 7 });
    const tCheckExists = taskPlanning.createTask({
      project: "opc-repo",
      title: "[A/B 降级 P0] 去重正则漏掉句末点号",
      priority: 10,
    });
    const tCheckAlreadyFixed = taskPlanning.createTask({
      project: "opc-repo",
      title: "[Bug] 旧版路由缺少 no-store 头",
      priority: 6,
    });
    const tRealReady = taskPlanning.createTask({
      project: "default",
      title: "为 opc-repo 补齐 CLI 校验单测",
      priority: 9,
    });
    const tNeedsScope = taskPlanning.createTask({
      project: "opc-repo",
      title: "提升系统整体性能",
      priority: 5,
    });
    const tNoAssetCmd = taskPlanning.createTask({
      project: "default",
      title: "无资产验收命令的已确认任务",
      priority: 5,
    });

    let capturedBotId = "";
    let capturedPrompt = "";
    const codeCheckedIds: string[] = [];

    const service = new TaskTriageService(db, {
      taskPlanning,
      registry: kernel.registry,
      botRunner: async (input) => {
        capturedBotId = input.botId;
        capturedPrompt = input.prompt;
        return {
          botId: input.botId,
          botTaskId: "btsk_mock_01",
          verdicts: [
            { taskId: tNoiseHigh.id, verdict: "noise_archive", confidence: 0.92, reason: "纯新闻摘要噪音" },
            { taskId: tNoiseLowConf.id, verdict: "noise_archive", confidence: 0.6, reason: "把握不够高" },
            { taskId: tIdea.id, verdict: "idea_demote", confidence: 0.88, reason: "技术雷达探索想法" },
            { taskId: tIdeaDup.id, verdict: "idea_demote", confidence: 0.86, reason: "同类探索想法" },
            { taskId: tDone.id, verdict: "already_done", confidence: 0.95, reason: "已在 recoverOrphanedRuns 实现", evidence: "src/server/dark-factory.ts" },
            { taskId: tCheckExists.id, verdict: "needs_code_check", confidence: 0.85, reason: "需核对去重正则代码" },
            { taskId: tCheckAlreadyFixed.id, verdict: "needs_code_check", confidence: 0.85, reason: "需核对中间件是否已补齐" },
            {
              taskId: tRealReady.id,
              verdict: "real_ready",
              confidence: 0.95,
              reason: "目标明确可直接派工",
              suggestedProject: "opc-repo",
              suggestedVerifyCommand: "npx tsx --test src/cli.test.ts",
            },
            { taskId: tNeedsScope.id, verdict: "needs_scope", confidence: 0.8, reason: "缺少指标与具体模块" },
            {
              taskId: tNoAssetCmd.id,
              verdict: "real_ready",
              confidence: 0.9,
              reason: "范围已确认，但模型建议的验收命令不能落库",
              suggestedVerifyCommand: "rm -rf /",
            },
          ],
        };
      },
      codeCheckRunner: async ({ task, repoPath }) => {
        assert.equal(repoPath, repoDir);
        codeCheckedIds.push(task.id);
        if (task.id === tCheckExists.id) {
          return {
            verdict: "real_ready",
            confidence: 0.94,
            reason: "经只读检索确认去重正则仍漏掉句末点号",
            evidence: "src/dedupe.ts:L42",
          };
        }
        return {
          verdict: "already_done",
          confidence: 0.96,
          reason: "代码已包含 Cache-Control: no-store 中间件",
          evidence: "src/server/http.ts:L88",
        };
      },
    });

    const report = await service.runBotTriageBatch({ batchSize: 15, dryRun: false, useAgyCodeCheck: true });

    // Verified RD VP Bot discovery & prompt contents
    assert.equal(capturedBotId, "bot_rd_vp_001");
    assert.ok(capturedPrompt.includes("opc-repo"));
    assert.ok(capturedPrompt.includes(repoDir));
    assert.equal(report.botTaskId, "btsk_mock_01");
    assert.equal(report.codeCheckedCount, 2);
    assert.deepEqual(codeCheckedIds.sort(), [tCheckExists.id, tCheckAlreadyFixed.id].sort());

    // Noise >= 0.8 archived, noise < 0.8 kept as needs_scope
    assert.equal(taskPlanning.getTask(tNoiseHigh.id).status, "archived");
    assert.equal(getTaskTriageStatus(taskPlanning.getTask(tNoiseHigh.id)), "noise_archived");
    assert.equal(taskPlanning.getTask(tNoiseLowConf.id).status, "todo");
    assert.equal(getTaskTriageStatus(taskPlanning.getTask(tNoiseLowConf.id)), "needs_scope");

    // Idea demotion archived both & inserted ONLY ONE deduped row in company_notes
    const idea1After = taskPlanning.getTask(tIdea.id);
    const idea2After = taskPlanning.getTask(tIdeaDup.id);
    assert.equal(idea1After.status, "archived");
    assert.equal(idea2After.status, "archived");
    assert.equal(getTaskTriageStatus(idea1After), "idea_demoted");
    assert.equal(getTaskTriageStatus(idea2After), "idea_demoted");
    const ideaNotes = db.prepare("SELECT * FROM company_notes WHERE kind = 'idea'").all() as Array<{
      id: string;
      title: string;
    }>;
    assert.equal(ideaNotes.length, 1);
    assert.equal(ideaNotes[0].title, "试水 Genie 4 世界模型与本地视频加速");
    assert.equal(extractTaskTriage(idea1After.metadata).demotedIdeaId, ideaNotes[0].id);
    assert.equal(extractTaskTriage(idea2After.metadata).demotedIdeaId, ideaNotes[0].id);

    // Already done -> superseded + archived
    const doneAfter = taskPlanning.getTask(tDone.id);
    assert.equal(doneAfter.status, "archived");
    assert.equal(getTaskTriageStatus(doneAfter), "superseded");
    assert.equal(extractTaskTriage(doneAfter.metadata).evidence, "src/server/dark-factory.ts");

    // Code check results
    const checkExistsAfter = taskPlanning.getTask(tCheckExists.id);
    assert.equal(checkExistsAfter.status, "todo");
    assert.equal(getTaskTriageStatus(checkExistsAfter), "verified");
    assert.equal(extractTaskTriage(checkExistsAfter.metadata).codeCheckRan, true);
    assert.equal(extractTaskTriage(checkExistsAfter.metadata).codeCheckVerdict, "still_exists");

    const checkFixedAfter = taskPlanning.getTask(tCheckAlreadyFixed.id);
    assert.equal(checkFixedAfter.status, "archived");
    assert.equal(getTaskTriageStatus(checkFixedAfter), "superseded");
    assert.equal(extractTaskTriage(checkFixedAfter.metadata).codeCheckVerdict, "already_done");

    // real_ready updated project + verifyCommand & entered verified ready queue
    const readyAfter = taskPlanning.getTask(tRealReady.id);
    assert.equal(getTaskTriageStatus(readyAfter), "verified");
    assert.equal(readyAfter.project, "opc-repo");
    assert.equal(readyAfter.assetId, "asset_opc_repo");
    assert.equal(readyAfter.verifyCommand, "npm test"); // inherited from active asset

    // needs_scope stayed todo but excluded from auto-dispatch
    assert.equal(getTaskTriageStatus(taskPlanning.getTask(tNeedsScope.id)), "needs_scope");

    const noAssetAfter = taskPlanning.getTask(tNoAssetCmd.id);
    assert.equal(noAssetAfter.verifyCommand, "");
    assert.equal(getTaskTriageStatus(noAssetAfter), "verified");

    const autoReadyIds = taskPlanning.listReadyForAutoDispatch(20).map((t) => t.id).sort();
    assert.deepEqual(autoReadyIds, [tCheckExists.id, tRealReady.id, tNoAssetCmd.id].sort());
  } finally {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("4. Clean fallback when Agent Home Bot is unreachable reverts undecided tasks to unreviewed", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const taskPlanning = new TaskPlanningStore(db);
    const ideaTask = taskPlanning.createTask({
      project: "opc-os",
      title: "**评估 Genie 4 与开源视频工具链**",
      sourceRef: "signal://sig_fallback_idea",
      priority: 8,
    });
    const realTask = taskPlanning.createTask({
      project: "opc-os",
      title: "修复 DarkFactory 并发派发锁竞争",
      priority: 10,
    });

    const service = new TaskTriageService(db, {
      taskPlanning,
      botRunner: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:37070");
      },
    });

    const report = await service.runBotTriageBatch({ batchSize: 10 });
    assert.equal(report.fallbackUsed, true);
    assert.ok(report.error?.includes("ECONNREFUSED"));
    assert.equal(report.ideaDemotedCount, 1);
    assert.equal(report.verifiedCount, 0);

    // Idea demoted cleanly via fallback; real task safely reverted from triaging -> unreviewed
    assert.equal(getTaskTriageStatus(taskPlanning.getTask(ideaTask.id)), "idea_demoted");
    assert.equal(getTaskTriageStatus(taskPlanning.getTask(realTask.id)), "unreviewed");
  } finally {
    db.close();
  }
});

test("5. ProductDepartment stamps unreviewed on normal signals and verified on emergency P0 crash bugs", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const kernel = new OpcKernel(db);
    const strategy = new StrategyDepartment({ kernel });
    const taskPlanning = new TaskPlanningStore(db);
    const product = new ProductDepartment({
      kernel,
      strategy,
      taskPlanning,
      autoPromote: true,
    });

    const normalRes = await product.ingestSignal({
      source: "journal:2026-11-24.md",
      projectRef: "pagelens-interpret",
      title: "为 pagelens-interpret 新增 SRT 字幕导出命令与单测",
      body: "明确改动 src/export.ts 并执行 npm test 验收",
      tags: ["monetization", "offline"],
      autoPromote: true,
    });
    assert.ok(normalRes.promotedTask);
    assert.equal(getTaskTriageStatus(normalRes.promotedTask), "unreviewed");
    assert.equal(
      taskPlanning.listReadyForAutoDispatch(20).some((t) => t.id === normalRes.promotedTask!.id),
      false,
    );

    const emergencyRes = await product.ingestSignal({
      source: "ops.crash_bug_filed",
      projectRef: "pagelens-interpret",
      title: "[P0 崩溃自愈] pagelens-interpret 启动空指针崩溃",
      body: "TypeError: Cannot read properties of undefined",
      tags: ["crash", "bug", "p0"],
      isEmergencyBug: true,
      autoPromote: true,
      priority: 10,
      taskType: "bug",
    });
    assert.ok(emergencyRes.promotedTask);
    assert.equal(getTaskTriageStatus(emergencyRes.promotedTask), "verified");
    assert.equal(
      taskPlanning.listReadyForAutoDispatch(20).some((t) => t.id === emergencyRes.promotedTask!.id),
      true,
    );
  } finally {
    db.close();
  }
});

test("6. Layer 2 runRollingCycle dispatches verified leaf tasks respecting autoRollEnabled, maxAutoDispatchPerCycle, and agent cooldown", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "opc-triage-roll-"));
  const logDir = join(tmpRoot, "logs");
  const worktreeBase = join(tmpRoot, "worktrees");
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  providers.update({ system: { maxConcurrentAgents: 2, agentLogDir: logDir } });
  const darkFactory = new DarkFactoryStore(db, providers, { worktreeBase, defaultRepoRoot: tmpRoot });

  try {
    const kernel = new OpcKernel(db);
    const taskPlanning = new TaskPlanningStore(db, providers);
    const resources = new ResourcesDepartment({
      kernel,
      darkFactory,
      readHubFn: () => ({ generatedAt: new Date().toISOString(), tools: [], fees: [], feesAvailable: false }),
    });

    // Two agents: grok-cli (cooled down with 2 recent failures) and agy (healthy)
    const grok = darkFactory.createAgent({
      name: "grok-cli",
      cliCommand: `node -e "process.exit(1)"`,
      capabilities: ["coding", "fullstack", "bugfix"],
    });
    const agy = darkFactory.createAgent({
      name: "agy",
      cliCommand: `node -e "console.log('done agy')"`,
      capabilities: ["coding", "fullstack"],
    });

    // Trip grok-cli cooldown via 2 consecutive failures
    const f1 = darkFactory.dispatch({ taskId: "PRE-FAIL-1", taskTitle: "F1", agentId: grok.id });
    await darkFactory.waitForRun(f1.id, 5_000);
    const f2 = darkFactory.dispatch({ taskId: "PRE-FAIL-2", taskTitle: "F2", agentId: grok.id });
    await darkFactory.waitForRun(f2.id, 5_000);
    assert.equal(darkFactory.isAgentCooledDown(grok.id), true);

    const tNoise = taskPlanning.createTask({ project: "pagelens-interpret", title: "今日产物与飞书公开数字花园链接" });
    const tReady1 = taskPlanning.createTask({ project: "pagelens-interpret", title: "修复字幕导出编码 bug", priority: 10 });
    const tReady2 = taskPlanning.createTask({ project: "pagelens-interpret", title: "补充支付回调单测", priority: 9 });

    const service = new TaskTriageService(db, {
      taskPlanning,
      darkFactory,
      resources,
      registry: kernel.registry,
      providers,
      botRunner: async ({ tasks }) => ({
        botId: "bot_rd",
        botTaskId: "btsk_roll_1",
        verdicts: tasks.map((t) => ({
          taskId: t.id,
          verdict: "real_ready" as const,
          confidence: 0.95,
          reason: "验收清晰",
        })),
      }),
    });

    // Default autoRollEnabled = false -> sweeps & verifies, dispatches 0
    const cycleNoRoll = await service.runRollingCycle();
    assert.equal(cycleNoRoll.noiseArchivedCount, 1);
    assert.equal(cycleNoRoll.verifiedCount, 2);
    assert.equal(cycleNoRoll.dispatchedCount, 0);
    assert.equal(taskPlanning.getTask(tNoise.id).status, "archived");

    // Enable autoRollEnabled with maxAutoDispatchPerCycle = 1 -> dispatches top 1 verified task to healthy agy!
    service.updateConfig({ autoRollEnabled: true, maxAutoDispatchPerCycle: 1 });
    const cycleRoll = await service.runRollingCycle();
    assert.equal(cycleRoll.dispatchedCount, 1);
    assert.deepEqual(cycleRoll.dispatchedTaskIds, [tReady1.id]);
    assert.equal(cycleRoll.dispatchedRunIds.length, 1);

    const dispatchedRun = await darkFactory.waitForRun(cycleRoll.dispatchedRunIds[0], 5_000);
    assert.equal(dispatchedRun.agentId, agy.id, "must fallback from cooled-down grok-cli to healthy agy");
    assert.equal(dispatchedRun.status, "completed");

    // Second task still todo & verified for next cycle
    assert.equal(taskPlanning.getTask(tReady2.id).status, "todo");
  } finally {
    await darkFactory.dispose();
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("7. HTTP routes under /api/opc/planning/triage/* and JSON parser edge cases", async () => {
  // Parser edge-case verification
  const fencedVerdicts = parseTriageVerdictsFromText(
    "以下是审查结果：\n```json\n[{\"taskId\":\"t1\",\"verdict\":\"real_ready\",\"confidence\":1.5,\"reason\":\"ok\"}]\n```",
  );
  assert.equal(fencedVerdicts.length, 1);
  assert.equal(fencedVerdicts[0].confidence, 1);

  const checkParsed = parseCodeCheckFromText(
    '分析完成：{"verdict":"still_exists","confidence":0.9,"reason":"bug仍在","evidence":"a.ts:10"}',
  );
  assert.equal(checkParsed.verdict, "real_ready");
  assert.equal(checkParsed.evidence, "a.ts:10");

  const db = new DatabaseSync(":memory:");
  try {
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
      return c.json({ error: "internal", message: String(err) }, 500);
    });

    const taskPlanning = new TaskPlanningStore(db);
    const tNoise = taskPlanning.createTask({ project: "opc-os", title: "技术学习补记" });
    const tReal = taskPlanning.createTask({ project: "opc-os", title: "修复队列锁死问题", priority: 9 });

    registerTaskTriageRoutes(app, db, {
      taskPlanning,
      user: () => ({ id: "u1", name: "Founder" }),
      botRunner: async ({ tasks }) => ({
        botId: "bot_rd",
        botTaskId: "btsk_http_1",
        verdicts: tasks.map((t) => ({
          taskId: t.id,
          verdict: "real_ready" as const,
          confidence: 0.9,
          reason: "明确可执行",
        })),
      }),
    });

    // GET /status
    const statusRes = await app.request("/api/opc/planning/triage/status");
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as TriageStatusResponse;
    assert.equal(statusBody.funnel.totalTodo, 2);
    assert.equal(statusBody.funnel.unreviewed, 2);
    assert.equal(statusBody.config.autoRollEnabled, false);

    // PATCH /config
    const cfgRes = await app.request("/api/opc/planning/triage/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoRollEnabled: true, batchSize: 10, useAgyCodeCheck: false }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgBody = (await cfgRes.json()) as { config: TriageConfig };
    assert.equal(cfgBody.config.autoRollEnabled, true);
    assert.equal(cfgBody.config.batchSize, 10);
    assert.equal(cfgBody.config.useAgyCodeCheck, false);

    // POST /sweep
    const sweepRes = await app.request("/api/opc/planning/triage/sweep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: false }),
    });
    assert.equal(sweepRes.status, 200);
    const sweepBody = (await sweepRes.json()) as TriageRunReport;
    assert.equal(sweepBody.noiseArchivedCount, 1);
    assert.equal(taskPlanning.getTask(tNoise.id).status, "archived");

    // POST /run-once
    const runRes = await app.request("/api/opc/planning/triage/run-once", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skipRoll: true }),
    });
    assert.equal(runRes.status, 200);
    const runBody = (await runRes.json()) as TriageRunReport;
    assert.equal(runBody.verifiedCount, 1);
    assert.equal(runBody.funnel.verified, 1);

    // POST /tasks/:id manual demote -> idea_demoted + company_notes
    const manualRes = await app.request(`/api/opc/planning/triage/tasks/${tReal.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "idea_demote", reason: "暂转想法库" }),
    });
    assert.equal(manualRes.status, 200);
    const manualBody = (await manualRes.json()) as {
      task: { status: string };
      demotedIdeaId: string | null;
      funnel: { idea_demoted: number };
    };
    assert.equal(manualBody.task.status, "archived");
    assert.ok(manualBody.demotedIdeaId);
    assert.equal(manualBody.funnel.idea_demoted, 1);
  } finally {
    db.close();
  }
});

test("8. Agent Home 3500-char prompt limit: compact prompt & dynamic sub-batching strictly enforce <= 3400 chars with valid JSON", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const kernel = new OpcKernel(db);
    const taskPlanning = new TaskPlanningStore(db);

    // Seed 10 active assets with realistic long local paths
    for (let i = 0; i < 10; i++) {
      kernel.registry.upsertAsset({
        id: `asset_long_${i}`,
        productId: "prod_opc_os",
        name: `service-repo-${i}`,
        slug: `service-repo-${i}`,
        localRepoPath: `/Users/penglei/developer/ai-github/organization-workspace/service-repo-${i}-monorepo`,
        verifyCommand: "npm run typecheck && npm test",
        paused: false,
      });
    }

    // Create 15 tasks with long titles & 2000-char descriptions
    const longDesc = "详细背景与复现步骤：".repeat(150);
    const createdTasks = [];
    for (let i = 0; i < 15; i++) {
      createdTasks.push(
        taskPlanning.createTask({
          project: `service-repo-${i % 10}`,
          title: `[Task #${i + 1}] 修复高并发场景下跨仓库任务队列去重与熔断状态同步的边界异常并补充完整单测回归验证用例 ${"X".repeat(80)}`,
          description: longDesc,
          priority: 10 - (i % 5),
          sourceRef: `signal://sig_long_batch_item_${i + 1}`,
        }),
      );
    }

    const mainlines = kernel.registry.listMainlines().map((m) => ({
      slug: m.slug,
      name: m.name,
      status: m.status,
      priorityWeight: m.priorityWeight,
      freezeNonMainline: m.freezeNonMainline,
    }));
    const assets = kernel.registry.listAssets().map((a) => ({
      slug: a.slug,
      name: a.name,
      localRepoPath: a.localRepoPath,
      verifyCommand: a.verifyCommand,
      paused: a.paused,
    }));

    // 1. Even calling buildBotTriagePrompt directly with all 15 huge tasks stays <= 3400 chars with valid JSON
    const directPrompt = buildBotTriagePrompt({ mainlines, assets, tasks: createdTasks });
    assert.ok(
      directPrompt.length <= MAX_BOT_TRIAGE_PROMPT_CHARS,
      `directPrompt length ${directPrompt.length} exceeded ${MAX_BOT_TRIAGE_PROMPT_CHARS}`,
    );
    const directJsonMatch = directPrompt.match(/任务:(\[[\s\S]*\])$/);
    assert.ok(directJsonMatch, "directPrompt must end with valid 任务 JSON array");
    assert.doesNotThrow(() => JSON.parse(directJsonMatch![1]));

    // 2. splitTasksIntoPromptBatches splits 15 huge tasks into multiple sub-batches covering all 15 tasks
    const subBatches = splitTasksIntoPromptBatches({ mainlines, assets, tasks: createdTasks });
    assert.ok(subBatches.length >= 2, `expected multiple sub-batches for 15 huge tasks, got ${subBatches.length}`);
    let coveredIds = new Set<string>();
    for (const sub of subBatches) {
      assert.ok(
        sub.prompt.length <= MAX_BOT_TRIAGE_PROMPT_CHARS,
        `sub-batch prompt length ${sub.prompt.length} exceeded ${MAX_BOT_TRIAGE_PROMPT_CHARS}`,
      );
      const match = sub.prompt.match(/任务:(\[[\s\S]*\])$/);
      assert.ok(match, "sub-batch prompt must contain valid 任务 JSON array");
      const parsedItems = JSON.parse(match![1]) as Array<{ taskId: string }>;
      assert.equal(parsedItems.length, sub.tasks.length);
      for (const item of parsedItems) coveredIds.add(item.taskId);
    }
    assert.equal(coveredIds.size, 15, "all 15 tasks must be covered across sub-batches");

    // 3. End-to-end runBotTriageBatch sends every sub-batch <= 3400 chars and applies all 15 verdicts
    const observedLengths: number[] = [];
    let callCount = 0;
    const service = new TaskTriageService(db, {
      taskPlanning,
      registry: kernel.registry,
      botRunner: async (input) => {
        callCount += 1;
        observedLengths.push(input.prompt.length);
        assert.ok(
          input.prompt.length <= MAX_BOT_TRIAGE_PROMPT_CHARS,
          `botRunner call #${callCount} prompt too long: ${input.prompt.length}`,
        );
        return {
          botId: input.botId,
          botTaskId: `btsk_sub_${callCount}`,
          verdicts: input.tasks.map((t) => ({
            taskId: t.id,
            verdict: "real_ready" as const,
            confidence: 0.92,
            reason: "分批审查通过",
          })),
        };
      },
    });

    const report = await service.runBotTriageBatch({ batchSize: 15, dryRun: false });
    assert.ok(callCount >= 2, "runBotTriageBatch should invoke botRunner per sub-batch");
    assert.ok(observedLengths.every((len) => len > 0 && len <= MAX_BOT_TRIAGE_PROMPT_CHARS));
    assert.equal(report.fallbackUsed, false);
    assert.equal(report.verifiedCount, 15);
    assert.equal(report.funnel.verified, 15);
    assert.equal(report.funnel.unreviewed, 0);
  } finally {
    db.close();
  }
});
