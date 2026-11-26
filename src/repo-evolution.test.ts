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
import { createApp } from "./server/http.ts";
import { ApiError, openStore } from "./server/logic.ts";
import {
  addRepoEvolutionRoutes,
  BUILTIN_REPO_DOMAINS,
  computePoolBucket,
  computeRepoVitality,
  createRepoEvolutionPool,
  extractRepoConcepts,
  isCuratedListOrTutorial,
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
import type { RepoEvolutionRadialGraph } from "./repo-evolution-types.ts";

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

  it("identifies curated awesome lists / tutorials and extracts high-precision engineering concepts", () => {
    assert.equal(
      isCuratedListOrTutorial({
        fullName: "EvoMap/awesome-agent-evolution",
        name: "awesome-agent-evolution",
        description: "A curated list of AI Agent evolution, memory systems, and multi-agent architectures",
        topics: ["awesome-list", "ai-agents"],
      }),
      true,
    );
    assert.equal(
      isCuratedListOrTutorial({
        fullName: "ZJU-LLMs/Foundations-of-LLMs",
        name: "Foundations-of-LLMs",
        description: "A book for Learning the Foundations of LLMs",
        topics: [],
      }),
      true,
    );
    assert.equal(
      isCuratedListOrTutorial({
        fullName: "browser-use/browser-use",
        name: "browser-use",
        description: "Make websites accessible for AI agents with Playwright DOM automation",
        topics: ["playwright", "browser-automation"],
      }),
      false,
    );

    const quantConcepts = extractRepoConcepts({
      name: "stock-research",
      description: "QuantLab Pro V2.0 quantitative research platform with Barra CNE6, cvxpy, A-share backtest",
      topics: [],
    });
    assert.ok(quantConcepts.has("quant-backtest-factors"));
    assert.ok(quantConcepts.has("financial-trading-agents"));

    const genericConcepts = extractRepoConcepts({
      name: "ai-cli-tool",
      description: "An open-source AI LLM CLI app tool framework for developers",
      topics: ["ai", "llm", "cli", "tool", "open-source"],
    });
    assert.equal(genericConcepts.size, 0, "generic buzzwords alone must not trigger specific mechanism concepts");

    const negatedConcepts = extractRepoConcepts({
      name: "pagelens-agent",
      description: "PageLens agent side panel without interpretation, dubbing, ASR, or TTS.",
      topics: ["chrome-extension"],
    });
    assert.ok(negatedConcepts.has("chrome-mv3-extension"));
    assert.equal(negatedConcepts.has("asr-subtitle-dubbing"), false, "negated 'without dubbing/ASR' must not trigger ASR concept");
    assert.equal(negatedConcepts.has("tts-voice-synthesis"), false, "negated 'without TTS' must not trigger TTS concept");

    // Org-chart prefix in notes must NOT trigger agent-control-plane on unrelated learning repos
    const learnAgentConcepts = extractRepoConcepts({
      name: "learn-agent",
      description: "认知诊断与主动学习 Agent，支持间隔重复与先测理解",
      notes: "OPC OS L1 · 常驻数字员工 · 能力契约：诊断理解与按依赖教学",
      topics: [],
    });
    assert.ok(learnAgentConcepts.has("adaptive-tutor-learning"));
    assert.equal(
      learnAgentConcepts.has("agent-control-plane"),
      false,
      "OPC OS L1 org-chart banner in notes must not falsely trigger agent-control-plane",
    );

    // ASCII phrase word boundaries: 'interactive learning' must NOT match 'active learning'
    const medicalPixelsConcepts = extractRepoConcepts({
      name: "pixels",
      description: "Large scale processing of HLS Medical images, OHIF Viewer and interactive learning.",
      topics: ["dicom", "medical-imaging"],
    });
    assert.equal(medicalPixelsConcepts.has("adaptive-tutor-learning"), false);

    // Music-gen / vertical consumer skills / bilingual LLM / warp-drive / Nomad Vault boundary guards
    const yueMusicConcepts = extractRepoConcepts({
      name: "YuE",
      description: "Open full-song music generation foundation model for song generation and zero-shot covers.",
      topics: ["music-generation", "voice-cloning"],
    });
    assert.equal(yueMusicConcepts.has("tts-voice-synthesis"), false, "music-gen repo must not trigger TTS");

    const shotcraftConcepts = extractRepoConcepts({
      name: "video-shotcraft",
      description: "AI video skill for Claude Code & Codex — cinematic product promos with Remotion.",
      topics: ["claude-code", "remotion"],
    });
    assert.ok(shotcraftConcepts.has("programmable-video-aigc"));
    assert.equal(shotcraftConcepts.has("coding-agent-harness"), false, "video promo skill must not trigger coding-agent-harness");

    const chatGlmConcepts = extractRepoConcepts({
      name: "ChatGLM3",
      description: "ChatGLM3 series: Open Bilingual Chat LLMs | 开源双语对话语言模型",
      topics: [],
    });
    assert.equal(chatGlmConcepts.has("web-page-translation"), false, "bilingual LLM must not trigger web translation");

    const warpDriveConcepts = extractRepoConcepts({
      name: "warp-drive",
      description: "WarpDrive is the lightweight data library for ambitious web apps.",
      topics: ["ember", "warp-drive"],
    });
    assert.equal(warpDriveConcepts.has("native-terminal-cockpit"), false, "warp-drive data library must not trigger terminal concept");

    const nomadConcepts = extractRepoConcepts({
      name: "nomad",
      description: "Flexible workload orchestrator with native Consul and Vault integrations.",
      topics: [],
    });
    assert.equal(nomadConcepts.has("blind-credential-security"), false, "Vault integration mention must not trigger credential vault");
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

  it("isolates forks/awesome-lists/generic-buzzwords and serves concentric 3-ring /graph/radial with 1-to-N cross-sector edges", async () => {
    const schema3 = `test_repo_evo_rad_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await pgHandle.adminPool.query(`CREATE SCHEMA ${schema3}`);
    const pool3 = await createRepoEvolutionPool(PG_URL, { schema: schema3, max: 4 });

    try {
      const gh3 = makeMockGithubFetcher();
      // Add a forked owned repo + an awesome-list star + a generic-buzzword star + a cross-sector browser-use star
      gh3.ownedRepos.push({
        fullName: "magele758/forked-old-editor",
        url: "https://github.com/magele758/forked-old-editor",
        visibility: "public",
        description: "Forked rich text editor framework with React SVG canvas",
        isArchived: false,
        isFork: true,
        starsCount: 0,
        forksCount: 0,
        pushedAt: monthsAgoIso(1),
        repoUpdatedAt: monthsAgoIso(1),
        defaultBranch: "main",
        primaryLanguage: "TypeScript",
        topics: ["react", "svg", "canvas"],
      });
      gh3.starredRepos.push(
        {
          fullName: "curated/awesome-mcp-agents",
          url: "https://github.com/curated/awesome-mcp-agents",
          visibility: "public",
          description: "A curated list of awesome AI agent MCP servers, workflows, and multi-agent orchestrators",
          isArchived: false,
          isFork: false,
          starsCount: 45000,
          forksCount: 3000,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          starredAt: "2026-11-25T11:00:00.000Z",
          defaultBranch: "main",
          primaryLanguage: "Markdown",
          topics: ["awesome", "awesome-list", "mcp", "ai-agent"],
        },
        {
          fullName: "noise/generic-ai-cli-tool",
          url: "https://github.com/noise/generic-ai-cli-tool",
          visibility: "public",
          description: "An open-source AI LLM CLI app tool framework library for developers",
          isArchived: false,
          isFork: false,
          starsCount: 1200,
          forksCount: 80,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          starredAt: "2026-11-25T10:30:00.000Z",
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
          topics: ["ai", "llm", "cli", "tool", "open-source"],
        },
      );

      const svc3 = new RepoEvolutionService({
        pool: pool3,
        github: gh3.fetcher,
        now: () => FIXED_NOW,
      });
      await svc3.init();
      await svc3.runSyncNow({ mode: "full" });
      const recallRes = await svc3.clusterAndRecall({
        recalibrateTaxonomy: true,
        enrichOwnedProfiles: true,
        reclassifyAi: true,
      });

      assert.ok(recallRes.ownedDomainsAssigned >= 3, "owned repos must be classified into Ring 1 domains");
      assert.ok(recallRes.ownedProfilesEnriched >= 3, "core original owned repos should cache README profiles");

      // 1. Fork owned repo must NEVER receive auto-suggested links
      const forkedOwned = await svc3.getNode("magele758/forked-old-editor");
      assert.equal(forkedOwned.isFork, true);
      const forkLinks = await svc3.listLinks({ targetNodeId: forkedOwned.id });
      assert.equal(forkLinks.length, 0, "forked owned repo must not grab auto-suggested absorption links");

      // 2. Awesome list & generic buzzword star must NEVER be auto-linked
      const awesomeStar = await svc3.getNode("curated/awesome-mcp-agents");
      const awesomeLinks = await svc3.listLinks({ sourceNodeId: awesomeStar.id });
      assert.equal(awesomeLinks.length, 0, "curated awesome-* list must not auto-link to engineering repos");

      const genericStar = await svc3.getNode("noise/generic-ai-cli-tool");
      const genericLinks = await svc3.listLinks({ sourceNodeId: genericStar.id });
      assert.equal(genericLinks.length, 0, "generic buzzword repo must not auto-link");

      // 3. Valid links must carry concrete mechanism rationale (not generic cosine similarity text)
      const validLinks = await svc3.listLinks({ limit: 50 });
      assert.ok(validLinks.length >= 2);
      for (const l of validLinks) {
        assert.match(l.rationale, /机制重合|共同技术点/);
        assert.doesNotMatch(l.rationale, /pgvector 语义召回匹配/);
      }

      // 4. Create an explicit approved cross-sector link & test recalibrate preserves approved while refreshing suggested
      const starMulti = await svc3.getNode("openorg/multi-agent-orchestrator");
      const canvasOwned = await svc3.getNode("magele758/web-canvas-kit");
      const approvedManual = await svc3.createLink({
        sourceNodeId: starMulti.id,
        targetNodeId: canvasOwned.id,
        relationType: "ux_workflow",
        status: "approved",
        strength: 0.88,
        rationale: "人工批准跨扇区借鉴其可视化编排画布",
      });

      const recalRes = await svc3.clusterAndRecall({
        recalibrateTaxonomy: true,
        clearSuggestedLinks: true,
        reclassifyAi: true,
      });
      assert.ok(recalRes.clearedSuggestedLinks >= 1);
      const preservedApproved = await svc3.getLink(approvedManual.id);
      assert.equal(preservedApproved.status, "approved", "recalibrate must preserve approved links");

      // 5. Verify GET /api/opc/repo-evolution/graph/radial contract & filters
      const app3 = new Hono();
      addRepoEvolutionRoutes(app3, svc3, () => ({ id: "u1", name: "founder" }));

      const radDefaultRes = await app3.request("/api/opc/repo-evolution/graph/radial");
      assert.equal(radDefaultRes.status, 200);
      const rad = (await radDefaultRes.json()) as RepoEvolutionRadialGraph;
      assert.equal(rad.filters.includeForks, false);
      assert.equal(rad.stats.ownedOriginalCount, 3);
      assert.equal(rad.stats.ownedForkCount, 1);
      assert.equal(rad.ownedNodes.some((o) => o.isFork), false, "includeForks=false must hide forked owned repos");
      assert.ok(rad.ownedNodes.every((o) => Boolean(o.primaryDomainId)), "all original owned repos should have a Ring 1 domain");
      assert.ok(rad.domains.some((d) => d.ownedCount > 0 && d.linkedStarCount > 0));
      assert.ok(rad.starNodes.length >= 2);
      assert.ok(rad.links.length >= 2);

      // Verify strict graph integrity: every link endpoint exists in starNodes & ownedNodes
      const ownedSet = new Set(rad.ownedNodes.map((o) => o.id));
      const starSet = new Set(rad.starNodes.map((s) => s.id));
      for (const l of rad.links) {
        assert.ok(starSet.has(l.starNodeId), `link starNodeId ${l.starNodeId} missing in starNodes`);
        assert.ok(ownedSet.has(l.ownedNodeId), `link ownedNodeId ${l.ownedNodeId} missing in ownedNodes`);
      }

      // Verify 1-to-N multi-target & cross-sector flags on openorg/multi-agent-orchestrator
      const multiNode = rad.starNodes.find((s) => s.fullName === "openorg/multi-agent-orchestrator");
      assert.ok(multiNode, "multi-agent-orchestrator should appear in Ring 3");
      assert.equal(multiNode.isMultiTarget, true);
      assert.ok(multiNode.targetOwnedIds.length >= 2);
      assert.equal(multiNode.isCrossSector, true);
      assert.equal(multiNode.stargazerCount, multiNode.starsCount);

      // Verify includeForks=true reveals forked owned repo
      const radForksRes = await app3.request("/api/opc/repo-evolution/graph/radial?includeForks=true");
      assert.equal(radForksRes.status, 200);
      const radForks = (await radForksRes.json()) as RepoEvolutionRadialGraph;
      assert.equal(radForks.ownedNodes.some((o) => o.fullName === "magele758/forked-old-editor"), true);

      // Verify maxStarsPerOwned truncation reports truncatedStarCount cleanly
      const radCapRes = await app3.request("/api/opc/repo-evolution/graph/radial?maxStarsPerOwned=1");
      assert.equal(radCapRes.status, 200);
      const radCap = (await radCapRes.json()) as RepoEvolutionRadialGraph;
      assert.ok(radCap.ownedNodes.some((o) => o.totalStarCount >= 1 && o.linkedStarCount <= 1));

      // Verify POST /recalibrate HTTP route works cleanly
      const recalHttpRes = await app3.request("/api/opc/repo-evolution/recalibrate", { method: "POST" });
      assert.equal(recalHttpRes.status, 200);
      const recalBody = (await recalHttpRes.json()) as { domainsCalibrated: number };
      assert.ok(recalBody.domainsCalibrated >= BUILTIN_REPO_DOMAINS.length);
    } finally {
      await pool3.end?.();
      await pgHandle.adminPool.query(`DROP SCHEMA IF EXISTS ${schema3} CASCADE`);
    }
  });

  it("enforces topic grounding, primary-domain alignment, and vertical-skill guards in end-to-end recall", async () => {
    const schema4 = `test_repo_evo_prec_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await pgHandle.adminPool.query(`CREATE SCHEMA ${schema4}`);
    const pool4 = await createRepoEvolutionPool(PG_URL, { schema: schema4, max: 4 });

    try {
      const gh4 = makeMockGithubFetcher();
      gh4.ownedRepos.length = 0;
      gh4.starredRepos.length = 0;
      gh4.starLists.length = 0;

      gh4.ownedRepos.push(
        {
          fullName: "magele758/chromegate-gateway",
          url: "https://github.com/magele758/chromegate-gateway",
          visibility: "public",
          description: "Chrome MV3 extension & native host gateway that lets Cursor, Claude Code, or Codex call your logged-in Chrome.",
          isArchived: false,
          isFork: false,
          starsCount: 5,
          forksCount: 0,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          defaultBranch: "main",
          primaryLanguage: "JavaScript",
          topics: ["chrome-extension", "manifest-v3"],
        },
        {
          fullName: "magele758/obsidian-palace",
          url: "https://github.com/magele758/obsidian-palace",
          visibility: "public",
          description: "Obsidian second-brain knowledge base and markdown graph builder.",
          isArchived: false,
          isFork: false,
          starsCount: 4,
          forksCount: 0,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
          topics: ["obsidian", "knowledge-graph"],
        },
        {
          fullName: "magele758/opc-commerce-kit",
          url: "https://github.com/magele758/opc-commerce-kit",
          visibility: "public",
          description: "MoR webhook normalizer, Ed25519 offline license SDK, and FinOps billing ledger.",
          isArchived: false,
          isFork: false,
          starsCount: 3,
          forksCount: 0,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
          topics: ["stripe", "licensing", "finops"],
        },
        {
          fullName: "magele758/my-claude-code",
          url: "https://github.com/magele758/my-claude-code",
          visibility: "public",
          description: "Custom Claude Code coding agent harness and hooks runtime.",
          isArchived: false,
          isFork: false,
          starsCount: 2,
          forksCount: 0,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
          topics: ["claude-code", "coding-agent"],
        },
      );

      gh4.starredRepos.push(
        // Should NOT link to chromegate-gateway (only shares non-primary coding-agent-harness mention)
        {
          fullName: "musistudio/claude-code-router",
          url: "https://github.com/musistudio/claude-code-router",
          visibility: "public",
          description: "Route Claude Code requests across different LLM models and coding agent providers.",
          isArchived: false,
          isFork: false,
          starsCount: 15000,
          forksCount: 900,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          starredAt: "2026-11-20T08:00:00.000Z",
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
          topics: ["claude-code", "coding-agent"],
        },
        // Should NOT link to obsidian-palace (only trailing topic tag 'obsidian', not in name/desc)
        {
          fullName: "handsomestWei/patent-disclosure-skill",
          url: "https://github.com/handsomestWei/patent-disclosure-skill",
          visibility: "public",
          description: "中国专利交底书自动挖掘与撰写助手，辅助工程师提炼专利点。",
          isArchived: false,
          isFork: false,
          starsCount: 600,
          forksCount: 40,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          starredAt: "2026-11-19T08:00:00.000Z",
          defaultBranch: "main",
          primaryLanguage: "Python",
          topics: ["patent", "obsidian", "agent-skills"],
        },
        // Should NOT classify into coding-agents or link to my-claude-code (vertical job-search skill)
        {
          fullName: "career-ops-hq/career-ops",
          url: "https://github.com/career-ops-hq/career-ops",
          visibility: "public",
          description: "Open-source AI job search agent and job finder: score jobs against your CV and tailor resumes. Runs in Claude Code or Codex.",
          isArchived: false,
          isFork: false,
          starsCount: 1800,
          forksCount: 120,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          starredAt: "2026-11-18T08:00:00.000Z",
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
          topics: ["claude-code", "job-search", "resume", "agent-skills"],
        },
        // Should NOT cross-sector link to opc-commerce-kit solely from tail-end 'billing & admin built in'
        {
          fullName: "jaikydota/BullFlow",
          url: "https://github.com/jaikydota/BullFlow",
          visibility: "public",
          description: "Open-source enterprise RAG solution: knowledge base and marketing content publishing. Multi-tenant, billing & admin built in.",
          isArchived: false,
          isFork: false,
          starsCount: 2400,
          forksCount: 200,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          starredAt: "2026-11-17T08:00:00.000Z",
          defaultBranch: "main",
          primaryLanguage: "TypeScript",
          topics: ["rag", "knowledge-base", "milvus"],
        },
        // True positive: real Chrome MV3 extension SHOULD link to chromegate-gateway
        {
          fullName: "bergside/design-md-chrome",
          url: "https://github.com/bergside/design-md-chrome",
          visibility: "public",
          description: "Chrome extension with Manifest V3 side panel to extract design tokens from any webpage.",
          isArchived: false,
          isFork: false,
          starsCount: 950,
          forksCount: 55,
          pushedAt: monthsAgoIso(0.5),
          repoUpdatedAt: monthsAgoIso(0.5),
          starredAt: "2026-11-16T08:00:00.000Z",
          defaultBranch: "main",
          primaryLanguage: "JavaScript",
          topics: ["chrome-extension", "manifest-v3"],
        },
      );

      const svc4 = new RepoEvolutionService({
        pool: pool4,
        github: gh4.fetcher,
        now: () => FIXED_NOW,
      });
      await svc4.init();
      await svc4.runSyncNow({ mode: "full" });
      await svc4.clusterAndRecall({
        recalibrateTaxonomy: true,
        enrichOwnedProfiles: false,
        reclassifyAi: true,
        clearSuggestedLinks: true,
      });

      const chromeGw = await svc4.getNode("magele758/chromegate-gateway");
      const chromeGwLinks = await svc4.listLinks({ targetNodeId: chromeGw.id });
      assert.equal(
        chromeGwLinks.some((l) => l.sourceRepoFullName === "musistudio/claude-code-router"),
        false,
        "chromegate-gateway must NOT link to coding-agent router via incidental README mention",
      );
      assert.equal(
        chromeGwLinks.some((l) => l.sourceRepoFullName === "bergside/design-md-chrome"),
        true,
        "chromegate-gateway MUST link to real Chrome MV3 extension",
      );

      const obsidianPalace = await svc4.getNode("magele758/obsidian-palace");
      const obsidianLinks = await svc4.listLinks({ targetNodeId: obsidianPalace.id });
      assert.equal(
        obsidianLinks.some((l) => l.sourceRepoFullName === "handsomestWei/patent-disclosure-skill"),
        false,
        "topic-only obsidian tag must NOT link patent-disclosure-skill to obsidian-palace",
      );

      const careerOps = await svc4.getNode("career-ops-hq/career-ops");
      assert.notEqual(
        careerOps.primaryDomainName,
        "编程 Agent 与工程范式",
        "vertical job-search skill must NOT classify into coding-agents",
      );
      const careerLinks = await svc4.listLinks({ sourceNodeId: careerOps.id });
      assert.equal(careerLinks.length, 0);

      const commerceKit = await svc4.getNode("magele758/opc-commerce-kit");
      const commerceLinks = await svc4.listLinks({ targetNodeId: commerceKit.id });
      assert.equal(
        commerceLinks.some((l) => l.sourceRepoFullName === "jaikydota/BullFlow"),
        false,
        "RAG repo with tail-end 'billing & admin built in' must NOT cross-sector link to opc-commerce-kit",
      );
    } finally {
      await pool4.end?.();
      await pgHandle.adminPool.query(`DROP SCHEMA IF EXISTS ${schema4} CASCADE`);
    }
  });
});

// ---- 3. createApp Server Wiring & Graceful 503 Degradation Tests ----

describe("repo-evolution createApp wiring", () => {
  it("gracefully degrades /api/opc/repo-evolution/* to 503 without crashing when PG URL is not configured", async () => {
    const store = openStore(":memory:", { pgUrl: "" });
    const { app, repoEvolution, close } = createApp(store, { pgUrl: "" });
    try {
      assert.equal(repoEvolution, null);

      const healthRes = await app.request("/api/health");
      assert.equal(healthRes.status, 200);
      const health = (await healthRes.json()) as {
        ok: boolean;
        sharedLocal: boolean;
        storage: string;
        repoEvolutionEnabled: boolean;
      };
      assert.equal(health.ok, true);
      assert.equal(health.sharedLocal, true);
      assert.equal(health.storage, "sqlite");
      assert.equal(health.repoEvolutionEnabled, false);

      // Unauthenticated request still returns 401
      const unauth = await app.request("/api/opc/repo-evolution/graph/macro");
      assert.equal(unauth.status, 401);

      // Authenticated session receives clear 503 degradation JSON
      const sessRes = await app.request("/api/session", { method: "POST" });
      assert.equal(sessRes.status, 200);
      const cookie = (sessRes.headers.get("set-cookie") ?? "").split(";")[0];
      assert.ok(cookie);

      const degraded = await app.request("/api/opc/repo-evolution/graph/macro", {
        headers: { cookie },
      });
      assert.equal(degraded.status, 503);
      const payload = (await degraded.json()) as { error: string; message: string };
      assert.equal(payload.error, "pg_unavailable");
      assert.match(payload.message, /PostgreSQL/);
    } finally {
      await close();
      store.db.close();
    }
  });

  it("wires RepoEvolutionService into createApp over isolated PG schema with mailbox & OpportunityStore end-to-end", async () => {
    const probe = await tryCreateIsolatedPgPool();
    if (!probe) return;
    await probe.pool.end?.();
    await probe.adminPool.query(`DROP SCHEMA IF EXISTS ${probe.schema} CASCADE`);
    await probe.adminPool.end?.();

    const store = openStore(":memory:", { pgUrl: PG_URL });
    const { app, repoEvolution, opportunities, company, close } = createApp(store, { pgUrl: PG_URL });
    try {
      assert.ok(repoEvolution, "repoEvolution should auto-wire when PG URL is configured");

      const healthRes = await app.request("/api/health");
      assert.equal(healthRes.status, 200);
      const health = (await healthRes.json()) as {
        ok: boolean;
        storage: string;
        repoEvolutionEnabled: boolean;
      };
      assert.equal(health.ok, true);
      assert.equal(health.storage, "postgres");
      assert.equal(health.repoEvolutionEnabled, true);

      const sessRes = await app.request("/api/session", { method: "POST" });
      const cookie = (sessRes.headers.get("set-cookie") ?? "").split(";")[0];
      const headers = { cookie, "content-type": "application/json" };

      const macroRes = await app.request("/api/opc/repo-evolution/graph/macro", { headers: { cookie } });
      assert.equal(macroRes.status, 200);
      const macro = (await macroRes.json()) as { domains: Array<{ slug: string }> };
      assert.equal(macro.domains.length, BUILTIN_REPO_DOMAINS.length);

      // Register spotlight target + create star node & link, submit to mailbox, approve, promote to opportunity
      const regTarget = await app.request("/api/opc/repo-evolution/nodes/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
          fullName: "magele758/ai-agent-node",
          visibility: "public",
          priorityTier: "spotlight",
          description: "Spotlight agent runtime",
        }),
      });
      assert.equal(regTarget.status, 200);
      const targetNode = (await regTarget.json()) as { id: string; priorityTier: string };
      assert.equal(targetNode.priorityTier, "spotlight");

      const regStar = await app.request("/api/opc/repo-evolution/nodes/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
          fullName: "openorg/agent-harness-kit",
          role: "starred",
          visibility: "public",
          description: "Agent harness toolkit",
        }),
      });
      assert.equal(regStar.status, 200);
      const starNode = (await regStar.json()) as { id: string };

      const createLinkRes = await app.request("/api/opc/repo-evolution/links", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceNodeId: starNode.id,
          targetNodeId: targetNode.id,
          relationType: "direct_module",
          rationale: "复用其轻量工具沙箱隔离机制",
        }),
      });
      assert.equal(createLinkRes.status, 200);
      const createdLink = (await createLinkRes.json()) as { id: string };

      const submitRes = await app.request(`/api/opc/repo-evolution/links/${createdLink.id}/submit-mailbox`, {
        method: "POST",
        headers,
        body: JSON.stringify({ note: "集成测试审批闭环" }),
      });
      assert.equal(submitRes.status, 200);
      const submitted = (await submitRes.json()) as { packet: { id: string; kind: string; status: string } };
      assert.equal(submitted.packet.kind, "repo_absorption");
      assert.equal(submitted.packet.status, "pending");

      // Approve through DecisionGateway HTTP / service
      const decided = await company.kernel.decisions.resolve(submitted.packet.id, {
        optionId: "approve",
        note: "批准吸收",
        actor: "founder",
      });
      assert.equal(decided.status, "approved");

      const promoteRes = await app.request(`/api/opc/repo-evolution/links/${createdLink.id}/promote-opportunity`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pipeline: "quick" }),
      });
      assert.equal(promoteRes.status, 200);
      const promoted = (await promoteRes.json()) as { opportunityId: string; project: string; link: { status: string } };
      assert.equal(promoted.project, "magele758/ai-agent-node");
      assert.equal(promoted.link.status, "absorbing");
      assert.ok(
        opportunities.list("magele758/ai-agent-node").opportunities.some((o) => o.id === promoted.opportunityId),
        "promoted opportunity should exist in OpportunityStore",
      );
    } finally {
      await close();
      store.db.close();
    }
  });
});
