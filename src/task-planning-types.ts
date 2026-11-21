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
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
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
}

export interface CreateEpicWithSubtasksInput {
  project?: string;
  title: string;
  description?: string;
  priority?: number;
  tags?: string[];
  dueAt?: string | null;
  sourceRef?: string | null;
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
  metadata?: Record<string, unknown>;
}

export interface TaskListFilters {
  project?: string;
  status?: PlanningTaskStatus;
  type?: PlanningTaskType;
  assigneeType?: PlanningAssigneeType;
  parentId?: string | null;
  includeSubtasks?: boolean;
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
  ) => Promise<{ runId: string; status: string }>;
  getAgentMetrics?: (days: number) => AgentMetricsSummary;
  getProjectRevenueUsd?: () => Record<string, number>;
  notifyPatrolToZoom?: (alerts: StaleTaskAlert[]) => void;
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
