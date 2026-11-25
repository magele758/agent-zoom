import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, relative, sep } from "node:path";
import type { ActivityIndex, AgentIndex, IndexedAgent, IndexSource, RepoIndex } from "../activity-index-types.ts";
import type { CliSessionSummary } from "../cli-ledger-types.ts";
import type { WorkspaceClassification } from "../workspace-classification-types.ts";
import { readGithubRepository } from "../../scripts/zoom-github.mjs";
import { ProjectStore } from "./projects.ts";
import { ApiError } from "./logic.ts";
import {
  addLocalCheckouts,
  createRepoIndex,
  readWorkspaceCheckouts,
  REPO_INDEX_INTERVAL_MS,
} from "./company-repos-index.ts";
import { readAgentIndex } from "./company-agents-index.ts";
import { repoContent, searchRepo } from "./company-repo-content.ts";
import type { WorkspaceClassifierStore } from "./workspace-classifier.ts";

export interface ActivityIndexEnrichers {
  classifier?: WorkspaceClassifierStore;
  getCliSessions?: () => CliSessionSummary[];
  findLinkedTask?: (input: { sessionId?: string | null; herdrAddress?: string | null }) => {
    id: string;
    title: string;
    status: string;
  } | null;
}

function normProviderFamily(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.includes("antigravity") || s === "agy") return "antigravity";
  if (s.includes("grok")) return "grok";
  if (s.includes("codex")) return "codex";
  if (s.includes("claude")) return "claude";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("opencode")) return "opencode";
  return s;
}

function stripSpinnerPrefix(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏π📜\s]+/u, "")
    .replace(/^(?:-\s*)?(?:Thinking|Compacting|Waiting|Writing[^-]*|Reading[^-]*|Running[^-]*|Wait[^-]*)\s*-\s*/i, "")
    .replace(/[…\.]+$/g, "")
    .trim()
    .toLowerCase();
}

function enrichAgentsWithCliAndClassifier(
  agents: IndexedAgent[],
  enrichers: ActivityIndexEnrichers,
): IndexedAgent[] {
  const cliSessions = (() => {
    try {
      return enrichers.getCliSessions?.() ?? [];
    } catch {
      return [];
    }
  })();

  const usedSessionIds = new Set<string>();
  const matchCliSession = (agent: IndexedAgent): CliSessionSummary | null => {
    if (!cliSessions.length) return null;
    // 1. Direct Herdr address match (already linked by CliLedger!)
    const addr = agent.herdr?.address;
    if (addr) {
      const direct = cliSessions.find((s) => s.herdrAddress === addr && !usedSessionIds.has(s.id));
      if (direct) {
        usedSessionIds.add(direct.id);
        return direct;
      }
    }
    // 2. Fallback: match by provider + title overlap or workspace recency
    const family = normProviderFamily(agent.provider);
    const cleanedTitle = stripSpinnerPrefix(agent.title);
    let best: CliSessionSummary | null = null;
    let bestScore = 0;
    for (const s of cliSessions) {
      if (usedSessionIds.has(s.id)) continue;
      if (s.providerId !== family) continue;
      let score = 0;
      const sTitle = (s.title || s.firstInstruction || "").trim().toLowerCase();
      if (cleanedTitle.length >= 6 && sTitle) {
        if (sTitle.includes(cleanedTitle) || cleanedTitle.includes(sTitle.slice(0, 18))) {
          score += 100;
        }
      }
      if (agent.workspace && (s.rawWorkspace === agent.workspace || s.workspace === agent.workspace)) {
        score += 40;
      } else if (
        agent.herdr?.spaceName &&
        s.project.toLowerCase() === agent.herdr.spaceName.toLowerCase()
      ) {
        score += 20;
      }
      if (score === 0) continue;
      if (s.status === "running" || s.status === "waiting_user") score += 10;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best) usedSessionIds.add(best.id);
    return best;
  };

  return agents.map((agent) => {
    const matched = matchCliSession(agent);
    const nextTitle = agent.title || matched?.title || null;
    const nextWhat = agent.what || (matched?.latestProgress && matched.latestProgress !== nextTitle ? matched.latestProgress : null);
    const linkedSessionId = matched?.id ?? agent.linkedSessionId ?? null;
    const effectiveWorkspace = agent.workspace ?? matched?.workspace ?? null;
    const effectiveRepo = agent.repository ?? matched?.repository ?? null;

    let classification: WorkspaceClassification | undefined = agent.classification;
    if (enrichers.classifier) {
      classification = enrichers.classifier.classify({
        workspace: effectiveWorkspace,
        repository: effectiveRepo,
        projectHint: matched?.project ?? null,
        spaceName: agent.herdr?.spaceName ?? null,
      });
    }

    const linkedTask = enrichers.findLinkedTask?.({
      sessionId: linkedSessionId,
      herdrAddress: agent.herdr?.address ?? null,
    });

    return {
      ...agent,
      title: nextTitle,
      what: nextWhat,
      linkedSessionId,
      ...(classification ? { classification } : {}),
      ...(matched?.originTrack && agent.originTrack !== "opc_dispatched"
        ? { originTrack: matched.originTrack, originDetail: matched.originDetail ?? agent.originDetail }
        : {}),
      linkedTaskId: linkedTask?.id ?? matched?.linkedTaskId ?? agent.linkedTaskId ?? null,
      linkedTaskTitle: linkedTask?.title ?? matched?.linkedTaskTitle ?? agent.linkedTaskTitle ?? null,
      linkedTaskStatus: linkedTask?.status ?? matched?.linkedTaskStatus ?? agent.linkedTaskStatus ?? null,
    };
  });
}

export const repositoryInterval = REPO_INDEX_INTERVAL_MS;
const inactive: IndexSource = {
  name: "本机索引",
  status: "unavailable",
  asOf: null,
  detail: "此实例未启用本机索引。",
};
const under = (path: string, folder: string) => {
  const rel = relative(folder, path);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
};
export function joinActivity(
  agents: AgentIndex,
  repos: RepoIndex,
  maintenance: IndexSource,
  workspaceRoots: Record<string, string> = {},
): ActivityIndex {
  const roots = repos.repositories
    .flatMap((repo) => repo.paths.map((path) => ({ path, repo })))
    .sort((a, b) => b.path.length - a.path.length);
  return {
    agents: agents.agents.map((a) => {
      if (a.repository || !a.workspace) return a;
      const cwd = workspaceRoots[a.workspace] ?? a.workspace;
      const match = roots.find((r) => under(cwd, r.path));
      return match ? { ...a, repository: match.repo.fullName } : a;
    }),
    repositories: repos.repositories,
    sources: [...agents.sources, ...repos.sources, maintenance],
  };
}

export function addActivityIndex(app: Hono, db: DatabaseSync, people: (c: Context) => unknown, enabled: boolean) {
  const base = "/api/opc/activity-index";
  const projects = new ProjectStore(db);
  const repos = enabled ? createRepoIndex(db) : null;
  let enrichers: ActivityIndexEnrichers = {};
  type LiveIndex = { agents: AgentIndex; checkouts: Awaited<ReturnType<typeof readWorkspaceCheckouts>> };
  const AGENT_FRESH_MS = 30_000;
  const CHECKOUT_CACHE_MS = 5 * 60 * 1000;
  let agentCache: { at: number; data: LiveIndex } | undefined;
  let checkoutCache: { key: string; at: number; data: LiveIndex["checkouts"] } | undefined;
  let fetchingAgents: Promise<LiveIndex> | undefined;
  let lastActivity: { at: number; data: ActivityIndex } | undefined;
  let refreshingSnapshot: Promise<ActivityIndex> | undefined;
  let maintain: IndexSource = {
    name: "已纳管仓库维护动态",
    status: "refreshing",
    asOf: null,
    detail: "等待首次检查。",
  };
  let maintaining: Promise<void> | undefined;
  let maintenanceChecked = 0;
  function updateMaintenance(force = false) {
    if (!enabled || (!force && Date.now() - maintenanceChecked < repositoryInterval))
      return maintaining ?? Promise.resolve();
    if (maintaining) return maintaining;
    maintain = { ...maintain, status: "refreshing", detail: "正在检查已纳管仓库的 Issue、PR 和 Release。" };
    maintaining = (async () => {
      const scope = projects
        .list()
        .projects.flatMap((p) => p.repositories.map((r) => ({ product: p.name, repo: r.fullName })));
      let ok = 0;
      const failures: string[] = [];
      // Bound concurrent gh subprocesses independently of the number of enrolled projects.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, scope.length) }, async () => {
          while (next < scope.length) {
            const { product, repo } = scope[next++];
            try {
              projects.sync({ name: product, repository: await readGithubRepository(repo) });
              ok++;
            } catch {
              failures.push(repo);
            }
          }
        }),
      );
      maintain = {
        name: "已纳管仓库维护动态",
        status: failures.length ? "partial" : "ok",
        asOf: new Date().toISOString(),
        detail:
          `每 15 分钟检查。已更新 ${ok}/${scope.length} 座仓库。` +
          (failures.length ? " 保留上次快照：" + failures.join("、") : ""),
      };
    })().finally(() => {
      maintenanceChecked = Date.now();
      maintaining = undefined;
    });
    return maintaining;
  }
  function fetchAgents(force: boolean): Promise<LiveIndex> {
    if (fetchingAgents) return fetchingAgents;
    fetchingAgents = readAgentIndex()
      .catch(() => ({
        agents: [],
        localWorkspaces: [],
        sources: [
          {
            name: "本机 coding agent",
            status: "unavailable" as const,
            detail: "本次查询失败，活动状态未知。",
            asOf: null,
          },
        ],
      }))
      .then(async (agentsResult) => {
        const wsKey = JSON.stringify([...new Set(agentsResult.localWorkspaces)].sort());
        let checkouts: LiveIndex["checkouts"];
        if (!force && checkoutCache && checkoutCache.key === wsKey && Date.now() - checkoutCache.at < CHECKOUT_CACHE_MS) {
          checkouts = checkoutCache.data;
        } else {
          checkouts = await readWorkspaceCheckouts(agentsResult.localWorkspaces);
          checkoutCache = { key: wsKey, at: Date.now(), data: checkouts };
        }
        const result = { agents: agentsResult, checkouts };
        agentCache = { at: Date.now(), data: result };
        return result;
      })
      .finally(() => {
        fetchingAgents = undefined;
      });
    return fetchingAgents;
  }
  function agents(force: boolean): Promise<LiveIndex> {
    if (!force) {
      if (agentCache && Date.now() - agentCache.at < AGENT_FRESH_MS) return Promise.resolve(agentCache.data);
      if (agentCache) {
        void fetchAgents(false).catch(() => {});
        return Promise.resolve(agentCache.data);
      }
    }
    return fetchAgents(force);
  }

  async function compute(force = false, refreshMaintenance = false): Promise<ActivityIndex> {
    if (!repos) return { agents: [], repositories: [], sources: [inactive] };
    // Passive reads trigger stale maintenance sync in the background so Overview/Index never stalls on GitHub latency.
    const maintenanceTask = refreshMaintenance ? updateMaintenance(force) : undefined;
    if (!force) void maintenanceTask?.catch(() => {});
    const [live, origin] = await Promise.all([
      agents(force),
      repos(force),
      force ? maintenanceTask : undefined,
    ]);
    const merged = {
      repositories: addLocalCheckouts(origin.repositories, live.checkouts.rows),
      sources: [...origin.sources, live.checkouts.source],
    };
    const joined = joinActivity(live.agents, merged, maintain, live.checkouts.workspaceRoots);
    lastActivity = { at: Date.now(), data: joined };
    return joined;
  }

  function decorateIndex(raw: ActivityIndex): ActivityIndex {
    if (!enrichers.classifier && !enrichers.getCliSessions && !enrichers.findLinkedTask) {
      return raw;
    }
    const agents = enrichAgentsWithCliAndClassifier(raw.agents, enrichers);
    const repositories = enrichers.classifier
      ? raw.repositories.map((r) => ({
          ...r,
          classification: enrichers.classifier!.classify({
            workspace: r.paths[0] ?? null,
            repository: r.fullName,
            projectHint: r.managed[0]?.project ?? null,
            skipFs: true,
          }),
        }))
      : raw.repositories;
    return { ...raw, agents, repositories };
  }

  async function latest(force = false, refreshMaintenance = false): Promise<ActivityIndex> {
    if (!repos) return { agents: [], repositories: [], sources: [inactive] };
    if (!force && lastActivity) {
      // Stale-while-revalidate: serve RAM snapshot immediately (<2ms) and refresh silently if aged > 30s.
      if (Date.now() - lastActivity.at >= AGENT_FRESH_MS && !refreshingSnapshot) {
        refreshingSnapshot = compute(false, refreshMaintenance)
          .catch(() => lastActivity!.data)
          .finally(() => { refreshingSnapshot = undefined; });
      }
      return decorateIndex(lastActivity.data);
    }
    if (!force && refreshingSnapshot) return decorateIndex(await refreshingSnapshot);
    const task = compute(force, refreshMaintenance).finally(() => {
      if (refreshingSnapshot === task) refreshingSnapshot = undefined;
    });
    refreshingSnapshot = task;
    return decorateIndex(await task);
  }

  async function repository(name: string | undefined) {
    if (!repos || !name || name.length > 4096) throw new ApiError(404, "unknown_repo", "没有索引到该仓库。");
    const item = (await latest()).repositories.find((r) => r.fullName === name);
    if (!item) throw new ApiError(404, "unknown_repo", "当前身份的索引没有这座仓库。");
    return item;
  }
  app.use(base + "/*", async (c, next) => {
    people(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(base, async (c) => {
    people(c);
    c.header("Cache-Control", "no-store");
    return c.json(await latest(false, true));
  });
  app.post(base + "/refresh", async (c) => c.json(await latest(true, true)));
  app.get(base + "/content", async (c) => c.json(await repoContent(await repository(c.req.query("repo")))));
  app.get(base + "/search", async (c) =>
    c.json(await searchRepo(await repository(c.req.query("repo")), c.req.query("q") ?? "")),
  );
  return {
    setEnrichers: (next: ActivityIndexEnrichers) => {
      enrichers = { ...enrichers, ...next };
    },
    getCachedAgents: (): IndexedAgent[] => {
      if (!enabled) return [];
      if (!agentCache || Date.now() - agentCache.at >= AGENT_FRESH_MS) {
        void fetchAgents(false).catch(() => {});
      }
      return agentCache?.data.agents.agents ?? lastActivity?.data.agents ?? [];
    },
    getCachedSnapshot: (): ActivityIndex | null => {
      if (!lastActivity) return null;
      return decorateIndex(lastActivity.data);
    },
    sync: async () => {
      if (!repos) return;
      if (!lastActivity) {
        try {
          const localRow = db
            .prepare("SELECT at, payload FROM opc_repo_inventory_snapshots WHERE source='local'")
            .get() as { at?: string; payload?: string } | undefined;
          if (localRow?.payload) {
            const parsed = JSON.parse(localRow.payload) as { rows?: { fullName: string; paths: string[] }[] };
            const seededRepos = addLocalCheckouts([], parsed.rows ?? []);
            if (seededRepos.length > 0) {
              lastActivity = {
                at: 0,
                data: {
                  agents: [],
                  repositories: seededRepos,
                  sources: [
                    { name: "本机索引", status: "refreshing", asOf: localRow.at ?? null, detail: "服务刚启动，正在后台刷新实时会话与最新仓库快照。" },
                  ],
                },
              };
            }
          }
        } catch {
          // Ignore cold-boot seed failures.
        }
      }
      await Promise.all([compute(true, false), updateMaintenance(true)]);
    },
  };
}
