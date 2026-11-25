import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  PLANNING_TASK_STATUSES,
  PLANNING_TASK_TYPES,
  extractExternalSession,
  extractTaskOriginTrack,
  extractTaskTriage,
  type DailyTrendPoint,
  type DailyTrendResponse,
  type KanbanBoardResponse,
  type KanbanColumnKey,
  type PatrolReport,
  type PlanningAgentOption,
  type PlanningEnergyLevel,
  type PlanningTask,
  type PlanningTaskStatus,
  type PlanningTaskType,
  type PlanningTaskWithSubtasks,
  type RoiDashboardResponse,
  type TaskTriageMeta,
  type TriageConfig,
  type TriageFunnelCounts,
  type TriageRunItemResult,
  type TriageRunReport,
  type TriageStatus,
  type TriageStatusResponse,
} from "../../src/task-planning-types";
import {
  WORK_ORIGIN_LABELS,
  WORKSPACE_CATEGORIES,
  WORKSPACE_CATEGORY_LABELS,
  type WorkOriginTrack,
  type WorkspaceCategory,
} from "../../src/workspace-classification-types";
import type { WorkstreamHerdrTree, WorkstreamsOverview } from "../../src/workstreams-types";
import { request } from "./api";
import { ClassificationBadge, HerdrBadge, OriginTrackBadge } from "./ClassificationBadge";
import { HerdrActions } from "./HerdrActions";
import { PlanningConversation } from "./PlanningConversation";
import "./task-planning.css";

const API_BASE = "/api/opc/planning";
const PRODUCT_API_BASE = "/api/opc/domains/product";
const POMODORO_DEFAULT_SECONDS = 25 * 60;

type SignalStatus = "new" | "promoted" | "dropped" | "blocked";

interface ProductSignalItem {
  id: string;
  dedupeKey: string;
  source: string;
  projectRef: string;
  mainlineId: string | null;
  assetId: string | null;
  title: string;
  body: string;
  tags: string[];
  alignmentScore: number;
  recommendation: string;
  scoreSummary: string;
  status: SignalStatus;
  promotedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SignalCounts {
  total: number;
  new: number;
  promoted: number;
  dropped: number;
  blocked: number;
}

const SIGNAL_STATUS_LABELS: Record<SignalStatus, string> = {
  new: "待人工筛选",
  promoted: "已转研发任务",
  dropped: "已丢弃噪音",
  blocked: "准入已拦截",
};

const SIGNAL_REC_LABELS: Record<string, string> = {
  auto_promote: "建议立项",
  needs_review: "建议人工复核",
  drop_noise: "疑似噪音",
  blocked: "主线/冻结拦截",
};

const KANBAN_COLUMNS: Array<{ key: KanbanColumnKey; label: string; hint: string }> = [
  { key: "todo", label: "Todo", hint: "待规划" },
  { key: "assigned", label: "Assigned", hint: "已认领" },
  { key: "in_progress", label: "In Progress", hint: "执行中 / PR Open" },
  { key: "review", label: "Review", hint: "待审阅" },
  { key: "done", label: "Done", hint: "已完成 / Published" },
];

const STATUS_LABELS: Record<PlanningTaskStatus, string> = {
  todo: "Todo",
  assigned: "Assigned",
  in_progress: "In Progress",
  pr_open: "PR Open",
  review: "Review",
  done: "Done",
  failed: "Failed",
  archived: "Archived",
  published: "Published",
};

const STATUS_COLORS: Record<PlanningTaskStatus, string> = {
  todo: "#8c948c",
  assigned: "#587968",
  in_progress: "#1f6e78",
  pr_open: "#2f8c96",
  review: "#b8761c",
  done: "#2f513e",
  published: "#1d6b43",
  failed: "#8d3b24",
  archived: "#b4b7ad",
};

const TYPE_LABELS: Record<PlanningTaskType, string> = {
  epic: "Epic",
  task: "Task",
  bug: "Bug",
  prd: "PRD",
};

type TodoTriageFilter = "verified" | "unreviewed" | "needs_scope" | "all";
type SingleTriageAction = "code_check" | "verify";

const TRIAGE_LABELS: Record<TriageStatus, string> = {
  unreviewed: "⏳ 待审查",
  triaging: "⏳ 审查中",
  verified: "✓ 已验真就绪",
  needs_scope: "⚠ 需补范围",
  idea_demoted: "💡 已降级想法",
  noise_archived: "🧹 噪音归档",
  superseded: "↪ 已替代",
};

function readTaskTriage(task: PlanningTask): TaskTriageMeta | null {
  const hasExplicit = Boolean(
    task.metadata &&
      typeof task.metadata === "object" &&
      task.metadata.triage &&
      typeof task.metadata.triage === "object",
  );
  if (hasExplicit || task.status === "todo") {
    return extractTaskTriage(task.metadata);
  }
  return null;
}

function summarizeTriageReport(report: TriageRunReport, mode: "sweep" | "run"): string {
  if (mode === "sweep") {
    return report.noiseArchivedCount > 0
      ? `🧹 Layer 0 规则清噪完成：扫描 ${report.scannedCount} 项，自动归档纯噪音 ${report.noiseArchivedCount} 项。`
      : `🧹 Layer 0 规则清噪完成：扫描 ${report.scannedCount} 项，未命中新的纯摘要噪音。`;
  }
  const parts = [
    report.noiseArchivedCount > 0 ? `噪音归档 ${report.noiseArchivedCount}` : "",
    report.verifiedCount > 0 ? `已验真就绪 ${report.verifiedCount}` : "",
    report.ideaDemotedCount > 0 ? `降级为想法 ${report.ideaDemotedCount}` : "",
    report.needsScopeCount > 0 ? `需补范围 ${report.needsScopeCount}` : "",
    report.supersededCount > 0 ? `已替代/完成 ${report.supersededCount}` : "",
    report.codeCheckedCount > 0 ? `agy 代码复核 ${report.codeCheckedCount}` : "",
    report.dispatchedCount > 0 ? `自动轮动派工 ${report.dispatchedCount}` : "",
  ].filter(Boolean);
  const fallbackHint = report.fallbackUsed ? "（产研 Bot 暂不可达，已用本地规则兜底）" : "";
  return parts.length
    ? `🤖 审查漏斗执行完成：${parts.join(" · ")}${fallbackHint}。`
    : `🤖 审查漏斗执行完成：当前没有新的待审查项${fallbackHint}。`;
}

function priorityTier(priority: number): "high" | "mid" | "low" {
  if (priority >= 8) return "high";
  if (priority >= 5) return "mid";
  return "low";
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatShortTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function isOverdue(task: PlanningTask): boolean {
  if (!task.dueAt) return false;
  if (task.status === "done" || task.status === "published" || task.status === "archived") return false;
  const dueMs = Date.parse(task.dueAt);
  return Number.isFinite(dueMs) && dueMs < Date.now();
}

function columnForStatus(status: PlanningTaskStatus): keyof Pick<
  KanbanBoardResponse,
  "todo" | "assigned" | "in_progress" | "review" | "done" | "failed" | "archived"
> {
  if (status === "pr_open") return "in_progress";
  if (status === "published") return "done";
  return status;
}

function heatLevel(point: DailyTrendPoint): 0 | 1 | 2 | 3 | 4 {
  const score = point.completed * 2 + point.created + point.agentRuns + point.pomodoroCount;
  if (score <= 0) return 0;
  if (score <= 2) return 1;
  if (score <= 5) return 2;
  if (score <= 9) return 3;
  return 4;
}

// ---- Embedded Pomodoro Timer Component ----

interface PomodoroWidgetProps {
  taskId: string;
  busy: boolean;
  onComplete: (taskId: string, energyLevel: PlanningEnergyLevel, durationMins: number, note: string) => Promise<void>;
  onClose: () => void;
}

function PomodoroWidget({ taskId, busy, onComplete, onClose }: PomodoroWidgetProps) {
  const [secondsLeft, setSecondsLeft] = useState(POMODORO_DEFAULT_SECONDS);
  const [running, setRunning] = useState(true);
  const [awaitingEnergy, setAwaitingEnergy] = useState(false);
  const [energy, setEnergy] = useState<PlanningEnergyLevel | null>(null);
  const [note, setNote] = useState("");
  const [settledMins, setSettledMins] = useState(25);

  useEffect(() => {
    if (!running || awaitingEnergy) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setRunning(false);
          setSettledMins(25);
          setAwaitingEnergy(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, awaitingEnergy]);

  const elapsedPct = Math.min(
    100,
    Math.round(((POMODORO_DEFAULT_SECONDS - secondsLeft) / POMODORO_DEFAULT_SECONDS) * 100),
  );

  const triggerQuickSettle = () => {
    setRunning(false);
    const elapsedMins = Math.max(1, Math.round((POMODORO_DEFAULT_SECONDS - secondsLeft) / 60));
    setSettledMins(secondsLeft === POMODORO_DEFAULT_SECONDS ? 25 : Math.max(elapsedMins, 25));
    setAwaitingEnergy(true);
  };

  const handleSave = async () => {
    if (!energy) return;
    await onComplete(taskId, energy, settledMins, note.trim());
    onClose();
  };

  return (
    <div className="tp-pomo-panel" onClick={(e) => e.stopPropagation()}>
      <div className="tp-pomo-clock">
        <span className="tp-pomo-time">{formatClock(secondsLeft)}</span>
        <span className="tp-pill mono">{awaitingEnergy ? "待结算精力" : running ? "专注计时中" : "已暂停"}</span>
      </div>
      <div className="tp-pomo-track">
        <div className="tp-pomo-fill" style={{ width: `${awaitingEnergy ? 100 : elapsedPct}%` }} />
      </div>

      {!awaitingEnergy ? (
        <div className="tp-pomo-controls">
          <button type="button" onClick={() => setRunning((r) => !r)}>
            {running ? "暂停" : "继续"}
          </button>
          <button
            type="button"
            onClick={() => {
              setRunning(false);
              setSecondsLeft(POMODORO_DEFAULT_SECONDS);
            }}
          >
            重置
          </button>
          <button type="button" className="tp-amber" onClick={triggerQuickSettle}>
            快速结算 1 番茄
          </button>
          <button type="button" className="tp-ghost" onClick={onClose}>
            收起
          </button>
        </div>
      ) : (
        <div className="tp-energy-gate">
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            必选本轮精力状态（完成后记录 {settledMins} 分钟番茄）：
          </div>
          <div className="tp-energy-choices">
            <button
              type="button"
              aria-pressed={energy === "high"}
              onClick={() => setEnergy("high")}
            >
              ⚡ 高能状态
            </button>
            <button
              type="button"
              aria-pressed={energy === "low"}
              onClick={() => setEnergy("low")}
            >
              🌙 低能状态
            </button>
          </div>
          <input
            type="text"
            placeholder="可选：本轮专注备注（产出或卡点）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="tp-pomo-controls">
            <button
              type="button"
              className="tp-primary"
              disabled={!energy || busy}
              onClick={() => void handleSave()}
            >
              保存番茄记录
            </button>
            <button
              type="button"
              className="tp-ghost"
              onClick={() => {
                setAwaitingEnergy(false);
                setEnergy(null);
              }}
            >
              返回计时
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Task Card Component ----

interface TaskCardProps {
  task: PlanningTaskWithSubtasks;
  agents: PlanningAgentOption[];
  busy: boolean;
  isDragging: boolean;
  onDragStart: (e: DragEvent<HTMLElement>, taskId: string) => void;
  onDragEnd: () => void;
  onStatusChange: (taskId: string, status: PlanningTaskStatus) => Promise<void>;
  onAssignHuman: (taskId: string) => Promise<void>;
  onDispatch: (taskId: string, agentId: string, autoCreatePr: boolean) => Promise<void>;
  onRecordPomodoro: (
    taskId: string,
    energyLevel: PlanningEnergyLevel,
    durationMins: number,
    note: string,
  ) => Promise<void>;
  onCreateSubtask: (parent: PlanningTaskWithSubtasks, title: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onTriageTask: (taskId: string, action: SingleTriageAction) => Promise<void>;
}

function TaskCard({
  task,
  agents,
  busy,
  isDragging,
  onDragStart,
  onDragEnd,
  onStatusChange,
  onAssignHuman,
  onDispatch,
  onRecordPomodoro,
  onCreateSubtask,
  onDeleteTask,
  onTriageTask,
}: TaskCardProps) {
  const [showPomo, setShowPomo] = useState(false);
  const [showDispatch, setShowDispatch] = useState(false);
  const [showSubtasks, setShowSubtasks] = useState(task.type === "epic" && task.subtasks.length > 0);
  const [newSubTitle, setNewSubTitle] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("__auto_quota__");
  const [autoCreatePr, setAutoCreatePr] = useState(true);

  useEffect(() => {
    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0].id);
    }
  }, [agents, selectedAgentId]);

  const tier = priorityTier(task.priority);
  const overdue = isOverdue(task);
  const triage = readTaskTriage(task);
  const subPct =
    task.subtaskStats.total > 0
      ? Math.round((task.subtaskStats.done / task.subtaskStats.total) * 100)
      : 0;

  const submitSubtask = async (e: FormEvent) => {
    e.preventDefault();
    const title = newSubTitle.trim();
    if (!title) return;
    await onCreateSubtask(task, title);
    setNewSubTitle("");
    setShowSubtasks(true);
  };

  return (
    <article
      className={`tp-card${isDragging ? " is-dragging" : ""}`}
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      onDragEnd={onDragEnd}
    >
      <div className={`tp-card-prio-bar ${tier}`} />

      <div className="tp-card-top">
        <span className={`tp-pill mono prio-${tier}`}>P{task.priority}</span>
        <span className={`tp-pill type-${task.type}`}>{TYPE_LABELS[task.type]}</span>
        <OriginTrackBadge track={task.originTrack ?? extractTaskOriginTrack(task)} />
        <ClassificationBadge classification={task.classification} />
        <span className="tp-pill">{task.project}</span>
        {triage && (
          <span
            className={`tp-pill triage-${triage.status}`}
            title={triage.reason || TRIAGE_LABELS[triage.status]}
          >
            {TRIAGE_LABELS[triage.status]}
          </span>
        )}
        {task.status === "pr_open" && <span className="tp-pill pr-open">PR Open</span>}
        {task.status === "published" && <span className="tp-pill published">Published</span>}
        {task.dueAt && (
          <span className={`tp-pill mono${overdue ? " overdue" : ""}`}>
            {overdue ? "已超期 " : "截止 "}
            {task.dueAt.slice(0, 10)}
          </span>
        )}
      </div>

      <div className="tp-card-title">{task.title}</div>
      {task.description && <div className="tp-card-desc">{task.description}</div>}
      {triage?.reason && (
        <div className="tp-triage-reason" title={triage.reason}>
          🤖 {triage.reason}
        </div>
      )}

      {task.tags.length > 0 && (
        <div className="tp-card-tags">
          {task.tags.map((tag) => (
            <span key={tag} className="tp-tag">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="tp-card-meta">
        <span className={`tp-pill ${task.assigneeType}`}>
          {task.assigneeType === "agent" ? "◈ Agent: " : "◉ "}
          {task.assigneeName || task.assigneeId || (task.assigneeType === "agent" ? "未指定" : "人类")}
        </span>
        <span className="tp-pill pomo mono">🍅 {task.pomodoroCount}</span>
        {task.energyLevel && (
          <span className={`tp-pill energy-${task.energyLevel}`}>
            {task.energyLevel === "high" ? "⚡高能" : "🌙低能"}
          </span>
        )}
        {(task.tokenUsed > 0 || task.costUsd > 0) && (
          <span className="tp-pill mono">
            {formatTokens(task.tokenUsed)} · {formatUsd(task.costUsd)}
          </span>
        )}
      </div>

      {(() => {
        const ext = task.externalSession ?? extractExternalSession(task.metadata);
        if (!ext) return null;
        const stLabel =
          ext.liveStatus === "running"
            ? "⚡ 执行中"
            : ext.liveStatus === "waiting_user"
              ? "💬 等你确认"
              : ext.liveStatus === "completed"
                ? "✓ 已交付本轮"
                : ext.liveStatus === "blocked"
                  ? "⛔ 受阻"
                  : "⏸ 静默";
        return (
          <div className="dt-ext-session-bar" aria-label="绑定的实时会话同步状态">
            <div className="dt-ext-session-row">
              <strong>
                {stLabel}
                {ext.herdrAddress ? ` · Herdr ${ext.herdrAddress}` : ext.provider ? ` · ${ext.provider}` : ""}
              </strong>
              <span>
                {ext.filesModifiedCount ? `改 ${ext.filesModifiedCount} 文件 · ` : ""}
                {ext.sessionId ? (
                  <a href={`#cli-ledger?session=${encodeURIComponent(ext.sessionId)}`}>查看台账 ↗</a>
                ) : (
                  <a href="#activity-index">查看现场 ↗</a>
                )}
              </span>
            </div>
            {ext.latestProgress && (
              <div style={{ opacity: 0.88, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ext.latestProgress}>
                {ext.latestProgress}
              </div>
            )}
            {ext.herdrAddress && (
              <div style={{ marginTop: 2 }}>
                <HerdrActions
                  address={ext.herdrAddress}
                  isBlocked={ext.liveStatus === "blocked"}
                  compact
                />
              </div>
            )}
          </div>
        );
      })()}

      {(task.prUrl || task.latestRunId || task.sourceRef) && (
        <div className="tp-card-links">
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              PR ↗
            </a>
          )}
          {task.latestRunId && (
            <a href={`#dark-factory?run=${encodeURIComponent(task.latestRunId)}`}>
              运行日志 ({task.latestRunId.slice(0, 10)}) ↗
            </a>
          )}
          {task.sourceRef && (() => {
            if (task.sourceRef.startsWith("canvas:")) {
              const parts = task.sourceRef.split(":");
              const canvasId = parts[1] ?? "";
              const nodeId = parts[2] ?? "";
              const href = canvasId
                ? `#canvas?id=${encodeURIComponent(canvasId)}${nodeId ? `&node=${encodeURIComponent(nodeId)}` : ""}`
                : "#canvas";
              return (
                <a href={href} title={task.sourceRef}>
                  画布溯源 ↗
                </a>
              );
            }
            return (
              <span className="tp-source-link" title={task.sourceRef}>
                来源: {task.sourceRef.length > 26 ? `${task.sourceRef.slice(0, 26)}…` : task.sourceRef}
              </span>
            );
          })()}
        </div>
      )}

      {/* Subtask progress & expandable tree */}
      <div className="tp-subtasks-box">
        <div className="tp-subtasks-bar">
          <button
            type="button"
            className="tp-ghost"
            onClick={() => setShowSubtasks((v) => !v)}
          >
            {showSubtasks ? "▾" : "▸"}{" "}
            {task.subtaskStats.total > 0
              ? `${task.subtaskStats.done}/${task.subtaskStats.total} sub`
              : "+ 子任务"}
          </button>
          {task.subtaskStats.total > 0 && (
            <div className="tp-mini-track" aria-label="子任务进度">
              <div className="tp-mini-fill" style={{ width: `${subPct}%` }} />
            </div>
          )}
          <select
            aria-label={`修改任务 ${task.title} 状态`}
            value={task.status}
            disabled={busy}
            onChange={(e) => void onStatusChange(task.id, e.target.value as PlanningTaskStatus)}
            style={{ fontSize: 11, padding: "2px 4px" }}
          >
            {PLANNING_TASK_STATUSES.map((st) => (
              <option key={st} value={st}>
                {STATUS_LABELS[st]}
              </option>
            ))}
          </select>
        </div>

        {showSubtasks && (
          <>
            {task.subtasks.length > 0 && (
              <ul className="tp-subtask-list">
                {task.subtasks.map((sub) => {
                  const subDone = sub.status === "done" || sub.status === "published";
                  return (
                    <li key={sub.id} className={`tp-subtask-item${subDone ? " is-done" : ""}`}>
                      <input
                        type="checkbox"
                        checked={subDone}
                        disabled={busy}
                        onChange={() => void onStatusChange(sub.id, subDone ? "todo" : "done")}
                      />
                      <span className="tp-subtask-item-title" title={sub.title}>
                        {sub.title}
                      </span>
                      {!subDone && (
                        <button
                          type="button"
                          className="tp-ghost"
                          disabled={busy}
                          style={{ fontSize: 10, padding: "1px 6px" }}
                          title="按实时套餐余量与依赖检查自动派发给暗工厂 Agent"
                          onClick={() => void onDispatch(sub.id, "__auto_quota__", true)}
                        >
                          ⚡派发
                        </button>
                      )}
                      <span className="tp-pill mono" style={{ fontSize: 10 }}>
                        {STATUS_LABELS[sub.status]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <form className="tp-inline-add-sub" onSubmit={(e) => void submitSubtask(e)}>
              <input
                type="text"
                placeholder="输入子任务标题并回车…"
                value={newSubTitle}
                onChange={(e) => setNewSubTitle(e.target.value)}
              />
              <button type="submit" disabled={busy || !newSubTitle.trim()}>
                添加
              </button>
            </form>
          </>
        )}
      </div>

      {/* Embedded Action Bar */}
      <div className="tp-card-actions">
        <button
          type="button"
          className={showPomo ? "tp-amber" : "tp-ghost"}
          onClick={() => {
            setShowPomo((v) => !v);
            setShowDispatch(false);
          }}
        >
          🍅 专注番茄
        </button>
        <button
          type="button"
          className="tp-ghost"
          disabled={busy}
          onClick={() => void onAssignHuman(task.id)}
        >
          ◉ 分给我
        </button>
        <button
          type="button"
          className={showDispatch ? "tp-teal" : "tp-ghost"}
          onClick={() => {
            setShowDispatch((v) => !v);
            setShowPomo(false);
          }}
        >
          → 派给 Agent
        </button>
        {task.status === "todo" && (triage?.status === "unreviewed" || triage?.status === "needs_scope") && (
          <>
            <button
              type="button"
              className="tp-ghost"
              disabled={busy}
              title="使用 agy 只读复核该任务在代码仓中是否真实存在"
              onClick={() => void onTriageTask(task.id, "code_check")}
            >
              🤖 代码复核
            </button>
            <button
              type="button"
              className="tp-ghost"
              disabled={busy}
              title="人工确认该任务可执行，标记为已验真就绪"
              onClick={() => void onTriageTask(task.id, "verify")}
            >
              ✓ 标为就绪
            </button>
          </>
        )}
        {(task.status === "review" || task.status === "pr_open") && (
          <>
            <button
              type="button"
              className="tp-primary"
              disabled={busy}
              onClick={() => void onStatusChange(task.id, "done")}
            >
              ✓ 审阅通过
            </button>
            <button
              type="button"
              className="tp-ghost"
              disabled={busy}
              style={{ color: "#8d3b24" }}
              onClick={() => void onStatusChange(task.id, "failed")}
            >
              ↩ 打回修改
            </button>
          </>
        )}
        {task.status === "done" && (
          <button
            type="button"
            className="tp-ghost"
            disabled={busy}
            onClick={() => void onDispatch(task.id, "__request_release__", false)}
          >
            {task.latestRunId ? "🚀 申请合入真上线" : "🚀 标记发布"}
          </button>
        )}
        <button
          type="button"
          className="tp-ghost"
          disabled={busy}
          title="删除任务及其子任务"
          onClick={() => void onDeleteTask(task.id)}
          style={{ marginLeft: "auto", color: "#8d3b24" }}
        >
          删
        </button>
      </div>

      {showPomo && (
        <PomodoroWidget
          taskId={task.id}
          busy={busy}
          onComplete={onRecordPomodoro}
          onClose={() => setShowPomo(false)}
        />
      )}

      {showDispatch && (
        <div className="tp-dispatch-panel">
          {agents.length === 0 ? (
            <div style={{ fontSize: 12, color: "#4f5c53" }}>
              当前暂无已注册的暗工厂 Agent。<a href="#dark-factory">前往 Agent 暗工厂注册 ↗</a>
            </div>
          ) : (
            <>
              <label className="tp-field">
                选择派发模式 / 暗工厂 Agent
                <select value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)}>
                  <option value="__auto_quota__">⚡ 按实时套餐配额智能选模路由 (推荐)</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.status}) {a.capabilities.length ? `· ${a.capabilities.slice(0, 3).join("/")}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={autoCreatePr}
                  onChange={(e) => setAutoCreatePr(e.target.checked)}
                />
                完成后自动提 PR (autoCreatePr)
              </label>
              <div className="tp-pomo-controls">
                <button
                  type="button"
                  className="tp-teal"
                  disabled={busy || !selectedAgentId}
                  onClick={async () => {
                    await onDispatch(task.id, selectedAgentId, autoCreatePr);
                    setShowDispatch(false);
                  }}
                >
                  确认派发
                </button>
                <button type="button" className="tp-ghost" onClick={() => setShowDispatch(false)}>
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

// ---- Main TaskPlanning Page Component ----

export function TaskPlanning({ nav, initialTab }: { nav?: ReactNode; initialTab?: "signals" | "kanban" | "roi" | "patrol" }) {
  const [activeTab, setActiveTab] = useState<"signals" | "kanban" | "roi" | "patrol">(initialTab ?? "kanban");
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);
  const [viewMode, setViewMode] = useState<"board" | "tree">("board");
  const [projectFilter, setProjectFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<"all" | "human" | "agent">("all");
  const [originFilter, setOriginFilter] = useState<"all" | WorkOriginTrack>("all");
  const [categoryFilter, setCategoryFilter] = useState<"" | WorkspaceCategory>("");
  const [todoTriageFilter, setTodoTriageFilter] = useState<TodoTriageFilter>("verified");
  const [showArchiveDrawer, setShowArchiveDrawer] = useState(false);
  const [workstreams, setWorkstreams] = useState<WorkstreamsOverview | null>(null);
  const [showLiveStrip, setShowLiveStrip] = useState(true);
  const [promotingHerdrId, setPromotingHerdrId] = useState<string | null>(null);

  const [triageConfig, setTriageConfig] = useState<Pick<TriageConfig, "autoSweepEnabled" | "autoRollEnabled" | "useAgyCodeCheck">>({
    autoSweepEnabled: true,
    autoRollEnabled: false,
    useAgyCodeCheck: true,
  });
  const [triageServerCounts, setTriageServerCounts] = useState<TriageFunnelCounts | null>(null);
  const [triageBusy, setTriageBusy] = useState(false);
  const [triageReceipt, setTriageReceipt] = useState("");

  const [kanban, setKanban] = useState<KanbanBoardResponse | null>(null);
  const [signals, setSignals] = useState<ProductSignalItem[]>([]);
  const [signalCounts, setSignalCounts] = useState<SignalCounts | null>(null);
  const [signalStatusFilter, setSignalStatusFilter] = useState<SignalStatus | "all">("all");
  const [collectManualOnly, setCollectManualOnly] = useState(true);
  const [showSignalForm, setShowSignalForm] = useState(false);
  const [sigTitle, setSigTitle] = useState("");
  const [sigProject, setSigProject] = useState("");
  const [sigTags, setSigTags] = useState("");
  const [sigBody, setSigBody] = useState("");
  const [sigManualOnly, setSigManualOnly] = useState(true);
  const [roi, setRoi] = useState<RoiDashboardResponse | null>(null);
  const [roiDays, setRoiDays] = useState(30);
  const [trend, setTrend] = useState<DailyTrendPoint[]>([]);
  const [selectedHeatDay, setSelectedHeatDay] = useState<DailyTrendPoint | null>(null);

  const [patrolStaleDays, setPatrolStaleDays] = useState(7);
  const [latestPatrol, setLatestPatrol] = useState<PatrolReport | null>(null);
  const [patrolHistory, setPatrolHistory] = useState<PatrolReport[]>([]);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Drag & Drop state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<KanbanColumnKey | null>(null);

  // Task / Epic Creator form
  const [showCreator, setShowCreator] = useState(false);
  const [showConversation, setShowConversation] = useState(false);
  const [createMode, setCreateMode] = useState<"task" | "epic">("task");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftProject, setDraftProject] = useState("default");
  const [draftDesc, setDraftDesc] = useState("");
  const [draftType, setDraftType] = useState<PlanningTaskType>("task");
  const [draftPriority, setDraftPriority] = useState(6);
  const [draftTags, setDraftTags] = useState("");
  const [draftDueAt, setDraftDueAt] = useState("");
  const [draftSourceRef, setDraftSourceRef] = useState("");
  const [epicSubtasks, setEpicSubtasks] = useState<
    Array<{ title: string; type: PlanningTaskType; priority: number }>
  >([
    { title: "", type: "task", priority: 6 },
    { title: "", type: "task", priority: 5 },
  ]);

  const loadKanban = useCallback(async () => {
    const query = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : "";
    const data = await request<KanbanBoardResponse>(`${API_BASE}/kanban${query}`);
    setKanban(data);
  }, [projectFilter]);

  const loadTriageStatus = useCallback(async () => {
    try {
      const res = await request<TriageStatusResponse>(`${API_BASE}/triage/status`);
      if (res.config) {
        setTriageConfig({
          autoSweepEnabled: Boolean(res.config.autoSweepEnabled),
          autoRollEnabled: Boolean(res.config.autoRollEnabled),
          useAgyCodeCheck: Boolean(res.config.useAgyCodeCheck),
        });
      }
      if (res.funnel) {
        setTriageServerCounts(res.funnel);
      }
    } catch {
      // Triage status endpoint may not be mounted in legacy test harnesses.
    }
  }, []);

  const loadRoiAndTrend = useCallback(async () => {
    const [roiData, trendData] = await Promise.all([
      request<RoiDashboardResponse>(`${API_BASE}/roi?days=${roiDays}`),
      request<DailyTrendResponse>(`${API_BASE}/daily-trend?days=112`),
    ]);
    setRoi(roiData);
    setTrend(trendData.points);
    if (trendData.points.length > 0) {
      setSelectedHeatDay((prev) => prev ?? trendData.points[trendData.points.length - 1]);
    }
  }, [roiDays]);

  const loadPatrolHistory = useCallback(async () => {
    const res = await request<{ runs: PatrolReport[] }>(`${API_BASE}/patrol/history?limit=15`);
    setPatrolHistory(res.runs);
    if (res.runs.length > 0) {
      setLatestPatrol((prev) => prev ?? res.runs[0]);
    }
  }, []);

  const loadSignals = useCallback(
    async (statusOverride?: SignalStatus | "all") => {
      const targetStatus = statusOverride ?? signalStatusFilter;
      const params = new URLSearchParams({ status: targetStatus, limit: "120" });
      const res = await request<{ signals: ProductSignalItem[]; counts: SignalCounts }>(
        `${PRODUCT_API_BASE}/signals?${params.toString()}`,
      );
      setSignals(res.signals);
      setSignalCounts(res.counts);
    },
    [signalStatusFilter],
  );

  const loadWorkstreams = useCallback(async () => {
    try {
      const res = await request<WorkstreamsOverview>("/api/opc/workstreams");
      setWorkstreams(res);
    } catch {
      // Optional live strip
    }
  }, []);

  const handlePromoteWorkstream = useCallback(
    async (tree: WorkstreamHerdrTree) => {
      setPromotingHerdrId(tree.id);
      setError("");
      try {
        const res = await request<{ taskId: string; title: string; alreadyLinked?: boolean }>(
          `${API_BASE}/promote-herdr`,
          {
            method: "POST",
            body: JSON.stringify({
              herdrAddress: tree.address,
              sessionId: tree.linkedSessionId ?? "",
              project: tree.classification?.canonicalProject || tree.spaceName || "个人工作区",
              provider: tree.provider,
              title: tree.title || tree.label,
              herdrSpace: tree.spaceName,
              workspace: tree.workspace,
              liveStatus:
                tree.effectiveState === "working"
                  ? "running"
                  : tree.effectiveState === "waiting"
                    ? "waiting_user"
                    : "idle",
              latestProgress: tree.what || tree.title || null,
              originTrack: tree.originTrack,
            }),
          },
        );
        setNotice(
          res.alreadyLinked
            ? `已同步实时会话到看板任务「${res.title}」`
            : `已将 Herdr 会话纳入看板持续追踪：「${res.title}」`,
        );
        await Promise.all([loadKanban(), loadWorkstreams()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "纳入看板失败");
      } finally {
        setPromotingHerdrId(null);
      }
    },
    [loadKanban, loadWorkstreams],
  );

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([loadKanban(), loadWorkstreams(), loadTriageStatus(), loadSignals(), loadRoiAndTrend(), loadPatrolHistory()]);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载任务规划数据失败");
    }
  }, [loadKanban, loadWorkstreams, loadTriageStatus, loadSignals, loadRoiAndTrend, loadPatrolHistory]);

  useEffect(() => {
    void loadKanban().catch((err) => setError(err instanceof Error ? err.message : "加载看板失败"));
    void loadWorkstreams();
    void loadTriageStatus();
  }, [loadKanban, loadWorkstreams, loadTriageStatus]);

  useEffect(() => {
    if (activeTab === "signals") {
      void loadSignals().catch((err) => setError(err instanceof Error ? err.message : "加载情报信号池失败"));
    } else if (activeTab === "roi") {
      void loadRoiAndTrend().catch((err) => setError(err instanceof Error ? err.message : "加载 ROI 数据失败"));
    } else if (activeTab === "patrol") {
      void loadPatrolHistory().catch((err) => setError(err instanceof Error ? err.message : "加载巡检记录失败"));
    }
  }, [activeTab, loadSignals, loadRoiAndTrend, loadPatrolHistory]);

  // Initial background load of patrol history & signal counts so tab badges are ready
  useEffect(() => {
    void loadPatrolHistory().catch(() => {});
    void loadSignals().catch(() => {});
  }, [loadPatrolHistory, loadSignals]);

  const filterTasks = useCallback(
    (list: PlanningTaskWithSubtasks[]) => {
      return list.filter((t) => {
        if (assigneeFilter !== "all" && t.assigneeType !== assigneeFilter) return false;
        if (originFilter !== "all") {
          const track = t.originTrack ?? extractTaskOriginTrack(t);
          if (track !== originFilter) return false;
        }
        if (categoryFilter) {
          const cat = t.classification?.category ?? "personal";
          if (cat !== categoryFilter) return false;
        }
        return true;
      });
    },
    [assigneeFilter, originFilter, categoryFilter],
  );

  const visibleHerdrTrees = useMemo(() => {
    const trees = workstreams?.herdrTrees ?? [];
    const projLow = projectFilter.trim().toLowerCase();
    return trees.filter((t) => {
      if (originFilter !== "all" && t.originTrack !== originFilter) return false;
      if (categoryFilter && (t.classification?.category ?? "personal") !== categoryFilter) return false;
      if (projLow) {
        const names = [t.classification?.canonicalProject, t.classification?.group, t.spaceName]
          .filter(Boolean)
          .map((s) => s!.toLowerCase());
        if (!names.some((n) => n === projLow || projLow.includes(n) || n.includes(projLow))) return false;
      }
      return true;
    });
  }, [workstreams, originFilter, categoryFilter, projectFilter]);

  const allBoardTasks = useMemo(() => {
    if (!kanban) return [];
    return [
      ...kanban.todo,
      ...kanban.assigned,
      ...kanban.in_progress,
      ...kanban.review,
      ...kanban.done,
      ...kanban.failed,
      ...kanban.archived,
    ];
  }, [kanban]);

  const localTriageCounts = useMemo<TriageFunnelCounts>(() => {
    const c: TriageFunnelCounts = {
      totalTodo: 0,
      unreviewed: 0,
      triaging: 0,
      verified: 0,
      needs_scope: 0,
      idea_demoted: 0,
      noise_archived: 0,
      superseded: 0,
    };
    for (const task of allBoardTasks) {
      const t = readTaskTriage(task);
      if (!t) continue;
      if (task.status === "todo") {
        c.totalTodo++;
        if (t.status === "unreviewed") c.unreviewed++;
        else if (t.status === "triaging") c.triaging++;
        else if (t.status === "verified") c.verified++;
        else if (t.status === "needs_scope") c.needs_scope++;
      } else {
        if (t.status === "idea_demoted") c.idea_demoted++;
        else if (t.status === "noise_archived") c.noise_archived++;
        else if (t.status === "superseded") c.superseded++;
      }
    }
    return c;
  }, [allBoardTasks]);

  const funnelCounts = useMemo<TriageFunnelCounts>(() => {
    if (!projectFilter && triageServerCounts) {
      return triageServerCounts;
    }
    return localTriageCounts;
  }, [projectFilter, triageServerCounts, localTriageCounts]);

  const filterTodoByTriage = useCallback(
    (list: PlanningTaskWithSubtasks[]) => {
      if (todoTriageFilter === "all") return list;
      return list.filter((task) => {
        const status = readTaskTriage(task)?.status ?? "unreviewed";
        if (todoTriageFilter === "unreviewed") return status === "unreviewed" || status === "triaging";
        return status === todoTriageFilter;
      });
    },
    [todoTriageFilter],
  );

  const handleUpdateTriageConfig = async (
    patch: Partial<Pick<TriageConfig, "autoSweepEnabled" | "autoRollEnabled" | "useAgyCodeCheck">>,
  ) => {
    if (triageBusy) return;
    setTriageBusy(true);
    setError("");
    try {
      const res = await request<{ config: TriageConfig }>(`${API_BASE}/triage/config`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setTriageConfig({
        autoSweepEnabled: Boolean(res.config.autoSweepEnabled),
        autoRollEnabled: Boolean(res.config.autoRollEnabled),
        useAgyCodeCheck: Boolean(res.config.useAgyCodeCheck),
      });
      setNotice("自动审查与轮动配置已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存自动审查配置失败");
    } finally {
      setTriageBusy(false);
    }
  };

  const handleRunTriageSweep = async () => {
    if (triageBusy || busy) return;
    setTriageBusy(true);
    setError("");
    setTriageReceipt("");
    try {
      const report = await request<TriageRunReport>(`${API_BASE}/triage/sweep`, {
        method: "POST",
        body: JSON.stringify({ dryRun: false }),
      });
      const summary = summarizeTriageReport(report, "sweep");
      setTriageReceipt(summary);
      setNotice(summary);
      await Promise.all([loadKanban(), loadTriageStatus()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "规则清噪执行失败");
    } finally {
      setTriageBusy(false);
    }
  };

  const handleRunTriageOnce = async () => {
    if (triageBusy || busy) return;
    setTriageBusy(true);
    setError("");
    setTriageReceipt("");
    try {
      const report = await request<TriageRunReport>(`${API_BASE}/triage/run-once`, {
        method: "POST",
        body: JSON.stringify({
          dryRun: false,
          useAgyCodeCheck: triageConfig.useAgyCodeCheck,
        }),
      });
      const summary = summarizeTriageReport(report, "run");
      setTriageReceipt(summary);
      setNotice(summary);
      await Promise.all([loadKanban(), loadTriageStatus()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "产研 Bot 批审执行失败");
    } finally {
      setTriageBusy(false);
    }
  };

  const handleTriageSingleTask = async (taskId: string, action: SingleTriageAction) => {
    if (triageBusy || busy) return;
    setTriageBusy(true);
    setError("");
    try {
      const res = await request<{
        task: PlanningTaskWithSubtasks;
        item: TriageRunItemResult;
        funnel: TriageFunnelCounts;
      }>(`${API_BASE}/triage/tasks/${encodeURIComponent(taskId)}`, {
        method: "POST",
        body: JSON.stringify({
          action,
          ...(action === "verify" ? { reason: "人工确认可执行" } : {}),
        }),
      });
      if (res.funnel) setTriageServerCounts(res.funnel);
      const summary = `🤖 单条审查完成（${TRIAGE_LABELS[res.item.nextStatus] ?? res.item.nextStatus}）${
        res.item.reason ? `：${res.item.reason}` : ""
      }`;
      setTriageReceipt(summary);
      setNotice(summary);
      await Promise.all([loadKanban(), loadTriageStatus()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "单条任务审查失败");
    } finally {
      setTriageBusy(false);
    }
  };

  const visibleTreeTasks = useMemo(() => {
    return filterTasks(allBoardTasks).filter((t) => {
      if (t.status === "archived") return false;
      if (t.status !== "todo" || todoTriageFilter === "all") return true;
      const status = readTaskTriage(t)?.status ?? "unreviewed";
      if (todoTriageFilter === "unreviewed") return status === "unreviewed" || status === "triaging";
      return status === todoTriageFilter;
    });
  }, [allBoardTasks, filterTasks, todoTriageFilter]);

  const handleStatusChange = async (taskId: string, nextStatus: PlanningTaskStatus) => {
    setError("");
    // Optimistic update for top-level tasks
    const previous = kanban;
    if (kanban) {
      const cols: Array<keyof Pick<KanbanBoardResponse, "todo" | "assigned" | "in_progress" | "review" | "done" | "failed" | "archived">> = [
        "todo",
        "assigned",
        "in_progress",
        "review",
        "done",
        "failed",
        "archived",
      ];
      let movedTask: PlanningTaskWithSubtasks | null = null;
      const nextBoard: KanbanBoardResponse = {
        ...kanban,
        todo: [...kanban.todo],
        assigned: [...kanban.assigned],
        in_progress: [...kanban.in_progress],
        review: [...kanban.review],
        done: [...kanban.done],
        failed: [...kanban.failed],
        archived: [...kanban.archived],
      };
      for (const col of cols) {
        const idx = nextBoard[col].findIndex((t) => t.id === taskId);
        if (idx !== -1) {
          movedTask = { ...nextBoard[col][idx], status: nextStatus };
          nextBoard[col].splice(idx, 1);
          break;
        }
      }
      if (movedTask) {
        const targetCol = columnForStatus(nextStatus);
        nextBoard[targetCol] = [movedTask, ...nextBoard[targetCol]];
        setKanban(nextBoard);
      }
    }

    try {
      await request<PlanningTaskWithSubtasks>(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadKanban();
      setNotice(`任务状态已更新为 ${STATUS_LABELS[nextStatus]}`);
    } catch (err) {
      if (previous) setKanban(previous);
      setError(err instanceof Error ? err.message : "状态更新失败");
    }
  };

  const handleAssignHuman = async (taskId: string) => {
    setBusy(true);
    setError("");
    try {
      await request<PlanningTaskWithSubtasks>(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/assign-human`, {
        method: "POST",
        body: "{}",
      });
      await loadKanban();
      setNotice("已将任务分配给人类执行");
    } catch (err) {
      setError(err instanceof Error ? err.message : "分配失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDispatch = async (taskId: string, agentId: string, autoCreatePr: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (agentId === "__request_release__") {
        const target = allBoardTasks.find((t) => t.id === taskId);
        if (target?.latestRunId) {
          await request(`/api/opc/domains/factory/runs/${encodeURIComponent(target.latestRunId)}/request-release`, {
            method: "POST",
            body: "{}",
          });
          setNotice("已提交真上线审批包至「总裁审批网关 (#mailbox)」，批准后将自动合入部署。");
        } else {
          await handleStatusChange(taskId, "published");
        }
        return;
      }
      if (agentId === "__auto_quota__") {
        const smartRes = await request<{
          run: { id: string; status: string; agentName: string };
          routing: { chosenAgent: { name: string } | null };
        }>("/api/opc/domains/resources/dispatch-smart", {
          method: "POST",
          body: JSON.stringify({ taskId, autoCreatePr }),
        });
        await loadKanban();
        setNotice(`⚡ 已按实时套餐配额路由至 ${smartRes.run.agentName} · Run ${smartRes.run.id} (${smartRes.run.status})`);
        return;
      }
      const res = await request<{ runId: string; runStatus: string }>(
        `${API_BASE}/tasks/${encodeURIComponent(taskId)}/dispatch`,
        {
          method: "POST",
          body: JSON.stringify({ agentId, autoCreatePr }),
        },
      );
      await loadKanban();
      setNotice(`已派发给 Agent (${agentId}) · Run ${res.runId} (${res.runStatus})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "派发 Agent 失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRecordPomodoro = async (
    taskId: string,
    energyLevel: PlanningEnergyLevel,
    durationMins: number,
    note: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      await request(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/pomodoro`, {
        method: "POST",
        body: JSON.stringify({ energyLevel, durationMins, note }),
      });
      await loadKanban();
      if (activeTab === "roi") await loadRoiAndTrend();
      setNotice(`已完成 1 轮番茄专注（${durationMins}m · ${energyLevel === "high" ? "⚡高能" : "🌙低能"}）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "记录番茄失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateSubtask = async (parent: PlanningTaskWithSubtasks, title: string) => {
    setBusy(true);
    setError("");
    try {
      await request<PlanningTask>(`${API_BASE}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          parentId: parent.id,
          project: parent.project,
          title,
          type: "task",
          priority: parent.priority,
        }),
      });
      await loadKanban();
      setNotice(`已为「${parent.title}」添加子任务`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加子任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setBusy(true);
    setError("");
    try {
      await request(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
      await loadKanban();
      setNotice("已删除任务");
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draftTitle.trim()) return;
    setBusy(true);
    setError("");
    const tags = draftTags
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      if (createMode === "epic") {
        const cleanSubs = epicSubtasks
          .filter((s) => s.title.trim())
          .map((s) => ({ title: s.title.trim(), type: s.type, priority: s.priority }));
        await request(`${API_BASE}/epics`, {
          method: "POST",
          body: JSON.stringify({
            project: draftProject.trim() || "default",
            title: draftTitle.trim(),
            description: draftDesc.trim(),
            priority: draftPriority,
            tags,
            dueAt: draftDueAt ? new Date(draftDueAt).toISOString() : null,
            sourceRef: draftSourceRef.trim() || null,
            subtasks: cleanSubs,
          }),
        });
        setNotice(`已创建 Epic「${draftTitle.trim()}」及 ${cleanSubs.length} 个子任务`);
      } else {
        await request(`${API_BASE}/tasks`, {
          method: "POST",
          body: JSON.stringify({
            project: draftProject.trim() || "default",
            title: draftTitle.trim(),
            description: draftDesc.trim(),
            type: draftType,
            priority: draftPriority,
            tags,
            dueAt: draftDueAt ? new Date(draftDueAt).toISOString() : null,
            sourceRef: draftSourceRef.trim() || null,
          }),
        });
        setNotice(`已创建任务「${draftTitle.trim()}」`);
      }

      setDraftTitle("");
      setDraftDesc("");
      setDraftTags("");
      setDraftDueAt("");
      setDraftSourceRef("");
      setEpicSubtasks([
        { title: "", type: "task", priority: 6 },
        { title: "", type: "task", priority: 5 },
      ]);
      setShowCreator(false);
      await loadKanban();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRunPatrol = async (notifyZoom: boolean) => {
    setBusy(true);
    setError("");
    try {
      const report = await request<PatrolReport>(`${API_BASE}/patrol`, {
        method: "POST",
        body: JSON.stringify({ staleDays: patrolStaleDays, notifyZoom }),
      });
      setLatestPatrol(report);
      await loadPatrolHistory();
      setNotice(
        `巡检完成：发现 ${report.staleCount} 条超期滞留任务、${report.failedCount} 条失败任务${
          report.notifiedZoom ? " · 已推送 Zoom 待办" : ""
        }`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "巡检执行失败");
    } finally {
      setBusy(false);
    }
  };

  const handlePatrolAction = async (
    taskId: string,
    action: "assign" | "archive" | "done" | "todo",
  ) => {
    setBusy(true);
    setError("");
    try {
      if (action === "assign") {
        await request(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/assign-human`, {
          method: "POST",
          body: "{}",
        });
      } else {
        const status: PlanningTaskStatus =
          action === "archive" ? "archived" : action === "done" ? "done" : "todo";
        await request(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        });
      }
      await Promise.all([loadKanban(), handleRunPatrol(false)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "任务处置失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCollectSignals = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await request<{
        collectedCount: number;
        journalSignals: number;
        githubIssueSignals: number;
        promotedCount: number;
      }>(`${PRODUCT_API_BASE}/collect`, {
        method: "POST",
        body: JSON.stringify({ autoPromote: !collectManualOnly }),
      });
      await Promise.all([loadSignals(), loadKanban()]);
      setNotice(
        res.collectedCount > 0
          ? `信号采集完成：新入池 ${res.collectedCount} 条（日读 ${res.journalSignals} · GitHub Issue ${res.githubIssueSignals}），自动立项 ${res.promotedCount} 条`
          : "信号采集完成：当前无新的未采集条目。",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "信号源采集失败");
    } finally {
      setBusy(false);
    }
  };

  const handleIngestSignal = async (e: FormEvent) => {
    e.preventDefault();
    if (!sigTitle.trim()) return;
    setBusy(true);
    setError("");
    const tags = sigTags
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await request<{
        created: boolean;
        signal: ProductSignalItem;
        promotedTask: PlanningTask | null;
      }>(`${PRODUCT_API_BASE}/signals`, {
        method: "POST",
        body: JSON.stringify({
          source: "manual",
          title: sigTitle.trim(),
          projectRef: sigProject.trim() || undefined,
          body: sigBody.trim() || undefined,
          tags,
          autoPromote: !sigManualOnly,
        }),
      });
      setSigTitle("");
      setSigProject("");
      setSigTags("");
      setSigBody("");
      setShowSignalForm(false);
      await Promise.all([loadSignals(), loadKanban()]);
      setNotice(
        res.promotedTask
          ? `信号已入池并自动立项为任务「${res.promotedTask.title}」（得分 ${res.signal.alignmentScore}/100）`
          : `信号已入池待人工筛选：得分 ${res.signal.alignmentScore}/100 · ${SIGNAL_REC_LABELS[res.signal.recommendation] ?? res.signal.recommendation}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "录入信号失败");
    } finally {
      setBusy(false);
    }
  };

  const handlePromoteSignal = async (signal: ProductSignalItem) => {
    setBusy(true);
    setError("");
    try {
      const res = await request<{ signal: ProductSignalItem; task: PlanningTask }>(
        `${PRODUCT_API_BASE}/signals/${encodeURIComponent(signal.id)}/promote`,
        { method: "POST", body: "{}" },
      );
      await Promise.all([loadSignals(), loadKanban()]);
      setNotice(`已将信号转为研发任务「${res.task.title}」，可切到「人机混合看板」分配给人类或 Agent 执行。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "转任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDropSignal = async (signalId: string) => {
    setBusy(true);
    setError("");
    try {
      await request(`${PRODUCT_API_BASE}/signals/${encodeURIComponent(signalId)}/drop`, {
        method: "POST",
        body: "{}",
      });
      await loadSignals();
      setNotice("已丢弃该噪音信号。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "丢弃信号失败");
    } finally {
      setBusy(false);
    }
  };

  // Drag handlers
  const handleDragStart = (e: DragEvent<HTMLElement>, taskId: string) => {
    setDraggingId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverCol(null);
  };

  const handleColDragOver = (e: DragEvent<HTMLElement>, col: KanbanColumnKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== col) setDragOverCol(col);
  };

  const handleColDrop = (e: DragEvent<HTMLElement>, col: KanbanColumnKey) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain") || draggingId;
    setDraggingId(null);
    setDragOverCol(null);
    if (!taskId) return;
    void handleStatusChange(taskId, col);
  };

  // Heatmap 16 weeks x 7 days slicing
  const heatmapWeeks = useMemo(() => {
    const slice = trend.slice(-112);
    const weeks: DailyTrendPoint[][] = [];
    for (let w = 0; w < 16; w++) {
      weeks.push(slice.slice(w * 7, w * 7 + 7));
    }
    return weeks;
  }, [trend]);

  const monthLabels = useMemo(() => {
    let lastMonth = "";
    return heatmapWeeks.map((week) => {
      const first = week[0];
      if (!first) return "";
      const m = first.date.slice(5, 7);
      if (m !== lastMonth) {
        lastMonth = m;
        return `${Number(m)}月`;
      }
      return "";
    });
  }, [heatmapWeeks]);

  const recent14Days = useMemo(() => trend.slice(-14), [trend]);
  const maxTrendVal = useMemo(() => {
    let max = 1;
    for (const pt of recent14Days) {
      max = Math.max(max, pt.completed, pt.agentRuns, pt.pomodoroCount);
    }
    return max;
  }, [recent14Days]);

  const patrolBadgeCount = (latestPatrol?.staleCount ?? 0) + (latestPatrol?.failedCount ?? 0);
  const newSignalBadgeCount = signalCounts?.new ?? 0;

  return (
    <section className="zo-product tp-page" aria-label="情报与产品拆解看板">
      <header className="tp-head">
        <div>
          <div className="tp-title-row">
            {nav}
            <h1>02 · 情报与产品拆解</h1>
          </div>
          <p className="tp-sub">
            情报信号池人工筛选 · Epic → SubTask 任务树 · 人机混合 5 列拖拽看板 · 番茄钟精力追踪 · 巡检卫士 · ROI 热力图
          </p>
          <div className="tp-upstream-links">
            <span>上游输入与专项工作台：</span>
            <a href="#ideas">信息与想法 ↗</a>
            <a href="#metabolism">信息代谢 · 简报 ↗</a>
            <a href="#opportunities">研发选题池 ↗</a>
            <a href="#canvas">无界知识画布 ↗</a>
          </div>
        </div>
        <div className="tp-head-actions">
          <button
            type="button"
            className="tp-primary"
            aria-expanded={showConversation && activeTab === "kanban"}
            onClick={() => {
              setActiveTab("kanban");
              setShowCreator(false);
              setShowConversation(activeTab !== "kanban" || !showConversation);
            }}
          >
            {showConversation && activeTab === "kanban" ? "收起任务对话" : "和 Bot 聊任务"}
          </button>
          <button
            type="button"
            aria-expanded={showCreator && activeTab === "kanban"}
            onClick={() => {
              setActiveTab("kanban");
              setShowConversation(false);
              setShowCreator(activeTab !== "kanban" || !showCreator);
            }}
          >
            {showCreator && activeTab === "kanban" ? "收起手动表单" : "手动新建"}
          </button>
          <button type="button" disabled={busy} onClick={() => void refreshAll()}>
            刷新数据
          </button>
        </div>
      </header>

      <div className="tp-nav-bar">
        <div className="tp-tabs" role="tablist" aria-label="任务规划视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "kanban"}
            onClick={() => setActiveTab("kanban")}
          >
            人机混合看板
            {kanban && <span className="tp-tab-count">{kanban.counts.total}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "signals"}
            onClick={() => setActiveTab("signals")}
          >
            情报信号池
            {newSignalBadgeCount > 0 ? (
              <span className="tp-tab-count warn">{newSignalBadgeCount}</span>
            ) : (
              signalCounts && <span className="tp-tab-count">{signalCounts.total}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "roi"}
            onClick={() => setActiveTab("roi")}
          >
            ROI 仪表盘 & 热力图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "patrol"}
            onClick={() => setActiveTab("patrol")}
          >
            巡检卫士 (Patrol)
            {patrolBadgeCount > 0 && <span className="tp-tab-count warn">{patrolBadgeCount}</span>}
          </button>
        </div>

        {activeTab === "kanban" && (
          <div className="tp-filters">
            <select
              aria-label="按项目筛选"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="">全部项目</option>
              {(kanban?.projects ?? []).map((proj) => (
                <option key={proj} value={proj}>
                  {proj}
                </option>
              ))}
            </select>

            <select
              aria-label="按归属分类筛选"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as "" | WorkspaceCategory)}
            >
              <option value="">全部分类</option>
              {WORKSPACE_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {WORKSPACE_CATEGORY_LABELS[cat]}
                </option>
              ))}
            </select>

            <div className="tp-segmented" role="group" aria-label="任务来源轨道筛选">
              <button
                type="button"
                aria-pressed={originFilter === "all"}
                onClick={() => setOriginFilter("all")}
              >
                双轨全部
              </button>
              <button
                type="button"
                aria-pressed={originFilter === "opc_dispatched"}
                onClick={() => setOriginFilter("opc_dispatched")}
              >
                ⚙ {WORK_ORIGIN_LABELS.opc_dispatched}
              </button>
              <button
                type="button"
                aria-pressed={originFilter === "founder_managed"}
                onClick={() => setOriginFilter("founder_managed")}
              >
                👤 {WORK_ORIGIN_LABELS.founder_managed}
              </button>
            </div>

            <div className="tp-segmented" role="group" aria-label="归属筛选">
              <button
                type="button"
                aria-pressed={assigneeFilter === "all"}
                onClick={() => setAssigneeFilter("all")}
              >
                全部
              </button>
              <button
                type="button"
                aria-pressed={assigneeFilter === "human"}
                onClick={() => setAssigneeFilter("human")}
              >
                ◉ 人类
              </button>
              <button
                type="button"
                aria-pressed={assigneeFilter === "agent"}
                onClick={() => setAssigneeFilter("agent")}
              >
                ◈ Agent
              </button>
            </div>

            <div className="tp-segmented" role="group" aria-label="布局切换">
              <button
                type="button"
                aria-pressed={viewMode === "board"}
                onClick={() => setViewMode("board")}
              >
                看板
              </button>
              <button
                type="button"
                aria-pressed={viewMode === "tree"}
                onClick={() => setViewMode("tree")}
              >
                Epic 树
              </button>
            </div>
          </div>
        )}
      </div>

      {notice && (
        <div role="status" className="tp-banner">
          <span>{notice}</span>
          <button type="button" className="tp-ghost" onClick={() => setNotice("")}>
            关闭
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="tp-banner error">
          <span>{error}</span>
          <button type="button" className="tp-ghost" onClick={() => setError("")}>
            关闭
          </button>
        </div>
      )}

      {/* Create Task / Epic Form */}
      {showConversation && activeTab === "kanban" &&
        <PlanningConversation key={projectFilter} project={projectFilter} onCreated={loadKanban} />}
      {showCreator && activeTab === "kanban" && (
        <form className="tp-creator" onSubmit={(e) => void handleCreateSubmit(e)}>
          <div className="tp-creator-head">
            <h3>{createMode === "epic" ? "新建 Epic 与子任务树" : "新建结构化任务"}</h3>
            <div className="tp-segmented">
              <button
                type="button"
                aria-pressed={createMode === "task"}
                onClick={() => setCreateMode("task")}
              >
                单条任务
              </button>
              <button
                type="button"
                aria-pressed={createMode === "epic"}
                onClick={() => setCreateMode("epic")}
              >
                Epic + 子任务树
              </button>
            </div>
          </div>

          <div className="tp-form-grid">
            <label className="tp-field full">
              标题 *
              <input
                type="text"
                required
                placeholder={createMode === "epic" ? "例：Phase 2 商业闭环上线" : "例：实现虎皮椒 Webhook 验签"}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
              />
            </label>
            <label className="tp-field">
              项目
              <input
                type="text"
                value={draftProject}
                onChange={(e) => setDraftProject(e.target.value)}
                placeholder="default"
              />
            </label>
            {createMode === "task" && (
              <label className="tp-field">
                类型
                <select
                  value={draftType}
                  onChange={(e) => setDraftType(e.target.value as PlanningTaskType)}
                >
                  {PLANNING_TASK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="tp-field">
              优先级 (1低 - 10高)
              <input
                type="number"
                min={1}
                max={10}
                value={draftPriority}
                onChange={(e) => setDraftPriority(Math.max(1, Math.min(10, Number(e.target.value) || 5)))}
              />
            </label>
            <label className="tp-field">
              标签（逗号分隔）
              <input
                type="text"
                placeholder="growth, backend, p0"
                value={draftTags}
                onChange={(e) => setDraftTags(e.target.value)}
              />
            </label>
            <label className="tp-field">
              截止日期
              <input type="date" value={draftDueAt} onChange={(e) => setDraftDueAt(e.target.value)} />
            </label>
            <label className="tp-field">
              来源回链 (sourceRef)
              <input
                type="text"
                placeholder="prd://pagelens-v2 或 #opportunities"
                value={draftSourceRef}
                onChange={(e) => setDraftSourceRef(e.target.value)}
              />
            </label>
            <label className="tp-field full">
              描述与验收标准
              <textarea
                rows={2}
                placeholder="补充上下文、验收标准或交付产物…"
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
              />
            </label>
          </div>

          {createMode === "epic" && (
            <div className="tp-subtask-drafts">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 12.5 }}>子任务列表（同一事务落盘）</strong>
                <button
                  type="button"
                  onClick={() =>
                    setEpicSubtasks((prev) => [...prev, { title: "", type: "task", priority: draftPriority }])
                  }
                >
                  + 加一行子任务
                </button>
              </div>
              {epicSubtasks.map((sub, idx) => (
                <div key={idx} className="tp-subtask-draft-row">
                  <input
                    type="text"
                    placeholder={`子任务 #${idx + 1} 标题`}
                    value={sub.title}
                    onChange={(e) =>
                      setEpicSubtasks((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, title: e.target.value } : item)),
                      )
                    }
                  />
                  <select
                    value={sub.type}
                    onChange={(e) =>
                      setEpicSubtasks((prev) =>
                        prev.map((item, i) =>
                          i === idx ? { ...item, type: e.target.value as PlanningTaskType } : item,
                        ),
                      )
                    }
                  >
                    <option value="task">Task</option>
                    <option value="bug">Bug</option>
                    <option value="prd">PRD</option>
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={sub.priority}
                    onChange={(e) =>
                      setEpicSubtasks((prev) =>
                        prev.map((item, i) =>
                          i === idx ? { ...item, priority: Number(e.target.value) || 5 } : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="tp-ghost"
                    onClick={() => setEpicSubtasks((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="tp-form-actions">
            <button type="button" onClick={() => setShowCreator(false)}>
              取消
            </button>
            <button type="submit" className="tp-primary" disabled={busy || !draftTitle.trim()}>
              {createMode === "epic" ? "一键创建 Epic 任务树" : "保存任务"}
            </button>
          </div>
        </form>
      )}

      {/* ==================== TAB 1: KANBAN / EPIC TREE ==================== */}
      {activeTab === "kanban" && (
        <>
          <section className="tp-triage-bar" aria-label="自动审查漏斗与轮动引擎" data-testid="triage-funnel-bar">
            <div className="tp-triage-head">
              <div className="tp-triage-title">
                <h2>🧹 自动审查漏斗 & 轮动引擎</h2>
                <small>
                  Layer 0 规则清噪 → 产研 Bot 验真分级 → agy 只读复核 → 仅「已验真就绪」进入自动派工队列
                </small>
              </div>
              <div className="tp-triage-funnel" role="group" aria-label="审查漏斗状态筛选">
                <button
                  type="button"
                  className="tp-funnel-chip tone-verified"
                  aria-pressed={todoTriageFilter === "verified"}
                  onClick={() => setTodoTriageFilter("verified")}
                >
                  <span>已验真就绪</span>
                  <strong>{funnelCounts.verified}</strong>
                </button>
                <button
                  type="button"
                  className="tp-funnel-chip tone-unreviewed"
                  aria-pressed={todoTriageFilter === "unreviewed"}
                  onClick={() => setTodoTriageFilter("unreviewed")}
                >
                  <span>待审查</span>
                  <strong>{funnelCounts.unreviewed + funnelCounts.triaging}</strong>
                </button>
                <button
                  type="button"
                  className="tp-funnel-chip tone-scope"
                  aria-pressed={todoTriageFilter === "needs_scope"}
                  onClick={() => setTodoTriageFilter("needs_scope")}
                >
                  <span>需补范围</span>
                  <strong>{funnelCounts.needs_scope}</strong>
                </button>
                <button
                  type="button"
                  className="tp-funnel-chip"
                  aria-pressed={todoTriageFilter === "all"}
                  onClick={() => setTodoTriageFilter("all")}
                >
                  <span>全部 Todo</span>
                  <strong>{kanban ? filterTasks(kanban.todo).length : 0}</strong>
                </button>
                <button
                  type="button"
                  className="tp-funnel-chip tone-idea"
                  title="已降级沉淀到「信息与想法 (#ideas)」并从待办清出"
                  onClick={() => setShowArchiveDrawer(true)}
                >
                  <span>已降级想法</span>
                  <strong>{funnelCounts.idea_demoted}</strong>
                </button>
                <button
                  type="button"
                  className="tp-funnel-chip tone-noise"
                  title="展开下方归档抽屉查看已清理的纯摘要噪音与已替代项"
                  onClick={() => setShowArchiveDrawer(true)}
                >
                  <span>噪音归档</span>
                  <strong>{funnelCounts.noise_archived + funnelCounts.superseded}</strong>
                </button>
              </div>
            </div>

            <div className="tp-triage-controls">
              <div className="tp-triage-btns">
                <button
                  type="button"
                  className="tp-primary"
                  disabled={triageBusy || busy}
                  onClick={() => void handleRunTriageOnce()}
                >
                  {triageBusy ? "产研 Bot 审查中…" : "🧹 规则清噪 + 🤖 产研 Bot 批审"}
                </button>
                <button
                  type="button"
                  disabled={triageBusy || busy}
                  onClick={() => void handleRunTriageSweep()}
                >
                  仅规则清噪
                </button>
              </div>
              <div className="tp-triage-toggles">
                <label className="tp-triage-check">
                  <input
                    type="checkbox"
                    checked={triageConfig.autoSweepEnabled}
                    disabled={triageBusy}
                    onChange={(e) => void handleUpdateTriageConfig({ autoSweepEnabled: e.target.checked })}
                  />
                  <span>自动定时审查</span>
                </label>
                <label className="tp-triage-check">
                  <input
                    type="checkbox"
                    checked={triageConfig.autoRollEnabled}
                    disabled={triageBusy}
                    onChange={(e) => void handleUpdateTriageConfig({ autoRollEnabled: e.target.checked })}
                  />
                  <span>自动轮动派工</span>
                </label>
                <label className="tp-triage-check">
                  <input
                    type="checkbox"
                    checked={triageConfig.useAgyCodeCheck}
                    disabled={triageBusy}
                    onChange={(e) => void handleUpdateTriageConfig({ useAgyCodeCheck: e.target.checked })}
                  />
                  <span>agy 只读代码复核</span>
                </label>
              </div>
            </div>

            {triageReceipt && (
              <div className="tp-triage-receipt" role="status">
                <span>{triageReceipt}</span>
                <button type="button" className="tp-ghost" onClick={() => setTriageReceipt("")}>
                  关闭
                </button>
              </div>
            )}
          </section>

          {/* Dual-Track Herdr / CLI Live Workstream Strip */}
          {workstreams && visibleHerdrTrees.length > 0 && (
            <section className="dt-live-strip" aria-label="Herdr 与 CLI 实时双轨工作带">
              <div className="dt-live-strip-head">
                <h3>
                  <span>⚡ Herdr 实时工作现场（{visibleHerdrTrees.length} 条主线）</span>
                  <span className="dt-pill dt-origin-opc_dispatched">
                    ⚙ OPC 派发 {visibleHerdrTrees.filter((t) => t.originTrack === "opc_dispatched").length}
                  </span>
                  <span className="dt-pill dt-origin-founder_managed">
                    👤 自主跟进 {visibleHerdrTrees.filter((t) => t.originTrack === "founder_managed").length}
                  </span>
                </h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <a href="#activity-index" style={{ fontSize: 12 }}>
                    完整工作现场 ↗
                  </a>
                  <button
                    type="button"
                    className="tp-ghost"
                    onClick={() => setShowLiveStrip((v) => !v)}
                  >
                    {showLiveStrip ? "收起" : "展开"}
                  </button>
                </div>
              </div>
              {showLiveStrip && (
                <div className="dt-live-grid">
                  {visibleHerdrTrees.slice(0, 8).map((tree) => (
                    <article key={tree.id} className="dt-live-card">
                      <div className="dt-live-card-top">
                        <OriginTrackBadge track={tree.originTrack} />
                        <ClassificationBadge
                          classification={tree.classification}
                          editable
                          onChanged={() => void Promise.all([loadWorkstreams(), loadKanban()])}
                        />
                        <HerdrBadge
                          address={tree.address}
                          spaceName={tree.spaceName}
                          subCount={tree.subAgents.length}
                        />
                      </div>
                      <div className="dt-live-card-title" title={tree.title || tree.label}>
                        {tree.effectiveState === "working"
                          ? "⚡ "
                          : tree.effectiveState === "waiting"
                            ? "💬 "
                            : "⏸ "}
                        {tree.title || tree.label}
                      </div>
                      <div className="dt-live-card-foot">
                        <span>
                          {tree.classification?.canonicalProject || tree.spaceName || tree.provider}
                          {tree.subAgents.length > 0 ? ` · ${tree.subAgents.length} 子 worker` : ""}
                        </span>
                        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                          <HerdrActions
                            address={tree.address}
                            compact
                            onSent={() => void loadWorkstreams()}
                          />
                          {tree.linkedTaskId ? (
                            <a
                              className="dt-pill dt-linked-task"
                              href={`#planning?task=${encodeURIComponent(tree.linkedTaskId)}`}
                            >
                              ✓ 已绑定任务 ↗
                            </a>
                          ) : (
                            <button
                              type="button"
                              className="dt-mini-btn"
                              disabled={promotingHerdrId === tree.id}
                              onClick={() => void handlePromoteWorkstream(tree)}
                            >
                              {promotingHerdrId === tree.id ? "纳入中…" : "📌 纳入看板同步"}
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {!kanban ? (
            <p role="status">正在加载任务看板…</p>
          ) : viewMode === "board" ? (
            <>
              <div className="tp-board" role="region" aria-label="人机混合五列看板" tabIndex={0}>
                {KANBAN_COLUMNS.map((col) => {
                  const baseItems = filterTasks(kanban[col.key]);
                  const items = col.key === "todo" ? filterTodoByTriage(baseItems) : baseItems;
                  const todoHint =
                    col.key === "todo"
                      ? todoTriageFilter === "verified"
                        ? "已验真就绪"
                        : todoTriageFilter === "unreviewed"
                          ? "待审查"
                          : todoTriageFilter === "needs_scope"
                            ? "需补范围"
                            : col.hint
                      : col.hint;
                  return (
                    <section
                      key={col.key}
                      className={`tp-col${dragOverCol === col.key ? " is-drag-over" : ""}`}
                      aria-label={`${col.label} 列`}
                      onDragOver={(e) => handleColDragOver(e, col.key)}
                      onDragLeave={() => {
                        if (dragOverCol === col.key) setDragOverCol(null);
                      }}
                      onDrop={(e) => handleColDrop(e, col.key)}
                    >
                      <header className="tp-col-head">
                        <div className="tp-col-title">
                          <span className={`tp-col-dot ${col.key}`} />
                          <span>{col.label}</span>
                          <small style={{ fontWeight: 400, color: "#616e65", fontSize: 11 }}>{todoHint}</small>
                        </div>
                        <span className="tp-col-count">
                          {col.key === "todo" && todoTriageFilter !== "all"
                            ? `${items.length}/${baseItems.length}`
                            : items.length}
                        </span>
                      </header>
                      <div className="tp-col-body">
                        {items.length === 0 ? (
                          col.key === "todo" && todoTriageFilter === "verified" && baseItems.length > 0 ? (
                            <div className="tp-todo-filter-hint">
                              <span>
                                已验真就绪 0 项（当前还有 {baseItems.length} 项待审查/需补范围已折叠，避免刷屏）
                              </span>
                              <div className="tp-todo-filter-hint-actions">
                                <button
                                  type="button"
                                  className="tp-primary"
                                  disabled={triageBusy || busy}
                                  onClick={() => void handleRunTriageOnce()}
                                >
                                  🧹 清噪 + 🤖 Bot 批审
                                </button>
                                <button
                                  type="button"
                                  className="tp-ghost"
                                  onClick={() => setTodoTriageFilter("unreviewed")}
                                >
                                  查看待审查 ({funnelCounts.unreviewed + funnelCounts.triaging})
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="tp-col-empty">拖拽任务卡片到此处</div>
                          )
                        ) : (
                          items.map((task) => (
                            <TaskCard
                              key={task.id}
                              task={task}
                              agents={kanban.agents}
                              busy={busy || triageBusy}
                              isDragging={draggingId === task.id}
                              onDragStart={handleDragStart}
                              onDragEnd={handleDragEnd}
                              onStatusChange={handleStatusChange}
                              onAssignHuman={handleAssignHuman}
                              onDispatch={handleDispatch}
                              onRecordPomodoro={handleRecordPomodoro}
                              onCreateSubtask={handleCreateSubtask}
                              onDeleteTask={handleDeleteTask}
                              onTriageTask={handleTriageSingleTask}
                            />
                          ))
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>

              {/* Collapsible Failed / Archived Drawer */}
              <section className="tp-drawer" aria-label="失败与已归档抽屉">
                <div
                  className="tp-drawer-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={showArchiveDrawer}
                  onClick={() => setShowArchiveDrawer((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setShowArchiveDrawer((v) => !v);
                    }
                  }}
                >
                  <strong>
                    {showArchiveDrawer ? "▾" : "▸"} Failed / Archived 抽屉
                  </strong>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span className="tp-pill prio-high mono">Failed: {filterTasks(kanban.failed).length}</span>
                    <span className="tp-pill mono">Archived: {filterTasks(kanban.archived).length}</span>
                  </div>
                </div>
                {showArchiveDrawer && (
                  <div className="tp-drawer-body">
                    {[...filterTasks(kanban.failed), ...filterTasks(kanban.archived)].length === 0 ? (
                      <div style={{ fontSize: 12.5, color: "#657268" }}>暂无失败或已归档任务。</div>
                    ) : (
                      [...filterTasks(kanban.failed), ...filterTasks(kanban.archived)].map((task) => {
                        const triage = readTaskTriage(task);
                        return (
                        <div key={task.id} className="tp-card" style={{ cursor: "default" }}>
                          <div className={`tp-card-prio-bar ${task.status === "failed" ? "high" : "low"}`} />
                          <div className="tp-card-top">
                            <span className={`tp-pill ${task.status === "failed" ? "prio-high" : ""}`}>
                              {STATUS_LABELS[task.status]}
                            </span>
                            <span className="tp-pill">{task.project}</span>
                            <span className="tp-pill mono">P{task.priority}</span>
                            {triage && (
                              <span className={`tp-pill triage-${triage.status}`}>
                                {TRIAGE_LABELS[triage.status]}
                              </span>
                            )}
                          </div>
                          <div className="tp-card-title">{task.title}</div>
                          {triage?.reason && (
                            <div className="tp-triage-reason" title={triage.reason}>
                              🤖 {triage.reason}
                            </div>
                          )}
                          <div className="tp-card-actions">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleStatusChange(task.id, "todo")}
                            >
                              恢复 Todo
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleAssignHuman(task.id)}
                            >
                              ◉ 分给我
                            </button>
                            <button
                              type="button"
                              className="tp-danger"
                              disabled={busy}
                              onClick={() => void handleDeleteTask(task.id)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        );
                      })
                    )}
                  </div>
                )}
              </section>
            </>
          ) : (
            /* Epic Tree View */
            <div className="tp-tree" aria-label="Epic 任务树视图">
              {visibleTreeTasks.length === 0 ? (
                <div className="tp-panel">暂无符合筛选条件的任务或 Epic。</div>
              ) : (
                visibleTreeTasks.map((task) => {
                  const pct =
                    task.subtaskStats.total > 0
                      ? Math.round((task.subtaskStats.done / task.subtaskStats.total) * 100)
                      : task.status === "done" || task.status === "published"
                        ? 100
                        : 0;
                  const triage = readTaskTriage(task);
                  return (
                    <div key={task.id} className="tp-tree-node">
                      <div className="tp-tree-head">
                        <div style={{ display: "grid", gap: 6 }}>
                          <div className="tp-card-top">
                            <span className={`tp-pill mono prio-${priorityTier(task.priority)}`}>
                              P{task.priority}
                            </span>
                            <span className={`tp-pill type-${task.type}`}>{TYPE_LABELS[task.type]}</span>
                            <span className="tp-pill">{task.project}</span>
                            <span className="tp-pill">{STATUS_LABELS[task.status]}</span>
                            {triage && (
                              <span className={`tp-pill triage-${triage.status}`}>
                                {TRIAGE_LABELS[triage.status]}
                              </span>
                            )}
                            <span className={`tp-pill ${task.assigneeType}`}>
                              {task.assigneeType === "agent" ? "◈ " : "◉ "}
                              {task.assigneeName || task.assigneeId || "未分配"}
                            </span>
                            <span className="tp-pill pomo mono">🍅 {task.pomodoroCount}</span>
                          </div>
                          <h3>{task.title}</h3>
                          {task.description && <p className="tp-sub">{task.description}</p>}
                        </div>

                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                          <span className="tp-pill mono">
                            {task.subtaskStats.total > 0
                              ? `${task.subtaskStats.done}/${task.subtaskStats.total} sub (${pct}%)`
                              : `${pct}%`}
                          </span>
                          <select
                            value={task.status}
                            disabled={busy}
                            onChange={(e) => void handleStatusChange(task.id, e.target.value as PlanningTaskStatus)}
                          >
                            {PLANNING_TASK_STATUSES.map((st) => (
                              <option key={st} value={st}>
                                {STATUS_LABELS[st]}
                              </option>
                            ))}
                          </select>
                          <button type="button" disabled={busy} onClick={() => void handleAssignHuman(task.id)}>
                            ◉ 分给我
                          </button>
                        </div>
                      </div>

                      <div className="tp-mini-track" style={{ height: 6 }}>
                        <div className="tp-mini-fill" style={{ width: `${pct}%` }} />
                      </div>

                      {task.subtasks.length > 0 && (
                        <div className="tp-tree-children">
                          {task.subtasks.map((sub) => (
                            <div key={sub.id} className="tp-tree-child">
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                                <span className={`tp-pill mono prio-${priorityTier(sub.priority)}`}>
                                  P{sub.priority}
                                </span>
                                <span className={`tp-pill type-${sub.type}`}>{TYPE_LABELS[sub.type]}</span>
                                <strong style={{ fontSize: 13 }}>{sub.title}</strong>
                                <span className={`tp-pill ${sub.assigneeType}`}>
                                  {sub.assigneeType === "agent" ? "◈ " : "◉ "}
                                  {sub.assigneeName || sub.assigneeId || "人类"}
                                </span>
                                <span className="tp-pill pomo mono">🍅 {sub.pomodoroCount}</span>
                              </div>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <select
                                  value={sub.status}
                                  disabled={busy}
                                  onChange={(e) =>
                                    void handleStatusChange(sub.id, e.target.value as PlanningTaskStatus)
                                  }
                                >
                                  {PLANNING_TASK_STATUSES.map((st) => (
                                    <option key={st} value={st}>
                                      {STATUS_LABELS[st]}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="tp-ghost"
                                  disabled={busy}
                                  onClick={() => void handleAssignHuman(sub.id)}
                                >
                                  分给我
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </>
      )}

      {/* ==================== TAB 1.5: INTELLIGENCE SIGNAL POOL ==================== */}
      {activeTab === "signals" && (
        <div className="tp-signals-wrap" data-testid="product-signals-panel">
          <div className="tp-signals-toolbar">
            <div className="tp-segmented" role="group" aria-label="信号状态筛选">
              {(
                [
                  { id: "all", label: `全部 (${signalCounts?.total ?? signals.length})` },
                  { id: "new", label: `待筛选 (${signalCounts?.new ?? 0})` },
                  { id: "promoted", label: `已立项 (${signalCounts?.promoted ?? 0})` },
                  { id: "dropped", label: `已丢弃 (${signalCounts?.dropped ?? 0})` },
                  { id: "blocked", label: `已拦截 (${signalCounts?.blocked ?? 0})` },
                ] as Array<{ id: SignalStatus | "all"; label: string }>
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={signalStatusFilter === item.id}
                  onClick={() => setSignalStatusFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="tp-signals-actions">
              <label className="tp-signals-check">
                <input
                  type="checkbox"
                  checked={collectManualOnly}
                  onChange={(e) => setCollectManualOnly(e.target.checked)}
                />
                <span>仅采集入池，让我人工筛选</span>
              </label>
              <button
                type="button"
                className="tp-primary"
                disabled={busy}
                onClick={() => void handleCollectSignals()}
              >
                🔍 立即采集信号源
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowSignalForm((v) => !v)}
              >
                {showSignalForm ? "收起录入" : "+ 手工录入信号"}
              </button>
            </div>
          </div>

          {showSignalForm && (
            <form className="tp-creator" onSubmit={(e) => void handleIngestSignal(e)}>
              <div className="tp-creator-head">
                <h3>手工录入情报 / 想法（自动按长期主线与习惯规则打分）</h3>
              </div>
              <div className="tp-creator-grid">
                <label className="tp-field span-2">
                  标题 *
                  <input
                    value={sigTitle}
                    onChange={(e) => setSigTitle(e.target.value)}
                    placeholder="例如：PageLens 离线导出字幕支持 SRT / Markdown"
                    required
                  />
                </label>
                <label className="tp-field">
                  归属项目 / 仓库（留空自动匹配）
                  <input
                    value={sigProject}
                    onChange={(e) => setSigProject(e.target.value)}
                    placeholder="PageLens / opc-os"
                  />
                </label>
                <label className="tp-field">
                  标签（逗号或空格分隔）
                  <input
                    value={sigTags}
                    onChange={(e) => setSigTags(e.target.value)}
                    placeholder="离线优先, 变现闭环"
                  />
                </label>
                <label className="tp-field span-2">
                  背景与验收要点
                  <textarea
                    rows={2}
                    value={sigBody}
                    onChange={(e) => setSigBody(e.target.value)}
                    placeholder="补充上下文、预期验收标准或原链接"
                  />
                </label>
              </div>
              <div className="tp-creator-foot">
                <label className="tp-signals-check">
                  <input
                    type="checkbox"
                    checked={sigManualOnly}
                    onChange={(e) => setSigManualOnly(e.target.checked)}
                  />
                  <span>先打分入池，由我决定是否转为研发任务</span>
                </label>
                <button type="submit" className="tp-primary" disabled={busy || !sigTitle.trim()}>
                  提交评估入池
                </button>
              </div>
            </form>
          )}

          {signals.length === 0 ? (
            <div className="tp-panel" style={{ textAlign: "center", color: "#5e6a61", padding: "32px 18px" }}>
              当前筛选下暂无情报信号。点击上方「🔍 立即采集信号源」从日读与 GitHub Issue 汇聚候选条目，或点「+ 手工录入信号」直接输入想法并试算主线匹配分。
            </div>
          ) : (
            <div className="tp-signals-list">
              {signals.map((sig) => (
                <article
                  key={sig.id}
                  className={`tp-signal-card status-${sig.status}`}
                  data-testid={`signal-card-${sig.id}`}
                >
                  <div className="tp-signal-head">
                    <div>
                      <div className="tp-signal-title">{sig.title}</div>
                      <div className="tp-signal-meta">
                        <span className="tp-pill">{SIGNAL_STATUS_LABELS[sig.status]}</span>
                        <span className="tp-pill">{SIGNAL_REC_LABELS[sig.recommendation] ?? sig.recommendation}</span>
                        <span>来源：{sig.source}</span>
                        <span>项目：{sig.projectRef}</span>
                        <span>{formatShortTime(sig.createdAt)}</span>
                      </div>
                    </div>
                    <span
                      className={`tp-signal-score ${
                        sig.alignmentScore >= 70 ? "high" : sig.alignmentScore < 45 ? "low" : ""
                      }`}
                    >
                      对齐分 {sig.alignmentScore} / 100
                    </span>
                  </div>

                  {sig.scoreSummary && <p className="tp-signal-summary">{sig.scoreSummary}</p>}
                  {sig.body && <p className="tp-signal-body">{sig.body}</p>}

                  <div className="tp-signal-foot">
                    <div className="tp-signal-meta">
                      {sig.tags.map((tag) => (
                        <span key={tag} className="tp-pill mono">
                          #{tag}
                        </span>
                      ))}
                    </div>
                    <div className="tp-alert-actions">
                      {sig.status === "promoted" && sig.promotedTaskId ? (
                        <button
                          type="button"
                          className="tp-primary"
                          onClick={() => setActiveTab("kanban")}
                        >
                          已转任务 ({sig.promotedTaskId.slice(0, 12)}) · 去看板查看 →
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="tp-primary"
                            disabled={busy}
                            onClick={() => void handlePromoteSignal(sig)}
                          >
                            → 转为研发任务
                          </button>
                          {sig.status !== "dropped" && (
                            <button
                              type="button"
                              className="tp-ghost"
                              disabled={busy}
                              onClick={() => void handleDropSignal(sig.id)}
                            >
                              ✕ 丢弃噪音
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 2: ROI DASHBOARD & HEATMAP ==================== */}
      {activeTab === "roi" && (
        <div>
          <div className="tp-roi-head">
            <h2 style={{ fontSize: 21 }}>投入产出 ROI 仪表盘</h2>
            <div className="tp-segmented" role="group" aria-label="统计周期">
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={roiDays === d}
                  onClick={() => setRoiDays(d)}
                >
                  近 {d} 天
                </button>
              ))}
            </div>
          </div>

          {!roi ? (
            <p role="status">正在汇总 ROI 与趋势数据…</p>
          ) : (
            <>
              <div className="tp-kpis" aria-label="ROI 核心指标">
                <div className="tp-kpi green">
                  <span>任务完成数与完成率（近 {roi.days} 天）</span>
                  <strong>
                    {roi.tasks.completed} / {roi.tasks.total}
                  </strong>
                  <small>完成率 {roi.tasks.completionRate.toFixed(1)}%</small>
                </div>
                <div className="tp-kpi teal">
                  <span>Agent 执行次数与算力成本</span>
                  <strong>{formatUsd(roi.agents.totalCostUsd)}</strong>
                  <small>
                    {roi.agents.totalRuns} 次运行 · {formatTokens(roi.agents.totalTokensUsed)} tokens
                  </small>
                </div>
                <div className="tp-kpi amber">
                  <span>人类专注番茄与折算工时</span>
                  <strong>{roi.human.totalPomodoros} 🍅</strong>
                  <small>折算深度工时 {roi.human.estimatedHours.toFixed(2)} 小时</small>
                </div>
                <div className="tp-kpi ochre">
                  <span>高能状态占比（精力追踪）</span>
                  <strong>{roi.human.highEnergyRate.toFixed(1)}%</strong>
                  <small>
                    ⚡高能 {roi.human.highEnergyCount} 轮 · 🌙低能 {roi.human.lowEnergyCount} 轮
                  </small>
                </div>
              </div>

              {/* Status Distribution Progress Bar */}
              <section className="tp-panel" aria-label="任务状态分布">
                <div className="tp-panel-head">
                  <h2>任务完成率与状态分布</h2>
                  <span className="tp-pill mono">完成率 {roi.tasks.completionRate.toFixed(1)}%</span>
                </div>
                <div className="tp-status-bar">
                  {roi.tasks.total > 0 &&
                    roi.tasks.byStatus.map((item) => (
                      <div
                        key={item.status}
                        className="tp-status-seg"
                        title={`${STATUS_LABELS[item.status]}: ${item.count}`}
                        style={{
                          width: `${(item.count / roi.tasks.total) * 100}%`,
                          background: STATUS_COLORS[item.status],
                        }}
                      />
                    ))}
                </div>
                <div className="tp-legend">
                  {roi.tasks.byStatus.length === 0 ? (
                    <span>统计周期内暂无任务</span>
                  ) : (
                    roi.tasks.byStatus.map((item) => (
                      <span key={item.status} className="tp-legend-item">
                        <span
                          className="tp-legend-swatch"
                          style={{ background: STATUS_COLORS[item.status] }}
                        />
                        {STATUS_LABELS[item.status]}: <strong>{item.count}</strong>
                      </span>
                    ))
                  )}
                </div>
              </section>

              {/* 16-Week Heatmap & 14-Day Trend Bar Chart */}
              <div className="tp-charts-grid">
                <section className="tp-panel" aria-label="16 周活动热力图">
                  <div className="tp-panel-head">
                    <h2>16 周活动热力图（112 天）</h2>
                    <span className="tp-pill mono">7 × 16 矩阵</span>
                  </div>
                  <div className="tp-heatmap-wrap">
                    <div className="tp-heatmap-months">
                      <span />
                      {monthLabels.map((m, idx) => (
                        <span key={idx}>{m}</span>
                      ))}
                    </div>
                    <div className="tp-heatmap-body">
                      <div className="tp-heatmap-weekdays">
                        <span>一</span>
                        <span />
                        <span>三</span>
                        <span />
                        <span>五</span>
                        <span />
                        <span>日</span>
                      </div>
                      {heatmapWeeks.map((week, wIdx) => (
                        <div key={wIdx} className="tp-heatmap-week">
                          {week.map((pt) => {
                            const lvl = heatLevel(pt);
                            const tip = `${pt.date} · 完成 ${pt.completed} / 新建 ${pt.created} / Agent ${pt.agentRuns} / 番茄 ${pt.pomodoroCount} (⚡${pt.highEnergyPomodoros})`;
                            return (
                              <div
                                key={pt.date}
                                className={`tp-heat-cell lvl-${lvl}${
                                  selectedHeatDay?.date === pt.date ? " is-selected" : ""
                                }`}
                                title={tip}
                                onMouseEnter={() => setSelectedHeatDay(pt)}
                                onClick={() => setSelectedHeatDay(pt)}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="tp-heatmap-foot">
                    <div>
                      {selectedHeatDay ? (
                        <span>
                          <strong>{selectedHeatDay.date}</strong>：完成 {selectedHeatDay.completed} · 新建{" "}
                          {selectedHeatDay.created} · Agent {selectedHeatDay.agentRuns} 次 · 番茄{" "}
                          {selectedHeatDay.pomodoroCount} 个（⚡高能 {selectedHeatDay.highEnergyPomodoros}）
                        </span>
                      ) : (
                        <span>悬停任意方格查看每日明细</span>
                      )}
                    </div>
                    <div className="tp-heat-scale">
                      <span>少</span>
                      <span className="tp-heat-swatch lvl-0" style={{ background: "#efede3" }} />
                      <span className="tp-heat-swatch lvl-1" style={{ background: "#c6dccb" }} />
                      <span className="tp-heat-swatch lvl-2" style={{ background: "#83b293" }} />
                      <span className="tp-heat-swatch lvl-3" style={{ background: "#4a8362" }} />
                      <span className="tp-heat-swatch lvl-4" style={{ background: "#2f513e" }} />
                      <span>多</span>
                    </div>
                  </div>
                </section>

                <section className="tp-panel" aria-label="14 天趋势对比柱图">
                  <div className="tp-panel-head">
                    <h2>近 14 天交付与投入趋势</h2>
                    <div className="tp-legend" style={{ gap: 10 }}>
                      <span className="tp-legend-item">
                        <span className="tp-legend-swatch" style={{ background: "#2f513e" }} />
                        完成
                      </span>
                      <span className="tp-legend-item">
                        <span className="tp-legend-swatch" style={{ background: "#1f6e78" }} />
                        Agent
                      </span>
                      <span className="tp-legend-item">
                        <span className="tp-legend-swatch" style={{ background: "#b8761c" }} />
                        番茄
                      </span>
                    </div>
                  </div>
                  <div className="tp-trend-chart">
                    {recent14Days.map((pt) => {
                      const hDone = Math.round((pt.completed / maxTrendVal) * 100);
                      const hAgent = Math.round((pt.agentRuns / maxTrendVal) * 100);
                      const hPomo = Math.round((pt.pomodoroCount / maxTrendVal) * 100);
                      return (
                        <div
                          key={pt.date}
                          className="tp-trend-day"
                          title={`${pt.date}: 完成 ${pt.completed} / Agent ${pt.agentRuns} / 番茄 ${pt.pomodoroCount}`}
                        >
                          <div className="tp-trend-bars">
                            <div
                              className="tp-trend-bar completed"
                              style={{ height: `${Math.max(2, hDone)}%` }}
                            />
                            <div
                              className="tp-trend-bar agent"
                              style={{ height: `${Math.max(2, hAgent)}%` }}
                            />
                            <div
                              className="tp-trend-bar pomo"
                              style={{ height: `${Math.max(2, hPomo)}%` }}
                            />
                          </div>
                          <span className="tp-trend-date">{pt.date.slice(5)}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>

              {/* Epic & Project ROI Table */}
              <section className="tp-panel" aria-label="Epic 与项目级 ROI 投入产出表">
                <div className="tp-panel-head">
                  <h2>Epic & 项目级 ROI 投入产出表</h2>
                  <span className="tp-pill mono">{roi.epicRoi.length} 项汇总</span>
                </div>
                <div className="tp-table-wrap opc-table-scroll" role="region" aria-label="项目投入产出" tabIndex={0}>
                  <table className="tp-table">
                    <thead>
                      <tr>
                        <th>层级</th>
                        <th>名称</th>
                        <th>所属项目</th>
                        <th className="num">完成 / 总数</th>
                        <th className="num">人类番茄 / 工时</th>
                        <th className="num">Agent 成本</th>
                        <th className="num">关联营收</th>
                        <th className="num">单完成任务成本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roi.epicRoi.length === 0 ? (
                        <tr>
                          <td colSpan={8} style={{ textAlign: "center", color: "#68756b" }}>
                            暂无项目或 Epic 统计记录
                          </td>
                        </tr>
                      ) : (
                        roi.epicRoi.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <span className={`tp-pill ${row.kind === "epic" ? "type-epic" : ""}`}>
                                {row.kind === "epic" ? "Epic" : "项目"}
                              </span>
                            </td>
                            <td>
                              <strong>{row.name}</strong>
                            </td>
                            <td>{row.project}</td>
                            <td className="num">
                              {row.completedTasks} / {row.totalTasks}
                            </td>
                            <td className="num">
                              {row.pomodoros} 🍅 ({row.humanHours.toFixed(2)}h)
                            </td>
                            <td className="num">{formatUsd(row.agentCostUsd)}</td>
                            <td className="num" style={{ color: row.revenueUsd > 0 ? "#2f513e" : undefined }}>
                              {formatUsd(row.revenueUsd)}
                            </td>
                            <td className="num">
                              {row.costPerCompletedTask !== null ? formatUsd(row.costPerCompletedTask) : "—"}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      )}

      {/* ==================== TAB 3: PATROL GUARD ==================== */}
      {activeTab === "patrol" && (
        <div>
          <div className="tp-patrol-controls">
            <label>
              滞留判定阈值（天）
              <input
                type="number"
                min={1}
                max={365}
                value={patrolStaleDays}
                onChange={(e) => setPatrolStaleDays(Math.max(1, Math.min(365, Number(e.target.value) || 7)))}
              />
            </label>
            <button
              type="button"
              className="tp-primary"
              disabled={busy}
              onClick={() => void handleRunPatrol(false)}
            >
              立即执行巡检
            </button>
            <button
              type="button"
              className="tp-danger"
              disabled={busy}
              onClick={() => void handleRunPatrol(true)}
            >
              巡检并推送 Zoom 待办
            </button>
          </div>

          {latestPatrol && (
            <>
              <section className="tp-panel" aria-label="超期滞留任务">
                <div className="tp-panel-head">
                  <h2>滞留任务告警（超过 {latestPatrol.staleDays} 天未推进）</h2>
                  <span className={`tp-pill mono${latestPatrol.staleCount > 0 ? " prio-high" : ""}`}>
                    {latestPatrol.staleCount} 条滞留
                  </span>
                </div>
                {latestPatrol.staleTasks.length === 0 ? (
                  <p className="tp-sub">当前所有活跃任务均在正常节奏内，无超期滞留。</p>
                ) : (
                  <div className="tp-alert-list">
                    {latestPatrol.staleTasks.map((alert) => (
                      <div key={alert.taskId} className="tp-alert-row">
                        <div className="tp-alert-info">
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                            <span className="tp-pill prio-high mono">滞留 {alert.staleDays} 天</span>
                            <span className="tp-pill">{alert.project}</span>
                            <span className="tp-pill">{STATUS_LABELS[alert.status]}</span>
                            <strong>{alert.title}</strong>
                          </div>
                          <small style={{ color: "#5c685f" }}>
                            负责人：{alert.assigneeName || (alert.assigneeType === "agent" ? "Agent" : "人类")} ·
                            最后更新：{formatShortTime(alert.updatedAt)}
                          </small>
                        </div>
                        <div className="tp-alert-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePatrolAction(alert.taskId, "assign")}
                          >
                            重新分配给我
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePatrolAction(alert.taskId, "archive")}
                          >
                            归档
                          </button>
                          <button
                            type="button"
                            className="tp-primary"
                            disabled={busy}
                            onClick={() => void handlePatrolAction(alert.taskId, "done")}
                          >
                            标为完成
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="tp-panel" aria-label="失败异常任务">
                <div className="tp-panel-head">
                  <h2>失败任务告警 (Failed)</h2>
                  <span className={`tp-pill mono${latestPatrol.failedCount > 0 ? " prio-high" : ""}`}>
                    {latestPatrol.failedCount} 条失败
                  </span>
                </div>
                {latestPatrol.failedTasks.length === 0 ? (
                  <p className="tp-sub">当前无失败异常任务。</p>
                ) : (
                  <div className="tp-alert-list">
                    {latestPatrol.failedTasks.map((alert) => (
                      <div key={alert.taskId} className="tp-alert-row failed">
                        <div className="tp-alert-info">
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                            <span className="tp-pill prio-high">Failed</span>
                            <span className="tp-pill">{alert.project}</span>
                            <strong>{alert.title}</strong>
                          </div>
                          <small style={{ color: "#5c685f" }}>
                            负责人：{alert.assigneeName || (alert.assigneeType === "agent" ? "Agent" : "人类")} ·
                            更新时间：{formatShortTime(alert.updatedAt)}
                          </small>
                        </div>
                        <div className="tp-alert-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePatrolAction(alert.taskId, "assign")}
                          >
                            重新分配给我
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePatrolAction(alert.taskId, "todo")}
                          >
                            重开 Todo
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePatrolAction(alert.taskId, "archive")}
                          >
                            归档
                          </button>
                          <button
                            type="button"
                            className="tp-primary"
                            disabled={busy}
                            onClick={() => void handlePatrolAction(alert.taskId, "done")}
                          >
                            标为完成
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          <section className="tp-panel" aria-label="历史巡检记录">
            <div className="tp-panel-head">
              <h2>最近巡检记录历史</h2>
              <span className="tp-pill mono">{patrolHistory.length} 次记录</span>
            </div>
            <div className="tp-table-wrap opc-table-scroll" role="region" aria-label="任务巡检记录" tabIndex={0}>
              <table className="tp-table">
                <thead>
                  <tr>
                    <th>巡检时间</th>
                    <th className="num">滞留阈值</th>
                    <th className="num">滞留数</th>
                    <th className="num">失败数</th>
                    <th>Zoom 通知</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {patrolHistory.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", color: "#68756b" }}>
                        尚未执行巡检，点击上方「立即执行巡检」开始扫描。
                      </td>
                    </tr>
                  ) : (
                    patrolHistory.map((run) => (
                      <tr key={run.id}>
                        <td className="num" style={{ textAlign: "left" }}>
                          {formatShortTime(run.createdAt)}
                        </td>
                        <td className="num">&gt; {run.staleDays} 天</td>
                        <td className="num">{run.staleCount}</td>
                        <td className="num">{run.failedCount}</td>
                        <td>
                          <span className={`tp-pill ${run.notifiedZoom ? "published" : ""}`}>
                            {run.notifiedZoom ? "已推送 Zoom" : "仅本地记录"}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="tp-ghost"
                            onClick={() => setLatestPatrol(run)}
                          >
                            查看详情
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
