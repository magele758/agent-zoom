import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "./server/http.ts";
import { openStore } from "./server/logic.ts";

async function jsonReq<T>(
  app: ReturnType<typeof createApp>["app"],
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await app.request(path, {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, data };
}

test("Full Knowledge-to-Business end-to-end wired pipeline across all 5 modules + Zoom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opc-k2b-e2e-"));
  const dbPath = join(dir, "chatroom.db");
  const store = openStore(dbPath, { demo: false });

  try {
    const { app } = createApp(store);

    // Establish local human session cookie
    const sessRes = await app.request("/api/session", { method: "POST" });
    assert.equal(sessRes.status, 200);
    const setCookie = sessRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];
    assert.ok(cookie.includes("="), "expected session cookie");

    // 1. Provider config & health check
    const provGet = await jsonReq<{ system: { maxConcurrentAgents: number } }>(app, cookie, "GET", "/api/opc/providers");
    assert.equal(provGet.status, 200);
    assert.equal(provGet.data.system.maxConcurrentAgents, 3);

    const provHealth = await jsonReq<{ overall: string; entries: unknown[] }>(
      app,
      cookie,
      "POST",
      "/api/opc/providers/health",
    );
    assert.equal(provHealth.status, 200);
    assert.equal(provHealth.data.overall, "ok");

    // 2. Knowledge Canvas: create two canvases, Note + Ink + Bidirectional Portal + Space Expand
    const c1 = await jsonReq<{ id: string; name: string }>(app, cookie, "POST", "/api/opc/canvases", {
      name: "PageLens 产品战略画布",
    });
    assert.equal(c1.status, 201);
    const c2 = await jsonReq<{ id: string; name: string }>(app, cookie, "POST", "/api/opc/canvases", {
      name: "商业变现画布",
    });
    assert.equal(c2.status, 201);

    const note1 = await jsonReq<{ id: string }>(
      app,
      cookie,
      "POST",
      `/api/opc/canvases/${c1.data.id}/nodes`,
      {
        type: "note",
        title: "Chrome 视频实时同传插件离线 License 付费变现方案",
        content: { text: "使用 Ed25519 离线签名解锁 Pro 功能，定价 $29 买断或 $19 年付，解决外语视频学习痛点。" },
        position: { x: 100, y: 120 },
      },
    );
    assert.equal(note1.status, 201);
    assert.ok(note1.data.id);

    const portalRes = await jsonReq<{ id: string; reciprocalNode?: { id: string } }>(
      app,
      cookie,
      "POST",
      `/api/opc/canvases/${c1.data.id}/nodes`,
      {
        type: "portal",
        title: "→ 商业变现画布",
        targetCanvasId: c2.data.id,
        bidirectional: true,
        position: { x: 420, y: 120 },
      },
    );
    assert.equal(portalRes.status, 201);
    assert.ok(portalRes.data.reciprocalNode?.id, "bidirectional portal should create return node");

    // 3. Information Metabolism: ingest semantically related briefing -> wakes dormant Canvas node -> projects Briefing Island
    const ingestRes = await jsonReq<{
      briefing: { id: string; corePoints: string[]; tags: string[]; score: number };
      activatedMemories: Array<{ kind: string; id: string; canvasId?: string }>;
    }>(app, cookie, "POST", "/api/opc/metabolism/briefings/ingest", {
      source: "hackernews",
      title: "Chrome 扩展离线授权与视频实时翻译变现案例",
      rawContent:
        "独立开发者分享 Chrome 浏览器视频实时同传插件变现经验：采用 Ed25519 离线 License 签名，定价 $29 买断，外语视频学习用户转化率达到 4.2%，零服务器成本。",
    });
    assert.equal(ingestRes.status, 201);
    assert.ok(ingestRes.data.briefing.corePoints.length >= 1);
    assert.ok(
      ingestRes.data.activatedMemories.some((m) => m.kind === "canvas_node" && m.canvasId === c1.data.id),
      `expected briefing to wake dormant canvas node, got ${JSON.stringify(ingestRes.data.activatedMemories)}`,
    );

    const islandRes = await jsonReq<{ createdNodes: number; semanticEdges: number }>(
      app,
      cookie,
      "POST",
      "/api/opc/metabolism/briefings/project-island",
      { canvasId: c1.data.id },
    );
    assert.equal(islandRes.status, 200);
    assert.ok(islandRes.data.createdNodes >= 1, "briefing island should create nodes on canvas");

    // 4. Promote Canvas Note to real Kanban Task + verify live hydration on Canvas
    const promoteRes = await jsonReq<{
      id: string;
      type: string;
      content: { taskId?: string };
      liveTask?: { id: string; status: string } | null;
    }>(
      app,
      cookie,
      "POST",
      `/api/opc/canvases/${c1.data.id}/nodes/${note1.data.id}/promote-task`,
      { project: "PageLens" },
    );
    assert.equal(promoteRes.status, 200);
    const promotedTaskId = String(promoteRes.data.liveTask?.id ?? promoteRes.data.content.taskId ?? "");
    assert.ok(promotedTaskId, "expected promoted task id on canvas node");

    const canvasReload = await jsonReq<{
      nodes: Array<{ id: string; type: string; liveTask?: { id: string; status: string } | null }>;
    }>(app, cookie, "GET", `/api/opc/canvases/${c1.data.id}`);
    assert.equal(canvasReload.status, 200);
    const hydratedNode = canvasReload.data.nodes.find((n) => n.id === note1.data.id);
    assert.equal(hydratedNode?.liveTask?.id, promotedTaskId);

    // 5. PM Agent evaluates high-value SaaS requirement -> auto-creates real Epic + SubTask tree in TaskPlanning
    const pmRes = await jsonReq<{
      action: string;
      combinedScore: number;
      epicTaskId: string | null;
      decomposedTasks: unknown[];
    }>(app, cookie, "POST", "/api/opc/metabolism/pm/evaluate", {
      source: "briefing",
      project: "PageLens",
      threshold: 65,
      autoCreate: true,
      content:
        "为 PageLens 视频同传 Chrome 插件上线 $29 买断 Pro 离线 License 收费系统与一键字幕导出工具：目标用户是外语开发者与跨境卖家，付费意愿强、竞品月费 $19/月，单人使用 TypeScript + Ed25519 在 5 天内即可上线 MVP 并通过 Lemon Squeezy / 虎皮椒直接收款。",
    });
    assert.equal(pmRes.status, 201);
    assert.equal(pmRes.data.action, "created");
    assert.ok(pmRes.data.epicTaskId, "PM Agent should auto-create Epic task");

    // 6. User Feedback -> auto-create real Kanban Task
    const fbRes = await jsonReq<{ id: string; generatedTaskId: string | null }>(
      app,
      cookie,
      "POST",
      "/api/opc/metabolism/feedback",
      {
        project: "PageLens",
        channel: "in_app",
        rawText: "紧急 Bug：在 Bilibili 全屏播放 4K 视频时，同传字幕浮层被遮挡且崩溃报错，希望能尽快修复。",
        autoCreateTask: true,
      },
    );
    assert.equal(fbRes.status, 201);
    assert.ok(fbRes.data.generatedTaskId, "feedback should auto-create Kanban task");

    // Verify both PM Epic and Feedback Task exist in TaskPlanning Kanban
    const kanbanRes = await jsonReq<{
      todo: Array<{ id: string; title: string }>;
    }>(app, cookie, "GET", "/api/opc/planning/kanban?project=PageLens");
    assert.equal(kanbanRes.status, 200);
    const todoIds = new Set(kanbanRes.data.todo.map((t) => t.id));
    assert.ok(todoIds.has(pmRes.data.epicTaskId!), "PM Epic should appear in Kanban todo");
    assert.ok(todoIds.has(fbRes.data.generatedTaskId!), "Feedback task should appear in Kanban todo");

    // 7. Record Human Pomodoro + Register Dark Factory Agent + Dispatch Kanban Task -> Verify live sync back to Kanban
    const pomRes = await jsonReq<{ task: { pomodoroCount: number; energyLevel: string } }>(
      app,
      cookie,
      "POST",
      `/api/opc/planning/tasks/${promotedTaskId}/pomodoro`,
      { energyLevel: "high", durationMins: 25, note: "完成架构设计" },
    );
    assert.equal(pomRes.status, 201);
    assert.equal(pomRes.data.task.pomodoroCount, 1);

    const agentRes = await jsonReq<{ id: string; name: string }>(app, cookie, "POST", "/api/opc/factory/agents", {
      name: "smoke-runner",
      type: "cli",
      cliCommand: `${process.execPath} -e "console.log('tokens: 1200'); console.log('cost_usd: 0.0120'); console.log('done');"`,
      maxCostPerTask: 1.0,
      maxDurationSecs: 30,
      maxRetries: 3,
      capabilities: ["coding"],
    });
    assert.equal(agentRes.status, 201);

    const dispatchRes = await jsonReq<{ runId: string; task: { status: string } }>(
      app,
      cookie,
      "POST",
      `/api/opc/planning/tasks/${promotedTaskId}/dispatch`,
      { agentId: agentRes.data.id },
    );
    assert.equal(dispatchRes.status, 200);
    assert.ok(dispatchRes.data.runId);

    // Wait briefly for the tiny node -e agent process to finish and sync back to TaskPlanning
    const deadline = Date.now() + 8000;
    let finalRunStatus = "queued";
    while (Date.now() < deadline) {
      const r = await jsonReq<{ status: string; tokenUsed: number; costUsd: number }>(
        app,
        cookie,
        "GET",
        `/api/opc/factory/runs/${dispatchRes.data.runId}`,
      );
      finalRunStatus = r.data.status;
      if (["completed", "no_output", "failed", "pr_open"].includes(finalRunStatus)) break;
      await new Promise((res) => setTimeout(res, 80));
    }
    assert.equal(finalRunStatus, "completed");

    const syncedTask = await jsonReq<{ status: string; tokenUsed: number; costUsd: number }>(
      app,
      cookie,
      "GET",
      `/api/opc/planning/tasks/${promotedTaskId}`,
    );
    assert.equal(syncedTask.data.status, "review");
    assert.equal(syncedTask.data.tokenUsed, 1200);
    assert.ok(syncedTask.data.costUsd > 0);

    // 8. Payments (Sandbox Pay) + ROI Dashboard integrates Human + Agent Cost + Paid Revenue
    const orderRes = await jsonReq<{ id: string; outTradeNo: string }>(
      app,
      cookie,
      "POST",
      "/api/opc/metabolism/payments/orders",
      { project: "PageLens", subject: "PageLens Pro Buyout", amount: 29, currency: "USD", channel: "lemonsqueezy" },
    );
    assert.equal(orderRes.status, 201);
    const paidRes = await jsonReq<{ status: string }>(
      app,
      cookie,
      "POST",
      `/api/opc/metabolism/payments/${orderRes.data.id}/sandbox-pay`,
    );
    assert.equal(paidRes.status, 200);
    assert.equal(paidRes.data.status, "paid");

    const roiRes = await jsonReq<{
      human: { totalPomodoros: number };
      agents: { totalRuns: number; totalTokensUsed: number };
      epicRoi: Array<{ project: string; revenueUsd: number }>;
    }>(app, cookie, "GET", "/api/opc/planning/roi");
    assert.equal(roiRes.status, 200);
    assert.ok(roiRes.data.human.totalPomodoros >= 1);
    assert.ok(roiRes.data.agents.totalRuns >= 1);
    assert.ok(roiRes.data.agents.totalTokensUsed >= 1200);
    assert.ok(
      roiRes.data.epicRoi.some((e) => e.project === "PageLens" && e.revenueUsd >= 29),
      `ROI should reflect paid PageLens revenue, got ${JSON.stringify(roiRes.data.epicRoi)}`,
    );

    // 9. Archive Canvas Node to Tombstone -> verify persisted into Company Knowledge Notes
    const tombRes = await jsonReq<{ tombstone: { id: string }; companyNoteId?: string }>(
      app,
      cookie,
      "POST",
      `/api/opc/canvases/${c1.data.id}/archive-tombstone`,
      { nodeIds: [note1.data.id], title: "PageLens 变现架构结案" },
    );
    assert.ok(tombRes.status === 200 || tombRes.status === 201);
    assert.ok(tombRes.data.tombstone.id);

    const companyRes = await jsonReq<{ information: Array<{ title: string }> }>(app, cookie, "GET", "/api/zoom/company");
    assert.equal(companyRes.status, 200);
    assert.ok(companyRes.data.information.some((n) => n.title.includes("PageLens 变现架构结案")));

    // 10. Commercial 3-Month Loss Heatmap + Kill Switch -> Zoom Alert
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      await jsonReq(app, cookie, "POST", "/api/opc/metabolism/commercial-heatmap/costs", {
        project: "LegacyTool",
        month,
        amountUsd: 120,
        category: "infra",
        note: "云主机亏损月费",
      });
    }
    const hmRes = await jsonReq<{
      projects: Array<{ project: string; consecutiveLossMonths: number; killSwitchAlert: boolean }>;
    }>(app, cookie, "GET", "/api/opc/metabolism/commercial-heatmap?months=6");
    assert.equal(hmRes.status, 200);
    const legacy = hmRes.data.projects.find((r) => r.project === "LegacyTool");
    assert.ok(legacy && legacy.consecutiveLossMonths >= 3 && legacy.killSwitchAlert);

    const ksRes = await jsonReq<{ killSwitch: { status: string } }>(
      app,
      cookie,
      "POST",
      "/api/opc/metabolism/kill-switch/LegacyTool/stop",
      { reason: "连续 3 个月亏损触发 ROI 熔断停服", notifyZoom: true },
    );
    assert.equal(ksRes.status, 200);
    assert.equal(ksRes.data.killSwitch.status, "stopped");

    // 11. Patrol Guard pushes stale task alert to Zoom Inbox
    const oldDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
    store.db.prepare("UPDATE opc_planning_tasks SET updated_at=? WHERE id=?").run(oldDate, fbRes.data.generatedTaskId);
    const patrolRes = await jsonReq<{ staleCount: number }>(app, cookie, "POST", "/api/opc/planning/patrol", {
      staleDays: 7,
      notifyZoom: true,
    });
    assert.equal(patrolRes.status, 200);
    assert.ok(patrolRes.data.staleCount >= 1);

    // Verify both Kill Switch and Patrol Guard alerts landed in Zoom Messages
    const zoomMsgs = await jsonReq<{ messages: Array<{ title?: string; taskTitle?: string; source: string }> }>(
      app,
      cookie,
      "GET",
      "/api/zoom/messages",
    );
    assert.equal(zoomMsgs.status, 200);
    assert.ok(zoomMsgs.data.messages.some((m) => m.source.includes("商业熔断卫士")));
    assert.ok(zoomMsgs.data.messages.some((m) => m.source.includes("后台巡检卫士")));
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
