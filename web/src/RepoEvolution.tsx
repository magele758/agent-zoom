import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { IndexedRepo, RepoContent } from "../../src/activity-index-types";
import {
  REPO_ABSORPTION_STATUS_LABELS,
  REPO_AUTOMATION_MODE_LABELS,
  REPO_EVOLUTION_EVENT_LABELS,
  REPO_RELATION_LABELS,
  REPO_VITALITY_LABELS,
  type AnalyzeLinkResult,
  type BatchUpdateRepoNodesInput,
  type BatchUpdateRepoNodesResult,
  type ClusterAndRecallResult,
  type ImportGithubListsResult,
  type PromoteLinkToOpportunityResult,
  type RepoAbsorptionEvent,
  type RepoAbsorptionLink,
  type RepoAbsorptionStatus,
  type RepoDomain,
  type RepoDomainCluster,
  type RepoEvolutionAutomationMode,
  type RepoEvolutionConfig,
  type RepoEvolutionContentSearchResult,
  type RepoEvolutionEventType,
  type RepoEvolutionFocusGraph,
  type RepoEvolutionMacroGraph,
  type RepoEvolutionNode,
  type RepoEvolutionNodesPage,
  type RepoEvolutionSyncJob,
  type RepoEvolutionSyncPhase,
  type RepoEvolutionTimelinePage,
  type RepoFocusType,
  type RepoMacroEdge,
  type RepoModuleAnalysisItem,
  type RepoModuleEffort,
  type RepoModuleRisk,
  type RepoNodeBucketFilter,
  type RepoNodeSortBy,
  type RepoRelationType,
  type RepoVisibility,
  type RepoVitality,
  type SubmitLinkToMailboxResult,
} from "../../src/repo-evolution-types";
import { request } from "./api";
import { RepositoryIndexContent } from "./RepositoryIndexContent";
import "./repo-evolution.css";

const API_BASE = "/api/opc/repo-evolution";

type MainTab = "graph" | "domains" | "timeline";
type GraphMode = "macro" | "focus";

interface NodeDetailResponse {
  node: RepoEvolutionNode;
  outgoingLinks: RepoAbsorptionLink[];
  incomingLinks: RepoAbsorptionLink[];
}

interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

const DOMAIN_COLORS = [
  "#2b4e3c",
  "#483d82",
  "#9c3a21",
  "#246874",
  "#b9751d",
  "#6b4e71",
  "#3d6442",
  "#38567a",
  "#8a5a36",
  "#4f5d54",
];

const SYNC_PHASE_LABELS: Record<RepoEvolutionSyncPhase, string> = {
  init: "初始化连接",
  owned_repos: "拉取自有公开/私有仓",
  star_lists: "拉取 GitHub Star Lists",
  starred_repos: "分页拉取 Star 仓库",
  embedding: "计算语义向量与活性",
  done: "同步完成",
  error: "同步中断",
};

const RELATION_KEYS = Object.keys(REPO_RELATION_LABELS) as RepoRelationType[];
const STATUS_KEYS = Object.keys(REPO_ABSORPTION_STATUS_LABELS) as RepoAbsorptionStatus[];
const EVENT_KEYS = Object.keys(REPO_EVOLUTION_EVENT_LABELS) as RepoEvolutionEventType[];

const POOL_BUCKET_ITEMS: Array<{ id: RepoNodeBucketFilter; label: string; statKey?: keyof RepoEvolutionMacroGraph["stats"] }> = [
  { id: "all", label: "全部仓库" },
  { id: "spotlight", label: "重点关注 (ai-agent-node 等)", statKey: "spotlightCount" },
  { id: "owned", label: "我的开源库（含私有）", statKey: "ownedCount" },
  { id: "unclassified", label: "未归类池", statKey: "unclassifiedCount" },
  { id: "classified_unlinked", label: "已归类未连线", statKey: "classifiedUnlinkedCount" },
  { id: "stale_pool", label: "陈旧沉淀池", statKey: "stalePoolCount" },
  { id: "floating", label: "游离散落总池", statKey: "floatingPoolCount" },
  { id: "ai_suggested", label: "AI 待确认建议", statKey: "aiSuggestedCount" },
  { id: "linked", label: "已建立吸收边" },
];

const DOMAIN_ICON_MAP: Record<string, string> = {
  bot: "🤖",
  brain: "🧠",
  terminal: "⌨",
  layout: "❖",
  database: "⛁",
  globe: "🌐",
  film: "🎬",
  shield: "🛡",
  bookmark: "🔖",
  layers: "▤",
};

function formatDomainIcon(icon?: string | null): string {
  if (!icon) return "";
  const key = icon.trim().toLowerCase();
  if (!key) return "";
  if (DOMAIN_ICON_MAP[key]) return DOMAIN_ICON_MAP[key];
  if (/^[a-z0-9_-]+$/i.test(key)) return "◈";
  return icon.trim();
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function safeExternalUrl(raw?: string | null): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || u.protocol === "http:") return u.href;
  } catch {
    // ignore invalid URL
  }
  return "";
}

function formatStars(count: number): string {
  if (count >= 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("zh-CN", { year: "2-digit", month: "2-digit", day: "2-digit" });
}

function formatTimeFull(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function edgeStatusVisual(status: RepoAbsorptionStatus): { stroke: string; dash?: string; width: number } {
  switch (status) {
    case "suggested":
      return { stroke: "#b9751d", dash: "6 4", width: 2.1 };
    case "in_review":
      return { stroke: "#483d82", width: 2.5 };
    case "approved":
      return { stroke: "#2a6b48", width: 2.5 };
    case "absorbing":
      return { stroke: "#1f7a53", width: 2.8 };
    case "absorbed":
      return { stroke: "#1c5e3a", width: 3.1 };
    case "watching":
      return { stroke: "#7b847d", dash: "4 3", width: 1.8 };
    case "rejected":
      return { stroke: "#b05a4c", dash: "2 3", width: 1.5 };
  }
}

function macroEdgeColor(edge: RepoMacroEdge): string {
  if (edge.inReviewCount > 0) return "#483d82";
  if (edge.approvedCount + edge.absorbedCount > 0) return "#2a6b48";
  if (edge.suggestedCount > 0) return "#b9751d";
  return edge.sourceDomainColor || "#6e7a72";
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number): { d: string; midX: number; midY: number } {
  const dx = Math.abs(x2 - x1);
  const pull = Math.max(70, Math.min(220, dx * 0.44));
  const cx1 = x1 + pull;
  const cy1 = y1;
  const cx2 = x2 - pull;
  const cy2 = y2;
  const midX = 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2;
  const midY = 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2;
  return {
    d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
    midX,
    midY,
  };
}

function toIndexedRepo(node: RepoEvolutionNode): IndexedRepo {
  return {
    fullName: node.fullName,
    url: node.url,
    description: node.description,
    visibility: node.visibility,
    relations: [node.role],
    paths: [],
    language: node.primaryLanguage,
    pushedAt: node.pushedAt,
    defaultBranch: node.defaultBranch,
    managed: [],
  };
}

/**
 * 仓库内容与 README 预览组件：
 * 默认通过 `/api/opc/repo-evolution/nodes/:id/content` 读取任意 Star 仓与私有自有仓，
 * 同时支持一键切换至内嵌 `<RepositoryIndexContent />` 以便读取本地检出索引。
 */
function RepoNodeContentPreview({ node }: { node: RepoEvolutionNode }) {
  const [sourceMode, setSourceMode] = useState<"evolution" | "activity_index">("evolution");
  const [content, setContent] = useState<RepoContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retrySeq, setRetrySeq] = useState(0);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResult, setSearchResult] = useState<(RepoEvolutionContentSearchResult & { query: string }) | null>(null);

  useEffect(() => {
    setSourceMode("evolution");
    setContent(null);
    setError("");
    setQuery("");
    setSearchResult(null);
    setSearchError("");
  }, [node.id]);

  useEffect(() => {
    if (sourceMode !== "evolution") return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request<RepoContent>(`${API_BASE}/nodes/${encodeURIComponent(node.id)}/content`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted) setContent(res);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err, "暂时无法读取仓库内容"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [node.id, sourceMode, retrySeq]);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError("");
    try {
      const res = await request<RepoEvolutionContentSearchResult>(
        `${API_BASE}/nodes/${encodeURIComponent(node.id)}/search?${new URLSearchParams({ q })}`,
      );
      setSearchResult({ ...res, query: q });
    } catch (err) {
      setSearchError(describeError(err, "仓内搜索失败"));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="re-readme-panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 11.5, color: "#586058" }}>
          数据源：{sourceMode === "evolution" ? "进化图谱引擎（支持 Star/私有仓）" : "活动索引（RepositoryIndexContent）"}
        </span>
        <button
          type="button"
          className="re-mini"
          onClick={() => setSourceMode((m) => (m === "evolution" ? "activity_index" : "evolution"))}
        >
          {sourceMode === "evolution" ? "切至本地索引组件" : "切回图谱预览"}
        </button>
      </div>

      {sourceMode === "activity_index" ? (
        <RepositoryIndexContent repo={toIndexedRepo(node)} />
      ) : (
        <section className="idx-content" aria-label="仓库内容与 README">
          <form onSubmit={(e) => void handleSearch(e)} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在仓内搜索文件或代码关键词…"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="submit" disabled={!query.trim() || searching}>
              {searching ? "搜索中…" : "搜索"}
            </button>
          </form>

          {searchError && <p role="alert" style={{ color: "#9c3a21", fontSize: 12 }}>{searchError}</p>}
          {searchResult && (
            <div className="idx-code-results" style={{ marginBottom: 8, fontSize: 12 }}>
              <p style={{ margin: "0 0 4px" }}>
                “{searchResult.query}” · {searchResult.source} · {searchResult.items.length} 条匹配
              </p>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {searchResult.items.slice(0, 12).map((item, idx) => {
                  const href = safeExternalUrl(item.url);
                  return (
                    <li key={`${item.path}-${idx}`}>
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer">
                          {item.path}
                          {item.line !== undefined ? `:${item.line}` : ""}
                        </a>
                      ) : (
                        <code>{item.path}</code>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {loading && <p role="status" style={{ fontSize: 12, color: "#5e645d" }}>正在拉取根目录与 README…</p>}
          {error && (
            <p role="alert" style={{ fontSize: 12, color: "#9c3a21" }}>
              {error}{" "}
              <button type="button" className="re-mini" onClick={() => setRetrySeq((n) => n + 1)}>
                重试
              </button>
            </p>
          )}
          {content && (
            <>
              <p className="idx-content-meta" style={{ fontSize: 11.5, margin: "4px 0 6px" }}>
                {content.source}
                {content.ref ? ` · ${content.ref.slice(0, 8)}` : ""}
                {content.note ? ` · ${content.note}` : ""}
              </p>
              <details className="idx-filetree" style={{ marginBottom: 8 }}>
                <summary style={{ fontSize: 12, cursor: "pointer" }}>
                  根目录文件树 · {content.files.length} 项
                </summary>
                <ul style={{ fontSize: 12, marginTop: 4 }}>
                  {content.files.slice(0, 40).map((f) => {
                    const href = safeExternalUrl(f.url);
                    return (
                      <li key={f.name}>
                        <span>{f.directory ? "目录" : "文件"}</span>
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer">{f.name}</a>
                        ) : (
                          <code>{f.name}</code>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
              <section className="idx-readme">
                <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <strong style={{ fontSize: 12.5 }}>README</strong>
                  {safeExternalUrl(content.readme?.url) && (
                    <a href={safeExternalUrl(content.readme?.url)} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                      查看原文 ↗
                    </a>
                  )}
                </header>
                {content.readme ? (
                  <>
                    <pre>{content.readme.text}</pre>
                    {content.readme.truncated && <small style={{ color: "#686c64" }}>已截断显示前段内容。</small>}
                  </>
                ) : (
                  <p style={{ fontSize: 12, color: "#686c64" }}>该仓库暂无可读取的 README。</p>
                )}
              </section>
            </>
          )}
        </section>
      )}
    </div>
  );
}

export function RepoEvolution({
  nav,
  hashQuery = "",
  initialTab,
  initialLinkId,
  initialRepo,
  initialDomainId,
  initialNodeId,
  initialBucket,
}: {
  nav?: ReactNode;
  hashQuery?: string;
  initialTab?: MainTab;
  initialLinkId?: string;
  initialRepo?: string;
  initialDomainId?: string;
  initialNodeId?: string;
  initialBucket?: string;
}) {
  const [activeTab, setActiveTab] = useState<MainTab>(initialTab ?? "graph");
  const [graphMode, setGraphMode] = useState<GraphMode>(
    initialLinkId || initialDomainId || initialNodeId || initialRepo ? "focus" : "macro",
  );

  // Core data states
  const [macroGraph, setMacroGraph] = useState<RepoEvolutionMacroGraph | null>(null);
  const [focusGraph, setFocusGraph] = useState<RepoEvolutionFocusGraph | null>(null);
  const [focusParams, setFocusParams] = useState<{
    focusType: RepoFocusType;
    focusId: string;
    status: RepoAbsorptionStatus | "all";
    vitality: RepoVitality | "all";
    includeRejected: boolean;
    q: string;
  }>({
    focusType: initialDomainId ? "domain" : initialNodeId ? "owned" : "all",
    focusId: initialDomainId ?? initialNodeId ?? "",
    status: "all",
    vitality: "all",
    includeRejected: false,
    q: "",
  });

  // Graph UI states
  const [viewport, setViewport] = useState<ViewportState>({ x: 16, y: 12, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredMacroDomainId, setHoveredMacroDomainId] = useState<string | null>(null);
  const [hoveredMacroOwnedId, setHoveredMacroOwnedId] = useState<string | null>(null);
  const [hoveredMacroEdgeId, setHoveredMacroEdgeId] = useState<string | null>(null);
  const [hoveredFocusStarId, setHoveredFocusStarId] = useState<string | null>(null);
  const [hoveredFocusOwnedId, setHoveredFocusOwnedId] = useState<string | null>(null);
  const [hoveredFocusLinkId, setHoveredFocusLinkId] = useState<string | null>(null);
  const [showAllOwnedInMacro, setShowAllOwnedInMacro] = useState(false);

  // Quick graph search
  const [graphSearch, setGraphSearch] = useState("");
  const [graphSearchResults, setGraphSearchResults] = useState<RepoEvolutionNode[]>([]);
  const [graphSearchOpen, setGraphSearchOpen] = useState(false);

  // Inspector drawer state
  const [inspectorMode, setInspectorMode] = useState<"none" | "node" | "link">("none");
  const [selectedNodeDetail, setSelectedNodeDetail] = useState<NodeDetailResponse | null>(null);
  const [selectedLink, setSelectedLink] = useState<RepoAbsorptionLink | null>(null);
  const [inspectorLoading, setInspectorLoading] = useState(false);

  // Node inspector form state
  const [nodeNotesDraft, setNodeNotesDraft] = useState("");
  const [bulkTargets, setBulkTargets] = useState<Set<string>>(new Set());
  const [bulkRelationType, setBulkRelationType] = useState<RepoRelationType>("direct_module");
  const [bulkRationale, setBulkRationale] = useState("");
  const [showNodeReadme, setShowNodeReadme] = useState(false);

  // Link inspector edit state
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkEditRelation, setLinkEditRelation] = useState<RepoRelationType>("direct_module");
  const [linkEditStatus, setLinkEditStatus] = useState<RepoAbsorptionStatus>("suggested");
  const [linkEditStrength, setLinkEditStrength] = useState(75);
  const [linkEditRationale, setLinkEditRationale] = useState("");
  const [mailboxNote, setMailboxNote] = useState("");
  const [addingModule, setAddingModule] = useState(false);
  const [newModSource, setNewModSource] = useState("");
  const [newModTarget, setNewModTarget] = useState("");
  const [newModMechanism, setNewModMechanism] = useState("");
  const [newModGap, setNewModGap] = useState("");
  const [newModPlan, setNewModPlan] = useState("");
  const [newModEffort, setNewModEffort] = useState<RepoModuleEffort>("M");
  const [newModRisk, setNewModRisk] = useState<RepoModuleRisk>("low");

  // View 2: Domains & Floating Pool states
  const [poolBucket, setPoolBucket] = useState<RepoNodeBucketFilter>(
    (initialBucket as RepoNodeBucketFilter) || "floating",
  );
  const [poolDomainId, setPoolDomainId] = useState<string>("");
  const [poolQuery, setPoolQuery] = useState("");
  const [poolQueryDebounced, setPoolQueryDebounced] = useState("");
  const [poolVitality, setPoolVitality] = useState<RepoVitality | "all">("all");
  const [poolVisibility, setPoolVisibility] = useState<RepoVisibility | "all">("all");
  const [poolLanguage, setPoolLanguage] = useState("");
  const [poolSortBy, setPoolSortBy] = useState<RepoNodeSortBy>("starred_at");
  const [poolPage, setPoolPage] = useState(1);
  const [poolPageSize, setPoolPageSize] = useState(50);
  const [nodesPage, setNodesPage] = useState<RepoEvolutionNodesPage | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [checkedNodeIds, setCheckedNodeIds] = useState<Set<string>>(new Set());
  const [batchTargetDomainId, setBatchTargetDomainId] = useState("");

  // Quick 1-to-N modal from table row
  const [quickLinkNode, setQuickLinkNode] = useState<RepoEvolutionNode | null>(null);
  const [quickLinkTargets, setQuickLinkTargets] = useState<Set<string>>(new Set());
  const [quickLinkRelation, setQuickLinkRelation] = useState<RepoRelationType>("direct_module");
  const [quickLinkRationale, setQuickLinkRationale] = useState("");

  // Domain CRUD modals
  const [domainModal, setDomainModal] = useState<{
    mode: "create" | "edit";
    domain?: RepoDomain;
    name: string;
    description: string;
    color: string;
    icon: string;
    seedKeywords: string;
  } | null>(null);
  const [mergeModal, setMergeModal] = useState<{
    sourceDomainId: string;
    targetDomainId: string;
  } | null>(null);

  // View 3: Evolution Timeline states
  const [timelinePage, setTimelinePage] = useState<RepoEvolutionTimelinePage | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineTargetId, setTimelineTargetId] = useState("");
  const [timelineRepoName, setTimelineRepoName] = useState(initialRepo ?? "");
  const [timelineDomainId, setTimelineDomainId] = useState("");
  const [timelineEventType, setTimelineEventType] = useState<RepoEvolutionEventType | "all">("all");

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cfgSpotlight, setCfgSpotlight] = useState<string[]>(["ai-agent-node"]);
  const [cfgNewSpotlight, setCfgNewSpotlight] = useState("");
  const [cfgDormantMonths, setCfgDormantMonths] = useState(12);
  const [cfgStaleMonths, setCfgStaleMonths] = useState(24);
  const [cfgMinClusterSim, setCfgMinClusterSim] = useState(0.28);
  const [cfgMinLinkSim, setCfgMinLinkSim] = useState(0.32);
  const [cfgSpotlightBonus, setCfgSpotlightBonus] = useState(0.08);
  const [cfgAllowPrivateLlm, setCfgAllowPrivateLlm] = useState(false);
  const [cfgAutomationMode, setCfgAutomationMode] = useState<RepoEvolutionAutomationMode>("mailbox_review");

  // Sync job & global notices
  const [activeSyncJob, setActiveSyncJob] = useState<RepoEvolutionSyncJob | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<{ text: string; href?: string; hrefLabel?: string } | null>(null);
  const [error, setError] = useState("");

  const panStartRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lastCompletedJobRef = useRef<string | null>(null);

  // ---- Data Fetchers ----

  const loadMacroGraph = useCallback(async () => {
    try {
      const data = await request<RepoEvolutionMacroGraph>(`${API_BASE}/graph/macro`);
      setMacroGraph(data);
      if (data.activeSyncJob) {
        setActiveSyncJob(data.activeSyncJob);
      } else if (data.latestSyncJob && (data.latestSyncJob.status === "failed" || data.latestSyncJob.status === "running")) {
        setActiveSyncJob(data.latestSyncJob);
      }
      setError("");
      return data;
    } catch (err) {
      setError(describeError(err, "加载开源进化图谱失败"));
      return null;
    }
  }, []);

  const loadFocusGraph = useCallback(async (params = focusParams) => {
    const qs = new URLSearchParams({
      focusType: params.focusType,
      limit: "60",
      includeRejected: params.includeRejected ? "true" : "false",
    });
    if (params.focusId) qs.set("focusId", params.focusId);
    if (params.status !== "all") qs.set("status", params.status);
    if (params.vitality !== "all") qs.set("vitality", params.vitality);
    if (params.q.trim()) qs.set("q", params.q.trim());
    try {
      const data = await request<RepoEvolutionFocusGraph>(`${API_BASE}/graph/focus?${qs.toString()}`);
      setFocusGraph(data);
      setError("");
      return data;
    } catch (err) {
      setError(describeError(err, "加载聚焦流向图失败"));
      return null;
    }
  }, [focusParams]);

  const loadNodesPage = useCallback(async () => {
    setPoolLoading(true);
    const qs = new URLSearchParams({
      bucket: poolBucket,
      sortBy: poolSortBy,
      sortDir: poolSortBy === "name" ? "asc" : "desc",
      page: String(poolPage),
      pageSize: String(poolPageSize),
    });
    if (poolDomainId) qs.set("domainId", poolDomainId);
    if (poolQueryDebounced.trim()) qs.set("q", poolQueryDebounced.trim());
    if (poolVitality !== "all") qs.set("vitality", poolVitality);
    if (poolVisibility !== "all") qs.set("visibility", poolVisibility);
    if (poolLanguage) qs.set("language", poolLanguage);
    try {
      const res = await request<RepoEvolutionNodesPage>(`${API_BASE}/nodes?${qs.toString()}`);
      setNodesPage(res);
      setError("");
    } catch (err) {
      setError(describeError(err, "加载仓库列表失败"));
    } finally {
      setPoolLoading(false);
    }
  }, [poolBucket, poolDomainId, poolQueryDebounced, poolVitality, poolVisibility, poolLanguage, poolSortBy, poolPage, poolPageSize]);

  const loadTimeline = useCallback(async (append = false) => {
    setTimelineLoading(true);
    const offset = append && timelinePage ? timelinePage.items.length : 0;
    const qs = new URLSearchParams({ limit: "60", offset: String(offset) });
    if (timelineTargetId) qs.set("targetNodeId", timelineTargetId);
    if (timelineRepoName.trim()) qs.set("repoFullName", timelineRepoName.trim());
    if (timelineDomainId) qs.set("domainId", timelineDomainId);
    if (timelineEventType !== "all") qs.set("eventType", timelineEventType);
    try {
      const res = await request<RepoEvolutionTimelinePage>(`${API_BASE}/timeline?${qs.toString()}`);
      setTimelinePage((prev) =>
        append && prev ? { ...res, items: [...prev.items, ...res.items] } : res,
      );
      setError("");
    } catch (err) {
      setError(describeError(err, "加载进化时间线失败"));
    } finally {
      setTimelineLoading(false);
    }
  }, [timelineTargetId, timelineRepoName, timelineDomainId, timelineEventType, timelinePage]);

  const openNodeInspector = useCallback(async (nodeId: string) => {
    setInspectorMode("node");
    setInspectorLoading(true);
    setShowNodeReadme(false);
    try {
      const res = await request<NodeDetailResponse>(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}`);
      setSelectedNodeDetail(res);
      setNodeNotesDraft(res.node.notes ?? "");
      setBulkTargets(new Set(res.outgoingLinks.map((l) => l.targetNodeId)));
      setBulkRationale("");
      setError("");
    } catch (err) {
      setError(describeError(err, "读取仓库详情失败"));
    } finally {
      setInspectorLoading(false);
    }
  }, []);

  const openLinkInspector = useCallback(async (linkOrId: RepoAbsorptionLink | string) => {
    setInspectorMode("link");
    setLinkEditing(false);
    setAddingModule(false);
    setMailboxNote("");
    if (typeof linkOrId !== "string") {
      setSelectedLink(linkOrId);
      setLinkEditRelation(linkOrId.relationType);
      setLinkEditStatus(linkOrId.status);
      setLinkEditStrength(Math.round(linkOrId.strength * 100));
      setLinkEditRationale(linkOrId.rationale ?? "");
    }
    const id = typeof linkOrId === "string" ? linkOrId : linkOrId.id;
    setInspectorLoading(true);
    try {
      const fresh = await request<RepoAbsorptionLink>(`${API_BASE}/links/${encodeURIComponent(id)}`);
      setSelectedLink(fresh);
      setLinkEditRelation(fresh.relationType);
      setLinkEditStatus(fresh.status);
      setLinkEditStrength(Math.round(fresh.strength * 100));
      setLinkEditRationale(fresh.rationale ?? "");
      setError("");
      return fresh;
    } catch (err) {
      setError(describeError(err, "读取吸收边详情失败"));
      return null;
    } finally {
      setInspectorLoading(false);
    }
  }, []);

  // ---- Initial load & hash deep-link synchronization ----

  useEffect(() => {
    void loadMacroGraph();
  }, [loadMacroGraph]);

  useEffect(() => {
    const params = new URLSearchParams(hashQuery);
    const tabParam = params.get("tab") as MainTab | null;
    const linkParam = params.get("link") || initialLinkId || "";
    const repoParam = params.get("repo") || initialRepo || "";
    const domainParam = params.get("domain") || initialDomainId || "";
    const nodeParam = params.get("node") || initialNodeId || "";
    const bucketParam = params.get("bucket") || initialBucket || "";

    if (tabParam && ["graph", "domains", "timeline"].includes(tabParam)) {
      setActiveTab(tabParam);
    }

    if (linkParam) {
      setActiveTab("graph");
      setGraphMode("focus");
      void openLinkInspector(linkParam).then((link) => {
        if (link) {
          const nextFocus = {
            focusType: "owned" as RepoFocusType,
            focusId: link.targetNodeId,
            status: "all" as const,
            vitality: "all" as const,
            includeRejected: link.status === "rejected",
            q: "",
          };
          setFocusParams(nextFocus);
          void loadFocusGraph(nextFocus);
        }
      });
      return;
    }

    if (tabParam === "timeline" && repoParam) {
      setTimelineRepoName(repoParam);
      setTimelineTargetId("");
      return;
    }

    if (domainParam) {
      setActiveTab("graph");
      setGraphMode("focus");
      const nextFocus = {
        focusType: "domain" as RepoFocusType,
        focusId: domainParam,
        status: "all" as const,
        vitality: "all" as const,
        includeRejected: false,
        q: "",
      };
      setFocusParams(nextFocus);
      void loadFocusGraph(nextFocus);
      return;
    }

    if (nodeParam) {
      setActiveTab("graph");
      setGraphMode("focus");
      void openNodeInspector(nodeParam);
      const nextFocus = {
        focusType: "owned" as RepoFocusType,
        focusId: nodeParam,
        status: "all" as const,
        vitality: "all" as const,
        includeRejected: false,
        q: "",
      };
      setFocusParams(nextFocus);
      void loadFocusGraph(nextFocus);
      return;
    }

    if (repoParam && tabParam !== "timeline") {
      setActiveTab("graph");
      setGraphMode("focus");
      const nextFocus = {
        focusType: "all" as RepoFocusType,
        focusId: "",
        status: "all" as const,
        vitality: "all" as const,
        includeRejected: false,
        q: repoParam,
      };
      setFocusParams(nextFocus);
      void loadFocusGraph(nextFocus);
      return;
    }

    if (bucketParam) {
      setActiveTab("domains");
      setPoolBucket(bucketParam as RepoNodeBucketFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashQuery]);

  // Reload focus graph when switching to focus mode or changing focus params
  useEffect(() => {
    if (activeTab === "graph" && graphMode === "focus") {
      void loadFocusGraph(focusParams);
    }
  }, [activeTab, graphMode, focusParams, loadFocusGraph]);

  // Debounce pool search
  useEffect(() => {
    const t = window.setTimeout(() => {
      setPoolQueryDebounced(poolQuery);
      setPoolPage(1);
    }, 260);
    return () => window.clearTimeout(t);
  }, [poolQuery]);

  // Load pool nodes when on domains tab
  useEffect(() => {
    if (activeTab === "domains") {
      void loadNodesPage();
    }
  }, [activeTab, loadNodesPage]);

  // Load timeline when on timeline tab
  useEffect(() => {
    if (activeTab === "timeline") {
      void loadTimeline(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, timelineTargetId, timelineRepoName, timelineDomainId, timelineEventType]);

  // Quick graph search debounce
  useEffect(() => {
    const q = graphSearch.trim();
    if (!q) {
      setGraphSearchResults([]);
      return;
    }
    const controller = new AbortController();
    const t = window.setTimeout(() => {
      request<RepoEvolutionNodesPage>(
        `${API_BASE}/nodes?${new URLSearchParams({ q, pageSize: "10", page: "1" })}`,
        { signal: controller.signal },
      )
        .then((res) => {
          if (!controller.signal.aborted) {
            setGraphSearchResults(res.items);
            setGraphSearchOpen(true);
          }
        })
        .catch(() => {});
    }, 220);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [graphSearch]);

  // Poll active sync job while running/queued
  useEffect(() => {
    if (!activeSyncJob || (activeSyncJob.status !== "queued" && activeSyncJob.status !== "running")) {
      return;
    }
    const timer = window.setInterval(() => {
      void request<RepoEvolutionSyncJob>(`${API_BASE}/sync/jobs/${encodeURIComponent(activeSyncJob.id)}`)
        .then((job) => {
          setActiveSyncJob(job);
          if (job.status === "completed" && lastCompletedJobRef.current !== job.id) {
            lastCompletedJobRef.current = job.id;
            setNotice({
              text: `GitHub 同步完成：自有仓 ${job.ownedFetched}，Star 仓 ${job.starredFetched}，Lists ${job.listsFetched}，向量更新 ${job.embeddingsComputed}。`,
            });
            void loadMacroGraph();
            if (activeTab === "graph" && graphMode === "focus") void loadFocusGraph();
            if (activeTab === "domains") void loadNodesPage();
            if (activeTab === "timeline") void loadTimeline(false);
          } else if (job.status === "failed") {
            setError(job.errorMessage || "GitHub 同步中途失败，可点击断点续传重试");
          }
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeSyncJob, activeTab, graphMode, loadMacroGraph, loadFocusGraph, loadNodesPage, loadTimeline]);

  // ---- Topbar Actions ----

  const triggerSync = async (mode: "incremental" | "full", resumeJobId?: string) => {
    setBusyAction(`sync:${mode}`);
    setError("");
    try {
      const job = await request<RepoEvolutionSyncJob>(`${API_BASE}/sync`, {
        method: "POST",
        body: JSON.stringify({ mode, ...(resumeJobId ? { resumeJobId } : {}) }),
      });
      setActiveSyncJob(job);
      setNotice({
        text: mode === "full" ? "已启动 GitHub 全量同步任务（后台分页拉取）" : "已启动 GitHub 增量同步任务",
      });
    } catch (err) {
      setError(describeError(err, "启动 GitHub 同步失败"));
    } finally {
      setBusyAction("");
    }
  };

  const triggerClusterAndRecall = async () => {
    setBusyAction("cluster");
    setError("");
    try {
      const res = await request<ClusterAndRecallResult>(`${API_BASE}/cluster-and-recall`, {
        method: "POST",
        body: JSON.stringify({ recomputeEmbeddings: true }),
      });
      setNotice({
        text: `AI 向量聚类与召回完成（${(res.durationMs / 1000).toFixed(1)}s）：更新向量 ${res.embeddingsUpdated} · 归类 ${res.domainsAssigned} · 召回候选边 ${res.linksSuggested}（Spotlight 命中 ${res.spotlightMatches}）· 保留散落池 ${res.skippedStaleOrLowMatch}。`,
      });
      await loadMacroGraph();
      if (activeTab === "graph" && graphMode === "focus") await loadFocusGraph();
      if (activeTab === "domains") await loadNodesPage();
      if (activeTab === "timeline") await loadTimeline(false);
    } catch (err) {
      setError(describeError(err, "AI 向量聚类与召回失败"));
    } finally {
      setBusyAction("");
    }
  };

  const openSettings = () => {
    const cfg = macroGraph?.config;
    if (cfg) {
      setCfgSpotlight(cfg.spotlightRepos);
      setCfgDormantMonths(cfg.dormantMonths);
      setCfgStaleMonths(cfg.staleMonths);
      setCfgMinClusterSim(cfg.minClusterSimilarity);
      setCfgMinLinkSim(cfg.minLinkSimilarity);
      setCfgSpotlightBonus(cfg.spotlightBonus);
      setCfgAllowPrivateLlm(cfg.allowPrivateLlmByDefault);
      setCfgAutomationMode(cfg.automationMode);
    }
    setCfgNewSpotlight("");
    setSettingsOpen(true);
  };

  const saveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setBusyAction("config");
    setError("");
    try {
      const updated = await request<RepoEvolutionConfig>(`${API_BASE}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          spotlightRepos: cfgSpotlight,
          dormantMonths: Number(cfgDormantMonths),
          staleMonths: Number(cfgStaleMonths),
          minClusterSimilarity: Number(cfgMinClusterSim),
          minLinkSimilarity: Number(cfgMinLinkSim),
          spotlightBonus: Number(cfgSpotlightBonus),
          allowPrivateLlmByDefault: cfgAllowPrivateLlm,
          automationMode: cfgAutomationMode,
        }),
      });
      setMacroGraph((prev) => (prev ? { ...prev, config: updated } : prev));
      setSettingsOpen(false);
      setNotice({ text: "进化图谱配置已保存（重点关注仓、陈旧阈值与隐私开关已生效）。" });
      await loadMacroGraph();
    } catch (err) {
      setError(describeError(err, "保存配置失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- Navigation Helpers ----

  const drillIntoFocus = (focusType: RepoFocusType, focusId: string, opts?: { status?: RepoAbsorptionStatus | "all"; openInspectorNodeId?: string }) => {
    setActiveTab("graph");
    setGraphMode("focus");
    setViewport({ x: 16, y: 12, zoom: 1 });
    setFocusParams((prev) => ({
      ...prev,
      focusType,
      focusId,
      status: opts?.status ?? "all",
      q: "",
    }));
    if (opts?.openInspectorNodeId) {
      void openNodeInspector(opts.openInspectorNodeId);
    }
  };

  const jumpToEdgeInGraph = async (linkId: string) => {
    setActiveTab("graph");
    setGraphMode("focus");
    setViewport({ x: 16, y: 12, zoom: 1 });
    const link = await openLinkInspector(linkId);
    if (link) {
      setFocusParams({
        focusType: "owned",
        focusId: link.targetNodeId,
        status: "all",
        vitality: "all",
        includeRejected: link.status === "rejected",
        q: "",
      });
    }
  };

  // ---- Pan & Zoom Handlers ----

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    panStartRef.current = { clientX: e.clientX, clientY: e.clientY, x: viewport.x, y: viewport.y };
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) return;
    const dx = e.clientX - panStartRef.current.clientX;
    const dy = e.clientY - panStartRef.current.clientY;
    setViewport((vp) => ({ ...vp, x: Math.round(panStartRef.current!.x + dx), y: Math.round(panStartRef.current!.y + dy) }));
  };

  const handleStagePointerUp = () => {
    panStartRef.current = null;
    setIsPanning(false);
  };

  // Attach non-passive wheel listener for smooth Ctrl/Meta+wheel zooming without console warnings
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.91;
        setViewport((vp) => ({
          ...vp,
          zoom: Math.max(0.45, Math.min(2.0, Math.round(vp.zoom * factor * 100) / 100)),
        }));
      } else {
        setViewport((vp) => ({
          ...vp,
          x: Math.round(vp.x - e.deltaX * 0.65),
          y: Math.round(vp.y - e.deltaY * 0.65),
        }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeTab]);

  const resetViewport = () => setViewport({ x: 16, y: 12, zoom: 1 });

  // ---- Node Inspector Mutations ----

  const handleUpdateNode = async (nodeId: string, patch: Record<string, unknown>, successMsg: string) => {
    setBusyAction("node-update");
    setError("");
    try {
      const updated = await request<RepoEvolutionNode>(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setSelectedNodeDetail((prev) => (prev && prev.node.id === updated.id ? { ...prev, node: updated } : prev));
      setNotice({ text: successMsg });
      void loadMacroGraph();
      if (graphMode === "focus") void loadFocusGraph();
      if (activeTab === "domains") void loadNodesPage();
    } catch (err) {
      setError(describeError(err, "更新仓库属性失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleBulkLinkFromInspector = async () => {
    if (!selectedNodeDetail) return;
    const targetIds = Array.from(bulkTargets);
    if (targetIds.length === 0) {
      setError("请至少勾选 1 个目标自有仓");
      return;
    }
    setBusyAction("bulk-link");
    setError("");
    try {
      const res = await request<{ links: RepoAbsorptionLink[] }>(
        `${API_BASE}/nodes/${encodeURIComponent(selectedNodeDetail.node.id)}/links/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            targetNodeIds: targetIds,
            relationType: bulkRelationType,
            rationale: bulkRationale.trim() || undefined,
          }),
        },
      );
      setNotice({ text: `已同步 ${selectedNodeDetail.node.fullName} 的 1 对 ${res.links.length} 吸收关联。` });
      await openNodeInspector(selectedNodeDetail.node.id);
      void loadMacroGraph();
      if (graphMode === "focus") void loadFocusGraph();
      if (activeTab === "domains") void loadNodesPage();
    } catch (err) {
      setError(describeError(err, "批量建立关联失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- Link Inspector Mutations ----

  const handleAnalyzeLink = async (linkId: string, opts: { force?: boolean; allowPrivateOverride?: boolean } = {}) => {
    setBusyAction("analyze");
    setError("");
    try {
      const res = await request<AnalyzeLinkResult>(`${API_BASE}/links/${encodeURIComponent(linkId)}/analyze`, {
        method: "POST",
        body: JSON.stringify({ force: opts.force ?? true, allowPrivateOverride: opts.allowPrivateOverride }),
      });
      setSelectedLink(res.link);
      setNotice({
        text:
          res.notice ||
          (res.privacyBlocked
            ? "目标为私有仓且未开启 LLM 隐私授权，已使用本地确定性结构分析。"
            : res.usedLlm
              ? `LLM 模块级深度分析完成：共提炼 ${res.link.moduleAnalysis.length} 个可吸收模块点。`
              : `确定性结构化模块分析完成：共提炼 ${res.link.moduleAnalysis.length} 个可吸收模块点。`),
      });
      void loadMacroGraph();
      if (graphMode === "focus") void loadFocusGraph();
    } catch (err) {
      setError(describeError(err, "执行模块级深度分析失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleSubmitToMailbox = async (linkId: string) => {
    setBusyAction("submit-mailbox");
    setError("");
    try {
      const res = await request<SubmitLinkToMailboxResult>(
        `${API_BASE}/links/${encodeURIComponent(linkId)}/submit-mailbox`,
        {
          method: "POST",
          body: JSON.stringify({ note: mailboxNote.trim() || undefined }),
        },
      );
      setSelectedLink(res.link);
      setMailboxNote("");
      setNotice({
        text: res.reusedPending
          ? "该边已有待审批提案在总裁信箱中（已自动防重复用）。"
          : "已生成开源吸收评估单并送达总裁信箱，待你拍板（V1 仅人工留痕不自动改代码）。",
        href: `#mailbox?decision=${encodeURIComponent(res.packet.id)}`,
        hrefLabel: "前往总裁信箱审批 ↗",
      });
      void loadMacroGraph();
      if (graphMode === "focus") void loadFocusGraph();
    } catch (err) {
      setError(describeError(err, "提交总裁信箱评估失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handlePromoteOpportunity = async (linkId: string) => {
    setBusyAction("promote-opp");
    setError("");
    try {
      const res = await request<PromoteLinkToOpportunityResult>(
        `${API_BASE}/links/${encodeURIComponent(linkId)}/promote-opportunity`,
        {
          method: "POST",
          body: JSON.stringify({ pipeline: "quick" }),
        },
      );
      setSelectedLink(res.link);
      setNotice({
        text: `已手动转为研发选题（项目：${res.project}）。`,
        href: "#opportunities",
        hrefLabel: "查看研发选题池 ↗",
      });
      void loadMacroGraph();
    } catch (err) {
      setError(describeError(err, "转为研发选题失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleSaveLinkEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedLink) return;
    setBusyAction("save-link");
    setError("");
    try {
      const updated = await request<RepoAbsorptionLink>(
        `${API_BASE}/links/${encodeURIComponent(selectedLink.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            relationType: linkEditRelation,
            status: linkEditStatus,
            strength: Math.max(0.05, Math.min(1, linkEditStrength / 100)),
            rationale: linkEditRationale.trim(),
          }),
        },
      );
      setSelectedLink(updated);
      setLinkEditing(false);
      setNotice({ text: "吸收边属性已更新。" });
      void loadMacroGraph();
      if (graphMode === "focus") void loadFocusGraph();
    } catch (err) {
      setError(describeError(err, "保存吸收边失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleDeleteLink = async (link: RepoAbsorptionLink) => {
    if (!window.confirm(`确认删除「${link.sourceRepoFullName} → ${link.targetRepoFullName}」的吸收边？`)) {
      return;
    }
    setBusyAction("delete-link");
    setError("");
    try {
      await request<{ ok: boolean }>(`${API_BASE}/links/${encodeURIComponent(link.id)}`, {
        method: "DELETE",
      });
      setSelectedLink(null);
      setInspectorMode("none");
      setNotice({ text: "已删除吸收边。" });
      void loadMacroGraph();
      if (graphMode === "focus") void loadFocusGraph();
    } catch (err) {
      setError(describeError(err, "删除吸收边失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleAddManualModule = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedLink || !newModSource.trim() || !newModMechanism.trim()) return;
    const item: RepoModuleAnalysisItem = {
      id: `mod-manual-${Date.now()}`,
      sourceModulePath: newModSource.trim(),
      targetModulePath: newModTarget.trim() || "待定目标模块",
      absorbableMechanism: newModMechanism.trim(),
      currentGap: newModGap.trim() || "当前自有仓尚无等价实现",
      adaptationPlan: newModPlan.trim() || "人工评审后制定适配计划",
      effort: newModEffort,
      risk: newModRisk,
      evidenceLinks: [],
    };
    const nextModules = [...selectedLink.moduleAnalysis, item];
    setBusyAction("add-module");
    try {
      const updated = await request<RepoAbsorptionLink>(
        `${API_BASE}/links/${encodeURIComponent(selectedLink.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ moduleAnalysis: nextModules }),
        },
      );
      setSelectedLink(updated);
      setAddingModule(false);
      setNewModSource("");
      setNewModTarget("");
      setNewModMechanism("");
      setNewModGap("");
      setNewModPlan("");
      setNotice({ text: "已添加手动模块分析条目。" });
      if (graphMode === "focus") void loadFocusGraph();
    } catch (err) {
      setError(describeError(err, "添加模块分析失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleRemoveModuleItem = async (modId: string) => {
    if (!selectedLink) return;
    const nextModules = selectedLink.moduleAnalysis.filter((m) => m.id !== modId);
    setBusyAction("remove-module");
    try {
      const updated = await request<RepoAbsorptionLink>(
        `${API_BASE}/links/${encodeURIComponent(selectedLink.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ moduleAnalysis: nextModules }),
        },
      );
      setSelectedLink(updated);
      if (graphMode === "focus") void loadFocusGraph();
    } catch (err) {
      setError(describeError(err, "删除模块条目失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- View 2: Domain CRUD & Batch Pool Actions ----

  const handleSaveDomain = async (e: FormEvent) => {
    e.preventDefault();
    if (!domainModal || !domainModal.name.trim()) return;
    setBusyAction("domain-save");
    setError("");
    const seedKeywords = domainModal.seedKeywords
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      if (domainModal.mode === "create") {
        await request<RepoDomain>(`${API_BASE}/domains`, {
          method: "POST",
          body: JSON.stringify({
            name: domainModal.name.trim(),
            description: domainModal.description.trim(),
            color: domainModal.color,
            icon: domainModal.icon.trim() || "◈",
            seedKeywords,
          }),
        });
        setNotice({ text: `已新建领域「${domainModal.name.trim()}」。` });
      } else if (domainModal.domain) {
        await request<RepoDomain>(`${API_BASE}/domains/${encodeURIComponent(domainModal.domain.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: domainModal.name.trim(),
            description: domainModal.description.trim(),
            color: domainModal.color,
            icon: domainModal.icon.trim() || "◈",
            seedKeywords,
          }),
        });
        setNotice({ text: `已更新领域「${domainModal.name.trim()}」。` });
      }
      setDomainModal(null);
      await loadMacroGraph();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "保存领域失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleDeleteDomain = async (domain: RepoDomainCluster) => {
    if (!window.confirm(`删除领域「${domain.name}」后，该领域下 ${domain.totalNodes} 个仓库将回到未归类池，确认删除？`)) {
      return;
    }
    setBusyAction("domain-del");
    setError("");
    try {
      await request<{ ok: boolean }>(`${API_BASE}/domains/${encodeURIComponent(domain.id)}`, {
        method: "DELETE",
      });
      if (poolDomainId === domain.id) setPoolDomainId("");
      setNotice({ text: `已删除领域「${domain.name}」。` });
      await loadMacroGraph();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "删除领域失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleMergeDomains = async (e: FormEvent) => {
    e.preventDefault();
    if (!mergeModal || !mergeModal.sourceDomainId || !mergeModal.targetDomainId || mergeModal.sourceDomainId === mergeModal.targetDomainId) {
      return;
    }
    setBusyAction("domain-merge");
    setError("");
    try {
      const res = await request<{ targetDomain: RepoDomain; movedNodes: number }>(`${API_BASE}/domains/merge`, {
        method: "POST",
        body: JSON.stringify(mergeModal),
      });
      if (poolDomainId === mergeModal.sourceDomainId) setPoolDomainId(mergeModal.targetDomainId);
      setMergeModal(null);
      setNotice({ text: `已合并领域至「${res.targetDomain.name}」，迁移 ${res.movedNodes} 个仓库。` });
      await loadMacroGraph();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "合并领域失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleImportGithubLists = async () => {
    setBusyAction("import-lists");
    setError("");
    try {
      const res = await request<ImportGithubListsResult>(`${API_BASE}/domains/import-github-lists`, {
        method: "POST",
        body: "{}",
      });
      setNotice({ text: `已导入 GitHub Star Lists：新增/同步领域 ${res.importedDomains} 个，自动归类 ${res.assignedNodes} 个仓库。` });
      await loadMacroGraph();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "导入 GitHub Star Lists 失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleBatchNodes = async (action: BatchUpdateRepoNodesInput["action"], domainId?: string | null) => {
    const ids = Array.from(checkedNodeIds);
    if (ids.length === 0) return;
    setBusyAction("batch-nodes");
    setError("");
    try {
      const res = await request<BatchUpdateRepoNodesResult>(`${API_BASE}/nodes/batch`, {
        method: "POST",
        body: JSON.stringify({
          nodeIds: ids,
          action,
          ...(domainId !== undefined ? { domainId } : {}),
        }),
      });
      setCheckedNodeIds(new Set());
      setNotice({ text: `批量操作完成，共更新 ${res.updatedCount} 个仓库。` });
      await loadMacroGraph();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "批量更新仓库失败"));
    } finally {
      setBusyAction("");
    }
  };

  const openQuickLinkModal = async (node: RepoEvolutionNode) => {
    setQuickLinkNode(node);
    setQuickLinkRelation("direct_module");
    setQuickLinkRationale("");
    setQuickLinkTargets(new Set());
    try {
      const detail = await request<NodeDetailResponse>(`${API_BASE}/nodes/${encodeURIComponent(node.id)}`);
      setQuickLinkTargets(new Set(detail.outgoingLinks.map((l) => l.targetNodeId)));
    } catch {
      // allow user to check freely
    }
  };

  const submitQuickLinkModal = async (e: FormEvent) => {
    e.preventDefault();
    if (!quickLinkNode) return;
    const ids = Array.from(quickLinkTargets);
    if (ids.length === 0) {
      setError("请至少勾选 1 个我的开源库");
      return;
    }
    setBusyAction("quick-link");
    setError("");
    try {
      const res = await request<{ links: RepoAbsorptionLink[] }>(
        `${API_BASE}/nodes/${encodeURIComponent(quickLinkNode.id)}/links/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            targetNodeIds: ids,
            relationType: quickLinkRelation,
            rationale: quickLinkRationale.trim() || undefined,
          }),
        },
      );
      setQuickLinkNode(null);
      setNotice({ text: `已为 ${quickLinkNode.fullName} 建立 ${res.links.length} 条吸收关联。` });
      await loadMacroGraph();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "保存 1 对 N 关联失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- Derived Data & SVG Layouts ----

  const domains = macroGraph?.domains ?? [];
  const ownedRepos = macroGraph?.ownedRepos ?? [];
  const stats = macroGraph?.stats;
  const spotlightOwned = useMemo(
    () => ownedRepos.filter((r) => r.priorityTier === "spotlight"),
    [ownedRepos],
  );

  // Macro Graph Layout
  const macroLayout = useMemo(() => {
    const visibleOwned = showAllOwnedInMacro ? ownedRepos : ownedRepos.slice(0, 22);
    const domainX = 36;
    const domainW = 310;
    const domainH = 74;
    const domainGap = 12;
    const headerY = 38;

    const domainPos = new Map<string, { x: number; y: number; w: number; h: number; cy: number; cluster: RepoDomainCluster }>();
    domains.forEach((d, idx) => {
      const y = headerY + idx * (domainH + domainGap);
      domainPos.set(d.id, { x: domainX, y, w: domainW, h: domainH, cy: y + domainH / 2, cluster: d });
    });

    const floatingY = headerY + domains.length * (domainH + domainGap) + 8;
    const floatingBox = { x: domainX, y: floatingY, w: domainW, h: 78 };

    const ownedX = 680;
    const ownedW = 326;
    const ownedH = 68;
    const ownedGap = 11;
    const ownedPos = new Map<string, { x: number; y: number; w: number; h: number; cy: number; repo: typeof ownedRepos[number] }>();
    visibleOwned.forEach((r, idx) => {
      const y = headerY + idx * (ownedH + ownedGap);
      ownedPos.set(r.id, { x: ownedX, y, w: ownedW, h: ownedH, cy: y + ownedH / 2, repo: r });
    });

    const edges = (macroGraph?.macroEdges ?? [])
      .map((edge) => {
        const src = domainPos.get(edge.sourceDomainId);
        const tgt = ownedPos.get(edge.targetNodeId);
        if (!src || !tgt) return null;
        const bez = cubicBezier(src.x + src.w, src.cy, tgt.x, tgt.cy);
        return { edge, ...bez };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const totalH = Math.max(
      floatingBox.y + floatingBox.h + 40,
      headerY + visibleOwned.length * (ownedH + ownedGap) + 64,
      540,
    );

    return {
      domainPos,
      floatingBox,
      ownedPos,
      visibleOwned,
      hiddenOwnedCount: Math.max(0, ownedRepos.length - visibleOwned.length),
      edges,
      width: 1050,
      height: totalH,
    };
  }, [domains, ownedRepos, macroGraph?.macroEdges, showAllOwnedInMacro]);

  // Focus Graph Layout (anti-hairball left Star -> right Owned 1-to-N flow)
  const focusLayout = useMemo(() => {
    const stars = focusGraph?.starNodes ?? [];
    const owneds = focusGraph?.ownedNodes ?? [];
    const links = focusGraph?.links ?? [];

    const drawerOpen = inspectorMode !== "none";
    const starCompact = stars.length > 16;
    const starX = drawerOpen ? 20 : 34;
    const starW = drawerOpen ? 264 : 320;
    const starH = starCompact ? 54 : 64;
    const starGap = starCompact ? 8 : 11;
    const headerY = 38;

    const starPos = new Map<string, { x: number; y: number; w: number; h: number; cy: number; node: RepoEvolutionNode }>();
    stars.forEach((n, idx) => {
      const y = headerY + idx * (starH + starGap);
      starPos.set(n.id, { x: starX, y, w: starW, h: starH, cy: y + starH / 2, node: n });
    });

    const ownedX = drawerOpen ? 450 : 684;
    const ownedW = drawerOpen ? 264 : 324;
    const ownedH = 72;
    const ownedGap = 14;
    const leftSpan = Math.max(200, stars.length * (starH + starGap));
    const rightSpan = owneds.length * (ownedH + ownedGap);
    const ownedStartY = rightSpan < leftSpan ? headerY + Math.min(180, Math.round((leftSpan - rightSpan) / 2)) : headerY;

    const ownedPos = new Map<string, { x: number; y: number; w: number; h: number; cy: number; node: RepoEvolutionNode }>();
    owneds.forEach((n, idx) => {
      const y = ownedStartY + idx * (ownedH + ownedGap);
      ownedPos.set(n.id, { x: ownedX, y, w: ownedW, h: ownedH, cy: y + ownedH / 2, node: n });
    });

    // Outgoing count per star in current view (highlights 1-to-N!)
    const starOutCount = new Map<string, number>();
    const ownedInCount = new Map<string, number>();
    for (const l of links) {
      starOutCount.set(l.sourceNodeId, (starOutCount.get(l.sourceNodeId) ?? 0) + 1);
      ownedInCount.set(l.targetNodeId, (ownedInCount.get(l.targetNodeId) ?? 0) + 1);
    }

    const renderedLinks = links
      .map((link) => {
        const src = starPos.get(link.sourceNodeId);
        const tgt = ownedPos.get(link.targetNodeId);
        if (!src || !tgt) return null;
        const bez = cubicBezier(src.x + src.w, src.cy, tgt.x, tgt.cy);
        return { link, ...bez };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const totalH = Math.max(
      headerY + stars.length * (starH + starGap) + 48,
      ownedStartY + owneds.length * (ownedH + ownedGap) + 48,
      540,
    );

    return {
      starX,
      ownedX,
      drawerOpen,
      starPos,
      ownedPos,
      starOutCount,
      ownedInCount,
      renderedLinks,
      width: drawerOpen ? 736 : 1050,
      height: totalH,
    };
  }, [focusGraph, inspectorMode]);

  // Focus highlighting sets (hover OR selected node/link -> fan-highlight 1-to-N / reverse-highlight!)
  const focusHighlight = useMemo(() => {
    const links = focusGraph?.links ?? [];
    const selectedNodeId = inspectorMode === "node" && selectedNodeDetail ? selectedNodeDetail.node.id : null;
    const activeStarId =
      hoveredFocusStarId ??
      (selectedNodeId && focusLayout.starPos.has(selectedNodeId) ? selectedNodeId : null);
    const activeOwnedId =
      hoveredFocusOwnedId ??
      (selectedNodeId && focusLayout.ownedPos.has(selectedNodeId) ? selectedNodeId : null);
    const activeLinkId =
      hoveredFocusLinkId ?? (inspectorMode === "link" && selectedLink ? selectedLink.id : null);

    if (!activeStarId && !activeOwnedId && !activeLinkId) {
      return { active: false, starIds: new Set<string>(), ownedIds: new Set<string>(), linkIds: new Set<string>() };
    }

    const starIds = new Set<string>();
    const ownedIds = new Set<string>();
    const linkIds = new Set<string>();

    if (activeLinkId) {
      const target = links.find((l) => l.id === activeLinkId);
      if (target) {
        linkIds.add(target.id);
        starIds.add(target.sourceNodeId);
        ownedIds.add(target.targetNodeId);
      }
    } else if (activeStarId) {
      starIds.add(activeStarId);
      for (const l of links) {
        if (l.sourceNodeId === activeStarId) {
          linkIds.add(l.id);
          ownedIds.add(l.targetNodeId);
        }
      }
    } else if (activeOwnedId) {
      ownedIds.add(activeOwnedId);
      for (const l of links) {
        if (l.targetNodeId === activeOwnedId) {
          linkIds.add(l.id);
          starIds.add(l.sourceNodeId);
        }
      }
    }

    return { active: true, starIds, ownedIds, linkIds };
  }, [focusGraph?.links, focusLayout.starPos, focusLayout.ownedPos, hoveredFocusStarId, hoveredFocusOwnedId, hoveredFocusLinkId, inspectorMode, selectedNodeDetail, selectedLink]);

  // Timeline grouped by YYYY-MM-DD
  const timelineGroups = useMemo(() => {
    const items = timelinePage?.items ?? [];
    const groups = new Map<string, RepoAbsorptionEvent[]>();
    for (const ev of items) {
      const day = ev.createdAt ? ev.createdAt.slice(0, 10) : "未知日期";
      const arr = groups.get(day) ?? [];
      arr.push(ev);
      groups.set(day, arr);
    }
    return Array.from(groups.entries());
  }, [timelinePage?.items]);

  // Sync progress percentage
  const syncProgressPct = useMemo(() => {
    if (!activeSyncJob) return null;
    if (activeSyncJob.status === "completed") return 100;
    if (activeSyncJob.starredTotal && activeSyncJob.starredTotal > 0) {
      return Math.min(98, Math.round((activeSyncJob.starredFetched / activeSyncJob.starredTotal) * 100));
    }
    if (activeSyncJob.ownedTotal && activeSyncJob.ownedTotal > 0 && activeSyncJob.phase === "owned_repos") {
      return Math.min(40, Math.round((activeSyncJob.ownedFetched / activeSyncJob.ownedTotal) * 40));
    }
    return null;
  }, [activeSyncJob]);

  const allPoolChecked =
    Boolean(nodesPage && nodesPage.items.length > 0) &&
    nodesPage!.items.every((item) => checkedNodeIds.has(item.id));

  const toggleAllPool = () => {
    if (!nodesPage) return;
    if (allPoolChecked) {
      setCheckedNodeIds(new Set());
    } else {
      setCheckedNodeIds(new Set(nodesPage.items.map((n) => n.id)));
    }
  };

  // ---- Render ----

  return (
    <section className="zo-product re-page" aria-label="开源进化与吸收图谱" data-testid="repo-evolution-page">
      {/* 顶部控制栏 */}
      <header className="re-topbar">
        <div className="re-topbar-row">
          <div className="re-title-group">
            {nav}
            <h1>开源进化与吸收图谱</h1>
            <span className="re-subtitle">
              千级 GitHub Star 语义聚类 · 1 对 N 滋养流向 · 模块级吸收评估 · 总裁信箱留痕闭环
            </span>
          </div>
          <div className="re-actions-group">
            <button
              type="button"
              className="re-primary"
              disabled={Boolean(busyAction) || activeSyncJob?.status === "running"}
              onClick={() => void triggerSync("incremental")}
            >
              {busyAction === "sync:incremental" ? "启动中…" : "增量同步 GitHub"}
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction) || activeSyncJob?.status === "running"}
              onClick={() => void triggerSync("full")}
            >
              {busyAction === "sync:full" ? "启动中…" : "全量同步"}
            </button>
            <button
              type="button"
              className="re-indigo"
              disabled={Boolean(busyAction)}
              onClick={() => void triggerClusterAndRecall()}
            >
              {busyAction === "cluster" ? "聚类召回中…" : "AI 向量聚类与召回"}
            </button>
            <button type="button" onClick={openSettings}>
              ⚙ 设置
            </button>
          </div>
        </div>

        {/* 5 项核心指标条 */}
        <div className="re-metrics-bar" role="region" aria-label="开源进化核心指标">
          <button
            type="button"
            className="re-metric-card"
            data-tone="pine"
            onClick={() => {
              setActiveTab("domains");
              setPoolBucket("owned");
              setPoolDomainId("");
              setPoolPage(1);
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">我的开源库</span>
              <span className="re-metric-value">{stats?.ownedCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              公开 {stats?.ownedPublicCount ?? 0} · 🔒 私有 {stats?.ownedPrivateCount ?? 0} · ★ 重点 {stats?.spotlightCount ?? 0}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            onClick={() => {
              setActiveTab("domains");
              setPoolBucket("all");
              setPoolDomainId("");
              setPoolPage(1);
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">Star 仓库总数</span>
              <span className="re-metric-value">{stats?.starredCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              活跃 {stats?.activeStarredCount ?? 0} · 静默 {stats?.dormantStarredCount ?? 0} · 陈旧/归档 {(stats?.staleStarredCount ?? 0) + (stats?.archivedStarredCount ?? 0)}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            data-tone="pine"
            onClick={() => drillIntoFocus("all", "")}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">已建立吸收边</span>
              <span className="re-metric-value">{stats?.linkCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              已批/落地 {(stats?.approvedLinkCount ?? 0) + (stats?.absorbingLinkCount ?? 0) + (stats?.absorbedLinkCount ?? 0)} · AI 建议 {stats?.suggestedLinkCount ?? 0} · 观察 {stats?.watchingLinkCount ?? 0}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            data-tone="indigo"
            onClick={() => {
              if ((stats?.inReviewLinkCount ?? 0) > 0) {
                drillIntoFocus("all", "", { status: "in_review" });
              } else {
                location.hash = "#mailbox";
              }
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">待总裁信箱审批</span>
              <span className="re-metric-value">{stats?.inReviewLinkCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              {stats && stats.inReviewLinkCount > 0 ? "点击聚焦待批边 · 或进总裁信箱拍板" : "暂无待批吸收单 · 去总裁信箱 ↗"}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            data-tone="amber"
            onClick={() => {
              setActiveTab("domains");
              setPoolBucket("floating");
              setPoolDomainId("");
              setPoolPage(1);
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">游离散落池</span>
              <span className="re-metric-value">{stats?.floatingPoolCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              未归类 {stats?.unclassifiedCount ?? 0} · 归类未连 {stats?.classifiedUnlinkedCount ?? 0} · 陈旧沉淀 {stats?.stalePoolCount ?? 0}
            </span>
          </button>
        </div>

        {/* 3 主视图切换 Tab + 自动化档位展示 */}
        <div className="re-tabs-row">
          <div className="re-main-tabs" role="tablist" aria-label="开源进化工作台视图">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "graph"}
              onClick={() => setActiveTab("graph")}
            >
              吸收图谱
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "domains"}
              onClick={() => setActiveTab("domains")}
            >
              领域与散落池
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "timeline"}
              onClick={() => setActiveTab("timeline")}
            >
              进化时间线
            </button>
          </div>

          <div className="re-actions-group">
            {macroGraph?.config && (
              <span className="re-auto-badge" title="可在右上角设置中查看或调整">
                档位：{REPO_AUTOMATION_MODE_LABELS[macroGraph.config.automationMode]}
              </span>
            )}
            <a className="re-link-btn" href="#mailbox">
              总裁信箱 ↗
            </a>
          </div>
        </div>

        {/* 后台同步实时进度条 */}
        {activeSyncJob && (activeSyncJob.status === "queued" || activeSyncJob.status === "running" || activeSyncJob.status === "failed") && (
          <div className="re-sync-bar" data-status={activeSyncJob.status} role="status">
            <div className="re-sync-bar-head">
              <span>
                <strong>
                  {activeSyncJob.status === "failed"
                    ? "⚠️ GitHub 同步中断"
                    : `🔄 GitHub ${activeSyncJob.mode === "full" ? "全量" : "增量"}同步中`}
                </strong>
                {" · "}阶段：{SYNC_PHASE_LABELS[activeSyncJob.phase] ?? activeSyncJob.phase}
                {" · "}自有 {activeSyncJob.ownedFetched}{activeSyncJob.ownedTotal ? `/${activeSyncJob.ownedTotal}` : ""}
                {" · "}Star {activeSyncJob.starredFetched}{activeSyncJob.starredTotal ? `/${activeSyncJob.starredTotal}` : ""}
                {" · "}Lists {activeSyncJob.listsFetched}
                {" · "}向量 {activeSyncJob.embeddingsComputed}
                {activeSyncJob.errorMessage ? ` · ${activeSyncJob.errorMessage}` : ""}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {activeSyncJob.status === "failed" && activeSyncJob.cursor && (
                  <button
                    type="button"
                    className="re-mini re-primary"
                    onClick={() => void triggerSync(activeSyncJob.mode === "full" ? "full" : "incremental", activeSyncJob.id)}
                  >
                    断点续传
                  </button>
                )}
                {activeSyncJob.status === "failed" && (
                  <button type="button" className="re-mini re-ghost" onClick={() => setActiveSyncJob(null)}>
                    关闭
                  </button>
                )}
              </div>
            </div>
            {(activeSyncJob.status === "queued" || activeSyncJob.status === "running") && (
              <div className="re-sync-progress-track">
                <div
                  className={`re-sync-progress-fill ${syncProgressPct === null ? "indeterminate" : ""}`}
                  style={syncProgressPct !== null ? { width: `${syncProgressPct}%` } : undefined}
                />
              </div>
            )}
          </div>
        )}
      </header>

      {/* 通知 / 错误横幅 */}
      {notice && (
        <div className="re-banner" role="status">
          <span>{notice.text}</span>
          <div className="re-banner-actions">
            {notice.href && (
              <a className="re-link-btn" href={notice.href}>
                {notice.hrefLabel || "查看 ↗"}
              </a>
            )}
            <button type="button" className="re-ghost re-mini" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="re-banner error" role="alert">
          <span>{error}</span>
          <button type="button" className="re-ghost re-mini" onClick={() => setError("")}>
            ✕
          </button>
        </div>
      )}

      {/* 主工作区 */}
      <div className="re-body">
        {/* ================= 视图 1：双层抗毛线球 SVG 吸收图谱 ================= */}
        {activeTab === "graph" && (
          <div className="re-graph-wrap">
            <div className="re-graph-subbar">
              <div className="re-graph-subbar-left">
                <button
                  type="button"
                  className={graphMode === "macro" ? "re-active" : ""}
                  onClick={() => {
                    setGraphMode("macro");
                    resetViewport();
                  }}
                >
                  宏观星团态
                </button>
                <button
                  type="button"
                  className={graphMode === "focus" ? "re-active" : ""}
                  onClick={() => {
                    setGraphMode("focus");
                    resetViewport();
                  }}
                >
                  聚焦流向态 (1 对 N)
                </button>

                {graphMode === "focus" && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setGraphMode("macro");
                        resetViewport();
                      }}
                    >
                      ← 返回宏观
                    </button>
                    <span className="re-focus-crumb">
                      焦点：{focusGraph?.focusLabel || "全量高相关子图"}
                    </span>
                  </>
                )}

                {spotlightOwned.slice(0, 3).map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    className="re-mini re-spotlight-chip"
                    onClick={() => drillIntoFocus("owned", repo.id, { openInspectorNodeId: repo.id })}
                    title={`快速聚焦重点关注仓 ${repo.fullName}`}
                  >
                    ★ {repo.name}
                  </button>
                ))}
              </div>

              <div className="re-graph-subbar-right">
                {graphMode === "focus" && (
                  <>
                    <select
                      aria-label="按吸收状态筛选"
                      value={focusParams.status}
                      onChange={(e) =>
                        setFocusParams((p) => ({ ...p, status: e.target.value as RepoAbsorptionStatus | "all" }))
                      }
                    >
                      <option value="all">全部边状态</option>
                      {STATUS_KEYS.map((st) => (
                        <option key={st} value={st}>
                          {REPO_ABSORPTION_STATUS_LABELS[st]}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="按仓库活性筛选"
                      value={focusParams.vitality}
                      onChange={(e) =>
                        setFocusParams((p) => ({ ...p, vitality: e.target.value as RepoVitality | "all" }))
                      }
                    >
                      <option value="all">全部活性</option>
                      <option value="active">活跃</option>
                      <option value="dormant">静默</option>
                      <option value="stale">陈旧</option>
                      <option value="archived">已归档</option>
                    </select>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#525852" }}>
                      <input
                        type="checkbox"
                        checked={focusParams.includeRejected}
                        onChange={(e) => setFocusParams((p) => ({ ...p, includeRejected: e.target.checked }))}
                      />
                      含已驳回
                    </label>
                  </>
                )}

                {/* 搜索定位仓库 */}
                <div className="re-search-box">
                  <input
                    type="search"
                    value={graphSearch}
                    onChange={(e) => setGraphSearch(e.target.value)}
                    onFocus={() => graphSearchResults.length > 0 && setGraphSearchOpen(true)}
                    onBlur={() => window.setTimeout(() => setGraphSearchOpen(false), 180)}
                    placeholder="搜索定位任意 Star / 自有仓…"
                    aria-label="搜索定位仓库"
                  />
                  {graphSearchOpen && graphSearchResults.length > 0 && (
                    <ul className="re-search-dropdown" role="listbox">
                      {graphSearchResults.map((node) => (
                        <li key={node.id}>
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setGraphSearchOpen(false);
                              setGraphSearch("");
                              drillIntoFocus(node.role === "owned" ? "owned" : "star", node.id, {
                                openInspectorNodeId: node.id,
                              });
                            }}
                          >
                            <span>
                              {node.priorityTier === "spotlight" ? "★ " : ""}
                              {node.visibility === "private" ? "🔒 " : ""}
                              <strong>{node.fullName}</strong>
                            </span>
                            <span className="re-pill">{node.role === "owned" ? "自有" : `★ ${formatStars(node.starsCount)}`}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* SVG 图谱舞台 */}
            <div
              ref={stageRef}
              className="re-stage"
              data-panning={isPanning ? "true" : "false"}
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerUp}
            >
              {graphMode === "focus" && focusGraph?.truncated && (
                <div className="re-truncate-banner">
                  <span>
                    匹配 {focusGraph.totalMatchingStars} 个 Star 仓，图谱聚焦显示前 {focusGraph.starNodes.length} 个（抗毛线球 60fps 上限）
                  </span>
                  <button
                    type="button"
                    className="re-mini"
                    onClick={() => {
                      setActiveTab("domains");
                      if (focusParams.focusType === "domain") setPoolDomainId(focusParams.focusId);
                      if (focusParams.focusType === "floating") setPoolBucket("floating");
                    }}
                  >
                    去表格查看全量 →
                  </button>
                </div>
              )}

              {/* 空态引导 */}
              {macroGraph && stats && stats.ownedCount === 0 && stats.starredCount === 0 ? (
                <div className="re-empty-stage">
                  <div className="re-empty-card">
                    <h2>尚未同步 GitHub 仓库与 Star 数据</h2>
                    <p>
                      首次同步将通过本机已登录的 <code>gh</code> CLI 拉取你的公开与私有自有仓（默认重点关注{" "}
                      <strong>ai-agent-node</strong>）、全部 GitHub Star 仓及 Star Lists，并在 PostgreSQL 18 + pgvector 中构建向量索引。
                    </p>
                    <div className="re-empty-actions">
                      <button
                        type="button"
                        className="re-primary"
                        disabled={Boolean(busyAction)}
                        onClick={() => void triggerSync("incremental")}
                      >
                        立即增量同步 GitHub
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyAction)}
                        onClick={() => void triggerSync("full")}
                      >
                        全量同步全部 Star
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <svg
                  className="re-svg"
                  role="img"
                  aria-label={graphMode === "macro" ? "宏观领域星团与自有仓吸收图谱" : "聚焦 1 对 N 吸收流向图谱"}
                >
                  <defs>
                    <marker id="re-arrow-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#b9751d" />
                    </marker>
                    <marker id="re-arrow-indigo" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#483d82" />
                    </marker>
                    <marker id="re-arrow-pine" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#2a6b48" />
                    </marker>
                    <marker id="re-arrow-gray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#7b847d" />
                    </marker>
                    <marker id="re-arrow-rust" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#b05a4c" />
                    </marker>
                  </defs>

                  <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
                    {/* ======== 宏观星团态 ======== */}
                    {graphMode === "macro" && (
                      <>
                        <text x={36} y={22} fontSize={12} fontWeight={700} fill="#4d554e">
                          领域星团 · {domains.length} 个领域（点击钻取 1 对 N 流向）
                        </text>
                        <text x={680} y={22} fontSize={12} fontWeight={700} fill="#4d554e">
                          我的开源库 · {ownedRepos.length} 个（★ Spotlight 置顶 · 🔒 私有仓）
                        </text>

                        {/* 中间宏观贝塞尔连线 */}
                        {macroLayout.edges.map(({ edge, d, midX, midY }) => {
                          const hasHover = Boolean(hoveredMacroDomainId || hoveredMacroOwnedId || hoveredMacroEdgeId);
                          const isHot =
                            hoveredMacroEdgeId === edge.id ||
                            hoveredMacroDomainId === edge.sourceDomainId ||
                            hoveredMacroOwnedId === edge.targetNodeId;
                          const opacity = hasHover ? (isHot ? 0.96 : 0.14) : 0.72;
                          const color = macroEdgeColor(edge);
                          const width = Math.min(6.2, 1.5 + Math.log2(edge.linkCount + 1) * 1.45) + (isHot ? 0.8 : 0);
                          const badgeLabel =
                            edge.modulePointCount > 0
                              ? `${edge.linkCount} 边 · ${edge.modulePointCount} 模块`
                              : `${edge.linkCount} 边`;
                          const badgeW = Math.max(54, badgeLabel.length * 7.2 + 12);
                          return (
                            <g
                              key={edge.id}
                              className="re-svg-edge"
                              style={{ opacity }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseEnter={() => setHoveredMacroEdgeId(edge.id)}
                              onMouseLeave={() => setHoveredMacroEdgeId(null)}
                              onClick={() => drillIntoFocus("owned", edge.targetNodeId)}
                            >
                              <title>{`${edge.sourceDomainName} → ${edge.targetRepoFullName}\n共 ${edge.linkCount} 条吸收边（建议 ${edge.suggestedCount} · 待批 ${edge.inReviewCount} · 已批/落地 ${edge.approvedCount + edge.absorbedCount} · 模块点 ${edge.modulePointCount}）`}</title>
                              <path d={d} className="re-svg-edge-hit" />
                              <path
                                d={d}
                                fill="none"
                                stroke={color}
                                strokeWidth={width}
                                strokeDasharray={edge.approvedCount + edge.absorbedCount + edge.inReviewCount === 0 ? "6 4" : undefined}
                              />
                              <g transform={`translate(${midX}, ${midY})`}>
                                <rect
                                  x={-badgeW / 2}
                                  y={-10}
                                  width={badgeW}
                                  height={20}
                                  rx={3}
                                  fill="#fffdf8"
                                  stroke={color}
                                  strokeWidth={isHot ? 1.4 : 1}
                                />
                                <text
                                  x={0}
                                  y={4}
                                  textAnchor="middle"
                                  fontSize={10.5}
                                  fontFamily="IBM Plex Mono, monospace"
                                  fill="#232d27"
                                >
                                  {badgeLabel}
                                </text>
                              </g>
                            </g>
                          );
                        })}

                        {/* 左侧：领域簇卡片 */}
                        {domains.map((domain) => {
                          const pos = macroLayout.domainPos.get(domain.id);
                          if (!pos) return null;
                          const hasHover = Boolean(hoveredMacroDomainId || hoveredMacroOwnedId || hoveredMacroEdgeId);
                          const connected =
                            hoveredMacroDomainId === domain.id ||
                            macroLayout.edges.some(
                              (e) =>
                                e.edge.sourceDomainId === domain.id &&
                                (e.edge.id === hoveredMacroEdgeId || e.edge.targetNodeId === hoveredMacroOwnedId),
                            );
                          const opacity = hasHover ? (connected ? 1 : 0.28) : 1;
                          return (
                            <g
                              key={domain.id}
                              className="re-svg-node"
                              transform={`translate(${pos.x}, ${pos.y})`}
                              style={{ opacity }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseEnter={() => setHoveredMacroDomainId(domain.id)}
                              onMouseLeave={() => setHoveredMacroDomainId(null)}
                              onClick={() => drillIntoFocus("domain", domain.id)}
                            >
                              <title>{`${domain.name}：${domain.description || "点击钻取该领域吸收流向"}`}</title>
                              <rect
                                width={pos.w}
                                height={pos.h}
                                rx={3}
                                fill="#fffdf8"
                                stroke={connected && hasHover ? domain.color : "#c9c3b3"}
                                strokeWidth={connected && hasHover ? 1.8 : 1.2}
                              />
                              <rect x={0} y={0} width={5} height={pos.h} rx={1} fill={domain.color || "#2b4e3c"} />
                              <text x={15} y={24} fontSize={13.5} fontWeight={700} fill="#1f2822">
                                {formatDomainIcon(domain.icon) ? `${formatDomainIcon(domain.icon)} ` : ""}
                                {truncateText(domain.name, 20)}
                              </text>
                              <rect x={pos.w - 58} y={10} width={48} height={20} rx={2} fill="#f2eee2" stroke="#d5d0c2" />
                              <text
                                x={pos.w - 34}
                                y={24}
                                textAnchor="middle"
                                fontSize={11}
                                fontWeight={600}
                                fontFamily="IBM Plex Mono, monospace"
                                fill="#232d27"
                              >
                                {domain.totalNodes}
                              </text>
                              <text x={15} y={45} fontSize={11.5} fill="#565d56">
                                活跃 {domain.activeNodes} · 陈旧 {domain.staleNodes + domain.archivedNodes} · 已关联 {domain.linkedNodes}
                              </text>
                              <text x={15} y={63} fontSize={10.8} fill="#767c74">
                                建议 {domain.suggestedLinks} · 待批 {domain.inReviewLinks} · 已批/落地 {domain.approvedLinks + domain.absorbedLinks}
                              </text>
                            </g>
                          );
                        })}

                        {/* 左侧底部：游离散落星云（虚线框） */}
                        {macroGraph?.floatingPool && (
                          <g
                            className="re-svg-node"
                            transform={`translate(${macroLayout.floatingBox.x}, ${macroLayout.floatingBox.y})`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => drillIntoFocus("floating", "")}
                          >
                            <title>游离散落星云：未归类或低匹配陈旧仓，点击查看或进入散落池工作台打捞/归档</title>
                            <rect
                              width={macroLayout.floatingBox.w}
                              height={macroLayout.floatingBox.h}
                              rx={3}
                              fill="#f7f4ea"
                              stroke="#a89e8a"
                              strokeWidth={1.5}
                              strokeDasharray="6 4"
                            />
                            <text x={14} y={24} fontSize={13.5} fontWeight={700} fill="#564a35">
                              ◌ 游离散落星云（未归类 / 陈旧仓）
                            </text>
                            <rect x={macroLayout.floatingBox.w - 60} y={9} width={50} height={20} rx={2} fill="#ede6d5" stroke="#c5bba6" />
                            <text
                              x={macroLayout.floatingBox.w - 35}
                              y={23}
                              textAnchor="middle"
                              fontSize={11}
                              fontWeight={600}
                              fontFamily="IBM Plex Mono, monospace"
                              fill="#564a35"
                            >
                              {macroGraph.floatingPool.totalCount}
                            </text>
                            <text x={14} y={45} fontSize={11.5} fill="#6c6558">
                              未归类 {macroGraph.floatingPool.unclassifiedCount} · 归类未连线 {macroGraph.floatingPool.classifiedUnlinkedCount}
                            </text>
                            <text x={14} y={64} fontSize={11} fill="#827a6c">
                              陈旧 {macroGraph.floatingPool.staleCount} · 已归档 {macroGraph.floatingPool.archivedCount} · 点击钻取或切「领域与散落池」
                            </text>
                          </g>
                        )}

                        {/* 右侧：我的开源库（Spotlight 置顶 + 私有标） */}
                        {macroLayout.visibleOwned.map((repo) => {
                          const pos = macroLayout.ownedPos.get(repo.id);
                          if (!pos) return null;
                          const isSpot = repo.priorityTier === "spotlight";
                          const isPriv = repo.visibility === "private";
                          const hasHover = Boolean(hoveredMacroDomainId || hoveredMacroOwnedId || hoveredMacroEdgeId);
                          const connected =
                            hoveredMacroOwnedId === repo.id ||
                            macroLayout.edges.some(
                              (e) =>
                                e.edge.targetNodeId === repo.id &&
                                (e.edge.id === hoveredMacroEdgeId || e.edge.sourceDomainId === hoveredMacroDomainId),
                            );
                          const opacity = hasHover ? (connected ? 1 : 0.28) : 1;
                          return (
                            <g
                              key={repo.id}
                              className="re-svg-node"
                              transform={`translate(${pos.x}, ${pos.y})`}
                              style={{ opacity }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseEnter={() => setHoveredMacroOwnedId(repo.id)}
                              onMouseLeave={() => setHoveredMacroOwnedId(null)}
                              onClick={() => drillIntoFocus("owned", repo.id, { openInspectorNodeId: repo.id })}
                            >
                              <title>{`${repo.fullName}${isPriv ? " [私有]" : ""}${isSpot ? " [重点关注]" : ""}\n点击聚焦所有滋养它的 Star 仓`}</title>
                              <rect
                                width={pos.w}
                                height={pos.h}
                                rx={3}
                                fill={isSpot ? "#fffbf0" : "#fffdf8"}
                                stroke={isSpot ? "#c79c4c" : connected && hasHover ? "#2b4e3c" : "#c5bfb0"}
                                strokeWidth={isSpot ? 1.8 : 1.2}
                              />
                              <rect
                                x={pos.w - 5}
                                y={0}
                                width={5}
                                height={pos.h}
                                rx={1}
                                fill={isSpot ? "#c79c4c" : isPriv ? "#6b5478" : "#2b4e3c"}
                              />
                              <text x={13} y={23} fontSize={13.5} fontWeight={700} fill="#1d2620">
                                {isSpot ? "★ " : ""}
                                {isPriv ? "🔒 " : ""}
                                {truncateText(repo.name, 24)}
                              </text>
                              {repo.primaryLanguage && (
                                <text x={pos.w - 14} y={22} textAnchor="end" fontSize={10.5} fill="#6b7068">
                                  {repo.primaryLanguage}
                                </text>
                              )}
                              <text x={13} y={42} fontSize={11.5} fill="#535a53">
                                滋养边 {repo.incomingLinkCount} · 待批 {repo.inReviewCount} · 已批/落地 {repo.approvedCount + repo.absorbingCount + repo.absorbedCount}
                              </text>
                              <text x={13} y={58} fontSize={10.8} fill="#767c74">
                                模块点数 {repo.modulePointCount} · {isPriv ? "私有仓" : "公开仓"}
                                {isSpot ? " · 重点关注" : ""}
                              </text>
                            </g>
                          );
                        })}

                        {macroLayout.hiddenOwnedCount > 0 && (
                          <g
                            className="re-svg-node"
                            transform={`translate(680, ${38 + macroLayout.visibleOwned.length * 79})`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setShowAllOwnedInMacro(true)}
                          >
                            <rect width={326} height={36} rx={3} fill="#f2eee2" stroke="#bbb4a4" strokeDasharray="4 3" />
                            <text x={163} y={22} textAnchor="middle" fontSize={12} fill="#3d463f">
                              展开其余 {macroLayout.hiddenOwnedCount} 个自有仓 ▾
                            </text>
                          </g>
                        )}
                      </>
                    )}

                    {/* ======== 聚焦流向态（1 对 N 扇形高亮） ======== */}
                    {graphMode === "focus" && (
                      <>
                        <text x={focusLayout.starX} y={22} fontSize={12} fontWeight={700} fill="#4d554e">
                          {focusLayout.drawerOpen
                            ? `Star 仓源头 · ${focusGraph?.starNodes.length ?? 0} 个（1 对 N 扇形高亮）`
                            : `Star 仓源头 · ${focusGraph?.starNodes.length ?? 0} 个（悬停/点击扇形高亮 1 对 N 吸收边）`}
                        </text>
                        <text x={focusLayout.ownedX} y={22} fontSize={12} fontWeight={700} fill="#4d554e">
                          {focusLayout.drawerOpen
                            ? `我的开源库 · ${focusGraph?.ownedNodes.length ?? 0} 个`
                            : `我的开源库 · ${focusGraph?.ownedNodes.length ?? 0} 个（悬停/点击反向高亮滋养源）`}
                        </text>

                        {/* 中心 1 对 N 贝塞尔吸收边 */}
                        {focusLayout.renderedLinks.map(({ link, d, midX, midY }) => {
                          const vis = edgeStatusVisual(link.status);
                          const isSelected = inspectorMode === "link" && selectedLink?.id === link.id;
                          const isHot = focusHighlight.linkIds.has(link.id) || isSelected;
                          const opacity = focusHighlight.active ? (isHot ? 1 : 0.14) : 0.84;
                          const marker =
                            link.status === "suggested"
                              ? "url(#re-arrow-amber)"
                              : link.status === "in_review"
                                ? "url(#re-arrow-indigo)"
                                : link.status === "watching"
                                  ? "url(#re-arrow-gray)"
                                  : link.status === "rejected"
                                    ? "url(#re-arrow-rust)"
                                    : "url(#re-arrow-pine)";
                          const badgeText =
                            link.moduleAnalysis.length > 0
                              ? `${link.moduleAnalysis.length} 模块`
                              : `${Math.round(link.strength * 100)}%`;
                          const badgeW = Math.max(46, badgeText.length * 7.5 + 12);
                          return (
                            <g
                              key={link.id}
                              className="re-svg-edge"
                              style={{ opacity }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseEnter={() => setHoveredFocusLinkId(link.id)}
                              onMouseLeave={() => setHoveredFocusLinkId(null)}
                              onClick={() => void openLinkInspector(link)}
                            >
                              <title>{`${link.sourceRepoFullName} → ${link.targetRepoFullName}\n状态：${REPO_ABSORPTION_STATUS_LABELS[link.status]} · 模块点数：${link.moduleAnalysis.length}`}</title>
                              <path d={d} className="re-svg-edge-hit" />
                              <path
                                d={d}
                                fill="none"
                                stroke={vis.stroke}
                                strokeWidth={isHot || isSelected ? vis.width + 1.2 : vis.width}
                                strokeDasharray={vis.dash}
                                markerEnd={marker}
                              />
                              <g transform={`translate(${midX}, ${midY})`}>
                                <rect
                                  x={-badgeW / 2}
                                  y={-10}
                                  width={badgeW}
                                  height={20}
                                  rx={10}
                                  fill={isSelected ? vis.stroke : "#fffdf8"}
                                  stroke={vis.stroke}
                                  strokeWidth={isHot || isSelected ? 1.5 : 1}
                                />
                                <text
                                  x={0}
                                  y={3.8}
                                  textAnchor="middle"
                                  fontSize={10.5}
                                  fontWeight={600}
                                  fontFamily="IBM Plex Mono, monospace"
                                  fill={isSelected ? "#fffdf8" : "#232d27"}
                                >
                                  {badgeText}
                                </text>
                              </g>
                            </g>
                          );
                        })}

                        {/* 左列：Star 仓节点 */}
                        {(focusGraph?.starNodes ?? []).map((node) => {
                          const pos = focusLayout.starPos.get(node.id);
                          if (!pos) return null;
                          const outCount = focusLayout.starOutCount.get(node.id) ?? 0;
                          const isSelected = inspectorMode === "node" && selectedNodeDetail?.node.id === node.id;
                          const isHot = focusHighlight.starIds.has(node.id) || isSelected;
                          const opacity = focusHighlight.active ? (isHot ? 1 : 0.2) : 1;
                          return (
                            <g
                              key={node.id}
                              className="re-svg-node"
                              transform={`translate(${pos.x}, ${pos.y})`}
                              style={{ opacity }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseEnter={() => setHoveredFocusStarId(node.id)}
                              onMouseLeave={() => setHoveredFocusStarId(null)}
                              onClick={() => void openNodeInspector(node.id)}
                            >
                              <title>{`${node.fullName}\n${node.description || ""}`}</title>
                              <rect
                                width={pos.w}
                                height={pos.h}
                                rx={3}
                                fill={isSelected ? "#f4f8f5" : "#fffdf8"}
                                stroke={isSelected ? "#2b4e3c" : isHot && focusHighlight.active ? "#b9751d" : "#cac4b5"}
                                strokeWidth={isSelected || (isHot && focusHighlight.active) ? 2 : 1.1}
                              />
                              <rect
                                x={0}
                                y={0}
                                width={4.5}
                                height={pos.h}
                                rx={1}
                                fill={node.primaryDomainColor || "#8c8f88"}
                              />
                              <text x={13} y={20} fontSize={12.5} fontWeight={700} fill="#1f2822">
                                {truncateText(node.fullName, focusLayout.drawerOpen ? 23 : 31)}
                              </text>
                              {outCount > 0 && (
                                <g transform={`translate(${pos.w - 50}, 7)`}>
                                  <rect
                                    width={42}
                                    height={18}
                                    rx={9}
                                    fill={outCount > 1 ? "#fdf3e1" : "#eef3ef"}
                                    stroke={outCount > 1 ? "#c98b2c" : "#8fb39b"}
                                  />
                                  <text
                                    x={21}
                                    y={12.5}
                                    textAnchor="middle"
                                    fontSize={10}
                                    fontWeight={600}
                                    fill={outCount > 1 ? "#7d4d0e" : "#224f34"}
                                  >
                                    →{outCount}库
                                  </text>
                                </g>
                              )}
                              <text x={13} y={pos.h > 58 ? 39 : 37} fontSize={11} fill="#5d645d">
                                ★ {formatStars(node.starsCount)}
                                {node.primaryLanguage ? ` · ${node.primaryLanguage}` : ""}
                                {" · "}
                                {REPO_VITALITY_LABELS[node.vitality]}
                              </text>
                              {pos.h > 58 && (
                                <text x={13} y={55} fontSize={10.5} fill="#7b8179">
                                  {truncateText(node.primaryDomainName || "未归类（散落池）", 26)}
                                </text>
                              )}
                            </g>
                          );
                        })}

                        {/* 右列：我的开源库节点 */}
                        {(focusGraph?.ownedNodes ?? []).map((node) => {
                          const pos = focusLayout.ownedPos.get(node.id);
                          if (!pos) return null;
                          const inCount = focusLayout.ownedInCount.get(node.id) ?? 0;
                          const isSpot = node.priorityTier === "spotlight";
                          const isPriv = node.visibility === "private";
                          const isSelected = inspectorMode === "node" && selectedNodeDetail?.node.id === node.id;
                          const isHot = focusHighlight.ownedIds.has(node.id) || isSelected;
                          const opacity = focusHighlight.active ? (isHot ? 1 : 0.2) : 1;
                          return (
                            <g
                              key={node.id}
                              className="re-svg-node"
                              transform={`translate(${pos.x}, ${pos.y})`}
                              style={{ opacity }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseEnter={() => setHoveredFocusOwnedId(node.id)}
                              onMouseLeave={() => setHoveredFocusOwnedId(null)}
                              onClick={() => void openNodeInspector(node.id)}
                            >
                              <title>{`${node.fullName}${isPriv ? " [私有]" : ""}${isSpot ? " [重点关注]" : ""}`}</title>
                              <rect
                                width={pos.w}
                                height={pos.h}
                                rx={3}
                                fill={isSelected ? "#f3f8f4" : isSpot ? "#fffbf0" : "#fffdf8"}
                                stroke={isSelected ? "#2b4e3c" : isSpot ? "#c79c4c" : isHot && focusHighlight.active ? "#2b4e3c" : "#c5bfb0"}
                                strokeWidth={isSelected || isSpot ? 2 : 1.2}
                              />
                              <rect
                                x={pos.w - 5}
                                y={0}
                                width={5}
                                height={pos.h}
                                rx={1}
                                fill={isSpot ? "#c79c4c" : isPriv ? "#6b5478" : "#2b4e3c"}
                              />
                              <text x={13} y={24} fontSize={13.5} fontWeight={700} fill="#1d2620">
                                {isSpot ? "★ " : ""}
                                {isPriv ? "🔒 " : ""}
                                {truncateText(node.name, focusLayout.drawerOpen ? 20 : 25)}
                              </text>
                              <text x={13} y={44} fontSize={11.5} fill="#535a53">
                                本视图滋养源 {inCount} 个 · {node.primaryLanguage || "多语言"} · {isPriv ? "私有" : "公开"}
                              </text>
                              <text x={13} y={61} fontSize={10.5} fill="#767c74">
                                {truncateText(node.fullName, focusLayout.drawerOpen ? 28 : 36)}
                              </text>
                            </g>
                          );
                        })}

                        {focusGraph && focusGraph.starNodes.length === 0 && focusGraph.ownedNodes.length === 0 && (
                          <text x={420} y={180} textAnchor="middle" fontSize={14} fill="#666d66">
                            当前筛选条件下暂无关联节点，可切换焦点、放宽状态筛选，或点击上方「AI 向量聚类与召回」。
                          </text>
                        )}
                      </>
                    )}
                  </g>
                </svg>
              )}

              {/* 状态图例 */}
              <div className="re-legend-dock" aria-label="吸收边状态图例">
                <span className="re-legend-item">
                  <i className="re-legend-line suggested" /> AI 建议
                </span>
                <span className="re-legend-item">
                  <i className="re-legend-line in_review" /> 信箱待批
                </span>
                <span className="re-legend-item">
                  <i className="re-legend-line approved" /> 已批/吸收
                </span>
                <span className="re-legend-item">
                  <i className="re-legend-line watching" /> 暂存观察
                </span>
              </div>

              {/* 缩放工具条 */}
              <div className="re-zoom-dock" onPointerDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="re-mini"
                  aria-label="缩小图谱"
                  onClick={() => setViewport((vp) => ({ ...vp, zoom: Math.max(0.45, Math.round((vp.zoom - 0.12) * 100) / 100) }))}
                >
                  −
                </button>
                <span className="re-zoom-readout">{Math.round(viewport.zoom * 100)}%</span>
                <button
                  type="button"
                  className="re-mini"
                  aria-label="放大图谱"
                  onClick={() => setViewport((vp) => ({ ...vp, zoom: Math.min(2.0, Math.round((vp.zoom + 0.12) * 100) / 100) }))}
                >
                  +
                </button>
                <button type="button" className="re-mini" onClick={resetViewport}>
                  复位
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ================= 视图 2：领域整理与散落池工作台 ================= */}
        {activeTab === "domains" && (
          <div className="re-pool-layout">
            {/* 左栏：快捷桶 + 领域列表 */}
            <aside className="re-pool-rail" aria-label="领域与散落池导航">
              <div className="re-rail-section">
                <div className="re-rail-head">
                  <h3>快捷池与重点视图</h3>
                </div>
                {POOL_BUCKET_ITEMS.map((item) => {
                  const count = item.statKey && stats ? stats[item.statKey] : null;
                  const active = poolBucket === item.id && !poolDomainId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="re-rail-btn"
                      aria-pressed={active}
                      onClick={() => {
                        setPoolBucket(item.id);
                        setPoolDomainId("");
                        setPoolPage(1);
                        setCheckedNodeIds(new Set());
                      }}
                    >
                      <span>{item.label}</span>
                      {count !== null && <span className="re-rail-count">{count}</span>}
                    </button>
                  );
                })}
              </div>

              <div className="re-rail-section">
                <div className="re-rail-head">
                  <h3>领域分组 ({domains.length})</h3>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      className="re-mini"
                      onClick={() =>
                        setDomainModal({
                          mode: "create",
                          name: "",
                          description: "",
                          color: DOMAIN_COLORS[domains.length % DOMAIN_COLORS.length],
                          icon: "◈",
                          seedKeywords: "",
                        })
                      }
                    >
                      + 新建
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={busyAction === "import-lists"}
                      onClick={() => void handleImportGithubLists()}
                      title="导入 GitHub Star Lists 为领域"
                    >
                      {busyAction === "import-lists" ? "导入…" : "导入 Lists"}
                    </button>
                  </div>
                </div>

                {domains.map((domain) => {
                  const active = poolDomainId === domain.id;
                  return (
                    <div key={domain.id} className="re-domain-row">
                      <button
                        type="button"
                        className="re-rail-btn"
                        aria-pressed={active}
                        onClick={() => {
                          setPoolDomainId(domain.id);
                          setPoolBucket("all");
                          setPoolPage(1);
                          setCheckedNodeIds(new Set());
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span className="re-domain-dot" style={{ background: domain.color || "#2b4e3c" }} />
                          <span className="re-domain-name-text" title={domain.description || domain.name}>
                            {domain.name}
                          </span>
                        </span>
                        <span className="re-rail-count">{domain.totalNodes}</span>
                      </button>
                      <button
                        type="button"
                        className="re-ghost re-mini"
                        title="编辑领域"
                        aria-label={`编辑领域 ${domain.name}`}
                        onClick={() =>
                          setDomainModal({
                            mode: "edit",
                            domain,
                            name: domain.name,
                            description: domain.description,
                            color: domain.color,
                            icon: domain.icon,
                            seedKeywords: domain.seedKeywords.join(", "),
                          })
                        }
                      >
                        ✎
                      </button>
                      {domains.length > 1 && (
                        <button
                          type="button"
                          className="re-ghost re-mini"
                          title="合并到其他领域"
                          aria-label={`合并领域 ${domain.name}`}
                          onClick={() => {
                            const other = domains.find((d) => d.id !== domain.id);
                            setMergeModal({
                              sourceDomainId: domain.id,
                              targetDomainId: other?.id ?? "",
                            });
                          }}
                        >
                          ⇄
                        </button>
                      )}
                      {domain.source !== "builtin" && (
                        <button
                          type="button"
                          className="re-ghost re-mini"
                          title="删除领域"
                          aria-label={`删除领域 ${domain.name}`}
                          onClick={() => void handleDeleteDomain(domain)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </aside>

            {/* 主区：千级分页仓库表 + 批量整理 */}
            <div className="re-pool-main">
              <div className="re-pool-filters">
                <input
                  type="search"
                  value={poolQuery}
                  onChange={(e) => setPoolQuery(e.target.value)}
                  placeholder="搜索仓库名、描述、Topic…"
                  aria-label="搜索仓库"
                />
                <select
                  aria-label="活性筛选"
                  value={poolVitality}
                  onChange={(e) => {
                    setPoolVitality(e.target.value as RepoVitality | "all");
                    setPoolPage(1);
                  }}
                >
                  <option value="all">全部活性</option>
                  <option value="active">活跃 ({nodesPage?.facets.vitalityCounts.active ?? 0})</option>
                  <option value="dormant">静默 ({nodesPage?.facets.vitalityCounts.dormant ?? 0})</option>
                  <option value="stale">陈旧 ({nodesPage?.facets.vitalityCounts.stale ?? 0})</option>
                  <option value="archived">已归档 ({nodesPage?.facets.vitalityCounts.archived ?? 0})</option>
                </select>
                <select
                  aria-label="语言筛选"
                  value={poolLanguage}
                  onChange={(e) => {
                    setPoolLanguage(e.target.value);
                    setPoolPage(1);
                  }}
                >
                  <option value="">全部语言</option>
                  {(nodesPage?.facets.languages ?? []).slice(0, 30).map((l) => (
                    <option key={l.name} value={l.name}>
                      {l.name} ({l.count})
                    </option>
                  ))}
                </select>
                <select
                  aria-label="可见性筛选"
                  value={poolVisibility}
                  onChange={(e) => {
                    setPoolVisibility(e.target.value as RepoVisibility | "all");
                    setPoolPage(1);
                  }}
                >
                  <option value="all">全部可见性</option>
                  <option value="public">公开</option>
                  <option value="private">🔒 私有</option>
                </select>
                <select
                  aria-label="排序方式"
                  value={poolSortBy}
                  onChange={(e) => {
                    setPoolSortBy(e.target.value as RepoNodeSortBy);
                    setPoolPage(1);
                  }}
                >
                  <option value="starred_at">按 Star 时间</option>
                  <option value="pushed_at">按最近推送</option>
                  <option value="stars">按 Star 数量</option>
                  <option value="priority">按重点优先级</option>
                  <option value="name">按仓库名</option>
                </select>
              </div>

              {/* 批量操作条 */}
              {checkedNodeIds.size > 0 && (
                <div className="re-batch-bar" role="region" aria-label="批量操作仓库">
                  <span>已选中 <strong>{checkedNodeIds.size}</strong> 个仓库</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <select
                      aria-label="选择目标领域"
                      value={batchTargetDomainId}
                      onChange={(e) => setBatchTargetDomainId(e.target.value)}
                    >
                      <option value="">选择目标领域…</option>
                      {domains.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="re-primary re-mini"
                      disabled={!batchTargetDomainId || Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("assign_domain", batchTargetDomainId)}
                    >
                      批量改领域
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("clear_domain")}
                    >
                      移回未归类
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("archive_stale")}
                    >
                      批量标陈旧归档
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("restore_standard")}
                    >
                      打捞恢复
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("set_spotlight")}
                    >
                      设为重点关注
                    </button>
                    <button type="button" className="re-mini" onClick={() => setCheckedNodeIds(new Set())}>
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 分页表格 */}
              <div className="re-table-scroll">
                <table className="re-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label="全选当前页"
                          checked={allPoolChecked}
                          onChange={toggleAllPool}
                        />
                      </th>
                      <th>仓库</th>
                      <th>所属领域</th>
                      <th>活性 / Star / 推送</th>
                      <th>吸收关联</th>
                      <th>快捷操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poolLoading && !nodesPage ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: 28, color: "#656b64" }}>
                          正在加载仓库数据…
                        </td>
                      </tr>
                    ) : !nodesPage || nodesPage.items.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: 32, color: "#656b64" }}>
                          当前池子或筛选条件下暂无仓库。
                        </td>
                      </tr>
                    ) : (
                      nodesPage.items.map((node) => {
                        const checked = checkedNodeIds.has(node.id);
                        return (
                          <tr key={node.id} data-selected={checked ? "true" : "false"}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`勾选 ${node.fullName}`}
                                checked={checked}
                                onChange={() => {
                                  setCheckedNodeIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(node.id)) next.delete(node.id);
                                    else next.add(node.id);
                                    return next;
                                  });
                                }}
                              />
                            </td>
                            <td>
                              <div className="re-repo-cell">
                                <div className="re-repo-cell-head">
                                  <button
                                    type="button"
                                    className="re-repo-name-btn"
                                    onClick={() => void openNodeInspector(node.id)}
                                  >
                                    {node.fullName}
                                  </button>
                                  {node.priorityTier === "spotlight" && <span className="re-pill spotlight">★ 重点</span>}
                                  {node.visibility === "private" && <span className="re-pill private">🔒 私有</span>}
                                  {node.role === "owned" && <span className="re-pill active">自有</span>}
                                  {node.primaryLanguage && <span className="re-pill">{node.primaryLanguage}</span>}
                                </div>
                                {node.description && <div className="re-repo-desc">{node.description}</div>}
                              </div>
                            </td>
                            <td>
                              {node.primaryDomainName ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  <span className="re-pill">
                                    <span className="re-domain-dot" style={{ background: node.primaryDomainColor || "#2b4e3c" }} />
                                    {node.primaryDomainName}
                                  </span>
                                  <small style={{ color: "#6f756e", fontSize: 11 }}>
                                    {node.domainAssignedBy === "ai"
                                      ? `AI 推荐${node.domainConfidence ? ` (${Math.round(node.domainConfidence * 100)}%)` : ""}`
                                      : node.domainAssignedBy === "github_list"
                                        ? "GitHub List"
                                        : "手动指定"}
                                  </small>
                                </div>
                              ) : (
                                <span className="re-pill stale">未归类</span>
                              )}
                            </td>
                            <td>
                              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <span className={`re-pill ${node.vitality}`}>{REPO_VITALITY_LABELS[node.vitality]}</span>
                                <span className="re-mono" style={{ color: "#585f57" }}>
                                  ★ {formatStars(node.starsCount)} · 推 {formatDateShort(node.pushedAt)}
                                </span>
                              </div>
                            </td>
                            <td>
                              <span className={node.linkCount > 0 ? "re-pill active" : "re-pill"}>
                                {node.linkCount > 0 ? `已连 ${node.linkCount} 边` : "未连线"}
                              </span>
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                                {node.role !== "owned" && (
                                  <button
                                    type="button"
                                    className="re-mini re-primary"
                                    onClick={() => void openQuickLinkModal(node)}
                                  >
                                    1 对 N 关联
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="re-mini"
                                  onClick={() =>
                                    drillIntoFocus(node.role === "owned" ? "owned" : "star", node.id, {
                                      openInspectorNodeId: node.id,
                                    })
                                  }
                                >
                                  图谱聚焦
                                </button>
                                <button
                                  type="button"
                                  className="re-mini"
                                  onClick={() => void openNodeInspector(node.id)}
                                >
                                  详情
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* 分页栏 */}
              <div className="re-pager">
                <span>
                  共 <strong>{nodesPage?.total ?? 0}</strong> 条 · 第 {nodesPage?.page ?? 1} / {Math.max(1, nodesPage?.totalPages ?? 1)} 页
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <select
                    aria-label="每页条数"
                    value={poolPageSize}
                    onChange={(e) => {
                      setPoolPageSize(Number(e.target.value));
                      setPoolPage(1);
                    }}
                  >
                    <option value={25}>25 条/页</option>
                    <option value={50}>50 条/页</option>
                    <option value={100}>100 条/页</option>
                  </select>
                  <button
                    type="button"
                    className="re-mini"
                    disabled={!nodesPage || nodesPage.page <= 1 || poolLoading}
                    onClick={() => setPoolPage((p) => Math.max(1, p - 1))}
                  >
                    ← 上一页
                  </button>
                  <button
                    type="button"
                    className="re-mini"
                    disabled={!nodesPage || nodesPage.page >= nodesPage.totalPages || poolLoading}
                    onClick={() => setPoolPage((p) => p + 1)}
                  >
                    下一页 →
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================= 视图 3：进化时间线 ================= */}
        {activeTab === "timeline" && (
          <div className="re-timeline-wrap">
            <div className="re-timeline-bar">
              <div className="re-stage-pipeline" aria-label="吸收进化标准链路">
                <span className="re-stage-step">1. 发现关联</span>
                <span>→</span>
                <span className="re-stage-step">2. 模块分析</span>
                <span>→</span>
                <span className="re-stage-step">3. 发总裁信箱</span>
                <span>→</span>
                <span className="re-stage-step">4. 创始人批示（批准 / 暂缓 / 驳回）</span>
                <span>→</span>
                <span className="re-stage-step">5. 吸收落地</span>
              </div>

              <div className="re-actions-group">
                <button
                  type="button"
                  className={!timelineTargetId && !timelineRepoName ? "re-active re-mini" : "re-mini"}
                  onClick={() => {
                    setTimelineTargetId("");
                    setTimelineRepoName("");
                  }}
                >
                  全局时间线
                </button>
                {spotlightOwned.map((repo) => {
                  const active = timelineTargetId === repo.id || timelineRepoName === repo.name || timelineRepoName === repo.fullName;
                  return (
                    <button
                      key={repo.id}
                      type="button"
                      className={active ? "re-active re-mini" : "re-mini re-spotlight-chip"}
                      onClick={() => {
                        setTimelineTargetId(repo.id);
                        setTimelineRepoName("");
                      }}
                    >
                      ★ {repo.name}
                    </button>
                  );
                })}
                {spotlightOwned.length === 0 && (
                  <button
                    type="button"
                    className={timelineRepoName === "ai-agent-node" ? "re-active re-mini" : "re-mini re-spotlight-chip"}
                    onClick={() => {
                      setTimelineTargetId("");
                      setTimelineRepoName("ai-agent-node");
                    }}
                  >
                    ★ ai-agent-node
                  </button>
                )}

                <select
                  aria-label="按我的开源库筛选"
                  value={timelineTargetId}
                  onChange={(e) => {
                    setTimelineTargetId(e.target.value);
                    setTimelineRepoName("");
                  }}
                >
                  <option value="">指定我的开源库（全部）</option>
                  {ownedRepos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.priorityTier === "spotlight" ? "★ " : ""}
                      {r.visibility === "private" ? "🔒 " : ""}
                      {r.fullName}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="按领域筛选时间线"
                  value={timelineDomainId}
                  onChange={(e) => setTimelineDomainId(e.target.value)}
                >
                  <option value="">全部领域</option>
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="按事件类型筛选"
                  value={timelineEventType}
                  onChange={(e) => setTimelineEventType(e.target.value as RepoEvolutionEventType | "all")}
                >
                  <option value="all">全部事件类型</option>
                  {EVENT_KEYS.map((et) => (
                    <option key={et} value={et}>
                      {REPO_EVOLUTION_EVENT_LABELS[et]}
                    </option>
                  ))}
                </select>

                <button type="button" className="re-mini" disabled={timelineLoading} onClick={() => void loadTimeline(false)}>
                  刷新
                </button>
              </div>
            </div>

            <div className="re-timeline-scroll">
              <div className="re-timeline-container">
                {timelineLoading && !timelinePage ? (
                  <p role="status" style={{ color: "#656b64", textAlign: "center", padding: 32 }}>
                    正在读取进化时间线…
                  </p>
                ) : timelineGroups.length === 0 ? (
                  <div className="re-empty-card" style={{ margin: "24px auto" }}>
                    <h3>暂无匹配的进化记录</h3>
                    <p>
                      当你执行同步、AI 聚类召回、模块级深度分析、提交总裁信箱或完成审批批示后，完整演变轨迹会自动沉淀在这里。
                    </p>
                  </div>
                ) : (
                  timelineGroups.map(([day, events]) => (
                    <section key={day} className="re-timeline-day">
                      <div className="re-timeline-day-label">
                        {day} · {events.length} 条记录
                      </div>
                      <ol className="re-timeline-list">
                        {events.map((ev) => (
                          <li key={ev.id} className="re-timeline-item">
                            <span className="re-timeline-dot" data-type={ev.eventType} aria-hidden="true" />
                            <div className="re-timeline-head">
                              <div className="re-badge-row">
                                <span className="re-pill">
                                  {REPO_EVOLUTION_EVENT_LABELS[ev.eventType] ?? ev.eventType}
                                </span>
                                {ev.domainName && <span className="re-pill">{ev.domainName}</span>}
                                <span style={{ fontSize: 11.5, color: "#666d66" }}>操作者：{ev.actor}</span>
                              </div>
                              <time className="re-mono" style={{ color: "#676d66" }}>
                                {formatTimeFull(ev.createdAt)}
                              </time>
                            </div>
                            <div className="re-timeline-title">{ev.title}</div>
                            {ev.summary && <div className="re-timeline-summary">{ev.summary}</div>}
                            <div className="re-timeline-foot">
                              <div className="re-badge-row">
                                {ev.sourceRepoFullName && ev.targetRepoFullName ? (
                                  <span className="re-mono" style={{ color: "#2b4e3c", fontWeight: 600 }}>
                                    {ev.sourceRepoFullName} → {ev.targetRepoFullName}
                                  </span>
                                ) : ev.targetRepoFullName || ev.sourceRepoFullName ? (
                                  <span className="re-mono" style={{ color: "#4c544d" }}>
                                    {ev.targetRepoFullName || ev.sourceRepoFullName}
                                  </span>
                                ) : null}
                              </div>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                {ev.linkId && (
                                  <button
                                    type="button"
                                    className="re-mini re-primary"
                                    onClick={() => void jumpToEdgeInGraph(ev.linkId!)}
                                  >
                                    图谱聚焦该边 →
                                  </button>
                                )}
                                {ev.decisionPacketId && (
                                  <a
                                    className="re-link-btn"
                                    style={{ padding: "2px 8px", fontSize: 11.5 }}
                                    href={`#mailbox?decision=${encodeURIComponent(ev.decisionPacketId)}`}
                                  >
                                    查看总裁信箱审批 ↗
                                  </a>
                                )}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))
                )}

                {timelinePage && timelinePage.items.length < timelinePage.total && (
                  <div style={{ textAlign: "center" }}>
                    <button type="button" disabled={timelineLoading} onClick={() => void loadTimeline(true)}>
                      {timelineLoading ? "加载中…" : `加载更多（已显示 ${timelinePage.items.length} / ${timelinePage.total}）`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================= 右侧 Inspector 抽屉（节点态 / 连线态） ================= */}
        {inspectorMode !== "none" && (
          <aside className="re-inspector" aria-label="详情与深度分析抽屉" data-testid="repo-evolution-inspector">
            <div className="re-inspector-head">
              <div className="re-inspector-title">
                <span style={{ fontSize: 11, color: "#656c64", letterSpacing: "0.05em" }}>
                  {inspectorMode === "node" ? "仓库节点检视器" : "吸收边 · 模块级深度分析"}
                </span>
                <h2>
                  {inspectorMode === "node"
                    ? selectedNodeDetail?.node.fullName || "读取中…"
                    : selectedLink
                      ? `${selectedLink.sourceRepoFullName} → ${selectedLink.targetRepoFullName}`
                      : "读取中…"}
                </h2>
              </div>
              <button
                type="button"
                className="re-ghost re-mini"
                aria-label="关闭检视抽屉"
                onClick={() => setInspectorMode("none")}
              >
                ✕
              </button>
            </div>

            <div className="re-inspector-body">
              {inspectorLoading && !selectedNodeDetail && !selectedLink && (
                <p role="status" style={{ color: "#636a63", fontSize: 12.5 }}>正在加载详情…</p>
              )}

              {/* ---- 节点态 Inspector ---- */}
              {inspectorMode === "node" && selectedNodeDetail && (() => {
                const node = selectedNodeDetail.node;
                const ghHref = safeExternalUrl(node.url);
                return (
                  <>
                    <div className="re-section-box">
                      <div className="re-badge-row">
                        <span className={`re-pill ${node.vitality}`}>{REPO_VITALITY_LABELS[node.vitality]}</span>
                        <span className="re-pill">{node.role === "owned" ? "我的开源库" : node.role === "both" ? "自有+Star" : "Star 仓"}</span>
                        {node.visibility === "private" && <span className="re-pill private">🔒 私有仓</span>}
                        {node.priorityTier === "spotlight" && <span className="re-pill spotlight">★ 重点关注</span>}
                        {node.primaryLanguage && <span className="re-pill">{node.primaryLanguage}</span>}
                      </div>

                      {node.description && (
                        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#363e37" }}>
                          {node.description}
                        </p>
                      )}

                      <div className="re-mono" style={{ fontSize: 11.5, color: "#5c635b", display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <span>★ {formatStars(node.starsCount)}</span>
                        <span>⑂ {node.forksCount}</span>
                        <span>推送 {formatDateShort(node.pushedAt)}</span>
                        {node.starredAt && <span>Star {formatDateShort(node.starredAt)}</span>}
                      </div>

                      {node.topics.length > 0 && (
                        <div className="re-badge-row">
                          {node.topics.slice(0, 10).map((t) => (
                            <span key={t} className="re-pill">#{t}</span>
                          ))}
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4 }}>
                        <button
                          type="button"
                          className="re-mini re-primary"
                          onClick={() => drillIntoFocus(node.role === "owned" ? "owned" : "star", node.id)}
                        >
                          在图谱中聚焦此仓
                        </button>
                        <button
                          type="button"
                          className="re-mini"
                          disabled={Boolean(busyAction)}
                          onClick={() =>
                            void handleUpdateNode(
                              node.id,
                              { priorityTier: node.priorityTier === "spotlight" ? "standard" : "spotlight" },
                              node.priorityTier === "spotlight" ? "已取消重点关注" : "已设为重点关注 (Spotlight)",
                            )
                          }
                        >
                          {node.priorityTier === "spotlight" ? "取消 ★ 重点" : "设为 ★ 重点关注"}
                        </button>
                        {ghHref && (
                          <a className="re-link-btn" style={{ padding: "2px 8px", fontSize: 11.5 }} href={ghHref} target="_blank" rel="noreferrer">
                            GitHub ↗
                          </a>
                        )}
                      </div>
                    </div>

                    {/* 私有仓 LLM 隐私开关 */}
                    {node.visibility === "private" && (
                      <label className="re-privacy-box">
                        <input
                          type="checkbox"
                          checked={node.allowLlmAnalysis}
                          disabled={Boolean(busyAction)}
                          onChange={(e) =>
                            void handleUpdateNode(
                              node.id,
                              { allowLlmAnalysis: e.target.checked },
                              e.target.checked ? "已允许对该私有仓执行 LLM 深度模块分析" : "已关闭该私有仓 LLM 外发分析（仅本地确定性分析）",
                            )
                          }
                        />
                        <span>
                          <strong>私有仓 LLM 分析隐私授权</strong>
                          <br />
                          允许将本私有仓的 README/目录结构摘要送入外部 LLM 进行模块对比（默认关闭以保护私密代码）。
                        </span>
                      </label>
                    )}

                    {/* 领域归属修改 */}
                    <div className="re-section-box">
                      <h3>领域归属</h3>
                      <label className="re-field">
                        <span>主领域</span>
                        <select
                          value={node.primaryDomainId ?? ""}
                          disabled={Boolean(busyAction)}
                          onChange={(e) =>
                            void handleUpdateNode(
                              node.id,
                              { primaryDomainId: e.target.value || null },
                              e.target.value ? "已更新主领域归属" : "已移回未归类散落池",
                            )
                          }
                        >
                          <option value="">未归类（游离散落池）</option>
                          {domains.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="re-field">
                        <span>副领域标签（多选）</span>
                        <div className="re-domain-chips">
                          {domains
                            .filter((d) => d.id !== node.primaryDomainId)
                            .map((d) => {
                              const selected = node.secondaryDomainIds.includes(d.id);
                              return (
                                <button
                                  key={d.id}
                                  type="button"
                                  className="re-domain-chip"
                                  data-selected={selected ? "true" : "false"}
                                  disabled={Boolean(busyAction)}
                                  onClick={() => {
                                    const next = selected
                                      ? node.secondaryDomainIds.filter((id) => id !== d.id)
                                      : [...node.secondaryDomainIds, d.id];
                                    void handleUpdateNode(node.id, { secondaryDomainIds: next }, "已更新副领域标签");
                                  }}
                                >
                                  {d.name}
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </div>

                    {/* 一键关联到多个我的开源库（Checkbox 1 对 N） */}
                    {node.role !== "owned" && ownedRepos.length > 0 && (
                      <div className="re-section-box">
                        <h3>一键关联到多个我的开源库（1 对 N）</h3>
                        <div className="re-checkbox-list">
                          {ownedRepos.map((owned) => {
                            const checked = bulkTargets.has(owned.id);
                            return (
                              <label key={owned.id} className="re-checkbox-item">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setBulkTargets((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(owned.id)) next.delete(owned.id);
                                      else next.add(owned.id);
                                      return next;
                                    });
                                  }}
                                />
                                <span>
                                  {owned.priorityTier === "spotlight" ? "★ " : ""}
                                  {owned.visibility === "private" ? "🔒 " : ""}
                                  <strong>{owned.name}</strong>
                                  <small style={{ color: "#686e67", marginLeft: 5 }}>{owned.owner}</small>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                          <select
                            aria-label="吸收关系类型"
                            value={bulkRelationType}
                            onChange={(e) => setBulkRelationType(e.target.value as RepoRelationType)}
                          >
                            {RELATION_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {REPO_RELATION_LABELS[k]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="re-primary"
                            disabled={bulkTargets.size === 0 || Boolean(busyAction)}
                            onClick={() => void handleBulkLinkFromInspector()}
                          >
                            {busyAction === "bulk-link" ? "关联中…" : `应用关联 (${bulkTargets.size} 库)`}
                          </button>
                        </div>
                        <input
                          type="text"
                          value={bulkRationale}
                          onChange={(e) => setBulkRationale(e.target.value)}
                          placeholder="可选：简要说明可吸收点…"
                        />
                      </div>
                    )}

                    {/* 关联的吸收边列表 */}
                    {(selectedNodeDetail.outgoingLinks.length > 0 || selectedNodeDetail.incomingLinks.length > 0) && (
                      <div className="re-section-box">
                        <h3>
                          已建立的吸收边 (
                          {selectedNodeDetail.outgoingLinks.length + selectedNodeDetail.incomingLinks.length})
                        </h3>
                        <ul className="re-link-list">
                          {[...selectedNodeDetail.outgoingLinks, ...selectedNodeDetail.incomingLinks].map((link) => (
                            <li key={link.id}>
                              <button
                                type="button"
                                className="re-link-item-btn"
                                onClick={() => void openLinkInspector(link)}
                              >
                                <span style={{ minWidth: 0 }}>
                                  <strong style={{ display: "block", fontSize: 12.5 }}>
                                    {link.sourceNodeId === node.id
                                      ? `→ ${link.targetRepoFullName}`
                                      : `← ${link.sourceRepoFullName}`}
                                  </strong>
                                  <small style={{ color: "#666c65" }}>
                                    {REPO_RELATION_LABELS[link.relationType]} · {link.moduleAnalysis.length} 模块点
                                  </small>
                                </span>
                                <span className={`re-pill ${link.status}`}>
                                  {REPO_ABSORPTION_STATUS_LABELS[link.status]}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 备注 */}
                    <div className="re-section-box">
                      <h3>个人备注</h3>
                      <textarea
                        rows={2}
                        value={nodeNotesDraft}
                        onChange={(e) => setNodeNotesDraft(e.target.value)}
                        placeholder="记录对该仓库架构或模块的观察笔记…"
                      />
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="re-mini"
                          disabled={Boolean(busyAction)}
                          onClick={() => void handleUpdateNode(node.id, { notes: nodeNotesDraft }, "已保存仓库备注")}
                        >
                          保存备注
                        </button>
                      </div>
                    </div>

                    {/* 内嵌 RepositoryIndexContent / README 预览 */}
                    <div className="re-section-box">
                      <h3>
                        <span>仓库文件树与 README 预览</span>
                        <button
                          type="button"
                          className="re-mini"
                          onClick={() => setShowNodeReadme((v) => !v)}
                        >
                          {showNodeReadme ? "收起预览" : "展开读取 README"}
                        </button>
                      </h3>
                      {showNodeReadme ? (
                        <RepoNodeContentPreview node={node} />
                      ) : (
                        <p style={{ margin: 0, fontSize: 12, color: "#646b64" }}>
                          按需加载根目录文件树、仓内代码搜索与 README 全文（内嵌 RepositoryIndexContent 能力）。
                        </p>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* ---- 连线态 Inspector（含模块级深度分析 & 总裁信箱） ---- */}
              {inspectorMode === "link" && selectedLink && (
                <>
                  <div className="re-section-box">
                    <div className="re-badge-row">
                      <span className={`re-pill ${selectedLink.status}`}>
                        {REPO_ABSORPTION_STATUS_LABELS[selectedLink.status]}
                      </span>
                      <span className="re-pill">{REPO_RELATION_LABELS[selectedLink.relationType]}</span>
                      <span className="re-pill">强度 {Math.round(selectedLink.strength * 100)}%</span>
                      <span className="re-pill">{selectedLink.createdBy === "ai" ? "AI 召回" : "手动建立"}</span>
                    </div>

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => void openNodeInspector(selectedLink.sourceNodeId)}
                      >
                        源仓：{selectedLink.sourceRepoFullName}
                      </button>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => void openNodeInspector(selectedLink.targetNodeId)}
                      >
                        目标仓：{selectedLink.targetRepoFullName}
                      </button>
                    </div>

                    {selectedLink.rationale && (
                      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#343d36" }}>
                        {selectedLink.rationale}
                      </p>
                    )}

                    {/* 核心操作按钮 */}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4 }}>
                      <button
                        type="button"
                        className="re-primary"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleAnalyzeLink(selectedLink.id)}
                      >
                        {busyAction === "analyze" ? "深度分析中…" : "执行模块级深度分析"}
                      </button>
                      <button
                        type="button"
                        className="re-indigo"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleSubmitToMailbox(selectedLink.id)}
                      >
                        {busyAction === "submit-mailbox" ? "提交中…" : "提交总裁信箱评估"}
                      </button>
                      <button type="button" className="re-mini" onClick={() => setLinkEditing((v) => !v)}>
                        {linkEditing ? "收起编辑" : "编辑边"}
                      </button>
                      <button
                        type="button"
                        className="re-mini re-danger"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleDeleteLink(selectedLink)}
                      >
                        删除边
                      </button>
                    </div>

                    <input
                      type="text"
                      value={mailboxNote}
                      onChange={(e) => setMailboxNote(e.target.value)}
                      placeholder="可选：提交总裁信箱时附带给自己的评审备注…"
                    />
                  </div>

                  {/* 总裁信箱审批闭环状态卡片 */}
                  {selectedLink.decisionPacketId && (
                    <div className="re-mailbox-card">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <strong>📮 已关联总裁信箱评估单</strong>
                        <span className={`re-pill ${selectedLink.status}`}>
                          {selectedLink.decisionStatus || REPO_ABSORPTION_STATUS_LABELS[selectedLink.status]}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, color: "#433969" }}>
                        审批单 ID：<code>{selectedLink.decisionPacketId}</code>（V1 审批后写入图谱与时间线，不自动改代码）
                      </span>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <a
                          className="re-link-btn"
                          href={`#mailbox?decision=${encodeURIComponent(selectedLink.decisionPacketId)}`}
                        >
                          在总裁信箱打开审批单 ↗
                        </a>
                        {selectedLink.status === "approved" && !selectedLink.opportunityId && (
                          <button
                            type="button"
                            className="re-mini re-primary"
                            disabled={Boolean(busyAction)}
                            onClick={() => void handlePromoteOpportunity(selectedLink.id)}
                          >
                            {busyAction === "promote-opp" ? "转换中…" : "手动转为研发选题"}
                          </button>
                        )}
                        {selectedLink.opportunityId && (
                          <a className="re-link-btn" href="#opportunities">
                            已转研发选题 ↗
                          </a>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 内联编辑边表单 */}
                  {linkEditing && (
                    <form className="re-section-box" onSubmit={(e) => void handleSaveLinkEdit(e)}>
                      <h3>编辑吸收边属性</h3>
                      <div className="re-form-grid">
                        <label className="re-field">
                          <span>关系类型</span>
                          <select
                            value={linkEditRelation}
                            onChange={(e) => setLinkEditRelation(e.target.value as RepoRelationType)}
                          >
                            {RELATION_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {REPO_RELATION_LABELS[k]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="re-field">
                          <span>吸收状态</span>
                          <select
                            value={linkEditStatus}
                            onChange={(e) => setLinkEditStatus(e.target.value as RepoAbsorptionStatus)}
                          >
                            {STATUS_KEYS.map((st) => (
                              <option key={st} value={st}>
                                {REPO_ABSORPTION_STATUS_LABELS[st]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className="re-field">
                        <span>吸收强度：{linkEditStrength}%</span>
                        <input
                          type="range"
                          min={5}
                          max={100}
                          value={linkEditStrength}
                          onChange={(e) => setLinkEditStrength(Number(e.target.value))}
                        />
                      </label>
                      <label className="re-field">
                        <span>核心理由</span>
                        <textarea
                          rows={2}
                          value={linkEditRationale}
                          onChange={(e) => setLinkEditRationale(e.target.value)}
                        />
                      </label>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                        <button type="button" className="re-mini" onClick={() => setLinkEditing(false)}>
                          取消
                        </button>
                        <button type="submit" className="re-mini re-primary" disabled={Boolean(busyAction)}>
                          保存修改
                        </button>
                      </div>
                    </form>
                  )}

                  {/* 结构化模块级分析卡片列表 */}
                  <div className="re-section-box">
                    <h3>
                      <span>结构化模块级吸收分析 ({selectedLink.moduleAnalysis.length})</span>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => setAddingModule((v) => !v)}
                      >
                        {addingModule ? "收起" : "+ 手动补充模块"}
                      </button>
                    </h3>
                    {selectedLink.analysisSource && (
                      <div style={{ fontSize: 11.5, color: "#616861" }}>
                        分析来源：
                        {selectedLink.analysisSource === "llm"
                          ? "LLM 深度代码结构对比"
                          : selectedLink.analysisSource === "deterministic"
                            ? "本地确定性结构化分析"
                            : "手动维护"}
                        {selectedLink.analyzedAt ? ` · ${formatTimeFull(selectedLink.analyzedAt)}` : ""}
                      </div>
                    )}

                    {addingModule && (
                      <form
                        onSubmit={(e) => void handleAddManualModule(e)}
                        style={{ display: "flex", flexDirection: "column", gap: 7, padding: 9, background: "#f7f4ea", border: "1px solid #d5d0c3" }}
                      >
                        <input
                          type="text"
                          required
                          value={newModSource}
                          onChange={(e) => setNewModSource(e.target.value)}
                          placeholder="源仓模块路径（如 src/scheduler/queue.ts）"
                        />
                        <input
                          type="text"
                          value={newModTarget}
                          onChange={(e) => setNewModTarget(e.target.value)}
                          placeholder="目标自有仓模块路径（如 packages/core/executor.ts）"
                        />
                        <textarea
                          rows={2}
                          required
                          value={newModMechanism}
                          onChange={(e) => setNewModMechanism(e.target.value)}
                          placeholder="可吸收机制（必填）"
                        />
                        <input
                          type="text"
                          value={newModGap}
                          onChange={(e) => setNewModGap(e.target.value)}
                          placeholder="现状差距"
                        />
                        <input
                          type="text"
                          value={newModPlan}
                          onChange={(e) => setNewModPlan(e.target.value)}
                          placeholder="适配落地建议"
                        />
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <select value={newModEffort} onChange={(e) => setNewModEffort(e.target.value as RepoModuleEffort)}>
                            <option value="S">工作量 S</option>
                            <option value="M">工作量 M</option>
                            <option value="L">工作量 L</option>
                          </select>
                          <select value={newModRisk} onChange={(e) => setNewModRisk(e.target.value as RepoModuleRisk)}>
                            <option value="low">低风险</option>
                            <option value="medium">中风险</option>
                            <option value="high">高风险</option>
                          </select>
                          <button type="submit" className="re-mini re-primary" style={{ marginLeft: "auto" }} disabled={Boolean(busyAction)}>
                            添加模块点
                          </button>
                        </div>
                      </form>
                    )}

                    {selectedLink.moduleAnalysis.length === 0 ? (
                      <div style={{ padding: "12px 10px", background: "#faf7ee", border: "1px dashed #c7c1b2", fontSize: 12.5, color: "#5e645d" }}>
                        尚未生成模块级深度分析。点击上方「执行模块级深度分析」将对比双方文件树与 README，产出具体的源模块 → 目标模块吸收建议与代码证据。
                      </div>
                    ) : (
                      <div className="re-module-list">
                        {selectedLink.moduleAnalysis.map((mod) => (
                          <article key={mod.id} className="re-module-card">
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                              <div className="re-module-path">
                                <span>{mod.sourceModulePath}</span>
                                <span className="re-module-arrow">→</span>
                                <span>{mod.targetModulePath}</span>
                              </div>
                              <button
                                type="button"
                                className="re-ghost re-mini"
                                title="移除该模块点"
                                onClick={() => void handleRemoveModuleItem(mod.id)}
                              >
                                ✕
                              </button>
                            </div>

                            <div className="re-badge-row">
                              <span className="re-pill">工作量 {mod.effort}</span>
                              <span
                                className={`re-pill ${
                                  mod.risk === "high" ? "rejected" : mod.risk === "medium" ? "suggested" : "active"
                                }`}
                              >
                                {mod.risk === "high" ? "高风险" : mod.risk === "medium" ? "中风险" : "低风险"}
                              </span>
                            </div>

                            <p className="re-module-kv">
                              <strong>可吸收机制：</strong>
                              {mod.absorbableMechanism}
                            </p>
                            <p className="re-module-kv">
                              <strong>现状差距：</strong>
                              {mod.currentGap}
                            </p>
                            <p className="re-module-kv">
                              <strong>适配方案：</strong>
                              {mod.adaptationPlan}
                            </p>

                            {mod.evidenceLinks.length > 0 && (
                              <div className="re-evidence-links">
                                {mod.evidenceLinks.map((ev, idx) => {
                                  const href = safeExternalUrl(ev.url);
                                  return href ? (
                                    <a key={`${mod.id}-ev-${idx}`} href={href} target="_blank" rel="noreferrer">
                                      🔗 {ev.label || ev.path || "代码证据"} ↗
                                    </a>
                                  ) : (
                                    <code key={`${mod.id}-ev-${idx}`} style={{ fontSize: 11 }}>
                                      {ev.path || ev.label}
                                    </code>
                                  );
                                })}
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* ================= 模态框 1：设置 ================= */}
      {settingsOpen && (
        <div className="re-modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void saveSettings(e)}>
            <div className="re-modal-head">
              <h2>开源进化图谱设置</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <div className="re-field">
                <span>重点关注仓（Spotlight · 置顶并获得召回加权，默认含 ai-agent-node）</span>
                <div className="re-spotlight-tags">
                  {cfgSpotlight.map((name) => (
                    <span key={name} className="re-spotlight-tag">
                      ★ {name}
                      <button
                        type="button"
                        className="re-ghost re-mini"
                        onClick={() => setCfgSpotlight((list) => list.filter((x) => x !== name))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input
                    type="text"
                    value={cfgNewSpotlight}
                    onChange={(e) => setCfgNewSpotlight(e.target.value)}
                    placeholder="输入仓库名或 owner/repo（如 ai-agent-node）"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const v = cfgNewSpotlight.trim();
                      if (v && !cfgSpotlight.includes(v)) {
                        setCfgSpotlight((list) => [...list, v]);
                      }
                      setCfgNewSpotlight("");
                    }}
                  >
                    + 添加重点仓
                  </button>
                </div>
              </div>

              <div className="re-form-grid">
                <label className="re-field">
                  <span>静默判定阈值（月无推送）</span>
                  <input
                    type="number"
                    min={3}
                    max={48}
                    value={cfgDormantMonths}
                    onChange={(e) => setCfgDormantMonths(Number(e.target.value))}
                  />
                </label>
                <label className="re-field">
                  <span>陈旧沉淀池阈值（月无推送）</span>
                  <input
                    type="number"
                    min={6}
                    max={96}
                    value={cfgStaleMonths}
                    onChange={(e) => setCfgStaleMonths(Number(e.target.value))}
                  />
                </label>
                <label className="re-field">
                  <span>语义聚类最低相似度 (0.1–0.9)</span>
                  <input
                    type="number"
                    step={0.02}
                    min={0.1}
                    max={0.9}
                    value={cfgMinClusterSim}
                    onChange={(e) => setCfgMinClusterSim(Number(e.target.value))}
                  />
                </label>
                <label className="re-field">
                  <span>候选吸收边最低相似度 (0.1–0.9)</span>
                  <input
                    type="number"
                    step={0.02}
                    min={0.1}
                    max={0.9}
                    value={cfgMinLinkSim}
                    onChange={(e) => setCfgMinLinkSim(Number(e.target.value))}
                  />
                </label>
              </div>

              <label className="re-privacy-box">
                <input
                  type="checkbox"
                  checked={cfgAllowPrivateLlm}
                  onChange={(e) => setCfgAllowPrivateLlm(e.target.checked)}
                />
                <span>
                  <strong>私有仓默认允许外部 LLM 分析</strong>
                  <br />
                  建议保持关闭：关闭后私有仓默认只使用本地确定性结构分析，需要时可在单个私有仓检视抽屉按需开启授权。
                </span>
              </label>

              <label className="re-field">
                <span>自动化档位（V1 默认总裁信箱人工拍板留痕，后续档位为平滑演进预留）</span>
                <select
                  value={cfgAutomationMode}
                  onChange={(e) => setCfgAutomationMode(e.target.value as RepoEvolutionAutomationMode)}
                >
                  {(Object.keys(REPO_AUTOMATION_MODE_LABELS) as RepoEvolutionAutomationMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {REPO_AUTOMATION_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button type="submit" className="re-primary" disabled={busyAction === "config"}>
                {busyAction === "config" ? "保存中…" : "保存配置"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================= 模态框 2：新建 / 编辑领域 ================= */}
      {domainModal && (
        <div className="re-modal-backdrop" onClick={() => setDomainModal(null)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleSaveDomain(e)}>
            <div className="re-modal-head">
              <h2>{domainModal.mode === "create" ? "新建技术领域" : `编辑领域：${domainModal.domain?.name}`}</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setDomainModal(null)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <div className="re-form-grid">
                <label className="re-field">
                  <span>领域名称</span>
                  <input
                    type="text"
                    required
                    value={domainModal.name}
                    onChange={(e) => setDomainModal((m) => (m ? { ...m, name: e.target.value } : m))}
                    placeholder="如：AI Agent 运行时与编排"
                  />
                </label>
                <label className="re-field">
                  <span>徽标字符</span>
                  <input
                    type="text"
                    maxLength={4}
                    value={domainModal.icon}
                    onChange={(e) => setDomainModal((m) => (m ? { ...m, icon: e.target.value } : m))}
                    placeholder="◈"
                  />
                </label>
              </div>
              <label className="re-field">
                <span>领域描述</span>
                <textarea
                  rows={2}
                  value={domainModal.description}
                  onChange={(e) => setDomainModal((m) => (m ? { ...m, description: e.target.value } : m))}
                  placeholder="说明该领域涵盖的技术方向，也会参与语义向量聚类…"
                />
              </label>
              <label className="re-field">
                <span>种子关键词（逗号分隔，用于增强 AI 自动聚类）</span>
                <input
                  type="text"
                  value={domainModal.seedKeywords}
                  onChange={(e) => setDomainModal((m) => (m ? { ...m, seedKeywords: e.target.value } : m))}
                  placeholder="agent, mcp, workflow, tool-use, memory"
                />
              </label>
              <div className="re-field">
                <span>领域色标</span>
                <div className="re-swatch-row">
                  {DOMAIN_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="re-swatch"
                      style={{ background: c }}
                      data-current={domainModal.color === c ? "true" : "false"}
                      aria-label={`选择色标 ${c}`}
                      onClick={() => setDomainModal((m) => (m ? { ...m, color: c } : m))}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setDomainModal(null)}>
                取消
              </button>
              <button type="submit" className="re-primary" disabled={busyAction === "domain-save" || !domainModal.name.trim()}>
                {busyAction === "domain-save" ? "保存中…" : "保存领域"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================= 模态框 3：合并领域 ================= */}
      {mergeModal && (
        <div className="re-modal-backdrop" onClick={() => setMergeModal(null)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleMergeDomains(e)}>
            <div className="re-modal-head">
              <h2>合并技术领域</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setMergeModal(null)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <p style={{ margin: 0, fontSize: 13, color: "#4e554e" }}>
                将源领域下的全部仓库（主领域与副领域归属）迁移到目标领域，并移除源领域。
              </p>
              <label className="re-field">
                <span>源领域（将被合并移除）</span>
                <select
                  value={mergeModal.sourceDomainId}
                  onChange={(e) => setMergeModal((m) => (m ? { ...m, sourceDomainId: e.target.value } : m))}
                >
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.totalNodes})
                    </option>
                  ))}
                </select>
              </label>
              <label className="re-field">
                <span>目标领域（保留）</span>
                <select
                  value={mergeModal.targetDomainId}
                  onChange={(e) => setMergeModal((m) => (m ? { ...m, targetDomainId: e.target.value } : m))}
                >
                  {domains
                    .filter((d) => d.id !== mergeModal.sourceDomainId)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.totalNodes})
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setMergeModal(null)}>
                取消
              </button>
              <button
                type="submit"
                className="re-accent"
                disabled={busyAction === "domain-merge" || !mergeModal.targetDomainId || mergeModal.sourceDomainId === mergeModal.targetDomainId}
              >
                {busyAction === "domain-merge" ? "合并中…" : "确认合并"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================= 模态框 4：表格单行 1 对 N 快速关联 ================= */}
      {quickLinkNode && (
        <div className="re-modal-backdrop" onClick={() => setQuickLinkNode(null)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submitQuickLinkModal(e)}>
            <div className="re-modal-head">
              <h2>1 对 N 关联：{quickLinkNode.fullName}</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setQuickLinkNode(null)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <p style={{ margin: 0, fontSize: 12.5, color: "#525952" }}>
                勾选 1 个或多个我的开源库，将该 Star 仓的架构、模块或工作流纳入吸收图谱。
              </p>
              <div className="re-checkbox-list" style={{ maxHeight: 240 }}>
                {ownedRepos.map((owned) => {
                  const checked = quickLinkTargets.has(owned.id);
                  return (
                    <label key={owned.id} className="re-checkbox-item">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setQuickLinkTargets((prev) => {
                            const next = new Set(prev);
                            if (next.has(owned.id)) next.delete(owned.id);
                            else next.add(owned.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        {owned.priorityTier === "spotlight" ? "★ " : ""}
                        {owned.visibility === "private" ? "🔒 " : ""}
                        <strong>{owned.fullName}</strong>
                      </span>
                    </label>
                  );
                })}
              </div>
              <label className="re-field">
                <span>关系类型</span>
                <select
                  value={quickLinkRelation}
                  onChange={(e) => setQuickLinkRelation(e.target.value as RepoRelationType)}
                >
                  {RELATION_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {REPO_RELATION_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="re-field">
                <span>吸收理由（选填）</span>
                <textarea
                  rows={2}
                  value={quickLinkRationale}
                  onChange={(e) => setQuickLinkRationale(e.target.value)}
                  placeholder="说明哪些模块或思路值得对应自有库借鉴…"
                />
              </label>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setQuickLinkNode(null)}>
                取消
              </button>
              <button
                type="submit"
                className="re-primary"
                disabled={busyAction === "quick-link" || quickLinkTargets.size === 0}
              >
                {busyAction === "quick-link" ? "保存中…" : `建立 ${quickLinkTargets.size} 条吸收边`}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
