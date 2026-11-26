import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";
import type { RepoContent } from "./activity-index-types.ts";
import { DecisionGateway } from "./kernel/decisions.ts";
import { DomainEventBus } from "./kernel/events.ts";
import { AssetRegistry } from "./kernel/registry.ts";
import { OpportunityStore } from "./server/autonomy.ts";
import { ApiError } from "./server/logic.ts";
import {
  addRepoEvolutionRoutes,
  BUILTIN_REPO_DOMAINS,
  computePoolBucket,
  computeRepoVitality,
  createRepoEvolutionPool,
  matchesSpotlightRepo,
  normalizeVectorToDim,
  parsePgVectorLiteral,
  REPO_EVOLUTION_VECTOR_DIM,
  RepoEvolutionService,
  toPgVectorLiteral,
  type GitHubEvolutionFetcher,
  type GitHubRepoSnapshot,
  type PgPoolLike,
} from "./server/repo-evolution.ts";

const FIXED_NOW = Date.parse("2026-11-26T12:00:00.000Z");

function monthsAgoIso(months: number): string {
  return new Date(FIXED_NOW - months * 30.4375 * 24 * 60 * 60 * 1000).toISOString();
}

function makeMockGithubFetcher(): {
  fetcher: GitHubEvolutionFetcher;
  ownedRepos: GitHubRepoSnapshot[];
  starredRepos: GitHubRepoSnapshot[];
  starLists: Array<{ id: string; name: string; slug: string; description: string; repoFullNames: string[] }>;
  contentCalls: string[];
} {
  const ownedRepos: GitHubRepoSnapshot[] = [
    {
      fullName: "magele758/ai-agent-node",
      url: "https://github.com/magele758/ai-agent-node",
      visibility: "public",
      description: "Autonomous TypeScript AI agent node runtime with MCP tool orchestration, multi-agent workflow planner and memory graph",
      isArchived: false,
      isFork: false,
      starsCount: 128,
      forksCount: 16,
      pushedAt: monthsAgoIso(0.2),
      repoUpdatedAt: monthsAgoIso(0.2),
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
      topics: ["ai-agent", "mcp", "multi-agent", "workflow", "typescript"],
    },
    {
      fullName: "magele758/private-core-engine",
      url: "https://github.com/magele758/private-core-engine",
      visibility: "private",
      description: "Internal private AI agent scheduler, MCP gateway, and pgvector RAG memory engine",
      isArchived: false,
      isFork: false,
      starsCount: 0,
      forksCount: 0,
      pushedAt: monthsAgoIso(0.5),
      repoUpdatedAt: monthsAgoIso(0.5),
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
      topics: ["ai-agent", "pgvector", "rag", "mcp", "scheduler"],
    },
    {
      fullName: "magele758/web-canvas-kit",
      url: "https://github.com/magele758/web-canvas-kit",
      visibility: "public",
      description: "Interactive React SVG graph canvas and diagram workbench for high-density knowledge visualization",
      isArchived: false,
      isFork: false,
      starsCount: 42,
      forksCount: 5,
      pushedAt: monthsAgoIso(1.5),
      repoUpdatedAt: monthsAgoIso(1.5),
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
      topics: ["react", "svg", "canvas", "graph", "visualization"],
    },
  ];

  const starredRepos: GitHubRepoSnapshot[] = [
    {
      fullName: "openorg/multi-agent-orchestrator",
      url: "https://github.com/openorg/multi-agent-orchestrator",
      visibility: "public",
      description: "Production multi-agent AI agent orchestration runtime with MCP tools, swarm routing, and persistent workflow memory",
      isArchived: false,
      isFork: false,
      starsCount: 14200,
      forksCount: 1200,
      pushedAt: monthsAgoIso(0.3),
      repoUpdatedAt: monthsAgoIso(0.3),
      starredAt: "2026-11-25T10:00:00.000Z",
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
      topics: ["ai-agent", "multi-agent", "mcp", "workflow", "orchestrator"],
    },
    {
      fullName: "openorg/mcp-tool-runtime",
      url: "https://github.com/openorg/mcp-tool-runtime",
      visibility: "public",
      description: "Lightweight MCP tool server SDK and agent node sandbox with deterministic schema validation and pgvector memory",
      isArchived: false,
      isFork: false,
      starsCount: 6800,
      forksCount: 490,
      pushedAt: monthsAgoIso(1),
      repoUpdatedAt: monthsAgoIso(1),
      starredAt: "2026-11-24T09:00:00.000Z",
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
      topics: ["mcp", "ai-agent", "sdk", "pgvector", "typescript"],
    },
    {
      fullName: "vizlab/svg-flow-canvas",
      url: "https://github.com/vizlab/svg-flow-canvas",
      visibility: "public",
      description: "High-fps React SVG interactive graph canvas, bezier edge routing and zoomable node diagram engine",
      isArchived: false,
      isFork: false,
      starsCount: 9100,
      forksCount: 620,
      pushedAt: monthsAgoIso(2),
      repoUpdatedAt: monthsAgoIso(2),
      starredAt: "2026-11-20T08:00:00.000Z",
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
      topics: ["react", "svg", "canvas", "graph", "diagram"],
    },
    {
      fullName: "dormantlab/vector-rerank-kit",
      url: "https://github.com/dormantlab/vector-rerank-kit",
      visibility: "public",
      description: "Hybrid BM25 and pgvector RAG retrieval reranking pipeline with semantic memory indexing",
      isArchived: false,
      isFork: false,
      starsCount: 2300,
      forksCount: 180,
      pushedAt: monthsAgoIso(15), // dormant (12..24m)
      repoUpdatedAt: monthsAgoIso(15),
      starredAt: "2026-11-10T08:00:00.000Z",
      defaultBranch: "main",
      primaryLanguage: "Python",
      topics: ["rag", "pgvector", "vector", "retrieval", "rerank"],
    },
    {
      fullName: "oldorg/legacy-agent-2021",
      url: "https://github.com/oldorg/legacy-agent-2021",
      visibility: "public",
      description: "Legacy AI agent workflow MCP orchestrator unmaintained since 2023",
      isArchived: false,
      isFork: false,
      starsCount: 5400,
      forksCount: 800,
      pushedAt: monthsAgoIso(32), // stale (>24m) -> must stay in stale pool, NOT force-linked
      repoUpdatedAt: monthsAgoIso(32),
      starredAt: "2026-10-01T08:00:00.000Z",
      defaultBranch: "master",
      primaryLanguage: "TypeScript",
      topics: ["ai-agent", "mcp", "workflow"],
    },
    {
      fullName: "oldorg/archived-agent-lib",
      url: "https://github.com/oldorg/archived-agent-lib",
      visibility: "public",
      description: "Archived AI agent runtime library",
      isArchived: true, // archived -> must stay in stale pool, NOT force-linked
      isFork: false,
      starsCount: 3100,
      forksCount: 410,
      pushedAt: monthsAgoIso(3),
      repoUpdatedAt: monthsAgoIso(3),
      starredAt: "2026-09-15T08:00:00.000Z",
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
      topics: ["ai-agent", "mcp"],
    },
    {
      fullName: "cooking/sourdough-recipes",
      url: "https://github.com/cooking/sourdough-recipes",
      visibility: "public",
      description: "Artisan sourdough fermentation schedules, hydration calculators and bakery bread formulas",
      isArchived: false,
      isFork: false,
      starsCount: 480,
      forksCount: 55,
      pushedAt: monthsAgoIso(1),
      repoUpdatedAt: monthsAgoIso(1),
      starredAt: "2026-09-01T08:00:00.000Z",
      defaultBranch: "main",
      primaryLanguage: "Markdown",
      topics: ["baking", "bread", "recipes"],
    },
  ];

  const starLists = [
    {
      id: "UL_list_agent_top",
      name: "精选 Agent 底座",
      slug: "featured-agent-bases",
      description: "长期跟踪的高质量 Agent 编排开源项目",
      repoFullNames: ["openorg/multi-agent-orchestrator"],
    },
  ];

  const contentCalls: string[] = [];

  const fetcher: GitHubEvolutionFetcher = {
    async fetchOwnedReposPage(cursor) {
      const pageSize = 2;
      const start = cursor ? Number(cursor) : 0;
      const slice = ownedRepos.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        login: "magele758",
        totalCount: ownedRepos.length,
        hasNextPage: next < ownedRepos.length,
        endCursor: next < ownedRepos.length ? String(next) : null,
        items: slice,
      };
    },
    async fetchStarredReposPage(cursor) {
      const pageSize = 3;
      const start = cursor ? Number(cursor) : 0;
      const slice = starredRepos.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        login: "magele758",
        totalCount: starredRepos.length,
        hasNextPage: next < starredRepos.length,
        endCursor: next < starredRepos.length ? String(next) : null,
        items: slice,
      };
    },
    async fetchStarLists() {
      return starLists;
    },
    async fetchRepoContent(repo): Promise<RepoContent> {
      contentCalls.push(repo.fullName);
      const ref = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      const base = `https://github.com/${repo.fullName}`;
      return {
        fullName: repo.fullName,
        ref,
        source: "Mock GitHub",
        note: "",
        issuesUrl: `${base}/issues`,
        pullsUrl: `${base}/pulls`,
        files: [
          { name: "src", directory: true, url: `${base}/tree/${ref}/src` },
          { name: "packages", directory: true, url: `${base}/tree/${ref}/packages` },
          { name: "package.json", directory: false, url: `${base}/blob/${ref}/package.json` },
          { name: "README.md", directory: false, url: `${base}/blob/${ref}/README.md` },
        ],
        readme: {
          url: `${base}/blob/${ref}/README.md`,
          text: `# ${repo.fullName}\n\n${repo.description}\n\n## Architecture\nModular runtime with clean plugin boundaries.\n`,
          truncated: false,
        },
      };
    },
    async searchRepoContent(repo, term) {
      return {
        source: "Mock Search",
        note: `matched ${term}`,
        items: [
          {
            path: "src/index.ts",
            url: `https://github.com/${repo.fullName}/blob/main/src/index.ts`,
          },
        ],
      };
    },
  };

  return { fetcher, ownedRepos, starredRepos, starLists, contentCalls };
}

// ---- 1. Pure Deterministic Logic Unit Tests ----

describe("repo-evolution pure logic", () => {
  it("classifies vitality across active / dormant / stale / archived thresholds", () => {
    const cfg = { staleMonths: 24, dormantMonths: 12 };
    assert.equal(computeRepoVitality(true, monthsAgoIso(1), cfg, FIXED_NOW), "archived");
    assert.equal(computeRepoVitality(false, null, cfg, FIXED_NOW), "stale");
    assert.equal(computeRepoVitality(false, monthsAgoIso(30), cfg, FIXED_NOW), "stale");
    assert.equal(computeRepoVitality(false, monthsAgoIso(16), cfg, FIXED_NOW), "dormant");
    assert.equal(computeRepoVitality(false, monthsAgoIso(2), cfg, FIXED_NOW), "active");
  });

  it("auto-matches spotlight repos by short name or full slug case-insensitively", () => {
    assert.equal(matchesSpotlightRepo("magele758/ai-agent-node", "ai-agent-node", ["ai-agent-node"]), true);
    assert.equal(matchesSpotlightRepo("MAGELE758/AI-Agent-Node", "AI-Agent-Node", ["ai-agent-node"]), true);
    assert.equal(
      matchesSpotlightRepo("magele758/private-core-engine", "private-core-engine", ["magele758/private-core-engine"]),
      true,
    );
    assert.equal(matchesSpotlightRepo("magele758/other-repo", "other-repo", ["ai-agent-node"]), false);
  });

  it("partitions pool buckets consistently across owned / linked / stale_pool / classified_unlinked / unclassified", () => {
    assert.equal(
      computePoolBucket({ role: "owned", vitality: "active", priorityTier: "spotlight", primaryDomainId: null, activeLinkCount: 0 }),
      "owned",
    );
    assert.equal(
      computePoolBucket({ role: "starred", vitality: "stale", priorityTier: "standard", primaryDomainId: null, activeLinkCount: 1 }),
      "linked",
    );
    assert.equal(
      computePoolBucket({ role: "starred", vitality: "stale", priorityTier: "standard", primaryDomainId: "dom_1", activeLinkCount: 0 }),
      "stale_pool",
    );
    assert.equal(
      computePoolBucket({ role: "starred", vitality: "archived", priorityTier: "standard", primaryDomainId: null, activeLinkCount: 0 }),
      "stale_pool",
    );
    assert.equal(
      computePoolBucket({ role: "starred", vitality: "active", priorityTier: "standard", primaryDomainId: "dom_1", activeLinkCount: 0 }),
      "classified_unlinked",
    );
    assert.equal(
      computePoolBucket({ role: "starred", vitality: "active", priorityTier: "standard", primaryDomainId: null, activeLinkCount: 0 }),
      "unclassified",
    );
  });

  it("projects arbitrary vector dimensions to 256-dim normalized pgvector literals safely", () => {
    const highDim = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 1));
    const projected = normalizeVectorToDim(highDim, REPO_EVOLUTION_VECTOR_DIM);
    assert.equal(projected.length, REPO_EVOLUTION_VECTOR_DIM);
    const norm = Math.sqrt(projected.reduce((acc, v) => acc + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit norm, got ${norm}`);

    const literal = toPgVectorLiteral(highDim);
    const parsed = parsePgVectorLiteral(literal);
    assert.ok(parsed);
    assert.equal(parsed.length, REPO_EVOLUTION_VECTOR_DIM);

    // Zero vector must never produce NaN or zero norm (breaks pgvector cosine <=>)
    const safeZero = normalizeVectorToDim([0, 0, 0], REPO_EVOLUTION_VECTOR_DIM);
    assert.equal(safeZero[0], 1);
  });
});

// ---- 2. Real PostgreSQL 18 + pgvector Integration & Hono HTTP Tests ----

const PG_URL = process.env.OPC_PG_URL || process.env.DATABASE_URL || "postgres://opc:opc_local_pg@127.0.0.1:15433/opc_os";

async function tryCreateIsolatedPgPool(): Promise<{
  adminPool: PgPoolLike;
  pool: PgPoolLike;
  schema: string;
} | null> {
  try {
    const adminPool = await createRepoEvolutionPool(PG_URL, { max: 2 });
    await adminPool.query("SELECT 1");
    const schema = `test_repo_evo_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = await createRepoEvolutionPool(PG_URL, { schema, max: 6 });
    return { adminPool, pool, schema };
  } catch {
    return null;
  }
}

describe("repo-evolution PostgreSQL 18 + pgvector end-to-end", async () => {
  const pgHandle = await tryCreateIsolatedPgPool();
  if (!pgHandle) {
    it("skips real PG18 suite when opc-postgres / pg driver is unreachable", { skip: "PG18 unavailable" }, () => {});
    return;
  }

  let sqliteDb: DatabaseSync;
  let decisions: DecisionGateway;
  let opportunities: OpportunityStore;
  let mockGh: ReturnType<typeof makeMockGithubFetcher>;
  let service: RepoEvolutionService;
  let llmCalls: Array<{ prompt: string; system?: string }> = [];
  let llmMode: "success" | "unconfigured" = "success";

  before(async () => {
    sqliteDb = new DatabaseSync(":memory:");
    sqliteDb.exec("CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY)");
    const events = new DomainEventBus(sqliteDb);
    const registry = new AssetRegistry(sqliteDb, events);
    decisions = new DecisionGateway(sqliteDb, events, registry);
    opportunities = new OpportunityStore(sqliteDb);

    // Ensure GovernancePolicy is full_auto to prove repo_absorption NEVER auto-approves!
    decisions.updatePolicy({ autonomyMode: "full_auto" });

    mockGh = makeMockGithubFetcher();
    service = new RepoEvolutionService({
      pool: pgHandle.pool,
      decisions,
      opportunities,
      github: mockGh.fetcher,
      now: () => FIXED_NOW,
      llmCaller: async (prompt, opts) => {
        llmCalls.push({ prompt, system: opts?.system });
        if (llmMode === "unconfigured") {
          return { ok: false, reason: "LLM API Key 未配置" };
        }
        return {
          ok: true,
          model: "mock-llm",
          text: JSON.stringify({
            rationale: "LLM 结构化分析：源仓的 MCP 路由与状态机可直接强化自有仓编排层。",
            modules: [
              {
                sourceModulePath: "src/orchestrator/router.ts",
                targetModulePath: "src/runtime/mcp-router.ts",
                absorbableMechanism: "基于能力标签的确定性工具分发与并发槽位控制",
                currentGap: "当前工具调用缺少优先级队列与失败熔断",
                adaptationPlan: "在 src/runtime/mcp-router.ts 抽离策略接口并补单测",
                effort: "M",
                risk: "low",
                evidenceLinks: [
                  {
                    label: "openorg/multi-agent-orchestrator:router.ts",
                    url: "https://github.com/openorg/multi-agent-orchestrator/blob/main/src/orchestrator/router.ts",
                    path: "src/orchestrator/router.ts",
                  },
                ],
              },
            ],
          }),
        };
      },
    });
    await service.init();
  });

  after(async () => {
    try {
      sqliteDb?.close();
    } catch {
      // ignore
    }
    try {
      await pgHandle.pool.end?.();
    } catch {
      // ignore
    }
    try {
      await pgHandle.adminPool.query(`DROP SCHEMA IF EXISTS ${pgHandle.schema} CASCADE`);
      await pgHandle.adminPool.end?.();
    } catch {
      // ignore
    }
  });

  it("initializes all 7 PG tables, pgvector HNSW index, seed domains, and default ai-agent-node config", async () => {
    const tablesRes = await pgHandle.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
      [pgHandle.schema],
    );
    const tableNames = tablesRes.rows.map((r) => r.tablename);
    for (const required of [
      "repo_domains",
      "repo_evolution_nodes",
      "repo_evolution_node_domains",
      "repo_absorption_links",
      "repo_absorption_events",
      "repo_evolution_sync_jobs",
      "repo_evolution_config",
    ]) {
      assert.ok(tableNames.includes(required), `missing table ${required}, found: ${tableNames.join(", ")}`);
    }

    const idxRes = await pgHandle.pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_repo_evo_nodes_embedding_hnsw'",
      [pgHandle.schema],
    );
    assert.equal(idxRes.rows.length, 1);
    assert.match(idxRes.rows[0]!.indexdef.toLowerCase(), /using hnsw.*vector_cosine_ops/);

    const domains = await service.listDomainClusters();
    assert.equal(domains.length, BUILTIN_REPO_DOMAINS.length);

    const cfg = await service.getConfig();
    assert.deepEqual(cfg.spotlightRepos, ["ai-agent-node"]);
    assert.equal(cfg.automationMode, "mailbox_review");
    assert.equal(cfg.staleMonths, 24);
    assert.equal(cfg.dormantMonths, 12);
    assert.equal(cfg.allowPrivateLlmByDefault, false);
  });

  it("syncs owned public+private repos, auto-spotlights ai-agent-node, paginates stars, and early-stops on incremental sync", async () => {
    const fullJob = await service.runSyncNow({ mode: "full" });
    assert.equal(fullJob.status, "completed");
    assert.equal(fullJob.phase, "done");
    assert.equal(fullJob.githubLogin, "magele758");
    assert.equal(fullJob.ownedFetched, 3);
    assert.equal(fullJob.starredFetched, 7);
    assert.equal(fullJob.listsFetched, 1);
    assert.ok(fullJob.embeddingsComputed >= 10);

    const spotlightNode = await service.getNode("magele758/ai-agent-node");
    assert.equal(spotlightNode.role, "owned");
    assert.equal(spotlightNode.priorityTier, "spotlight");
    assert.equal(spotlightNode.visibility, "public");
    assert.equal(spotlightNode.allowLlmAnalysis, true);
    assert.equal(spotlightNode.hasEmbedding, true);

    const privateNode = await service.getNode("magele758/private-core-engine");
    assert.equal(privateNode.role, "owned");
    assert.equal(privateNode.visibility, "private");
    assert.equal(privateNode.allowLlmAnalysis, false);

    const staleNode = await service.getNode("oldorg/legacy-agent-2021");
    assert.equal(staleNode.vitality, "stale");
    const archivedNode = await service.getNode("oldorg/archived-agent-lib");
    assert.equal(archivedNode.vitality, "archived");
    const dormantNode = await service.getNode("dormantlab/vector-rerank-kit");
    assert.equal(dormantNode.vitality, "dormant");

    // Star list import should have assigned multi-agent-orchestrator to github_list domain
    const listedStar = await service.getNode("openorg/multi-agent-orchestrator");
    assert.equal(listedStar.domainAssignedBy, "github_list");
    assert.equal(listedStar.primaryDomainName, "精选 Agent 底座");

    // Incremental sync with no newer stars should early-stop after 1 page (3 stars instead of 7)
    const incJob = await service.runSyncNow({ mode: "incremental" });
    assert.equal(incJob.status, "completed");
    assert.equal(incJob.earlyStopped, true);
    assert.equal(incJob.starredFetched, 3);
  });

  it("runs pgvector HNSW clustering & 1-to-N recall while leaving stale/archived/unrelated repos in Floating Pool", async () => {
    const result = await service.clusterAndRecall();
    assert.ok(result.domainsAssigned >= 2, `expected >= 2 domains assigned, got ${result.domainsAssigned}`);
    assert.ok(result.linksSuggested >= 2, `expected >= 2 links suggested, got ${result.linksSuggested}`);
    assert.ok(result.spotlightMatches >= 1, "expected spotlight repo ai-agent-node to receive candidate links");

    // Verify 1-to-N recall: multi-agent-orchestrator should match ai-agent-node (and/or private-core-engine)
    const agentNode = await service.getNode("magele758/ai-agent-node");
    const incomingToSpotlight = await service.listLinks({ targetNodeId: agentNode.id });
    assert.ok(
      incomingToSpotlight.some((l) => l.sourceRepoFullName === "openorg/multi-agent-orchestrator"),
      "ai-agent-node should be fed by openorg/multi-agent-orchestrator",
    );

    // Verify stale, archived, and unrelated repos are NOT force-linked and remain in Floating/Stale Pool!
    for (const floatingName of [
      "oldorg/legacy-agent-2021",
      "oldorg/archived-agent-lib",
      "cooking/sourdough-recipes",
    ]) {
      const detail = await service.getNodeDetail(floatingName);
      assert.equal(detail.outgoingLinks.length, 0, `${floatingName} must NOT be force-linked`);
      assert.ok(
        detail.node.poolBucket === "stale_pool" ||
          detail.node.poolBucket === "unclassified" ||
          detail.node.poolBucket === "classified_unlinked",
        `${floatingName} must remain in floating pool, got ${detail.node.poolBucket}`,
      );
    }

    const macro = await service.getMacroGraph();
    assert.equal(macro.stats.ownedCount, 3);
    assert.equal(macro.stats.ownedPrivateCount, 1);
    assert.equal(macro.stats.spotlightCount, 1);
    assert.equal(macro.stats.starredCount, 7);
    assert.equal(
      macro.stats.unclassifiedCount + macro.stats.classifiedUnlinkedCount + macro.stats.stalePoolCount,
      macro.stats.floatingPoolCount,
      "floating pool partitions must sum cleanly to floatingPoolCount",
    );
    assert.equal(macro.ownedRepos[0]!.fullName, "magele758/ai-agent-node", "spotlight repo must be pinned first");
    assert.ok(macro.macroEdges.length >= 1);
  });

  it("supports 1-to-N bulk linking, focus graph, pagination buckets, batch ops, and domain CRUD/merge", async () => {
    const star = await service.getNode("openorg/multi-agent-orchestrator");
    const owned1 = await service.getNode("magele758/ai-agent-node");
    const owned2 = await service.getNode("magele758/private-core-engine");
    const owned3 = await service.getNode("magele758/web-canvas-kit");

    // 1 Star -> 3 Owned repos simultaneously
    const bulk = await service.bulkLinkTargets(star.id, {
      targetNodeIds: [owned1.id, owned2.id, owned3.id],
      relationType: "architecture_pattern",
      rationale: "多仓同时借鉴其编排与路由思想",
    });
    assert.equal(bulk.links.length, 3);

    // Focus graph on single Star shows 1 -> 3 fan-out
    const focusStar = await service.getFocusGraph({ focusType: "star", focusId: star.id });
    assert.equal(focusStar.starNodes.length, 1);
    assert.equal(focusStar.links.length, 3);
    assert.ok(focusStar.ownedNodes.length >= 3);

    // Focus graph on floating pool shows only unlinked stars
    const focusFloating = await service.getFocusGraph({ focusType: "floating", limit: 60 });
    assert.ok(focusFloating.starNodes.length >= 3);
    assert.ok(focusFloating.starNodes.every((n) => n.activeLinkCount === 0));

    // Nodes pagination & bucket filters
    const stalePage = await service.queryNodes({ bucket: "stale_pool", page: 1, pageSize: 10 });
    assert.ok(stalePage.items.some((n) => n.fullName === "oldorg/legacy-agent-2021"));
    assert.ok(stalePage.items.some((n) => n.fullName === "oldorg/archived-agent-lib"));

    // Custom domain create + batch assign + merge
    const d1 = await service.createDomain({ name: "临时实验域 A", color: "#112233", seedKeywords: ["bread"] });
    const d2 = await service.createDomain({ name: "临时实验域 B", color: "#334455", seedKeywords: ["baking"] });
    const sourdough = await service.getNode("cooking/sourdough-recipes");
    const batchRes = await service.batchUpdateNodes({
      nodeIds: [sourdough.id],
      action: "assign_domain",
      domainId: d1.id,
    });
    assert.equal(batchRes.updatedCount, 1);

    const merged = await service.mergeDomains({ sourceDomainId: d1.id, targetDomainId: d2.id });
    assert.equal(merged.movedNodes, 1);
    const sourdoughAfter = await service.getNode(sourdough.id);
    assert.equal(sourdoughAfter.primaryDomainId, d2.id);

    // Clean up custom domain & reset sourdough back to unclassified
    await service.deleteDomain(d2.id);
    const sourdoughClean = await service.getNode(sourdough.id);
    assert.equal(sourdoughClean.primaryDomainId, null);

    // Manual spotlight registration
    const customOwned = await service.registerOwnedOrSpotlightNode({
      fullName: "magele758/custom-spotlight-tool",
      visibility: "private",
      priorityTier: "spotlight",
      description: "Manually registered spotlight private repo",
    });
    assert.equal(customOwned.priorityTier, "spotlight");
    assert.equal(customOwned.visibility, "private");
    assert.equal(customOwned.allowLlmAnalysis, false);
  });

  it("enforces private-repo LLM privacy gate during Stage 2 module analysis and supports LLM + deterministic fallback", async () => {
    const privateTarget = await service.getNode("magele758/private-core-engine");
    const linksToPrivate = await service.listLinks({ targetNodeId: privateTarget.id });
    assert.ok(linksToPrivate.length >= 1);
    const privLink = linksToPrivate[0]!;

    // 1. Private repo with allowLlmAnalysis=false MUST NOT call external LLM
    llmCalls = [];
    llmMode = "success";
    const blockedRes = await service.analyzeLink(privLink.id, { force: true }, "founder");
    assert.equal(llmCalls.length, 0, "private repo with allowLlmAnalysis=false must NOT leak to remote LLM");
    assert.equal(blockedRes.privacyBlocked, true);
    assert.equal(blockedRes.usedLlm, false);
    assert.equal(blockedRes.link.analysisSource, "deterministic");
    assert.ok(blockedRes.link.moduleAnalysis.length >= 2);
    assert.ok(blockedRes.link.moduleAnalysis[0]!.evidenceLinks.length >= 1);

    // 2. Opt-in allowLlmAnalysis=true allows LLM call and parses structured module JSON
    await service.updateNode(privateTarget.id, { allowLlmAnalysis: true });
    const allowedRes = await service.analyzeLink(privLink.id, { force: true }, "founder");
    assert.equal(llmCalls.length, 1);
    assert.equal(allowedRes.privacyBlocked, false);
    assert.equal(allowedRes.usedLlm, true);
    assert.equal(allowedRes.link.analysisSource, "llm");
    assert.equal(allowedRes.link.moduleAnalysis[0]!.sourceModulePath, "src/orchestrator/router.ts");
    assert.equal(allowedRes.link.moduleAnalysis[0]!.targetModulePath, "src/runtime/mcp-router.ts");

    // 3. When LLM is unconfigured, seamlessly falls back to deterministic module analysis
    const spotlightTarget = await service.getNode("magele758/ai-agent-node");
    const spotlightLinks = await service.listLinks({ targetNodeId: spotlightTarget.id });
    llmMode = "unconfigured";
    const fallbackRes = await service.analyzeLink(spotlightLinks[0]!.id, { force: true }, "founder");
    assert.equal(fallbackRes.usedLlm, false);
    assert.equal(fallbackRes.privacyBlocked, false);
    assert.equal(fallbackRes.link.analysisSource, "deterministic");
    assert.ok(fallbackRes.link.moduleAnalysis.length >= 2);
  });

  it("closes the Founder Mailbox DecisionGateway loop (approve / watch / reject + dedupe + bypassAutoApprove + promote)", async () => {
    const star = await service.getNode("openorg/multi-agent-orchestrator");
    const links = await service.listLinks({ sourceNodeId: star.id });
    assert.ok(links.length >= 3, "expected 3 outgoing links from multi-agent-orchestrator");

    const linkApprove = links.find((l) => l.targetRepoFullName === "magele758/ai-agent-node")!;
    const linkWatch = links.find((l) => l.targetRepoFullName === "magele758/private-core-engine")!;
    const linkReject = links.find((l) => l.targetRepoFullName === "magele758/web-canvas-kit")!;

    // 1. Submit to Mailbox -> NEVER auto-approved even though policy is full_auto!
    const sub1 = await service.submitLinkToMailbox(linkApprove.id, { note: "重点评估 ai-agent-node 吸收方案" }, "founder");
    assert.equal(sub1.reusedPending, false);
    assert.equal(sub1.packet.domain, "product");
    assert.equal(sub1.packet.kind, "repo_absorption");
    assert.equal(sub1.packet.riskLevel, "medium");
    assert.equal(sub1.packet.status, "pending", "bypassAutoApprove must keep packet pending even in full_auto");
    assert.equal(sub1.packet.autoApproved, false);
    assert.ok(sub1.packet.dedupeKey.startsWith(`product:repo_absorption:${linkApprove.id}:`));
    assert.ok(sub1.packet.tags.includes(`link:${linkApprove.id}`));
    assert.match(sub1.packet.diffOrEvidence, /#repo-evolution\?tab=graph&link=/);
    assert.equal(sub1.link.status, "in_review");
    assert.equal(sub1.link.decisionPacketId, sub1.packet.id);

    // 2. Submitting the same link again deduplicates cleanly onto the same pending packet
    const sub1Dup = await service.submitLinkToMailbox(linkApprove.id, {}, "founder");
    assert.equal(sub1Dup.reusedPending, true);
    assert.equal(sub1Dup.packet.id, sub1.packet.id);

    // 3. Founder APPROVES -> link becomes approved + timeline event + V1 does NOT auto-create opportunity
    const resolvedApprove = await decisions.resolve(sub1.packet.id, {
      optionId: "approve",
      note: "架构方向吻合，纳入 Q4 进化路线",
      actor: "founder",
    });
    assert.equal(resolvedApprove.status, "approved");
    const afterApprove = await service.getLink(linkApprove.id);
    assert.equal(afterApprove.status, "approved");
    assert.equal(afterApprove.opportunityId, null, "V1 mailbox_review must NOT auto-create opportunity");

    // 4. Manual promote-to-opportunity writes into OpportunityStore & updates link to absorbing
    const promoted = await service.promoteLinkToOpportunity(linkApprove.id, { pipeline: "quick" }, "founder");
    assert.ok(promoted.opportunityId);
    assert.equal(promoted.project, "magele758/ai-agent-node");
    assert.equal(promoted.link.status, "absorbing");
    assert.equal(promoted.link.opportunityId, promoted.opportunityId);
    const oppList = opportunities.list("magele758/ai-agent-node");
    assert.ok(oppList.opportunities.some((o) => o.id === promoted.opportunityId));

    // 5. Founder WATCHES (snoozed) -> link becomes watching + timeline event
    const sub2 = await service.submitLinkToMailbox(linkWatch.id, {}, "founder");
    const resolvedWatch = await decisions.resolve(sub2.packet.id, {
      optionId: "watch",
      note: "先观察两个月看社区稳定度",
      actor: "founder",
    });
    assert.equal(resolvedWatch.status, "snoozed");
    const afterWatch = await service.getLink(linkWatch.id);
    assert.equal(afterWatch.status, "watching");

    // 6. Founder REJECTS -> link becomes rejected + subsequent scans automatically skip it!
    const sub3 = await service.submitLinkToMailbox(linkReject.id, {}, "founder");
    const resolvedReject = await decisions.resolve(sub3.packet.id, {
      optionId: "reject",
      note: "与前端画布库方向不匹配",
      actor: "founder",
    });
    assert.equal(resolvedReject.status, "rejected");
    const afterReject = await service.getLink(linkReject.id);
    assert.equal(afterReject.status, "rejected");

    // Re-running clusterAndRecall must NOT overwrite or resurface rejected link
    await service.clusterAndRecall({ maxNewLinksPerOwned: 20 });
    const afterRescan = await service.getLink(linkReject.id);
    assert.equal(afterRescan.status, "rejected");

    // Verify Timeline recorded the complete evolution lifecycle!
    const timeline = await service.getTimeline({ repoFullName: "ai-agent-node", limit: 50 });
    const eventTypes = new Set(timeline.items.map((e) => e.eventType));
    assert.ok(eventTypes.has("module_analyzed"));
    assert.ok(eventTypes.has("submitted_to_mailbox"));
    assert.ok(eventTypes.has("decision_approved"));
    assert.ok(eventTypes.has("promoted_to_opportunity"));

    const globalTimeline = await service.getTimeline({ limit: 100 });
    const allTypes = new Set(globalTimeline.items.map((e) => e.eventType));
    assert.ok(allTypes.has("decision_watching"));
    assert.ok(allTypes.has("decision_rejected"));
    assert.ok(allTypes.has("sync_completed"));
  });

  it("serves all /api/opc/repo-evolution/* Hono routes with auth enforcement", async () => {
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
      return c.json({ error: "internal", message: err.message }, 500);
    });

    let authed = false;
    addRepoEvolutionRoutes(app, service, () => {
      if (!authed) throw new ApiError(401, "auth", "unauthorized");
      return { id: "u1", name: "founder" };
    });

    // Unauthenticated request rejected with 401
    const unauthRes = await app.request("/api/opc/repo-evolution/graph/macro");
    assert.equal(unauthRes.status, 401);

    authed = true;
    const macroRes = await app.request("/api/opc/repo-evolution/graph/macro");
    assert.equal(macroRes.status, 200);
    const macroBody = (await macroRes.json()) as { stats: { ownedCount: number }; ownedRepos: unknown[] };
    assert.ok(macroBody.stats.ownedCount >= 3);

    const focusRes = await app.request("/api/opc/repo-evolution/graph/focus?focusType=owned&focusId=ai-agent-node");
    assert.equal(focusRes.status, 200);
    const focusBody = (await focusRes.json()) as { ownedNodes: Array<{ fullName: string }>; links: unknown[] };
    assert.equal(focusBody.ownedNodes[0]!.fullName, "magele758/ai-agent-node");
    assert.ok(focusBody.links.length >= 1);

    const nodesRes = await app.request("/api/opc/repo-evolution/nodes?bucket=floating&page=1&pageSize=20");
    assert.equal(nodesRes.status, 200);
    const nodesBody = (await nodesRes.json()) as { items: unknown[]; total: number; facets: { languages: unknown[] } };
    assert.ok(nodesBody.total >= 3);
    assert.ok(Array.isArray(nodesBody.facets.languages));

    const contentRes = await app.request(
      "/api/opc/repo-evolution/content?repo=" + encodeURIComponent("openorg/multi-agent-orchestrator"),
    );
    assert.equal(contentRes.status, 200);
    const contentBody = (await contentRes.json()) as RepoContent;
    assert.equal(contentBody.fullName, "openorg/multi-agent-orchestrator");
    assert.ok(contentBody.readme?.text.includes("Architecture"));

    const configPatchRes = await app.request("/api/opc/repo-evolution/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staleMonths: 18, dormantMonths: 9 }),
    });
    assert.equal(configPatchRes.status, 200);
    const cfgBody = (await configPatchRes.json()) as { staleMonths: number; dormantMonths: number };
    assert.equal(cfgBody.staleMonths, 18);
    assert.equal(cfgBody.dormantMonths, 9);

    const timelineRes = await app.request("/api/opc/repo-evolution/timeline?limit=10");
    assert.equal(timelineRes.status, 200);
    const tlBody = (await timelineRes.json()) as { items: unknown[]; total: number };
    assert.ok(tlBody.total >= 5);

    const syncRes = await app.request("/api/opc/repo-evolution/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "incremental" }),
    });
    assert.equal(syncRes.status, 202);
    const syncJob = (await syncRes.json()) as { id: string };
    assert.ok(syncJob.id.startsWith("sync_"));

    // Poll until background sync completes cleanly
    for (let i = 0; i < 30; i++) {
      const check = await app.request(`/api/opc/repo-evolution/sync/jobs/${syncJob.id}`);
      const job = (await check.json()) as { status: string };
      if (job.status === "completed" || job.status === "failed") {
        assert.equal(job.status, "completed");
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  });

  it("preserves existing approved/in_review links untouched during bulkLinkTargets when appending new targets", async () => {
    const star = await service.getNode("openorg/mcp-tool-runtime");
    const target1 = await service.getNode("magele758/ai-agent-node");
    const target2 = await service.getNode("magele758/web-canvas-kit");

    // Create & approve link1 with custom relationType & strength
    const link1 = await service.createLink({
      sourceNodeId: star.id,
      targetNodeId: target1.id,
      relationType: "direct_module",
      status: "approved",
      strength: 0.91,
      rationale: "已批准的核心 MCP 沙箱模块",
    });
    assert.equal(link1.status, "approved");

    // Re-submit checkbox selection [target1, target2] via bulkLinkTargets
    const res = await service.bulkLinkTargets(star.id, {
      targetNodeIds: [target1.id, target2.id],
      relationType: "inspiration",
      rationale: "批量新增勾选",
    });
    assert.equal(res.links.length, 2);

    const preserved = await service.getLink(link1.id);
    assert.equal(preserved.status, "approved", "bulkLinkTargets must NOT downgrade existing approved link");
    assert.equal(preserved.relationType, "direct_module", "bulkLinkTargets must NOT clobber existing relationType");
    assert.equal(preserved.strength, 0.91, "bulkLinkTargets must NOT clobber existing strength");
    assert.equal(preserved.rationale, "已批准的核心 MCP 沙箱模块");

    const added = res.links.find((l) => l.targetNodeId === target2.id);
    assert.ok(added);
    assert.equal(added.status, "watching");
  });

  it("enforces private-repo embedding privacy and aligns remote/local vector spaces in clusterAndRecall", async () => {
    const schema2 = `test_repo_evo_rem_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await pgHandle.adminPool.query(`CREATE SCHEMA ${schema2}`);
    const pool2 = await createRepoEvolutionPool(PG_URL, { schema: schema2, max: 4 });
    const remoteCalls: string[] = [];

    // Deterministic mock remote embedding space (orthogonal basis per topic family)
    const mockRemoteVector = (text: string): number[] => {
      const vec = new Array<number>(REPO_EVOLUTION_VECTOR_DIM).fill(0);
      const lower = text.toLowerCase();
      if (/(agent|mcp|orchestrat|workflow|swarm|tool|编排)/.test(lower)) vec[10] = 1;
      if (/(canvas|svg|react|diagram|前端|画布)/.test(lower)) vec[20] = 1;
      if (/(rag|vector|pgvector|retrieval|知识图谱|检索)/.test(lower)) vec[30] = 1;
      if (!vec.some((v) => v !== 0)) vec[99] = 1;
      return vec;
    };

    try {
      const gh2 = makeMockGithubFetcher();
      const svc2 = new RepoEvolutionService({
        pool: pool2,
        github: gh2.fetcher,
        now: () => FIXED_NOW,
        vectorCaller: async (text) => {
          remoteCalls.push(text);
          return { vector: mockRemoteVector(text), source: "remote", dimensions: REPO_EVOLUTION_VECTOR_DIM };
        },
      });
      await svc2.init();

      // 1. Sync & register: private repo (allowLlmAnalysis=false) MUST NOT leak to remote vectorCaller!
      await svc2.runSyncNow({ mode: "full" });
      await svc2.registerOwnedOrSpotlightNode({
        fullName: "magele758/secret-private-vault",
        visibility: "private",
        priorityTier: "standard",
        description: "TOP_SECRET_PRIVATE_CODEWORD_XYZ987 internal agent vault",
      });

      assert.equal(
        remoteCalls.some((t) => t.includes("private-core-engine") || t.includes("TOP_SECRET_PRIVATE_CODEWORD_XYZ987")),
        false,
        "unauthorized private repo metadata must NEVER be sent to remote embedding API",
      );

      const privSynced = await svc2.getNode("magele758/private-core-engine");
      assert.equal(privSynced.embeddingSource, "local");
      const pubStar = await svc2.getNode("openorg/mcp-tool-runtime");
      assert.equal(pubStar.embeddingSource, "remote");

      // 2. Cluster & recall with recomputeEmbeddings=true:
      //    - private repos still stay strictly local (never leaked)
      //    - public remote stars match remote domain centroids in the SAME vector space
      //    - private local owned repo still recalls public remote stars via local hybrid fallback!
      await svc2.clusterAndRecall({ recomputeEmbeddings: true, reclassifyAi: true });

      assert.equal(
        remoteCalls.some((t) => t.includes("private-core-engine") || t.includes("TOP_SECRET_PRIVATE_CODEWORD_XYZ987")),
        false,
        "recomputeEmbeddings must still block unauthorized private repos from remote embedding API",
      );

      const pubStarAfter = await svc2.getNode("openorg/mcp-tool-runtime");
      assert.equal(pubStarAfter.primaryDomainName, "AI Agent 与编排框架");
      const svgStarAfter = await svc2.getNode("vizlab/svg-flow-canvas");
      assert.equal(svgStarAfter.primaryDomainName, "前端交互与可视化");

      const privIncoming = await svc2.listLinks({ targetNodeId: privSynced.id });
      assert.ok(
        privIncoming.length >= 1,
        "private local owned repo should still recall matching public stars via local hybrid fallback",
      );
    } finally {
      await pool2.end?.();
      await pgHandle.adminPool.query(`DROP SCHEMA IF EXISTS ${schema2} CASCADE`);
    }
  });
});
