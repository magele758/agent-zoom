import type {
  ExternalSessionBinding,
  WorkOriginTrack,
  WorkspaceClassification,
} from "./workspace-classification-types.ts";

export const PLANNING_TASK_TYPES = ["epic", "task", "bug", "prd"] as const;
export type PlanningTaskType = (typeof PLANNING_TASK_TYPES)[number];

export const PLANNING_TASK_STATUSES = [
  "todo",
  "assigned",
  "in_progress",
  "pr_open",
  "review",
  "done",
  "failed",
  "archived",
  "published",
] as const;
export type PlanningTaskStatus = (typeof PLANNING_TASK_STATUSES)[number];

export const PLANNING_ASSIGNEE_TYPES = ["human", "agent"] as const;
export type PlanningAssigneeType = (typeof PLANNING_ASSIGNEE_TYPES)[number];

export const PLANNING_ENERGY_LEVELS = ["high", "low"] as const;
export type PlanningEnergyLevel = (typeof PLANNING_ENERGY_LEVELS)[number];

export type KanbanColumnKey = "todo" | "assigned" | "in_progress" | "review" | "done";

export interface PlanningTask {
  id: string;
  project: string;
  parentId: string | null;
  title: string;
  description: string;
  type: PlanningTaskType;
  status: PlanningTaskStatus;
  /** Priority from 1 (lowest) to 10 (highest). */
  priority: number;
  tags: string[];
  dueAt: string | null;
  assigneeType: PlanningAssigneeType;
  assigneeId: string | null;
  assigneeName: string | null;
  pomodoroCount: number;
  energyLevel: PlanningEnergyLevel | null;
  sourceRef: string | null;
  latestRunId: string | null;
  prUrl: string | null;
  tokenUsed: number;
  costUsd: number;
  dependsOn: string[];
  snoozedUntil: string | null;
  verifyCommand: string;
  mainlineId: string | null;
  assetId: string | null;
  metadata: Record<string, unknown>;
  /** 双轨来源：OPC OS 派发 vs 创始人自主跟进。 */
  originTrack?: WorkOriginTrack;
  /** 统一归属分类（公司产品 / 研发基建 / 个人事项）。 */
  classification?: WorkspaceClassification;
  /** 已绑定的 Herdr / CLI 外部实时会话。 */
  externalSession?: ExternalSessionBinding | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function extractExternalSession(
  metadata?: Record<string, unknown> | null,
): ExternalSessionBinding | null {
  const raw =
    metadata &&
    typeof metadata === "object" &&
    metadata.externalSession &&
    typeof metadata.externalSession === "object" &&
    !Array.isArray(metadata.externalSession)
      ? (metadata.externalSession as Record<string, unknown>)
      : null;
  if (!raw) return null;
  const sessionId = typeof raw.sessionId === "string" && raw.sessionId.trim() ? raw.sessionId.trim() : null;
  const herdrAddress =
    typeof raw.herdrAddress === "string" && raw.herdrAddress.trim() ? raw.herdrAddress.trim() : null;
  if (!sessionId && !herdrAddress) return null;
  return {
    sessionId,
    herdrAddress,
    herdrSpace: typeof raw.herdrSpace === "string" ? raw.herdrSpace : null,
    provider: typeof raw.provider === "string" ? raw.provider : null,
    workspace: typeof raw.workspace === "string" ? raw.workspace : null,
    canonicalProject: typeof raw.canonicalProject === "string" ? raw.canonicalProject : null,
    liveStatus:
      typeof raw.liveStatus === "string"
        ? (raw.liveStatus as ExternalSessionBinding["liveStatus"])
        : null,
    latestProgress: typeof raw.latestProgress === "string" ? raw.latestProgress : null,
    filesModifiedCount:
      typeof raw.filesModifiedCount === "number" && Number.isFinite(raw.filesModifiedCount)
        ? raw.filesModifiedCount
        : undefined,
    boundAt: typeof raw.boundAt === "string" ? raw.boundAt : new Date().toISOString(),
    lastSyncedAt: typeof raw.lastSyncedAt === "string" ? raw.lastSyncedAt : null,
  };
}

export function extractTaskOriginTrack(task: {
  metadata?: Record<string, unknown> | null;
  latestRunId?: string | null;
  sourceRef?: string | null;
  assigneeType?: string | null;
}): WorkOriginTrack {
  const meta = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  if (meta.originTrack === "opc_dispatched" || meta.originTrack === "founder_managed") {
    return meta.originTrack;
  }
  const src = (task.sourceRef ?? "").trim();
  if (src.startsWith("cli-ledger:") || src.startsWith("herdr:")) return "founder_managed";
  if (extractExternalSession(meta)) return "founder_managed";
  if (
    task.latestRunId ||
    task.assigneeType === "agent" ||
    src.startsWith("signal:") ||
    src.startsWith("eval:") ||
    src.startsWith("pilot") ||
    src.startsWith("workflow:") ||
    src.startsWith("dark-factory:")
  ) {
    return "opc_dispatched";
  }
  return "founder_managed";
}

export interface DependencyCheckResult {
  met: boolean;
  blockingIds: string[];
}

export interface SubtaskStats {
  total: number;
  done: number;
}

export interface PlanningTaskWithSubtasks extends PlanningTask {
  subtasks: PlanningTask[];
  subtaskStats: SubtaskStats;
}

export interface CreatePlanningTaskInput {
  project?: string;
  parentId?: string | null;
  title: string;
  description?: string;
  type?: PlanningTaskType;
  status?: PlanningTaskStatus;
  priority?: number;
  tags?: string[];
  dueAt?: string | null;
  assigneeType?: PlanningAssigneeType;
  assigneeId?: string | null;
  assigneeName?: string | null;
  sourceRef?: string | null;
  dependsOn?: string[];
  snoozedUntil?: string | null;
  verifyCommand?: string;
  mainlineId?: string | null;
  assetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateEpicSubtaskInput {
  title: string;
  description?: string;
  priority?: number;
  type?: PlanningTaskType;
  tags?: string[];
  dueAt?: string | null;
  assigneeType?: PlanningAssigneeType;
  assigneeId?: string | null;
  assigneeName?: string | null;
  dependsOn?: string[];
  dependsOnIndices?: number[];
  verifyCommand?: string;
  mainlineId?: string | null;
  assetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateEpicWithSubtasksInput {
  project?: string;
  title: string;
  description?: string;
  priority?: number;
  tags?: string[];
  dueAt?: string | null;
  sourceRef?: string | null;
  dependsOn?: string[];
  verifyCommand?: string;
  mainlineId?: string | null;
  assetId?: string | null;
  metadata?: Record<string, unknown>;
  subtasks: CreateEpicSubtaskInput[];
}

export interface CreateEpicWithSubtasksResult {
  epic: PlanningTaskWithSubtasks;
  subtasks: PlanningTask[];
}

export interface UpdatePlanningTaskInput {
  project?: string;
  parentId?: string | null;
  title?: string;
  description?: string;
  type?: PlanningTaskType;
  status?: PlanningTaskStatus;
  priority?: number;
  tags?: string[];
  dueAt?: string | null;
  assigneeType?: PlanningAssigneeType;
  assigneeId?: string | null;
  assigneeName?: string | null;
  sourceRef?: string | null;
  latestRunId?: string | null;
  prUrl?: string | null;
  tokenUsed?: number;
  costUsd?: number;
  dependsOn?: string[];
  snoozedUntil?: string | null;
  verifyCommand?: string;
  mainlineId?: string | null;
  assetId?: string | null;
  metadata?: Record<string, unknown>;
}

export const TRIAGE_STATUSES = [
  "unreviewed",
  "triaging",
  "verified",
  "needs_scope",
  "idea_demoted",
  "noise_archived",
  "superseded",
] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

export const TRIAGE_VERDICT_ACTIONS = [
  "noise_archive",
  "idea_demote",
  "already_done",
  "needs_code_check",
  "needs_scope",
  "real_ready",
] as const;
export type TriageVerdictAction = (typeof TRIAGE_VERDICT_ACTIONS)[number];

export interface TriageVerdict {
  taskId: string;
  verdict: TriageVerdictAction;
  confidence: number;
  reason: string;
  suggestedProject?: string | null;
  suggestedVerifyCommand?: string | null;
  evidence?: string | null;
}

export interface TaskTriageMeta {
  status: TriageStatus;
  verdict?: TriageVerdictAction | null;
  confidence?: number | null;
  reason?: string | null;
  evidence?: string | null;
  reviewer?: string | null;
  reviewedAt?: string | null;
  botTaskId?: string | null;
  demotedIdeaId?: string | null;
  codeCheckRan?: boolean;
  codeCheckVerdict?: "still_exists" | "already_done" | "noise" | "inconclusive" | null;
}

export interface TriageConfig {
  autoSweepEnabled: boolean;
  autoRollEnabled: boolean;
  useAgyCodeCheck: boolean;
  batchSize: number;
  maxAutoDispatchPerCycle: number;
  sweepIntervalMins: number;
  noiseConfidenceThreshold: number;
  ideaConfidenceThreshold: number;
  updatedAt: string;
}

export interface TriageFunnelCounts {
  totalTodo: number;
  unreviewed: number;
  triaging: number;
  verified: number;
  needs_scope: number;
  idea_demoted: number;
  noise_archived: number;
  superseded: number;
}

export interface TriageRunItemResult {
  taskId: string;
  title: string;
  previousStatus: TriageStatus;
  nextStatus: TriageStatus;
  taskStatusAfter: PlanningTaskStatus;
  verdict: TriageVerdictAction;
  confidence: number;
  reason: string;
  evidence?: string | null;
  demotedIdeaId?: string | null;
  applied: boolean;
}

export interface TriageRunReport {
  id: string;
  kind: "sweep" | "bot_batch" | "rolling_cycle" | "manual_task";
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  scannedCount: number;
  noiseArchivedCount: number;
  ideaDemotedCount: number;
  supersededCount: number;
  verifiedCount: number;
  needsScopeCount: number;
  codeCheckedCount: number;
  dispatchedCount: number;
  dispatchedTaskIds: string[];
  dispatchedRunIds: string[];
  botId?: string | null;
  botTaskId?: string | null;
  fallbackUsed?: boolean;
  error?: string | null;
  items: TriageRunItemResult[];
  funnel: TriageFunnelCounts;
}

export interface TriageStatusResponse {
  config: TriageConfig;
  funnel: TriageFunnelCounts;
  running: boolean;
  readyVerifiedCount: number;
  rdBotId: string | null;
  lastRun: TriageRunReport | null;
  recentRuns: TriageRunReport[];
}

const TRIAGE_STATUS_SET = new Set<string>(TRIAGE_STATUSES);
const TRIAGE_VERDICT_SET = new Set<string>(TRIAGE_VERDICT_ACTIONS);

export function isEmergencyAutoVerifiedTask(task: {
  metadata?: Record<string, unknown> | null;
  type?: string;
  priority?: number;
  tags?: string[];
}): boolean {
  const meta = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  if (meta.signalSource === "ops.crash_bug_filed" || meta.isEmergencyBug === true) {
    return true;
  }
  const tags = Array.isArray(task.tags) ? task.tags : [];
  return task.type === "bug" && Number(task.priority ?? 0) >= 9 && tags.includes("crash");
}

export function extractTaskTriage(metadata?: Record<string, unknown> | null): TaskTriageMeta {
  const raw =
    metadata && typeof metadata === "object" && metadata.triage && typeof metadata.triage === "object" && !Array.isArray(metadata.triage)
      ? (metadata.triage as Record<string, unknown>)
      : null;

  const rawStatus = typeof raw?.status === "string" && TRIAGE_STATUS_SET.has(raw.status) ? (raw.status as TriageStatus) : "unreviewed";
  const rawVerdict =
    typeof raw?.verdict === "string" && TRIAGE_VERDICT_SET.has(raw.verdict)
      ? (raw.verdict as TriageVerdictAction)
      : null;

  return {
    status: rawStatus,
    verdict: rawVerdict,
    confidence: typeof raw?.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : null,
    reason: typeof raw?.reason === "string" ? raw.reason : null,
    evidence: typeof raw?.evidence === "string" ? raw.evidence : null,
    reviewer: typeof raw?.reviewer === "string" ? raw.reviewer : null,
    reviewedAt: typeof raw?.reviewedAt === "string" ? raw.reviewedAt : null,
    botTaskId: typeof raw?.botTaskId === "string" ? raw.botTaskId : null,
    demotedIdeaId: typeof raw?.demotedIdeaId === "string" ? raw.demotedIdeaId : null,
    codeCheckRan: raw?.codeCheckRan === true,
    codeCheckVerdict:
      raw?.codeCheckVerdict === "still_exists" ||
      raw?.codeCheckVerdict === "already_done" ||
      raw?.codeCheckVerdict === "noise" ||
      raw?.codeCheckVerdict === "inconclusive"
        ? raw.codeCheckVerdict
        : null,
  };
}

export function getTaskTriageStatus(task: {
  metadata?: Record<string, unknown> | null;
  type?: string;
  priority?: number;
  tags?: string[];
}): TriageStatus {
  const raw =
    task.metadata &&
    typeof task.metadata === "object" &&
    task.metadata.triage &&
    typeof task.metadata.triage === "object" &&
    !Array.isArray(task.metadata.triage)
      ? (task.metadata.triage as Record<string, unknown>)
      : null;
  if (typeof raw?.status === "string" && TRIAGE_STATUS_SET.has(raw.status)) {
    return raw.status as TriageStatus;
  }
  return isEmergencyAutoVerifiedTask(task) ? "verified" : "unreviewed";
}

export function isTaskVerifiedForAutoDispatch(task: {
  metadata?: Record<string, unknown> | null;
  type?: string;
  priority?: number;
  tags?: string[];
}): boolean {
  return getTaskTriageStatus(task) === "verified";
}

export interface TaskListFilters {
  project?: string;
  status?: PlanningTaskStatus;
  type?: PlanningTaskType;
  assigneeType?: PlanningAssigneeType;
  parentId?: string | null;
  includeSubtasks?: boolean;
  mainlineId?: string;
  assetId?: string;
  triageStatus?: TriageStatus;
}

export interface PlanningAgentOption {
  id: string;
  name: string;
  status: string;
  capabilities: string[];
}

export interface AgentMetricsSummary {
  totalRuns: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  byDay: Record<string, { runs: number; tokens: number; costUsd: number }>;
  byProject: Record<string, { runs: number; tokens: number; costUsd: number }>;
}

export interface StaleTaskAlert {
  taskId: string;
  title: string;
  project: string;
  status: PlanningTaskStatus;
  assigneeType: PlanningAssigneeType;
  assigneeName: string | null;
  staleDays: number;
  updatedAt: string;
  reason: "stale" | "failed";
}

export interface TaskPlanningHooks {
  listAgents?: () => PlanningAgentOption[];
  dispatchToAgent?: (
    task: PlanningTask,
    agentId: string,
    autoCreatePr?: boolean,
    requestKey?: string,
    executionHost?: "subprocess" | "herdr",
  ) => Promise<{ runId: string; status: string }>;
  getAgentMetrics?: (days: number) => AgentMetricsSummary;
  getProjectRevenueUsd?: () => Record<string, number>;
  notifyPatrolToZoom?: (alerts: StaleTaskAlert[], report: Pick<PatrolReport, "id" | "createdAt">) => void;
  onEpicCompleted?: (epic: PlanningTaskWithSubtasks) => void;
  onPatrolReport?: (report: PatrolReport) => void;
}

export interface KanbanBoardResponse {
  todo: PlanningTaskWithSubtasks[];
  assigned: PlanningTaskWithSubtasks[];
  in_progress: PlanningTaskWithSubtasks[];
  review: PlanningTaskWithSubtasks[];
  done: PlanningTaskWithSubtasks[];
  failed: PlanningTaskWithSubtasks[];
  archived: PlanningTaskWithSubtasks[];
  projects: string[];
  agents: PlanningAgentOption[];
  counts: {
    total: number;
    todo: number;
    assigned: number;
    in_progress: number;
    review: number;
    done: number;
    failed: number;
    archived: number;
  };
}

export interface DispatchTaskInput {
  agentId: string;
  autoCreatePr?: boolean;
  executionHost?: "subprocess" | "herdr";
}

export interface DispatchTaskResult {
  task: PlanningTaskWithSubtasks;
  runId: string;
  runStatus: string;
}

export interface SyncRunOutcomeEvent {
  taskId: string;
  runId: string;
  status: string;
  prUrl?: string | null;
  tokenUsed?: number;
  costUsd?: number;
}

export interface PomodoroSession {
  id: string;
  taskId: string;
  project: string;
  durationMins: number;
  energyLevel: PlanningEnergyLevel;
  note: string;
  completedAt: string;
}

export interface RecordPomodoroInput {
  energyLevel: PlanningEnergyLevel;
  durationMins?: number;
  note?: string;
}

export interface RecordPomodoroResult {
  task: PlanningTaskWithSubtasks;
  session: PomodoroSession;
}

export interface PomodoroSummaryResponse {
  days: number;
  totalSessions: number;
  totalMinutes: number;
  estimatedHours: number;
  highEnergyCount: number;
  lowEnergyCount: number;
  /** Percentage 0-100, rounded to 1 decimal place. */
  highEnergyRate: number;
  sessions: PomodoroSession[];
}

export interface PatrolRunOptions {
  staleDays?: number;
  notifyZoom?: boolean;
}

export interface PatrolReport {
  id: string;
  staleDays: number;
  staleCount: number;
  failedCount: number;
  staleTasks: StaleTaskAlert[];
  failedTasks: StaleTaskAlert[];
  alerts: StaleTaskAlert[];
  notifiedZoom: boolean;
  createdAt: string;
}

export interface StatusCountItem {
  status: PlanningTaskStatus;
  count: number;
}

export interface EpicRoiEntry {
  id: string;
  kind: "epic" | "project";
  name: string;
  project: string;
  totalTasks: number;
  completedTasks: number;
  pomodoros: number;
  humanHours: number;
  agentCostUsd: number;
  revenueUsd: number;
  costPerCompletedTask: number | null;
}

export interface RoiDashboardResponse {
  days: number;
  generatedAt: string;
  tasks: {
    total: number;
    completed: number;
    /** Percentage 0-100, rounded to 1 decimal place. */
    completionRate: number;
    byStatus: StatusCountItem[];
  };
  agents: {
    totalRuns: number;
    totalTokensUsed: number;
    totalCostUsd: number;
  };
  human: {
    totalPomodoros: number;
    estimatedHours: number;
    highEnergyCount: number;
    lowEnergyCount: number;
    /** Percentage 0-100, rounded to 1 decimal place. */
    highEnergyRate: number;
  };
  epicRoi: EpicRoiEntry[];
}

export interface DailyTrendPoint {
  date: string;
  completed: number;
  created: number;
  agentRuns: number;
  pomodoroCount: number;
  highEnergyPomodoros: number;
}

export interface DailyTrendResponse {
  days: number;
  points: DailyTrendPoint[];
}
