import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { IndexedRepo, RepoContent } from "../activity-index-types.ts";
import type { DecisionGateway } from "../kernel/decisions.ts";
import type { DecisionPacket } from "../kernel/types.ts";
import type { ProvidersConfig } from "../providers-types.ts";
import type {
  AnalyzeLinkInput,
  AnalyzeLinkResult,
  BatchUpdateRepoNodesInput,
  BatchUpdateRepoNodesResult,
  BulkLinkTargetsInput,
  ClusterAndRecallInput,
  ClusterAndRecallResult,
  CreateRepoDomainInput,
  CreateRepoLinkInput,
  ImportGithubListsResult,
  MergeRepoDomainsInput,
  PromoteLinkToOpportunityInput,
  PromoteLinkToOpportunityResult,
  RepoAbsorptionEvent,
  RepoAbsorptionLink,
  RepoAbsorptionStatus,
  RepoDomain,
  RepoDomainAssignedBy,
  RepoDomainCluster,
  RepoDomainSource,
  RepoEvidenceLink,
  RepoEvolutionAutomationMode,
  RepoEvolutionConfig,
  RepoEvolutionContentSearchResult,
  RepoEvolutionEventType,
  RepoEvolutionFocusGraph,
  RepoEvolutionMacroGraph,
  RepoEvolutionNode,
  RepoEvolutionNodesPage,
  RepoEvolutionNodesQuery,
  RepoEvolutionStats,
  RepoEvolutionSyncJob,
  RepoEvolutionSyncMode,
  RepoEvolutionSyncPhase,
  RepoEvolutionSyncStatus,
  RepoEvolutionTimelinePage,
  RepoEvolutionTimelineQuery,
  RepoFloatingPoolSummary,
  RepoFocusType,
  RepoMacroEdge,
  RepoModuleAnalysisItem,
  RepoModuleEffort,
  RepoModuleRisk,
  RepoNodeBrief,
  RepoNodeRole,
  RepoOwnedSummaryNode,
  RepoPoolBucket,
  RepoPriorityTier,
  RepoReadmeDigest,
  RepoRelationType,
  RepoVisibility,
  RepoVitality,
  SubmitLinkToMailboxInput,
  SubmitLinkToMailboxResult,
  TriggerSyncInput,
  UpdateRepoDomainInput,
  UpdateRepoEvolutionConfigInput,
  UpdateRepoLinkInput,
  UpdateRepoNodeInput,
} from "../repo-evolution-types.ts";
import type { OpportunityStore } from "./autonomy.ts";
import { repoContent, searchRepo } from "./company-repo-content.ts";
import { ApiError } from "./logic.ts";
import {
  callConfiguredLLM,
  computeSemanticVector,
  cosineSimilarity,
  LOCAL_VECTOR_DIMENSIONS,
  localSemanticVector,
  type ProvidersStore,
} from "./providers.ts";

const exec = promisify(execFile);

export const REPO_EVOLUTION_VECTOR_DIM = LOCAL_VECTOR_DIMENSIONS;
const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;

export interface PgQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount?: number | null;
}

export interface PgClientLike {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<R>>;
  release: () => void;
}

export interface PgPoolLike {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<R>>;
  connect?: () => Promise<PgClientLike>;
  end?: () => Promise<void>;
}

export interface GitHubRepoSnapshot {
  fullName: string;
  url: string;
  visibility: RepoVisibility;
  description: string;
  isArchived: boolean;
  isFork: boolean;
  starsCount: number;
  forksCount: number;
  pushedAt: string | null;
  repoUpdatedAt: string | null;
  starredAt?: string | null;
  defaultBranch: string | null;
  primaryLanguage: string | null;
  topics: string[];
}

export interface GitHubRepoPage {
  login: string;
  totalCount: number | null;
  hasNextPage: boolean;
  endCursor: string | null;
  items: GitHubRepoSnapshot[];
}

export interface GitHubStarListSnapshot {
  id: string;
  name: string;
  slug: string;
  description: string;
  repoFullNames: string[];
}

export interface GitHubEvolutionFetcher {
  fetchOwnedReposPage(cursor: string | null): Promise<GitHubRepoPage>;
  fetchStarredReposPage(cursor: string | null): Promise<GitHubRepoPage>;
  fetchStarLists(): Promise<GitHubStarListSnapshot[]>;
  fetchRepoContent(repo: IndexedRepo): Promise<RepoContent>;
  searchRepoContent(repo: IndexedRepo, term: string): Promise<RepoEvolutionContentSearchResult>;
}

export interface RepoEvolutionServiceOptions {
  pool: PgPoolLike;
  decisions?: DecisionGateway;
  providers?: ProvidersStore;
  opportunities?: OpportunityStore;
  github?: GitHubEvolutionFetcher;
  llmCaller?: typeof callConfiguredLLM;
  now?: () => number;
}

interface SeedDomainSpec {
  slug: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  sortOrder: number;
  seedKeywords: string[];
}

export const BUILTIN_REPO_DOMAINS: readonly SeedDomainSpec[] = [
  {
    slug: "ai-agents",
    name: "AI Agent 与编排框架",
    description: "智能体运行时、MCP 工具协议、多 Agent 协同、任务编排与上下文工程",
    color: "#4f46e5",
    icon: "bot",
    sortOrder: 10,
    seedKeywords: [
      "agent",
      "ai-agent",
      "llm",
      "mcp",
      "tool-use",
      "workflow",
      "multi-agent",
      "swarm",
      "claude",
      "codex",
      "harness",
      "memory",
      "orchestrator",
      "autonomous",
      "prompt",
      "skill",
      "openai",
      "langchain",
      "langgraph",
    ],
  },
  {
    slug: "rag-knowledge",
    name: "知识图谱与 RAG 检索",
    description: "向量检索、pgvector、知识库索引、语义召回、图谱记忆与重排引擎",
    color: "#0891b2",
    icon: "brain",
    sortOrder: 20,
    seedKeywords: [
      "rag",
      "vector",
      "embedding",
      "pgvector",
      "search",
      "retrieval",
      "knowledge-graph",
      "graph",
      "indexing",
      "semantic",
      "rerank",
      "chunking",
      "qdrant",
      "milvus",
      "obsidian",
      "note",
    ],
  },
  {
    slug: "dev-infra",
    name: "研发基建与 CLI 工具",
    description: "终端效率、Git/Worktree 隔离、构建编译、代码分析、测试与开发运行时",
    color: "#0d9488",
    icon: "terminal",
    sortOrder: 30,
    seedKeywords: [
      "cli",
      "terminal",
      "tmux",
      "git",
      "worktree",
      "build",
      "compiler",
      "bundler",
      "testing",
      "debug",
      "lsp",
      "devtool",
      "shell",
      "rust",
      "typescript",
      "runtime",
      "sdk",
      "ast",
    ],
  },
  {
    slug: "web-ui-viz",
    name: "前端交互与可视化",
    description: "React 组件架构、画布/图谱 SVG 渲染、编辑器、设计系统与数据可视化",
    color: "#d97706",
    icon: "layout",
    sortOrder: 40,
    seedKeywords: [
      "react",
      "ui",
      "canvas",
      "svg",
      "chart",
      "diagram",
      "design-system",
      "css",
      "animation",
      "editor",
      "whiteboard",
      "markdown",
      "dashboard",
      "tailwind",
      "frontend",
      "visualization",
      "mermaid",
      "excalidraw",
    ],
  },
  {
    slug: "data-backend",
    name: "数据库与分布式后端",
    description: "PostgreSQL/SQLite 引擎、事件流、异步队列、高性能 API 框架与同步存储",
    color: "#2563eb",
    icon: "database",
    sortOrder: 50,
    seedKeywords: [
      "postgres",
      "postgresql",
      "sqlite",
      "database",
      "sql",
      "queue",
      "cache",
      "api",
      "hono",
      "rpc",
      "websocket",
      "sync",
      "distributed",
      "storage",
      "backend",
      "server",
      "duckdb",
      "orm",
    ],
  },
  {
    slug: "browser-automation",
    name: "浏览器自动化与采集",
    description: "Playwright/Puppeteer 驱动、Chrome 插件、网页抓取、DOM 理解与 RPA 自动化",
    color: "#9333ea",
    icon: "globe",
    sortOrder: 60,
    seedKeywords: [
      "playwright",
      "puppeteer",
      "browser",
      "chrome",
      "extension",
      "scraper",
      "crawler",
      "automation",
      "dom",
      "headless",
      "rpa",
      "cdp",
      "web-scraping",
      "rss",
    ],
  },
  {
    slug: "media-creative",
    name: "音视频与多模态创作",
    description: "可编程视频渲染、Remotion/FFmpeg、语音合成/识别、图像生成与实时着色器",
    color: "#db2777",
    icon: "film",
    sortOrder: 70,
    seedKeywords: [
      "video",
      "audio",
      "remotion",
      "ffmpeg",
      "tts",
      "asr",
      "whisper",
      "speech",
      "image",
      "diffusion",
      "shader",
      "webgl",
      "caption",
      "media",
      "multimodal",
      "ocr",
      "pdf",
    ],
  },
  {
    slug: "ops-security-growth",
    name: "运维安全与商业增长",
    description: "容器部署、内网穿透、监控自愈、安全鉴权、支付账单与 SaaS 增长基础设施",
    color: "#dc2626",
    icon: "shield",
    sortOrder: 80,
    seedKeywords: [
      "docker",
      "kubernetes",
      "tailscale",
      "ssh",
      "monitoring",
      "observability",
      "security",
      "auth",
      "payment",
      "billing",
      "stripe",
      "analytics",
      "saas",
      "deploy",
      "self-hosted",
      "proxy",
    ],
  },
];

const GITHUB_LIST_PALETTE = [
  "#0ea5e9",
  "#10b981",
  "#8b5cf6",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
];

// ---- Helpers ----

export function repoNodeIdFromFullName(fullName: string): string {
  const digest = createHash("sha256").update(fullName.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `ren_${digest}`;
}

export function domainIdFromSlug(slug: string): string {
  const digest = createHash("sha256").update(slug.trim().toLowerCase()).digest("hex").slice(0, 12);
  return `dom_${digest}`;
}

function slugifyDomain(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii) return ascii.slice(0, 64);
  return `domain-${randomUUID().slice(0, 8)}`;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const str = String(value).trim();
  if (!str) return null;
  const ts = Date.parse(str);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : str;
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function normalizeVectorToDim(
  vec: number[],
  dim = REPO_EVOLUTION_VECTOR_DIM,
): number[] {
  const target = new Float64Array(dim);
  if (vec.length === dim) {
    for (let i = 0; i < dim; i++) {
      target[i] = Number.isFinite(vec[i]) ? vec[i] : 0;
    }
  } else if (vec.length > 0) {
    // Deterministic signed random projection (JL folding) when remote model dims differ.
    for (let i = 0; i < vec.length; i++) {
      const val = Number.isFinite(vec[i]) ? vec[i] : 0;
      if (val === 0) continue;
      const h = Math.imul(i + 1, 2654435761) >>> 0;
      const idx = h % dim;
      const sign = (h & 1) === 0 ? 1 : -1;
      target[idx] += sign * val;
    }
  }
  let normSq = 0;
  for (let i = 0; i < dim; i++) normSq += target[i] * target[i];
  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    target[0] = 1;
    return Array.from(target);
  }
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = Math.round((target[i] / norm) * 1e6) / 1e6;
  }
  return out;
}

export function debiasLocalSemanticVector(
  vec: number[],
  source: "local" | "remote" = "local",
): number[] {
  const normalized = normalizeVectorToDim(vec, REPO_EVOLUTION_VECTOR_DIM);
  if (source !== "local") return normalized;
  // localSemanticVector couples bucket parity (h % 256) with sign (h & 1), creating a constant
  // alternating orthant component u = [+1,-1,+1,-1,...]/sqrt(dim). Projecting u out restores
  // zero-centered cosine similarity (~0.05 for unrelated repos vs ~0.35-0.55 for true matches).
  const n = normalized.length;
  let proj = 0;
  for (let i = 0; i < n; i++) {
    proj += normalized[i]! * (i % 2 === 0 ? 1 : -1);
  }
  proj /= n;
  const centered = normalized.map((x, i) => x - proj * (i % 2 === 0 ? 1 : -1));
  return normalizeVectorToDim(centered, REPO_EVOLUTION_VECTOR_DIM);
}

export function toPgVectorLiteral(vec: number[], source: "local" | "remote" = "remote"): string {
  const normalized = debiasLocalSemanticVector(vec, source);
  return "[" + normalized.map((n) => (Number.isFinite(n) ? n.toFixed(6) : "0")).join(",") + "]";
}

export function parsePgVectorLiteral(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const nums = raw.map(Number);
    return nums.length === REPO_EVOLUTION_VECTOR_DIM ? nums : null;
  }
  const str = String(raw).trim();
  if (!str.startsWith("[") || !str.endsWith("]")) return null;
  const parts = str
    .slice(1, -1)
    .split(",")
    .map((s) => Number(s.trim()));
  return parts.length === REPO_EVOLUTION_VECTOR_DIM && parts.every(Number.isFinite) ? parts : null;
}

export function computeRepoVitality(
  isArchived: boolean,
  pushedAt: string | null,
  config: Pick<RepoEvolutionConfig, "staleMonths" | "dormantMonths">,
  nowMs = Date.now(),
): RepoVitality {
  if (isArchived) return "archived";
  if (!pushedAt) return "stale";
  const pushedMs = Date.parse(pushedAt);
  if (!Number.isFinite(pushedMs)) return "stale";
  const ageMs = Math.max(0, nowMs - pushedMs);
  if (ageMs >= config.staleMonths * MS_PER_MONTH) return "stale";
  if (ageMs >= config.dormantMonths * MS_PER_MONTH) return "dormant";
  return "active";
}

export function matchesSpotlightRepo(
  fullName: string,
  name: string,
  spotlightRepos: readonly string[],
): boolean {
  const fnLower = fullName.trim().toLowerCase();
  const nameLower = name.trim().toLowerCase();
  for (const entry of spotlightRepos) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e === fnLower || e === nameLower) return true;
  }
  return false;
}

export function computePoolBucket(input: {
  role: RepoNodeRole;
  vitality: RepoVitality;
  priorityTier: RepoPriorityTier;
  primaryDomainId: string | null;
  activeLinkCount: number;
}): RepoPoolBucket {
  if (input.role === "owned") return "owned";
  if (input.activeLinkCount > 0) return "linked";
  if (
    input.vitality === "stale" ||
    input.vitality === "archived" ||
    input.priorityTier === "archived"
  ) {
    return "stale_pool";
  }
  if (input.primaryDomainId) return "classified_unlinked";
  return "unclassified";
}

function buildRepoSemanticText(repo: {
  fullName: string;
  name: string;
  description: string;
  primaryLanguage: string | null;
  topics: string[];
  readmeDigest?: RepoReadmeDigest | null;
}): string {
  const parts = [
    repo.name,
    repo.name.replace(/[-_./]+/g, " "),
    repo.fullName,
    repo.description,
    repo.primaryLanguage ?? "",
    repo.topics.join(" "),
    repo.readmeDigest?.summary ?? "",
    (repo.readmeDigest?.keyModules ?? []).join(" "),
    (repo.readmeDigest?.techStack ?? []).join(" "),
  ];
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" · ");
}

function extractTokens(text: string): Set<string> {
  const raw = text.toLowerCase();
  const words = raw.match(/[a-z0-9][a-z0-9_-]{1,31}/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    for (const part of w.split(/[-_]+/)) {
      if (part.length >= 2) out.add(part);
    }
  }
  return out;
}

function keywordOverlapBoost(repoTokens: Set<string>, keywords: readonly string[]): number {
  if (!repoTokens.size || !keywords.length) return 0;
  let hits = 0;
  for (const kw of keywords) {
    const k = kw.trim().toLowerCase();
    if (!k) continue;
    if (repoTokens.has(k)) {
      hits += 1;
    } else if (k.includes("-")) {
      const parts = k.split("-").filter(Boolean);
      if (parts.length > 0 && parts.every((p) => repoTokens.has(p))) hits += 0.85;
    }
  }
  if (hits === 0) return 0;
  return Math.min(0.42, 0.14 + (hits - 1) * 0.08);
}

function topicOverlapScore(aTopics: string[], bTopics: string[], aLang: string | null, bLang: string | null): number {
  const setA = new Set(aTopics.map((t) => t.toLowerCase()));
  const setB = new Set(bTopics.map((t) => t.toLowerCase()));
  let overlap = 0;
  for (const t of setA) {
    if (setB.has(t)) overlap++;
  }
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union > 0 ? overlap / union : 0;
  const langBonus = aLang && bLang && aLang.toLowerCase() === bLang.toLowerCase() ? 0.05 : 0;
  return Math.min(0.3, jaccard * 0.45 + langBonus);
}

function inferRelationType(source: {
  name: string;
  description: string;
  topics: string[];
}): RepoRelationType {
  const bag = `${source.name} ${source.description} ${source.topics.join(" ")}`.toLowerCase();
  if (/(benchmark|eval|leaderboard|harness|dataset|metric)/.test(bag)) return "benchmark_ref";
  if (/(ui|canvas|editor|whiteboard|design|component|svg|graph|ux|dashboard|theme)/.test(bag)) return "ux_workflow";
  if (/(algorithm|rerank|scheduler|planner|search|vector|graph|consensus|routing|memory)/.test(bag)) {
    return "algorithm_idea";
  }
  if (/(cli|docker|tmux|worktree|build|ci|lint|test|deploy|proxy|monitor|infra)/.test(bag)) return "tooling_infra";
  if (/(sdk|plugin|adapter|middleware|driver|library|package|module|client)/.test(bag)) return "direct_module";
  return "architecture_pattern";
}

function normalizeVisibility(raw: string | undefined | null, isPrivate?: boolean): RepoVisibility {
  const v = String(raw ?? "").trim().toUpperCase();
  if (v === "PRIVATE" || isPrivate) return "private";
  if (v === "INTERNAL") return "internal";
  return "public";
}

function extractReadmeHeadings(text: string): string[] {
  const headings: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) {
      const clean = m[1].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").trim();
      if (clean && clean.length <= 80) headings.push(clean);
    }
    if (headings.length >= 8) break;
  }
  return headings;
}

function summarizeReadme(content: RepoContent, fallbackDesc: string): RepoReadmeDigest {
  const readmeText = content.readme?.text ?? "";
  const lines = readmeText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("![") && !l.startsWith("<") && !l.startsWith("[!["));
  const summary = (lines.slice(0, 3).join(" ").slice(0, 360) || fallbackDesc || content.fullName).trim();
  const keyDirs = content.files
    .filter((f) => f.directory && !f.name.startsWith("."))
    .slice(0, 12)
    .map((f) => f.name + "/");
  const keyFiles = content.files
    .filter((f) => !f.directory && /^(package\.json|cargo\.toml|pyproject\.toml|go\.mod|dockerfile|makefile|tsconfig\.json)$/i.test(f.name))
    .map((f) => f.name);
  const techStack = keyFiles.map((f) => {
    const lower = f.toLowerCase();
    if (lower === "package.json") return "Node/TypeScript";
    if (lower === "cargo.toml") return "Rust";
    if (lower === "pyproject.toml") return "Python";
    if (lower === "go.mod") return "Go";
    if (lower === "dockerfile") return "Docker";
    return f;
  });
  return {
    summary,
    keyModules: keyDirs.length ? keyDirs : extractReadmeHeadings(readmeText).slice(0, 6),
    techStack: [...new Set(techStack)],
    fileCount: content.files.length,
    ref: content.ref,
    fetchedAt: new Date().toISOString(),
  };
}

// ---- Default GitHub GraphQL Fetcher ----

const OWNED_REPOS_QUERY = `query($cursor: String) {
  viewer {
    login
    repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER], orderBy: { field: PUSHED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner url isPrivate visibility description isArchived isFork
        stargazerCount forkCount pushedAt updatedAt
        defaultBranchRef { name }
        primaryLanguage { name }
        repositoryTopics(first: 12) { nodes { topic { name } } }
      }
    }
  }
}`;

const STARRED_REPOS_QUERY = `query($cursor: String) {
  viewer {
    login
    starredRepositories(first: 100, after: $cursor, orderBy: { field: STARRED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        starredAt
        node {
          nameWithOwner url isPrivate visibility description isArchived isFork
          stargazerCount forkCount pushedAt updatedAt
          defaultBranchRef { name }
          primaryLanguage { name }
          repositoryTopics(first: 12) { nodes { topic { name } } }
        }
      }
    }
  }
}`;

const STAR_LISTS_QUERY = `query($cursor: String) {
  viewer {
    login
    lists(first: 50, after: $cursor) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id name slug description
        items(first: 100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on Repository { nameWithOwner }
          }
        }
      }
    }
  }
}`;

const STAR_LIST_ITEMS_QUERY = `query($listId: ID!, $cursor: String) {
  node(id: $listId) {
    ... on UserList {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on Repository { nameWithOwner }
        }
      }
    }
  }
}`;

interface RawGhRepo {
  nameWithOwner?: string;
  url?: string;
  isPrivate?: boolean;
  visibility?: string;
  description?: string | null;
  isArchived?: boolean;
  isFork?: boolean;
  stargazerCount?: number;
  forkCount?: number;
  pushedAt?: string | null;
  updatedAt?: string | null;
  defaultBranchRef?: { name?: string } | null;
  primaryLanguage?: { name?: string } | null;
  repositoryTopics?: { nodes?: Array<{ topic?: { name?: string } }> } | null;
}

function mapRawGhRepo(node: RawGhRepo, starredAt?: string | null): GitHubRepoSnapshot | null {
  const fullName = String(node.nameWithOwner ?? "").trim();
  if (!fullName || !fullName.includes("/")) return null;
  const topics = (node.repositoryTopics?.nodes ?? [])
    .map((n) => String(n.topic?.name ?? "").trim())
    .filter(Boolean);
  return {
    fullName,
    url: String(node.url ?? `https://github.com/${fullName}`),
    visibility: normalizeVisibility(node.visibility, node.isPrivate),
    description: String(node.description ?? "").trim(),
    isArchived: Boolean(node.isArchived),
    isFork: Boolean(node.isFork),
    starsCount: Number(node.stargazerCount ?? 0),
    forksCount: Number(node.forkCount ?? 0),
    pushedAt: toIso(node.pushedAt),
    repoUpdatedAt: toIso(node.updatedAt),
    starredAt: starredAt !== undefined ? toIso(starredAt) : undefined,
    defaultBranch: node.defaultBranchRef?.name ? String(node.defaultBranchRef.name) : null,
    primaryLanguage: node.primaryLanguage?.name ? String(node.primaryLanguage.name) : null,
    topics,
  };
}

async function runGhGraphql<T>(query: string, vars: Record<string, string | null> = {}): Promise<T> {
  const args = ["api", "--hostname", "github.com", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== null && v !== undefined) {
      args.push("-f", `${k}=${v}`);
    }
  }
  const { stdout } = await exec("gh", args, {
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  const parsed = JSON.parse(stdout) as { data?: T; errors?: Array<{ message?: string }> };
  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((e) => e.message || "GitHub GraphQL error").join("; "));
  }
  if (!parsed.data) throw new Error("GitHub GraphQL returned empty data");
  return parsed.data;
}

export function createGhCliFetcher(): GitHubEvolutionFetcher {
  return {
    async fetchOwnedReposPage(cursor: string | null): Promise<GitHubRepoPage> {
      const data = await runGhGraphql<{
        viewer?: {
          login?: string;
          repositories?: {
            totalCount?: number;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: RawGhRepo[];
          };
        };
      }>(OWNED_REPOS_QUERY, cursor ? { cursor } : {});
      const viewer = data.viewer;
      const conn = viewer?.repositories;
      const items = (conn?.nodes ?? [])
        .map((n) => mapRawGhRepo(n))
        .filter((x): x is GitHubRepoSnapshot => x !== null);
      return {
        login: String(viewer?.login ?? ""),
        totalCount: conn?.totalCount ?? null,
        hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
        endCursor: conn?.pageInfo?.endCursor ?? null,
        items,
      };
    },

    async fetchStarredReposPage(cursor: string | null): Promise<GitHubRepoPage> {
      const data = await runGhGraphql<{
        viewer?: {
          login?: string;
          starredRepositories?: {
            totalCount?: number;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            edges?: Array<{ starredAt?: string; node?: RawGhRepo }>;
          };
        };
      }>(STARRED_REPOS_QUERY, cursor ? { cursor } : {});
      const viewer = data.viewer;
      const conn = viewer?.starredRepositories;
      const items = (conn?.edges ?? [])
        .map((edge) => (edge.node ? mapRawGhRepo(edge.node, edge.starredAt ?? null) : null))
        .filter((x): x is GitHubRepoSnapshot => x !== null);
      return {
        login: String(viewer?.login ?? ""),
        totalCount: conn?.totalCount ?? null,
        hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
        endCursor: conn?.pageInfo?.endCursor ?? null,
        items,
      };
    },

    async fetchStarLists(): Promise<GitHubStarListSnapshot[]> {
      type StarListsResp = {
        viewer?: {
          lists?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: Array<{
              id?: string;
              name?: string;
              slug?: string;
              description?: string | null;
              items?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                nodes?: Array<{ nameWithOwner?: string }>;
              };
            }>;
          };
        };
      };
      type StarListItemsResp = {
        node?: {
          items?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: Array<{ nameWithOwner?: string }>;
          };
        };
      };
      const out: GitHubStarListSnapshot[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data: StarListsResp = await runGhGraphql<StarListsResp>(
          STAR_LISTS_QUERY,
          cursor ? { cursor } : {},
        );
        const lists = data.viewer?.lists;
        for (const list of lists?.nodes ?? []) {
          if (!list.id || !list.name) continue;
          const repos: string[] = (list.items?.nodes ?? [])
            .map((n) => String(n.nameWithOwner ?? "").trim())
            .filter(Boolean);
          let itemCursor: string | null = list.items?.pageInfo?.hasNextPage
            ? list.items.pageInfo.endCursor ?? null
            : null;
          let guard = 0;
          while (itemCursor && guard < 30) {
            guard++;
            const more: StarListItemsResp = await runGhGraphql<StarListItemsResp>(STAR_LIST_ITEMS_QUERY, {
              listId: list.id,
              cursor: itemCursor,
            });
            for (const n of more.node?.items?.nodes ?? []) {
              if (n.nameWithOwner) repos.push(String(n.nameWithOwner).trim());
            }
            itemCursor = more.node?.items?.pageInfo?.hasNextPage
              ? more.node.items.pageInfo.endCursor ?? null
              : null;
          }
          out.push({
            id: String(list.id),
            name: String(list.name),
            slug: String(list.slug || slugifyDomain(list.name)),
            description: String(list.description ?? "").trim(),
            repoFullNames: [...new Set(repos)],
          });
        }
        if (!lists?.pageInfo?.hasNextPage || !lists.pageInfo.endCursor) break;
        cursor = lists.pageInfo.endCursor;
      }
      return out;
    },

    async fetchRepoContent(repo: IndexedRepo): Promise<RepoContent> {
      return repoContent(repo);
    },

    async searchRepoContent(repo: IndexedRepo, term: string): Promise<RepoEvolutionContentSearchResult> {
      return searchRepo(repo, term);
    },
  };
}

/**
 * Dynamically creates a native pg.Pool without requiring a hard static import on pg
 * (allows compilation in worktrees before pg-infra's package.json merges, and uses real pg at runtime).
 */
export async function createRepoEvolutionPool(
  connectionString: string,
  options: { schema?: string; max?: number } = {},
): Promise<PgPoolLike> {
  const modName = "pg";
  const pgMod = (await import(modName)) as {
    default?: {
      Pool: new (cfg: Record<string, unknown>) => PgPoolLike;
      types?: { setTypeParser: (oid: number, fn: (v: string) => unknown) => void };
    };
    Pool?: new (cfg: Record<string, unknown>) => PgPoolLike;
    types?: { setTypeParser: (oid: number, fn: (v: string) => unknown) => void };
  };
  const PoolCtor = pgMod.Pool ?? pgMod.default?.Pool;
  const types = pgMod.types ?? pgMod.default?.types;
  if (!PoolCtor) {
    throw new Error("pg module is not available; install pg to run RepoEvolutionService");
  }
  types?.setTypeParser(20, (v: string) => Number(v));
  const poolCfg: Record<string, unknown> = {
    connectionString,
    max: options.max ?? 10,
  };
  if (options.schema) {
    const safeSchema = options.schema.replace(/[^a-zA-Z0-9_]/g, "_");
    poolCfg.options = `-c search_path=${safeSchema},public`;
  }
  return new PoolCtor(poolCfg);
}

// ---- Deterministic Structural Module Analyzer (Fallback & Private-Safe Engine) ----

function pickDirectoryHints(files: RepoContent["files"]): string[] {
  const priority = [
    /^src$/i,
    /^packages$/i,
    /^core$/i,
    /^server$/i,
    /^kernel$/i,
    /^agents?$/i,
    /^plugins?$/i,
    /^engine$/i,
    /^runtime$/i,
    /^lib$/i,
    /^internal$/i,
    /^cmd$/i,
    /^web$/i,
    /^app$/i,
    /^scripts$/i,
    /^docs$/i,
  ];
  const dirs = files.filter((f) => f.directory && !f.name.startsWith("."));
  const ranked = [...dirs].sort((a, b) => {
    const ai = priority.findIndex((re) => re.test(a.name));
    const bi = priority.findIndex((re) => re.test(b.name));
    const sa = ai === -1 ? 99 : ai;
    const sb = bi === -1 ? 99 : bi;
    return sa - sb || a.name.localeCompare(b.name);
  });
  return ranked.slice(0, 6).map((d) => d.name);
}

function buildEvidenceUrl(
  repoUrl: string,
  ref: string | null,
  path: string,
  isDir: boolean,
): string {
  const cleanUrl = repoUrl.replace(/\/+$/, "");
  if (!cleanUrl.startsWith("https://github.com/")) return cleanUrl;
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  if (!cleanPath || cleanPath === ".") return cleanUrl;
  const branch = ref || "HEAD";
  const kind = isDir ? "tree" : "blob";
  return `${cleanUrl}/${kind}/${branch}/${cleanPath.split("/").map(encodeURIComponent).join("/")}`;
}

function buildDeterministicModuleAnalysis(input: {
  source: RepoEvolutionNode;
  target: RepoEvolutionNode;
  relationType: RepoRelationType;
  sourceContent: RepoContent | null;
  targetContent: RepoContent | null;
}): RepoModuleAnalysisItem[] {
  const { source, target, relationType, sourceContent, targetContent } = input;
  const srcDirs = sourceContent ? pickDirectoryHints(sourceContent.files) : [];
  const tgtDirs = targetContent ? pickDirectoryHints(targetContent.files) : [];
  const srcRef = sourceContent?.ref || source.defaultBranch || "main";
  const tgtRef = targetContent?.ref || target.defaultBranch || "main";

  const srcPrimary = srcDirs[0] ? `${srcDirs[0]}/` : "src/";
  const srcSecondary = srcDirs[1] ? `${srcDirs[1]}/` : sourceContent?.readme ? "README.md" : "packages/";
  const tgtPrimary = tgtDirs[0] ? `${tgtDirs[0]}/` : "src/";
  const tgtSecondary = tgtDirs[1] ? `${tgtDirs[1]}/` : "docs/";

  const sharedTopics = source.topics.filter((t) =>
    target.topics.some((tt) => tt.toLowerCase() === t.toLowerCase()),
  );
  const topicText = sharedTopics.length
    ? `共同领域标签（${sharedTopics.slice(0, 4).join(" / ")}）`
    : source.topics.length
      ? `源仓核心标签（${source.topics.slice(0, 4).join(" / ")}）`
      : `${source.primaryLanguage || "跨语言"} 实现模式`;

  const srcDesc = source.description || source.readmeDigest?.summary || source.fullName;
  const tgtDesc = target.description || target.readmeDigest?.summary || target.fullName;

  const items: RepoModuleAnalysisItem[] = [
    {
      id: `mod_${randomUUID().slice(0, 8)}`,
      sourceModulePath: srcPrimary,
      targetModulePath: tgtPrimary,
      absorbableMechanism:
        relationType === "direct_module"
          ? `复用 ${source.name} 在 ${srcPrimary} 中的模块化抽象与接口契约（${topicText}）：${srcDesc.slice(0, 140)}`
          : `吸收 ${source.name} 在 ${srcPrimary} 中的核心编排与状态流转设计（${topicText}）：${srcDesc.slice(0, 140)}`,
      currentGap: `${target.name}（${tgtDesc.slice(0, 90)}）在 ${tgtPrimary} 尚未系统封装同等能力，存在扩展性与边界容错缺口。`,
      adaptationPlan: `保持 ${target.name} 现有主干契约不变，在 ${tgtPrimary} 下新增隔离适配层或策略模块，先以单元测试验证关键路径，再按开关灰度接入。`,
      effort: relationType === "direct_module" || relationType === "tooling_infra" ? "S" : "M",
      risk: source.primaryLanguage && target.primaryLanguage && source.primaryLanguage !== target.primaryLanguage ? "medium" : "low",
      evidenceLinks: [
        {
          label: `${source.fullName}:${srcPrimary}`,
          url: buildEvidenceUrl(source.url, srcRef, srcPrimary, true),
          path: srcPrimary,
        },
        ...(sourceContent?.readme?.url
          ? [{ label: `${source.name} README`, url: sourceContent.readme.url, path: "README.md" }]
          : []),
        {
          label: `${target.fullName}:${tgtPrimary}`,
          url: buildEvidenceUrl(target.url, tgtRef, tgtPrimary, true),
          path: tgtPrimary,
        },
      ],
    },
    {
      id: `mod_${randomUUID().slice(0, 8)}`,
      sourceModulePath: srcSecondary,
      targetModulePath: tgtSecondary,
      absorbableMechanism: `借鉴 ${source.name} 在 ${srcSecondary} 中的工程化配置、验证样本与可扩展插件约定，补齐可观测与回归基线。`,
      currentGap: `${target.name} 在 ${tgtSecondary} 缺少对照外部高星方案（★${source.starsCount}）的标准化验收对照样例与边界防护。`,
      adaptationPlan: `梳理 ${source.name} 的核心用例并在 ${tgtSecondary} 沉淀最小对照设计说明与回归测试，验证通过后再决定是否扩大吸收范围。`,
      effort: "S",
      risk: "low",
      evidenceLinks: [
        {
          label: `${source.fullName}:${srcSecondary}`,
          url: buildEvidenceUrl(source.url, srcRef, srcSecondary, srcSecondary.endsWith("/")),
          path: srcSecondary,
        },
        {
          label: `${target.fullName}:${tgtSecondary}`,
          url: buildEvidenceUrl(target.url, tgtRef, tgtSecondary, tgtSecondary.endsWith("/")),
          path: tgtSecondary,
        },
      ],
    },
  ];

  return items;
}

function parseLlmModuleAnalysis(
  rawText: string,
  source: RepoEvolutionNode,
  target: RepoEvolutionNode,
  srcRef: string,
  tgtRef: string,
): { rationale?: string; items: RepoModuleAnalysisItem[] } | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText);
  const candidate = (fenceMatch ? fenceMatch[1] : rawText).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      rationale?: unknown;
      modules?: unknown;
      moduleAnalysis?: unknown;
    };
    const arr = Array.isArray(parsed.modules)
      ? parsed.modules
      : Array.isArray(parsed.moduleAnalysis)
        ? parsed.moduleAnalysis
        : null;
    if (!arr || arr.length === 0) return null;
    const items: RepoModuleAnalysisItem[] = [];
    for (const raw of arr.slice(0, 6)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const sourceModulePath = String(r.sourceModulePath ?? "").trim();
      const targetModulePath = String(r.targetModulePath ?? "").trim();
      const absorbableMechanism = String(r.absorbableMechanism ?? "").trim();
      const currentGap = String(r.currentGap ?? "").trim();
      if (!sourceModulePath || !targetModulePath || !absorbableMechanism) continue;
      const effortRaw = String(r.effort ?? "M").toUpperCase();
      const effort: RepoModuleEffort = effortRaw === "S" || effortRaw === "L" ? effortRaw : "M";
      const riskRaw = String(r.risk ?? "medium").toLowerCase();
      const risk: RepoModuleRisk = riskRaw === "low" || riskRaw === "high" ? riskRaw : "medium";
      const rawEvidence = Array.isArray(r.evidenceLinks) ? r.evidenceLinks : [];
      const evidenceLinks: RepoEvidenceLink[] = rawEvidence
        .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === "object"))
        .map((e) => ({
          label: String(e.label ?? e.path ?? "源码证据").trim(),
          url: String(e.url ?? "").trim(),
          path: e.path ? String(e.path).trim() : undefined,
        }))
        .filter((e) => e.url.startsWith("https://") || e.url.startsWith("http://"));

      if (evidenceLinks.length === 0) {
        evidenceLinks.push(
          {
            label: `${source.fullName}:${sourceModulePath}`,
            url: buildEvidenceUrl(source.url, srcRef, sourceModulePath, sourceModulePath.endsWith("/")),
            path: sourceModulePath,
          },
          {
            label: `${target.fullName}:${targetModulePath}`,
            url: buildEvidenceUrl(target.url, tgtRef, targetModulePath, targetModulePath.endsWith("/")),
            path: targetModulePath,
          },
        );
      }
      items.push({
        id: `mod_${randomUUID().slice(0, 8)}`,
        sourceModulePath,
        targetModulePath,
        absorbableMechanism,
        currentGap: currentGap || `当前 ${target.name} 在 ${targetModulePath} 缺少对应机制。`,
        adaptationPlan: String(r.adaptationPlan ?? "按最小增量模块接入并补充确定性测试。").trim(),
        effort,
        risk,
        evidenceLinks,
      });
    }
    if (items.length === 0) return null;
    return {
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim() : undefined,
      items,
    };
  } catch {
    return null;
  }
}

// ---- Zod Validation Schemas ----

const relationTypeEnum = z.enum([
  "architecture_pattern",
  "direct_module",
  "algorithm_idea",
  "ux_workflow",
  "tooling_infra",
  "benchmark_ref",
  "inspiration",
]);

const absorptionStatusEnum = z.enum([
  "suggested",
  "watching",
  "in_review",
  "approved",
  "absorbing",
  "absorbed",
  "rejected",
]);

const priorityTierEnum = z.enum(["spotlight", "standard", "archived"]);

const moduleAnalysisItemSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  sourceModulePath: z.string().trim().min(1).max(300),
  targetModulePath: z.string().trim().min(1).max(300),
  absorbableMechanism: z.string().trim().min(1).max(2000),
  currentGap: z.string().trim().max(2000).default(""),
  adaptationPlan: z.string().trim().max(2000).default(""),
  effort: z.enum(["S", "M", "L"]).default("M"),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  evidenceLinks: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        url: z.string().trim().min(1).max(1000),
        path: z.string().trim().max(300).optional(),
      }),
    )
    .max(12)
    .default([]),
});

const createDomainSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).default(""),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/).default("#6366f1"),
  icon: z.string().trim().min(1).max(40).default("layers"),
  seedKeywords: z.array(z.string().trim().min(1).max(60)).max(60).default([]),
});

const updateDomainSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  icon: z.string().trim().min(1).max(40).optional(),
  seedKeywords: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

const mergeDomainsSchema = z.object({
  sourceDomainId: z.string().trim().min(1).max(120),
  targetDomainId: z.string().trim().min(1).max(120),
});

const updateNodeSchema = z.object({
  primaryDomainId: z.string().trim().min(1).max(120).nullable().optional(),
  secondaryDomainIds: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  priorityTier: priorityTierEnum.optional(),
  allowLlmAnalysis: z.boolean().optional(),
  notes: z.string().trim().max(4000).optional(),
});

const registerNodeSchema = z.object({
  fullName: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/).max(160),
  role: z.enum(["owned", "starred", "both"]).default("owned"),
  visibility: z.enum(["public", "private", "internal"]).default("public"),
  priorityTier: priorityTierEnum.default("spotlight"),
  description: z.string().trim().max(1000).default(""),
  primaryLanguage: z.string().trim().max(60).nullable().default(null),
  topics: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  allowLlmAnalysis: z.boolean().optional(),
});

const batchUpdateNodesSchema = z.object({
  nodeIds: z.array(z.string().trim().min(1).max(120)).min(1).max(500),
  action: z.enum([
    "assign_domain",
    "clear_domain",
    "archive_stale",
    "restore_standard",
    "set_spotlight",
    "set_allow_llm",
  ]),
  domainId: z.string().trim().min(1).max(120).nullable().optional(),
  allowLlmAnalysis: z.boolean().optional(),
});

const createLinkSchema = z.object({
  sourceNodeId: z.string().trim().min(1).max(160),
  targetNodeId: z.string().trim().min(1).max(160),
  relationType: relationTypeEnum.default("architecture_pattern"),
  status: absorptionStatusEnum.optional(),
  strength: z.number().min(0).max(1).default(0.72),
  rationale: z.string().trim().max(3000).default(""),
  moduleAnalysis: z.array(moduleAnalysisItemSchema).max(20).optional(),
});

const bulkLinksSchema = z.object({
  targetNodeIds: z.array(z.string().trim().min(1).max(160)).min(1).max(50),
  relationType: relationTypeEnum.default("architecture_pattern"),
  rationale: z.string().trim().max(2000).default(""),
});

const updateLinkSchema = z.object({
  relationType: relationTypeEnum.optional(),
  status: absorptionStatusEnum.optional(),
  strength: z.number().min(0).max(1).optional(),
  rationale: z.string().trim().max(3000).optional(),
  moduleAnalysis: z.array(moduleAnalysisItemSchema).max(20).optional(),
});

const triggerSyncSchema = z.object({
  mode: z.enum(["incremental", "full", "owned_only", "stars_only"]).default("incremental"),
  resumeJobId: z.string().trim().min(1).max(120).optional(),
  maxPages: z.number().int().min(1).max(500).optional(),
});

const clusterRecallSchema = z.object({
  recomputeEmbeddings: z.boolean().default(false),
  reclassifyAi: z.boolean().default(false),
  maxNewLinksPerOwned: z.number().int().min(1).max(50).optional(),
  focusOwnedNodeId: z.string().trim().min(1).max(160).optional(),
});

const analyzeLinkSchema = z.object({
  force: z.boolean().default(false),
  allowPrivateOverride: z.boolean().default(false),
});

const submitMailboxSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  recommendedOption: z.enum(["approve", "watch", "reject"]).optional(),
});

const promoteOpportunitySchema = z.object({
  pipeline: z.enum(["quick", "full-product"]).default("quick"),
  title: z.string().trim().min(1).max(200).optional(),
  rationale: z.string().trim().min(1).max(1000).optional(),
});

const updateConfigSchema = z.object({
  spotlightRepos: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  automationMode: z.enum(["mailbox_review", "auto_opportunity", "full_auto"]).optional(),
  staleMonths: z.number().int().min(3).max(120).optional(),
  dormantMonths: z.number().int().min(1).max(60).optional(),
  minClusterSimilarity: z.number().min(0.05).max(0.95).optional(),
  minLinkSimilarity: z.number().min(0.05).max(0.95).optional(),
  spotlightBonus: z.number().min(0).max(0.3).optional(),
  allowPrivateLlmByDefault: z.boolean().optional(),
});

function parseInput<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.output<T> {
  const res = schema.safeParse(raw ?? {});
  if (!res.success) {
    throw new ApiError(
      400,
      "repo_evolution_invalid_input",
      res.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join(" / "),
    );
  }
  return res.data;
}

// ---- Core Service ----

export class RepoEvolutionService {
  private pool: PgPoolLike;
  private decisions?: DecisionGateway;
  private providers?: ProvidersStore;
  private opportunities?: OpportunityStore;
  private github: GitHubEvolutionFetcher;
  private llmCaller: typeof callConfiguredLLM;
  private now: () => number;
  private initPromise: Promise<void> | null = null;
  private activeSyncPromise: Promise<RepoEvolutionSyncJob> | null = null;
  private handlersRegistered = false;

  constructor(options: RepoEvolutionServiceOptions) {
    this.pool = options.pool;
    this.decisions = options.decisions;
    this.providers = options.providers;
    this.opportunities = options.opportunities;
    this.github = options.github ?? createGhCliFetcher();
    this.llmCaller = options.llmCaller ?? callConfiguredLLM;
    this.now = options.now ?? (() => Date.now());
    if (this.decisions) {
      this.registerDecisionHandlers(this.decisions);
    }
  }

  attachDecisionGateway(decisions: DecisionGateway): void {
    this.decisions = decisions;
    this.registerDecisionHandlers(decisions);
  }

  attachOpportunityStore(opportunities: OpportunityStore): void {
    this.opportunities = opportunities;
  }

  attachProvidersStore(providers: ProvidersStore): void {
    this.providers = providers;
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.bootstrapSchema().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    await this.initPromise;
  }

  private async bootstrapSchema(): Promise<void> {
    try {
      await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch {
      // Extension may already be installed by superuser in public schema.
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repo_domains (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#6366f1',
        icon TEXT NOT NULL DEFAULT 'layers',
        seed_keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        source TEXT NOT NULL DEFAULT 'custom',
        github_list_id TEXT UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 100,
        centroid vector(${REPO_EVOLUTION_VECTOR_DIM}),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repo_evolution_nodes (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL UNIQUE,
        full_name_lower TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owned', 'starred', 'both')),
        visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private', 'internal')),
        vitality TEXT NOT NULL DEFAULT 'active' CHECK (vitality IN ('active', 'dormant', 'stale', 'archived')),
        priority_tier TEXT NOT NULL DEFAULT 'standard' CHECK (priority_tier IN ('spotlight', 'standard', 'archived')),
        description TEXT NOT NULL DEFAULT '',
        primary_language TEXT,
        topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        stars_count INTEGER NOT NULL DEFAULT 0,
        forks_count INTEGER NOT NULL DEFAULT 0,
        is_fork BOOLEAN NOT NULL DEFAULT FALSE,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        default_branch TEXT,
        pushed_at TIMESTAMPTZ,
        starred_at TIMESTAMPTZ,
        repo_updated_at TIMESTAMPTZ,
        primary_domain_id TEXT REFERENCES repo_domains(id) ON DELETE SET NULL,
        domain_confidence DOUBLE PRECISION,
        domain_assigned_by TEXT NOT NULL DEFAULT 'unassigned'
          CHECK (domain_assigned_by IN ('manual', 'ai', 'github_list', 'unassigned')),
        allow_llm_analysis BOOLEAN NOT NULL DEFAULT TRUE,
        readme_sha TEXT,
        readme_digest_json JSONB,
        embedding vector(${REPO_EVOLUTION_VECTOR_DIM}),
        embedding_source TEXT,
        notes TEXT NOT NULL DEFAULT '',
        last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repo_evo_nodes_role ON repo_evolution_nodes(role);
      CREATE INDEX IF NOT EXISTS idx_repo_evo_nodes_domain ON repo_evolution_nodes(primary_domain_id);
      CREATE INDEX IF NOT EXISTS idx_repo_evo_nodes_vitality ON repo_evolution_nodes(vitality);
      CREATE INDEX IF NOT EXISTS idx_repo_evo_nodes_priority ON repo_evolution_nodes(priority_tier);
      CREATE INDEX IF NOT EXISTS idx_repo_evo_nodes_starred_at ON repo_evolution_nodes(starred_at DESC NULLS LAST);
      CREATE INDEX IF NOT EXISTS idx_repo_evo_nodes_pushed_at ON repo_evolution_nodes(pushed_at DESC NULLS LAST);
      CREATE INDEX IF NOT EXISTS idx_repo_evo_nodes_embedding_hnsw
        ON repo_evolution_nodes USING hnsw (embedding vector_cosine_ops);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repo_evolution_node_domains (
        node_id TEXT NOT NULL REFERENCES repo_evolution_nodes(id) ON DELETE CASCADE,
        domain_id TEXT NOT NULL REFERENCES repo_domains(id) ON DELETE CASCADE,
        confidence DOUBLE PRECISION,
        assigned_by TEXT NOT NULL DEFAULT 'manual',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (node_id, domain_id)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_evo_node_domains_domain ON repo_evolution_node_domains(domain_id);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repo_absorption_links (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL REFERENCES repo_evolution_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES repo_evolution_nodes(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL DEFAULT 'architecture_pattern',
        status TEXT NOT NULL DEFAULT 'suggested'
          CHECK (status IN ('suggested', 'watching', 'in_review', 'approved', 'absorbing', 'absorbed', 'rejected')),
        strength DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        rationale TEXT NOT NULL DEFAULT '',
        module_analysis_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        analysis_source TEXT,
        analyzed_at TIMESTAMPTZ,
        decision_packet_id TEXT,
        opportunity_id TEXT,
        created_by TEXT NOT NULL DEFAULT 'ai' CHECK (created_by IN ('ai', 'manual')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source_node_id, target_node_id),
        CHECK (source_node_id <> target_node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_abs_links_source ON repo_absorption_links(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_repo_abs_links_target ON repo_absorption_links(target_node_id);
      CREATE INDEX IF NOT EXISTS idx_repo_abs_links_status ON repo_absorption_links(status);
      CREATE INDEX IF NOT EXISTS idx_repo_abs_links_decision ON repo_absorption_links(decision_packet_id);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repo_absorption_events (
        id TEXT PRIMARY KEY,
        link_id TEXT REFERENCES repo_absorption_links(id) ON DELETE SET NULL,
        source_node_id TEXT REFERENCES repo_evolution_nodes(id) ON DELETE SET NULL,
        target_node_id TEXT REFERENCES repo_evolution_nodes(id) ON DELETE SET NULL,
        domain_id TEXT REFERENCES repo_domains(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT 'system',
        decision_packet_id TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_repo_abs_events_created ON repo_absorption_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_repo_abs_events_target ON repo_absorption_events(target_node_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_repo_abs_events_domain ON repo_absorption_events(domain_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_repo_abs_events_link ON repo_absorption_events(link_id, created_at DESC);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repo_evolution_sync_jobs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'incremental',
        status TEXT NOT NULL DEFAULT 'queued',
        phase TEXT NOT NULL DEFAULT 'init',
        github_login TEXT,
        owned_fetched INTEGER NOT NULL DEFAULT 0,
        owned_total INTEGER,
        starred_fetched INTEGER NOT NULL DEFAULT 0,
        starred_total INTEGER,
        lists_fetched INTEGER NOT NULL DEFAULT 0,
        embeddings_computed INTEGER NOT NULL DEFAULT 0,
        pages_processed INTEGER NOT NULL DEFAULT 0,
        cursor TEXT,
        early_stopped BOOLEAN NOT NULL DEFAULT FALSE,
        error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_repo_evo_sync_jobs_started ON repo_evolution_sync_jobs(started_at DESC);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS repo_evolution_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        spotlight_repos_json JSONB NOT NULL DEFAULT '["ai-agent-node"]'::jsonb,
        automation_mode TEXT NOT NULL DEFAULT 'mailbox_review',
        stale_months INTEGER NOT NULL DEFAULT 24,
        dormant_months INTEGER NOT NULL DEFAULT 12,
        min_cluster_similarity DOUBLE PRECISION NOT NULL DEFAULT 0.24,
        min_link_similarity DOUBLE PRECISION NOT NULL DEFAULT 0.26,
        spotlight_bonus DOUBLE PRECISION NOT NULL DEFAULT 0.08,
        allow_private_llm_by_default BOOLEAN NOT NULL DEFAULT FALSE,
        seeded_domains BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const cfgRow = await this.pool.query<{ seeded_domains?: boolean }>(
      `INSERT INTO repo_evolution_config (singleton, spotlight_repos_json, automation_mode)
       VALUES (1, '["ai-agent-node"]'::jsonb, 'mailbox_review')
       ON CONFLICT (singleton) DO NOTHING
       RETURNING seeded_domains`,
    );
    const currentCfg = cfgRow.rows[0]
      ? cfgRow.rows[0]
      : (
          await this.pool.query<{ seeded_domains?: boolean }>(
            "SELECT seeded_domains FROM repo_evolution_config WHERE singleton = 1",
          )
        ).rows[0];

    if (!currentCfg?.seeded_domains) {
      const existing = await this.pool.query<{ n: number }>("SELECT COUNT(*) AS n FROM repo_domains");
      if (Number(existing.rows[0]?.n ?? 0) === 0) {
        for (const seed of BUILTIN_REPO_DOMAINS) {
          const centroid = localSemanticVector(
            `${seed.name} ${seed.description} ${seed.seedKeywords.join(" ")}`,
            REPO_EVOLUTION_VECTOR_DIM,
          );
          await this.pool.query(
            `INSERT INTO repo_domains
              (id, slug, name, description, color, icon, seed_keywords_json, source, sort_order, centroid)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'builtin', $8, $9::vector)
             ON CONFLICT (slug) DO NOTHING`,
            [
              domainIdFromSlug(seed.slug),
              seed.slug,
              seed.name,
              seed.description,
              seed.color,
              seed.icon,
              JSON.stringify(seed.seedKeywords),
              seed.sortOrder,
              toPgVectorLiteral(centroid, "local"),
            ],
          );
        }
      }
      await this.pool.query("UPDATE repo_evolution_config SET seeded_domains = TRUE WHERE singleton = 1");
    }
  }

  private registerDecisionHandlers(decisions: DecisionGateway): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    decisions.registerHandler("product.repo_absorption_approve", async ({ packet, option, note, actor }) => {
      await this.init();
      const linkId = String(option.payload?.linkId ?? "").trim();
      if (!linkId) throw new ApiError(400, "missing_link_id", "审批载荷缺少 linkId");
      const link = await this.getLink(linkId);
      const nowIso = new Date(this.now()).toISOString();
      await this.pool.query(
        `UPDATE repo_absorption_links
         SET status = 'approved', decision_packet_id = $1, updated_at = $2
         WHERE id = $3`,
        [packet.id, nowIso, linkId],
      );
      await this.recordEvent({
        linkId,
        sourceNodeId: link.sourceNodeId,
        targetNodeId: link.targetNodeId,
        domainId: link.sourceNode?.primaryDomainId ?? null,
        eventType: "decision_approved",
        title: `总裁批准吸收：${link.sourceRepoFullName} → ${link.targetRepoFullName}`,
        summary: note || `已通过总裁信箱批准吸收提案（${link.moduleAnalysis.length} 个模块切入点）。`,
        actor,
        decisionPacketId: packet.id,
        metadata: { optionId: option.id, moduleCount: link.moduleAnalysis.length },
      });

      const config = await this.getConfig();
      let opportunityId: string | null = link.opportunityId;
      if (config.automationMode === "auto_opportunity" && this.opportunities && !opportunityId) {
        const promoted = await this.promoteLinkToOpportunity(linkId, {}, actor);
        opportunityId = promoted.opportunityId;
      }

      return {
        action: "approved",
        linkId,
        status: "approved",
        automationMode: config.automationMode,
        opportunityId,
      };
    });

    decisions.registerHandler("product.repo_absorption_watch", async ({ packet, option, note, actor }) => {
      await this.init();
      const linkId = String(option.payload?.linkId ?? "").trim();
      if (!linkId) throw new ApiError(400, "missing_link_id", "审批载荷缺少 linkId");
      const link = await this.getLink(linkId);
      const nowIso = new Date(this.now()).toISOString();
      await this.pool.query(
        `UPDATE repo_absorption_links
         SET status = 'watching', decision_packet_id = $1, updated_at = $2
         WHERE id = $3`,
        [packet.id, nowIso, linkId],
      );
      await this.recordEvent({
        linkId,
        sourceNodeId: link.sourceNodeId,
        targetNodeId: link.targetNodeId,
        domainId: link.sourceNode?.primaryDomainId ?? null,
        eventType: "decision_watching",
        title: `暂存观察：${link.sourceRepoFullName} → ${link.targetRepoFullName}`,
        summary: note || "创始人批示暂存观察，保留图谱关联待后续复评。",
        actor,
        decisionPacketId: packet.id,
        metadata: { optionId: option.id },
      });
      return { action: "watching", linkId, status: "watching" };
    });

    decisions.registerHandler("product.repo_absorption_reject", async ({ packet, option, note, actor }) => {
      await this.init();
      const linkId = String(option.payload?.linkId ?? "").trim();
      if (!linkId) throw new ApiError(400, "missing_link_id", "审批载荷缺少 linkId");
      const link = await this.getLink(linkId);
      const nowIso = new Date(this.now()).toISOString();
      await this.pool.query(
        `UPDATE repo_absorption_links
         SET status = 'rejected', decision_packet_id = $1, updated_at = $2
         WHERE id = $3`,
        [packet.id, nowIso, linkId],
      );
      await this.recordEvent({
        linkId,
        sourceNodeId: link.sourceNodeId,
        targetNodeId: link.targetNodeId,
        domainId: link.sourceNode?.primaryDomainId ?? null,
        eventType: "decision_rejected",
        title: `驳回不吸收：${link.sourceRepoFullName} → ${link.targetRepoFullName}`,
        summary: note || "创始人驳回该吸收建议，后续 AI 扫描将自动跳过此组合。",
        actor,
        decisionPacketId: packet.id,
        metadata: { optionId: option.id },
      });
      return { action: "rejected", linkId, status: "rejected" };
    });
  }

  // ---- Config ----

  async getConfig(): Promise<RepoEvolutionConfig> {
    await this.init();
    const res = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM repo_evolution_config WHERE singleton = 1",
    );
    const row = res.rows[0];
    if (!row) {
      return {
        spotlightRepos: ["ai-agent-node"],
        automationMode: "mailbox_review",
        staleMonths: 24,
        dormantMonths: 12,
        minClusterSimilarity: 0.24,
        minLinkSimilarity: 0.26,
        spotlightBonus: 0.08,
        allowPrivateLlmByDefault: false,
        updatedAt: new Date(this.now()).toISOString(),
      };
    }
    return {
      spotlightRepos: safeJson<string[]>(row.spotlight_repos_json, ["ai-agent-node"]),
      automationMode: (String(row.automation_mode ?? "mailbox_review") as RepoEvolutionAutomationMode),
      staleMonths: Number(row.stale_months ?? 24),
      dormantMonths: Number(row.dormant_months ?? 12),
      minClusterSimilarity: Number(row.min_cluster_similarity ?? 0.24),
      minLinkSimilarity: Number(row.min_link_similarity ?? 0.26),
      spotlightBonus: Number(row.spotlight_bonus ?? 0.08),
      allowPrivateLlmByDefault: Boolean(row.allow_private_llm_by_default),
      updatedAt: toIso(row.updated_at) ?? new Date(this.now()).toISOString(),
    };
  }

  async updateConfig(raw: UpdateRepoEvolutionConfigInput): Promise<RepoEvolutionConfig> {
    await this.init();
    const patch = parseInput(updateConfigSchema, raw);
    const cur = await this.getConfig();
    const next: RepoEvolutionConfig = {
      spotlightRepos: patch.spotlightRepos !== undefined
        ? [...new Set(patch.spotlightRepos.map((s) => s.trim()).filter(Boolean))]
        : cur.spotlightRepos,
      automationMode: patch.automationMode ?? cur.automationMode,
      staleMonths: patch.staleMonths ?? cur.staleMonths,
      dormantMonths: patch.dormantMonths ?? cur.dormantMonths,
      minClusterSimilarity: patch.minClusterSimilarity ?? cur.minClusterSimilarity,
      minLinkSimilarity: patch.minLinkSimilarity ?? cur.minLinkSimilarity,
      spotlightBonus: patch.spotlightBonus ?? cur.spotlightBonus,
      allowPrivateLlmByDefault: patch.allowPrivateLlmByDefault ?? cur.allowPrivateLlmByDefault,
      updatedAt: new Date(this.now()).toISOString(),
    };
    if (next.dormantMonths >= next.staleMonths) {
      throw new ApiError(400, "bad_vitality_thresholds", "dormantMonths 必须小于 staleMonths");
    }

    await this.pool.query(
      `UPDATE repo_evolution_config
       SET spotlight_repos_json = $1::jsonb,
           automation_mode = $2,
           stale_months = $3,
           dormant_months = $4,
           min_cluster_similarity = $5,
           min_link_similarity = $6,
           spotlight_bonus = $7,
           allow_private_llm_by_default = $8,
           updated_at = $9
       WHERE singleton = 1`,
      [
        JSON.stringify(next.spotlightRepos),
        next.automationMode,
        next.staleMonths,
        next.dormantMonths,
        next.minClusterSimilarity,
        next.minLinkSimilarity,
        next.spotlightBonus,
        next.allowPrivateLlmByDefault,
        next.updatedAt,
      ],
    );

    // Re-evaluate spotlight tier on owned nodes when spotlightRepos changes
    if (patch.spotlightRepos !== undefined) {
      const ownedRes = await this.pool.query<{ id: string; full_name: string; name: string; priority_tier: string }>(
        "SELECT id, full_name, name, priority_tier FROM repo_evolution_nodes WHERE role IN ('owned', 'both')",
      );
      for (const row of ownedRes.rows) {
        const shouldSpotlight = matchesSpotlightRepo(row.full_name, row.name, next.spotlightRepos);
        if (shouldSpotlight && row.priority_tier !== "spotlight") {
          await this.pool.query(
            "UPDATE repo_evolution_nodes SET priority_tier = 'spotlight', updated_at = $1 WHERE id = $2",
            [next.updatedAt, row.id],
          );
        } else if (!shouldSpotlight && row.priority_tier === "spotlight") {
          await this.pool.query(
            "UPDATE repo_evolution_nodes SET priority_tier = 'standard', updated_at = $1 WHERE id = $2",
            [next.updatedAt, row.id],
          );
        }
      }
    }

    // Re-evaluate vitality when stale/dormant thresholds change
    if (patch.staleMonths !== undefined || patch.dormantMonths !== undefined) {
      const nodesRes = await this.pool.query<{ id: string; is_archived: boolean; pushed_at: unknown; vitality: string }>(
        "SELECT id, is_archived, pushed_at, vitality FROM repo_evolution_nodes",
      );
      const nowMs = this.now();
      for (const row of nodesRes.rows) {
        const v = computeRepoVitality(Boolean(row.is_archived), toIso(row.pushed_at), next, nowMs);
        if (v !== row.vitality) {
          await this.pool.query(
            "UPDATE repo_evolution_nodes SET vitality = $1, updated_at = $2 WHERE id = $3",
            [v, next.updatedAt, row.id],
          );
        }
      }
    }

    return next;
  }

  // ---- Domains CRUD & GitHub Star Lists ----

  private mapDomain(row: Record<string, unknown>): RepoDomain {
    return {
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      description: String(row.description ?? ""),
      color: String(row.color ?? "#6366f1"),
      icon: String(row.icon ?? "layers"),
      seedKeywords: safeJson<string[]>(row.seed_keywords_json, []),
      source: (String(row.source ?? "custom") as RepoDomainSource),
      githubListId: row.github_list_id ? String(row.github_list_id) : null,
      sortOrder: Number(row.sort_order ?? 100),
      createdAt: toIso(row.created_at) ?? new Date(this.now()).toISOString(),
      updatedAt: toIso(row.updated_at) ?? new Date(this.now()).toISOString(),
    };
  }

  async listDomainClusters(): Promise<RepoDomainCluster[]> {
    await this.init();
    const domRes = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM repo_domains ORDER BY sort_order ASC, name ASC",
    );
    const domains = domRes.rows.map((r) => this.mapDomain(r));
    if (domains.length === 0) return [];

    const statsRes = await this.pool.query<Record<string, unknown>>(`
      SELECT
        n.primary_domain_id AS domain_id,
        COUNT(*)::int AS total_nodes,
        COUNT(*) FILTER (WHERE n.vitality = 'active')::int AS active_nodes,
        COUNT(*) FILTER (WHERE n.vitality = 'dormant')::int AS dormant_nodes,
        COUNT(*) FILTER (WHERE n.vitality = 'stale')::int AS stale_nodes,
        COUNT(*) FILTER (WHERE n.vitality = 'archived')::int AS archived_nodes,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM repo_absorption_links l
          WHERE l.source_node_id = n.id AND l.status <> 'rejected'
        ))::int AS linked_nodes
      FROM repo_evolution_nodes n
      WHERE n.primary_domain_id IS NOT NULL AND n.role IN ('starred', 'both')
      GROUP BY n.primary_domain_id
    `);
    const nodeStatsByDom = new Map<string, Record<string, unknown>>();
    for (const r of statsRes.rows) nodeStatsByDom.set(String(r.domain_id), r);

    const linkStatsRes = await this.pool.query<Record<string, unknown>>(`
      SELECT
        n.primary_domain_id AS domain_id,
        COUNT(*) FILTER (WHERE l.status = 'suggested')::int AS suggested_links,
        COUNT(*) FILTER (WHERE l.status = 'in_review')::int AS in_review_links,
        COUNT(*) FILTER (WHERE l.status = 'approved')::int AS approved_links,
        COUNT(*) FILTER (WHERE l.status = 'absorbed')::int AS absorbed_links
      FROM repo_absorption_links l
      JOIN repo_evolution_nodes n ON n.id = l.source_node_id
      WHERE n.primary_domain_id IS NOT NULL
      GROUP BY n.primary_domain_id
    `);
    const linkStatsByDom = new Map<string, Record<string, unknown>>();
    for (const r of linkStatsRes.rows) linkStatsByDom.set(String(r.domain_id), r);

    const langRes = await this.pool.query<Record<string, unknown>>(`
      SELECT primary_domain_id AS domain_id, primary_language, COUNT(*)::int AS cnt
      FROM repo_evolution_nodes
      WHERE primary_domain_id IS NOT NULL AND primary_language IS NOT NULL AND role IN ('starred', 'both')
      GROUP BY primary_domain_id, primary_language
      ORDER BY primary_domain_id, cnt DESC
    `);
    const langsByDom = new Map<string, string[]>();
    for (const r of langRes.rows) {
      const domId = String(r.domain_id);
      const list = langsByDom.get(domId) ?? [];
      if (list.length < 4 && r.primary_language) list.push(String(r.primary_language));
      langsByDom.set(domId, list);
    }

    const sampleRes = await this.pool.query<Record<string, unknown>>(`
      SELECT ranked.*, d.name AS domain_name, d.color AS domain_color
      FROM (
        SELECT n.*, ROW_NUMBER() OVER (PARTITION BY n.primary_domain_id ORDER BY n.stars_count DESC, n.pushed_at DESC NULLS LAST) AS rn
        FROM repo_evolution_nodes n
        WHERE n.primary_domain_id IS NOT NULL AND n.role IN ('starred', 'both')
      ) ranked
      LEFT JOIN repo_domains d ON d.id = ranked.primary_domain_id
      WHERE ranked.rn <= 5
    `);
    const samplesByDom = new Map<string, RepoNodeBrief[]>();
    for (const r of sampleRes.rows) {
      const domId = String(r.primary_domain_id);
      const arr = samplesByDom.get(domId) ?? [];
      arr.push(this.mapNodeBrief(r));
      samplesByDom.set(domId, arr);
    }

    return domains.map((d) => {
      const ns = nodeStatsByDom.get(d.id);
      const ls = linkStatsByDom.get(d.id);
      return {
        ...d,
        totalNodes: Number(ns?.total_nodes ?? 0),
        activeNodes: Number(ns?.active_nodes ?? 0),
        dormantNodes: Number(ns?.dormant_nodes ?? 0),
        staleNodes: Number(ns?.stale_nodes ?? 0),
        archivedNodes: Number(ns?.archived_nodes ?? 0),
        linkedNodes: Number(ns?.linked_nodes ?? 0),
        suggestedLinks: Number(ls?.suggested_links ?? 0),
        inReviewLinks: Number(ls?.in_review_links ?? 0),
        approvedLinks: Number(ls?.approved_links ?? 0),
        absorbedLinks: Number(ls?.absorbed_links ?? 0),
        topLanguages: langsByDom.get(d.id) ?? [],
        sampleRepos: samplesByDom.get(d.id) ?? [],
      };
    });
  }

  async createDomain(raw: CreateRepoDomainInput): Promise<RepoDomain> {
    await this.init();
    const input = parseInput(createDomainSchema, raw);
    const slug = slugifyDomain(input.slug ?? input.name);
    const existing = await this.pool.query("SELECT id FROM repo_domains WHERE slug = $1", [slug]);
    if (existing.rows.length > 0) {
      throw new ApiError(409, "domain_exists", `领域标识 "${slug}" 已存在`);
    }
    const id = domainIdFromSlug(slug);
    const nowIso = new Date(this.now()).toISOString();
    const centroid = localSemanticVector(
      `${input.name} ${input.description} ${input.seedKeywords.join(" ")}`,
      REPO_EVOLUTION_VECTOR_DIM,
    );
    const res = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO repo_domains
        (id, slug, name, description, color, icon, seed_keywords_json, source, sort_order, centroid, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'custom', 200, $8::vector, $9, $9)
       RETURNING *`,
      [
        id,
        slug,
        input.name,
        input.description,
        input.color,
        input.icon,
        JSON.stringify(input.seedKeywords),
        toPgVectorLiteral(centroid, "local"),
        nowIso,
      ],
    );
    return this.mapDomain(res.rows[0]!);
  }

  async updateDomain(id: string, raw: UpdateRepoDomainInput): Promise<RepoDomain> {
    await this.init();
    const patch = parseInput(updateDomainSchema, raw);
    const curRes = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM repo_domains WHERE id = $1 OR slug = $1 LIMIT 1",
      [id],
    );
    if (!curRes.rows[0]) throw new ApiError(404, "domain_not_found", "未找到该领域");
    const cur = this.mapDomain(curRes.rows[0]);
    const nextName = patch.name ?? cur.name;
    const nextDesc = patch.description ?? cur.description;
    const nextColor = patch.color ?? cur.color;
    const nextIcon = patch.icon ?? cur.icon;
    const nextKeywords = patch.seedKeywords ?? cur.seedKeywords;
    const nextSortOrder = patch.sortOrder ?? cur.sortOrder;
    const nowIso = new Date(this.now()).toISOString();
    const centroid = localSemanticVector(
      `${nextName} ${nextDesc} ${nextKeywords.join(" ")}`,
      REPO_EVOLUTION_VECTOR_DIM,
    );
    const res = await this.pool.query<Record<string, unknown>>(
      `UPDATE repo_domains
       SET name = $1, description = $2, color = $3, icon = $4,
           seed_keywords_json = $5::jsonb, sort_order = $6,
           centroid = $7::vector, updated_at = $8
       WHERE id = $9
       RETURNING *`,
      [
        nextName,
        nextDesc,
        nextColor,
        nextIcon,
        JSON.stringify(nextKeywords),
        nextSortOrder,
        toPgVectorLiteral(centroid, "local"),
        nowIso,
        cur.id,
      ],
    );
    return this.mapDomain(res.rows[0]!);
  }

  async deleteDomain(id: string): Promise<{ ok: true; id: string }> {
    await this.init();
    const curRes = await this.pool.query<{ id: string }>(
      "SELECT id FROM repo_domains WHERE id = $1 OR slug = $1 LIMIT 1",
      [id],
    );
    if (!curRes.rows[0]) throw new ApiError(404, "domain_not_found", "未找到该领域");
    const domId = curRes.rows[0].id;
    await this.pool.query(
      "UPDATE repo_evolution_nodes SET primary_domain_id = NULL, domain_assigned_by = 'unassigned', domain_confidence = NULL WHERE primary_domain_id = $1",
      [domId],
    );
    await this.pool.query("DELETE FROM repo_domains WHERE id = $1", [domId]);
    return { ok: true, id: domId };
  }

  async mergeDomains(raw: MergeRepoDomainsInput): Promise<{ targetDomain: RepoDomain; movedNodes: number }> {
    await this.init();
    const { sourceDomainId, targetDomainId } = parseInput(mergeDomainsSchema, raw);
    if (sourceDomainId === targetDomainId) {
      throw new ApiError(400, "domain_merge_same", "源领域与目标领域不能相同");
    }
    const srcRes = await this.pool.query<Record<string, unknown>>("SELECT * FROM repo_domains WHERE id = $1", [sourceDomainId]);
    const tgtRes = await this.pool.query<Record<string, unknown>>("SELECT * FROM repo_domains WHERE id = $1", [targetDomainId]);
    if (!srcRes.rows[0] || !tgtRes.rows[0]) {
      throw new ApiError(404, "domain_not_found", "源领域或目标领域不存在");
    }
    const src = this.mapDomain(srcRes.rows[0]);
    const tgt = this.mapDomain(tgtRes.rows[0]);
    const nowIso = new Date(this.now()).toISOString();

    const moved = await this.pool.query<{ id: string }>(
      `UPDATE repo_evolution_nodes
       SET primary_domain_id = $1, updated_at = $2
       WHERE primary_domain_id = $3
       RETURNING id`,
      [tgt.id, nowIso, src.id],
    );

    // Move secondary domain mappings cleanly without PK collision
    await this.pool.query(
      `INSERT INTO repo_evolution_node_domains (node_id, domain_id, confidence, assigned_by)
       SELECT node_id, $1, confidence, assigned_by
       FROM repo_evolution_node_domains
       WHERE domain_id = $2
       ON CONFLICT (node_id, domain_id) DO NOTHING`,
      [tgt.id, src.id],
    );
    await this.pool.query("DELETE FROM repo_evolution_node_domains WHERE domain_id = $1", [src.id]);
    await this.pool.query(
      `DELETE FROM repo_evolution_node_domains
       WHERE domain_id = $1
         AND node_id IN (SELECT id FROM repo_evolution_nodes WHERE primary_domain_id = $1)`,
      [tgt.id],
    );
    await this.pool.query("UPDATE repo_absorption_events SET domain_id = $1 WHERE domain_id = $2", [tgt.id, src.id]);

    // Merge seed keywords into target domain
    const mergedKeywords = [...new Set([...tgt.seedKeywords, ...src.seedKeywords])].slice(0, 60);
    const updatedTarget = await this.updateDomain(tgt.id, { seedKeywords: mergedKeywords });
    await this.pool.query("DELETE FROM repo_domains WHERE id = $1", [src.id]);
    return { targetDomain: updatedTarget, movedNodes: moved.rows.length };
  }

  async importGithubStarLists(): Promise<ImportGithubListsResult> {
    await this.init();
    const lists = await this.github.fetchStarLists();
    let importedDomains = 0;
    let assignedNodes = 0;
    const domains: RepoDomain[] = [];
    const nowIso = new Date(this.now()).toISOString();

    for (let i = 0; i < lists.length; i++) {
      const list = lists[i]!;
      const slug = slugifyDomain(`gh-${list.slug || list.name}`);
      const id = domainIdFromSlug(slug);
      const color = GITHUB_LIST_PALETTE[i % GITHUB_LIST_PALETTE.length]!;
      const centroid = localSemanticVector(
        `${list.name} ${list.description} ${list.repoFullNames.slice(0, 20).join(" ")}`,
        REPO_EVOLUTION_VECTOR_DIM,
      );
      const upsert = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO repo_domains
          (id, slug, name, description, color, icon, seed_keywords_json, source, github_list_id, sort_order, centroid, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'bookmark', '[]'::jsonb, 'github_list', $6, $7, $8::vector, $9, $9)
         ON CONFLICT (github_list_id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           centroid = EXCLUDED.centroid,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [id, slug, list.name, list.description, color, list.id, 120 + i, toPgVectorLiteral(centroid, "local"), nowIso],
      );
      const dom = this.mapDomain(upsert.rows[0]!);
      domains.push(dom);
      importedDomains++;

      for (const repoFullName of list.repoFullNames) {
        const lower = repoFullName.trim().toLowerCase();
        const nodeRes = await this.pool.query<{ id: string; primary_domain_id: string | null; domain_assigned_by: string }>(
          "SELECT id, primary_domain_id, domain_assigned_by FROM repo_evolution_nodes WHERE full_name_lower = $1",
          [lower],
        );
        const node = nodeRes.rows[0];
        if (!node) continue;
        if (!node.primary_domain_id || node.domain_assigned_by === "ai" || node.domain_assigned_by === "unassigned") {
          await this.pool.query(
            `UPDATE repo_evolution_nodes
             SET primary_domain_id = $1, domain_assigned_by = 'github_list', domain_confidence = 1.0, updated_at = $2
             WHERE id = $3`,
            [dom.id, nowIso, node.id],
          );
          assignedNodes++;
        } else if (node.primary_domain_id !== dom.id) {
          await this.pool.query(
            `INSERT INTO repo_evolution_node_domains (node_id, domain_id, confidence, assigned_by)
             VALUES ($1, $2, 1.0, 'github_list')
             ON CONFLICT (node_id, domain_id) DO NOTHING`,
            [node.id, dom.id],
          );
          assignedNodes++;
        }
      }
    }

    return { importedDomains, assignedNodes, domains };
  }

  // ---- Nodes CRUD, Pagination & Spotlight Registration ----

  private mapNodeBrief(row: Record<string, unknown>): RepoNodeBrief {
    return {
      id: String(row.id),
      fullName: String(row.full_name),
      name: String(row.name),
      owner: String(row.owner),
      url: String(row.url),
      role: String(row.role) as RepoNodeRole,
      visibility: String(row.visibility ?? "public") as RepoVisibility,
      vitality: String(row.vitality ?? "active") as RepoVitality,
      priorityTier: String(row.priority_tier ?? "standard") as RepoPriorityTier,
      primaryLanguage: row.primary_language ? String(row.primary_language) : null,
      starsCount: Number(row.stars_count ?? 0),
      primaryDomainId: row.primary_domain_id ? String(row.primary_domain_id) : null,
      primaryDomainName: row.domain_name ? String(row.domain_name) : null,
      primaryDomainColor: row.domain_color ? String(row.domain_color) : null,
      allowLlmAnalysis: Boolean(row.allow_llm_analysis ?? true),
    };
  }

  private mapNode(row: Record<string, unknown>, secondaryDomainIds: string[] = []): RepoEvolutionNode {
    const role = String(row.role) as RepoNodeRole;
    const vitality = String(row.vitality ?? "active") as RepoVitality;
    const priorityTier = String(row.priority_tier ?? "standard") as RepoPriorityTier;
    const primaryDomainId = row.primary_domain_id ? String(row.primary_domain_id) : null;
    const activeLinkCount = Number(row.active_link_count ?? 0);
    return {
      id: String(row.id),
      fullName: String(row.full_name),
      owner: String(row.owner),
      name: String(row.name),
      url: String(row.url),
      role,
      visibility: String(row.visibility ?? "public") as RepoVisibility,
      vitality,
      priorityTier,
      description: String(row.description ?? ""),
      primaryLanguage: row.primary_language ? String(row.primary_language) : null,
      topics: safeJson<string[]>(row.topics_json, []),
      starsCount: Number(row.stars_count ?? 0),
      forksCount: Number(row.forks_count ?? 0),
      isFork: Boolean(row.is_fork),
      isArchived: Boolean(row.is_archived),
      defaultBranch: row.default_branch ? String(row.default_branch) : null,
      pushedAt: toIso(row.pushed_at),
      starredAt: toIso(row.starred_at),
      repoUpdatedAt: toIso(row.repo_updated_at),
      primaryDomainId,
      primaryDomainName: row.domain_name ? String(row.domain_name) : null,
      primaryDomainColor: row.domain_color ? String(row.domain_color) : null,
      secondaryDomainIds,
      domainConfidence:
        row.domain_confidence !== null && row.domain_confidence !== undefined
          ? Number(row.domain_confidence)
          : null,
      domainAssignedBy: String(row.domain_assigned_by ?? "unassigned") as RepoDomainAssignedBy,
      poolBucket: computePoolBucket({ role, vitality, priorityTier, primaryDomainId, activeLinkCount }),
      allowLlmAnalysis: Boolean(row.allow_llm_analysis ?? true),
      readmeSha: row.readme_sha ? String(row.readme_sha) : null,
      readmeDigest: safeJson<RepoReadmeDigest | null>(row.readme_digest_json, null),
      hasEmbedding: Boolean(row.has_embedding),
      embeddingSource:
        row.embedding_source === "remote" || row.embedding_source === "local"
          ? row.embedding_source
          : null,
      linkCount: Number(row.link_count ?? activeLinkCount),
      activeLinkCount,
      notes: String(row.notes ?? ""),
      lastSyncedAt: toIso(row.last_synced_at) ?? new Date(this.now()).toISOString(),
      createdAt: toIso(row.created_at) ?? new Date(this.now()).toISOString(),
      updatedAt: toIso(row.updated_at) ?? new Date(this.now()).toISOString(),
    };
  }

  private async loadSecondaryDomainsMap(nodeIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (nodeIds.length === 0) return map;
    const res = await this.pool.query<{ node_id: string; domain_id: string }>(
      "SELECT node_id, domain_id FROM repo_evolution_node_domains WHERE node_id = ANY($1::text[])",
      [nodeIds],
    );
    for (const r of res.rows) {
      const list = map.get(r.node_id) ?? [];
      list.push(r.domain_id);
      map.set(r.node_id, list);
    }
    return map;
  }

  private async resolveNodeRow(idOrFullName: string): Promise<Record<string, unknown> | null> {
    const key = idOrFullName.trim();
    if (!key) return null;
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT n.*,
         (n.embedding IS NOT NULL) AS has_embedding,
         d.name AS domain_name,
         d.color AS domain_color,
         (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.source_node_id = n.id OR l.target_node_id = n.id)::int AS link_count,
         (SELECT COUNT(*) FROM repo_absorption_links l WHERE (l.source_node_id = n.id OR l.target_node_id = n.id) AND l.status <> 'rejected')::int AS active_link_count
       FROM repo_evolution_nodes n
       LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
       WHERE n.id = $1 OR n.full_name_lower = $2 OR LOWER(n.name) = $2
       ORDER BY CASE WHEN n.id = $1 THEN 0 WHEN n.full_name_lower = $2 THEN 1 ELSE 2 END
       LIMIT 1`,
      [key, key.toLowerCase()],
    );
    return res.rows[0] ?? null;
  }

  async getNode(idOrFullName: string): Promise<RepoEvolutionNode> {
    await this.init();
    const row = await this.resolveNodeRow(idOrFullName);
    if (!row) throw new ApiError(404, "node_not_found", `未找到仓库节点：${idOrFullName}`);
    const secMap = await this.loadSecondaryDomainsMap([String(row.id)]);
    return this.mapNode(row, secMap.get(String(row.id)) ?? []);
  }

  async getNodeDetail(idOrFullName: string): Promise<{
    node: RepoEvolutionNode;
    outgoingLinks: RepoAbsorptionLink[];
    incomingLinks: RepoAbsorptionLink[];
  }> {
    const node = await this.getNode(idOrFullName);
    const [outgoingLinks, incomingLinks] = await Promise.all([
      this.listLinks({ sourceNodeId: node.id, limit: 200 }),
      this.listLinks({ targetNodeId: node.id, limit: 200 }),
    ]);
    return { node, outgoingLinks, incomingLinks };
  }

  async registerOwnedOrSpotlightNode(raw: unknown): Promise<RepoEvolutionNode> {
    await this.init();
    const input = parseInput(registerNodeSchema, raw);
    const config = await this.getConfig();
    const [owner, name] = input.fullName.split("/") as [string, string];
    const id = repoNodeIdFromFullName(input.fullName);
    const nowIso = new Date(this.now()).toISOString();
    const url = `https://github.com/${input.fullName}`;
    const allowLlm =
      input.allowLlmAnalysis !== undefined
        ? input.allowLlmAnalysis
        : input.visibility === "private"
          ? config.allowPrivateLlmByDefault
          : true;

    const semText = buildRepoSemanticText({
      fullName: input.fullName,
      name,
      description: input.description,
      primaryLanguage: input.primaryLanguage,
      topics: input.topics,
    });
    const emb = await computeSemanticVector(semText, this.providers?.get());

    await this.pool.query(
      `INSERT INTO repo_evolution_nodes (
         id, full_name, full_name_lower, owner, name, url, role, visibility, vitality, priority_tier,
         description, primary_language, topics_json, allow_llm_analysis, embedding, embedding_source,
         pushed_at, last_synced_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, $12::jsonb, $13, $14::vector, $15, $16, $16, $16, $16)
       ON CONFLICT (full_name_lower) DO UPDATE SET
         role = CASE
           WHEN repo_evolution_nodes.role = 'starred' AND EXCLUDED.role = 'owned' THEN 'both'
           WHEN repo_evolution_nodes.role = 'owned' AND EXCLUDED.role = 'starred' THEN 'both'
           ELSE EXCLUDED.role
         END,
         visibility = EXCLUDED.visibility,
         priority_tier = EXCLUDED.priority_tier,
         description = CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE repo_evolution_nodes.description END,
         primary_language = COALESCE(EXCLUDED.primary_language, repo_evolution_nodes.primary_language),
         topics_json = CASE WHEN jsonb_array_length(EXCLUDED.topics_json) > 0 THEN EXCLUDED.topics_json ELSE repo_evolution_nodes.topics_json END,
         allow_llm_analysis = EXCLUDED.allow_llm_analysis,
         embedding = EXCLUDED.embedding,
         embedding_source = EXCLUDED.embedding_source,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        input.fullName,
        input.fullName.toLowerCase(),
        owner,
        name,
        url,
        input.role,
        input.visibility,
        input.priorityTier,
        input.description,
        input.primaryLanguage,
        JSON.stringify(input.topics),
        allowLlm,
        toPgVectorLiteral(emb.vector, emb.source),
        emb.source,
        nowIso,
      ],
    );

    if (input.priorityTier === "spotlight" && !matchesSpotlightRepo(input.fullName, name, config.spotlightRepos)) {
      await this.updateConfig({ spotlightRepos: [...config.spotlightRepos, input.fullName] });
    }
    return this.getNode(id);
  }

  async updateNode(idOrFullName: string, raw: UpdateRepoNodeInput): Promise<RepoEvolutionNode> {
    await this.init();
    const patch = parseInput(updateNodeSchema, raw);
    const node = await this.getNode(idOrFullName);
    const nowIso = new Date(this.now()).toISOString();

    let primaryDomainId = node.primaryDomainId;
    let domainAssignedBy = node.domainAssignedBy;
    let domainConfidence = node.domainConfidence;
    if (patch.primaryDomainId !== undefined) {
      if (patch.primaryDomainId === null) {
        primaryDomainId = null;
        domainAssignedBy = "unassigned";
        domainConfidence = null;
      } else {
        const dRes = await this.pool.query<{ id: string }>(
          "SELECT id FROM repo_domains WHERE id = $1 OR slug = $1 LIMIT 1",
          [patch.primaryDomainId],
        );
        if (!dRes.rows[0]) throw new ApiError(404, "domain_not_found", "指定领域不存在");
        primaryDomainId = dRes.rows[0].id;
        domainAssignedBy = "manual";
        domainConfidence = 1.0;
      }
    }

    const priorityTier = patch.priorityTier ?? node.priorityTier;
    const allowLlmAnalysis = patch.allowLlmAnalysis ?? node.allowLlmAnalysis;
    const notes = patch.notes ?? node.notes;

    await this.pool.query(
      `UPDATE repo_evolution_nodes
       SET primary_domain_id = $1,
           domain_assigned_by = $2,
           domain_confidence = $3,
           priority_tier = $4,
           allow_llm_analysis = $5,
           notes = $6,
           updated_at = $7
       WHERE id = $8`,
      [primaryDomainId, domainAssignedBy, domainConfidence, priorityTier, allowLlmAnalysis, notes, nowIso, node.id],
    );

    if (patch.secondaryDomainIds !== undefined) {
      await this.pool.query("DELETE FROM repo_evolution_node_domains WHERE node_id = $1", [node.id]);
      for (const domId of [...new Set(patch.secondaryDomainIds)]) {
        if (domId === primaryDomainId) continue;
        await this.pool.query(
          `INSERT INTO repo_evolution_node_domains (node_id, domain_id, confidence, assigned_by)
           SELECT $1, id, 1.0, 'manual' FROM repo_domains WHERE id = $2
           ON CONFLICT (node_id, domain_id) DO NOTHING`,
          [node.id, domId],
        );
      }
    }

    return this.getNode(node.id);
  }

  async batchUpdateNodes(raw: BatchUpdateRepoNodesInput): Promise<BatchUpdateRepoNodesResult> {
    await this.init();
    const input = parseInput(batchUpdateNodesSchema, raw);
    const nowIso = new Date(this.now()).toISOString();
    const uniqueIds = [...new Set(input.nodeIds)];

    if (input.action === "assign_domain") {
      if (!input.domainId) throw new ApiError(400, "missing_domain_id", "批量归类必须提供 domainId");
      const dRes = await this.pool.query<{ id: string }>(
        "SELECT id FROM repo_domains WHERE id = $1 OR slug = $1 LIMIT 1",
        [input.domainId],
      );
      if (!dRes.rows[0]) throw new ApiError(404, "domain_not_found", "目标领域不存在");
      const res = await this.pool.query<{ id: string }>(
        `UPDATE repo_evolution_nodes
         SET primary_domain_id = $1, domain_assigned_by = 'manual', domain_confidence = 1.0, updated_at = $2
         WHERE id = ANY($3::text[])
         RETURNING id`,
        [dRes.rows[0].id, nowIso, uniqueIds],
      );
      return { updatedCount: res.rows.length, nodeIds: res.rows.map((r) => r.id) };
    }

    if (input.action === "clear_domain") {
      const res = await this.pool.query<{ id: string }>(
        `UPDATE repo_evolution_nodes
         SET primary_domain_id = NULL, domain_assigned_by = 'unassigned', domain_confidence = NULL, updated_at = $1
         WHERE id = ANY($2::text[])
         RETURNING id`,
        [nowIso, uniqueIds],
      );
      return { updatedCount: res.rows.length, nodeIds: res.rows.map((r) => r.id) };
    }

    if (input.action === "archive_stale") {
      const res = await this.pool.query<{ id: string }>(
        `UPDATE repo_evolution_nodes
         SET priority_tier = 'archived', updated_at = $1
         WHERE id = ANY($2::text[])
         RETURNING id`,
        [nowIso, uniqueIds],
      );
      return { updatedCount: res.rows.length, nodeIds: res.rows.map((r) => r.id) };
    }

    if (input.action === "restore_standard") {
      const res = await this.pool.query<{ id: string }>(
        `UPDATE repo_evolution_nodes
         SET priority_tier = 'standard', updated_at = $1
         WHERE id = ANY($2::text[])
         RETURNING id`,
        [nowIso, uniqueIds],
      );
      return { updatedCount: res.rows.length, nodeIds: res.rows.map((r) => r.id) };
    }

    if (input.action === "set_spotlight") {
      const res = await this.pool.query<{ id: string }>(
        `UPDATE repo_evolution_nodes
         SET priority_tier = 'spotlight', updated_at = $1
         WHERE id = ANY($2::text[])
         RETURNING id`,
        [nowIso, uniqueIds],
      );
      return { updatedCount: res.rows.length, nodeIds: res.rows.map((r) => r.id) };
    }

    const allow = Boolean(input.allowLlmAnalysis);
    const res = await this.pool.query<{ id: string }>(
      `UPDATE repo_evolution_nodes
       SET allow_llm_analysis = $1, updated_at = $2
       WHERE id = ANY($3::text[])
       RETURNING id`,
      [allow, nowIso, uniqueIds],
    );
    return { updatedCount: res.rows.length, nodeIds: res.rows.map((r) => r.id) };
  }

  async queryNodes(query: RepoEvolutionNodesQuery = {}): Promise<RepoEvolutionNodesPage> {
    await this.init();
    const page = Math.max(1, Math.floor(Number(query.page ?? 1) || 1));
    const pageSize = Math.max(1, Math.min(200, Math.floor(Number(query.pageSize ?? 50) || 50)));
    const offset = (page - 1) * pageSize;

    const where: string[] = [];
    const params: unknown[] = [];
    const pushParam = (val: unknown) => {
      params.push(val);
      return `$${params.length}`;
    };

    const hasActiveLinkSql = `EXISTS (
      SELECT 1 FROM repo_absorption_links l
      WHERE (l.source_node_id = n.id OR l.target_node_id = n.id) AND l.status <> 'rejected'
    )`;
    const hasStarActiveLinkSql = `EXISTS (
      SELECT 1 FROM repo_absorption_links l
      WHERE l.source_node_id = n.id AND l.status <> 'rejected'
    )`;

    if (query.q?.trim()) {
      const p = pushParam(`%${query.q.trim().toLowerCase()}%`);
      where.push(
        `(n.full_name_lower LIKE ${p} OR LOWER(n.description) LIKE ${p} OR LOWER(n.topics_json::text) LIKE ${p})`,
      );
    }

    if (query.role && query.role !== "all") {
      if (query.role === "owned") where.push("n.role IN ('owned', 'both')");
      else if (query.role === "starred") where.push("n.role IN ('starred', 'both')");
      else where.push(`n.role = ${pushParam(query.role)}`);
    }

    if (query.bucket && query.bucket !== "all") {
      switch (query.bucket) {
        case "owned":
          where.push("n.role IN ('owned', 'both')");
          break;
        case "spotlight":
          where.push("n.priority_tier = 'spotlight'");
          break;
        case "linked":
          where.push(`n.role IN ('starred', 'both') AND ${hasStarActiveLinkSql}`);
          break;
        case "floating":
          where.push(`n.role IN ('starred', 'both') AND NOT ${hasStarActiveLinkSql}`);
          break;
        case "unclassified":
          where.push(
            `n.role IN ('starred', 'both') AND NOT ${hasStarActiveLinkSql} AND n.vitality NOT IN ('stale', 'archived') AND n.priority_tier <> 'archived' AND n.primary_domain_id IS NULL`,
          );
          break;
        case "classified_unlinked":
          where.push(
            `n.role IN ('starred', 'both') AND NOT ${hasStarActiveLinkSql} AND n.vitality NOT IN ('stale', 'archived') AND n.priority_tier <> 'archived' AND n.primary_domain_id IS NOT NULL`,
          );
          break;
        case "stale_pool":
          where.push(
            `n.role IN ('starred', 'both') AND NOT ${hasStarActiveLinkSql} AND (n.vitality IN ('stale', 'archived') OR n.priority_tier = 'archived')`,
          );
          break;
        case "ai_suggested":
          where.push(
            `n.role IN ('starred', 'both') AND (
               EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status = 'suggested')
               OR (n.domain_assigned_by = 'ai' AND n.primary_domain_id IS NOT NULL)
             )`,
          );
          break;
      }
    }

    if (query.domainId) {
      if (query.domainId === "__none__" || query.domainId === "__floating__") {
        where.push("n.primary_domain_id IS NULL");
      } else {
        const p = pushParam(query.domainId);
        where.push(
          `(n.primary_domain_id = ${p} OR EXISTS (SELECT 1 FROM repo_evolution_node_domains nd WHERE nd.node_id = n.id AND nd.domain_id = ${p}))`,
        );
      }
    }

    if (query.vitality && query.vitality !== "all") {
      where.push(`n.vitality = ${pushParam(query.vitality)}`);
    }
    if (query.visibility && query.visibility !== "all") {
      where.push(`n.visibility = ${pushParam(query.visibility)}`);
    }
    if (query.priorityTier && query.priorityTier !== "all") {
      where.push(`n.priority_tier = ${pushParam(query.priorityTier)}`);
    }
    if (query.language?.trim()) {
      where.push(`LOWER(n.primary_language) = ${pushParam(query.language.trim().toLowerCase())}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const dir = query.sortDir === "asc" ? "ASC" : "DESC";
    const orderByMap: Record<string, string> = {
      starred_at: `n.starred_at ${dir} NULLS LAST, n.stars_count DESC`,
      pushed_at: `n.pushed_at ${dir} NULLS LAST, n.stars_count DESC`,
      stars: `n.stars_count ${dir}, n.pushed_at DESC NULLS LAST`,
      updated_at: `n.updated_at ${dir}, n.full_name ASC`,
      name: `n.full_name_lower ${dir}`,
      priority: `CASE n.priority_tier WHEN 'spotlight' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END ASC, n.stars_count DESC`,
    };
    const orderSql = orderByMap[query.sortBy ?? "starred_at"] ?? orderByMap.starred_at;

    const countRes = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM repo_evolution_nodes n ${whereSql}`,
      params,
    );
    const total = Number(countRes.rows[0]?.n ?? 0);

    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;
    const rowsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT n.*,
         (n.embedding IS NOT NULL) AS has_embedding,
         d.name AS domain_name,
         d.color AS domain_color,
         (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.source_node_id = n.id OR l.target_node_id = n.id)::int AS link_count,
         (SELECT COUNT(*) FROM repo_absorption_links l WHERE (l.source_node_id = n.id OR l.target_node_id = n.id) AND l.status <> 'rejected')::int AS active_link_count
       FROM repo_evolution_nodes n
       LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...params, pageSize, offset],
    );

    const nodeIds = rowsRes.rows.map((r) => String(r.id));
    const secMap = await this.loadSecondaryDomainsMap(nodeIds);
    const items = rowsRes.rows.map((r) => this.mapNode(r, secMap.get(String(r.id)) ?? []));

    // Facets (fast grouped query over same filter scope)
    const langRes = await this.pool.query<{ name: string; cnt: number }>(
      `SELECT n.primary_language AS name, COUNT(*)::int AS cnt
       FROM repo_evolution_nodes n
       ${whereSql ? `${whereSql} AND` : "WHERE"} n.primary_language IS NOT NULL
       GROUP BY n.primary_language
       ORDER BY cnt DESC
       LIMIT 20`,
      params,
    );
    const vitRes = await this.pool.query<{ vitality: RepoVitality; cnt: number }>(
      `SELECT n.vitality, COUNT(*)::int AS cnt
       FROM repo_evolution_nodes n
       ${whereSql}
       GROUP BY n.vitality`,
      params,
    );
    const vitalityCounts: Record<RepoVitality, number> = {
      active: 0,
      dormant: 0,
      stale: 0,
      archived: 0,
    };
    for (const r of vitRes.rows) {
      if (r.vitality in vitalityCounts) vitalityCounts[r.vitality] = Number(r.cnt ?? 0);
    }

    // Keep unused reference linter happy
    void hasActiveLinkSql;

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      facets: {
        languages: langRes.rows.map((r) => ({ name: r.name, count: Number(r.cnt ?? 0) })),
        vitalityCounts,
      },
    };
  }

  // ---- Repo Content Preview ----

  private toIndexedRepo(node: RepoEvolutionNode): IndexedRepo {
    return {
      fullName: node.fullName,
      url: node.url,
      description: node.description,
      visibility: node.visibility,
      relations: [node.role === "owned" ? "我的" : "Star"],
      paths: [],
      language: node.primaryLanguage,
      pushedAt: node.pushedAt,
      defaultBranch: node.defaultBranch,
      managed: [],
    };
  }

  async getNodeContent(idOrFullName: string): Promise<RepoContent> {
    await this.init();
    const row = await this.resolveNodeRow(idOrFullName);
    let indexed: IndexedRepo;
    let nodeId: string | null = null;
    let fallbackDesc = "";
    if (row) {
      const node = this.mapNode(row);
      indexed = this.toIndexedRepo(node);
      nodeId = node.id;
      fallbackDesc = node.description;
    } else if (/^[\w.-]+\/[\w.-]+$/.test(idOrFullName.trim())) {
      const fullName = idOrFullName.trim();
      indexed = {
        fullName,
        url: `https://github.com/${fullName}`,
        description: "",
        visibility: "public",
        relations: [],
        paths: [],
        language: null,
        pushedAt: null,
        defaultBranch: null,
        managed: [],
      };
    } else {
      throw new ApiError(404, "node_not_found", `未找到仓库：${idOrFullName}`);
    }

    const content = await this.github.fetchRepoContent(indexed);
    if (nodeId) {
      const digest = summarizeReadme(content, fallbackDesc);
      const readmeSha = content.readme?.text
        ? createHash("sha256").update(content.readme.text).digest("hex").slice(0, 16)
        : null;
      await this.pool.query(
        `UPDATE repo_evolution_nodes
         SET readme_sha = COALESCE($1, readme_sha),
             readme_digest_json = $2::jsonb,
             updated_at = $3
         WHERE id = $4`,
        [readmeSha, JSON.stringify(digest), new Date(this.now()).toISOString(), nodeId],
      );
    }
    return content;
  }

  async searchNodeContent(idOrFullName: string, term: string): Promise<RepoEvolutionContentSearchResult> {
    await this.init();
    const node = await this.getNode(idOrFullName);
    return this.github.searchRepoContent(this.toIndexedRepo(node), term);
  }

  // ---- Absorption Links CRUD (1-to-N) ----

  private mapLink(row: Record<string, unknown>): RepoAbsorptionLink {
    const decisionPacketId = row.decision_packet_id ? String(row.decision_packet_id) : null;
    const livePacket = decisionPacketId && this.decisions ? this.decisions.get(decisionPacketId) : null;
    const sourceNode: RepoNodeBrief | undefined = row.src_full_name
      ? {
          id: String(row.source_node_id),
          fullName: String(row.src_full_name),
          name: String(row.src_name),
          owner: String(row.src_owner),
          url: String(row.src_url),
          role: String(row.src_role) as RepoNodeRole,
          visibility: String(row.src_visibility ?? "public") as RepoVisibility,
          vitality: String(row.src_vitality ?? "active") as RepoVitality,
          priorityTier: String(row.src_priority_tier ?? "standard") as RepoPriorityTier,
          primaryLanguage: row.src_language ? String(row.src_language) : null,
          starsCount: Number(row.src_stars ?? 0),
          primaryDomainId: row.src_domain_id ? String(row.src_domain_id) : null,
          primaryDomainName: row.src_domain_name ? String(row.src_domain_name) : null,
          primaryDomainColor: row.src_domain_color ? String(row.src_domain_color) : null,
          allowLlmAnalysis: Boolean(row.src_allow_llm ?? true),
        }
      : undefined;
    const targetNode: RepoNodeBrief | undefined = row.tgt_full_name
      ? {
          id: String(row.target_node_id),
          fullName: String(row.tgt_full_name),
          name: String(row.tgt_name),
          owner: String(row.tgt_owner),
          url: String(row.tgt_url),
          role: String(row.tgt_role) as RepoNodeRole,
          visibility: String(row.tgt_visibility ?? "public") as RepoVisibility,
          vitality: String(row.tgt_vitality ?? "active") as RepoVitality,
          priorityTier: String(row.tgt_priority_tier ?? "standard") as RepoPriorityTier,
          primaryLanguage: row.tgt_language ? String(row.tgt_language) : null,
          starsCount: Number(row.tgt_stars ?? 0),
          primaryDomainId: row.tgt_domain_id ? String(row.tgt_domain_id) : null,
          primaryDomainName: row.tgt_domain_name ? String(row.tgt_domain_name) : null,
          primaryDomainColor: row.tgt_domain_color ? String(row.tgt_domain_color) : null,
          allowLlmAnalysis: Boolean(row.tgt_allow_llm ?? true),
        }
      : undefined;

    return {
      id: String(row.id),
      sourceNodeId: String(row.source_node_id),
      targetNodeId: String(row.target_node_id),
      sourceRepoFullName: String(row.src_full_name ?? ""),
      targetRepoFullName: String(row.tgt_full_name ?? ""),
      sourceNode,
      targetNode,
      relationType: String(row.relation_type) as RepoRelationType,
      status: String(row.status) as RepoAbsorptionStatus,
      strength: Number(row.strength ?? 0.5),
      rationale: String(row.rationale ?? ""),
      moduleAnalysis: safeJson<RepoModuleAnalysisItem[]>(row.module_analysis_json, []),
      analysisSource:
        row.analysis_source === "llm" ||
        row.analysis_source === "deterministic" ||
        row.analysis_source === "manual"
          ? row.analysis_source
          : null,
      analyzedAt: toIso(row.analyzed_at),
      decisionPacketId,
      decisionStatus: livePacket?.status ?? null,
      opportunityId: row.opportunity_id ? String(row.opportunity_id) : null,
      createdBy: row.created_by === "manual" ? "manual" : "ai",
      createdAt: toIso(row.created_at) ?? new Date(this.now()).toISOString(),
      updatedAt: toIso(row.updated_at) ?? new Date(this.now()).toISOString(),
    };
  }

  private readonly LINK_SELECT_SQL = `
    SELECT l.*,
      s.full_name AS src_full_name, s.name AS src_name, s.owner AS src_owner, s.url AS src_url,
      s.role AS src_role, s.visibility AS src_visibility, s.vitality AS src_vitality,
      s.priority_tier AS src_priority_tier, s.primary_language AS src_language, s.stars_count AS src_stars,
      s.primary_domain_id AS src_domain_id, sd.name AS src_domain_name, sd.color AS src_domain_color,
      s.allow_llm_analysis AS src_allow_llm,
      t.full_name AS tgt_full_name, t.name AS tgt_name, t.owner AS tgt_owner, t.url AS tgt_url,
      t.role AS tgt_role, t.visibility AS tgt_visibility, t.vitality AS tgt_vitality,
      t.priority_tier AS tgt_priority_tier, t.primary_language AS tgt_language, t.stars_count AS tgt_stars,
      t.primary_domain_id AS tgt_domain_id, td.name AS tgt_domain_name, td.color AS tgt_domain_color,
      t.allow_llm_analysis AS tgt_allow_llm
    FROM repo_absorption_links l
    JOIN repo_evolution_nodes s ON s.id = l.source_node_id
    LEFT JOIN repo_domains sd ON sd.id = s.primary_domain_id
    JOIN repo_evolution_nodes t ON t.id = l.target_node_id
    LEFT JOIN repo_domains td ON td.id = t.primary_domain_id
  `;

  async getLink(id: string): Promise<RepoAbsorptionLink> {
    await this.init();
    const res = await this.pool.query<Record<string, unknown>>(
      `${this.LINK_SELECT_SQL} WHERE l.id = $1 LIMIT 1`,
      [id],
    );
    if (!res.rows[0]) throw new ApiError(404, "link_not_found", `未找到吸收关联边：${id}`);
    return this.mapLink(res.rows[0]);
  }

  async listLinks(filter: {
    sourceNodeId?: string;
    targetNodeId?: string;
    status?: string;
    relationType?: string;
    limit?: number;
  } = {}): Promise<RepoAbsorptionLink[]> {
    await this.init();
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (filter.sourceNodeId) where.push(`l.source_node_id = ${push(filter.sourceNodeId)}`);
    if (filter.targetNodeId) where.push(`l.target_node_id = ${push(filter.targetNodeId)}`);
    if (filter.status && filter.status !== "all") where.push(`l.status = ${push(filter.status)}`);
    if (filter.relationType && filter.relationType !== "all") {
      where.push(`l.relation_type = ${push(filter.relationType)}`);
    }
    const limit = Math.max(1, Math.min(500, Number(filter.limit ?? 100) || 100));
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const res = await this.pool.query<Record<string, unknown>>(
      `${this.LINK_SELECT_SQL} ${whereSql}
       ORDER BY CASE l.status
         WHEN 'in_review' THEN 0
         WHEN 'approved' THEN 1
         WHEN 'absorbing' THEN 2
         WHEN 'suggested' THEN 3
         WHEN 'watching' THEN 4
         WHEN 'absorbed' THEN 5
         ELSE 6 END ASC,
         l.strength DESC, l.updated_at DESC
       LIMIT ${push(limit)}`,
      params,
    );
    return res.rows.map((r) => this.mapLink(r));
  }

  async createLink(raw: CreateRepoLinkInput, actor = "founder"): Promise<RepoAbsorptionLink> {
    await this.init();
    const input = parseInput(createLinkSchema, raw);
    const source = await this.getNode(input.sourceNodeId);
    const target = await this.getNode(input.targetNodeId);
    if (source.id === target.id) {
      throw new ApiError(400, "link_self", "不能将仓库关联到自身");
    }
    const existing = await this.pool.query<{ id: string }>(
      "SELECT id FROM repo_absorption_links WHERE source_node_id = $1 AND target_node_id = $2",
      [source.id, target.id],
    );
    const nowIso = new Date(this.now()).toISOString();
    const modules = (input.moduleAnalysis ?? []).map((m) => ({
      ...m,
      id: m.id ?? `mod_${randomUUID().slice(0, 8)}`,
    }));

    if (existing.rows[0]) {
      const linkId = existing.rows[0].id;
      await this.pool.query(
        `UPDATE repo_absorption_links
         SET relation_type = $1,
             status = COALESCE($2, CASE WHEN status = 'rejected' THEN 'watching' ELSE status END),
             strength = $3,
             rationale = CASE WHEN $4 <> '' THEN $4 ELSE rationale END,
             module_analysis_json = CASE WHEN $5::jsonb <> '[]'::jsonb THEN $5::jsonb ELSE module_analysis_json END,
             updated_at = $6
         WHERE id = $7`,
        [
          input.relationType,
          input.status ?? null,
          input.strength,
          input.rationale,
          JSON.stringify(modules),
          nowIso,
          linkId,
        ],
      );
      return this.getLink(linkId);
    }

    const id = `lnk_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const status: RepoAbsorptionStatus = input.status ?? "watching";
    await this.pool.query(
      `INSERT INTO repo_absorption_links (
         id, source_node_id, target_node_id, relation_type, status, strength, rationale,
         module_analysis_json, analysis_source, analyzed_at, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'manual', $11, $11)`,
      [
        id,
        source.id,
        target.id,
        input.relationType,
        status,
        input.strength,
        input.rationale,
        JSON.stringify(modules),
        modules.length > 0 ? "manual" : null,
        modules.length > 0 ? nowIso : null,
        nowIso,
      ],
    );

    await this.recordEvent({
      linkId: id,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      domainId: source.primaryDomainId,
      eventType: "link_created",
      title: `手动建立吸收关联：${source.fullName} → ${target.fullName}`,
      summary: input.rationale || `建立 1 对 N 吸收边（${input.relationType}）。`,
      actor,
      metadata: { relationType: input.relationType, status },
    });

    return this.getLink(id);
  }

  async bulkLinkTargets(
    sourceNodeIdOrName: string,
    raw: BulkLinkTargetsInput,
    actor = "founder",
  ): Promise<{ links: RepoAbsorptionLink[] }> {
    await this.init();
    const input = parseInput(bulkLinksSchema, raw);
    const source = await this.getNode(sourceNodeIdOrName);
    const links: RepoAbsorptionLink[] = [];
    for (const targetRef of [...new Set(input.targetNodeIds)]) {
      if (targetRef === source.id || targetRef.toLowerCase() === source.fullName.toLowerCase()) continue;
      const link = await this.createLink(
        {
          sourceNodeId: source.id,
          targetNodeId: targetRef,
          relationType: input.relationType,
          rationale: input.rationale,
          status: "watching",
        },
        actor,
      );
      links.push(link);
    }
    return { links };
  }

  async updateLink(id: string, raw: UpdateRepoLinkInput, actor = "founder"): Promise<RepoAbsorptionLink> {
    await this.init();
    const patch = parseInput(updateLinkSchema, raw);
    const cur = await this.getLink(id);
    const nowIso = new Date(this.now()).toISOString();

    const nextRelation = patch.relationType ?? cur.relationType;
    const nextStatus = patch.status ?? cur.status;
    const nextStrength = patch.strength ?? cur.strength;
    const nextRationale = patch.rationale ?? cur.rationale;
    const nextModules =
      patch.moduleAnalysis !== undefined
        ? patch.moduleAnalysis.map((m) => ({ ...m, id: m.id ?? `mod_${randomUUID().slice(0, 8)}` }))
        : cur.moduleAnalysis;
    const nextAnalysisSource =
      patch.moduleAnalysis !== undefined ? "manual" : cur.analysisSource;

    await this.pool.query(
      `UPDATE repo_absorption_links
       SET relation_type = $1,
           status = $2,
           strength = $3,
           rationale = $4,
           module_analysis_json = $5::jsonb,
           analysis_source = $6,
           updated_at = $7
       WHERE id = $8`,
      [
        nextRelation,
        nextStatus,
        nextStrength,
        nextRationale,
        JSON.stringify(nextModules),
        nextAnalysisSource,
        nowIso,
        cur.id,
      ],
    );

    if (patch.status && patch.status !== cur.status) {
      await this.recordEvent({
        linkId: cur.id,
        sourceNodeId: cur.sourceNodeId,
        targetNodeId: cur.targetNodeId,
        domainId: cur.sourceNode?.primaryDomainId ?? null,
        eventType: "status_changed",
        title: `吸收状态变更：${cur.sourceRepoFullName} → ${cur.targetRepoFullName}（${cur.status} → ${nextStatus}）`,
        summary: nextRationale || `状态已更新为 ${nextStatus}。`,
        actor,
        metadata: { from: cur.status, to: nextStatus },
      });
    }

    return this.getLink(cur.id);
  }

  async deleteLink(id: string): Promise<{ ok: true; id: string }> {
    await this.init();
    const res = await this.pool.query<{ id: string }>(
      "DELETE FROM repo_absorption_links WHERE id = $1 RETURNING id",
      [id],
    );
    if (!res.rows[0]) throw new ApiError(404, "link_not_found", `未找到吸收关联边：${id}`);
    return { ok: true, id };
  }

  // ---- Stage 2: Module-Level Deep Analysis ----

  async analyzeLink(
    linkId: string,
    raw: AnalyzeLinkInput = {},
    actor = "system",
  ): Promise<AnalyzeLinkResult> {
    await this.init();
    const input = parseInput(analyzeLinkSchema, raw);
    const link = await this.getLink(linkId);
    if (link.moduleAnalysis.length > 0 && !input.force) {
      return {
        link,
        usedLlm: link.analysisSource === "llm",
        privacyBlocked: false,
      };
    }

    const [source, target] = await Promise.all([
      this.getNode(link.sourceNodeId),
      this.getNode(link.targetNodeId),
    ]);

    const [sourceContent, targetContent] = await Promise.all([
      this.getNodeContent(source.id).catch(() => null),
      this.getNodeContent(target.id).catch(() => null),
    ]);

    const privateRestricted =
      ((source.visibility === "private" && !source.allowLlmAnalysis) ||
        (target.visibility === "private" && !target.allowLlmAnalysis)) &&
      !input.allowPrivateOverride;

    const srcRef = sourceContent?.ref || source.defaultBranch || "main";
    const tgtRef = targetContent?.ref || target.defaultBranch || "main";

    let modules: RepoModuleAnalysisItem[] | null = null;
    let rationale = link.rationale;
    let usedLlm = false;
    let privacyBlocked = false;
    let notice: string | undefined;

    if (privateRestricted) {
      privacyBlocked = true;
      notice = "检测到私有仓库未开启外部 LLM 分析授权，已自动使用本地确定性结构分析引擎（代码零外传）。";
    } else {
      const providersCfg: ProvidersConfig | undefined = this.providers?.get();
      const srcFiles = (sourceContent?.files ?? []).slice(0, 30).map((f) => (f.directory ? `${f.name}/` : f.name));
      const tgtFiles = (targetContent?.files ?? []).slice(0, 30).map((f) => (f.directory ? `${f.name}/` : f.name));
      const prompt = [
        `请对比开源参考仓库与我方目标仓库，产出 2~4 条具体到模块路径的可吸收架构/能力对比方案。`,
        `【源参考仓库】${source.fullName} (★${source.starsCount}, lang=${source.primaryLanguage ?? "unknown"}, topics=${source.topics.join(",")})`,
        `简介：${source.description}`,
        `根目录：${srcFiles.join(", ") || "(未知)"}`,
        `README 摘录：${(sourceContent?.readme?.text ?? "").slice(0, 2200)}`,
        ``,
        `【目标自有仓库】${target.fullName} (tier=${target.priorityTier}, visibility=${target.visibility}, lang=${target.primaryLanguage ?? "unknown"}, topics=${target.topics.join(",")})`,
        `简介：${target.description}`,
        `根目录：${tgtFiles.join(", ") || "(未知)"}`,
        `README 摘录：${(targetContent?.readme?.text ?? "").slice(0, 2200)}`,
        ``,
        `严格输出 JSON 对象：{"rationale":"一句话核心价值总结","modules":[{"sourceModulePath":"...","targetModulePath":"...","absorbableMechanism":"...","currentGap":"...","adaptationPlan":"...","effort":"S|M|L","risk":"low|medium|high","evidenceLinks":[{"label":"...","url":"https://github.com/...","path":"..."}]}]}`,
      ].join("\n");

      const llmRes = await this.llmCaller(prompt, {
        system: "你是资深软件架构师，擅长开源仓库模块级拆解与吸收评估。只返回合法 JSON。",
        maxTokens: 1800,
        config: providersCfg,
      });

      if (llmRes.ok) {
        const parsed = parseLlmModuleAnalysis(llmRes.text, source, target, srcRef, tgtRef);
        if (parsed && parsed.items.length > 0) {
          modules = parsed.items;
          if (parsed.rationale) rationale = parsed.rationale;
          usedLlm = true;
        } else {
          notice = "远端 LLM 输出未通过结构化校验，已自动回退本地确定性模块分析引擎。";
        }
      } else {
        notice = llmRes.reason;
      }
    }

    if (!modules || modules.length === 0) {
      modules = buildDeterministicModuleAnalysis({
        source,
        target,
        relationType: link.relationType,
        sourceContent,
        targetContent,
      });
      if (!rationale.trim()) {
        rationale = `建议从 ${source.fullName} 吸收 ${modules.length} 个关键模块机制至 ${target.fullName}（${link.relationType}）。`;
      }
    }

    const nowIso = new Date(this.now()).toISOString();
    await this.pool.query(
      `UPDATE repo_absorption_links
       SET module_analysis_json = $1::jsonb,
           rationale = $2,
           analysis_source = $3,
           analyzed_at = $4,
           updated_at = $4
       WHERE id = $5`,
      [JSON.stringify(modules), rationale, usedLlm ? "llm" : "deterministic", nowIso, link.id],
    );

    await this.recordEvent({
      linkId: link.id,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      domainId: source.primaryDomainId,
      eventType: "module_analyzed",
      title: `完成模块级深度分析：${source.fullName} → ${target.fullName}（${modules.length} 个模块点）`,
      summary: modules.map((m) => `${m.sourceModulePath} → ${m.targetModulePath} (${m.effort}/${m.risk})`).join("；"),
      actor,
      metadata: {
        moduleCount: modules.length,
        usedLlm,
        privacyBlocked,
      },
    });

    const updated = await this.getLink(link.id);
    return { link: updated, usedLlm, privacyBlocked, ...(notice ? { notice } : {}) };
  }

  // ---- Submit to Founder Mailbox (DecisionGateway) ----

  async submitLinkToMailbox(
    linkId: string,
    raw: SubmitLinkToMailboxInput = {},
    actor = "founder",
  ): Promise<SubmitLinkToMailboxResult> {
    await this.init();
    if (!this.decisions) {
      throw new ApiError(503, "decision_gateway_unavailable", "总裁信箱 DecisionGateway 尚未挂载");
    }
    const input = parseInput(submitMailboxSchema, raw);
    let link = await this.getLink(linkId);
    if (link.moduleAnalysis.length === 0) {
      const analyzed = await this.analyzeLink(link.id, {}, actor);
      link = analyzed.link;
    }

    const [source, target] = await Promise.all([
      this.getNode(link.sourceNodeId),
      this.getNode(link.targetNodeId),
    ]);

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          source: source.fullName,
          target: target.fullName,
          relationType: link.relationType,
          modules: link.moduleAnalysis.map((m) => [
            m.sourceModulePath,
            m.targetModulePath,
            m.absorbableMechanism,
          ]),
        }),
      )
      .digest("hex")
      .slice(0, 12);

    const dedupeKey = `product:repo_absorption:${link.id}:${fingerprint}`;
    const existingPending = this.decisions
      .list({ status: "pending", domain: "product", limit: 200 })
      .find((p) => p.dedupeKey === dedupeKey);

    const deepLink = `#repo-evolution?tab=graph&link=${encodeURIComponent(link.id)}`;
    const moduleMarkdown = link.moduleAnalysis
      .map(
        (m, idx) =>
          `${idx + 1}. **\`${m.sourceModulePath}\` → \`${m.targetModulePath}\`**（工作量 ${m.effort} · 风险 ${m.risk}）\n   - 可吸收机制：${m.absorbableMechanism}\n   - 现状差距：${m.currentGap}\n   - 适配建议：${m.adaptationPlan}` +
          (m.evidenceLinks.length
            ? `\n   - 代码证据：${m.evidenceLinks.map((e) => `[${e.label}](${e.url})`).join(" · ")}`
            : ""),
      )
      .join("\n\n");

    const backgroundLines = [
      `关联项目：${target.fullName}${target.priorityTier === "spotlight" ? "（⭐ 重点关注仓）" : ""}${target.visibility === "private" ? "（🔒 私有仓）" : ""}`,
      `参考开源仓：${source.fullName}（★${source.starsCount} · ${source.vitality} · ${source.primaryDomainName ?? "游离散落池"}）`,
      `关联类型：${link.relationType} · 综合匹配度 ${(link.strength * 100).toFixed(0)}% · 已拆解 ${link.moduleAnalysis.length} 个模块吸收点`,
      link.rationale ? `评估摘要：${link.rationale}` : "",
      input.note ? `发起备注：${input.note}` : "",
    ].filter(Boolean);

    const payloadBase = {
      linkId: link.id,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      sourceRepoFullName: source.fullName,
      targetRepoFullName: target.fullName,
      deepLink,
    };

    const packet: DecisionPacket = await this.decisions.propose({
      dedupeKey,
      domain: "product",
      kind: "repo_absorption",
      riskLevel: "medium",
      bypassAutoApprove: true,
      projectOrAssetRef: target.fullName,
      title: `开源吸收评估：${source.fullName} → ${target.fullName}`,
      backgroundSummary: backgroundLines.join("\n"),
      whyRecommended:
        link.moduleAnalysis[0]?.absorbableMechanism ||
        `源仓在 ${link.relationType} 维度与 ${target.name} 高度契合，建议批准后记入进化路线。`,
      diffOrEvidence: `${moduleMarkdown}\n\n图谱直达：${deepLink}`,
      rollbackPlan:
        "V1 仅在开源进化图谱与时间线落盘审批结论，不自动修改代码或拉起暗工厂；如需调整可在图谱内随时变更状态。",
      tags: [
        "repo_evolution",
        "repo_absorption",
        `link:${link.id}`,
        `source:${source.fullName}`,
        `target:${target.fullName}`,
        ...(target.priorityTier === "spotlight" ? ["spotlight"] : []),
      ],
      recommendedOptionId: input.recommendedOption ?? "approve",
      options: [
        {
          id: "approve",
          label: "批准吸收（写入进化路线）",
          description: "边置为 approved 并写入进化时间线（V1 仅人工留痕，不自动改代码）",
          outcome: "approved",
          handlerKey: "product.repo_absorption_approve",
          payload: payloadBase,
        },
        {
          id: "watch",
          label: "暂存观察（后续再评估）",
          description: "边置为 watching 并写入时间线，暂不推进落地",
          outcome: "snoozed",
          handlerKey: "product.repo_absorption_watch",
          payload: payloadBase,
        },
        {
          id: "reject",
          label: "驳回不吸收（后续自动跳过）",
          description: "边置为 rejected，后续 AI 扫描自动跳过此组合",
          outcome: "rejected",
          handlerKey: "product.repo_absorption_reject",
          payload: payloadBase,
        },
      ],
    });

    const nowIso = new Date(this.now()).toISOString();
    await this.pool.query(
      `UPDATE repo_absorption_links
       SET status = CASE WHEN status IN ('approved', 'absorbing', 'absorbed') THEN status ELSE 'in_review' END,
           decision_packet_id = $1,
           updated_at = $2
       WHERE id = $3`,
      [packet.id, nowIso, link.id],
    );

    if (!existingPending) {
      await this.recordEvent({
        linkId: link.id,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        domainId: source.primaryDomainId,
        eventType: "submitted_to_mailbox",
        title: `提交总裁信箱评估：${source.fullName} → ${target.fullName}`,
        summary: `已生成中风险审批单 ${packet.id}（bypassAutoApprove=true，含 ${link.moduleAnalysis.length} 个模块证据）。`,
        actor,
        decisionPacketId: packet.id,
        metadata: { dedupeKey, deepLink },
      });
    }

    return {
      link: await this.getLink(link.id),
      packet,
      reusedPending: Boolean(existingPending),
    };
  }

  // ---- Manual Promote to Opportunity (研发选题) ----

  async promoteLinkToOpportunity(
    linkId: string,
    raw: PromoteLinkToOpportunityInput = {},
    actor = "founder",
  ): Promise<PromoteLinkToOpportunityResult> {
    await this.init();
    if (!this.opportunities) {
      throw new ApiError(503, "opportunity_store_unavailable", "研发选题存储 OpportunityStore 尚未挂载");
    }
    const input = parseInput(promoteOpportunitySchema, raw);
    const link = await this.getLink(linkId);
    const [source, target] = await Promise.all([
      this.getNode(link.sourceNodeId),
      this.getNode(link.targetNodeId),
    ]);

    const project = target.fullName;
    const title = (input.title ?? `吸收 ${source.name} 机制至 ${target.name}`).slice(0, 200);
    const moduleBrief = link.moduleAnalysis
      .slice(0, 3)
      .map((m) => `${m.sourceModulePath}→${m.targetModulePath}: ${m.absorbableMechanism}`)
      .join(" | ");
    const rationale = (
      input.rationale ??
      [link.rationale, moduleBrief].filter(Boolean).join("\n") ??
      `从 ${source.fullName} 吸收模块能力至 ${target.fullName}`
    ).slice(0, 1000);

    const evidence: string[] = [
      `#repo-evolution?tab=graph&link=${link.id}`,
      source.url,
      ...link.moduleAnalysis
        .flatMap((m) => m.evidenceLinks.map((e) => e.url))
        .slice(0, 5),
    ].slice(0, 8);

    const avgEffort = link.moduleAnalysis.some((m) => m.effort === "L")
      ? 4
      : link.moduleAnalysis.every((m) => m.effort === "S")
        ? 2
        : 3;

    const opportunity = this.opportunities.add({
      project,
      sourceId: `repo-evolution/${link.id}`,
      kind: "feature",
      pipeline: input.pipeline,
      title,
      rationale: rationale || title,
      evidence,
      impact: target.priorityTier === "spotlight" ? 5 : 4,
      confidence: Math.max(2, Math.min(5, Math.round(link.strength * 5))),
      effort: avgEffort,
    });

    const nowIso = new Date(this.now()).toISOString();
    await this.pool.query(
      `UPDATE repo_absorption_links
       SET opportunity_id = $1,
           status = CASE WHEN status = 'approved' THEN 'absorbing' ELSE status END,
           updated_at = $2
       WHERE id = $3`,
      [opportunity.id, nowIso, link.id],
    );

    await this.recordEvent({
      linkId: link.id,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      domainId: source.primaryDomainId,
      eventType: "promoted_to_opportunity",
      title: `手动转为研发选题：${title}`,
      summary: `已写入项目 ${project} 研发待选队列（opportunityId=${opportunity.id}）。`,
      actor,
      metadata: { opportunityId: opportunity.id, project, pipeline: input.pipeline },
    });

    return {
      link: await this.getLink(link.id),
      opportunityId: opportunity.id,
      project,
    };
  }

  // ---- Timeline Events ----

  private async recordEvent(input: {
    linkId?: string | null;
    sourceNodeId?: string | null;
    targetNodeId?: string | null;
    domainId?: string | null;
    eventType: RepoEvolutionEventType;
    title: string;
    summary?: string;
    actor?: string;
    decisionPacketId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const id = `evt_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const nowIso = new Date(this.now()).toISOString();
    await this.pool.query(
      `INSERT INTO repo_absorption_events (
         id, link_id, source_node_id, target_node_id, domain_id, event_type,
         title, summary, actor, decision_packet_id, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        id,
        input.linkId ?? null,
        input.sourceNodeId ?? null,
        input.targetNodeId ?? null,
        input.domainId ?? null,
        input.eventType,
        input.title,
        input.summary ?? "",
        input.actor ?? "system",
        input.decisionPacketId ?? null,
        JSON.stringify(input.metadata ?? {}),
        nowIso,
      ],
    );
  }

  async getTimeline(query: RepoEvolutionTimelineQuery = {}): Promise<RepoEvolutionTimelinePage> {
    await this.init();
    const limit = Math.max(1, Math.min(200, Number(query.limit ?? 60) || 60));
    const offset = Math.max(0, Number(query.offset ?? 0) || 0);
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    if (query.targetNodeId) {
      const p = push(query.targetNodeId);
      const pl = push(query.targetNodeId.toLowerCase());
      where.push(`(e.target_node_id = ${p} OR t.full_name_lower = ${pl} OR LOWER(t.name) = ${pl})`);
    }
    if (query.sourceNodeId) {
      const p = push(query.sourceNodeId);
      const pl = push(query.sourceNodeId.toLowerCase());
      where.push(`(e.source_node_id = ${p} OR s.full_name_lower = ${pl} OR LOWER(s.name) = ${pl})`);
    }
    if (query.repoFullName?.trim()) {
      const pl = push(query.repoFullName.trim().toLowerCase());
      where.push(
        `(s.full_name_lower = ${pl} OR t.full_name_lower = ${pl} OR LOWER(s.name) = ${pl} OR LOWER(t.name) = ${pl})`,
      );
    }
    if (query.domainId) {
      where.push(`e.domain_id = ${push(query.domainId)}`);
    }
    if (query.eventType && query.eventType !== "all") {
      where.push(`e.event_type = ${push(query.eventType)}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRes = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
       FROM repo_absorption_events e
       LEFT JOIN repo_evolution_nodes s ON s.id = e.source_node_id
       LEFT JOIN repo_evolution_nodes t ON t.id = e.target_node_id
       ${whereSql}`,
      params,
    );
    const total = Number(countRes.rows[0]?.n ?? 0);

    const limitP = push(limit);
    const offsetP = push(offset);
    const rowsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT e.*,
         s.full_name AS source_repo_full_name,
         t.full_name AS target_repo_full_name,
         d.name AS domain_name
       FROM repo_absorption_events e
       LEFT JOIN repo_evolution_nodes s ON s.id = e.source_node_id
       LEFT JOIN repo_evolution_nodes t ON t.id = e.target_node_id
       LEFT JOIN repo_domains d ON d.id = e.domain_id
       ${whereSql}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${limitP} OFFSET ${offsetP}`,
      params,
    );

    const items: RepoAbsorptionEvent[] = rowsRes.rows.map((r) => ({
      id: String(r.id),
      linkId: r.link_id ? String(r.link_id) : null,
      sourceNodeId: r.source_node_id ? String(r.source_node_id) : null,
      targetNodeId: r.target_node_id ? String(r.target_node_id) : null,
      domainId: r.domain_id ? String(r.domain_id) : null,
      eventType: String(r.event_type) as RepoEvolutionEventType,
      title: String(r.title),
      summary: String(r.summary ?? ""),
      actor: String(r.actor ?? "system"),
      decisionPacketId: r.decision_packet_id ? String(r.decision_packet_id) : null,
      sourceRepoFullName: r.source_repo_full_name ? String(r.source_repo_full_name) : null,
      targetRepoFullName: r.target_repo_full_name ? String(r.target_repo_full_name) : null,
      domainName: r.domain_name ? String(r.domain_name) : null,
      metadata: safeJson<Record<string, unknown>>(r.metadata_json, {}),
      createdAt: toIso(r.created_at) ?? new Date(this.now()).toISOString(),
    }));

    return { items, total, limit, offset };
  }

  // ---- GitHub GraphQL Background Syncer ----

  private mapSyncJob(row: Record<string, unknown>): RepoEvolutionSyncJob {
    return {
      id: String(row.id),
      mode: String(row.mode ?? "incremental") as RepoEvolutionSyncMode,
      status: String(row.status ?? "queued") as RepoEvolutionSyncStatus,
      phase: String(row.phase ?? "init") as RepoEvolutionSyncPhase,
      githubLogin: row.github_login ? String(row.github_login) : null,
      ownedFetched: Number(row.owned_fetched ?? 0),
      ownedTotal: row.owned_total !== null && row.owned_total !== undefined ? Number(row.owned_total) : null,
      starredFetched: Number(row.starred_fetched ?? 0),
      starredTotal: row.starred_total !== null && row.starred_total !== undefined ? Number(row.starred_total) : null,
      listsFetched: Number(row.lists_fetched ?? 0),
      embeddingsComputed: Number(row.embeddings_computed ?? 0),
      pagesProcessed: Number(row.pages_processed ?? 0),
      cursor: row.cursor ? String(row.cursor) : null,
      earlyStopped: Boolean(row.early_stopped),
      errorMessage: row.error_message ? String(row.error_message) : null,
      startedAt: toIso(row.started_at) ?? new Date(this.now()).toISOString(),
      updatedAt: toIso(row.updated_at) ?? new Date(this.now()).toISOString(),
      completedAt: toIso(row.completed_at),
    };
  }

  async listSyncJobs(limit = 20): Promise<{ activeJob: RepoEvolutionSyncJob | null; jobs: RepoEvolutionSyncJob[] }> {
    await this.init();
    const res = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM repo_evolution_sync_jobs ORDER BY started_at DESC LIMIT $1",
      [Math.max(1, Math.min(100, limit))],
    );
    const jobs = res.rows.map((r) => this.mapSyncJob(r));
    const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued") ?? null;
    return { activeJob, jobs };
  }

  async getSyncJob(id: string): Promise<RepoEvolutionSyncJob> {
    await this.init();
    const res = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM repo_evolution_sync_jobs WHERE id = $1 LIMIT 1",
      [id],
    );
    if (!res.rows[0]) throw new ApiError(404, "sync_job_not_found", `未找到同步任务：${id}`);
    return this.mapSyncJob(res.rows[0]);
  }

  private async upsertSyncedRepo(
    repo: GitHubRepoSnapshot,
    sourceRole: "owned" | "starred",
    config: RepoEvolutionConfig,
    providersCfg: ProvidersConfig | undefined,
    nowMs: number,
  ): Promise<{ embeddingComputed: boolean; isNew: boolean }> {
    const [owner, name] = repo.fullName.split("/") as [string, string];
    const id = repoNodeIdFromFullName(repo.fullName);
    const vitality = computeRepoVitality(repo.isArchived, repo.pushedAt, config, nowMs);
    const nowIso = new Date(nowMs).toISOString();

    const existingRes = await this.pool.query<{
      id: string;
      role: string;
      priority_tier: string;
      description: string;
      topics_json: unknown;
      has_embedding: boolean;
    }>(
      "SELECT id, role, priority_tier, description, topics_json, (embedding IS NOT NULL) AS has_embedding FROM repo_evolution_nodes WHERE full_name_lower = $1",
      [repo.fullName.toLowerCase()],
    );
    const existing = existingRes.rows[0];

    const mergedRole: RepoNodeRole = !existing
      ? sourceRole
      : existing.role === sourceRole
        ? sourceRole
        : "both";

    const isSpotlight =
      (mergedRole === "owned" || mergedRole === "both") &&
      matchesSpotlightRepo(repo.fullName, name, config.spotlightRepos);

    const priorityTier: RepoPriorityTier =
      isSpotlight && existing?.priority_tier !== "archived"
        ? "spotlight"
        : existing
          ? (existing.priority_tier as RepoPriorityTier)
          : "standard";

    const allowLlmDefault =
      repo.visibility === "private" ? config.allowPrivateLlmByDefault : true;

    const existingTopics = existing ? JSON.stringify(safeJson<string[]>(existing.topics_json, [])) : "";
    const nextTopics = JSON.stringify(repo.topics);
    const needsEmbedding =
      !existing ||
      !existing.has_embedding ||
      existing.description !== repo.description ||
      existingTopics !== nextTopics;

    let embeddingLiteral: string | null = null;
    let embeddingSource: "remote" | "local" | null = null;
    if (needsEmbedding) {
      const semText = buildRepoSemanticText({
        fullName: repo.fullName,
        name,
        description: repo.description,
        primaryLanguage: repo.primaryLanguage,
        topics: repo.topics,
      });
      // For bulk star sync, use local semantic vector if no remote key; if remote key exists, computeSemanticVector handles it gracefully
      const emb = await computeSemanticVector(semText, providersCfg);
      embeddingLiteral = toPgVectorLiteral(emb.vector, emb.source);
      embeddingSource = emb.source;
    }

    await this.pool.query(
      `INSERT INTO repo_evolution_nodes (
         id, full_name, full_name_lower, owner, name, url, role, visibility, vitality, priority_tier,
         description, primary_language, topics_json, stars_count, forks_count, is_fork, is_archived,
         default_branch, pushed_at, starred_at, repo_updated_at, allow_llm_analysis,
         embedding, embedding_source, last_synced_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13::jsonb, $14, $15, $16, $17,
         $18, $19, $20, $21, $22,
         $23::vector, $24, $25, $25, $25
       )
       ON CONFLICT (full_name_lower) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         url = EXCLUDED.url,
         role = CASE
           WHEN repo_evolution_nodes.role = 'owned' AND EXCLUDED.role = 'starred' THEN 'both'
           WHEN repo_evolution_nodes.role = 'starred' AND EXCLUDED.role = 'owned' THEN 'both'
           WHEN repo_evolution_nodes.role = 'both' THEN 'both'
           ELSE EXCLUDED.role
         END,
         visibility = EXCLUDED.visibility,
         allow_llm_analysis = CASE
           WHEN repo_evolution_nodes.visibility <> 'private' AND EXCLUDED.visibility = 'private' THEN EXCLUDED.allow_llm_analysis
           ELSE repo_evolution_nodes.allow_llm_analysis
         END,
         vitality = EXCLUDED.vitality,
         priority_tier = CASE
           WHEN EXCLUDED.priority_tier = 'spotlight' AND repo_evolution_nodes.priority_tier <> 'archived' THEN 'spotlight'
           ELSE repo_evolution_nodes.priority_tier
         END,
         description = EXCLUDED.description,
         primary_language = EXCLUDED.primary_language,
         topics_json = EXCLUDED.topics_json,
         stars_count = EXCLUDED.stars_count,
         forks_count = EXCLUDED.forks_count,
         is_fork = EXCLUDED.is_fork,
         is_archived = EXCLUDED.is_archived,
         default_branch = EXCLUDED.default_branch,
         pushed_at = EXCLUDED.pushed_at,
         starred_at = COALESCE(EXCLUDED.starred_at, repo_evolution_nodes.starred_at),
         repo_updated_at = EXCLUDED.repo_updated_at,
         embedding = COALESCE(EXCLUDED.embedding, repo_evolution_nodes.embedding),
         embedding_source = COALESCE(EXCLUDED.embedding_source, repo_evolution_nodes.embedding_source),
         last_synced_at = EXCLUDED.last_synced_at,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        repo.fullName,
        repo.fullName.toLowerCase(),
        owner,
        name,
        repo.url,
        mergedRole,
        repo.visibility,
        vitality,
        priorityTier,
        repo.description,
        repo.primaryLanguage,
        nextTopics,
        repo.starsCount,
        repo.forksCount,
        repo.isFork,
        repo.isArchived,
        repo.defaultBranch,
        repo.pushedAt,
        repo.starredAt ?? null,
        repo.repoUpdatedAt,
        allowLlmDefault,
        embeddingLiteral,
        embeddingSource,
        nowIso,
      ],
    );

    return { embeddingComputed: needsEmbedding, isNew: !existing };
  }

  /**
   * Starts a background sync job and returns immediately with the created job record.
   */
  async triggerSync(raw: TriggerSyncInput = {}): Promise<RepoEvolutionSyncJob> {
    await this.init();
    const input = parseInput(triggerSyncSchema, raw);
    const { activeJob } = await this.listSyncJobs(5);
    if (activeJob && this.activeSyncPromise) {
      return activeJob;
    }

    const job = await this.createSyncJobRow(input);
    this.activeSyncPromise = this.executeSyncJob(job.id, input).finally(() => {
      this.activeSyncPromise = null;
    });
    return job;
  }

  /**
   * Runs a sync job to completion and returns the finished job (ideal for tests and CLI runs).
   */
  async runSyncNow(raw: TriggerSyncInput = {}): Promise<RepoEvolutionSyncJob> {
    await this.init();
    const input = parseInput(triggerSyncSchema, raw);
    const job = await this.createSyncJobRow(input);
    return this.executeSyncJob(job.id, input);
  }

  private async createSyncJobRow(input: z.output<typeof triggerSyncSchema>): Promise<RepoEvolutionSyncJob> {
    let resumeCursor: string | null = null;
    if (input.resumeJobId) {
      const prev = await this.getSyncJob(input.resumeJobId);
      resumeCursor = prev.cursor;
    }
    const id = `sync_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const nowIso = new Date(this.now()).toISOString();
    const res = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO repo_evolution_sync_jobs
         (id, mode, status, phase, cursor, started_at, updated_at)
       VALUES ($1, $2, 'running', 'init', $3, $4, $4)
       RETURNING *`,
      [id, input.mode, resumeCursor, nowIso],
    );
    return this.mapSyncJob(res.rows[0]!);
  }

  private async executeSyncJob(
    jobId: string,
    input: z.output<typeof triggerSyncSchema>,
  ): Promise<RepoEvolutionSyncJob> {
    const config = await this.getConfig();
    const providersCfg = this.providers?.get();
    const maxPages = input.maxPages ?? 120;
    let githubLogin: string | null = null;
    let ownedFetched = 0;
    let ownedTotal: number | null = null;
    let starredFetched = 0;
    let starredTotal: number | null = null;
    let listsFetched = 0;
    let embeddingsComputed = 0;
    let pagesProcessed = 0;
    let cursor: string | null = (await this.getSyncJob(jobId)).cursor;
    let earlyStopped = false;

    const flushProgress = async (phase: RepoEvolutionSyncPhase, status: RepoEvolutionSyncStatus = "running") => {
      const nowIso = new Date(this.now()).toISOString();
      await this.pool.query(
        `UPDATE repo_evolution_sync_jobs
         SET status = $1, phase = $2, github_login = COALESCE($3, github_login),
             owned_fetched = $4, owned_total = $5,
             starred_fetched = $6, starred_total = $7,
             lists_fetched = $8, embeddings_computed = $9,
             pages_processed = $10, cursor = $11, early_stopped = $12,
             updated_at = $13,
             completed_at = CASE WHEN $1 IN ('completed', 'failed', 'cancelled') THEN $13 ELSE completed_at END
         WHERE id = $14`,
        [
          status,
          phase,
          githubLogin,
          ownedFetched,
          ownedTotal,
          starredFetched,
          starredTotal,
          listsFetched,
          embeddingsComputed,
          pagesProcessed,
          cursor,
          earlyStopped,
          nowIso,
          jobId,
        ],
      );
    };

    try {
      // 1. Owned repos (public + private)
      if (input.mode !== "stars_only") {
        await flushProgress("owned_repos");
        let ownCursor: string | null = null;
        for (let p = 0; p < maxPages; p++) {
          const page = await this.github.fetchOwnedReposPage(ownCursor);
          if (page.login) githubLogin = page.login;
          if (page.totalCount !== null) ownedTotal = page.totalCount;
          pagesProcessed++;
          const nowMs = this.now();
          for (const repo of page.items) {
            const res = await this.upsertSyncedRepo(repo, "owned", config, providersCfg, nowMs);
            ownedFetched++;
            if (res.embeddingComputed) embeddingsComputed++;
          }
          await flushProgress("owned_repos");
          if (!page.hasNextPage || !page.endCursor) break;
          ownCursor = page.endCursor;
        }
      }

      // 2. Starred repos (ordered STARRED_AT DESC, incremental early stop or full cursor resume)
      if (input.mode !== "owned_only") {
        await flushProgress("starred_repos");
        let latestKnownStarredMs: number | null = null;
        if (input.mode === "incremental" && !cursor) {
          const maxRes = await this.pool.query<{ max_ts: unknown }>(
            "SELECT MAX(starred_at) AS max_ts FROM repo_evolution_nodes WHERE role IN ('starred', 'both')",
          );
          const iso = toIso(maxRes.rows[0]?.max_ts);
          if (iso) {
            const parsed = Date.parse(iso);
            if (Number.isFinite(parsed)) latestKnownStarredMs = parsed;
          }
        }

        let starCursor: string | null = cursor;
        for (let p = 0; p < maxPages; p++) {
          const page = await this.github.fetchStarredReposPage(starCursor);
          if (page.login) githubLogin = page.login;
          if (page.totalCount !== null) starredTotal = page.totalCount;
          pagesProcessed++;
          const nowMs = this.now();
          let allOlderThanWatermark = latestKnownStarredMs !== null && page.items.length > 0;
          let anyNewOnPage = false;

          for (const repo of page.items) {
            const res = await this.upsertSyncedRepo(repo, "starred", config, providersCfg, nowMs);
            starredFetched++;
            if (res.embeddingComputed) embeddingsComputed++;
            if (res.isNew) anyNewOnPage = true;
            const stMs = repo.starredAt ? Date.parse(repo.starredAt) : NaN;
            if (latestKnownStarredMs !== null && Number.isFinite(stMs) && stMs > latestKnownStarredMs) {
              allOlderThanWatermark = false;
            }
          }

          cursor = page.hasNextPage ? page.endCursor : null;
          if (input.mode === "incremental" && allOlderThanWatermark && !anyNewOnPage) {
            earlyStopped = true;
            cursor = null;
            await flushProgress("starred_repos");
            break;
          }
          await flushProgress("starred_repos");
          if (!page.hasNextPage || !page.endCursor) break;
          starCursor = page.endCursor;
        }
      }

      // 3. GitHub Star Lists (non-fatal if empty/unavailable)
      if (input.mode === "full" || input.mode === "incremental") {
        await flushProgress("star_lists");
        try {
          const imported = await this.importGithubStarLists();
          listsFetched = imported.importedDomains;
        } catch {
          // Star lists are optional on GitHub; do not fail the whole sync job.
        }
      }

      await flushProgress("done", "completed");

      await this.recordEvent({
        eventType: "sync_completed",
        title: `GitHub 同步完成（${input.mode === "full" ? "全量" : "增量"}）`,
        summary: `自有仓 ${ownedFetched}${ownedTotal !== null ? `/${ownedTotal}` : ""}、Star 仓 ${starredFetched}${starredTotal !== null ? `/${starredTotal}` : ""}、更新向量 ${embeddingsComputed} 个${earlyStopped ? "（增量早停）" : ""}。`,
        actor: githubLogin ? `github:${githubLogin}` : "system",
        metadata: {
          jobId,
          mode: input.mode,
          ownedFetched,
          starredFetched,
          listsFetched,
          embeddingsComputed,
          earlyStopped,
        },
      });

      return this.getSyncJob(jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nowIso = new Date(this.now()).toISOString();
      await this.pool.query(
        `UPDATE repo_evolution_sync_jobs
         SET status = 'failed', phase = 'error', error_message = $1,
             owned_fetched = $2, starred_fetched = $3, pages_processed = $4, cursor = $5,
             updated_at = $6, completed_at = $6
         WHERE id = $7`,
        [msg, ownedFetched, starredFetched, pagesProcessed, cursor, nowIso, jobId],
      );
      return this.getSyncJob(jobId);
    }
  }

  // ---- Stage 1: AI Vector Clustering & 1-to-N Recall (pgvector HNSW) ----

  async clusterAndRecall(raw: ClusterAndRecallInput = {}): Promise<ClusterAndRecallResult> {
    await this.init();
    const startMs = Date.now();
    const input = parseInput(clusterRecallSchema, raw);
    const config = await this.getConfig();
    const providersCfg = this.providers?.get();
    const nowIso = new Date(this.now()).toISOString();

    let embeddingsUpdated = 0;
    let domainsAssigned = 0;
    let linksSuggested = 0;
    let skippedStaleOrLowMatch = 0;
    let spotlightMatches = 0;

    // Step 1: Ensure embeddings for nodes lacking them (or all if recomputeEmbeddings)
    const embNodesRes = await this.pool.query<Record<string, unknown>>(
      input.recomputeEmbeddings
        ? "SELECT id, full_name, name, description, primary_language, topics_json, readme_digest_json FROM repo_evolution_nodes"
        : "SELECT id, full_name, name, description, primary_language, topics_json, readme_digest_json FROM repo_evolution_nodes WHERE embedding IS NULL",
    );
    for (const row of embNodesRes.rows) {
      const semText = buildRepoSemanticText({
        fullName: String(row.full_name),
        name: String(row.name),
        description: String(row.description ?? ""),
        primaryLanguage: row.primary_language ? String(row.primary_language) : null,
        topics: safeJson<string[]>(row.topics_json, []),
        readmeDigest: safeJson<RepoReadmeDigest | null>(row.readme_digest_json, null),
      });
      const emb = await computeSemanticVector(semText, providersCfg);
      await this.pool.query(
        "UPDATE repo_evolution_nodes SET embedding = $1::vector, embedding_source = $2, updated_at = $3 WHERE id = $4",
        [toPgVectorLiteral(emb.vector, emb.source), emb.source, nowIso, String(row.id)],
      );
      embeddingsUpdated++;
    }

    // Step 2: Refresh domain centroids (blending keyword centroid + manual exemplars)
    const domRes = await this.pool.query<Record<string, unknown>>("SELECT * FROM repo_domains");
    const domains = domRes.rows.map((r) => this.mapDomain(r));
    const domainCentroids = new Map<string, { domain: RepoDomain; vec: number[] }>();

    for (const dom of domains) {
      const baseVec = debiasLocalSemanticVector(
        localSemanticVector(`${dom.name} ${dom.description} ${dom.seedKeywords.join(" ")}`, REPO_EVOLUTION_VECTOR_DIM),
        "local",
      );
      const manualRes = await this.pool.query<{ emb_text: string }>(
        `SELECT embedding::text AS emb_text FROM repo_evolution_nodes
         WHERE primary_domain_id = $1 AND domain_assigned_by IN ('manual', 'github_list') AND embedding IS NOT NULL
         LIMIT 50`,
        [dom.id],
      );
      let finalVec = baseVec;
      if (manualRes.rows.length > 0) {
        const sum = new Float64Array(REPO_EVOLUTION_VECTOR_DIM);
        let count = 0;
        for (const mr of manualRes.rows) {
          const parsed = parsePgVectorLiteral(mr.emb_text);
          if (!parsed) continue;
          for (let i = 0; i < REPO_EVOLUTION_VECTOR_DIM; i++) sum[i] += parsed[i]!;
          count++;
        }
        if (count > 0) {
          const blended = new Array<number>(REPO_EVOLUTION_VECTOR_DIM);
          for (let i = 0; i < REPO_EVOLUTION_VECTOR_DIM; i++) {
            blended[i] = baseVec[i]! * 0.65 + (sum[i]! / count) * 0.35;
          }
          finalVec = normalizeVectorToDim(blended);
        }
      }
      await this.pool.query(
        "UPDATE repo_domains SET centroid = $1::vector WHERE id = $2",
        [toPgVectorLiteral(finalVec), dom.id],
      );
      domainCentroids.set(dom.id, { domain: dom, vec: finalVec });
    }

    // Step 3: Cluster unassigned (or reclassifyAi) starred repos into domains
    if (domains.length > 0) {
      const candidateWhere = input.reclassifyAi
        ? "role IN ('starred', 'both') AND domain_assigned_by IN ('unassigned', 'ai') AND embedding IS NOT NULL"
        : "role IN ('starred', 'both') AND primary_domain_id IS NULL AND domain_assigned_by = 'unassigned' AND embedding IS NOT NULL";
      const starNodesRes = await this.pool.query<Record<string, unknown>>(
        `SELECT id, full_name, name, description, primary_language, topics_json, vitality, priority_tier, embedding::text AS emb_text
         FROM repo_evolution_nodes
         WHERE ${candidateWhere}`,
      );

      for (const row of starNodesRes.rows) {
        const nodeId = String(row.id);
        const vec = parsePgVectorLiteral(row.emb_text);
        if (!vec) continue;
        const topics = safeJson<string[]>(row.topics_json, []);
        const tokens = extractTokens(
          `${row.name} ${row.description ?? ""} ${row.primary_language ?? ""} ${topics.join(" ")}`,
        );

        const scored: Array<{ domainId: string; score: number }> = [];
        for (const { domain, vec: centroid } of domainCentroids.values()) {
          const sim = cosineSimilarity(vec, centroid);
          const kwBoost = keywordOverlapBoost(tokens, domain.seedKeywords);
          const combined = Math.min(1, Math.max(0, sim * 0.8 + kwBoost));
          scored.push({ domainId: domain.id, score: combined });
        }
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        if (best && best.score >= config.minClusterSimilarity) {
          await this.pool.query(
            `UPDATE repo_evolution_nodes
             SET primary_domain_id = $1, domain_confidence = $2, domain_assigned_by = 'ai', updated_at = $3
             WHERE id = $4`,
            [best.domainId, Math.round(best.score * 1000) / 1000, nowIso, nodeId],
          );
          domainsAssigned++;

          const second = scored[1];
          if (second && second.score >= config.minClusterSimilarity + 0.06) {
            await this.pool.query(
              `INSERT INTO repo_evolution_node_domains (node_id, domain_id, confidence, assigned_by)
               VALUES ($1, $2, $3, 'ai')
               ON CONFLICT (node_id, domain_id) DO NOTHING`,
              [nodeId, second.domainId, Math.round(second.score * 1000) / 1000],
            );
          }
        } else {
          skippedStaleOrLowMatch++;
        }
      }
    }

    // Step 4: Recall 1-to-N absorption candidates using pgvector HNSW (<=> cosine distance)
    const ownedParams: unknown[] = [];
    let ownedFilterSql =
      "role IN ('owned', 'both') AND priority_tier <> 'archived' AND ((is_fork = FALSE AND is_archived = FALSE) OR priority_tier = 'spotlight') AND embedding IS NOT NULL";
    if (input.focusOwnedNodeId) {
      ownedParams.push(input.focusOwnedNodeId, input.focusOwnedNodeId.toLowerCase());
      ownedFilterSql += " AND (id = $1 OR full_name_lower = $2 OR LOWER(name) = $2)";
    }
    const ownedRes = await this.pool.query<Record<string, unknown>>(
      `SELECT id, full_name, name, description, primary_language, topics_json, priority_tier, primary_domain_id, embedding::text AS emb_text
       FROM repo_evolution_nodes
       WHERE ${ownedFilterSql}
       ORDER BY CASE priority_tier WHEN 'spotlight' THEN 0 ELSE 1 END ASC, pushed_at DESC NULLS LAST`,
      ownedParams,
    );

    // Count stale/archived starred repos that naturally stay in Floating/Stale Pool
    const staleCountRes = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM repo_evolution_nodes n
       WHERE n.role IN ('starred', 'both')
         AND (n.vitality IN ('stale', 'archived') OR n.priority_tier = 'archived')
         AND NOT EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')`,
    );
    skippedStaleOrLowMatch += Number(staleCountRes.rows[0]?.n ?? 0);

    for (const targetRow of ownedRes.rows) {
      const targetId = String(targetRow.id);
      const targetFullName = String(targetRow.full_name);
      const targetTopics = safeJson<string[]>(targetRow.topics_json, []);
      const targetLang = targetRow.primary_language ? String(targetRow.primary_language) : null;
      const targetDomainId = targetRow.primary_domain_id ? String(targetRow.primary_domain_id) : null;
      const isSpotlight = targetRow.priority_tier === "spotlight";
      const targetVecStr = String(targetRow.emb_text ?? "");
      if (!targetVecStr) continue;

      const maxPerTarget = input.maxNewLinksPerOwned ?? (isSpotlight ? 12 : 6);

      // Query pgvector HNSW index for closest active/dormant Star repos not already linked (nor rejected!)
      const candidatesRes = await this.pool.query<Record<string, unknown>>(
        `SELECT n.id, n.full_name, n.name, n.description, n.primary_language, n.topics_json,
                n.primary_domain_id, n.vitality, n.stars_count,
                (1 - (n.embedding <=> $1::vector)) AS cosine_sim
         FROM repo_evolution_nodes n
         WHERE n.role IN ('starred', 'both')
           AND n.id <> $2
           AND n.embedding IS NOT NULL
           AND n.vitality IN ('active', 'dormant')
           AND n.priority_tier <> 'archived'
           AND NOT EXISTS (
             SELECT 1 FROM repo_absorption_links l
             WHERE l.source_node_id = n.id AND l.target_node_id = $2
           )
         ORDER BY n.embedding <=> $1::vector ASC
         LIMIT 40`,
        [targetVecStr, targetId],
      );

      let addedForTarget = 0;
      for (const cand of candidatesRes.rows) {
        if (addedForTarget >= maxPerTarget) break;
        const rawCosine = Number(cand.cosine_sim ?? 0);
        if (!Number.isFinite(rawCosine)) continue;
        const candTopics = safeJson<string[]>(cand.topics_json, []);
        const candLang = cand.primary_language ? String(cand.primary_language) : null;
        const candDomainId = cand.primary_domain_id ? String(cand.primary_domain_id) : null;

        const tBoost = topicOverlapScore(candTopics, targetTopics, candLang, targetLang);
        const domainBoost = targetDomainId && candDomainId && targetDomainId === candDomainId ? 0.06 : 0;
        const baseScore = rawCosine + tBoost + domainBoost;
        const effectiveScore = Math.min(0.99, baseScore + (isSpotlight ? config.spotlightBonus : 0));

        // Never force-link unrelated repos even for spotlight targets
        const minBaseFloor = Math.max(0.16, config.minLinkSimilarity - config.spotlightBonus);
        if (effectiveScore < config.minLinkSimilarity || baseScore < minBaseFloor) {
          skippedStaleOrLowMatch++;
          continue;
        }

        const candId = String(cand.id);
        const candFullName = String(cand.full_name);
        const candName = String(cand.name);
        const candDesc = String(cand.description ?? "");
        const relationType = inferRelationType({
          name: candName,
          description: candDesc,
          topics: candTopics,
        });
        const strength = Math.round(effectiveScore * 1000) / 1000;
        const linkId = `lnk_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
        const rationale = `pgvector 语义召回匹配（相似度 ${(rawCosine * 100).toFixed(0)}%，综合分 ${(strength * 100).toFixed(0)}%${isSpotlight ? "，重点关注仓加权" : ""}）：${candDesc.slice(0, 140) || candFullName}`;

        const inserted = await this.pool.query<{ id: string }>(
          `INSERT INTO repo_absorption_links (
             id, source_node_id, target_node_id, relation_type, status, strength, rationale,
             created_by, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'suggested', $5, $6, 'ai', $7, $7)
           ON CONFLICT (source_node_id, target_node_id) DO NOTHING
           RETURNING id`,
          [linkId, candId, targetId, relationType, strength, rationale, nowIso],
        );

        if (inserted.rows[0]) {
          addedForTarget++;
          linksSuggested++;
          if (isSpotlight) spotlightMatches++;
          await this.recordEvent({
            linkId,
            sourceNodeId: candId,
            targetNodeId: targetId,
            domainId: candDomainId,
            eventType: "link_discovered",
            title: `AI 发现吸收建议：${candFullName} → ${targetFullName}`,
            summary: rationale,
            actor: "ai:pgvector",
            metadata: { cosine: rawCosine, strength, relationType, isSpotlight },
          });
        }
      }
    }

    if (domainsAssigned > 0 || linksSuggested > 0) {
      await this.recordEvent({
        eventType: "domain_clustered",
        title: `向量聚类与召回完成：归类 ${domainsAssigned} 仓 · 新建 ${linksSuggested} 条吸收建议`,
        summary: `重点关注仓命中 ${spotlightMatches} 条；${skippedStaleOrLowMatch} 条陈旧/低相关仓库自然保留在游离散落池。`,
        actor: "ai:pgvector",
        metadata: {
          embeddingsUpdated,
          domainsAssigned,
          linksSuggested,
          skippedStaleOrLowMatch,
          spotlightMatches,
        },
      });
    }

    return {
      embeddingsUpdated,
      domainsAssigned,
      linksSuggested,
      skippedStaleOrLowMatch,
      spotlightMatches,
      durationMs: Date.now() - startMs,
    };
  }

  // ---- Stats, Macro Graph & Focus Graph Projections ----

  async getStats(): Promise<RepoEvolutionStats> {
    await this.init();
    const [nodeRes, linkRes, domRes] = await Promise.all([
      this.pool.query<Record<string, unknown>>(`
        SELECT
          COUNT(*) FILTER (WHERE role IN ('owned', 'both'))::int AS owned_count,
          COUNT(*) FILTER (WHERE role IN ('owned', 'both') AND visibility = 'public')::int AS owned_public_count,
          COUNT(*) FILTER (WHERE role IN ('owned', 'both') AND visibility = 'private')::int AS owned_private_count,
          COUNT(*) FILTER (WHERE priority_tier = 'spotlight')::int AS spotlight_count,
          COUNT(*) FILTER (WHERE role IN ('starred', 'both'))::int AS starred_count,
          COUNT(*) FILTER (WHERE role IN ('starred', 'both') AND vitality = 'active')::int AS active_starred_count,
          COUNT(*) FILTER (WHERE role IN ('starred', 'both') AND vitality = 'dormant')::int AS dormant_starred_count,
          COUNT(*) FILTER (WHERE role IN ('starred', 'both') AND vitality = 'stale')::int AS stale_starred_count,
          COUNT(*) FILTER (WHERE role IN ('starred', 'both') AND vitality = 'archived')::int AS archived_starred_count,
          COUNT(*) FILTER (
            WHERE role IN ('starred', 'both')
              AND NOT EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')
          )::int AS floating_pool_count,
          COUNT(*) FILTER (
            WHERE role IN ('starred', 'both')
              AND NOT EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')
              AND vitality NOT IN ('stale', 'archived') AND priority_tier <> 'archived'
              AND primary_domain_id IS NULL
          )::int AS unclassified_count,
          COUNT(*) FILTER (
            WHERE role IN ('starred', 'both')
              AND NOT EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')
              AND vitality NOT IN ('stale', 'archived') AND priority_tier <> 'archived'
              AND primary_domain_id IS NOT NULL
          )::int AS classified_unlinked_count,
          COUNT(*) FILTER (
            WHERE role IN ('starred', 'both')
              AND NOT EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')
              AND (vitality IN ('stale', 'archived') OR priority_tier = 'archived')
          )::int AS stale_pool_count,
          COUNT(*) FILTER (
            WHERE role IN ('starred', 'both')
              AND (
                EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status = 'suggested')
                OR (domain_assigned_by = 'ai' AND primary_domain_id IS NOT NULL)
              )
          )::int AS ai_suggested_count
        FROM repo_evolution_nodes n
      `),
      this.pool.query<Record<string, unknown>>(`
        SELECT
          COUNT(*)::int AS link_count,
          COUNT(*) FILTER (WHERE status = 'suggested')::int AS suggested_count,
          COUNT(*) FILTER (WHERE status = 'watching')::int AS watching_count,
          COUNT(*) FILTER (WHERE status = 'in_review')::int AS in_review_count,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
          COUNT(*) FILTER (WHERE status = 'absorbing')::int AS absorbing_count,
          COUNT(*) FILTER (WHERE status = 'absorbed')::int AS absorbed_count,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count
        FROM repo_absorption_links
      `),
      this.pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM repo_domains"),
    ]);

    const nr = nodeRes.rows[0] ?? {};
    const lr = linkRes.rows[0] ?? {};
    return {
      ownedCount: Number(nr.owned_count ?? 0),
      ownedPublicCount: Number(nr.owned_public_count ?? 0),
      ownedPrivateCount: Number(nr.owned_private_count ?? 0),
      spotlightCount: Number(nr.spotlight_count ?? 0),
      starredCount: Number(nr.starred_count ?? 0),
      activeStarredCount: Number(nr.active_starred_count ?? 0),
      dormantStarredCount: Number(nr.dormant_starred_count ?? 0),
      staleStarredCount: Number(nr.stale_starred_count ?? 0),
      archivedStarredCount: Number(nr.archived_starred_count ?? 0),
      domainCount: Number(domRes.rows[0]?.n ?? 0),
      linkCount: Number(lr.link_count ?? 0),
      suggestedLinkCount: Number(lr.suggested_count ?? 0),
      watchingLinkCount: Number(lr.watching_count ?? 0),
      inReviewLinkCount: Number(lr.in_review_count ?? 0),
      approvedLinkCount: Number(lr.approved_count ?? 0),
      absorbingLinkCount: Number(lr.absorbing_count ?? 0),
      absorbedLinkCount: Number(lr.absorbed_count ?? 0),
      rejectedLinkCount: Number(lr.rejected_count ?? 0),
      floatingPoolCount: Number(nr.floating_pool_count ?? 0),
      unclassifiedCount: Number(nr.unclassified_count ?? 0),
      classifiedUnlinkedCount: Number(nr.classified_unlinked_count ?? 0),
      stalePoolCount: Number(nr.stale_pool_count ?? 0),
      aiSuggestedCount: Number(nr.ai_suggested_count ?? 0),
    };
  }

  async getMacroGraph(): Promise<RepoEvolutionMacroGraph> {
    await this.init();
    const [stats, domains, config, syncList, ownedRes, floatingSampleRes, macroEdgesRes] =
      await Promise.all([
        this.getStats(),
        this.listDomainClusters(),
        this.getConfig(),
        this.listSyncJobs(5),
        this.pool.query<Record<string, unknown>>(`
          SELECT n.*,
            d.name AS domain_name,
            d.color AS domain_color,
            COUNT(l.id) FILTER (WHERE l.status <> 'rejected')::int AS incoming_link_count,
            COUNT(l.id) FILTER (WHERE l.status = 'suggested')::int AS suggested_count,
            COUNT(l.id) FILTER (WHERE l.status = 'watching')::int AS watching_count,
            COUNT(l.id) FILTER (WHERE l.status = 'in_review')::int AS in_review_count,
            COUNT(l.id) FILTER (WHERE l.status = 'approved')::int AS approved_count,
            COUNT(l.id) FILTER (WHERE l.status = 'absorbing')::int AS absorbing_count,
            COUNT(l.id) FILTER (WHERE l.status = 'absorbed')::int AS absorbed_count,
            COALESCE(SUM(CASE WHEN l.status <> 'rejected' THEN jsonb_array_length(l.module_analysis_json) ELSE 0 END), 0)::int AS module_point_count
          FROM repo_evolution_nodes n
          LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
          LEFT JOIN repo_absorption_links l ON l.target_node_id = n.id
          WHERE n.role IN ('owned', 'both')
          GROUP BY n.id, d.name, d.color
          ORDER BY
            CASE n.priority_tier WHEN 'spotlight' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END ASC,
            CASE WHEN n.is_fork THEN 1 ELSE 0 END ASC,
            COUNT(l.id) FILTER (WHERE l.status <> 'rejected') DESC,
            n.pushed_at DESC NULLS LAST
        `),
        this.pool.query<Record<string, unknown>>(`
          SELECT n.*, d.name AS domain_name, d.color AS domain_color
          FROM repo_evolution_nodes n
          LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
          WHERE n.role IN ('starred', 'both')
            AND NOT EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')
          ORDER BY n.stars_count DESC, n.starred_at DESC NULLS LAST
          LIMIT 8
        `),
        this.pool.query<Record<string, unknown>>(`
          SELECT
            COALESCE(s.primary_domain_id, '__floating__') AS source_domain_id,
            COALESCE(d.name, '游离散落星云') AS source_domain_name,
            COALESCE(d.color, '#94a3b8') AS source_domain_color,
            l.target_node_id,
            t.full_name AS target_repo_full_name,
            COUNT(*)::int AS link_count,
            COUNT(*) FILTER (WHERE l.status = 'suggested')::int AS suggested_count,
            COUNT(*) FILTER (WHERE l.status = 'watching')::int AS watching_count,
            COUNT(*) FILTER (WHERE l.status = 'in_review')::int AS in_review_count,
            COUNT(*) FILTER (WHERE l.status = 'approved')::int AS approved_count,
            COUNT(*) FILTER (WHERE l.status = 'absorbed')::int AS absorbed_count,
            AVG(l.strength)::float AS avg_strength,
            COALESCE(SUM(jsonb_array_length(l.module_analysis_json)), 0)::int AS module_point_count
          FROM repo_absorption_links l
          JOIN repo_evolution_nodes s ON s.id = l.source_node_id
          JOIN repo_evolution_nodes t ON t.id = l.target_node_id
          LEFT JOIN repo_domains d ON d.id = s.primary_domain_id
          WHERE l.status <> 'rejected'
          GROUP BY COALESCE(s.primary_domain_id, '__floating__'), COALESCE(d.name, '游离散落星云'), COALESCE(d.color, '#94a3b8'), l.target_node_id, t.full_name
          ORDER BY COUNT(*) DESC, AVG(l.strength) DESC
        `),
      ]);

    const ownedRepos: RepoOwnedSummaryNode[] = ownedRes.rows.map((r) => ({
      ...this.mapNodeBrief(r),
      description: String(r.description ?? ""),
      pushedAt: toIso(r.pushed_at),
      incomingLinkCount: Number(r.incoming_link_count ?? 0),
      suggestedCount: Number(r.suggested_count ?? 0),
      watchingCount: Number(r.watching_count ?? 0),
      inReviewCount: Number(r.in_review_count ?? 0),
      approvedCount: Number(r.approved_count ?? 0),
      absorbingCount: Number(r.absorbing_count ?? 0),
      absorbedCount: Number(r.absorbed_count ?? 0),
      modulePointCount: Number(r.module_point_count ?? 0),
    }));

    const floatingPool: RepoFloatingPoolSummary = {
      totalCount: stats.floatingPoolCount,
      unclassifiedCount: stats.unclassifiedCount,
      classifiedUnlinkedCount: stats.classifiedUnlinkedCount,
      staleCount: stats.stalePoolCount,
      archivedCount: stats.archivedStarredCount,
      sampleRepos: floatingSampleRes.rows.map((r) => this.mapNodeBrief(r)),
    };

    const macroEdges: RepoMacroEdge[] = macroEdgesRes.rows.map((r) => {
      const sourceDomainId = String(r.source_domain_id);
      const targetNodeId = String(r.target_node_id);
      return {
        id: `me_${sourceDomainId}__${targetNodeId}`,
        sourceDomainId,
        sourceDomainName: String(r.source_domain_name),
        sourceDomainColor: String(r.source_domain_color),
        targetNodeId,
        targetRepoFullName: String(r.target_repo_full_name),
        linkCount: Number(r.link_count ?? 0),
        suggestedCount: Number(r.suggested_count ?? 0),
        watchingCount: Number(r.watching_count ?? 0),
        inReviewCount: Number(r.in_review_count ?? 0),
        approvedCount: Number(r.approved_count ?? 0),
        absorbedCount: Number(r.absorbed_count ?? 0),
        avgStrength: Math.round(Number(r.avg_strength ?? 0) * 1000) / 1000,
        modulePointCount: Number(r.module_point_count ?? 0),
      };
    });

    return {
      stats,
      domains,
      floatingPool,
      ownedRepos,
      macroEdges,
      config,
      activeSyncJob: syncList.activeJob,
      latestSyncJob: syncList.jobs[0] ?? null,
    };
  }

  async getFocusGraph(query: {
    focusType?: RepoFocusType;
    focusId?: string;
    q?: string;
    status?: string;
    vitality?: string;
    includeRejected?: boolean;
    limit?: number;
  } = {}): Promise<RepoEvolutionFocusGraph> {
    await this.init();
    const focusType: RepoFocusType = query.focusType ?? "all";
    const limit = Math.max(1, Math.min(80, Number(query.limit ?? 60) || 60));
    const includeRejected = Boolean(query.includeRejected);
    let focusId = query.focusId?.trim() || null;
    let focusLabel = "全部聚焦图谱";

    const starWhere: string[] = ["n.role IN ('starred', 'both')"];
    const starParams: unknown[] = [];
    const pushStar = (v: unknown) => {
      starParams.push(v);
      return `$${starParams.length}`;
    };

    let focusedOwnedId: string | null = null;

    if (focusType === "domain" && focusId) {
      const domRes = await this.pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM repo_domains WHERE id = $1 OR slug = $1 LIMIT 1",
        [focusId],
      );
      if (domRes.rows[0]) {
        focusId = domRes.rows[0].id;
        focusLabel = `领域 · ${domRes.rows[0].name}`;
        const p = pushStar(focusId);
        starWhere.push(
          `(n.primary_domain_id = ${p} OR EXISTS (SELECT 1 FROM repo_evolution_node_domains nd WHERE nd.node_id = n.id AND nd.domain_id = ${p}))`,
        );
      }
    } else if (focusType === "star" && focusId) {
      const nodeRow = await this.resolveNodeRow(focusId);
      if (nodeRow) {
        focusId = String(nodeRow.id);
        focusLabel = `Star 仓 · ${String(nodeRow.full_name)}`;
        starWhere.push(`n.id = ${pushStar(focusId)}`);
      }
    } else if (focusType === "owned" && focusId) {
      const nodeRow = await this.resolveNodeRow(focusId);
      if (nodeRow) {
        focusedOwnedId = String(nodeRow.id);
        focusId = focusedOwnedId;
        focusLabel = `我的库 · ${String(nodeRow.full_name)}`;
        const p = pushStar(focusedOwnedId);
        const rejClause = includeRejected ? "" : "AND l.status <> 'rejected'";
        starWhere.push(
          `EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.target_node_id = ${p} ${rejClause})`,
        );
      }
    } else if (focusType === "floating") {
      focusLabel = "游离散落星云";
      starWhere.push(
        "NOT EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')",
      );
    }

    if (query.q?.trim()) {
      const p = pushStar(`%${query.q.trim().toLowerCase()}%`);
      starWhere.push(
        `(n.full_name_lower LIKE ${p} OR LOWER(n.description) LIKE ${p} OR LOWER(n.topics_json::text) LIKE ${p})`,
      );
    }
    if (query.vitality && query.vitality !== "all") {
      starWhere.push(`n.vitality = ${pushStar(query.vitality)}`);
    }
    if (query.status && query.status !== "all") {
      const p = pushStar(query.status);
      starWhere.push(
        `EXISTS (SELECT 1 FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status = ${p})`,
      );
    }

    const starWhereSql = `WHERE ${starWhere.join(" AND ")}`;
    const totalRes = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM repo_evolution_nodes n ${starWhereSql}`,
      starParams,
    );
    const totalMatchingStars = Number(totalRes.rows[0]?.n ?? 0);

    const limitParam = pushStar(limit);
    const starRowsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT n.*,
         (n.embedding IS NOT NULL) AS has_embedding,
         d.name AS domain_name,
         d.color AS domain_color,
         (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.source_node_id = n.id)::int AS link_count,
         (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected')::int AS active_link_count
       FROM repo_evolution_nodes n
       LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
       ${starWhereSql}
       ORDER BY
         (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.source_node_id = n.id AND l.status <> 'rejected') DESC,
         CASE n.vitality WHEN 'active' THEN 0 WHEN 'dormant' THEN 1 WHEN 'stale' THEN 2 ELSE 3 END ASC,
         n.stars_count DESC
       LIMIT ${limitParam}`,
      starParams,
    );

    const starIds = starRowsRes.rows.map((r) => String(r.id));
    const starSecMap = await this.loadSecondaryDomainsMap(starIds);
    const starNodes = starRowsRes.rows.map((r) => this.mapNode(r, starSecMap.get(String(r.id)) ?? []));

    // Fetch links connecting these starNodes (and filtered to focusedOwnedId if focusing an owned repo)
    let links: RepoAbsorptionLink[] = [];
    if (starIds.length > 0) {
      const linkWhere: string[] = ["l.source_node_id = ANY($1::text[])"];
      const linkParams: unknown[] = [starIds];
      if (!includeRejected) linkWhere.push("l.status <> 'rejected'");
      if (focusedOwnedId) {
        linkParams.push(focusedOwnedId);
        linkWhere.push(`l.target_node_id = $${linkParams.length}`);
      }
      if (query.status && query.status !== "all") {
        linkParams.push(query.status);
        linkWhere.push(`l.status = $${linkParams.length}`);
      }
      const linksRes = await this.pool.query<Record<string, unknown>>(
        `${this.LINK_SELECT_SQL}
         WHERE ${linkWhere.join(" AND ")}
         ORDER BY l.strength DESC, l.updated_at DESC`,
        linkParams,
      );
      links = linksRes.rows.map((r) => this.mapLink(r));
    }

    // Determine right-column ownedNodes: focused owned repo, or all connected owned repos + spotlight repos
    const targetIds = new Set<string>(links.map((l) => l.targetNodeId));
    if (focusedOwnedId) targetIds.add(focusedOwnedId);

    const ownedRowsRes = await this.pool.query<Record<string, unknown>>(
      focusedOwnedId
        ? `SELECT n.*, (n.embedding IS NOT NULL) AS has_embedding, d.name AS domain_name, d.color AS domain_color,
             (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.target_node_id = n.id)::int AS link_count,
             (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.target_node_id = n.id AND l.status <> 'rejected')::int AS active_link_count
           FROM repo_evolution_nodes n
           LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
           WHERE n.id = $1`
        : targetIds.size > 0
          ? `SELECT n.*, (n.embedding IS NOT NULL) AS has_embedding, d.name AS domain_name, d.color AS domain_color,
               (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.target_node_id = n.id)::int AS link_count,
               (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.target_node_id = n.id AND l.status <> 'rejected')::int AS active_link_count
             FROM repo_evolution_nodes n
             LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
             WHERE n.id = ANY($1::text[]) OR (n.role IN ('owned', 'both') AND n.priority_tier = 'spotlight')
             ORDER BY CASE n.priority_tier WHEN 'spotlight' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END ASC, n.pushed_at DESC NULLS LAST
             LIMIT 30`
          : `SELECT n.*, (n.embedding IS NOT NULL) AS has_embedding, d.name AS domain_name, d.color AS domain_color,
               (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.target_node_id = n.id)::int AS link_count,
               (SELECT COUNT(*) FROM repo_absorption_links l WHERE l.target_node_id = n.id AND l.status <> 'rejected')::int AS active_link_count
             FROM repo_evolution_nodes n
             LEFT JOIN repo_domains d ON d.id = n.primary_domain_id
             WHERE n.role IN ('owned', 'both')
             ORDER BY CASE n.priority_tier WHEN 'spotlight' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END ASC, n.pushed_at DESC NULLS LAST
             LIMIT 20`,
      focusedOwnedId ? [focusedOwnedId] : targetIds.size > 0 ? [[...targetIds]] : [],
    );

    const ownedIds = ownedRowsRes.rows.map((r) => String(r.id));
    const ownedSecMap = await this.loadSecondaryDomainsMap(ownedIds);
    const ownedNodes = ownedRowsRes.rows.map((r) => this.mapNode(r, ownedSecMap.get(String(r.id)) ?? []));

    return {
      focusType,
      focusId,
      focusLabel,
      starNodes,
      ownedNodes,
      links,
      totalMatchingStars,
      truncated: totalMatchingStars > starNodes.length,
    };
  }
}

// ---- Hono Routes ----

function actorName(user: unknown): string {
  if (user && typeof user === "object" && "name" in user && typeof (user as { name?: unknown }).name === "string") {
    const n = (user as { name: string }).name.trim();
    if (n) return n;
  }
  return "founder";
}

export function addRepoEvolutionRoutes(
  app: Hono,
  service: RepoEvolutionService,
  requireUser: (c: Context) => unknown,
): RepoEvolutionService {
  const base = "/api/opc/repo-evolution";

  app.use(base, async (c, next) => {
    requireUser(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(base + "/*", async (c, next) => {
    requireUser(c);
    c.header("Cache-Control", "no-store");
    await next();
  });

  // Graph projections
  app.get(base + "/graph/macro", async (c) => c.json(await service.getMacroGraph()));
  app.get(base + "/overview", async (c) => c.json(await service.getMacroGraph()));
  app.get(base + "/graph/focus", async (c) => {
    const rawFocusType = c.req.query("focusType");
    const focusType: RepoFocusType =
      rawFocusType === "domain" ||
      rawFocusType === "star" ||
      rawFocusType === "owned" ||
      rawFocusType === "floating" ||
      rawFocusType === "all"
        ? rawFocusType
        : "all";
    return c.json(
      await service.getFocusGraph({
        focusType,
        focusId: c.req.query("focusId") ?? undefined,
        q: c.req.query("q") ?? undefined,
        status: c.req.query("status") ?? undefined,
        vitality: c.req.query("vitality") ?? undefined,
        includeRejected: c.req.query("includeRejected") === "true" || c.req.query("includeRejected") === "1",
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      }),
    );
  });

  // Nodes pagination, floating pool, register, update, batch, bulk 1-to-N linking, content preview
  app.get(base + "/nodes", async (c) =>
    c.json(
      await service.queryNodes({
        q: c.req.query("q") ?? undefined,
        role: (c.req.query("role") as RepoEvolutionNodesQuery["role"]) ?? undefined,
        bucket: (c.req.query("bucket") as RepoEvolutionNodesQuery["bucket"]) ?? undefined,
        domainId: c.req.query("domainId") ?? undefined,
        vitality: (c.req.query("vitality") as RepoEvolutionNodesQuery["vitality"]) ?? undefined,
        visibility: (c.req.query("visibility") as RepoEvolutionNodesQuery["visibility"]) ?? undefined,
        priorityTier: (c.req.query("priorityTier") as RepoEvolutionNodesQuery["priorityTier"]) ?? undefined,
        language: c.req.query("language") ?? undefined,
        sortBy: (c.req.query("sortBy") as RepoEvolutionNodesQuery["sortBy"]) ?? undefined,
        sortDir: c.req.query("sortDir") === "asc" ? "asc" : c.req.query("sortDir") === "desc" ? "desc" : undefined,
        page: c.req.query("page") ? Number(c.req.query("page")) : undefined,
        pageSize: c.req.query("pageSize") ? Number(c.req.query("pageSize")) : undefined,
      }),
    ),
  );
  app.post(base + "/nodes/register", async (c) =>
    c.json(await service.registerOwnedOrSpotlightNode(await c.req.json())),
  );
  app.post(base + "/nodes/batch", async (c) =>
    c.json(await service.batchUpdateNodes(await c.req.json())),
  );
  app.get(base + "/nodes/:id", async (c) => c.json(await service.getNodeDetail(c.req.param("id")!)));
  app.patch(base + "/nodes/:id", async (c) =>
    c.json(await service.updateNode(c.req.param("id")!, await c.req.json())),
  );
  app.post(base + "/nodes/:id/links/bulk", async (c) => {
    const actor = actorName(requireUser(c));
    return c.json(await service.bulkLinkTargets(c.req.param("id")!, await c.req.json(), actor));
  });
  app.get(base + "/nodes/:id/content", async (c) =>
    c.json(await service.getNodeContent(c.req.param("id")!)),
  );
  app.get(base + "/nodes/:id/search", async (c) =>
    c.json(await service.searchNodeContent(c.req.param("id")!, c.req.query("q") ?? "")),
  );
  app.get(base + "/content", async (c) => {
    const repo = c.req.query("repo") ?? "";
    if (!repo.trim()) throw new ApiError(400, "missing_repo", "请提供 repo 查询参数");
    return c.json(await service.getNodeContent(repo));
  });

  // Domains CRUD & GitHub Star Lists import
  app.get(base + "/domains", async (c) => c.json({ domains: await service.listDomainClusters() }));
  app.post(base + "/domains", async (c) => c.json(await service.createDomain(await c.req.json())));
  app.post(base + "/domains/merge", async (c) => c.json(await service.mergeDomains(await c.req.json())));
  app.post(base + "/domains/import-github-lists", async (c) =>
    c.json(await service.importGithubStarLists()),
  );
  app.patch(base + "/domains/:id", async (c) =>
    c.json(await service.updateDomain(c.req.param("id")!, await c.req.json())),
  );
  app.delete(base + "/domains/:id", async (c) =>
    c.json(await service.deleteDomain(c.req.param("id")!)),
  );

  // Links CRUD, Module Analysis, Submit to Mailbox, Promote to Opportunity
  app.get(base + "/links", async (c) =>
    c.json({
      links: await service.listLinks({
        sourceNodeId: c.req.query("sourceNodeId") ?? undefined,
        targetNodeId: c.req.query("targetNodeId") ?? undefined,
        status: c.req.query("status") ?? undefined,
        relationType: c.req.query("relationType") ?? undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      }),
    }),
  );
  app.post(base + "/links", async (c) => {
    const actor = actorName(requireUser(c));
    return c.json(await service.createLink(await c.req.json(), actor));
  });
  app.get(base + "/links/:id", async (c) => c.json(await service.getLink(c.req.param("id")!)));
  app.patch(base + "/links/:id", async (c) => {
    const actor = actorName(requireUser(c));
    return c.json(await service.updateLink(c.req.param("id")!, await c.req.json(), actor));
  });
  app.delete(base + "/links/:id", async (c) => c.json(await service.deleteLink(c.req.param("id")!)));
  app.post(base + "/links/:id/analyze", async (c) => {
    const actor = actorName(requireUser(c));
    let body: AnalyzeLinkInput = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    return c.json(await service.analyzeLink(c.req.param("id")!, body, actor));
  });
  app.post(base + "/links/:id/submit-mailbox", async (c) => {
    const actor = actorName(requireUser(c));
    let body: SubmitLinkToMailboxInput = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    return c.json(await service.submitLinkToMailbox(c.req.param("id")!, body, actor));
  });
  app.post(base + "/links/:id/promote-opportunity", async (c) => {
    const actor = actorName(requireUser(c));
    let body: PromoteLinkToOpportunityInput = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    return c.json(await service.promoteLinkToOpportunity(c.req.param("id")!, body, actor));
  });

  // Timeline
  app.get(base + "/timeline", async (c) =>
    c.json(
      await service.getTimeline({
        targetNodeId: c.req.query("targetNodeId") ?? undefined,
        sourceNodeId: c.req.query("sourceNodeId") ?? undefined,
        repoFullName: c.req.query("repoFullName") ?? undefined,
        domainId: c.req.query("domainId") ?? undefined,
        eventType: (c.req.query("eventType") as RepoEvolutionTimelineQuery["eventType"]) ?? undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
      }),
    ),
  );

  // Background Sync
  app.post(base + "/sync", async (c) => {
    let body: TriggerSyncInput = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    return c.json(await service.triggerSync(body), 202);
  });
  app.get(base + "/sync/jobs", async (c) =>
    c.json(await service.listSyncJobs(c.req.query("limit") ? Number(c.req.query("limit")) : 20)),
  );
  app.get(base + "/sync/jobs/:id", async (c) => c.json(await service.getSyncJob(c.req.param("id")!)));

  // AI Clustering & Recall
  app.post(base + "/cluster-and-recall", async (c) => {
    let body: ClusterAndRecallInput = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    return c.json(await service.clusterAndRecall(body));
  });

  // Config
  app.get(base + "/config", async (c) => c.json(await service.getConfig()));
  app.patch(base + "/config", async (c) => c.json(await service.updateConfig(await c.req.json())));

  return service;
}
