import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { IndexedAgent } from "../activity-index-types.ts";
import type { WorkflowRun } from "../workflow-types.ts";
import {
  WORKSPACE_CATEGORIES,
  WORKSPACE_CATEGORY_LABELS,
  type WorkOriginTrack,
  type WorkspaceCategory,
} from "../workspace-classification-types.ts";
import type {
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

export function registerWorkstreamRoutes(
  app: Hono,
  db: DatabaseSync,
  deps: {
    user: (c: Context) => unknown;
    submitToken?: string;
    getActivityAgents: () => Promise<IndexedAgent[]>;
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

    const liveAgents = await deps.getActivityAgents().catch(() => []);
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
        byCategory: [...catMap.values()],
      },
      herdrTrees,
      backgroundTerminals,
      recentCliSessions,
      activeFactoryRuns,
      activeWorkflows,
    };

    return c.json(payload);
  });
}
