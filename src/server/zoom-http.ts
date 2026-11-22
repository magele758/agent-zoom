import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import type { WorkflowRun } from "../workflow-types.ts";
import type { ExecutiveDepartmentId } from "../executive-bots-types.ts";
import { securityStatus } from "../security-department-types.ts";
import type { Principal, Store } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";
import { readPausedWorkflow, type WorkflowService } from "./workflow/service.ts";
import { channelMessages } from "./zoom-channel.ts";
import { workflowMessages } from "./zoom-workflow.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import { addDelegationRoutes } from "./delegation.ts";
import { ZoomStore } from "./zoom.ts";
import type { HomeRoomBridge } from "./home-room.ts";
import type { OpportunityStore } from "./autonomy.ts";
import { addBusinessRoutes } from "./business.ts";
import { addGrowthRoutes } from "./growth.ts";
import { addProjectProfileRoutes } from "./project-profiles.ts";
import { addCommercialRoutes } from "./commercial.ts";
import { OperationsDepartmentStore, registerOperationsDepartmentRoutes } from "./operations-department.ts";
import { buildOperationsTopology } from "./ops-fleet.ts";
import { readHubResources, registerResourceDepartmentRoutes } from "./resource-department.ts";
import { registerSecurityDepartmentRoutes, SecurityReviews } from "./security-department.ts";
import { registerExecutiveBotRoutes, type ExecutivePulseProvider } from "./executive-bots.ts";
import { registerRoleBotRoutes } from "./role-bots.ts";
import { addProjectRoutes } from "./projects.ts";
import { projectMessages } from "./project-mail.ts";
import { addWorklogRoutes } from "./worklog.ts";
import { addCapabilityRoutes } from "./repo-capabilities.ts";
import { ApiError, PRESENCE_MS } from "./logic.ts";
import { addCompanyLearnRoutes } from "./company-learn.ts";
import { addCompanyRoutes, CompanyStore } from "./company.ts";
import { addStageWorkRoutes } from "./stage-work.ts";
import { addStageHomeRoutes } from "./stage-home.ts";
import { cosineSimilarity, localSemanticVector, registerProvidersRoutes } from "./providers.ts";
import { registerDarkFactoryRoutes } from "./dark-factory.ts";
import { registerTaskPlanningRoutes } from "./task-planning.ts";
import { registerKnowledgeCanvasRoutes } from "./knowledge-canvas.ts";
import { registerMetabolismRoutes, toUsd } from "./metabolism.ts";
import { bootstrapCompanyRuntime, type CompanyRuntime } from "../kernel/bootstrap.ts";

export function addZoomRoutes(app: Hono, store: Store, options: {
  submitToken?: string;
  opportunities: OpportunityStore;
  homeRooms: HomeRoomBridge;
  workflow?: WorkflowService;
  user: (c: Context) => Extract<Principal, { type: "user" }>;
}) {
  const zoom = new ZoomStore(store.db);
  const { requireSubmit } = submitAuth(options.submitToken);
  if (!options.workflow) {
    app.get("/api/workflows/:id", c => {
      options.user(c);
      c.header("Cache-Control", "no-store");
      return c.json(readPausedWorkflow(store.db, c.req.param("id")));
    });
  }
  app.use("/api/zoom/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  addBusinessRoutes(app, store.db, options.submitToken, options.user, options.opportunities);
  addGrowthRoutes(app, store.db, options.submitToken, options.user);
  const projects = addProjectRoutes(app, store.db, options.submitToken, options.user);
  addCompanyLearnRoutes(app, options.user);
  addCompanyRoutes(app, store.db, options.submitToken, options.user, options.opportunities);
  addProjectProfileRoutes(app, store.db, options.submitToken, options.user);
  registerSecurityDepartmentRoutes(app, store.db, options.user);
  registerResourceDepartmentRoutes(app, store.db, options.user);
  const commercial = addCommercialRoutes(app, store.db, options.opportunities, options.submitToken, options.user);
  registerOperationsDepartmentRoutes(app, store.db, options.user, async () => {
    return (await commercial.checkServices()).services;
  });
  const capabilities = addCapabilityRoutes(app,store.db,options.opportunities,options.submitToken,options.user);
  addWorklogRoutes(app, store.db, options.user);
  const work = addStageWorkRoutes(app, store.db, options.submitToken, options.user);
  const home = addStageHomeRoutes(app, store.db, work, options.user);
  function rawMessages(user: Extract<Principal, { type: "user" }>): ZoomMessage[] {
    const workflow = options.workflow?.messages() ?? store.db.prepare("SELECT snapshot FROM workflow_runs ORDER BY created_at DESC").all()
      .flatMap(row => workflowMessages(JSON.parse(String(row.snapshot)) as WorkflowRun));
    const trials = new Map(store.db.prepare("SELECT task_id,id,line_id FROM opc_trials").all()
      .map(row => [String(row.task_id), {lineId:String(row.line_id),trialId:String(row.id)}]));
    const capabilityTasks = new Map(store.db.prepare("SELECT id,task_id FROM opc_capability_requests WHERE task_id IS NOT NULL").all()
      .map(row => [String(row.task_id),String(row.id)]));
    const requirementVersions = new Map(store.db.prepare("SELECT question_id,revision FROM opc_capability_revisions WHERE question_id IS NOT NULL").all()
      .map(row => [String(row.question_id),Number(row.revision)]));
    const native = zoom.messages().map(message => {
      const id = capabilityTasks.get(message.taskId);
      if (id) return {...message,capabilityRequest:{id,revision:requirementVersions.get(message.replyTo??message.id)}};
      return trials.has(message.taskId) ? {...message,businessTrial:trials.get(message.taskId)} : message;
    });
    return [...native, ...workflow, ...options.homeRooms.zoomMessages(user), ...channelMessages(store, user), ...projectMessages(store.db)];
  }
  options.homeRooms.attachPendingSource(() => rawMessages(store.localUser()));
  app.get("/api/opc/delegations/agents", c => {
    const user = options.user(c);
    c.header("Cache-Control", "no-store");
    const rows = store.db.prepare(`SELECT DISTINCT a.handle,a.runtime,a.last_seen_at FROM agents a
      JOIN local_console l ON l.singleton=1 JOIN rooms lobby ON lobby.id=l.room_id AND lobby.org_id=a.org_id
      JOIN room_members m ON m.principal_type='agent' AND m.principal_id=a.id
      JOIN rooms r ON r.id=m.room_id AND r.archived=0
      JOIN room_members u ON u.room_id=m.room_id AND u.principal_type='user' AND u.principal_id=? AND u.hidden=0
      WHERE a.paused=0 AND a.demo=0 ORDER BY a.handle`).all(user.id);
    return c.json({ agents: rows.map(a => ({handle:String(a.handle),runtime:String(a.runtime),
      online: !!a.last_seen_at && Date.parse(String(a.last_seen_at)) > Date.now()-PRESENCE_MS})) });
  });
  const delegations = addDelegationRoutes(app, store, work, home, options.user, rawMessages, options.homeRooms);
  const opsStore = new OperationsDepartmentStore(store.db);
  const securityReviews = new SecurityReviews(store.db);
  const preview = process.env.KUNLUN_PREVIEW === "1" || process.env.DEMO_MODE === "1";
  const hubQuotaPath = process.env.OPC_HUB_QUOTA_DB ?? join(homedir(), ".agent-hub", "hub.db");
  let companyRef: CompanyRuntime | null = null;
  let pulseCache: { at: number; value: Awaited<ReturnType<ExecutivePulseProvider>> } | null = null;
  const pulseProvider: ExecutivePulseProvider = async () => {
    if (pulseCache && Date.now() - pulseCache.at < 15_000) return pulseCache.value;
    const pendingMsgs = rawMessages(store.localUser()).filter(m => m.pending);
    const comm = await commercial.overview().catch(() => null);
    const probes = comm?.services ?? [];
    const topo = await buildOperationsTopology(opsStore.index().services, probes, {
      selfPort: Number(process.env.PORT ?? 0) || undefined,
      disableHostProbes: preview,
    }).catch(() => null);

    const reviews = securityReviews.index().reviews;
    const openSec = reviews.filter(r => securityStatus(r) !== "passed");
    const changesSec = reviews.filter(r => securityStatus(r) === "changes");

    const projectCount = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM company_projects").get() as { n?: number } | undefined)?.n ?? 0,
    );
    const openOpps = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM opc_opportunities WHERE state IN ('queued','selected')").get() as { n?: number } | undefined)?.n ?? 0,
    );
    const runRows = store.db.prepare("SELECT snapshot FROM workflow_runs").all() as Array<{ snapshot: string }>;
    const activeWorkflows = runRows.filter(row => {
      try {
        const run = JSON.parse(String(row.snapshot)) as WorkflowRun;
        if (run.cleanedAt) return false;
        const done = run.cards.some(
          c => c.status === "reject" || (c.kind === "final" && c.status === "approve"),
        );
        return !done;
      } catch {
        return false;
      }
    }).length;

    const hub = readHubResources(hubQuotaPath);
    const lowQuotaTools = hub.tools.filter(t =>
      t.windows.some(w => typeof w.reportedRemaining === "number" && w.reportedRemaining <= 20),
    );
    const expiredAuthTools = hub.tools.filter(t => t.diagnostic === "auth_expired");
    const monthlyUsd = hub.fees.reduce(
      (sum, f) => sum + (f.paid && typeof f.monthlyUsd === "number" ? f.monthlyUsd : 0),
      0,
    );

    const onlineMachines = topo ? topo.machines.filter(m => m.online).length : 0;
    const totalMachines = topo ? topo.machines.length : 0;
    const relayMachines = topo ? topo.machines.filter(m => m.online && m.connection === "relay").length : 0;
    const healthyServices = topo
      ? topo.deployments.filter(d => d.healthy === true).length
      : probes.filter(s => s.healthy).length;
    const totalServices = topo ? topo.deployments.length : probes.length;
    const unhealthyNames = topo
      ? topo.deployments.filter(d => d.healthy === false).map(d => d.name).slice(0, 3)
      : [];

    const pilotProduct = comm?.pilot.product ?? "PageLens";
    const pilotCompletionPct = comm?.completionPct ?? 0;

    const departmentHighlights: Record<ExecutiveDepartmentId, string[]> = {
      commercial: [
        `1号试点（${pilotProduct}）闭环度 ${pilotCompletionPct}%`,
        comm
          ? `订单 ${comm.metrics.orders} 笔 · 有效授权 ${comm.metrics.activeLicenses} 张 · 候补 ${comm.metrics.waitlistSubscribers} 人 · 待处理工单 ${comm.metrics.openTickets} 件`
          : "商业套件待巡检",
      ],
      rd: [
        `登记项目 ${projectCount} 个 · 研发选题池 ${openOpps} 项 · 活跃工作流 ${activeWorkflows} 条`,
        pendingMsgs.length > 0 ? `当前共有 ${pendingMsgs.length} 项待创始人拍板事项` : "当前无阻塞审批的工作流",
      ],
      operations: [
        totalMachines > 0
          ? `Tailscale 机器 ${onlineMachines}/${totalMachines} 台在线${relayMachines > 0 ? `（${relayMachines} 台经中继）` : "（全直连）"}`
          : "本机拓扑巡检中",
        unhealthyNames.length > 0
          ? `部署服务 ${healthyServices}/${totalServices} 健康，异常：${unhealthyNames.join("、")}`
          : `部署服务 ${healthyServices}/${totalServices} 全部健康运行`,
      ],
      security: [
        openSec.length > 0
          ? `待处理/整改中安全评审 ${openSec.length} 项（需整改 ${changesSec.length} 项）`
          : `安全评审全部绿灯（累计 ${reviews.length} 项）`,
        "公开仓库隐私门禁与插件 MV3 权限持续巡检",
      ],
      resources: [
        monthlyUsd > 0 ? `已登记付费套餐固定订阅约 $${Math.round(monthlyUsd)}/月` : `监测工具 ${hub.tools.length} 个`,
        expiredAuthTools.length > 0
          ? `${expiredAuthTools.map(t => t.name).join("、")} 登录态失效需续期`
          : lowQuotaTools.length > 0
            ? `${lowQuotaTools.map(t => t.name).join("、")} 余量低于 20%`
            : "各主力 AI 套餐余量与登录状态总体充足",
      ],
    };

    const kernelPending = companyRef ? companyRef.kernel.decisions.counts().pending : 0;
    const totalPendingApprovals = pendingMsgs.length + kernelPending;

    const companyPulse = {
      pendingApprovals: totalPendingApprovals,
      onlineMachines,
      totalMachines,
      healthyServices,
      totalServices,
      pilotCompletionPct,
      pilotProduct,
      openSecurityReviews: openSec.length,
    };

    const snapshotText = [
      `待创始人审批：${companyPulse.pendingApprovals} 项`,
      `1号商业试点（${pilotProduct}）：${pilotCompletionPct}%`,
      `基础设施：机器 ${onlineMachines}/${totalMachines} 在线，部署服务 ${healthyServices}/${totalServices} 健康`,
      `安全评审：未关闭 ${openSec.length} 项`,
    ].join(" ｜ ");

    const value = { companyPulse, departmentHighlights, snapshotText };
    pulseCache = { at: Date.now(), value };
    return value;
  };
  const codingAgentsProvider = () => {
    try {
      const rows = store.db
        .prepare("SELECT DISTINCT id, handle, runtime, last_seen_at FROM agents WHERE paused=0 AND demo=0 ORDER BY handle")
        .all() as Array<{ id: string; handle: string; runtime: string; last_seen_at?: string | null }>;
      return rows.map(row => {
        const online = Boolean(row.last_seen_at && Date.parse(String(row.last_seen_at)) > Date.now() - PRESENCE_MS);
        return {
          id: `cli:${row.id}`,
          name: String(row.handle),
          kind: "coding_agent_cli" as const,
          runtime: String(row.runtime || "Coding Agent"),
          status: online ? ("online" as const) : ("offline" as const),
          activeWorkCount: 0,
          completedCount: 0,
          groupName: "Coding-Agent CLI",
        };
      });
    } catch {
      return [];
    }
  };
  registerExecutiveBotRoutes(app, store.db, options.user, { pulseProvider, codingAgentsProvider });
  registerRoleBotRoutes(app, store.db, options.user);

  // ---- Knowledge-to-Business Full Pipeline Wiring (Providers + Dark Factory + Task Planning + Knowledge Canvas + Metabolism) ----
  const providers = registerProvidersRoutes(app, store.db, options.user, options.submitToken);
  const darkFactory = registerDarkFactoryRoutes(app, store.db, providers, options.user, {
    submitToken: options.submitToken,
    hooks: {
      resolveRepoPath: (project) => {
        const direct = options.workflow?.workspaceForProject(project);
        if (direct) return direct;
        return null;
      },
    },
  });
  const taskPlanning = registerTaskPlanningRoutes(app, store.db, providers, options.user, {
    submitToken: options.submitToken,
  });
  const knowledgeCanvas = registerKnowledgeCanvasRoutes(app, store.db, providers, options.user, {
    submitToken: options.submitToken,
  });
  const companyStore = new CompanyStore(store.db);

  const searchCompanyNotesByVector = (queryVector: number[], limit: number) => {
    const notes = store.db
      .prepare("SELECT id, kind, title, body FROM company_notes ORDER BY rowid DESC LIMIT 200")
      .all() as Array<{ id: string; kind: string; title: string; body: string }>;
    const hits: Array<{ id: string; kind: "company_idea"; title: string; snippet: string; href: string; similarity: number }> = [];
    for (const note of notes) {
      const vec = localSemanticVector(`${note.title}\n${note.body}`, queryVector.length);
      const similarity = cosineSimilarity(queryVector, vec);
      if (similarity >= 0.22) {
        hits.push({
          id: note.id,
          kind: "company_idea",
          title: note.title,
          snippet: note.body.slice(0, 160),
          href: `#ideas?idea=${encodeURIComponent(note.id)}`,
          similarity: Math.round(similarity * 1000) / 1000,
        });
      }
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
  };

  const metabolism = registerMetabolismRoutes(app, store.db, providers, options.user, {
    submitToken: options.submitToken,
    hooks: {
      createTaskTree: (input) => {
        const result = taskPlanning.createEpicWithSubtasks({
          project: input.project,
          title: input.title,
          description: input.description,
          priority: input.priority,
          tags: input.tags,
          sourceRef: input.sourceRef,
          subtasks: input.subtasks,
        });
        return { epicId: result.epic.id, subtaskIds: result.subtasks.map((s) => s.id) };
      },
      addOpportunity: (input) => {
        const opp = options.opportunities.add({
          project: input.project,
          sourceId: input.sourceId,
          kind: "feature",
          title: input.title,
          rationale: input.rationale,
          evidence: input.evidence,
          impact: input.impact,
          confidence: input.confidence,
          effort: input.effort,
        });
        return { id: opp.id };
      },
      listCanvases: () => knowledgeCanvas.listCanvases(false).map((c) => ({ id: c.id, name: c.name })),
      projectToCanvas: async (canvasId, items) => {
        const res = await knowledgeCanvas.projectBriefingIsland(canvasId, items);
        return { createdNodes: res.nodes.length, semanticEdges: res.semanticEdges.length };
      },
      findDormantMemories: (vector, _queryText, limit) => {
        const canvasHits = knowledgeCanvas.searchNodesByVector(vector, limit, 0.22).map((m) => ({
          id: m.nodeId,
          kind: "canvas_node" as const,
          title: `${m.canvasName} · ${m.title}`,
          canvasId: m.canvasId,
          href: m.href,
          similarity: m.score,
        }));
        const ideaHits = searchCompanyNotesByVector(vector, limit).map((m) => ({
          id: m.id,
          kind: "company_idea" as const,
          title: m.title,
          href: m.href,
          similarity: m.similarity,
        }));
        return [...canvasHits, ...ideaHits]
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit);
      },
      readAgentCostsByProjectMonth: (months) => {
        const allowed = new Set(months);
        const metrics = darkFactory.getMetrics(365);
        const out: Record<string, Record<string, number>> = {};
        for (const row of metrics.byProjectMonth) {
          if (!allowed.has(row.month)) continue;
          const proj = row.project || "default";
          out[proj] ??= {};
          out[proj][row.month] = (out[proj][row.month] ?? 0) + row.costUsd;
        }
        return out;
      },
      postAlertToZoom: (alert) => {
        const task = zoom.register({
          source: "OPC OS · 商业熔断卫士",
          externalId: alert.externalId,
          folder: alert.folder,
          title: alert.title,
          context: alert.body.slice(0, 4000),
          stage: "revenue",
        });
        const msg = zoom.report(task.id, {
          eventId: `alert/${alert.externalId}/${Date.now()}`,
          kind: "question",
          body: alert.body,
          ...(alert.choices?.length ? { choices: alert.choices } : {}),
        });
        const projectKey = alert.folder.split("/")[0] || alert.externalId.replace(/^kill-switch\//, "");
        if (companyRef) {
          void companyRef.kernel.decisions.propose({
            dedupeKey: `commercial:kill_switch:${projectKey}`,
            domain: "commercial",
            kind: "kill_switch",
            riskLevel: "critical",
            projectOrAssetRef: projectKey,
            title: alert.title,
            backgroundSummary: alert.body,
            whyRecommended: "连续亏损项目默认建议冻结算力派工与预算，避免持续失血；若属战略投入期可明确豁免。",
            options: [
              {
                id: "freeze",
                label: "立即冻结该项目派工与算力准入",
                outcome: "approved",
                handlerKey: "commercial.kill_switch_freeze",
                payload: { project: projectKey },
              },
              {
                id: "exempt",
                label: "调整商业模型后豁免恢复",
                outcome: "rejected",
                handlerKey: "commercial.kill_switch_exempt",
                payload: { project: projectKey },
              },
            ],
            recommendedOptionId: "freeze",
            tags: ["kill-switch", "commercial", projectKey],
          }).catch(() => {});
        }
        return { taskId: task.id, messageId: msg.id };
      },
    },
  });

  // Bidirectional hook wiring across Dark Factory <-> Task Planning <-> Knowledge Canvas <-> Metabolism
  darkFactory.addRunStatusListener((run) => {
    try {
      taskPlanning.syncRunOutcome({
        taskId: run.taskId,
        runId: run.id,
        status: run.status,
        prUrl: run.prUrl,
        tokenUsed: run.tokenUsed,
        costUsd: run.costUsd,
      });
    } catch {
      // Task may have been created ad-hoc outside TaskPlanning.
    }
  });

  taskPlanning.setHooks({
    listAgents: () =>
      darkFactory.listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        capabilities: a.capabilities,
      })),
    dispatchToAgent: async (task, agentId, autoCreatePr) => {
      if (companyRef) {
        const adm = companyRef.kernel.registry.checkAdmission(task.project, {
          isEmergencyBug: task.type === "bug" && task.priority >= 9,
        });
        if (!adm.allowed) {
          throw new ApiError(409, adm.code ?? "admission_blocked", adm.reason ?? "主线或停服准入限制拒绝派工");
        }
      }
      const run = darkFactory.dispatch({
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        project: task.project,
        verifyCommand: task.verifyCommand || undefined,
        agentId,
        autoCreatePr: Boolean(autoCreatePr),
      });
      return { runId: run.id, status: run.status };
    },
    getAgentMetrics: (days) => {
      const m = darkFactory.getMetrics(days);
      const byDay: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
      for (const d of m.byDay) {
        byDay[d.date] = { runs: d.runs, tokens: d.tokenUsed, costUsd: d.costUsd };
      }
      const byProject: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
      for (const pm of m.byProjectMonth) {
        const proj = pm.project || "default";
        const cur = byProject[proj] ?? { runs: 0, tokens: 0, costUsd: 0 };
        cur.runs += pm.runs;
        cur.tokens += pm.tokenUsed;
        cur.costUsd = Math.round((cur.costUsd + pm.costUsd) * 10000) / 10000;
        byProject[proj] = cur;
      }
      return {
        totalRuns: m.totalRuns,
        totalTokensUsed: m.totalTokens,
        totalCostUsd: m.totalCostUsd,
        byDay,
        byProject,
      };
    },
    getProjectRevenueUsd: () => {
      const rev: Record<string, number> = {};
      for (const p of metabolism.listPayments(undefined, 500)) {
        if (p.status !== "paid") continue;
        const proj = p.project || "default";
        rev[proj] = Math.round(((rev[proj] ?? 0) + toUsd(p.amount, p.currency)) * 100) / 100;
      }
      return rev;
    },
    notifyPatrolToZoom: (alerts) => {
      if (!alerts.length) return;
      const day = new Date().toISOString().slice(0, 10);
      const task = zoom.register({
        source: "OPC OS · 后台巡检卫士",
        externalId: `patrol-${day}`,
        folder: "公司/巡检告警",
        title: `巡检发现 ${alerts.length} 项滞留任务`,
        context: alerts.map((a) => `· [${a.project}] ${a.title}（已滞留 ${a.staleDays} 天，状态 ${a.status}）`).join("\n").slice(0, 4000),
      });
      zoom.report(task.id, {
        eventId: `patrol-report-${day}-${Date.now()}`,
        kind: "question",
        body: `后台巡检卫士发现 ${alerts.length} 项滞留未推进任务：\n` +
          alerts.slice(0, 8).map((a) => `- [${a.project}] ${a.title}（${a.staleDays} 天未更新 · ${a.status}）`).join("\n") +
          `\n请前往 #planning?tab=patrol 处置或重新指派。`,
        choices: ["前往任务看板处理", "暂缓一周"],
      });
    },
  });

  knowledgeCanvas.setHooks({
    searchExternalMemory: (queryVector, _queryText, limit) => {
      const ideaHits = searchCompanyNotesByVector(queryVector, limit);
      const briefings = store.db
        .prepare("SELECT id, title, summary, raw_content, embedding FROM opc_daily_briefings ORDER BY created_at DESC LIMIT 120")
        .all() as Array<{ id: string; title: string; summary: string | null; raw_content: string; embedding: string | null }>;
      const briefingHits = [];
      for (const b of briefings) {
        let vec: number[] = [];
        if (b.embedding) {
          try {
            vec = JSON.parse(b.embedding) as number[];
          } catch {
            vec = [];
          }
        }
        if (vec.length !== queryVector.length) {
          vec = localSemanticVector(`${b.title}\n${b.summary ?? b.raw_content}`, queryVector.length);
        }
        const sim = cosineSimilarity(queryVector, vec);
        if (sim >= 0.22) {
          briefingHits.push({
            id: b.id,
            kind: "briefing" as const,
            title: b.title || (b.summary ?? b.raw_content).slice(0, 60),
            snippet: (b.summary ?? b.raw_content).slice(0, 160),
            href: `#metabolism?briefing=${encodeURIComponent(b.id)}`,
            similarity: Math.round(sim * 1000) / 1000,
          });
        }
      }
      return [...ideaHits, ...briefingHits]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    },
    createTaskFromNode: (input) => {
      const created = taskPlanning.createTask({
        project: input.project || "default",
        title: input.title,
        description: input.description,
        type: "task",
        priority: 6,
        sourceRef: input.sourceRef,
      });
      return { id: created.id, status: created.status, priority: created.priority };
    },
    getTaskSummary: (taskId) => {
      try {
        const t = taskPlanning.getTask(taskId);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          assigneeType: t.assigneeType,
          prUrl: t.prUrl,
        };
      } catch {
        return null;
      }
    },
    archiveToCompanyNote: (input) => {
      const id = randomUUID();
      companyStore.addNote("research", {
        id,
        title: input.title.slice(0, 180),
        body: input.markdown.slice(0, 5000),
        reference: input.reference.slice(0, 1500),
      });
      return { id };
    },
  });
  const company = bootstrapCompanyRuntime({
    db: store.db,
    app,
    requireUser: options.user,
    darkFactory,
    taskPlanning,
    commercialHub: commercial,
    submitToken: options.submitToken,
    hubQuotaPath,
  });
  companyRef = company;

  app.get("/api/zoom/messages", c => {
    const messages = delegations.decorate(rawMessages(options.user(c)))
      .sort((a, b) => Number(b.pending) - Number(a.pending) || b.at.localeCompare(a.at));
    const projectFolders = store.db.prepare("SELECT product, name FROM company_projects ORDER BY product,name").all()
      .map(row => row.product + "/" + row.name);
    return c.json({
      messages,
      products: projects.names(),
      projectFolders,
      pendingDecisions: company.kernel.decisions.counts().pending,
    });
  });
  app.post("/api/zoom/tasks", async c => {
    requireSubmit(c);
    return c.json(zoom.register(await c.req.json()));
  });
  app.post("/api/zoom/tasks/:id/messages", async c => {
    requireSubmit(c);
    const id = c.req.param("id");
    if (capabilities.task(id)) throw new ApiError(409,"capability_task","请通过原仓需求的修订或审批入口更新本任务");
    const event = await c.req.json();
    return c.json(work.has(id) ? work.report(id,event) : zoom.report(id,event));
  });
  app.get("/api/zoom/tasks/:id/feedback", c => {
    requireSubmit(c);
    return c.json(zoom.feedback(c.req.param("id"), Number(c.req.query("after") ?? "0")));
  });
  app.post("/api/zoom/tasks/:id/replies", async c => {
    const user = options.user(c);
    const id = c.req.param("id");
    const input = await c.req.json();
    if (id.startsWith("home-room:")) return c.json(await options.homeRooms.replyZoom(user, id, input), 202);
    if (capabilities.task(id)) return c.json(capabilities.reply(id, input, user.name));
    return c.json(zoom.reply(id, input, user.name));
  });
  return { delegations, providers, darkFactory, taskPlanning, knowledgeCanvas, metabolism, company };
}
