import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  PLANNING_ASSIGNEE_TYPES,
  PLANNING_ENERGY_LEVELS,
  PLANNING_TASK_STATUSES,
  PLANNING_TASK_TYPES,
  type AgentMetricsSummary,
  type CreateEpicWithSubtasksInput,
  type CreateEpicWithSubtasksResult,
  type CreatePlanningTaskInput,
  type DailyTrendPoint,
  type DependencyCheckResult,
  type DispatchTaskInput,
  type DispatchTaskResult,
  type EpicRoiEntry,
  type KanbanBoardResponse,
  type PatrolReport,
  type PatrolRunOptions,
  type PlanningAgentOption,
  type PlanningEnergyLevel,
  type PlanningTask,
  type PlanningTaskStatus,
  type PlanningTaskType,
  type PlanningTaskWithSubtasks,
  type PomodoroSession,
  type PomodoroSummaryResponse,
  type RecordPomodoroInput,
  type RecordPomodoroResult,
  type RoiDashboardResponse,
  type StaleTaskAlert,
  type StatusCountItem,
  type SyncRunOutcomeEvent,
  type TaskListFilters,
  type TaskPlanningHooks,
  type UpdatePlanningTaskInput,
} from "../task-planning-types.ts";
import { ApiError } from "./logic.ts";
import type { ProvidersStore } from "./providers.ts";
import { submitAuth } from "./workflow/http.ts";

export type {
  AgentMetricsSummary,
  DependencyCheckResult,
  PlanningAgentOption,
  StaleTaskAlert,
  TaskPlanningHooks,
} from "../task-planning-types.ts";

const MS_PER_DAY = 86_400_000;
const COMPLETED_STATUSES = new Set<PlanningTaskStatus>(["done", "published"]);
const STALE_WATCH_STATUSES: PlanningTaskStatus[] = ["todo", "assigned", "in_progress", "pr_open"];

const taskTypeSchema = z.enum(PLANNING_TASK_TYPES);
const taskStatusSchema = z.enum(PLANNING_TASK_STATUSES);
const assigneeTypeSchema = z.enum(PLANNING_ASSIGNEE_TYPES);
const energyLevelSchema = z.enum(PLANNING_ENERGY_LEVELS);
const tagsSchema = z.array(z.string().trim().min(1).max(60)).max(20);
const dependsOnSchema = z.array(z.string().trim().min(1).max(120)).max(50);
const dependsOnIndicesSchema = z.array(z.number().int().min(0).max(50)).max(50);
const metadataSchema = z.record(z.string(), z.unknown());

const createTaskSchema = z.object({
  project: z.string().trim().max(120).optional(),
  parentId: z.string().trim().min(1).max(120).nullable().optional(),
  title: z.string().trim().min(1, "任务标题不能为空").max(300),
  description: z.string().max(10_000).optional(),
  type: taskTypeSchema.optional(),
  status: taskStatusSchema.optional(),
  priority: z.number().int().min(1).max(10).optional(),
  tags: tagsSchema.optional(),
  dueAt: z.string().trim().max(80).nullable().optional(),
  assigneeType: assigneeTypeSchema.optional(),
  assigneeId: z.string().trim().max(120).nullable().optional(),
  assigneeName: z.string().trim().max(120).nullable().optional(),
  sourceRef: z.string().trim().max(300).nullable().optional(),
  dependsOn: dependsOnSchema.optional(),
  snoozedUntil: z.string().trim().max(80).nullable().optional(),
  verifyCommand: z.string().max(2_000).optional(),
  mainlineId: z.string().trim().max(120).nullable().optional(),
  assetId: z.string().trim().max(120).nullable().optional(),
  metadata: metadataSchema.optional(),
});

const createEpicSubtaskSchema = z.object({
  title: z.string().trim().min(1, "子任务标题不能为空").max(300),
  description: z.string().max(10_000).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  type: taskTypeSchema.optional(),
  tags: tagsSchema.optional(),
  dueAt: z.string().trim().max(80).nullable().optional(),
  assigneeType: assigneeTypeSchema.optional(),
  assigneeId: z.string().trim().max(120).nullable().optional(),
  assigneeName: z.string().trim().max(120).nullable().optional(),
  dependsOn: dependsOnSchema.optional(),
  dependsOnIndices: dependsOnIndicesSchema.optional(),
  verifyCommand: z.string().max(2_000).optional(),
  mainlineId: z.string().trim().max(120).nullable().optional(),
  assetId: z.string().trim().max(120).nullable().optional(),
  metadata: metadataSchema.optional(),
});

const createEpicSchema = z.object({
  project: z.string().trim().max(120).optional(),
  title: z.string().trim().min(1, "Epic 标题不能为空").max(300),
  description: z.string().max(10_000).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  tags: tagsSchema.optional(),
  dueAt: z.string().trim().max(80).nullable().optional(),
  sourceRef: z.string().trim().max(300).nullable().optional(),
  dependsOn: dependsOnSchema.optional(),
  verifyCommand: z.string().max(2_000).optional(),
  mainlineId: z.string().trim().max(120).nullable().optional(),
  assetId: z.string().trim().max(120).nullable().optional(),
  metadata: metadataSchema.optional(),
  subtasks: z.array(createEpicSubtaskSchema).max(50).default([]),
});

const updateTaskSchema = z.object({
  project: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().trim().min(1).max(120).nullable().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(10_000).optional(),
  type: taskTypeSchema.optional(),
  status: taskStatusSchema.optional(),
  priority: z.number().int().min(1).max(10).optional(),
  tags: tagsSchema.optional(),
  dueAt: z.string().trim().max(80).nullable().optional(),
  assigneeType: assigneeTypeSchema.optional(),
  assigneeId: z.string().trim().max(120).nullable().optional(),
  assigneeName: z.string().trim().max(120).nullable().optional(),
  sourceRef: z.string().trim().max(300).nullable().optional(),
  latestRunId: z.string().trim().max(160).nullable().optional(),
  prUrl: z.string().trim().max(500).nullable().optional(),
  tokenUsed: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  dependsOn: dependsOnSchema.optional(),
  snoozedUntil: z.string().trim().max(80).nullable().optional(),
  verifyCommand: z.string().max(2_000).optional(),
  mainlineId: z.string().trim().max(120).nullable().optional(),
  assetId: z.string().trim().max(120).nullable().optional(),
  metadata: metadataSchema.optional(),
});

const recordPomodoroSchema = z.object({
  energyLevel: energyLevelSchema,
  durationMins: z.number().int().min(1).max(180).default(25),
  note: z.string().trim().max(500).default(""),
});

const assignHumanSchema = z.object({
  name: z.string().trim().max(120).optional(),
  assigneeId: z.string().trim().max(120).optional(),
});

const dispatchSchema = z.object({
  agentId: z.string().trim().min(1, "必须指定 Agent ID").max(120),
  autoCreatePr: z.boolean().optional(),
});

const patrolSchema = z.object({
  staleDays: z.number().int().min(1).max(365).optional(),
  notifyZoom: z.boolean().optional(),
});

const snoozeSchema = z.object({
  days: z.number().positive().max(365).default(7),
});

interface TaskRow {
  id: string;
  project: string;
  parent_id: string | null;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: number;
  tags: string;
  due_at: string | null;
  assignee_type: string;
  assignee_id: string | null;
  assignee_name: string | null;
  pomodoro_count: number;
  energy_level: string | null;
  source_ref: string | null;
  latest_run_id: string | null;
  pr_url: string | null;
  token_used: number;
  cost_usd: number;
  depends_on_json?: string;
  snoozed_until?: string | null;
  verify_command?: string;
  mainline_id?: string | null;
  asset_id?: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface PomodoroRow {
  id: string;
  task_id: string;
  project: string;
  duration_mins: number;
  energy_level: string;
  note: string;
  completed_at: string;
}

interface PatrolRow {
  id: string;
  stale_days: number;
  stale_count: number;
  failed_count: number;
  alerts_json: string;
  notified_zoom: number;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join(" / ");
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function cleanNullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function dedupeTags(tags?: string[]): string[] {
  if (!tags?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isCompletedStatus(status: PlanningTaskStatus): boolean {
  return COMPLETED_STATUSES.has(status);
}

function mapTaskRow(row: TaskRow): PlanningTask {
  return {
    id: row.id,
    project: row.project,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    type: (PLANNING_TASK_TYPES.includes(row.type as PlanningTaskType) ? row.type : "task") as PlanningTaskType,
    status: (PLANNING_TASK_STATUSES.includes(row.status as PlanningTaskStatus)
      ? row.status
      : "todo") as PlanningTaskStatus,
    priority: Number(row.priority) || 5,
    tags: parseJsonArray<string>(row.tags).map(String),
    dueAt: row.due_at,
    assigneeType: row.assignee_type === "agent" ? "agent" : "human",
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    pomodoroCount: Number(row.pomodoro_count) || 0,
    energyLevel: row.energy_level === "high" || row.energy_level === "low" ? row.energy_level : null,
    sourceRef: row.source_ref,
    latestRunId: row.latest_run_id,
    prUrl: row.pr_url,
    tokenUsed: Number(row.token_used) || 0,
    costUsd: round4(Number(row.cost_usd) || 0),
    dependsOn: parseJsonArray<string>(row.depends_on_json ?? "[]").map(String),
    snoozedUntil: row.snoozed_until ?? null,
    verifyCommand: String(row.verify_command ?? ""),
    mainlineId: row.mainline_id ?? null,
    assetId: row.asset_id ?? null,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapPomodoroRow(row: PomodoroRow): PomodoroSession {
  return {
    id: row.id,
    taskId: row.task_id,
    project: row.project,
    durationMins: Number(row.duration_mins) || 25,
    energyLevel: row.energy_level === "low" ? "low" : "high",
    note: row.note || "",
    completedAt: row.completed_at,
  };
}

function mapPatrolRow(row: PatrolRow): PatrolReport {
  const alerts = parseJsonArray<StaleTaskAlert>(row.alerts_json);
  const staleTasks = alerts.filter((a) => a.reason === "stale");
  const failedTasks = alerts.filter((a) => a.reason === "failed");
  return {
    id: row.id,
    staleDays: Number(row.stale_days) || 7,
    staleCount: Number(row.stale_count) || staleTasks.length,
    failedCount: Number(row.failed_count) || failedTasks.length,
    staleTasks,
    failedTasks,
    alerts,
    notifiedZoom: Boolean(row.notified_zoom),
    createdAt: row.created_at,
  };
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoDateKey(iso: string | null | undefined): string | null {
  if (!iso || iso.length < 10) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso.slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

function windowStartIso(days: number): string {
  const now = new Date();
  const startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1), 0, 0, 0, 0);
  return new Date(startUtc).toISOString();
}

export class TaskPlanningStore {
  private hooks: TaskPlanningHooks;
  private epicCompletedListeners = new Set<(epic: PlanningTaskWithSubtasks) => void>();
  private patrolListeners = new Set<(report: PatrolReport) => void>();

  constructor(
    private db: DatabaseSync,
    private providers?: ProvidersStore,
    hooks?: TaskPlanningHooks,
  ) {
    this.hooks = hooks ?? {};
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_planning_tasks (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL DEFAULT 'default',
        parent_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'task',
        status TEXT NOT NULL DEFAULT 'todo',
        priority INTEGER NOT NULL DEFAULT 5,
        tags TEXT NOT NULL DEFAULT '[]',
        due_at TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'human',
        assignee_id TEXT,
        assignee_name TEXT,
        pomodoro_count INTEGER NOT NULL DEFAULT 0,
        energy_level TEXT,
        source_ref TEXT,
        latest_run_id TEXT,
        pr_url TEXT,
        token_used INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        snoozed_until TEXT,
        verify_command TEXT NOT NULL DEFAULT '',
        mainline_id TEXT,
        asset_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_opc_planning_tasks_project ON opc_planning_tasks(project);
      CREATE INDEX IF NOT EXISTS idx_opc_planning_tasks_parent ON opc_planning_tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_opc_planning_tasks_status ON opc_planning_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_opc_planning_tasks_updated ON opc_planning_tasks(updated_at);

      CREATE TABLE IF NOT EXISTS opc_pomodoro_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT 'default',
        duration_mins INTEGER NOT NULL DEFAULT 25,
        energy_level TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_pomodoro_task ON opc_pomodoro_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_opc_pomodoro_completed ON opc_pomodoro_sessions(completed_at);

      CREATE TABLE IF NOT EXISTS opc_patrol_runs (
        id TEXT PRIMARY KEY,
        stale_days INTEGER NOT NULL,
        stale_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        alerts_json TEXT NOT NULL DEFAULT '[]',
        notified_zoom INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_patrol_created ON opc_patrol_runs(created_at);
    `);

    const existingCols = new Set(
      (this.db.prepare("PRAGMA table_info(opc_planning_tasks)").all() as Array<{ name?: string }>).map((c) =>
        String(c.name ?? ""),
      ),
    );
    const columnMigrations: Array<[string, string]> = [
      ["depends_on_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["snoozed_until", "TEXT"],
      ["verify_command", "TEXT NOT NULL DEFAULT ''"],
      ["mainline_id", "TEXT"],
      ["asset_id", "TEXT"],
    ];
    for (const [col, sqlType] of columnMigrations) {
      if (!existingCols.has(col)) {
        this.db.exec(`ALTER TABLE opc_planning_tasks ADD COLUMN ${col} ${sqlType}`);
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_opc_planning_tasks_mainline ON opc_planning_tasks(mainline_id);
      CREATE INDEX IF NOT EXISTS idx_opc_planning_tasks_asset ON opc_planning_tasks(asset_id);
    `);
  }

  setHooks(hooks: TaskPlanningHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  onEpicComplete(listener: (epic: PlanningTaskWithSubtasks) => void): () => void {
    this.epicCompletedListeners.add(listener);
    return () => {
      this.epicCompletedListeners.delete(listener);
    };
  }

  onPatrol(listener: (report: PatrolReport) => void): () => void {
    this.patrolListeners.add(listener);
    return () => {
      this.patrolListeners.delete(listener);
    };
  }

  private getRawTask(id: string): PlanningTask | null {
    const row = this.db.prepare("SELECT * FROM opc_planning_tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row ? mapTaskRow(row) : null;
  }

  private requireRawTask(id: string): PlanningTask {
    const task = this.getRawTask(id);
    if (!task) {
      throw new ApiError(404, "task_not_found", `任务不存在: ${id}`);
    }
    return task;
  }

  private attachSubtasks(tasks: PlanningTask[]): PlanningTaskWithSubtasks[] {
    if (tasks.length === 0) return [];
    const ids = tasks.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(", ");
    const childRows = this.db
      .prepare(
        `SELECT * FROM opc_planning_tasks
         WHERE parent_id IN (${placeholders})
         ORDER BY priority DESC, created_at ASC`,
      )
      .all(...ids) as unknown as TaskRow[];

    const childrenByParent = new Map<string, PlanningTask[]>();
    for (const row of childRows) {
      const child = mapTaskRow(row);
      if (!child.parentId) continue;
      const list = childrenByParent.get(child.parentId);
      if (list) list.push(child);
      else childrenByParent.set(child.parentId, [child]);
    }

    return tasks.map((task) => {
      const subtasks = childrenByParent.get(task.id) ?? [];
      const done = subtasks.filter((s) => isCompletedStatus(s.status)).length;
      return {
        ...task,
        subtasks,
        subtaskStats: { total: subtasks.length, done },
      };
    });
  }

  private maybeAutoCompleteParentEpic(parentId: string | null, now: string): void {
    if (!parentId) return;
    const parent = this.getRawTask(parentId);
    if (!parent || parent.type !== "epic") return;
    if (isCompletedStatus(parent.status)) return;

    const childRows = this.db
      .prepare("SELECT * FROM opc_planning_tasks WHERE parent_id = ?")
      .all(parentId) as unknown as TaskRow[];
    if (childRows.length === 0) return;

    const allDone = childRows.every((row) =>
      isCompletedStatus(
        (PLANNING_TASK_STATUSES.includes(row.status as PlanningTaskStatus)
          ? row.status
          : "todo") as PlanningTaskStatus,
      ),
    );
    if (!allDone) return;

    this.db
      .prepare(
        `UPDATE opc_planning_tasks
         SET status = 'done', completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, parent.id);

    const completedEpic = this.getTask(parent.id);
    this.hooks.onEpicCompleted?.(completedEpic);
    for (const listener of this.epicCompletedListeners) {
      listener(completedEpic);
    }
  }

  private insertTaskRow(params: {
    id: string;
    project: string;
    parentId: string | null;
    title: string;
    description: string;
    type: PlanningTaskType;
    status: PlanningTaskStatus;
    priority: number;
    tags: string[];
    dueAt: string | null;
    assigneeType: "human" | "agent";
    assigneeId: string | null;
    assigneeName: string | null;
    sourceRef: string | null;
    dependsOn: string[];
    snoozedUntil: string | null;
    verifyCommand: string;
    mainlineId: string | null;
    assetId: string | null;
    metadata: Record<string, unknown>;
    now: string;
  }): PlanningTask {
    const completedAt = isCompletedStatus(params.status) ? params.now : null;
    this.db
      .prepare(
        `INSERT INTO opc_planning_tasks (
          id, project, parent_id, title, description, type, status, priority, tags, due_at,
          assignee_type, assignee_id, assignee_name, pomodoro_count, energy_level,
          source_ref, latest_run_id, pr_url, token_used, cost_usd,
          depends_on_json, snoozed_until, verify_command, mainline_id, asset_id,
          metadata, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.project,
        params.parentId,
        params.title,
        params.description,
        params.type,
        params.status,
        params.priority,
        JSON.stringify(params.tags),
        params.dueAt,
        params.assigneeType,
        params.assigneeId,
        params.assigneeName,
        params.sourceRef,
        JSON.stringify(params.dependsOn),
        params.snoozedUntil,
        params.verifyCommand,
        params.mainlineId,
        params.assetId,
        JSON.stringify(params.metadata),
        params.now,
        params.now,
        completedAt,
      );
    return this.requireRawTask(params.id);
  }

  // ---- 1. Structured Task CRUD + Epic -> SubTask Hierarchy ----

  createTask(rawInput: CreatePlanningTaskInput | unknown): PlanningTask {
    const parsed = createTaskSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ApiError(400, "task_input", formatZodIssues(parsed.error));
    }
    const data = parsed.data;
    const parentId = cleanNullable(data.parentId);
    let inheritedProject: string | undefined;
    let inheritedMainlineId: string | null = null;
    let inheritedAssetId: string | null = null;
    let inheritedVerifyCommand = "";
    if (parentId) {
      const parent = this.getRawTask(parentId);
      if (!parent) {
        throw new ApiError(404, "parent_not_found", `父任务不存在: ${parentId}`);
      }
      inheritedProject = parent.project;
      inheritedMainlineId = parent.mainlineId;
      inheritedAssetId = parent.assetId;
      inheritedVerifyCommand = parent.verifyCommand;
    }

    const id = `tsk_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const dependsOn = dedupeTags(data.dependsOn).filter((depId) => depId !== id);
    const project = data.project?.trim() || inheritedProject || "default";
    const now = nowIso();
    const created = this.insertTaskRow({
      id,
      project,
      parentId,
      title: data.title,
      description: data.description ?? "",
      type: data.type ?? "task",
      status: data.status ?? "todo",
      priority: data.priority ?? 5,
      tags: dedupeTags(data.tags),
      dueAt: cleanNullable(data.dueAt),
      assigneeType: data.assigneeType ?? "human",
      assigneeId: cleanNullable(data.assigneeId),
      assigneeName: cleanNullable(data.assigneeName),
      sourceRef: cleanNullable(data.sourceRef),
      dependsOn,
      snoozedUntil: cleanNullable(data.snoozedUntil),
      verifyCommand: (data.verifyCommand ?? inheritedVerifyCommand).trim(),
      mainlineId: data.mainlineId !== undefined ? cleanNullable(data.mainlineId) : inheritedMainlineId,
      assetId: data.assetId !== undefined ? cleanNullable(data.assetId) : inheritedAssetId,
      metadata: data.metadata ?? {},
      now,
    });
    if (isCompletedStatus(created.status)) {
      this.maybeAutoCompleteParentEpic(parentId, now);
    }
    return created;
  }

  createEpicWithSubtasks(rawInput: CreateEpicWithSubtasksInput | unknown): CreateEpicWithSubtasksResult {
    const parsed = createEpicSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ApiError(400, "epic_input", formatZodIssues(parsed.error));
    }
    const data = parsed.data;
    const project = data.project?.trim() || "default";
    const epicPriority = data.priority ?? 7;
    const epicTags = dedupeTags(data.tags);
    const sourceRef = cleanNullable(data.sourceRef);
    const epicDependsOn = dedupeTags(data.dependsOn);
    const epicVerifyCommand = (data.verifyCommand ?? "").trim();
    const epicMainlineId = cleanNullable(data.mainlineId);
    const epicAssetId = cleanNullable(data.assetId);
    const now = nowIso();

    const subtaskIds = data.subtasks.map(() => `tsk_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
    const resolvedSubtaskDeps: string[][] = data.subtasks.map((sub, i) => {
      const fromIndices: string[] = [];
      for (const idx of sub.dependsOnIndices ?? []) {
        if (idx < 0 || idx >= data.subtasks.length || idx === i) {
          throw new ApiError(
            400,
            "epic_input",
            `子任务 #${i} 的 dependsOnIndices 包含非法下标 ${idx}`,
          );
        }
        fromIndices.push(subtaskIds[idx]);
      }
      return dedupeTags([...(sub.dependsOn ?? []), ...fromIndices]).filter((depId) => depId !== subtaskIds[i]);
    });

    // Detect dependency cycles among subtasks
    const idToIndex = new Map<string, number>(subtaskIds.map((sid, idx) => [sid, idx]));
    const color = new Array<number>(subtaskIds.length).fill(0); // 0=unvisited, 1=visiting, 2=done
    const hasCycle = (u: number): boolean => {
      color[u] = 1;
      for (const depId of resolvedSubtaskDeps[u]) {
        const v = idToIndex.get(depId);
        if (v === undefined) continue;
        if (color[v] === 1) return true;
        if (color[v] === 0 && hasCycle(v)) return true;
      }
      color[u] = 2;
      return false;
    };
    for (let i = 0; i < subtaskIds.length; i++) {
      if (color[i] === 0 && hasCycle(i)) {
        throw new ApiError(400, "epic_input", "子任务依赖关系存在循环引用");
      }
    }

    this.db.exec("BEGIN");
    try {
      const epicId = `epc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const epicTask = this.insertTaskRow({
        id: epicId,
        project,
        parentId: null,
        title: data.title,
        description: data.description ?? "",
        type: "epic",
        status: "todo",
        priority: epicPriority,
        tags: epicTags,
        dueAt: cleanNullable(data.dueAt),
        assigneeType: "human",
        assigneeId: null,
        assigneeName: null,
        sourceRef,
        dependsOn: epicDependsOn.filter((depId) => depId !== epicId),
        snoozedUntil: null,
        verifyCommand: epicVerifyCommand,
        mainlineId: epicMainlineId,
        assetId: epicAssetId,
        metadata: data.metadata ?? {},
        now,
      });

      const subtasks: PlanningTask[] = [];
      for (let i = 0; i < data.subtasks.length; i++) {
        const sub = data.subtasks[i];
        const subTask = this.insertTaskRow({
          id: subtaskIds[i],
          project,
          parentId: epicId,
          title: sub.title,
          description: sub.description ?? "",
          type: sub.type ?? "task",
          status: "todo",
          priority: sub.priority ?? epicPriority,
          tags: dedupeTags(sub.tags),
          dueAt: cleanNullable(sub.dueAt),
          assigneeType: sub.assigneeType ?? "human",
          assigneeId: cleanNullable(sub.assigneeId),
          assigneeName: cleanNullable(sub.assigneeName),
          sourceRef,
          dependsOn: resolvedSubtaskDeps[i],
          snoozedUntil: null,
          verifyCommand: (sub.verifyCommand ?? epicVerifyCommand).trim(),
          mainlineId: sub.mainlineId !== undefined ? cleanNullable(sub.mainlineId) : epicMainlineId,
          assetId: sub.assetId !== undefined ? cleanNullable(sub.assetId) : epicAssetId,
          metadata: sub.metadata ?? {},
          now,
        });
        subtasks.push(subTask);
      }

      this.db.exec("COMMIT");

      const done = subtasks.filter((s) => isCompletedStatus(s.status)).length;
      return {
        epic: {
          ...epicTask,
          subtasks,
          subtaskStats: { total: subtasks.length, done },
        },
        subtasks,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getTask(id: string): PlanningTaskWithSubtasks {
    const task = this.requireRawTask(id);
    return this.attachSubtasks([task])[0];
  }

  listTasks(filters: TaskListFilters = {}): PlanningTaskWithSubtasks[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];

    if (filters.project && filters.project.trim()) {
      clauses.push("project = ?");
      args.push(filters.project.trim());
    }
    if (filters.status) {
      clauses.push("status = ?");
      args.push(filters.status);
    }
    if (filters.type) {
      clauses.push("type = ?");
      args.push(filters.type);
    }
    if (filters.assigneeType) {
      clauses.push("assignee_type = ?");
      args.push(filters.assigneeType);
    }
    if (filters.mainlineId && filters.mainlineId.trim()) {
      clauses.push("mainline_id = ?");
      args.push(filters.mainlineId.trim());
    }
    if (filters.assetId && filters.assetId.trim()) {
      clauses.push("asset_id = ?");
      args.push(filters.assetId.trim());
    }

    if (typeof filters.parentId === "string" && filters.parentId.trim()) {
      clauses.push("parent_id = ?");
      args.push(filters.parentId.trim());
    } else if (filters.parentId === null) {
      clauses.push("parent_id IS NULL");
    } else if (!filters.includeSubtasks) {
      clauses.push("parent_id IS NULL");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM opc_planning_tasks
         ${where}
         ORDER BY priority DESC, updated_at DESC, created_at DESC`,
      )
      .all(...args) as unknown as TaskRow[];

    return this.attachSubtasks(rows.map(mapTaskRow));
  }

  getKanban(project?: string, options?: { includeSubtasks?: boolean }): KanbanBoardResponse {
    const tasks = this.listTasks({
      project: project?.trim() || undefined,
      includeSubtasks: options?.includeSubtasks ?? false,
    });

    const board: KanbanBoardResponse = {
      todo: [],
      assigned: [],
      in_progress: [],
      review: [],
      done: [],
      failed: [],
      archived: [],
      projects: this.listProjects(),
      agents: this.hooks.listAgents?.() ?? [],
      counts: {
        total: tasks.length,
        todo: 0,
        assigned: 0,
        in_progress: 0,
        review: 0,
        done: 0,
        failed: 0,
        archived: 0,
      },
    };

    for (const task of tasks) {
      switch (task.status) {
        case "todo":
          board.todo.push(task);
          break;
        case "assigned":
          board.assigned.push(task);
          break;
        case "in_progress":
        case "pr_open":
          board.in_progress.push(task);
          break;
        case "review":
          board.review.push(task);
          break;
        case "done":
        case "published":
          board.done.push(task);
          break;
        case "failed":
          board.failed.push(task);
          break;
        case "archived":
          board.archived.push(task);
          break;
      }
    }

    board.counts = {
      total: tasks.length,
      todo: board.todo.length,
      assigned: board.assigned.length,
      in_progress: board.in_progress.length,
      review: board.review.length,
      done: board.done.length,
      failed: board.failed.length,
      archived: board.archived.length,
    };

    return board;
  }

  listProjects(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT project FROM opc_planning_tasks ORDER BY project ASC")
      .all() as unknown as Array<{ project: string }>;
    return rows.map((r) => r.project).filter(Boolean);
  }

  updateTask(id: string, rawPatch: UpdatePlanningTaskInput | unknown): PlanningTaskWithSubtasks {
    const existing = this.requireRawTask(id);
    const parsed = updateTaskSchema.safeParse(rawPatch);
    if (!parsed.success) {
      throw new ApiError(400, "task_patch_input", formatZodIssues(parsed.error));
    }
    const patch = parsed.data;

    let nextParentId = existing.parentId;
    if (patch.parentId !== undefined) {
      nextParentId = cleanNullable(patch.parentId);
      if (nextParentId === id) {
        throw new ApiError(400, "invalid_parent", "任务不能将自身设为父任务");
      }
      if (nextParentId) {
        const parent = this.getRawTask(nextParentId);
        if (!parent) {
          throw new ApiError(404, "parent_not_found", `父任务不存在: ${nextParentId}`);
        }
        // Prevent cycles
        let cursor: string | null = parent.parentId;
        const visited = new Set<string>([id, nextParentId]);
        while (cursor) {
          if (visited.has(cursor)) {
            throw new ApiError(400, "cyclic_parent", "父任务层级存在循环引用");
          }
          visited.add(cursor);
          cursor = this.getRawTask(cursor)?.parentId ?? null;
        }
      }
    }

    let nextDependsOn = existing.dependsOn;
    if (patch.dependsOn !== undefined) {
      const cleanedDeps = dedupeTags(patch.dependsOn);
      if (cleanedDeps.includes(id)) {
        throw new ApiError(400, "invalid_dependency", "任务不能将自身设为前置依赖");
      }
      nextDependsOn = cleanedDeps;
    }

    const now = nowIso();
    const nextStatus: PlanningTaskStatus = patch.status ?? existing.status;
    let nextCompletedAt = existing.completedAt;
    if (patch.status !== undefined) {
      if (isCompletedStatus(nextStatus)) {
        nextCompletedAt = existing.completedAt ?? now;
      } else if (nextStatus !== "archived") {
        nextCompletedAt = null;
      }
    }

    const nextProject = patch.project !== undefined ? patch.project.trim() || "default" : existing.project;
    const nextTitle = patch.title ?? existing.title;
    const nextDescription = patch.description ?? existing.description;
    const nextType = patch.type ?? existing.type;
    const nextPriority = patch.priority ?? existing.priority;
    const nextTags = patch.tags !== undefined ? dedupeTags(patch.tags) : existing.tags;
    const nextDueAt = patch.dueAt !== undefined ? cleanNullable(patch.dueAt) : existing.dueAt;
    const nextAssigneeType = patch.assigneeType ?? existing.assigneeType;
    const nextAssigneeId = patch.assigneeId !== undefined ? cleanNullable(patch.assigneeId) : existing.assigneeId;
    const nextAssigneeName =
      patch.assigneeName !== undefined ? cleanNullable(patch.assigneeName) : existing.assigneeName;
    const nextSourceRef = patch.sourceRef !== undefined ? cleanNullable(patch.sourceRef) : existing.sourceRef;
    const nextLatestRunId = patch.latestRunId !== undefined ? cleanNullable(patch.latestRunId) : existing.latestRunId;
    const nextPrUrl = patch.prUrl !== undefined ? cleanNullable(patch.prUrl) : existing.prUrl;
    const nextTokenUsed = patch.tokenUsed ?? existing.tokenUsed;
    const nextCostUsd = patch.costUsd !== undefined ? round4(patch.costUsd) : existing.costUsd;
    const nextSnoozedUntil =
      patch.snoozedUntil !== undefined ? cleanNullable(patch.snoozedUntil) : existing.snoozedUntil;
    const nextVerifyCommand =
      patch.verifyCommand !== undefined ? patch.verifyCommand.trim() : existing.verifyCommand;
    const nextMainlineId = patch.mainlineId !== undefined ? cleanNullable(patch.mainlineId) : existing.mainlineId;
    const nextAssetId = patch.assetId !== undefined ? cleanNullable(patch.assetId) : existing.assetId;
    const nextMetadata = patch.metadata ?? existing.metadata;

    this.db
      .prepare(
        `UPDATE opc_planning_tasks
         SET project = ?, parent_id = ?, title = ?, description = ?, type = ?, status = ?,
             priority = ?, tags = ?, due_at = ?, assignee_type = ?, assignee_id = ?, assignee_name = ?,
             source_ref = ?, latest_run_id = ?, pr_url = ?, token_used = ?, cost_usd = ?,
             depends_on_json = ?, snoozed_until = ?, verify_command = ?, mainline_id = ?, asset_id = ?,
             metadata = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        nextProject,
        nextParentId,
        nextTitle,
        nextDescription,
        nextType,
        nextStatus,
        nextPriority,
        JSON.stringify(nextTags),
        nextDueAt,
        nextAssigneeType,
        nextAssigneeId,
        nextAssigneeName,
        nextSourceRef,
        nextLatestRunId,
        nextPrUrl,
        nextTokenUsed,
        nextCostUsd,
        JSON.stringify(nextDependsOn),
        nextSnoozedUntil,
        nextVerifyCommand,
        nextMainlineId,
        nextAssetId,
        JSON.stringify(nextMetadata),
        now,
        nextCompletedAt,
        id,
      );

    if (isCompletedStatus(nextStatus)) {
      this.maybeAutoCompleteParentEpic(nextParentId, now);
    }

    return this.getTask(id);
  }

  updateStatus(id: string, status: PlanningTaskStatus | string): PlanningTaskWithSubtasks {
    const parsed = taskStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_status", `不支持的任务状态: ${String(status)}`);
    }
    return this.updateTask(id, { status: parsed.data });
  }

  deleteTask(id: string): { deleted: true; deletedIds: string[] } {
    this.requireRawTask(id);

    // Recursively gather all descendants
    const toDelete: string[] = [id];
    const queue: string[] = [id];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = this.db
        .prepare("SELECT id FROM opc_planning_tasks WHERE parent_id = ?")
        .all(parentId) as unknown as Array<{ id: string }>;
      for (const child of children) {
        if (!toDelete.includes(child.id)) {
          toDelete.push(child.id);
          queue.push(child.id);
        }
      }
    }

    const placeholders = toDelete.map(() => "?").join(", ");
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM opc_planning_tasks WHERE id IN (${placeholders})`).run(...toDelete);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { deleted: true, deletedIds: toDelete };
  }

  // ---- 2. Human / Agent Hybrid Assignment & Dark Factory Dispatch ----

  assignHuman(id: string, name?: string, assigneeId?: string): PlanningTaskWithSubtasks {
    const existing = this.requireRawTask(id);
    const nextStatus: PlanningTaskStatus = existing.status === "todo" ? "assigned" : existing.status;
    const nextName = cleanNullable(name) ?? (existing.assigneeType === "human" ? existing.assigneeName : null) ?? "Founder";
    const nextId = cleanNullable(assigneeId) ?? (existing.assigneeType === "human" ? existing.assigneeId : null);
    const now = nowIso();

    this.db
      .prepare(
        `UPDATE opc_planning_tasks
         SET assignee_type = 'human', assignee_id = ?, assignee_name = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextId, nextName, nextStatus, now, id);

    return this.getTask(id);
  }

  areDependenciesMet(taskId: string): DependencyCheckResult {
    const task = this.requireRawTask(taskId);
    if (task.dependsOn.length === 0) {
      return { met: true, blockingIds: [] };
    }
    const blockingIds: string[] = [];
    for (const depId of task.dependsOn) {
      const dep = this.getRawTask(depId);
      if (dep && !isCompletedStatus(dep.status)) {
        blockingIds.push(depId);
      }
    }
    return {
      met: blockingIds.length === 0,
      blockingIds,
    };
  }

  snoozeTask(id: string, days = 7): PlanningTaskWithSubtasks {
    this.requireRawTask(id);
    const numDays = Number(days);
    if (!Number.isFinite(numDays) || numDays <= 0) {
      throw new ApiError(400, "snooze_input", "延后天数必须大于 0");
    }
    const now = nowIso();
    const snoozedUntil = new Date(Date.now() + numDays * MS_PER_DAY).toISOString();
    this.db
      .prepare(
        `UPDATE opc_planning_tasks
         SET snoozed_until = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(snoozedUntil, now, id);
    return this.getTask(id);
  }

  listReadyForAutoDispatch(limit = 20): PlanningTask[] {
    const safeLimit = clampInt(limit, 20, 1, 500);
    const now = nowIso();
    const rows = this.db
      .prepare(
        `SELECT t.* FROM opc_planning_tasks t
         WHERE t.status IN ('todo', 'assigned')
           AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?)
           AND (
             t.type != 'epic'
             OR NOT EXISTS (SELECT 1 FROM opc_planning_tasks c WHERE c.parent_id = t.id)
           )
         ORDER BY t.priority DESC, t.created_at ASC`,
      )
      .all(now) as unknown as TaskRow[];

    const ready: PlanningTask[] = [];
    for (const row of rows) {
      const task = mapTaskRow(row);
      if (this.areDependenciesMet(task.id).met) {
        ready.push(task);
        if (ready.length >= safeLimit) break;
      }
    }
    return ready;
  }

  async dispatchTask(id: string, rawInput: DispatchTaskInput | unknown): Promise<DispatchTaskResult> {
    const parsed = dispatchSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ApiError(400, "dispatch_input", formatZodIssues(parsed.error));
    }
    const { agentId, autoCreatePr } = parsed.data;
    const task = this.requireRawTask(id);

    const depCheck = this.areDependenciesMet(id);
    if (!depCheck.met) {
      throw new ApiError(
        409,
        "dependency_blocked",
        `前置依赖任务尚未完成: ${depCheck.blockingIds.join(", ")}`,
      );
    }

    if (!this.hooks.dispatchToAgent) {
      throw new ApiError(503, "dispatch_unconfigured", "尚未接入暗工厂 Agent 派发执行钩子");
    }

    const matchedAgent: PlanningAgentOption | undefined = this.hooks
      .listAgents?.()
      .find((a) => a.id === agentId);
    const agentName = matchedAgent?.name || agentId;

    const outcome = await this.hooks.dispatchToAgent(task, agentId, Boolean(autoCreatePr));
    const now = nowIso();

    this.db
      .prepare(
        `UPDATE opc_planning_tasks
         SET assignee_type = 'agent', assignee_id = ?, assignee_name = ?,
             status = 'in_progress', latest_run_id = ?, updated_at = ?, completed_at = NULL
         WHERE id = ?`,
      )
      .run(agentId, agentName, outcome.runId, now, id);

    return {
      task: this.getTask(id),
      runId: outcome.runId,
      runStatus: outcome.status,
    };
  }

  syncRunOutcome(event: SyncRunOutcomeEvent): PlanningTaskWithSubtasks {
    const existing = this.requireRawTask(event.taskId);
    const normalized = String(event.status || "").toLowerCase();

    let nextStatus: PlanningTaskStatus = existing.status;
    if (normalized === "pr_open") {
      nextStatus = "pr_open";
    } else if (normalized === "published") {
      nextStatus = "published";
    } else if (normalized === "completed" || normalized === "succeeded" || normalized === "done") {
      nextStatus = "review";
    } else if (normalized === "failed" || normalized === "error" || normalized === "cancelled") {
      nextStatus = "failed";
    } else if (normalized === "running" || normalized === "in_progress") {
      nextStatus = "in_progress";
    }

    const addedTokens = Math.max(0, Math.floor(Number(event.tokenUsed ?? 0) || 0));
    const addedCost = Math.max(0, Number(event.costUsd ?? 0) || 0);
    const nextTokens = existing.tokenUsed + addedTokens;
    const nextCost = round4(existing.costUsd + addedCost);
    const nextPrUrl = cleanNullable(event.prUrl) ?? existing.prUrl;
    const nextRunId = cleanNullable(event.runId) ?? existing.latestRunId;
    const now = nowIso();
    const nextCompletedAt = isCompletedStatus(nextStatus) ? existing.completedAt ?? now : existing.completedAt;

    this.db
      .prepare(
        `UPDATE opc_planning_tasks
         SET status = ?, latest_run_id = ?, pr_url = ?, token_used = ?, cost_usd = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(nextStatus, nextRunId, nextPrUrl, nextTokens, nextCost, now, nextCompletedAt, existing.id);

    if (isCompletedStatus(nextStatus)) {
      this.maybeAutoCompleteParentEpic(existing.parentId, now);
    }

    return this.getTask(existing.id);
  }

  // ---- 3. Pomodoro Timer + Mandatory Energy Tracking ----

  recordPomodoro(taskId: string, rawInput: RecordPomodoroInput | unknown): RecordPomodoroResult {
    const parsed = recordPomodoroSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ApiError(400, "pomodoro_input", formatZodIssues(parsed.error));
    }
    const task = this.requireRawTask(taskId);
    const { energyLevel, durationMins, note } = parsed.data;
    const now = nowIso();
    const sessionId = `pom_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO opc_pomodoro_sessions (
            id, task_id, project, duration_mins, energy_level, note, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, task.id, task.project, durationMins, energyLevel, note, now);

      this.db
        .prepare(
          `UPDATE opc_planning_tasks
           SET pomodoro_count = pomodoro_count + 1, energy_level = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(energyLevel, now, task.id);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const session: PomodoroSession = {
      id: sessionId,
      taskId: task.id,
      project: task.project,
      durationMins,
      energyLevel,
      note,
      completedAt: now,
    };

    return {
      task: this.getTask(task.id),
      session,
    };
  }

  listPomodoros(days = 30): PomodoroSummaryResponse {
    const safeDays = clampInt(days, 30, 1, 365);
    const cutoff = windowStartIso(safeDays);
    const rows = this.db
      .prepare(
        `SELECT * FROM opc_pomodoro_sessions
         WHERE completed_at >= ?
         ORDER BY completed_at DESC`,
      )
      .all(cutoff) as unknown as PomodoroRow[];

    const sessions = rows.map(mapPomodoroRow);
    let totalMinutes = 0;
    let highEnergyCount = 0;
    let lowEnergyCount = 0;

    for (const s of sessions) {
      totalMinutes += s.durationMins;
      if (s.energyLevel === "high") highEnergyCount += 1;
      else lowEnergyCount += 1;
    }

    const totalSessions = sessions.length;
    return {
      days: safeDays,
      totalSessions,
      totalMinutes,
      estimatedHours: round2(totalMinutes / 60),
      highEnergyCount,
      lowEnergyCount,
      highEnergyRate: totalSessions > 0 ? round1((highEnergyCount / totalSessions) * 100) : 0,
      sessions,
    };
  }

  // ---- 4. Background Patrol Guard ----

  runPatrol(rawOptions: PatrolRunOptions | unknown = {}): PatrolReport {
    const parsed = patrolSchema.safeParse(rawOptions ?? {});
    if (!parsed.success) {
      throw new ApiError(400, "patrol_input", formatZodIssues(parsed.error));
    }

    const defaultStaleDays = this.providers?.get().system.patrolStaleDays ?? 7;
    const staleDays = parsed.data.staleDays ?? clampInt(defaultStaleDays, 7, 1, 365);
    const notifyZoomRequested = Boolean(parsed.data.notifyZoom);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const staleCutoff = new Date(nowMs - staleDays * MS_PER_DAY).toISOString();

    const placeholders = STALE_WATCH_STATUSES.map(() => "?").join(", ");
    const staleRows = this.db
      .prepare(
        `SELECT * FROM opc_planning_tasks
         WHERE status IN (${placeholders})
           AND updated_at < ?
           AND (snoozed_until IS NULL OR snoozed_until <= ?)
         ORDER BY updated_at ASC`,
      )
      .all(...STALE_WATCH_STATUSES, staleCutoff, now) as unknown as TaskRow[];

    const failedRows = this.db
      .prepare(
        `SELECT * FROM opc_planning_tasks
         WHERE status = 'failed'
           AND (snoozed_until IS NULL OR snoozed_until <= ?)
         ORDER BY updated_at DESC`,
      )
      .all(now) as unknown as TaskRow[];

    const staleTasks: StaleTaskAlert[] = staleRows.map((row) => {
      const task = mapTaskRow(row);
      const updatedMs = Date.parse(task.updatedAt);
      const ageDays = Number.isFinite(updatedMs) ? Math.max(1, Math.floor((nowMs - updatedMs) / MS_PER_DAY)) : staleDays;
      return {
        taskId: task.id,
        title: task.title,
        project: task.project,
        status: task.status,
        assigneeType: task.assigneeType,
        assigneeName: task.assigneeName,
        staleDays: ageDays,
        updatedAt: task.updatedAt,
        reason: "stale",
      };
    });

    const failedTasks: StaleTaskAlert[] = failedRows.map((row) => {
      const task = mapTaskRow(row);
      const updatedMs = Date.parse(task.updatedAt);
      const ageDays = Number.isFinite(updatedMs) ? Math.max(0, Math.floor((nowMs - updatedMs) / MS_PER_DAY)) : 0;
      return {
        taskId: task.id,
        title: task.title,
        project: task.project,
        status: task.status,
        assigneeType: task.assigneeType,
        assigneeName: task.assigneeName,
        staleDays: ageDays,
        updatedAt: task.updatedAt,
        reason: "failed",
      };
    });

    const alerts: StaleTaskAlert[] = [...staleTasks, ...failedTasks];
    let notifiedZoom = false;
    if (notifyZoomRequested && alerts.length > 0 && this.hooks.notifyPatrolToZoom) {
      this.hooks.notifyPatrolToZoom(alerts);
      notifiedZoom = true;
    }

    const reportId = `ptr_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.db
      .prepare(
        `INSERT INTO opc_patrol_runs (
          id, stale_days, stale_count, failed_count, alerts_json, notified_zoom, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(reportId, staleDays, staleTasks.length, failedTasks.length, JSON.stringify(alerts), notifiedZoom ? 1 : 0, now);

    const report: PatrolReport = {
      id: reportId,
      staleDays,
      staleCount: staleTasks.length,
      failedCount: failedTasks.length,
      staleTasks,
      failedTasks,
      alerts,
      notifiedZoom,
      createdAt: now,
    };

    this.hooks.onPatrolReport?.(report);
    for (const listener of this.patrolListeners) {
      listener(report);
    }

    return report;
  }

  listPatrolHistory(limit = 10): PatrolReport[] {
    const safeLimit = clampInt(limit, 10, 1, 100);
    const rows = this.db
      .prepare("SELECT * FROM opc_patrol_runs ORDER BY created_at DESC LIMIT ?")
      .all(safeLimit) as unknown as PatrolRow[];
    return rows.map(mapPatrolRow);
  }

  // ---- 5. ROI Dashboard + 16-Week Heatmap + 14-Day Trend ----

  getRoiDashboard(days = 30): RoiDashboardResponse {
    const safeDays = clampInt(days, 30, 1, 365);
    const cutoff = windowStartIso(safeDays);

    const taskRows = this.db
      .prepare(
        `SELECT * FROM opc_planning_tasks
         WHERE created_at >= ? OR updated_at >= ? OR (completed_at IS NOT NULL AND completed_at >= ?)`,
      )
      .all(cutoff, cutoff, cutoff) as unknown as TaskRow[];
    const windowTasks = taskRows.map(mapTaskRow);

    const allRows = this.db.prepare("SELECT * FROM opc_planning_tasks").all() as unknown as TaskRow[];
    const allTasks = allRows.map(mapTaskRow);

    const statusCounts = new Map<PlanningTaskStatus, number>();
    let completedCount = 0;
    const taskAgentStatsByProject = new Map<string, { runs: number; tokens: number; costUsd: number }>();

    for (const task of windowTasks) {
      statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1);
      if (isCompletedStatus(task.status)) completedCount += 1;

      const hasAgentWork = Boolean(task.latestRunId || task.tokenUsed > 0 || task.costUsd > 0);
      if (hasAgentWork) {
        const cur = taskAgentStatsByProject.get(task.project) ?? { runs: 0, tokens: 0, costUsd: 0 };
        cur.runs += task.latestRunId ? 1 : 0;
        cur.tokens += task.tokenUsed;
        cur.costUsd = round4(cur.costUsd + task.costUsd);
        taskAgentStatsByProject.set(task.project, cur);
      }
    }

    const byStatus: StatusCountItem[] = PLANNING_TASK_STATUSES.map((status) => ({
      status,
      count: statusCounts.get(status) ?? 0,
    })).filter((item) => item.count > 0);

    const pomodoroSummary = this.listPomodoros(safeDays);
    const pomodorosByTask = new Map<string, { count: number; mins: number }>();
    const pomodorosByProject = new Map<string, { count: number; mins: number }>();
    for (const s of pomodoroSummary.sessions) {
      const tCur = pomodorosByTask.get(s.taskId) ?? { count: 0, mins: 0 };
      tCur.count += 1;
      tCur.mins += s.durationMins;
      pomodorosByTask.set(s.taskId, tCur);

      const pCur = pomodorosByProject.get(s.project) ?? { count: 0, mins: 0 };
      pCur.count += 1;
      pCur.mins += s.durationMins;
      pomodorosByProject.set(s.project, pCur);
    }

    const hookMetrics: AgentMetricsSummary | undefined = this.hooks.getAgentMetrics?.(safeDays);
    const revenueMap: Record<string, number> = this.hooks.getProjectRevenueUsd?.() ?? {};

    // Collect every known project across tasks, pomodoros, agent metrics, and revenue
    const allProjectNames = new Set<string>();
    for (const t of windowTasks) allProjectNames.add(t.project);
    for (const p of pomodorosByProject.keys()) allProjectNames.add(p);
    if (hookMetrics?.byProject) {
      for (const p of Object.keys(hookMetrics.byProject)) allProjectNames.add(p);
    }
    for (const p of Object.keys(revenueMap)) allProjectNames.add(p);

    // Merge agent metrics per project (avoid double-counting synced runs while preserving task-only costs)
    let mergedRuns = 0;
    let mergedTokens = 0;
    let mergedCostUsd = 0;
    const mergedAgentByProject = new Map<string, { runs: number; tokens: number; costUsd: number }>();

    for (const project of allProjectNames) {
      const fromTask = taskAgentStatsByProject.get(project) ?? { runs: 0, tokens: 0, costUsd: 0 };
      const fromHook = hookMetrics?.byProject?.[project] ?? { runs: 0, tokens: 0, costUsd: 0 };
      const runs = Math.max(fromHook.runs, fromTask.runs);
      const tokens = Math.max(fromHook.tokens, fromTask.tokens);
      const costUsd = round4(Math.max(fromHook.costUsd, fromTask.costUsd));
      mergedAgentByProject.set(project, { runs, tokens, costUsd });
      mergedRuns += runs;
      mergedTokens += tokens;
      mergedCostUsd = round4(mergedCostUsd + costUsd);
    }

    if (hookMetrics) {
      mergedRuns = Math.max(mergedRuns, hookMetrics.totalRuns);
      mergedTokens = Math.max(mergedTokens, hookMetrics.totalTokensUsed);
      mergedCostUsd = round4(Math.max(mergedCostUsd, hookMetrics.totalCostUsd));
    }

    // Build Project-level ROI entries
    const epicRoi: EpicRoiEntry[] = [];
    const sortedProjects = Array.from(allProjectNames).sort((a, b) => a.localeCompare(b));
    for (const project of sortedProjects) {
      const pTasks = windowTasks.filter((t) => t.project === project);
      const pCompleted = pTasks.filter((t) => isCompletedStatus(t.status)).length;
      const pPom = pomodorosByProject.get(project) ?? { count: 0, mins: 0 };
      const pAgent = mergedAgentByProject.get(project) ?? { runs: 0, tokens: 0, costUsd: 0 };
      const revenueUsd = round2(Number(revenueMap[project] ?? 0) || 0);
      epicRoi.push({
        id: `project:${project}`,
        kind: "project",
        name: project,
        project,
        totalTasks: pTasks.length,
        completedTasks: pCompleted,
        pomodoros: pPom.count,
        humanHours: round2(pPom.mins / 60),
        agentCostUsd: pAgent.costUsd,
        revenueUsd,
        costPerCompletedTask: pCompleted > 0 ? round4(pAgent.costUsd / pCompleted) : null,
      });
    }

    // Build Epic-level ROI entries
    const subtasksByParent = new Map<string, PlanningTask[]>();
    for (const t of allTasks) {
      if (!t.parentId) continue;
      const list = subtasksByParent.get(t.parentId);
      if (list) list.push(t);
      else subtasksByParent.set(t.parentId, [t]);
    }

    const epics = allTasks
      .filter((t) => t.type === "epic")
      .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));

    for (const epic of epics) {
      const children = subtasksByParent.get(epic.id) ?? [];
      const memberTasks = [epic, ...children];
      const totalTasks = children.length > 0 ? children.length : 1;
      const completedTasks =
        children.length > 0
          ? children.filter((c) => isCompletedStatus(c.status)).length
          : isCompletedStatus(epic.status)
            ? 1
            : 0;

      let pomCount = 0;
      let pomMins = 0;
      let agentCostUsd = 0;
      for (const m of memberTasks) {
        const s = pomodorosByTask.get(m.id);
        if (s) {
          pomCount += s.count;
          pomMins += s.mins;
        }
        agentCostUsd = round4(agentCostUsd + m.costUsd);
      }

      const metaRevenue = typeof epic.metadata.revenueUsd === "number" ? epic.metadata.revenueUsd : 0;
      epicRoi.push({
        id: epic.id,
        kind: "epic",
        name: epic.title,
        project: epic.project,
        totalTasks,
        completedTasks,
        pomodoros: pomCount,
        humanHours: round2(pomMins / 60),
        agentCostUsd,
        revenueUsd: round2(metaRevenue),
        costPerCompletedTask: completedTasks > 0 ? round4(agentCostUsd / completedTasks) : null,
      });
    }

    const totalTasks = windowTasks.length;
    return {
      days: safeDays,
      generatedAt: nowIso(),
      tasks: {
        total: totalTasks,
        completed: completedCount,
        completionRate: totalTasks > 0 ? round1((completedCount / totalTasks) * 100) : 0,
        byStatus,
      },
      agents: {
        totalRuns: mergedRuns,
        totalTokensUsed: mergedTokens,
        totalCostUsd: mergedCostUsd,
      },
      human: {
        totalPomodoros: pomodoroSummary.totalSessions,
        estimatedHours: pomodoroSummary.estimatedHours,
        highEnergyCount: pomodoroSummary.highEnergyCount,
        lowEnergyCount: pomodoroSummary.lowEnergyCount,
        highEnergyRate: pomodoroSummary.highEnergyRate,
      },
      epicRoi,
    };
  }

  getDailyTrend(days = 112): DailyTrendPoint[] {
    const safeDays = clampInt(days, 112, 1, 366);
    const now = new Date();
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const startMs = todayUtcMs - (safeDays - 1) * MS_PER_DAY;
    const cutoffIso = new Date(startMs).toISOString();

    const pointsMap = new Map<string, DailyTrendPoint>();
    const orderedDates: string[] = [];
    for (let i = 0; i < safeDays; i++) {
      const date = utcDateKey(new Date(startMs + i * MS_PER_DAY));
      orderedDates.push(date);
      pointsMap.set(date, {
        date,
        completed: 0,
        created: 0,
        agentRuns: 0,
        pomodoroCount: 0,
        highEnergyPomodoros: 0,
      });
    }

    const taskRows = this.db
      .prepare(
        `SELECT created_at, updated_at, completed_at, latest_run_id
         FROM opc_planning_tasks
         WHERE created_at >= ? OR updated_at >= ? OR (completed_at IS NOT NULL AND completed_at >= ?)`,
      )
      .all(cutoffIso, cutoffIso, cutoffIso) as unknown as Array<{
      created_at: string;
      updated_at: string;
      completed_at: string | null;
      latest_run_id: string | null;
    }>;

    const taskAgentRunsByDay = new Map<string, number>();
    for (const row of taskRows) {
      const createdDay = isoDateKey(row.created_at);
      if (createdDay) {
        const pt = pointsMap.get(createdDay);
        if (pt) pt.created += 1;
      }
      const completedDay = isoDateKey(row.completed_at);
      if (completedDay) {
        const pt = pointsMap.get(completedDay);
        if (pt) pt.completed += 1;
      }
      if (row.latest_run_id) {
        const runDay = isoDateKey(row.updated_at) ?? createdDay;
        if (runDay && pointsMap.has(runDay)) {
          taskAgentRunsByDay.set(runDay, (taskAgentRunsByDay.get(runDay) ?? 0) + 1);
        }
      }
    }

    const pomodoroRows = this.db
      .prepare(
        `SELECT energy_level, completed_at
         FROM opc_pomodoro_sessions
         WHERE completed_at >= ?`,
      )
      .all(cutoffIso) as unknown as Array<{ energy_level: PlanningEnergyLevel; completed_at: string }>;

    for (const row of pomodoroRows) {
      const day = isoDateKey(row.completed_at);
      if (!day) continue;
      const pt = pointsMap.get(day);
      if (!pt) continue;
      pt.pomodoroCount += 1;
      if (row.energy_level === "high") pt.highEnergyPomodoros += 1;
    }

    const hookByDay = this.hooks.getAgentMetrics?.(safeDays)?.byDay ?? {};
    for (const date of orderedDates) {
      const pt = pointsMap.get(date)!;
      const fromTask = taskAgentRunsByDay.get(date) ?? 0;
      const fromHook = hookByDay[date]?.runs ?? 0;
      pt.agentRuns = Math.max(fromHook, fromTask);
    }

    return orderedDates.map((date) => pointsMap.get(date)!);
  }
}

async function readJsonBody(c: Context, optional = false): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw.trim()) {
    if (optional) return {};
    throw new ApiError(400, "bad_json", "请求体不能为空");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
  }
}

export interface RegisterTaskPlanningOptions {
  hooks?: TaskPlanningHooks;
  submitToken?: string;
}

export function registerTaskPlanningRoutes(
  app: Hono,
  db: DatabaseSync,
  providers: ProvidersStore | undefined,
  user: (c: Context) => unknown,
  options?: RegisterTaskPlanningOptions,
): TaskPlanningStore {
  const store = new TaskPlanningStore(db, providers, options?.hooks);
  const { permits } = submitAuth(options?.submitToken);
  const base = "/api/opc/planning" as const;

  const guard = async (c: Context, next: () => Promise<void>) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  };

  app.use(base, guard);
  app.use(`${base}/*`, guard);

  app.get(`${base}/kanban`, (c) => {
    const project = c.req.query("project") || undefined;
    const includeSubtasks = c.req.query("includeSubtasks") === "true" || c.req.query("includeSubtasks") === "1";
    return c.json(store.getKanban(project, { includeSubtasks }));
  });

  app.get(`${base}/tasks`, (c) => {
    const statusParam = c.req.query("status");
    const typeParam = c.req.query("type");
    const assigneeTypeParam = c.req.query("assigneeType");
    const parentIdParam = c.req.query("parentId");
    const includeSubtasks = c.req.query("includeSubtasks") === "true" || c.req.query("includeSubtasks") === "1";

    const filters: TaskListFilters = {
      project: c.req.query("project") || undefined,
      mainlineId: c.req.query("mainlineId") || undefined,
      assetId: c.req.query("assetId") || undefined,
      includeSubtasks,
    };

    if (statusParam) {
      const parsedStatus = taskStatusSchema.safeParse(statusParam);
      if (!parsedStatus.success) {
        throw new ApiError(400, "invalid_status", `不支持的状态筛选: ${statusParam}`);
      }
      filters.status = parsedStatus.data;
    }
    if (typeParam) {
      const parsedType = taskTypeSchema.safeParse(typeParam);
      if (!parsedType.success) {
        throw new ApiError(400, "invalid_type", `不支持的类型筛选: ${typeParam}`);
      }
      filters.type = parsedType.data;
    }
    if (assigneeTypeParam) {
      const parsedAssignee = assigneeTypeSchema.safeParse(assigneeTypeParam);
      if (!parsedAssignee.success) {
        throw new ApiError(400, "invalid_assignee_type", `不支持的归属类型筛选: ${assigneeTypeParam}`);
      }
      filters.assigneeType = parsedAssignee.data;
    }
    if (parentIdParam !== undefined) {
      filters.parentId = parentIdParam === "null" ? null : parentIdParam;
    }

    return c.json({ tasks: store.listTasks(filters) });
  });

  app.post(`${base}/tasks`, async (c) => {
    const body = await readJsonBody(c);
    return c.json(store.createTask(body), 201);
  });

  app.post(`${base}/epics`, async (c) => {
    const body = await readJsonBody(c);
    return c.json(store.createEpicWithSubtasks(body), 201);
  });

  app.get(`${base}/tasks/:id`, (c) => c.json(store.getTask(c.req.param("id"))));

  app.patch(`${base}/tasks/:id`, async (c) => {
    const body = await readJsonBody(c);
    return c.json(store.updateTask(c.req.param("id"), body));
  });

  app.patch(`${base}/tasks/:id/status`, async (c) => {
    const body = (await readJsonBody(c)) as { status?: unknown };
    return c.json(store.updateStatus(c.req.param("id"), String(body?.status ?? "")));
  });

  app.delete(`${base}/tasks/:id`, (c) => c.json(store.deleteTask(c.req.param("id"))));

  app.post(`${base}/tasks/:id/pomodoro`, async (c) => {
    const body = await readJsonBody(c);
    return c.json(store.recordPomodoro(c.req.param("id"), body), 201);
  });

  app.get(`${base}/pomodoros`, (c) => {
    const days = clampInt(c.req.query("days"), 30, 1, 365);
    return c.json(store.listPomodoros(days));
  });

  app.post(`${base}/tasks/:id/assign-human`, async (c) => {
    const body = await readJsonBody(c, true);
    const parsed = assignHumanSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "assign_input", formatZodIssues(parsed.error));
    }
    let fallbackName: string | undefined;
    if (!parsed.data.name && !permits(c)) {
      const principal = user(c) as { name?: string } | undefined;
      if (principal && typeof principal.name === "string" && principal.name.trim()) {
        fallbackName = principal.name.trim();
      }
    }
    return c.json(store.assignHuman(c.req.param("id"), parsed.data.name ?? fallbackName, parsed.data.assigneeId));
  });

  app.post(`${base}/tasks/:id/dispatch`, async (c) => {
    const body = await readJsonBody(c);
    return c.json(await store.dispatchTask(c.req.param("id"), body));
  });

  app.post(`${base}/tasks/:id/snooze`, async (c) => {
    const body = await readJsonBody(c, true);
    const parsed = snoozeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "snooze_input", formatZodIssues(parsed.error));
    }
    return c.json(store.snoozeTask(c.req.param("id"), parsed.data.days));
  });

  app.get(`${base}/ready`, (c) => {
    const limit = clampInt(c.req.query("limit"), 20, 1, 500);
    return c.json({ tasks: store.listReadyForAutoDispatch(limit) });
  });

  app.get(`${base}/roi`, (c) => {
    const days = clampInt(c.req.query("days"), 30, 1, 365);
    return c.json(store.getRoiDashboard(days));
  });

  app.get(`${base}/daily-trend`, (c) => {
    const days = clampInt(c.req.query("days"), 112, 1, 366);
    return c.json({ days, points: store.getDailyTrend(days) });
  });

  app.post(`${base}/patrol`, async (c) => {
    const body = await readJsonBody(c, true);
    return c.json(store.runPatrol(body));
  });

  app.get(`${base}/patrol/history`, (c) => {
    const limit = clampInt(c.req.query("limit"), 10, 1, 100);
    return c.json({ runs: store.listPatrolHistory(limit) });
  });

  return store;
}
