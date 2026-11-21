import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { ApiError } from "./server/logic.ts";
import {
  MetabolismStore,
  recentMonthLabels,
  registerMetabolismRoutes,
  signHupijiaoParams,
  todayDate,
  verifyHupijiaoSignature,
} from "./server/metabolism.ts";
import { ProvidersStore, registerProvidersRoutes } from "./server/providers.ts";

function setupEnv() {
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  return { db, providers };
}

test("1. Information Metabolism: ingest briefing, daily digest, journal import, island projection & dormant memory activation", async () => {
  const { db, providers } = setupEnv();
  const projectedCalls: Array<{ canvasId: string; count: number }> = [];
  const tempJournalDir = mkdtempSync(join(tmpdir(), "opc-journal-test-"));

  try {
    writeFileSync(
      join(tempJournalDir, "2026-11-20.md"),
      `# 2026-11-20 技术复盘

## Chrome 浏览器插件离线授权实践
使用 Ed25519 离线签名验证 Pro License，可以让独立开发者免去高昂的服务器校验成本。客单价 $29 买断方案转化率提升 38%，支持完全离线运行。

## SQLite 本地优先向量检索
在单机 Node 22 node:sqlite 上结合 256 维语义向量，无需外部数据库即可在 5ms 内召回历史沉睡记忆卡片与知识图谱节点。
`,
      "utf8",
    );

    const store = new MetabolismStore(db, providers, {
      journalDir: tempJournalDir,
      hooks: {
        listCanvases: () => [{ id: "canvas-main", name: "OPC 知识画布" }],
        projectToCanvas: async (canvasId, items) => {
          projectedCalls.push({ canvasId, count: items.length });
          return { createdNodes: items.length, semanticEdges: Math.max(0, items.length - 1) };
        },
        findDormantMemories: (_vec, queryText) =>
          queryText.includes("插件")
            ? [
                {
                  id: "node-pagelens-1",
                  kind: "canvas_node",
                  title: "PageLens 离线 License 架构草图",
                  canvasId: "canvas-main",
                  href: "#canvas?id=canvas-main&node=node-pagelens-1",
                  similarity: 0.86,
                },
              ]
            : [],
      },
    });

    // Seed an earlier briefing on Chrome extension monetization
    const first = await store.ingestBriefing({
      source: "github",
      title: "PageLens Chrome 视频同传插件离线授权架构",
      rawContent:
        "PageLens Chrome 浏览器插件采用本地音频流实时同声传译，使用 Ed25519 离线 License 实现 $29 买断变现，无服务端校验延迟，转化率达到 4.2%。同时通过 SQLite 记录用户核心激活漏斗。",
    });

    assert.equal(first.engine, "local");
    assert.equal(first.vectorSource, "local");
    assert.equal(first.briefing.corePoints.length, 3);
    assert.ok(first.briefing.tags.length >= 1 && first.briefing.tags.length <= 5);
    assert.ok(first.briefing.score >= 60 && first.briefing.score <= 100);
    assert.ok(first.activatedMemories.some((m) => m.id === "node-pagelens-1"));

    // Ingest a second semantically related briefing -> should awaken the first briefing too!
    const second = await store.ingestBriefing({
      source: "hackernews",
      rawContent:
        "独立开发者分享 Chrome 浏览器插件变现复盘：通过离线 License 买断与本地音频处理，首月实现 $3200 MRR，零服务器成本，获客主要靠开源核心与 Reddit 社区。",
    });

    assert.ok(
      second.activatedMemories.some((m) => m.kind === "briefing" && m.id === first.briefing.id),
      "expected second related briefing to awaken historical briefing memory",
    );

    // Explicit activateDormantMemories call
    const memRes = store.activateDormantMemories(second.briefing.id);
    assert.ok(memRes.memories.some((m) => m.id === first.briefing.id));

    // Daily digest
    const digest = store.generateDailyDigest(todayDate());
    assert.equal(digest.count, 2);
    assert.ok(digest.topTags.length >= 1);
    assert.ok(digest.markdown.includes("信息代谢每日综述"));
    assert.ok(digest.markdown.includes(first.briefing.title));

    // Project briefing island to Knowledge Canvas
    const island = await store.projectBriefingIsland("canvas-main", todayDate());
    assert.equal(island.createdNodes, 2);
    assert.equal(island.semanticEdges, 1);
    assert.equal(island.simulated, false);
    assert.equal(projectedCalls.length, 1);

    // Import from local daily-review-learning journal + deduplication check
    const imported1 = await store.importFromJournal("2026-11-20");
    assert.equal(imported1.day, "2026-11-20");
    assert.equal(imported1.imported, 2);
    assert.equal(imported1.skipped, 0);

    const imported2 = await store.importFromJournal("2026-11-20");
    assert.equal(imported2.imported, 0);
    assert.equal(imported2.skipped, 2);

    // Workflow trigger unconfigured -> clear guidance
    const wfUnconfigured = await store.triggerExternalWorkflow({});
    assert.equal(wfUnconfigured.configured, false);
    assert.equal(wfUnconfigured.triggered, false);

    // Delete briefing
    const del = store.deleteBriefing(second.briefing.id);
    assert.equal(del.deleted, true);
    assert.equal(store.getTodayBriefings().length, 1);
  } finally {
    rmSync(tempJournalDir, { recursive: true, force: true });
  }
});

test("2. PM Agent dual-dimension scoring: high-score idea auto-creates Epic+SubTasks, vague low-score returns no_action", async () => {
  const { db, providers } = setupEnv();
  const createdTrees: Array<{ project: string; title: string; subtasksCount: number }> = [];
  const addedOpps: Array<{ project: string; title: string }> = [];

  const store = new MetabolismStore(db, providers, {
    hooks: {
      createTaskTree: (input) => {
        createdTrees.push({ project: input.project, title: input.title, subtasksCount: input.subtasks.length });
        return {
          epicId: `epic-${createdTrees.length}`,
          subtaskIds: input.subtasks.map((_, i) => `sub-${createdTrees.length}-${i + 1}`),
        };
      },
      addOpportunity: (input) => {
        addedOpps.push({ project: input.project, title: input.title });
        return { id: `opp-${addedOpps.length}` };
      },
    },
  });

  // High-value, concrete, feasible, monetizable requirement
  const highEval = await store.evaluateWithPmAgent({
    project: "PageLens",
    source: "briefing",
    alsoAddOpportunity: true,
    content:
      "开发 Chrome 视频实时同声传译插件 Pro 版：基于本地音频流 + Whisper API 与 SQLite 轻量缓存，面向跨境电商和外语学习者解决外语长视频听不懂的刚需痛点。定价 $29 离线 License 买断，接入 Stripe 与虎皮椒收款，单人 2 周即可交付 MVP。",
  });

  assert.ok(highEval.technicalScore >= 80, `expected high technical score, got ${highEval.technicalScore}`);
  assert.ok(highEval.commercialScore >= 80, `expected high commercial score, got ${highEval.commercialScore}`);
  assert.ok(highEval.combinedScore >= 85, `expected combined >= 85, got ${highEval.combinedScore}`);
  assert.equal(highEval.action, "created");
  assert.equal(highEval.epicTaskId, "epic-1");
  assert.equal(highEval.opportunityId, "opp-1");
  assert.ok(highEval.decomposedTasks.length >= 3);
  assert.equal(createdTrees.length, 1);
  assert.equal(addedOpps.length, 1);

  // Vague low-score content -> no_action
  const lowEval = await store.evaluateWithPmAgent({
    project: "Misc",
    source: "manual",
    content: "随便做个好玩的东西，不知道给谁用，完全免费无变现",
  });

  assert.ok(lowEval.combinedScore < 60, `expected low combined score, got ${lowEval.combinedScore}`);
  assert.equal(lowEval.action, "no_action");
  assert.equal(lowEval.epicTaskId, null);
  assert.equal(createdTrees.length, 1);

  const history = store.listPmEvaluations();
  assert.equal(history.length, 2);
});

test("3. User Feedback reverse-feed: extract action, auto-convert high severity, manual idempotent convert", async () => {
  const { db, providers } = setupEnv();
  let treeCallCount = 0;

  const store = new MetabolismStore(db, providers, {
    hooks: {
      createTaskTree: (input) => {
        treeCallCount += 1;
        return {
          epicId: `fb-epic-${treeCallCount}`,
          subtaskIds: input.subtasks.map((_, i) => `fb-sub-${treeCallCount}-${i + 1}`),
        };
      },
    },
  });

  // Auto-convert billing/crash feedback
  const autoFb = await store.submitFeedback({
    project: "PageLens",
    channel: "wechat",
    rawText: "虎皮椒支付成功后一直报错 500，无法拿到激活码，扣款成功但页面白屏崩溃！",
    autoCreateTask: true,
  });

  assert.equal(autoFb.category, "billing");
  assert.equal(autoFb.severity, "high");
  assert.ok(autoFb.priority >= 9);
  assert.ok(autoFb.extractedAction.length > 5);
  assert.equal(autoFb.status, "converted");
  assert.equal(autoFb.generatedTaskId, "fb-epic-1");
  assert.equal(treeCallCount, 1);

  // Manual convert UX feedback + verify idempotency
  const manualFb = await store.submitFeedback({
    project: "PageLens",
    channel: "in_app",
    rawText: "希望能支持一键导出双语 Markdown 字幕笔记，方便放到 Obsidian 里复习。",
    autoCreateTask: false,
  });

  assert.equal(manualFb.category, "feature");
  assert.equal(manualFb.status, "triaged");
  assert.equal(manualFb.generatedTaskId, null);

  const converted1 = store.convertFeedbackToTask(manualFb.id);
  assert.equal(converted1.alreadyConverted, false);
  assert.equal(converted1.taskId, "fb-epic-2");
  assert.equal(converted1.feedback.status, "converted");
  assert.equal(treeCallCount, 2);

  // Second convert is idempotent and does not recreate task
  const converted2 = store.convertFeedbackToTask(manualFb.id);
  assert.equal(converted2.alreadyConverted, true);
  assert.equal(converted2.taskId, "fb-epic-2");
  assert.equal(treeCallCount, 2);
});

test("4. Multi-channel Payments: Hupijiao MD5 signing & strict callback verification + sandbox instant pay", () => {
  const { db, providers } = setupEnv();
  const secret = "hupi_super_secret_key_2026";
  providers.update({
    services: {
      payment: {
        domestic: {
          enabled: true,
          type: "hupijiao",
          endpoint: "https://api.xunhupay.com",
          appId: "20260001",
          appSecret: secret,
          notifyUrl: "https://opc.example.com/api/opc/metabolism/payments/callback/hupijiao",
        },
      },
    },
  });

  const store = new MetabolismStore(db, providers);

  // Create Hupijiao real signed order
  const order = store.createPaymentOrder({
    project: "PageLens",
    subject: "PageLens Pro 买断授权",
    amount: 199,
    currency: "CNY",
    channel: "hupijiao",
  });

  assert.equal(order.status, "pending");
  assert.equal(order.sandbox, false);
  assert.ok(order.outTradeNo.startsWith("OPC-"));
  assert.ok(order.payUrl.includes("api.xunhupay.com/payment/do.html"));
  assert.ok(order.payUrl.includes("hash="));

  // Verify embedded URL hash matches signHupijiaoParams
  const urlObj = new URL(order.payUrl);
  const urlParams: Record<string, string> = {};
  urlObj.searchParams.forEach((v, k) => {
    urlParams[k] = v;
  });
  assert.equal(verifyHupijiaoSignature(urlParams, secret), true);

  // Callback with INVALID signature MUST be rejected
  const badCb = store.handlePaymentCallback("hupijiao", {
    trade_order_id: order.outTradeNo,
    open_order_id: "XH9999",
    total_fee: "199.00",
    trade_status: "OD",
    hash: "deadbeef000000000000000000000000",
  });
  assert.equal(badCb.success, false);
  assert.equal(badCb.message, "Invalid signature");

  // Order must still be pending
  assert.equal(store.listPayments("PageLens")[0].status, "pending");

  // Callback with VALID MD5 signature & trade_status=OD marks paid
  const cbPayload: Record<string, string> = {
    trade_order_id: order.outTradeNo,
    open_order_id: "XH20261121001",
    total_fee: "199.00",
    trade_status: "OD",
    appid: "20260001",
  };
  cbPayload.hash = signHupijiaoParams(cbPayload, secret);

  const okCb = store.handlePaymentCallback("hupijiao", cbPayload);
  assert.equal(okCb.success, true);
  assert.equal(okCb.order?.status, "paid");
  assert.equal(okCb.order?.transactionId, "XH20261121001");
  assert.ok(okCb.order?.paidAt);

  // Stripe sandbox order + instant sandbox pay
  const stripeOrder = store.createPaymentOrder({
    project: "AudioBook",
    subject: "AudioBook Desktop Pro",
    amount: 29,
    currency: "USD",
    channel: "stripe",
  });
  assert.equal(stripeOrder.sandbox, true);
  assert.equal(stripeOrder.status, "pending");

  const paidSandbox = store.confirmSandboxPayment(stripeOrder.id);
  assert.equal(paidSandbox.status, "paid");
  assert.ok(paidSandbox.transactionId?.startsWith("SANDBOX-"));
});

test("5. Omnichannel Content Distribution generates tailored platform copy and dispatches webhooks when configured", async () => {
  const { db, providers } = setupEnv();
  const webhookCalls: Array<{ channel: string; title: string }> = [];

  const mockFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { channel: string; title: string };
    webhookCalls.push({ channel: body.channel, title: body.title });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const store = new MetabolismStore(db, providers, { fetchImpl: mockFetch });

  // Offline draft_ready mode
  const draft = await store.distributeContent({
    title: "OPC OS 如何用 1 人 + 多 Agent 跑通商业闭环",
    content:
      "我们在 OPC OS 中打通了每日信息代谢、PM Agent 双维评分自动立项、虎皮椒/Stripe 原生收款与商业盈亏热力图。实测单人两周可上线完整商业试点，毛利率超过 85%。",
    channels: ["wechat", "juejin", "x", "reddit", "newsletter", "telegram"],
    sourceRef: "https://github.com/magele758/agent-zoom",
  });

  assert.equal(draft.status, "draft_ready");
  assert.equal(draft.channels.length, 6);
  assert.ok(draft.adaptedPayload.wechat.includes("在看"));
  assert.ok(draft.adaptedPayload.juejin.includes("TL;DR"));
  assert.ok(draft.adaptedPayload.x.includes("1/4"));
  assert.ok(draft.adaptedPayload.reddit.includes("[Share & Discussion]"));
  assert.ok(draft.adaptedPayload.newsletter.includes("Subject:"));
  assert.ok(draft.adaptedPayload.telegram.includes("⚡"));

  // Enable webhook dispatch and verify live POSTs
  providers.update({
    services: {
      distribution: {
        enabled: true,
        endpoint: "https://hook.example.com/distribute",
        apiKey: "dist_key_123",
      },
    },
  });

  const dispatched = await store.distributeContent({
    title: "PageLens v2.0 发布",
    content: "全新离线同传引擎上线，延迟降低 60%。",
    channels: ["x", "telegram"],
  });

  assert.equal(dispatched.status, "sent");
  assert.equal(webhookCalls.length, 2);
  assert.equal(store.listDistributions().length, 2);
});

test("6. Fractal CI/CD Outer-Loop Deployments: create, trigger deploy & rollback with audit logs", () => {
  const { db, providers } = setupEnv();
  const store = new MetabolismStore(db, providers);

  const created = store.createDeployment({
    project: "PageLens-API",
    targetHost: "tokyo-edge-01.tailnet",
    dockerImage: "ghcr.io/magele758/pagelens-api:v1.4.0",
    deployCommand: "docker compose pull && docker compose up -d",
    version: "v1.4.0",
    envVars: { NODE_ENV: "production", PORT: "8080" },
  });

  assert.equal(created.status, "configured");
  assert.equal(created.deployedAt, null);
  assert.equal(created.logs.length, 1);

  const deployed = store.triggerDeployment(created.id);
  assert.equal(deployed.status, "deployed");
  assert.ok(deployed.deployedAt);
  assert.ok(deployed.logs.length >= 4);

  const rolledBack = store.rollbackDeployment(created.id, { note: "检测到 5xx 上升，切回 v1.3.9" });
  assert.equal(rolledBack.status, "rolled_back");
  assert.ok(rolledBack.logs.some((l) => l.action === "rollback" && l.message.includes("5xx")));
  assert.equal(store.listDeployments("PageLens-API").length, 1);
});

test("7. Commercial Profit Heatmap, 3-month consecutive loss auto-alert, Kill Switch stop & resume", () => {
  const { db, providers } = setupEnv();
  const zoomAlerts: Array<{ folder: string; title: string }> = [];
  const months = recentMonthLabels(6);
  const lastThree = months.slice(-3);

  const store = new MetabolismStore(db, providers, {
    hooks: {
      readAgentCostsByProjectMonth: () => ({
        "LossProject": {
          [lastThree[0]]: 45,
          [lastThree[1]]: 60,
          [lastThree[2]]: 80,
        },
        "ProfitProject": {
          [lastThree[2]]: 12,
        },
      }),
      postAlertToZoom: (input) => {
        zoomAlerts.push({ folder: input.folder, title: input.title });
        return { taskId: "zt-kill-1", messageId: "zm-kill-1" };
      },
    },
  });

  // Add extra infra cost for LossProject
  store.recordMonthlyCost({
    project: "LossProject",
    month: lastThree[2],
    amountUsd: 20,
    category: "cloud",
    note: "VPS 服务器月费",
  });

  // Add paid revenue for ProfitProject in current month
  const order = store.createPaymentOrder({
    project: "ProfitProject",
    subject: "Pro Annual",
    amount: 199,
    currency: "USD",
    channel: "stripe",
  });
  store.confirmSandboxPayment(order.id);

  const heatmap = store.getCommercialHeatmap(6);
  assert.equal(heatmap.months.length, 6);
  assert.equal(heatmap.lossKillSwitchMonths, 3);

  const lossRow = heatmap.projects.find((p) => p.project === "LossProject");
  assert.ok(lossRow, "LossProject should appear in heatmap");
  assert.equal(lossRow.consecutiveLossMonths, 3);
  assert.equal(lossRow.cumulativeLossUsd, 205);
  assert.equal(lossRow.killSwitchAlert, true);
  assert.equal(lossRow.cells.at(-1)?.status, "loss");

  const profitRow = heatmap.projects.find((p) => p.project === "ProfitProject");
  assert.ok(profitRow, "ProfitProject should appear in heatmap");
  assert.equal(profitRow.consecutiveLossMonths, 0);
  assert.equal(profitRow.killSwitchAlert, false);
  assert.equal(profitRow.cells.at(-1)?.status, "profit");
  assert.equal(profitRow.cells.at(-1)?.netProfitUsd, 187);

  // Trigger Kill Switch
  const stopped = store.triggerKillSwitch("LossProject", {
    reason: "连续 3 个月亏损超 $200，立即止损停服",
    notifyZoom: true,
  });
  assert.equal(stopped.killSwitch.status, "stopped");
  assert.equal(stopped.killSwitch.consecutiveLossMonths, 3);
  assert.equal(stopped.killSwitch.cumulativeLossUsd, 205);
  assert.equal(stopped.zoomAlert?.taskId, "zt-kill-1");
  assert.equal(zoomAlerts.length, 1);

  const heatmapAfterStop = store.getCommercialHeatmap(6);
  assert.equal(heatmapAfterStop.summary.stoppedCount, 1);

  // Resume Project
  const resumed = store.resumeProject("LossProject", "切换为按量付费后恢复试运行");
  assert.equal(resumed.status, "active");
  assert.ok(resumed.resumedAt);
  assert.equal(store.getCommercialHeatmap(6).summary.stoppedCount, 0);
});

test("8. Hono HTTP Routes end-to-end verification across all 7 modules + providers", async () => {
  const { db } = setupEnv();
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    return c.json({ error: "internal", message: String(err) }, 500);
  });

  const mockUser = () => ({ id: "u1", name: "founder" });
  const providers = registerProvidersRoutes(app, db, mockUser);
  registerMetabolismRoutes(app, db, providers, mockUser, {
    hooks: {
      createTaskTree: () => ({ epicId: "http-epic-1", subtaskIds: ["http-sub-1", "http-sub-2"] }),
      listCanvases: () => [{ id: "c1", name: "主画布" }],
      projectToCanvas: async () => ({ createdNodes: 1, semanticEdges: 0 }),
    },
  });

  const jsonReq = (path: string, method = "GET", body?: unknown) =>
    app.request(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  // 1. Ingest briefing + fetch today + digest + project island
  const ingestRes = await jsonReq("/api/opc/metabolism/briefings/ingest", "POST", {
    source: "x",
    title: "AI Agent 工程化最佳实践",
    rawContent:
      "多 Agent 并行工作流结合 SQLite 持久化和语义检索，可将一人公司的研发效率提升 5 倍，并降低 40% Token 成本。",
  });
  assert.equal(ingestRes.status, 201);
  const ingested = (await ingestRes.json()) as { briefing: { id: string } };

  const todayRes = await jsonReq("/api/opc/metabolism/briefings/today");
  assert.equal(todayRes.status, 200);
  const todayBody = (await todayRes.json()) as { items: unknown[]; canvases: unknown[] };
  assert.equal(todayBody.items.length, 1);
  assert.equal(todayBody.canvases.length, 1);

  const digestRes = await jsonReq("/api/opc/metabolism/briefings/digest");
  assert.equal(digestRes.status, 200);

  const memRes = await jsonReq(`/api/opc/metabolism/briefings/${ingested.briefing.id}/activate-memory`, "POST");
  assert.equal(memRes.status, 200);

  const islandRes = await jsonReq("/api/opc/metabolism/briefings/project-island", "POST", { canvasId: "c1" });
  assert.equal(islandRes.status, 200);

  const wfRes = await jsonReq("/api/opc/metabolism/workflow/trigger", "POST", {});
  assert.equal(wfRes.status, 400);

  // 2. PM evaluate + list
  const pmRes = await jsonReq("/api/opc/metabolism/pm/evaluate", "POST", {
    project: "OPC-Kit",
    content:
      "构建独立开发者轻量 Chrome 插件，集成 SQLite 本地存储与 Stripe $29 买断 License 授权，解决跨境电商高频痛点，2周完成 MVP。",
  });
  assert.equal(pmRes.status, 201);
  const pmBody = (await pmRes.json()) as { action: string; epicTaskId: string | null };
  assert.equal(pmBody.action, "created");
  assert.equal(pmBody.epicTaskId, "http-epic-1");

  assert.equal((await jsonReq("/api/opc/metabolism/pm/evaluations")).status, 200);

  // 3. Feedback submit + manual create-task
  const fbRes = await jsonReq("/api/opc/metabolism/feedback", "POST", {
    project: "OPC-Kit",
    rawText: "导出 PDF 时偶尔卡死报错",
    autoCreateTask: false,
  });
  assert.equal(fbRes.status, 201);
  const fb = (await fbRes.json()) as { id: string };
  const fbConv = await jsonReq(`/api/opc/metabolism/feedback/${fb.id}/create-task`, "POST");
  assert.equal(fbConv.status, 200);
  assert.equal(((await fbConv.json()) as { taskId: string }).taskId, "http-epic-1");

  // 4. Payment create + sandbox pay + callback verification
  const payRes = await jsonReq("/api/opc/metabolism/payments/orders", "POST", {
    project: "OPC-Kit",
    subject: "Pro Plan",
    amount: 49,
    currency: "USD",
    channel: "lemonsqueezy",
  });
  assert.equal(payRes.status, 201);
  const order = (await payRes.json()) as { id: string };
  const payOk = await jsonReq(`/api/opc/metabolism/payments/${order.id}/sandbox-pay`, "POST");
  assert.equal(payOk.status, 200);
  assert.equal(((await payOk.json()) as { status: string }).status, "paid");

  // 5. Distribution
  const distRes = await jsonReq("/api/opc/metabolism/distributions", "POST", {
    title: "新版本发布",
    content: "支持全渠道分发与商业热力图监控。",
    channels: ["wechat", "x"],
  });
  assert.equal(distRes.status, 201);

  // 6. Deployment create + deploy + rollback
  const depRes = await jsonReq("/api/opc/metabolism/deployments", "POST", {
    project: "OPC-Kit",
    targetHost: "hk-node-1",
    version: "v1.0.0",
    dockerImage: "opc/kit:v1.0.0",
  });
  assert.equal(depRes.status, 201);
  const dep = (await depRes.json()) as { id: string };
  assert.equal((await jsonReq(`/api/opc/metabolism/deployments/${dep.id}/deploy`, "POST")).status, 200);
  assert.equal(
    (await jsonReq(`/api/opc/metabolism/deployments/${dep.id}/rollback`, "POST", { note: "回滚测试" })).status,
    200,
  );

  // 7. Commercial heatmap + costs + kill switch stop/resume
  const months = recentMonthLabels(6);
  for (const m of months.slice(-3)) {
    const costRes = await jsonReq("/api/opc/metabolism/commercial-heatmap/costs", "POST", {
      project: "ZombieApp",
      month: m,
      amountUsd: 35,
      category: "server",
    });
    assert.equal(costRes.status, 201);
  }
  const hmRes = await jsonReq("/api/opc/metabolism/commercial-heatmap?months=6");
  assert.equal(hmRes.status, 200);
  const hm = (await hmRes.json()) as { projects: Array<{ project: string; killSwitchAlert: boolean }> };
  assert.equal(hm.projects.find((p) => p.project === "ZombieApp")?.killSwitchAlert, true);

  const stopRes = await jsonReq("/api/opc/metabolism/kill-switch/ZombieApp/stop", "POST", {
    reason: "连续亏损熔断",
  });
  assert.equal(stopRes.status, 200);
  const resumeRes = await jsonReq("/api/opc/metabolism/kill-switch/ZombieApp/resume", "POST", {
    note: "重新评估后恢复",
  });
  assert.equal(resumeRes.status, 200);

  // 8. Providers health check route works alongside metabolism
  const healthRes = await jsonReq("/api/opc/providers/health", "POST");
  assert.equal(healthRes.status, 200);
});
