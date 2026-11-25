import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { ActivityIndex, HerdrMachineInfo, IndexedAgent } from "../activity-index-types.ts";
import type { CliSessionSummary } from "../cli-ledger-types.ts";
import type { WorkflowRun } from "../workflow-types.ts";
import {
  WORKSPACE_CATEGORIES,
  WORKSPACE_CATEGORY_LABELS,
  type WorkOriginTrack,
  type WorkspaceCategory,
} from "../workspace-classification-types.ts";
import type {
  WorkstreamAttentionItem,
  WorkstreamCategoryCount,
  WorkstreamFactoryRun,
  WorkstreamHerdrTree,
  WorkstreamWorkflowItem,
  WorkstreamsOverview,
} from "../workstreams-types.ts";
import type { CliLedgerService } from "./cli-ledger.ts";
import type { DarkFactoryStore } from "./dark-factory.ts";
import type { WorkspaceClassifierStore } from "./workspace-classifier.ts";
import { submitAuth } from "./workflow/http.ts";

const STATE_PRIORITY: Record<IndexedAgent["state"], number> = {
  working: 0,
  waiting: 1,
  recent: 2,
  idle: 3,
  unknown: 4,
};

function bestState(states: IndexedAgent["state"][]): IndexedAgent["state"] {
  let best: IndexedAgent["state"] = "unknown";
  for (const st of states) {
    if (STATE_PRIORITY[st] < STATE_PRIORITY[best]) best = st;
  }
  return best;
}

export function buildHerdrTrees(agents: IndexedAgent[]): {
  trees: WorkstreamHerdrTree[];
  background: IndexedAgent[];
} {
  const herdrAgents = agents.filter((a) => Boolean(a.herdr?.address));
  const byAddr = new Map<string, IndexedAgent>();
  for (const a of herdrAgents) {
    if (a.herdr?.address) byAddr.set(a.herdr.address, a);
  }

  const childrenByParent = new Map<string, IndexedAgent[]>();
  const roots: IndexedAgent[] = [];
  const background: IndexedAgent[] = [];

  for (const a of herdrAgents) {
    const parent = a.herdr?.parent;
    if (parent && byAddr.has(parent)) {
      const list = childrenByParent.get(parent) ?? [];
      list.push(a);
      childrenByParent.set(parent, list);
      continue;
    }
    if (a.herdr?.isBackground) {
      background.push(a);
      continue;
    }
    roots.push(a);
  }

  const trees: WorkstreamHerdrTree[] = roots.map((root) => {
    const addr = root.herdr!.address;
    const subAgents = (childrenByParent.get(addr) ?? []).sort(
      (a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] || a.label.localeCompare(b.label),
    );
    const effectiveState = bestState([root.state, ...subAgents.map((c) => c.state)]);
    const originTrack: WorkOriginTrack =
      root.originTrack === "opc_dispatched" || subAgents.some((c) => c.originTrack === "opc_dispatched")
        ? "opc_dispatched"
        : "founder_managed";

    return {
      id: root.id,
      address: addr,
      provider: root.provider,
      label: root.label,
      title: root.title,
      what: root.what,
      state: root.state,
      effectiveState,
      workspace: root.workspace,
      repository: root.repository,
      spaceName: root.herdr?.spaceName ?? null,
      tabName: root.herdr?.tabName ?? null,
      originTrack,
      originDetail: root.originDetail,
      classification: root.classification,
      linkedSessionId: root.linkedSessionId ?? null,
      linkedTaskId: root.linkedTaskId ?? null,
      linkedTaskTitle: root.linkedTaskTitle ?? null,
      linkedTaskStatus: root.linkedTaskStatus ?? null,
      subAgents,
    };
  });

  trees.sort(
    (a, b) =>
      STATE_PRIORITY[a.effectiveState] - STATE_PRIORITY[b.effectiveState] ||
      (a.classification?.canonicalProject ?? "").localeCompare(b.classification?.canonicalProject ?? "") ||
      a.address.localeCompare(b.address),
  );

  return { trees, background };
}

const RECENT_CLI_ATTENTION_MS = 12 * 60 * 60 * 1000;

export function buildAttentionItems(params: {
  localAgents: IndexedAgent[];
  remoteAgents?: IndexedAgent[];
  cliSessions: CliSessionSummary[];
  nowMs?: number;
}): WorkstreamAttentionItem[] {
  const nowMs = params.nowMs ?? Date.now();
  const items: WorkstreamAttentionItem[] = [];
  const seenHerdr = new Set<string>();
  const seenSessions = new Set<string>();

  const allHerdr = [...params.localAgents, ...(params.remoteAgents ?? [])].filter((a) => Boolean(a.herdr?.address));
  for (const agent of allHerdr) {
    const rawStatus = agent.herdr?.rawStatus ?? null;
    const isBlocked = rawStatus === "blocked";
    const needsAttention = isBlocked || rawStatus === "waiting" || agent.state === "waiting";
    if (!needsAttention) continue;
    const addr = agent.herdr!.address;
    seenHerdr.add(addr);
    if (agent.linkedSessionId) seenSessions.add(agent.linkedSessionId);
    items.push({
      id: `herdr:${addr}`,
      source: "herdr",
      severity: isBlocked ? "blocked" : "waiting",
      provider: agent.provider,
      title: agent.title || agent.label,
      snippet:
        agent.what ||
        (isBlocked
          ? "终端处于权限/交互阻塞态，请切到 Herdr 亲自确认"
          : "终端正在等待你的回复或下一步指示"),
      project: agent.classification?.canonicalProject || agent.herdr?.spaceName || agent.provider,
      originTrack: agent.originTrack ?? "founder_managed",
      classification: agent.classification,
      herdrAddress: addr,
      herdrSpace: agent.herdr?.spaceName ?? null,
      machine: agent.herdr?.machine ?? null,
      isBlockedPermission: isBlocked,
      sessionId: agent.linkedSessionId ?? null,
      linkedTaskId: agent.linkedTaskId ?? null,
      updatedAt: agent.updatedAt,
    });
  }

  for (const s of params.cliSessions) {
    if (s.status !== "waiting_user" && s.status !== "blocked") continue;
    if (seenSessions.has(s.id)) continue;
    if (s.herdrAddress && seenHerdr.has(s.herdrAddress)) continue;
    const ts = s.updatedAt ? Date.parse(s.updatedAt) : Number.NaN;
    if (Number.isFinite(ts) && nowMs - ts > RECENT_CLI_ATTENTION_MS) continue;
    seenSessions.add(s.id);
    if (s.herdrAddress) seenHerdr.add(s.herdrAddress);
    const isBlocked = s.status === "blocked";
    items.push({
      id: `cli:${s.id}`,
      source: "cli_ledger",
      severity: isBlocked ? "blocked" : "waiting",
      provider: s.provider,
      title: s.title || s.firstInstruction?.slice(0, 80) || s.project,
      snippet: s.latestProgress || s.statusReason || null,
      project: s.classification?.canonicalProject || s.project,
      originTrack: s.originTrack ?? "founder_managed",
      classification: s.classification,
      herdrAddress: s.herdrAddress ?? null,
      herdrSpace: s.herdrSpace ?? null,
      machine: s.herdrAddress?.includes("/") ? s.herdrAddress.slice(0, s.herdrAddress.indexOf("/")) : null,
      isBlockedPermission: s.herdrState === "blocked",
      sessionId: s.id,
      linkedTaskId: s.linkedTaskId ?? null,
      updatedAt: s.updatedAt,
    });
  }

  items.sort((a, b) => {
    const sevA = a.severity === "blocked" ? 0 : 1;
    const sevB = b.severity === "blocked" ? 0 : 1;
    if (sevA !== sevB) return sevA - sevB;
    const srcA = a.source === "herdr" ? 0 : 1;
    const srcB = b.source === "herdr" ? 0 : 1;
    if (srcA !== srcB) return srcA - srcB;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id);
  });

  return items;
}

export function registerWorkstreamRoutes(
  app: Hono,
  db: DatabaseSync,
  deps: {
    user: (c: Context) => unknown;
    submitToken?: string;
    getActivityAgents: () => Promise<IndexedAgent[]>;
    getActivitySnapshot?: () => Promise<ActivityIndex | null>;
    cliLedger: CliLedgerService;
    darkFactory: DarkFactoryStore;
    classifier: WorkspaceClassifierStore;
  },
): void {
  const { permits } = submitAuth(deps.submitToken);
  const base = "/api/opc/workstreams" as const;

  app.use(base, async (c, next) => {
    if (!permits(c)) deps.user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get(base, async (c) => {
    const categoryFilter =
      c.req.query("category") &&
      WORKSPACE_CATEGORIES.includes(c.req.query("category") as WorkspaceCategory)
        ? (c.req.query("category") as WorkspaceCategory)
        : null;
    const originFilter =
      c.req.query("origin") === "opc_dispatched" || c.req.query("origin") === "founder_managed"
        ? (c.req.query("origin") as WorkOriginTrack)
        : null;
    const projectFilter = c.req.query("project")?.trim().toLowerCase() || null;

    const snapshot = deps.getActivitySnapshot ? await deps.getActivitySnapshot().catch(() => null) : null;
    const liveAgents = snapshot ? snapshot.agents : await deps.getActivityAgents().catch(() => []);
    const allRemoteTerminals: IndexedAgent[] = snapshot?.remoteAgents ?? [];
    const remoteMachines: HerdrMachineInfo[] = snapshot?.remoteMachines ?? [];
    const { trees: allTrees, background: allBackground } = buildHerdrTrees(liveAgents);

    const cliOverview = deps.cliLedger.getOverview({ days: 3, limit: 60 });
    const representedSessionIds = new Set<string>();
    for (const t of allTrees) {
      if (t.linkedSessionId) representedSessionIds.add(t.linkedSessionId);
      for (const child of t.subAgents) {
        if (child.linkedSessionId) representedSessionIds.add(child.linkedSessionId);
      }
    }

    const allFactoryRuns: WorkstreamFactoryRun[] = deps.darkFactory
      .listRuns({ limit: 30 })
      .filter((r) => r.status === "running" || r.status === "queued" || r.status === "pr_open")
      .map((r) => ({
        id: r.id,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        project: r.project,
        agentName: r.agentName,
        status: r.status,
        executionHost: r.executionHost ?? "subprocess",
        herdrTerminal: r.herdrTerminal ?? null,
        herdrSpace: r.herdrSpace ?? null,
        classification: deps.classifier.classify({
          workspace: r.repoPath ?? r.worktreePath,
          projectHint: r.project,
          skipFs: true,
        }),
        updatedAt: r.updatedAt,
      }));

    const allActiveWorkflows: WorkstreamWorkflowItem[] = [];
    try {
      const rows = db
        .prepare("SELECT snapshot FROM workflow_runs ORDER BY created_at DESC LIMIT 30")
        .all() as Array<{ snapshot: string }>;
      for (const row of rows) {
        const run = JSON.parse(String(row.snapshot)) as WorkflowRun;
        if (run.cleanedAt) continue;
        const closed = run.cards.some(
          (card) => card.status === "reject" || (card.kind === "final" && card.status === "approve"),
        );
        if (closed) continue;
        allActiveWorkflows.push({
          id: run.id,
          goal: run.request.goal,
          folder: run.request.folder || "未归类",
          source: run.request.source || "OPC OS",
          backend: run.backend || "herdr",
          workspace: run.workspace,
          classification: deps.classifier.classify({
            workspace: run.workspace,
            projectHint: run.request.folder,
            skipFs: true,
          }),
          updatedAt: run.events.at(-1)?.at ?? run.createdAt,
        });
      }
    } catch {
      // Ignore workflow_runs query error on minimal DB
    }

    const matchFilters = (item: {
      originTrack?: WorkOriginTrack;
      category?: WorkspaceCategory;
      project?: string | null;
    }) => {
      if (originFilter && (item.originTrack ?? "founder_managed") !== originFilter) return false;
      if (categoryFilter && (item.category ?? "personal") !== categoryFilter) return false;
      if (projectFilter && (item.project ?? "").toLowerCase() !== projectFilter) return false;
      return true;
    };

    const herdrTrees = allTrees.filter((t) =>
      matchFilters({
        originTrack: t.originTrack,
        category: t.classification?.category,
        project: t.classification?.canonicalProject ?? t.spaceName,
      }),
    );

    const backgroundTerminals = allBackground.filter((b) =>
      matchFilters({
        originTrack: b.originTrack,
        category: b.classification?.category,
        project: b.classification?.canonicalProject,
      }),
    );

    const remoteTerminals = allRemoteTerminals.filter((r) =>
      matchFilters({
        originTrack: r.originTrack,
        category: r.classification?.category,
        project: r.classification?.canonicalProject ?? r.herdr?.spaceName,
      }),
    );

    const attentionItems = buildAttentionItems({
      localAgents: liveAgents,
      remoteAgents: allRemoteTerminals,
      cliSessions: cliOverview.sessions,
    })
      .filter((item) =>
        matchFilters({
          originTrack: item.originTrack,
          category: item.classification?.category,
          project: item.project,
        }),
      )
      .slice(0, 20);

    const recentCliSessions = cliOverview.sessions
      .filter((s) => !representedSessionIds.has(s.id) && (s.status === "running" || s.status === "waiting_user" || s.status === "blocked"))
      .filter((s) =>
        matchFilters({
          originTrack: s.originTrack,
          category: s.classification?.category,
          project: s.project,
        }),
      )
      .slice(0, 20);

    const activeFactoryRuns = allFactoryRuns.filter((r) =>
      matchFilters({
        originTrack: "opc_dispatched",
        category: r.classification?.category,
        project: r.classification?.canonicalProject ?? r.project,
      }),
    );

    const activeWorkflows = allActiveWorkflows.filter((w) =>
      matchFilters({
        originTrack: "opc_dispatched",
        category: w.classification?.category,
        project: w.classification?.canonicalProject ?? w.folder,
      }),
    );

    const catMap = new Map<WorkspaceCategory, WorkstreamCategoryCount>(
      WORKSPACE_CATEGORIES.map((cat) => [
        cat,
        {
          category: cat,
          categoryLabel: WORKSPACE_CATEGORY_LABELS[cat],
          active: 0,
          opcDispatched: 0,
          founderManaged: 0,
        },
      ]),
    );

    let opcDispatched = 0;
    let founderManaged = 0;
    let workingCount = 0;
    let waitingCount = 0;

    for (const t of herdrTrees) {
      const cat = t.classification?.category ?? "personal";
      const bucket = catMap.get(cat)!;
      bucket.active += 1;
      if (t.originTrack === "opc_dispatched") {
        opcDispatched += 1;
        bucket.opcDispatched += 1;
      } else {
        founderManaged += 1;
        bucket.founderManaged += 1;
      }
      if (t.effectiveState === "working") workingCount += 1;
      if (t.effectiveState === "waiting") waitingCount += 1;
    }

    for (const r of activeFactoryRuns) {
      if (r.herdrTerminal && herdrTrees.some((t) => t.address === r.herdrTerminal)) continue;
      const cat = r.classification?.category ?? "personal";
      const bucket = catMap.get(cat)!;
      bucket.active += 1;
      opcDispatched += 1;
      bucket.opcDispatched += 1;
      if (r.status === "running") workingCount += 1;
    }

    const payload: WorkstreamsOverview = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalActive: opcDispatched + founderManaged,
        opcDispatched,
        founderManaged,
        workingCount,
        waitingCount,
        backgroundCount: backgroundTerminals.length,
        attentionCount: attentionItems.length,
        remoteCount: remoteTerminals.length,
        byCategory: [...catMap.values()],
      },
      herdrTrees,
      backgroundTerminals,
      remoteTerminals,
      remoteMachines,
      attentionItems,
      recentCliSessions,
      activeFactoryRuns,
      activeWorkflows,
    };

    return c.json(payload);
  });
}
