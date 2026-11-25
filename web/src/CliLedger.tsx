import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  CliLedgerOverview,
  CliLedgerPromoteResult,
  CliProgressStage,
  CliProviderBreakdown,
  CliProviderId,
  CliSessionDetail,
  CliSessionStatus,
  CliSessionSummary,
  CliTurnItem,
} from "../../src/cli-ledger-types";
import {
  WORK_ORIGIN_LABELS,
  WORKSPACE_CATEGORIES,
  WORKSPACE_CATEGORY_LABELS,
  type WorkOriginTrack,
  type WorkspaceCategory,
} from "../../src/workspace-classification-types";
import { request } from "./api";
import { ClassificationBadge, HerdrBadge, OriginTrackBadge } from "./ClassificationBadge";
import "./cli-ledger.css";

type WindowDays = 3 | 7 | 14 | 30;
const priorOverview = new Map<WindowDays, CliLedgerOverview>();
const readingOverview = new Map<WindowDays, Promise<CliLedgerOverview>>();

function readOverview(days: WindowDays, forceRefresh: boolean) {
  const ongoing = readingOverview.get(days);
  if (ongoing && !forceRefresh) return ongoing;
  const pending = request<CliLedgerOverview>(
    `/api/opc/cli-ledger?days=${days}&refresh=${forceRefresh ? 1 : 0}`,
  ).then(data => {
    if (readingOverview.get(days) === pending) priorOverview.set(days, data);
    return data;
  }).finally(() => {
    if (readingOverview.get(days) === pending) readingOverview.delete(days);
  });
  readingOverview.set(days, pending);
  return pending;
}
type ViewMode = "kanban" | "project" | "timeline";
type StatusFilter = "all" | "running" | "waiting_user" | "completed" | "stalled" | "blocked" | "idle";

const WINDOW_OPTIONS: Array<{ days: WindowDays; label: string }> = [
  { days: 3, label: "近 3 天" },
  { days: 7, label: "近 7 天" },
  { days: 14, label: "近 14 天" },
  { days: 30, label: "近 30 天" },
];

const FOUR_STAGES = [
  { key: "received", label: "收到指令" },
  { key: "exploring", label: "调研分析" },
  { key: "implementing", label: "编码改动" },
  { key: "verifying", label: "验证交付" },
] as const;

const STATUS_META: Record<CliSessionStatus, { label: string; icon: string }> = {
  running: { label: "正在执行", icon: "⚡" },
  waiting_user: { label: "等你确认", icon: "💬" },
  completed: { label: "已交付本轮", icon: "✓" },
  blocked: { label: "执行受阻", icon: "⛔" },
  idle: { label: "历史待续", icon: "⏸" },
};

const OUTCOME_STATUS_META: Record<
  CliTurnItem["outcomeStatus"],
  { label: string; toneClass: string }
> = {
  done: { label: "本轮完成", toneClass: "cl-st-completed" },
  in_progress: { label: "执行中", toneClass: "cl-st-running" },
  waiting: { label: "等待确认", toneClass: "cl-st-waiting_user" },
  aborted: { label: "中断 / 受阻", toneClass: "cl-st-blocked" },
};

const KANBAN_COLUMNS: Array<{
  key: "running" | "waiting_user" | "completed" | "stalled";
  title: string;
  colClass: string;
  match: (status: CliSessionStatus) => boolean;
}> = [
  {
    key: "running",
    title: "⚡ 正在执行",
    colClass: "col-running",
    match: (s) => s === "running",
  },
  {
    key: "waiting_user",
    title: "💬 等你确认",
    colClass: "col-waiting",
    match: (s) => s === "waiting_user",
  },
  {
    key: "completed",
    title: "✓ 已交付本轮",
    colClass: "col-completed",
    match: (s) => s === "completed",
  },
  {
    key: "stalled",
    title: "⏸ 受阻与历史待续",
    colClass: "col-stalled",
    match: (s) => s === "blocked" || s === "idle",
  },
];

function providerClassName(providerId: CliProviderId): string {
  switch (providerId) {
    case "codex":
      return "cl-prov-codex";
    case "claude":
      return "cl-prov-claude";
    case "antigravity":
      return "cl-prov-antigravity";
    case "grok":
      return "cl-prov-grok";
    case "cursor":
      return "cl-prov-cursor";
    case "opencode":
      return "cl-prov-opencode";
    default:
      return "cl-prov-other";
  }
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "时间未知";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 45) return "刚刚";
  if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDayBucket(iso: string | null): string {
  if (!iso) return "更早";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "更早";
  const target = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfTarget) / 86400000);
  if (dayDiff === 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (dayDiff === 2) return "前天";
  return target.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function formatDuration(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return "<1 分钟";
  if (mins < 60) return `${Math.round(mins)} 分钟`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function shortFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function computeStageStates(
  stage: CliProgressStage,
  status: CliSessionStatus,
  progressPct: number,
): Array<"done" | "active" | "waiting" | "blocked" | "todo"> {
  if (stage === "delivered" || status === "completed") {
    return ["done", "done", "done", "done"];
  }
  let currentIdx = 0;
  if (stage === "received") currentIdx = 0;
  else if (stage === "exploring") currentIdx = 1;
  else if (stage === "implementing") currentIdx = 2;
  else if (stage === "verifying") currentIdx = 3;
  else {
    // waiting / blocked: infer stage reached from progressPct
    if (progressPct >= 80) currentIdx = 3;
    else if (progressPct >= 50) currentIdx = 2;
    else if (progressPct >= 22) currentIdx = 1;
    else currentIdx = 0;
  }

  const activeState: "active" | "waiting" | "blocked" =
    stage === "blocked" || status === "blocked"
      ? "blocked"
      : stage === "waiting" || status === "waiting_user" || status === "idle"
        ? "waiting"
        : "active";

  return FOUR_STAGES.map((_, idx) => {
    if (idx < currentIdx) return "done";
    if (idx === currentIdx) return activeState;
    return "todo";
  });
}

function buildFallbackHandoff(detail: CliSessionDetail): string {
  const lines = [
    `# CLI 交接上下文：${detail.title || detail.project}`,
    `- CLI: ${detail.provider} (${detail.model ?? "unknown model"})`,
    `- 项目: ${detail.project}${detail.branch ? ` (${detail.branch})` : ""}`,
    detail.workspace ? `- 工作目录: ${detail.workspace}` : "",
    `- 状态: ${STATUS_META[detail.status].label} (${detail.progressPct}%) · ${detail.statusReason}`,
    "",
    "## 首条指令",
    detail.firstInstruction,
    "",
    "## 当前进度",
    detail.latestProgress,
  ].filter(Boolean);
  return lines.join("\n");
}

function StageProgressTrack({
  stage,
  status,
  progressPct,
  statusReason,
}: {
  stage: CliProgressStage;
  status: CliSessionStatus;
  progressPct: number;
  statusReason: string;
}) {
  const states = computeStageStates(stage, status, progressPct);
  const clampedPct = Math.max(0, Math.min(100, Math.round(progressPct)));
  return (
    <div className="cl-stage-block">
      <div className="cl-stage-steps" aria-label={`当前阶段进度 ${clampedPct}%`}>
        {FOUR_STAGES.map((st, idx) => (
          <div key={st.key} className={`cl-stage-step ${states[idx]}`}>
            <div className="cl-stage-seg" />
            <span className="cl-stage-lbl">{st.label}</span>
          </div>
        ))}
      </div>
      <div className="cl-progress-meta">
        <span className="cl-progress-reason" title={statusReason}>
          {statusReason || STATUS_META[status].label}
        </span>
        <span className="cl-progress-pct">{clampedPct}%</span>
      </div>
    </div>
  );
}

function SessionCard({
  session,
  copyingId,
  copiedId,
  onOpen,
  onCopyHandoff,
  onClassified,
}: {
  session: CliSessionSummary;
  copyingId: string | null;
  copiedId: string | null;
  onOpen: (id: string) => void;
  onCopyHandoff: (session: CliSessionSummary) => void;
  onClassified?: () => void;
}) {
  const firstInstr = session.firstInstruction?.trim() || session.title || "（无指令文本）";
  const hasFollowUp =
    session.stats.instructionCount > 1 &&
    Boolean(session.latestInstruction?.trim()) &&
    session.latestInstruction.trim() !== firstInstr;
  const stMeta = STATUS_META[session.status];

  const handleCardClick = (e: MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, a")) return;
    onOpen(session.id);
  };

  return (
    <article
      className={`cl-card st-${session.status}`}
      onClick={handleCardClick}
      aria-label={`${session.provider} · ${session.project} · ${firstInstr.slice(0, 40)}`}
    >
      <div className="cl-card-top">
        <span className={`cl-provider-badge ${providerClassName(session.providerId)}`}>
          <span className="cl-provider-dot" />
          {session.provider}
        </span>
        <OriginTrackBadge track={session.originTrack} />
        <ClassificationBadge classification={session.classification} editable onChanged={onClassified} />
        <span className="cl-project-tag" title={session.workspace || session.project}>
          {session.project}
        </span>
        <HerdrBadge address={session.herdrAddress} spaceName={session.herdrSpace} />
        {session.linkedTaskId && (
          <a
            className="dt-pill dt-linked-task"
            href={`#planning?task=${encodeURIComponent(session.linkedTaskId)}`}
            title={session.linkedTaskTitle || session.linkedTaskId}
          >
            ✓ 已入看板 ↗
          </a>
        )}
        {session.branch && (
          <span className="cl-meta-tag" title={`分支: ${session.branch}`}>
            ⎇ {session.branch}
          </span>
        )}
        {session.model && (
          <span className="cl-meta-tag" title={`模型: ${session.model}`}>
            {session.model}
          </span>
        )}
        <time className="cl-card-time" title={formatDateTime(session.updatedAt ?? session.startedAt)}>
          {formatRelativeTime(session.updatedAt ?? session.startedAt)}
        </time>
      </div>

      <div className="cl-instr-box">
        <div className="cl-instr-head">
          <span>我发的指令</span>
          {session.stats.instructionCount > 1 && (
            <span className="cl-instr-count">共 {session.stats.instructionCount} 条指令</span>
          )}
        </div>
        <p className="cl-instr-first" title={firstInstr}>
          {firstInstr}
        </p>
        {hasFollowUp && (
          <p className="cl-instr-latest" title={session.latestInstruction}>
            <b>最新追问：</b>
            {session.latestInstruction}
          </p>
        )}
      </div>

      <StageProgressTrack
        stage={session.progressStage}
        status={session.status}
        progressPct={session.progressPct}
        statusReason={session.statusReason}
      />

      <div className="cl-outcome-box">
        <div className="cl-outcome-head">
          <span>当前干到哪了</span>
          <span className={`cl-status-pill cl-st-${session.status}`}>
            {stMeta.icon} {stMeta.label}
          </span>
        </div>
        <p className="cl-outcome-text" title={session.latestProgress}>
          {session.latestProgress || session.statusReason || "等待输出进展…"}
        </p>
        <div className="cl-stat-chips">
          <span className={`cl-chip ${session.stats.filesModifiedCount > 0 ? "accent" : ""}`}>
            改动 {session.stats.filesModifiedCount} 文件
          </span>
          <span className="cl-chip">工具 {session.stats.totalToolCalls} 次</span>
          {session.durationMins > 0 && (
            <span className="cl-chip">{formatDuration(session.durationMins)}</span>
          )}
        </div>
      </div>

      <div className="cl-card-actions">
        <button
          type="button"
          className="cl-btn-link"
          onClick={() => onOpen(session.id)}
        >
          查看全过程时间线 →
        </button>
        <button
          type="button"
          className="cl-btn-ghost"
          disabled={copyingId === session.id}
          onClick={() => onCopyHandoff(session)}
        >
          {copyingId === session.id
            ? "读取中…"
            : copiedId === session.id
              ? "已复制 ✓"
              : "复制交接"}
        </button>
      </div>
    </article>
  );
}

function TurnStepCard({
  turn,
  forceExpandThinking,
}: {
  turn: CliTurnItem;
  forceExpandThinking: boolean;
}) {
  const [expandedUser, setExpandedUser] = useState(false);
  const [expandedOutcome, setExpandedOutcome] = useState(false);
  const [showThinking, setShowThinking] = useState(false);

  useEffect(() => {
    setShowThinking(forceExpandThinking);
  }, [forceExpandThinking]);

  const userLong = turn.userInstruction.length > 240;
  const userText =
    userLong && !expandedUser
      ? `${turn.userInstruction.slice(0, 240)}…`
      : turn.userInstruction;

  const outcomeRaw = turn.agentOutcome?.trim() ?? "";
  const outcomeLong = outcomeRaw.length > 480;
  const outcomeText =
    outcomeLong && !expandedOutcome ? `${outcomeRaw.slice(0, 480)}…` : outcomeRaw;

  const outcomeMeta = OUTCOME_STATUS_META[turn.outcomeStatus];
  const hasExec =
    turn.toolsUsed.length > 0 || turn.filesTouched.length > 0 || turn.commandsRun > 0;

  return (
    <div className={`cl-turn-node st-${turn.outcomeStatus}`}>
      <span className="cl-turn-badge-num" aria-hidden="true">
        {turn.index}
      </span>

      <div className="cl-turn-head">
        <span className="cl-turn-title">
          第 {turn.index} 轮
          {turn.at && <span className="cl-turn-time">{formatDateTime(turn.at)}</span>}
        </span>
        <span className={`cl-status-pill ${outcomeMeta.toneClass}`}>{outcomeMeta.label}</span>
      </div>

      {/* User Instruction */}
      <div className="cl-turn-block cl-turn-block-user">
        <div className="cl-turn-block-lbl">
          <span>🧑 我发的指令</span>
          {userLong && (
            <button
              type="button"
              className="cl-btn-link"
              onClick={() => setExpandedUser((v) => !v)}
            >
              {expandedUser ? "收起" : `展开全文 (${turn.userInstruction.length} 字)`}
            </button>
          )}
        </div>
        <p className="cl-turn-text">{userText || "（继续上一轮指令）"}</p>
      </div>

      {/* Thinking Summary */}
      {turn.thinkingSummary && (
        <div className="cl-turn-block cl-turn-block-think">
          <div className="cl-turn-block-lbl">
            <span>🧠 思路摘要</span>
            <button
              type="button"
              className="cl-btn-link"
              aria-expanded={showThinking}
              onClick={() => setShowThinking((v) => !v)}
            >
              {showThinking ? "收起思路" : "展开思路"}
            </button>
          </div>
          {showThinking && <p className="cl-turn-text">{turn.thinkingSummary}</p>}
        </div>
      )}

      {/* Execution Tools & Files */}
      {hasExec && (
        <div className="cl-turn-block cl-turn-block-exec">
          <div className="cl-turn-block-lbl">
            <span>🛠 执行过程</span>
            <span className="cl-turn-time">
              {turn.toolsUsed.reduce((sum, t) => sum + t.count, 0)} 次工具调用
              {turn.commandsRun > 0 ? ` · ${turn.commandsRun} 次命令` : ""}
              {turn.filesTouched.length > 0 ? ` · ${turn.filesTouched.length} 文件` : ""}
            </span>
          </div>
          {turn.toolsUsed.length > 0 && (
            <div className="cl-tool-chips">
              {turn.toolsUsed.map((tool) => (
                <span key={tool.name} className="cl-tool-chip">
                  {tool.name} ×{tool.count}
                </span>
              ))}
            </div>
          )}
          {turn.filesTouched.length > 0 && (
            <div className="cl-tool-chips">
              {turn.filesTouched.map((fp) => (
                <span key={fp} className="cl-file-chip" title={fp}>
                  📄 {shortFileName(fp)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Agent Outcome */}
      <div className="cl-turn-block cl-turn-block-outcome">
        <div className="cl-turn-block-lbl">
          <span>🤖 本轮进度与产出</span>
          {outcomeLong && (
            <button
              type="button"
              className="cl-btn-link"
              onClick={() => setExpandedOutcome((v) => !v)}
            >
              {expandedOutcome ? "收起" : "展开完整产出"}
            </button>
          )}
        </div>
        <p className="cl-turn-text">
          {outcomeText ||
            (turn.outcomeStatus === "in_progress"
              ? "本轮仍在执行中，尚未产出最终答复。"
              : "本轮无文字总结输出。")}
        </p>
      </div>
    </div>
  );
}

export function CliLedger({
  nav,
  initialSessionId,
  initialProvider,
  initialProject,
}: {
  nav?: ReactNode;
  initialSessionId?: string;
  initialProvider?: string;
  initialProject?: string;
}) {
  const [windowDays, setWindowDays] = useState<WindowDays>(14);
  const [overview, setOverview] = useState<CliLedgerOverview | null>(() => priorOverview.get(14) ?? null);
  const [loading, setLoading] = useState(() => !priorOverview.has(14));
  const overviewRequest = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  // Filters & View Mode
  const [viewMode, setViewMode] = useState<ViewMode>("kanban");
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>(initialProvider ?? "");
  const [projectFilter, setProjectFilter] = useState<string>(initialProject ?? "");
  const [categoryFilter, setCategoryFilter] = useState<WorkspaceCategory | "">("");
  const [originFilter, setOriginFilter] = useState<WorkOriginTrack | "">("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [bindableTasks, setBindableTasks] = useState<Array<{ id: string; title: string; project: string; status: string }>>([]);
  const [bindTargetTaskId, setBindTargetTaskId] = useState("");
  const [bindingId, setBindingId] = useState<string | null>(null);

  // Detail Drawer state
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const [detail, setDetail] = useState<CliSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [expandAllThinking, setExpandAllThinking] = useState(false);

  // Actions state
  const detailCacheRef = useRef<Map<string, CliSessionDetail>>(new Map());
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promotedMap, setPromotedMap] = useState<Record<string, CliLedgerPromoteResult>>({});
  const [toast, setToast] = useState<{ text: string; href?: string; linkLabel?: string } | null>(
    null,
  );
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((text: string, href?: string, linkLabel?: string) => {
    setToast({ text, href, linkLabel });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Sync external route params when navigating with hash query changes
  useEffect(() => {
    if (initialProvider !== undefined) setProviderFilter(initialProvider);
  }, [initialProvider]);

  useEffect(() => {
    if (initialProject !== undefined) setProjectFilter(initialProject);
  }, [initialProject]);

  useEffect(() => {
    if (initialSessionId) setSelectedSessionId(initialSessionId);
  }, [initialSessionId]);

  const loadOverview = useCallback(async (days: WindowDays, forceRefresh: boolean) => {
    const current = ++overviewRequest.current;
    const previous = priorOverview.get(days) ?? null;
    setOverview(previous);
    setLoading(!previous);
    setRefreshing(forceRefresh || !!previous);
    if (forceRefresh) detailCacheRef.current.clear();
    setError("");
    try {
      const data = await readOverview(days, forceRefresh);
      if (current === overviewRequest.current) setOverview(data);
    } catch (err) {
      if (current === overviewRequest.current) setError(err instanceof Error ? err.message : "加载 CLI 指令台账失败");
    } finally {
      if (current === overviewRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadOverview(windowDays, false);
    return () => { overviewRequest.current++; };
  }, [loadOverview, windowDays]);

  const fetchSessionDetail = useCallback(
    async (id: string, bypassCache = false): Promise<CliSessionDetail> => {
      if (!bypassCache) {
        const cached = detailCacheRef.current.get(id);
        if (cached) return cached;
      }
      const data = await request<CliSessionDetail>(
        `/api/opc/cli-ledger/${encodeURIComponent(id)}`,
      );
      detailCacheRef.current.set(id, data);
      return data;
    },
    [],
  );

  // Load selected session detail when drawer opens
  useEffect(() => {
    if (!selectedSessionId) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailError("");
    const cached = detailCacheRef.current.get(selectedSessionId);
    if (cached) {
      setDetail(cached);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    void fetchSessionDetail(selectedSessionId)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetailError(err instanceof Error ? err.message : "读取会话过程时间线失败");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchSessionDetail, selectedSessionId]);

  // Close drawer on Escape
  useEffect(() => {
    if (!selectedSessionId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedSessionId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedSessionId]);

  // Quick copy handoff from card or drawer
  const handleCopyHandoff = useCallback(
    async (sessionOrDetail: CliSessionSummary | CliSessionDetail) => {
      setCopyingId(sessionOrDetail.id);
      try {
        const full =
          "handoffMarkdown" in sessionOrDetail
            ? sessionOrDetail
            : await fetchSessionDetail(sessionOrDetail.id);
        const md = full.handoffMarkdown?.trim() || buildFallbackHandoff(full);
        const ok = await copyText(md);
        if (ok) {
          setCopiedId(sessionOrDetail.id);
          showToast(`已复制「${full.project} · ${full.provider}」跨 CLI 交接上下文`);
          window.setTimeout(() => {
            setCopiedId((cur) => (cur === sessionOrDetail.id ? null : cur));
          }, 2200);
        } else {
          showToast("复制失败，请检查浏览器剪贴板权限");
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "读取交接上下文失败");
      } finally {
        setCopyingId(null);
      }
    },
    [fetchSessionDetail, showToast],
  );

  const handlePromoteTask = useCallback(
    async (id: string) => {
      setPromotingId(id);
      try {
        const res = await request<CliLedgerPromoteResult>(
          `/api/opc/cli-ledger/${encodeURIComponent(id)}/promote-task`,
          { method: "POST", body: "{}" },
        );
        setPromotedMap((prev) => ({ ...prev, [id]: res }));
        showToast(
          res.alreadyLinked
            ? `已同步到现有看板任务：「${res.title}」`
            : `已收入 OPC 任务看板并开启持续同步：「${res.title}」`,
          res.href || "#planning",
          "打开任务看板 ↗",
        );
        void loadOverview(windowDays, true);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "收入任务看板失败");
      } finally {
        setPromotingId(null);
      }
    },
    [loadOverview, showToast, windowDays],
  );

  const handleBindTask = useCallback(
    async (id: string, taskId: string) => {
      if (!taskId) return;
      setBindingId(id);
      try {
        const res = await request<CliLedgerPromoteResult>(
          `/api/opc/cli-ledger/${encodeURIComponent(id)}/bind-task`,
          { method: "POST", body: JSON.stringify({ taskId }) },
        );
        setPromotedMap((prev) => ({ ...prev, [id]: res }));
        setBindTargetTaskId("");
        showToast(
          `已绑定至看板任务「${res.title}」（后续进展自动同步）`,
          res.href || "#planning",
          "查看任务 ↗",
        );
        void loadOverview(windowDays, true);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "绑定任务失败");
      } finally {
        setBindingId(null);
      }
    },
    [loadOverview, showToast, windowDays],
  );

  // Lazy load open planning tasks when session drawer opens so user can bind to an existing card
  useEffect(() => {
    if (!selectedSessionId) return;
    request<{ tasks: Array<{ id: string; title: string; project: string; status: string }> }>(
      "/api/opc/planning/tasks?includeSubtasks=1",
    )
      .then((res) => {
        const active = (res.tasks ?? []).filter(
          (t) => t.status !== "done" && t.status !== "published" && t.status !== "archived",
        );
        setBindableTasks(active.slice(0, 60));
      })
      .catch(() => {});
  }, [selectedSessionId]);

  const handleCopyPath = useCallback(
    async (pathStr: string, label = "工作目录路径") => {
      const ok = await copyText(pathStr);
      showToast(ok ? `已复制${label}：${pathStr}` : `复制${label}失败`);
    },
    [showToast],
  );

  // Derived provider breakdown sorted by sessions desc
  const sortedProviders = useMemo<CliProviderBreakdown[]>(() => {
    if (!overview) return [];
    return [...overview.byProvider].sort((a, b) => b.sessions - a.sessions);
  }, [overview]);

  const maxProviderSessions = useMemo(() => {
    return Math.max(1, ...sortedProviders.map((p) => p.sessions));
  }, [sortedProviders]);

  const activeProviderLabel = useMemo(() => {
    if (!providerFilter) return "";
    const low = providerFilter.toLowerCase();
    const hit = sortedProviders.find(
      (p) => p.providerId.toLowerCase() === low || p.provider.toLowerCase() === low,
    );
    return hit ? hit.provider : providerFilter;
  }, [providerFilter, sortedProviders]);

  // Filtered sessions
  const filteredSessions = useMemo<CliSessionSummary[]>(() => {
    if (!overview) return [];
    const q = search.trim().toLowerCase();
    const provLow = providerFilter.trim().toLowerCase();
    const projLow = projectFilter.trim().toLowerCase();

    return overview.sessions.filter((s) => {
      if (provLow) {
        const matchProv =
          s.providerId.toLowerCase() === provLow || s.provider.toLowerCase() === provLow;
        if (!matchProv) return false;
      }
      if (projLow && s.project.toLowerCase() !== projLow) {
        return false;
      }
      if (categoryFilter && (s.classification?.category ?? "personal") !== categoryFilter) {
        return false;
      }
      if (originFilter && (s.originTrack ?? "founder_managed") !== originFilter) {
        return false;
      }
      if (statusFilter !== "all") {
        if (statusFilter === "stalled") {
          if (s.status !== "blocked" && s.status !== "idle") return false;
        } else if (s.status !== statusFilter) {
          return false;
        }
      }
      if (q) {
        const haystack = [
          s.title,
          s.firstInstruction,
          s.latestInstruction,
          s.latestProgress,
          s.statusReason,
          s.project,
          s.repository ?? "",
          s.branch ?? "",
          s.model ?? "",
          s.provider,
          ...s.stats.filesTouched,
          ...s.recentTurnsPreview.map((t) => `${t.instruction} ${t.outcome ?? ""}`),
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [overview, projectFilter, providerFilter, categoryFilter, originFilter, search, statusFilter]);

  const hasActiveFilters = Boolean(
    search.trim() || providerFilter || projectFilter || categoryFilter || originFilter || statusFilter !== "all",
  );

  const resetFilters = () => {
    setSearch("");
    setProviderFilter("");
    setProjectFilter("");
    setCategoryFilter("");
    setOriginFilter("");
    setStatusFilter("all");
  };

  // Swimlane grouping by project
  const projectGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        project: string;
        workspace: string | null;
        sessions: CliSessionSummary[];
        instructions: number;
        filesModified: number;
        providers: Map<CliProviderId, string>;
        running: number;
        waiting: number;
        completed: number;
        latestTs: number;
      }
    >();

    for (const s of filteredSessions) {
      const key = s.project || "未归类项目";
      let grp = map.get(key);
      if (!grp) {
        grp = {
          project: key,
          workspace: s.workspace,
          sessions: [],
          instructions: 0,
          filesModified: 0,
          providers: new Map(),
          running: 0,
          waiting: 0,
          completed: 0,
          latestTs: 0,
        };
        map.set(key, grp);
      }
      grp.sessions.push(s);
      grp.instructions += s.stats.instructionCount;
      grp.filesModified += s.stats.filesModifiedCount;
      grp.providers.set(s.providerId, s.provider);
      if (s.status === "running") grp.running += 1;
      else if (s.status === "waiting_user") grp.waiting += 1;
      else if (s.status === "completed") grp.completed += 1;
      const ts = Date.parse(s.updatedAt ?? s.startedAt ?? "") || 0;
      if (ts > grp.latestTs) grp.latestTs = ts;
      if (!grp.workspace && s.workspace) grp.workspace = s.workspace;
    }

    return [...map.values()].sort((a, b) => b.latestTs - a.latestTs);
  }, [filteredSessions]);

  // Timeline grouping by date bucket
  const timelineGroups = useMemo(() => {
    const sorted = [...filteredSessions].sort((a, b) => {
      const ta = Date.parse(a.updatedAt ?? a.startedAt ?? "") || 0;
      const tb = Date.parse(b.updatedAt ?? b.startedAt ?? "") || 0;
      return tb - ta;
    });
    const buckets: Array<{ label: string; items: CliSessionSummary[] }> = [];
    for (const item of sorted) {
      const label = formatDayBucket(item.updatedAt ?? item.startedAt);
      const last = buckets[buckets.length - 1];
      if (last && last.label === label) {
        last.items.push(item);
      } else {
        buckets.push({ label, items: [item] });
      }
    }
    return buckets;
  }, [filteredSessions]);

  // Summary fallback for drawer header while detail loads
  const selectedSummary = useMemo(() => {
    if (!selectedSessionId || !overview) return null;
    return overview.sessions.find((s) => s.id === selectedSessionId) ?? null;
  }, [overview, selectedSessionId]);

  const activeDrawerSession = detail ?? selectedSummary;
  const promotedInfo = selectedSessionId ? promotedMap[selectedSessionId] : undefined;

  const toggleStatusFilter = (target: StatusFilter) => {
    setStatusFilter((prev) => (prev === target ? "all" : target));
  };

  return (
    <section className="zo-product cl-page" aria-label="CLI 指令台账与进度追踪">
      {/* ---- 1. Header & Controls ---- */}
      <header className="cl-head">
        <div className="cl-head-left">
          <div className="cl-title-row">
            {nav}
            <h1>CLI 指令台账与进度追踪</h1>
          </div>
          <p className="cl-sub">
            跨 Codex / Claude Code / Antigravity / Grok / Cursor / OpenCode 统一梳理：我发了什么指令、他干了什么、干到哪一步
          </p>
          <div className="cl-quick-links">
            <a href="#company-architecture?tab=story">查看 OPC OS 运作全景 ↗</a>
            <a href="#planning">任务看板 ↗</a>
            {overview && (
              <span className="cl-scan-stamp">
                最近扫描 {formatDateTime(overview.generatedAt)} · 近 {overview.windowDays} 天
              </span>
            )}
          </div>
        </div>

        <div className="cl-head-actions">
          <div className="cl-window-group" role="group" aria-label="时间窗口">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                aria-pressed={windowDays === opt.days}
                disabled={loading || refreshing}
                onClick={() => setWindowDays(opt.days)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="cl-btn-primary"
            disabled={loading || refreshing}
            onClick={() => void loadOverview(windowDays, true)}
          >
            {refreshing ? "更新中…" : "↻ 强制刷新"}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="cl-banner cl-banner-error">
          <span>加载失败：{error}</span>
          <button
            type="button"
            className="cl-btn-rust"
            onClick={() => void loadOverview(windowDays, true)}
          >
            重试加载
          </button>
        </div>
      )}

      {/* ---- 2. KPI Summary Strip ---- */}
      {overview && (
        <section className="cl-kpi-strip" aria-label="核心进度指标筛选">
          <button
            type="button"
            className={`cl-kpi-chip tone-ink ${statusFilter === "all" ? "active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            <span className="cl-kpi-label">全部会话任务</span>
            <span className="cl-kpi-val">{overview.totals.sessions}</span>
            <span className="cl-kpi-hint">
              跨 {overview.byProvider.length} CLI · {overview.byProject.length} 项目
              {overview.byOrigin && ` · ⚙${overview.byOrigin.opcDispatched} / 👤${overview.byOrigin.founderManaged}`}
            </span>
          </button>

          <button
            type="button"
            className="cl-kpi-chip tone-muted"
            onClick={() => setStatusFilter("all")}
          >
            <span className="cl-kpi-label">累计下达指令</span>
            <span className="cl-kpi-val">{overview.totals.instructions}</span>
            <span className="cl-kpi-hint">
              均值{" "}
              {overview.totals.sessions > 0
                ? (overview.totals.instructions / overview.totals.sessions).toFixed(1)
                : "0"}{" "}
              条/会话
            </span>
          </button>

          <button
            type="button"
            className={`cl-kpi-chip tone-running ${statusFilter === "running" ? "active" : ""}`}
            onClick={() => toggleStatusFilter("running")}
          >
            <span className="cl-kpi-label">
              {overview.totals.running > 0 && <span className="cl-live-dot" aria-hidden="true" />}
              正在执行
            </span>
            <span className="cl-kpi-val">{overview.totals.running}</span>
            <span className="cl-kpi-hint">点击筛选执行中</span>
          </button>

          <button
            type="button"
            className={`cl-kpi-chip tone-waiting ${statusFilter === "waiting_user" ? "active" : ""}`}
            onClick={() => toggleStatusFilter("waiting_user")}
          >
            <span className="cl-kpi-label">💬 等你确认</span>
            <span className="cl-kpi-val">{overview.totals.waitingUser}</span>
            <span className="cl-kpi-hint">待你拍板或追问</span>
          </button>

          <button
            type="button"
            className={`cl-kpi-chip tone-completed ${statusFilter === "completed" ? "active" : ""}`}
            onClick={() => toggleStatusFilter("completed")}
          >
            <span className="cl-kpi-label">✓ 已交付本轮</span>
            <span className="cl-kpi-val">{overview.totals.completed}</span>
            <span className="cl-kpi-hint">已完成答复/修改</span>
          </button>

          <button
            type="button"
            className={`cl-kpi-chip tone-stalled ${statusFilter === "stalled" ? "active" : ""}`}
            onClick={() => toggleStatusFilter("stalled")}
          >
            <span className="cl-kpi-label">⏸ 受阻 / 待续</span>
            <span className="cl-kpi-val">{overview.totals.blocked + overview.totals.idle}</span>
            <span className="cl-kpi-hint">
              受阻 {overview.totals.blocked} · 待续 {overview.totals.idle}
            </span>
          </button>

          <button
            type="button"
            className="cl-kpi-chip tone-muted"
            onClick={() => setViewMode("project")}
          >
            <span className="cl-kpi-label">累计改动文件</span>
            <span className="cl-kpi-val">{overview.totals.filesModified}</span>
            <span className="cl-kpi-hint">工具调用 {overview.totals.toolCalls} 次</span>
          </button>
        </section>
      )}

      {/* ---- 3. Visual Cross-CLI Comparison Chart ---- */}
      {overview && sortedProviders.length > 0 && (
        <section className="cl-chart-card" aria-label="各 CLI 任务与进度分布">
          <div className="cl-chart-head">
            <div className="cl-chart-title-wrap">
              <h2>各 CLI 任务与进度分布</h2>
              <span className="cl-chart-sub">点击任意 CLI 条形可筛选下方会话</span>
              {providerFilter && (
                <span className="cl-active-filter-pill">
                  已筛选：{activeProviderLabel}
                  <button
                    type="button"
                    aria-label="清除 CLI 筛选"
                    onClick={() => setProviderFilter("")}
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
            <div className="cl-chart-legend" aria-label="状态图例">
              <span className="cl-legend-item">
                <span className="cl-legend-dot completed" />
                已交付
              </span>
              <span className="cl-legend-item">
                <span className="cl-legend-dot running" />
                执行中
              </span>
              <span className="cl-legend-item">
                <span className="cl-legend-dot waiting" />
                等你确认
              </span>
              <span className="cl-legend-item">
                <span className="cl-legend-dot blocked" />
                受阻
              </span>
              <span className="cl-legend-item">
                <span className="cl-legend-dot idle" />
                待续
              </span>
            </div>
          </div>

          <div className="cl-bar-list">
            {sortedProviders.map((prov) => {
              const idleCount = Math.max(
                0,
                prov.sessions - prov.completed - prov.running - prov.waitingUser - prov.blocked,
              );
              const totalWidthPct = Math.max(6, (prov.sessions / maxProviderSessions) * 100);
              const denom = Math.max(1, prov.sessions);
              const isSelected =
                providerFilter.toLowerCase() === prov.providerId.toLowerCase() ||
                providerFilter.toLowerCase() === prov.provider.toLowerCase();
              const isDimmed = Boolean(providerFilter) && !isSelected;

              return (
                <button
                  key={prov.providerId}
                  type="button"
                  className={`cl-bar-row ${isSelected ? "is-active" : ""} ${isDimmed ? "is-dimmed" : ""}`}
                  aria-pressed={isSelected}
                  onClick={() =>
                    setProviderFilter((cur) =>
                      cur.toLowerCase() === prov.providerId.toLowerCase() ? "" : prov.providerId,
                    )
                  }
                >
                  <div className="cl-bar-provider">
                    <span className={`cl-provider-badge ${providerClassName(prov.providerId)}`}>
                      <span className="cl-provider-dot" />
                      {prov.provider}
                    </span>
                    <span className="cl-bar-count">{prov.sessions} 会话</span>
                  </div>

                  <div className="cl-bar-track-wrap">
                    <div
                      className="cl-bar-track"
                      title={`${prov.provider}：共 ${prov.sessions} 会话（已交付 ${prov.completed} · 执行中 ${prov.running} · 等你确认 ${prov.waitingUser} · 受阻 ${prov.blocked} · 待续 ${idleCount}）`}
                    >
                      <div className="cl-bar-fill" style={{ width: `${totalWidthPct}%` }}>
                        {prov.completed > 0 && (
                          <div
                            className="cl-seg completed"
                            style={{ width: `${(prov.completed / denom) * 100}%` }}
                            title={`已交付：${prov.completed}`}
                          />
                        )}
                        {prov.running > 0 && (
                          <div
                            className="cl-seg running"
                            style={{ width: `${(prov.running / denom) * 100}%` }}
                            title={`执行中：${prov.running}`}
                          />
                        )}
                        {prov.waitingUser > 0 && (
                          <div
                            className="cl-seg waiting"
                            style={{ width: `${(prov.waitingUser / denom) * 100}%` }}
                            title={`等你确认：${prov.waitingUser}`}
                          />
                        )}
                        {prov.blocked > 0 && (
                          <div
                            className="cl-seg blocked"
                            style={{ width: `${(prov.blocked / denom) * 100}%` }}
                            title={`受阻：${prov.blocked}`}
                          />
                        )}
                        {idleCount > 0 && (
                          <div
                            className="cl-seg idle"
                            style={{ width: `${(idleCount / denom) * 100}%` }}
                            title={`待续：${idleCount}`}
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="cl-bar-metrics">
                    <span>
                      指令 <b>{prov.instructions}</b>
                    </span>
                    <span>
                      工具 <b>{prov.toolCalls}</b>
                    </span>
                    <span>
                      改文件 <b>{prov.filesModified}</b>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ---- 4. Filter Bar & 3 View Modes ---- */}
      <div className="cl-toolbar">
        <div className="cl-filters">
          <div className="cl-search-wrap">
            <input
              type="search"
              aria-label="搜索指令内容、项目、进度结论、文件名"
              placeholder="搜指令内容、项目、进度结论、文件名…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="cl-search-clear"
                aria-label="清空搜索"
                onClick={() => setSearch("")}
              >
                ✕
              </button>
            )}
          </div>

          <select
            aria-label="按归属分类筛选"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as WorkspaceCategory | "")}
          >
            <option value="">全部分类</option>
            {WORKSPACE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {WORKSPACE_CATEGORY_LABELS[cat]}
              </option>
            ))}
          </select>

          <select
            aria-label="按来源轨道筛选"
            value={originFilter}
            onChange={(e) => setOriginFilter(e.target.value as WorkOriginTrack | "")}
          >
            <option value="">双轨全部</option>
            <option value="opc_dispatched">⚙ {WORK_ORIGIN_LABELS.opc_dispatched}</option>
            <option value="founder_managed">👤 {WORK_ORIGIN_LABELS.founder_managed}</option>
          </select>

          <select
            aria-label="按项目筛选"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">
              全部项目 ({overview?.byProject.length ?? 0})
            </option>
            {(overview?.byProject ?? []).map((proj) => (
              <option key={proj.project} value={proj.project}>
                {proj.project} ({proj.sessions})
              </option>
            ))}
          </select>

          <select
            aria-label="按进度状态筛选"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">全部状态</option>
            <option value="running">⚡ 正在执行</option>
            <option value="waiting_user">💬 等你确认</option>
            <option value="completed">✓ 已交付本轮</option>
            <option value="stalled">⏸ 受阻与历史待续</option>
            <option value="blocked">⛔ 仅执行受阻</option>
            <option value="idle">💤 仅历史待续</option>
          </select>

          {overview && (
            <span className="cl-filter-count">
              显示 {filteredSessions.length} / {overview.sessions.length} 条
            </span>
          )}

          {hasActiveFilters && (
            <button type="button" className="cl-btn-ghost" onClick={resetFilters}>
              重置筛选
            </button>
          )}
        </div>

        <div className="cl-view-switch" role="tablist" aria-label="台账展示视图">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "kanban"}
            onClick={() => setViewMode("kanban")}
          >
            进度看板
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "project"}
            onClick={() => setViewMode("project")}
          >
            按项目分组
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "timeline"}
            onClick={() => setViewMode("timeline")}
          >
            时间线列表
          </button>
        </div>
      </div>

      {/* ---- Main Content Area ---- */}
      {loading && !overview ? (
        <div className="cl-skeleton-grid" aria-busy="true" aria-label="正在加载 CLI 指令台账">
          <div className="cl-skeleton-card" />
          <div className="cl-skeleton-card" />
          <div className="cl-skeleton-card" />
          <div className="cl-skeleton-card" />
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="cl-empty-box">
          <h3>{hasActiveFilters ? "没有符合当前筛选条件的 CLI 会话" : "当前时间窗口内暂无 CLI 会话记录"}</h3>
          <p>
            {hasActiveFilters
              ? "可以清空关键词、切换项目/CLI，或扩大右上角时间窗口试试。"
              : "尝试切换到「近 14 天」或「近 30 天」，或点击「强制刷新」重新扫描本机各 CLI 会话目录。"}
          </p>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
            {hasActiveFilters && (
              <button type="button" className="cl-btn-primary" onClick={resetFilters}>
                清除全部筛选
              </button>
            )}
            {windowDays < 30 && (
              <button type="button" onClick={() => setWindowDays(30)}>
                扩大到近 30 天
              </button>
            )}
          </div>
        </div>
      ) : viewMode === "kanban" ? (
        /* ---- View Mode 1: Kanban by Status ---- */
        <div className="cl-kanban" aria-label="进度状态看板">
          {KANBAN_COLUMNS.map((col) => {
            const colItems = filteredSessions.filter((s) => col.match(s.status));
            return (
              <section key={col.key} className={`cl-col ${col.colClass}`} aria-label={col.title}>
                <header className="cl-col-head">
                  <span className="cl-col-title">{col.title}</span>
                  <span className="cl-col-count">{colItems.length}</span>
                </header>
                <div className="cl-col-body">
                  {colItems.length === 0 ? (
                    <div className="cl-col-empty">暂无此状态的会话</div>
                  ) : (
                    colItems.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        copyingId={copyingId}
                        copiedId={copiedId}
                        onOpen={setSelectedSessionId}
                        onCopyHandoff={(s) => void handleCopyHandoff(s)}
                        onClassified={() => void loadOverview(windowDays, true)}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : viewMode === "project" ? (
        /* ---- View Mode 2: Project Swimlanes ---- */
        <div className="cl-swimlanes" aria-label="按项目分组视图">
          {projectGroups.map((group) => (
            <section key={group.project} className="cl-swimlane" aria-label={`项目 ${group.project}`}>
              <header className="cl-swimlane-head">
                <div className="cl-swimlane-title-wrap">
                  <h3>📁 {group.project}</h3>
                  {Array.from(group.providers.entries()).map(([pid, label]) => (
                    <span key={pid} className={`cl-provider-badge ${providerClassName(pid)}`}>
                      <span className="cl-provider-dot" />
                      {label}
                    </span>
                  ))}
                  {group.workspace && (
                    <span className="cl-swimlane-path" title={group.workspace}>
                      {group.workspace}
                    </span>
                  )}
                </div>
                <div className="cl-swimlane-meta">
                  <span className="cl-chip">{group.sessions.length} 会话</span>
                  <span className="cl-chip">{group.instructions} 指令</span>
                  <span className="cl-chip accent">改 {group.filesModified} 文件</span>
                  {group.running > 0 && (
                    <span className="cl-status-pill cl-st-running">⚡ {group.running}</span>
                  )}
                  {group.waiting > 0 && (
                    <span className="cl-status-pill cl-st-waiting_user">💬 {group.waiting}</span>
                  )}
                  {group.completed > 0 && (
                    <span className="cl-status-pill cl-st-completed">✓ {group.completed}</span>
                  )}
                </div>
              </header>
              <div className="cl-swimlane-grid">
                {group.sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    copyingId={copyingId}
                    copiedId={copiedId}
                    onOpen={setSelectedSessionId}
                    onCopyHandoff={(s) => void handleCopyHandoff(s)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        /* ---- View Mode 3: Chronological Timeline Feed ---- */
        <div className="cl-feed" aria-label="时间线列表视图">
          {timelineGroups.map((bucket) => (
            <section key={bucket.label} className="cl-feed-group">
              <div className="cl-feed-day">
                <span>{bucket.label}</span>
                <span className="cl-col-count">{bucket.items.length}</span>
              </div>
              {bucket.items.map((session) => {
                const firstInstr = session.firstInstruction?.trim() || session.title || "（无指令文本）";
                const hasFollowUp =
                  session.stats.instructionCount > 1 &&
                  Boolean(session.latestInstruction?.trim()) &&
                  session.latestInstruction.trim() !== firstInstr;
                const stMeta = STATUS_META[session.status];

                return (
                  <article
                    key={session.id}
                    className={`cl-feed-row st-${session.status}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button, a")) return;
                      setSelectedSessionId(session.id);
                    }}
                  >
                    <div className="cl-card-top">
                      <span className={`cl-provider-badge ${providerClassName(session.providerId)}`}>
                        <span className="cl-provider-dot" />
                        {session.provider}
                      </span>
                      <OriginTrackBadge track={session.originTrack} />
                      <ClassificationBadge
                        classification={session.classification}
                        editable
                        onChanged={() => void loadOverview(windowDays, true)}
                      />
                      <span className="cl-project-tag">{session.project}</span>
                      <HerdrBadge address={session.herdrAddress} spaceName={session.herdrSpace} />
                      {session.branch && <span className="cl-meta-tag">⎇ {session.branch}</span>}
                      {session.model && <span className="cl-meta-tag">{session.model}</span>}
                      <span className={`cl-status-pill cl-st-${session.status}`}>
                        {stMeta.icon} {stMeta.label}
                      </span>
                      <time
                        className="cl-card-time"
                        title={formatDateTime(session.updatedAt ?? session.startedAt)}
                      >
                        {formatDateTime(session.updatedAt ?? session.startedAt)} ·{" "}
                        {formatRelativeTime(session.updatedAt ?? session.startedAt)}
                      </time>
                    </div>

                    <div className="cl-feed-body">
                      <div className="cl-instr-box">
                        <div className="cl-instr-head">
                          <span>我发的指令</span>
                          {session.stats.instructionCount > 1 && (
                            <span className="cl-instr-count">
                              共 {session.stats.instructionCount} 条指令
                            </span>
                          )}
                        </div>
                        <p className="cl-instr-first">{firstInstr}</p>
                        {hasFollowUp && (
                          <p className="cl-instr-latest">
                            <b>最新追问：</b>
                            {session.latestInstruction}
                          </p>
                        )}
                      </div>

                      <div style={{ display: "grid", gap: "8px", minWidth: 0 }}>
                        <StageProgressTrack
                          stage={session.progressStage}
                          status={session.status}
                          progressPct={session.progressPct}
                          statusReason={session.statusReason}
                        />
                        <div className="cl-outcome-box">
                          <div className="cl-outcome-head">
                            <span>当前干到哪了</span>
                            <div className="cl-stat-chips">
                              <span
                                className={`cl-chip ${session.stats.filesModifiedCount > 0 ? "accent" : ""}`}
                              >
                                改动 {session.stats.filesModifiedCount} 文件
                              </span>
                              <span className="cl-chip">工具 {session.stats.totalToolCalls} 次</span>
                            </div>
                          </div>
                          <p className="cl-outcome-text">
                            {session.latestProgress || session.statusReason}
                          </p>
                        </div>
                      </div>
                    </div>

                    {session.recentTurnsPreview.length > 0 && (
                      <div className="cl-turn-bubbles">
                        <span className="cl-turn-bubbles-lbl">
                          最近轮次轨迹（点击卡片查看全部 {session.stats.totalTurns} 轮）
                        </span>
                        {session.recentTurnsPreview.map((turn) => (
                          <div key={turn.index} className="cl-turn-bubble">
                            <span className={`cl-turn-dot ${turn.outcomeStatus}`} />
                            <div className="cl-turn-bubble-content">
                              <span className="cl-turn-bubble-q" title={turn.instruction}>
                                #{turn.index} {turn.instruction}
                              </span>
                              {turn.outcome && (
                                <span className="cl-turn-bubble-a" title={turn.outcome}>
                                  ↳ {turn.outcome}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="cl-card-actions">
                      <button
                        type="button"
                        className="cl-btn-link"
                        onClick={() => setSelectedSessionId(session.id)}
                      >
                        查看全过程时间线 →
                      </button>
                      <button
                        type="button"
                        className="cl-btn-ghost"
                        disabled={copyingId === session.id}
                        onClick={() => void handleCopyHandoff(session)}
                      >
                        {copyingId === session.id
                          ? "读取中…"
                          : copiedId === session.id
                            ? "已复制 ✓"
                            : "复制交接"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      )}

      {/* ---- 6. Data Sources Transparency Footer ---- */}
      {overview && (
        <details className="cl-sources">
          <summary>
            <span>
              数据源扫描明细（{overview.sources.length} 个 CLI 源 · 扫描时间{" "}
              {formatDateTime(overview.generatedAt)}）
            </span>
            <span className="cl-scan-stamp">点击展开来源路径</span>
          </summary>
          <div className="cl-sources-grid">
            {overview.sources.map((src) => (
              <div key={`${src.providerId}-${src.detail}`} className="cl-source-item">
                <div className="cl-source-top">
                  <span className={`cl-provider-badge ${providerClassName(src.providerId)}`}>
                    <span className="cl-provider-dot" />
                    {src.provider}
                  </span>
                  <span className={`cl-source-status ${src.status}`}>
                    {src.status === "ok"
                      ? `● 正常 · ${src.scanned} 会话`
                      : src.status === "empty"
                        ? "○ 目录为空 · 0 会话"
                        : "▲ 未检测到"}
                  </span>
                </div>
                <div className="cl-source-detail">{src.detail}</div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* ---- 5. Interactive Process & Thinking Timeline Drawer ---- */}
      {selectedSessionId && (
        <div
          className="cl-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="会话全过程与思路时间线"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedSessionId(null);
          }}
        >
          <aside className="cl-drawer">
            <header className="cl-drawer-head">
              <div className="cl-drawer-head-top">
                <div className="cl-drawer-badges">
                  {activeDrawerSession && (
                    <>
                      <span
                        className={`cl-provider-badge ${providerClassName(activeDrawerSession.providerId)}`}
                      >
                        <span className="cl-provider-dot" />
                        {activeDrawerSession.provider}
                      </span>
                      <span className={`cl-status-pill cl-st-${activeDrawerSession.status}`}>
                        {STATUS_META[activeDrawerSession.status].icon}{" "}
                        {STATUS_META[activeDrawerSession.status].label}
                      </span>
                      <OriginTrackBadge track={activeDrawerSession.originTrack} />
                      <ClassificationBadge
                        classification={activeDrawerSession.classification}
                        editable
                        onChanged={() => void loadOverview(windowDays, true)}
                      />
                      <span className="cl-project-tag">{activeDrawerSession.project}</span>
                      <HerdrBadge
                        address={activeDrawerSession.herdrAddress}
                        spaceName={activeDrawerSession.herdrSpace}
                      />
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="cl-btn-ghost"
                  aria-label="关闭抽屉"
                  onClick={() => setSelectedSessionId(null)}
                >
                  ✕ 关闭
                </button>
              </div>

              <h2 className="cl-drawer-title">
                {activeDrawerSession?.title ||
                  activeDrawerSession?.firstInstruction?.slice(0, 80) ||
                  "正在读取会话详情…"}
              </h2>

              {activeDrawerSession && (
                <>
                  <div className="cl-drawer-meta-grid">
                    {activeDrawerSession.workspace && (
                      <span className="cl-drawer-meta-item">
                        目录：<code>{activeDrawerSession.workspace}</code>
                      </span>
                    )}
                    {activeDrawerSession.branch && (
                      <span className="cl-drawer-meta-item">
                        分支：<code>{activeDrawerSession.branch}</code>
                      </span>
                    )}
                    {activeDrawerSession.model && (
                      <span className="cl-drawer-meta-item">
                        模型：<code>{activeDrawerSession.model}</code>
                      </span>
                    )}
                    <span className="cl-drawer-meta-item">
                      耗时：<code>{formatDuration(activeDrawerSession.durationMins)}</code>
                    </span>
                    <span className="cl-drawer-meta-item">
                      更新：<code>{formatDateTime(activeDrawerSession.updatedAt)}</code>
                    </span>
                    {activeDrawerSession.stats.tokensTotal > 0 && (
                      <span className="cl-drawer-meta-item">
                        Tokens：<code>{formatTokens(activeDrawerSession.stats.tokensTotal)}</code>
                      </span>
                    )}
                  </div>

                  <StageProgressTrack
                    stage={activeDrawerSession.progressStage}
                    status={activeDrawerSession.status}
                    progressPct={activeDrawerSession.progressPct}
                    statusReason={activeDrawerSession.statusReason}
                  />
                </>
              )}
            </header>

            <div className="cl-drawer-body">
              {detailLoading ? (
                <div className="cl-empty-box">
                  <h3>正在解析多轮对话、思路与工具调用记录…</h3>
                  <p>会话 ID：{selectedSessionId}</p>
                </div>
              ) : detailError ? (
                <div role="alert" className="cl-banner cl-banner-error">
                  <span>{detailError}</span>
                  <button
                    type="button"
                    className="cl-btn-rust"
                    onClick={() => {
                      detailCacheRef.current.delete(selectedSessionId);
                      setDetailLoading(true);
                      setDetailError("");
                      void fetchSessionDetail(selectedSessionId, true)
                        .then(setDetail)
                        .catch((err) =>
                          setDetailError(err instanceof Error ? err.message : "重新读取失败"),
                        )
                        .finally(() => setDetailLoading(false));
                    }}
                  >
                    重试
                  </button>
                </div>
              ) : detail ? (
                <>
                  {/* Multi-turn Flow Timeline */}
                  <section aria-label="多轮执行过程时间线">
                    <div className="cl-drawer-section-head">
                      <h3>
                        全过程时间线（共 {detail.turns.length} 轮 · {detail.stats.instructionCount}{" "}
                        条指令 · {detail.stats.totalToolCalls} 次工具调用）
                      </h3>
                      {detail.turns.some((t) => Boolean(t.thinkingSummary)) && (
                        <button
                          type="button"
                          className="cl-btn-ghost"
                          onClick={() => setExpandAllThinking((v) => !v)}
                        >
                          {expandAllThinking ? "折叠全部思路" : "展开全部思路"}
                        </button>
                      )}
                    </div>

                    {detail.turns.length === 0 ? (
                      <div className="cl-col-empty" style={{ marginTop: "10px" }}>
                        该会话暂无可解析的逐轮交互记录。
                      </div>
                    ) : (
                      <div className="cl-turns" style={{ marginTop: "12px" }}>
                        {detail.turns.map((turn) => (
                          <TurnStepCard
                            key={`${detail.id}-turn-${turn.index}`}
                            turn={turn}
                            forceExpandThinking={expandAllThinking}
                          />
                        ))}
                      </div>
                    )}
                  </section>

                  {/* Files Modified Panel */}
                  <section className="cl-files-panel" aria-label="改动与涉及的文件">
                    <div className="cl-drawer-section-head">
                      <h3>改动与涉及文件（{detail.stats.filesTouched.length}）</h3>
                      <span className="cl-scan-stamp">点击文件路径即可复制</span>
                    </div>
                    {detail.stats.filesTouched.length === 0 ? (
                      <p className="cl-sub" style={{ margin: 0 }}>
                        本会话未检测到代码文件改动（可能为调研、排查或问答类指令）。
                      </p>
                    ) : (
                      <div className="cl-files-list">
                        {detail.stats.filesTouched.map((fp) => (
                          <button
                            key={fp}
                            type="button"
                            className="cl-file-chip-btn"
                            title={`点击复制：${fp}`}
                            onClick={() => void handleCopyPath(fp, "文件路径")}
                          >
                            📄 {fp}
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              ) : null}
            </div>

            <footer className="cl-drawer-foot">
              <button
                type="button"
                className="cl-btn-primary"
                disabled={!detail || copyingId === selectedSessionId}
                onClick={() => detail && void handleCopyHandoff(detail)}
              >
                {copiedId === selectedSessionId
                  ? "✓ 已复制交接上下文"
                  : "📋 复制跨 CLI 交接上下文"}
              </button>

              {promotedInfo || activeDrawerSession?.linkedTaskId ? (
                <a
                  className="cl-promoted-link"
                  href={
                    promotedInfo?.href ||
                    `#planning?task=${encodeURIComponent(activeDrawerSession?.linkedTaskId ?? "")}`
                  }
                >
                  ✓ 已绑定看板（持续同步）· 查看任务 ↗
                </a>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!detail || promotingId === selectedSessionId}
                    onClick={() => void handlePromoteTask(selectedSessionId)}
                  >
                    {promotingId === selectedSessionId ? "正在收入…" : "📌 收入看板持续同步"}
                  </button>
                  {bindableTasks.length > 0 && (
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                      <select
                        aria-label="选择要绑定的已有看板任务"
                        value={bindTargetTaskId}
                        onChange={(e) => setBindTargetTaskId(e.target.value)}
                        style={{ maxWidth: 180, fontSize: 12, padding: "4px 6px" }}
                      >
                        <option value="">绑定已有任务…</option>
                        {bindableTasks.map((t) => (
                          <option key={t.id} value={t.id}>
                            [{t.project}] {t.title.slice(0, 32)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!bindTargetTaskId || bindingId === selectedSessionId}
                        onClick={() => void handleBindTask(selectedSessionId, bindTargetTaskId)}
                      >
                        {bindingId === selectedSessionId ? "绑定中…" : "🔗 绑定"}
                      </button>
                    </span>
                  )}
                </>
              )}

              <button
                type="button"
                className="cl-btn-ghost"
                disabled={!activeDrawerSession?.workspace}
                onClick={() =>
                  activeDrawerSession?.workspace &&
                  void handleCopyPath(activeDrawerSession.workspace, "工作目录路径")
                }
              >
                📂 打开工作目录路径（复制）
              </button>
            </footer>
          </aside>
        </div>
      )}

      {/* ---- Toast Notification ---- */}
      {toast && (
        <div className="cl-toast" role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.href && (
            <a href={toast.href}>{toast.linkLabel || "查看 ↗"}</a>
          )}
          <button type="button" aria-label="关闭提示" onClick={() => setToast(null)}>
            ✕
          </button>
        </div>
      )}
    </section>
  );
}
