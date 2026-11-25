import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ResourcesDepartment } from "../domains/resources/index.ts";
import { isDigestOrNonActionableNoise, stripCandidateTitlePrefix } from "../kernel/admission-filter.ts";
import type { AssetRegistry } from "../kernel/registry.ts";
import {
  TRIAGE_STATUSES,
  TRIAGE_VERDICT_ACTIONS,
  extractTaskTriage,
  getTaskTriageStatus,
  type PlanningTask,
  type PlanningTaskStatus,
  type PlanningTaskWithSubtasks,
  type TaskTriageMeta,
  type TriageConfig,
  type TriageFunnelCounts,
  type TriageRunItemResult,
  type TriageRunReport,
  type TriageStatus,
  type TriageStatusResponse,
  type TriageVerdict,
  type TriageVerdictAction,
} from "../task-planning-types.ts";
import type { DarkFactoryStore } from "./dark-factory.ts";
import { ApiError } from "./logic.ts";
import type { ProvidersStore } from "./providers.ts";
import { StageHomeClient } from "./stage-home-client.ts";
import type { TaskPlanningStore } from "./task-planning.ts";
import { submitAuth } from "./workflow/http.ts";

const execFileAsync = promisify(execFile);

/** Agent Home `/api/bot-work/tasks` enforces `1..3500` characters on `input`. */
export const MAX_BOT_TRIAGE_PROMPT_CHARS = 3400;

const TERMINAL_BOT_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

const EXPLORATORY_IDEA_PATTERN =
  /(?:试水|试用|评估|借鉴|关注|探索|参考.{0,30}思路|套用.{0,20}模板|对比测试|追踪.{0,20}账本|试点.{0,20}模式|关注本地模型|重审个人与团队)/i;

const CONCRETE_BUG_OR_CODE_ANCHOR_PATTERN =
  /(?:修复|fix\b|bug\b|crash|崩溃|报错|异常|stack|traceback|exit\s*code|\bsrc\/|\bweb\/|\bscripts\/|\.tsx?\b|\.py\b|\.rs\b|\[A\/B|\[Build\])/i;

export interface TriageBotRunInput {
  botId: string;
  prompt: string;
  tasks: PlanningTask[];
  batchId: string;
}

export interface TriageBotRunResult {
  verdicts: TriageVerdict[];
  botId?: string | null;
  botTaskId?: string | null;
  rawOutput?: string;
}

export type TriageBotRunner = (input: TriageBotRunInput) => Promise<TriageBotRunResult>;

export interface AgyCodeCheckInput {
  task: PlanningTask;
  repoPath: string;
  reason?: string;
}

export interface AgyCodeCheckResult {
  verdict: "real_ready" | "already_done" | "noise_archive" | "needs_scope";
  confidence: number;
  reason: string;
  evidence?: string | null;
}

export type AgyCodeCheckRunner = (input: AgyCodeCheckInput) => Promise<AgyCodeCheckResult>;

export interface SweepOptions {
  dryRun?: boolean;
}

export interface BotTriageBatchOptions {
  batchSize?: number;
  dryRun?: boolean;
  useAgyCodeCheck?: boolean;
  excludeTaskIds?: Iterable<string>;
}

export interface RollingCycleOptions {
  dryRun?: boolean;
  batchSize?: number;
  useAgyCodeCheck?: boolean;
  forceRoll?: boolean;
  skipRoll?: boolean;
}

export type ManualTriageAction =
  | "verify"
  | "needs_scope"
  | "idea_demote"
  | "noise_archive"
  | "superseded"
  | "reset_unreviewed"
  | "code_check";

export interface ManualTriageTaskInput {
  action?: ManualTriageAction;
  status?: TriageStatus;
  reason?: string;
  evidence?: string;
  project?: string;
  verifyCommand?: string;
  reviewer?: string;
}

export interface ManualTriageTaskResult {
  task: PlanningTaskWithSubtasks;
  item: TriageRunItemResult;
  funnel: TriageFunnelCounts;
  demotedIdeaId?: string | null;
}

export interface TaskTriageServiceDeps {
  taskPlanning: TaskPlanningStore;
  darkFactory?: DarkFactoryStore;
  resources?: ResourcesDepartment;
  registry?: AssetRegistry;
  providers?: ProvidersStore;
  stageHomeClient?: StageHomeClient;
  resolveRepoPath?: (project: string) => string | null;
  botRunner?: TriageBotRunner;
  codeCheckRunner?: AgyCodeCheckRunner;
  botPollTimeoutMs?: number;
  botPollIntervalMs?: number;
  codeCheckTimeoutMs?: number;
  agyBinary?: string;
  nowFn?: () => number;
}

export interface RegisterTaskTriageDeps extends TaskTriageServiceDeps {
  user?: (c: Context) => unknown;
  requireUser?: (c: Context) => unknown;
  submitToken?: string;
  service?: TaskTriageService;
}

const triageConfigPatchSchema = z.object({
  autoSweepEnabled: z.boolean().optional(),
  autoRollEnabled: z.boolean().optional(),
  useAgyCodeCheck: z.boolean().optional(),
  batchSize: z.number().int().min(1).max(50).optional(),
  maxAutoDispatchPerCycle: z.number().int().min(0).max(10).optional(),
  sweepIntervalMins: z.number().int().min(1).max(1440).optional(),
  noiseConfidenceThreshold: z.number().min(0.5).max(1).optional(),
  ideaConfidenceThreshold: z.number().min(0.5).max(1).optional(),
});

const sweepBodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

const runOnceBodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
  batchSize: z.number().int().min(1).max(50).optional(),
  useAgyCodeCheck: z.boolean().optional(),
  forceRoll: z.boolean().optional().default(false),
  skipRoll: z.boolean().optional().default(false),
});

const manualTaskTriageSchema = z.object({
  action: z
    .enum([
      "verify",
      "needs_scope",
      "idea_demote",
      "noise_archive",
      "superseded",
      "reset_unreviewed",
      "code_check",
    ])
    .optional(),
  status: z.enum(TRIAGE_STATUSES).optional(),
  reason: z.string().trim().max(2000).optional(),
  evidence: z.string().trim().max(4000).optional(),
  project: z.string().trim().min(1).max(120).optional(),
  verifyCommand: z.string().trim().max(2000).optional(),
  reviewer: z.string().trim().max(120).optional(),
});

const VERDICT_SET = new Set<string>(TRIAGE_VERDICT_ACTIONS);

function defaultTriageConfig(nowIso: string): TriageConfig {
  return {
    autoSweepEnabled: true,
    autoRollEnabled: false,
    useAgyCodeCheck: true,
    batchSize: 15,
    maxAutoDispatchPerCycle: 1,
    sweepIntervalMins: 30,
    noiseConfidenceThreshold: 0.8,
    ideaConfidenceThreshold: 0.75,
    updatedAt: nowIso,
  };
}

function clampConfidence(raw: unknown, fallback = 0.7): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, Math.round(num * 1000) / 1000));
}

function cleanIdeaTitle(rawTitle: string): string {
  const cleaned = stripCandidateTitlePrefix(rawTitle)
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || rawTitle.trim()).slice(0, 180);
}

function stripMarkdownFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

export function parseTriageVerdictsFromText(raw: string): TriageVerdict[] {
  const stripped = stripMarkdownFences(raw);
  const candidates: string[] = [stripped];
  const firstBracket = stripped.indexOf("[");
  const lastBracket = stripped.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(stripped.slice(firstBracket, lastBracket + 1));
  }
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }

  let parsed: unknown = null;
  for (const text of candidates) {
    if (!text) continue;
    try {
      parsed = JSON.parse(text);
      break;
    } catch {
      // try next slice
    }
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { verdicts?: unknown }).verdicts)
      ? ((parsed as { verdicts: unknown[] }).verdicts)
      : null;

  if (!list) {
    throw new Error("Bot 审查返回内容中未解析出合法的 JSON 裁决数组");
  }

  const out: TriageVerdict[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const taskId = String(rec.taskId ?? rec.id ?? "").trim();
    const rawVerdict = String(rec.verdict ?? rec.action ?? "").trim();
    if (!taskId || seen.has(taskId) || !VERDICT_SET.has(rawVerdict)) continue;
    seen.add(taskId);
    out.push({
      taskId,
      verdict: rawVerdict as TriageVerdictAction,
      confidence: clampConfidence(rec.confidence, 0.75),
      reason: String(rec.reason ?? "").trim() || `Bot 裁决：${rawVerdict}`,
      suggestedProject:
        typeof rec.suggestedProject === "string" && rec.suggestedProject.trim()
          ? rec.suggestedProject.trim()
          : null,
      suggestedVerifyCommand:
        typeof rec.suggestedVerifyCommand === "string" && rec.suggestedVerifyCommand.trim()
          ? rec.suggestedVerifyCommand.trim()
          : null,
      evidence:
        typeof rec.evidence === "string" && rec.evidence.trim() ? rec.evidence.trim() : null,
    });
  }
  return out;
}

export function parseCodeCheckFromText(raw: string): AgyCodeCheckResult {
  const stripped = stripMarkdownFences(raw);
  const candidates: string[] = [stripped];
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }

  for (const text of candidates) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rawVerdict = String(parsed.verdict ?? "").trim();
        const verdict: AgyCodeCheckResult["verdict"] =
          rawVerdict === "real_ready" ||
          rawVerdict === "already_done" ||
          rawVerdict === "noise_archive" ||
          rawVerdict === "needs_scope"
            ? rawVerdict
            : rawVerdict === "still_exists"
              ? "real_ready"
              : "needs_scope";
        return {
          verdict,
          confidence: clampConfidence(parsed.confidence, 0.8),
          reason: String(parsed.reason ?? "").trim() || `agy 只读复核结论：${verdict}`,
          evidence:
            typeof parsed.evidence === "string" && parsed.evidence.trim()
              ? parsed.evidence.trim()
              : null,
        };
      }
    } catch {
      // try next
    }
  }

  return {
    verdict: "needs_scope",
    confidence: 0.5,
    reason: "agy 只读代码复核未返回结构化 JSON，已转人工补范围确认",
    evidence: raw.trim().slice(0, 600) || null,
  };
}

export function fallbackHeuristicTriage(task: PlanningTask): TriageVerdict | null {
  const noise = isDigestOrNonActionableNoise(task.title, task.description);
  if (noise.noisy) {
    return {
      taskId: task.id,
      verdict: "noise_archive",
      confidence: 0.95,
      reason: noise.reason ?? "命中确定性日报噪音规则",
    };
  }
  if (
    task.sourceRef?.startsWith("signal://") &&
    EXPLORATORY_IDEA_PATTERN.test(task.title) &&
    !CONCRETE_BUG_OR_CODE_ANCHOR_PATTERN.test(task.title)
  ) {
    return {
      taskId: task.id,
      verdict: "idea_demote",
      confidence: 0.8,
      reason: "属于每日情报收集的技术雷达/探索类灵感（缺少明确仓库改动边界），已降级沉淀至公司想法库",
    };
  }
  return null;
}

export interface BotTriageMainlineSummary {
  slug: string;
  name: string;
  status: string;
  priorityWeight: number;
  freezeNonMainline: boolean;
}

export interface BotTriageAssetSummary {
  slug: string;
  name: string;
  localRepoPath: string;
  verifyCommand: string;
  paused: boolean;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  const cleaned = collapseWhitespace(text);
  if (cleaned.length <= maxLen) return cleaned;
  return maxLen <= 1 ? cleaned.slice(0, maxLen) : `${cleaned.slice(0, maxLen - 1)}…`;
}

function formatBotTriagePromptWithLimits(params: {
  mainlines: BotTriageMainlineSummary[];
  assets: BotTriageAssetSummary[];
  tasks: PlanningTask[];
  titleLimit: number;
  descLimit: number;
  maxMainlines: number;
  maxAssets: number;
  includeRepoPath: boolean;
}): string {
  const header = [
    "你是OPC产研VP Bot，请分诊待办任务，严格只输出JSON数组(无其他文字)。",
    '格式:[{"taskId":"...","verdict":"noise_archive|idea_demote|already_done|needs_code_check|needs_scope|real_ready","confidence":0.9,"reason":"简短中文理由","suggestedProject":null,"suggestedVerifyCommand":null,"evidence":null}]',
    "规则:noise_archive=日报/榜单噪音;idea_demote=技术雷达/探索灵感(转想法库);already_done=已完成/过时;needs_code_check=具体仓库Bug/改造需只读查代码;needs_scope=缺仓库/范围/验收;real_ready=边界清晰可直接派工。",
  ].join("\n");

  const mainlinePart = params.mainlines
    .slice(0, params.maxMainlines)
    .map((m) => `${m.slug}(w${m.priorityWeight}${m.freezeNonMainline ? ",frozen" : ""})`)
    .join(",");

  const activeAssets = params.assets
    .filter((a) => !a.paused)
    .sort((a, b) => Number(Boolean(b.localRepoPath)) - Number(Boolean(a.localRepoPath)))
    .slice(0, params.maxAssets);
  const assetPart = activeAssets
    .map((a) => {
      const repo = params.includeRepoPath && a.localRepoPath ? `(${truncateText(a.localRepoPath, 120)})` : "";
      return `${a.slug}${repo}`;
    })
    .join("; ");

  const compactTasks = params.tasks.map((t) => {
    const entry: Record<string, unknown> = {
      taskId: t.id,
      project: truncateText(t.project, 48),
      type: t.type,
      priority: t.priority,
      title: truncateText(t.title, params.titleLimit),
    };
    if (t.sourceRef) {
      entry.sourceRef = truncateText(t.sourceRef, 40);
    }
    if (params.descLimit > 0 && t.description?.trim()) {
      entry.desc = truncateText(t.description, params.descLimit);
    }
    return entry;
  });

  const sections = [header];
  if (mainlinePart) sections.push(`主线:${truncateText(mainlinePart, 240)}`);
  if (assetPart) sections.push(`活跃资产:${truncateText(assetPart, 1000)}`);
  sections.push(`任务:${JSON.stringify(compactTasks)}`);
  return sections.join("\n");
}

export function buildBotTriagePrompt(params: {
  mainlines: BotTriageMainlineSummary[];
  assets: BotTriageAssetSummary[];
  tasks: PlanningTask[];
  maxChars?: number;
}): string {
  const maxChars = Math.max(800, Math.min(MAX_BOT_TRIAGE_PROMPT_CHARS, params.maxChars ?? MAX_BOT_TRIAGE_PROMPT_CHARS));

  const presets: Array<{
    titleLimit: number;
    descLimit: number;
    maxMainlines: number;
    maxAssets: number;
    includeRepoPath: boolean;
  }> = [
    { titleLimit: 160, descLimit: 160, maxMainlines: 6, maxAssets: 12, includeRepoPath: true },
    { titleLimit: 120, descLimit: 80, maxMainlines: 6, maxAssets: 10, includeRepoPath: true },
    { titleLimit: 100, descLimit: 0, maxMainlines: 4, maxAssets: 8, includeRepoPath: true },
    { titleLimit: 72, descLimit: 0, maxMainlines: 4, maxAssets: 6, includeRepoPath: false },
    { titleLimit: 40, descLimit: 0, maxMainlines: 2, maxAssets: 4, includeRepoPath: false },
  ];

  let prompt = "";
  for (const preset of presets) {
    prompt = formatBotTriagePromptWithLimits({
      mainlines: params.mainlines,
      assets: params.assets,
      tasks: params.tasks,
      ...preset,
    });
    if (prompt.length <= maxChars) {
      return prompt;
    }
  }

  // Last-resort valid-JSON clamp (e.g., if a caller passes dozens of tasks directly to buildBotTriagePrompt)
  const minimalHeader = [
    '分诊任务，只输出JSON数组:[{"taskId":"...","verdict":"noise_archive|idea_demote|already_done|needs_code_check|needs_scope|real_ready","confidence":0.9,"reason":"理由"}]',
  ].join("\n");
  const fitted: Array<{ taskId: string; project: string; title: string }> = [];
  for (const t of params.tasks) {
    const next = {
      taskId: t.id,
      project: truncateText(t.project, 24),
      title: truncateText(t.title, 48),
    };
    const candidate = `${minimalHeader}\n任务:${JSON.stringify([...fitted, next])}`;
    if (candidate.length > maxChars) break;
    fitted.push(next);
  }
  return `${minimalHeader}\n任务:${JSON.stringify(fitted)}`;
}

export function splitTasksIntoPromptBatches(params: {
  mainlines: BotTriageMainlineSummary[];
  assets: BotTriageAssetSummary[];
  tasks: PlanningTask[];
  maxChars?: number;
}): Array<{ tasks: PlanningTask[]; prompt: string }> {
  const maxChars = Math.max(800, Math.min(MAX_BOT_TRIAGE_PROMPT_CHARS, params.maxChars ?? MAX_BOT_TRIAGE_PROMPT_CHARS));
  if (params.tasks.length === 0) return [];

  const batches: Array<{ tasks: PlanningTask[]; prompt: string }> = [];
  let current: PlanningTask[] = [];
  let currentPrompt = "";

  const buildReadableCandidate = (tasks: PlanningTask[]) =>
    formatBotTriagePromptWithLimits({
      mainlines: params.mainlines,
      assets: params.assets,
      tasks,
      titleLimit: 140,
      descLimit: 120,
      maxMainlines: 6,
      maxAssets: 12,
      includeRepoPath: true,
    });

  for (const task of params.tasks) {
    const candidateTasks = [...current, task];
    const candidatePrompt = buildReadableCandidate(candidateTasks);
    if (candidatePrompt.length <= maxChars) {
      current = candidateTasks;
      currentPrompt = candidatePrompt;
      continue;
    }

    if (current.length > 0) {
      batches.push({ tasks: current, prompt: currentPrompt });
      current = [];
      currentPrompt = "";
    }

    // Try task alone with rich formatting, or fall back to buildBotTriagePrompt strict clamp
    const soloReadable = buildReadableCandidate([task]);
    if (soloReadable.length <= maxChars) {
      current = [task];
      currentPrompt = soloReadable;
    } else {
      const clampedPrompt = buildBotTriagePrompt({
        mainlines: params.mainlines,
        assets: params.assets,
        tasks: [task],
        maxChars,
      });
      batches.push({ tasks: [task], prompt: clampedPrompt });
    }
  }

  if (current.length > 0) {
    batches.push({ tasks: current, prompt: currentPrompt });
  }

  return batches;
}

function buildAgyCodeCheckPrompt(task: PlanningTask, repoPath: string, reason?: string): string {
  return [
    "你正在执行【只读代码现状复核】（Read-Only Plan Mode）。严禁修改任何文件，严禁执行破坏性命令。",
    `当前仓库目录：${repoPath}`,
    `待核实任务 ID：${task.id}`,
    `任务标题：${task.title}`,
    `任务描述：${(task.description || "(无)").slice(0, 1500)}`,
    reason ? `产研 Bot 初审说明：${reason}` : "",
    "",
    "请仅通过只读检索代码库，核实该任务描述的问题/缺口在当前代码中是否仍然存在、是否已经完成，或者是否为无效噪音。",
    "最后只输出一个合法 JSON 对象：",
    `{"verdict":"real_ready"|"already_done"|"noise_archive"|"needs_scope","confidence":0.9,"reason":"简洁中文结论","evidence":"命中的文件路径与关键行号/符号"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveDefaultAgyBinary(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.OPC_AGY_BIN?.trim()) return process.env.OPC_AGY_BIN.trim();
  const localBin = join(homedir(), ".local", "bin", "agy");
  if (existsSync(localBin)) return localBin;
  return "agy";
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join(" / ");
}

async function readOptionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "bad_json", "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
  }
}

export class TaskTriageService {
  private readonly db: DatabaseSync;
  private readonly taskPlanning: TaskPlanningStore;
  private readonly darkFactory?: DarkFactoryStore;
  private readonly resources?: ResourcesDepartment;
  private readonly registry?: AssetRegistry;
  private readonly providers?: ProvidersStore;
  private readonly stageHomeClient: StageHomeClient;
  private readonly resolveRepoPathHook?: (project: string) => string | null;
  private readonly botRunner: TriageBotRunner;
  private readonly codeCheckRunner: AgyCodeCheckRunner;
  private readonly botPollTimeoutMs: number;
  private readonly botPollIntervalMs: number;
  private readonly codeCheckTimeoutMs: number;
  private readonly agyBinary: string;
  private readonly nowFn: () => number;
  private inFlight = false;

  constructor(db: DatabaseSync, deps: TaskTriageServiceDeps) {
    this.db = db;
    this.taskPlanning = deps.taskPlanning;
    this.darkFactory = deps.darkFactory;
    this.resources = deps.resources;
    this.registry = deps.registry;
    this.providers = deps.providers;
    this.stageHomeClient = deps.stageHomeClient ?? new StageHomeClient();
    this.resolveRepoPathHook = deps.resolveRepoPath;
    this.botPollTimeoutMs = Math.max(1000, deps.botPollTimeoutMs ?? 90_000);
    this.botPollIntervalMs = Math.max(50, deps.botPollIntervalMs ?? 1500);
    this.codeCheckTimeoutMs = Math.max(1000, deps.codeCheckTimeoutMs ?? 90_000);
    this.agyBinary = resolveDefaultAgyBinary(deps.agyBinary);
    this.nowFn = deps.nowFn ?? (() => Date.now());
    this.botRunner = deps.botRunner ?? ((input) => this.defaultBotRunner(input));
    this.codeCheckRunner = deps.codeCheckRunner ?? ((input) => this.defaultAgyCodeCheckRunner(input));

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_triage_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_triage_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        scanned_count INTEGER NOT NULL DEFAULT 0,
        noise_archived_count INTEGER NOT NULL DEFAULT 0,
        idea_demoted_count INTEGER NOT NULL DEFAULT 0,
        superseded_count INTEGER NOT NULL DEFAULT 0,
        verified_count INTEGER NOT NULL DEFAULT 0,
        needs_scope_count INTEGER NOT NULL DEFAULT 0,
        code_checked_count INTEGER NOT NULL DEFAULT 0,
        dispatched_count INTEGER NOT NULL DEFAULT 0,
        report_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_triage_runs_started
        ON opc_triage_runs(started_at DESC);

      CREATE TABLE IF NOT EXISTS company_notes(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        reference TEXT NOT NULL
      );
    `);
  }

  private nowIso(): string {
    return new Date(this.nowFn()).toISOString();
  }

  private hasTable(tableName: string): boolean {
    try {
      return Boolean(
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName),
      );
    } catch {
      return false;
    }
  }

  // ---- Config Persistence ----

  getConfig(): TriageConfig {
    const row = this.db
      .prepare("SELECT config_json, updated_at FROM opc_triage_state WHERE singleton = 1")
      .get() as { config_json?: string; updated_at?: string } | undefined;
    const base = defaultTriageConfig(row?.updated_at ?? this.nowIso());
    if (!row?.config_json) return base;
    try {
      const parsed = JSON.parse(row.config_json) as Partial<TriageConfig>;
      return {
        ...base,
        ...parsed,
        updatedAt: String(row.updated_at || parsed.updatedAt || base.updatedAt),
      };
    } catch {
      return base;
    }
  }

  updateConfig(rawPatch: Partial<TriageConfig> | unknown): TriageConfig {
    const parsed = triageConfigPatchSchema.safeParse(rawPatch ?? {});
    if (!parsed.success) {
      throw new ApiError(400, "triage_config_input", formatZodIssues(parsed.error));
    }
    const current = this.getConfig();
    const now = this.nowIso();
    const next: TriageConfig = {
      ...current,
      ...parsed.data,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO opc_triage_state (singleton, config_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(next), now);
    return next;
  }

  // ---- Funnel Metrics & Run History ----

  getFunnelCounts(): TriageFunnelCounts {
    const counts: TriageFunnelCounts = {
      totalTodo: 0,
      unreviewed: 0,
      triaging: 0,
      verified: 0,
      needs_scope: 0,
      idea_demoted: 0,
      noise_archived: 0,
      superseded: 0,
    };

    const rows = this.db
      .prepare("SELECT status, type, priority, tags, metadata FROM opc_planning_tasks")
      .all() as Array<{
      status?: string;
      type?: string;
      priority?: number;
      tags?: string;
      metadata?: string;
    }>;

    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      if (row.metadata) {
        try {
          const parsed = JSON.parse(row.metadata) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {
          metadata = {};
        }
      }
      let tags: string[] = [];
      if (row.tags) {
        try {
          const parsed = JSON.parse(row.tags) as unknown;
          if (Array.isArray(parsed)) tags = parsed.map(String);
        } catch {
          tags = [];
        }
      }

      const taskStatus = String(row.status ?? "todo");
      const triageStatus = getTaskTriageStatus({
        metadata,
        type: String(row.type ?? "task"),
        priority: Number(row.priority ?? 5),
        tags,
      });

      if (taskStatus === "todo") {
        counts.totalTodo += 1;
        if (triageStatus === "unreviewed") counts.unreviewed += 1;
        else if (triageStatus === "triaging") counts.triaging += 1;
        else if (triageStatus === "verified") counts.verified += 1;
        else if (triageStatus === "needs_scope") counts.needs_scope += 1;
      }

      if (triageStatus === "idea_demoted") counts.idea_demoted += 1;
      else if (triageStatus === "noise_archived") counts.noise_archived += 1;
      else if (triageStatus === "superseded") counts.superseded += 1;
    }

    return counts;
  }

  getCachedRdBotId(): string | null {
    if (!this.hasTable("opc_executive_state")) return null;
    try {
      const row = this.db
        .prepare("SELECT config FROM opc_executive_state WHERE singleton = 1")
        .get() as { config?: string } | undefined;
      if (!row?.config) return null;
      const cfg = JSON.parse(row.config) as {
        superBotId?: string;
        departmentBotIds?: { rd?: string };
      };
      return cfg.departmentBotIds?.rd || cfg.superBotId || null;
    } catch {
      return null;
    }
  }

  async resolveRdBotId(): Promise<string | null> {
    const cached = this.getCachedRdBotId();
    if (cached) return cached;
    try {
      const bots = await this.stageHomeClient.bots();
      const rdBot = bots.find((b) => b.name === "OPC 产研与工程部 Bot");
      if (rdBot) return rdBot.id;
      const defaultRes = await this.stageHomeClient.call(
        "/api/bot-work/default",
        z.object({ bot: z.object({ id: z.string().min(1) }) }),
      );
      return defaultRes.bot.id;
    } catch {
      return null;
    }
  }

  listRuns(limit = 20): TriageRunReport[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare("SELECT report_json FROM opc_triage_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(safeLimit) as Array<{ report_json?: string }>;
    const reports: TriageRunReport[] = [];
    for (const row of rows) {
      if (!row.report_json) continue;
      try {
        reports.push(JSON.parse(row.report_json) as TriageRunReport);
      } catch {
        // skip corrupted row
      }
    }
    return reports;
  }

  getStatus(): TriageStatusResponse {
    const recentRuns = this.listRuns(15);
    return {
      config: this.getConfig(),
      funnel: this.getFunnelCounts(),
      running: this.inFlight,
      readyVerifiedCount: this.taskPlanning.listReadyForAutoDispatch(200).length,
      rdBotId: this.getCachedRdBotId(),
      lastRun: recentRuns[0] ?? null,
      recentRuns,
    };
  }

  private persistRunReport(report: TriageRunReport): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO opc_triage_runs (
          id, kind, dry_run, started_at, completed_at,
          scanned_count, noise_archived_count, idea_demoted_count, superseded_count,
          verified_count, needs_scope_count, code_checked_count, dispatched_count, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.kind,
        report.dryRun ? 1 : 0,
        report.startedAt,
        report.completedAt,
        report.scannedCount,
        report.noiseArchivedCount,
        report.ideaDemotedCount,
        report.supersededCount,
        report.verifiedCount,
        report.needsScopeCount,
        report.codeCheckedCount,
        report.dispatchedCount,
        JSON.stringify(report),
      );
  }

  // ---- Internal Helpers ----

  private resolveTargetRepoPath(task: PlanningTask, suggestedProject?: string | null): string | null {
    const refs = [suggestedProject, task.assetId, task.project].filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );
    for (const ref of refs) {
      if (this.registry) {
        const resolved = this.registry.resolveCanonicalRef(ref);
        const localPath = resolved.asset?.localRepoPath?.trim();
        if (localPath) return localPath;
      }
      if (this.resolveRepoPathHook) {
        const hooked = this.resolveRepoPathHook(ref);
        if (hooked && hooked.trim()) return hooked.trim();
      }
      if (this.darkFactory?.hooks.resolveRepoPath) {
        const dfPath = this.darkFactory.hooks.resolveRepoPath(ref);
        if (dfPath && dfPath.trim()) return dfPath.trim();
      }
    }
    return null;
  }

  private upsertDemotedIdea(task: PlanningTask, reason: string): string {
    const title = cleanIdeaTitle(task.title);
    const reference = (task.sourceRef || `planning://${task.id}`).slice(0, 1500);

    const existing = this.db
      .prepare(
        `SELECT id FROM company_notes
         WHERE kind = 'idea' AND (LOWER(TRIM(title)) = LOWER(TRIM(?)) OR (reference != '' AND reference = ?))
         LIMIT 1`,
      )
      .get(title, reference) as { id?: string } | undefined;

    if (existing?.id) {
      return String(existing.id);
    }

    const ideaId = randomUUID();
    const bodyParts = [
      task.description.trim(),
      `---\n由产研分诊漏斗从任务规划（${task.id} · project=${task.project}）降级沉淀为公司想法：${reason}`,
    ].filter(Boolean);
    const body = bodyParts.join("\n\n").slice(0, 5000);

    this.db
      .prepare("INSERT INTO company_notes (id, kind, title, body, reference) VALUES (?, 'idea', ?, ?, ?)")
      .run(ideaId, title, body, reference);

    return ideaId;
  }

  private writeTaskTriage(
    task: PlanningTask,
    triagePatch: TaskTriageMeta,
    taskUpdate: {
      status?: PlanningTaskStatus;
      project?: string;
      assetId?: string | null;
      mainlineId?: string | null;
      verifyCommand?: string;
    } = {},
  ): PlanningTaskWithSubtasks {
    const nextMetadata: Record<string, unknown> = {
      ...task.metadata,
      triage: {
        ...extractTaskTriage(task.metadata),
        ...triagePatch,
      },
    };
    return this.taskPlanning.updateTask(task.id, {
      ...taskUpdate,
      metadata: nextMetadata,
    });
  }

  // ---- Default External Runners (Agent Home Bot + Read-only agy) ----

  private async defaultBotRunner(input: TriageBotRunInput): Promise<TriageBotRunResult> {
    const safePrompt =
      input.prompt.length <= MAX_BOT_TRIAGE_PROMPT_CHARS
        ? input.prompt
        : buildBotTriagePrompt({
            mainlines: [],
            assets: [],
            tasks: input.tasks,
            maxChars: MAX_BOT_TRIAGE_PROMPT_CHARS,
          });

    const dispatched = await this.stageHomeClient.send(
      input.botId,
      safePrompt,
      `opc-triage-${input.batchId}`,
    );

    const deadline = Date.now() + this.botPollTimeoutMs;
    let current = dispatched;

    while (!TERMINAL_BOT_TASK_STATUSES.has(current.status) && Date.now() < deadline) {
      await delay(this.botPollIntervalMs);
      current = await this.stageHomeClient.read(current.id);
    }

    if (!TERMINAL_BOT_TASK_STATUSES.has(current.status)) {
      throw new Error(`产研 Bot 审查任务超时未完成（taskId=${current.id}, status=${current.status}）`);
    }
    if (current.status !== "completed") {
      throw new Error(
        `产研 Bot 审查任务未成功（taskId=${current.id}, status=${current.status}）：${current.failureReason || "未知错误"}`,
      );
    }

    const rawOutput = (current.delivery?.report || current.result || "").trim();
    if (!rawOutput) {
      throw new Error(`产研 Bot 返回空回执（taskId=${current.id}）`);
    }

    const verdicts = parseTriageVerdictsFromText(rawOutput);
    return {
      verdicts,
      botId: input.botId,
      botTaskId: current.id,
      rawOutput,
    };
  }

  private async defaultAgyCodeCheckRunner(input: AgyCodeCheckInput): Promise<AgyCodeCheckResult> {
    const prompt = buildAgyCodeCheckPrompt(input.task, input.repoPath, input.reason);
    try {
      const { stdout } = await execFileAsync(
        this.agyBinary,
        ["--mode", "plan", "--disable-slash-commands", "--print", prompt],
        {
          cwd: input.repoPath,
          timeout: this.codeCheckTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            HFLOW_WORKER: "1",
          },
        },
      );
      return parseCodeCheckFromText(stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verdict: "needs_scope",
        confidence: 0.5,
        reason: `agy 只读代码复核执行失败/超时：${msg.slice(0, 200)}`,
        evidence: null,
      };
    }
  }

  // ---- Layer 0: Deterministic Noise & Repo-Binding Sweep ----

  runDeterministicSweep(options: SweepOptions = {}): TriageRunReport {
    const dryRun = options.dryRun === true;
    const startedAt = this.nowIso();
    const runId = `trg_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    // Strictly scan only status = 'todo' (never touch done / published / archived / in_progress / etc.)
    const todoTasks = this.taskPlanning.listTasks({ status: "todo", includeSubtasks: true });

    const items: TriageRunItemResult[] = [];
    let noiseArchivedCount = 0;
    let needsScopeCount = 0;

    for (const task of todoTasks) {
      const prevStatus = getTaskTriageStatus(task);
      const noise = isDigestOrNonActionableNoise(task.title, task.description);

      if (noise.noisy) {
        const reason = noise.reason ?? "命中 Layer 0 日报噪音/非研发动作规则";
        if (!dryRun) {
          this.writeTaskTriage(
            task,
            {
              status: "noise_archived",
              verdict: "noise_archive",
              confidence: 0.98,
              reason,
              reviewer: "layer0-deterministic",
              reviewedAt: this.nowIso(),
            },
            { status: "archived" },
          );
        }
        noiseArchivedCount += 1;
        items.push({
          taskId: task.id,
          title: task.title,
          previousStatus: prevStatus,
          nextStatus: "noise_archived",
          taskStatusAfter: dryRun ? task.status : "archived",
          verdict: "noise_archive",
          confidence: 0.98,
          reason,
          applied: !dryRun,
        });
        continue;
      }

      // Check signal:// tasks bound to paused or missing repos
      if (task.sourceRef?.startsWith("signal://") && prevStatus === "unreviewed") {
        let scopeBlockReason: string | null = null;
        if (this.registry) {
          const ref = task.assetId || task.project;
          const resolved = this.registry.resolveCanonicalRef(ref);
          if (resolved.asset?.paused) {
            scopeBlockReason = `信号任务关联的代码资产「${resolved.asset.name}」当前已暂停 (paused)，暂不进入自动派工`;
          } else if (
            resolved.asset &&
            resolved.asset.localRepoPath &&
            !existsSync(resolved.asset.localRepoPath)
          ) {
            scopeBlockReason = `信号任务关联资产「${resolved.asset.name}」的本地仓库路径不存在（${resolved.asset.localRepoPath}），需先补齐有效仓库`;
          } else if (!resolved.asset && (!resolved.product || task.project === "default")) {
            scopeBlockReason = `信号来源任务未绑定已注册的有效代码仓库（project=${task.project}），需人工明确范围与目标仓库`;
          }
        } else if (task.project === "default") {
          scopeBlockReason = "信号来源任务 project=default 未绑定有效代码仓库，需人工补充目标范围";
        }

        if (scopeBlockReason) {
          if (!dryRun) {
            this.writeTaskTriage(task, {
              status: "needs_scope",
              verdict: "needs_scope",
              confidence: 0.9,
              reason: scopeBlockReason,
              reviewer: "layer0-repo-guard",
              reviewedAt: this.nowIso(),
            });
          }
          needsScopeCount += 1;
          items.push({
            taskId: task.id,
            title: task.title,
            previousStatus: prevStatus,
            nextStatus: "needs_scope",
            taskStatusAfter: task.status,
            verdict: "needs_scope",
            confidence: 0.9,
            reason: scopeBlockReason,
            applied: !dryRun,
          });
        }
      }
    }

    const report: TriageRunReport = {
      id: runId,
      kind: "sweep",
      dryRun,
      startedAt,
      completedAt: this.nowIso(),
      scannedCount: todoTasks.length,
      noiseArchivedCount,
      ideaDemotedCount: 0,
      supersededCount: 0,
      verifiedCount: 0,
      needsScopeCount,
      codeCheckedCount: 0,
      dispatchedCount: 0,
      dispatchedTaskIds: [],
      dispatchedRunIds: [],
      items,
      funnel: this.getFunnelCounts(),
    };

    if (!dryRun) {
      this.persistRunReport(report);
    }
    return report;
  }

  // ---- Layer 1 + 1.5: R&D VP Bot Triage Batch + Optional Read-Only agy Code Check ----

  async runBotTriageBatch(options: BotTriageBatchOptions = {}): Promise<TriageRunReport> {
    const config = this.getConfig();
    const dryRun = options.dryRun === true;
    const batchSize = Math.max(1, Math.min(50, Math.floor(options.batchSize ?? config.batchSize)));
    const useAgyCodeCheck = options.useAgyCodeCheck ?? config.useAgyCodeCheck;
    const startedAt = this.nowIso();
    const runId = `trg_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const excluded = new Set<string>(options.excludeTaskIds ?? []);
    const unreviewedTodos = this.taskPlanning
      .listTasks({ status: "todo", includeSubtasks: true })
      .filter((t) => !excluded.has(t.id) && getTaskTriageStatus(t) === "unreviewed")
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
      .slice(0, batchSize);

    if (unreviewedTodos.length === 0) {
      const emptyReport: TriageRunReport = {
        id: runId,
        kind: "bot_batch",
        dryRun,
        startedAt,
        completedAt: this.nowIso(),
        scannedCount: 0,
        noiseArchivedCount: 0,
        ideaDemotedCount: 0,
        supersededCount: 0,
        verifiedCount: 0,
        needsScopeCount: 0,
        codeCheckedCount: 0,
        dispatchedCount: 0,
        dispatchedTaskIds: [],
        dispatchedRunIds: [],
        items: [],
        funnel: this.getFunnelCounts(),
      };
      if (!dryRun) this.persistRunReport(emptyReport);
      return emptyReport;
    }

    const mainlines = this.registry
      ? this.registry.listMainlines().map((m) => ({
          slug: m.slug,
          name: m.name,
          status: m.status,
          priorityWeight: m.priorityWeight,
          freezeNonMainline: m.freezeNonMainline,
        }))
      : [];
    const assets = this.registry
      ? this.registry.listAssets().map((a) => ({
          slug: a.slug,
          name: a.name,
          localRepoPath: a.localRepoPath,
          verifyCommand: a.verifyCommand,
          paused: a.paused,
        }))
      : [];

    const promptBatches = splitTasksIntoPromptBatches({
      mainlines,
      assets,
      tasks: unreviewedTodos,
      maxChars: MAX_BOT_TRIAGE_PROMPT_CHARS,
    });
    const resolvedBotId = (await this.resolveRdBotId()) ?? "rd-vp-bot";

    if (!dryRun) {
      for (const task of unreviewedTodos) {
        this.writeTaskTriage(task, {
          status: "triaging",
          reviewer: resolvedBotId,
          reviewedAt: startedAt,
        });
      }
    }

    const verdicts: TriageVerdict[] = [];
    const botTaskIds: string[] = [];
    let usedBotId: string | null = resolvedBotId;
    let fallbackUsed = false;
    let errorMessage: string | null = null;
    const verdictReviewerByTaskId = new Map<string, string>();
    const verdictBotTaskIdByTaskId = new Map<string, string | null>();

    for (let idx = 0; idx < promptBatches.length; idx++) {
      const sub = promptBatches[idx];
      const subBatchId = promptBatches.length === 1 ? runId : `${runId}_b${idx + 1}`;
      if (fallbackUsed) {
        for (const t of sub.tasks) {
          const fb = fallbackHeuristicTriage(t);
          if (fb) {
            verdicts.push(fb);
            verdictReviewerByTaskId.set(fb.taskId, "layer1-fallback-heuristic");
            verdictBotTaskIdByTaskId.set(fb.taskId, null);
          }
        }
        continue;
      }

      try {
        const botResult = await this.botRunner({
          botId: resolvedBotId,
          prompt: sub.prompt,
          tasks: sub.tasks,
          batchId: subBatchId,
        });
        usedBotId = botResult.botId ?? resolvedBotId;
        if (botResult.botTaskId) botTaskIds.push(botResult.botTaskId);
        for (const v of botResult.verdicts) {
          verdicts.push(v);
          verdictReviewerByTaskId.set(v.taskId, usedBotId || "rd-vp-bot");
          verdictBotTaskIdByTaskId.set(v.taskId, botResult.botTaskId ?? null);
        }
      } catch (err) {
        fallbackUsed = true;
        errorMessage = err instanceof Error ? err.message : String(err);
        for (const t of sub.tasks) {
          const fb = fallbackHeuristicTriage(t);
          if (fb) {
            verdicts.push(fb);
            verdictReviewerByTaskId.set(fb.taskId, "layer1-fallback-heuristic");
            verdictBotTaskIdByTaskId.set(fb.taskId, null);
          }
        }
      }
    }

    const botTaskId = botTaskIds.length > 0 ? botTaskIds.join(",") : null;
    const verdictByTaskId = new Map<string, TriageVerdict>(verdicts.map((v) => [v.taskId, v]));
    const items: TriageRunItemResult[] = [];

    let noiseArchivedCount = 0;
    let ideaDemotedCount = 0;
    let supersededCount = 0;
    let verifiedCount = 0;
    let needsScopeCount = 0;
    let codeCheckedCount = 0;

    for (const originalTask of unreviewedTodos) {
      const currentTask = dryRun ? originalTask : this.taskPlanning.getTask(originalTask.id);
      const verdict = verdictByTaskId.get(originalTask.id);

      if (!verdict) {
        // Revert triaging -> unreviewed if Bot omitted this task or fallback left it undecided
        if (!dryRun && getTaskTriageStatus(currentTask) === "triaging") {
          this.writeTaskTriage(currentTask, {
            status: "unreviewed",
            reviewer: null,
            reviewedAt: null,
          });
        }
        continue;
      }

      const appliedItem = await this.applyVerdictToTask(currentTask, verdict, {
        dryRun,
        config,
        useAgyCodeCheck,
        reviewer:
          verdictReviewerByTaskId.get(originalTask.id) ??
          (fallbackUsed ? "layer1-fallback-heuristic" : usedBotId || "rd-vp-bot"),
        botTaskId: verdictBotTaskIdByTaskId.get(originalTask.id) ?? botTaskId,
      });

      items.push(appliedItem.item);
      if (appliedItem.codeChecked) codeCheckedCount += 1;

      if (appliedItem.item.nextStatus === "noise_archived") noiseArchivedCount += 1;
      else if (appliedItem.item.nextStatus === "idea_demoted") ideaDemotedCount += 1;
      else if (appliedItem.item.nextStatus === "superseded") supersededCount += 1;
      else if (appliedItem.item.nextStatus === "verified") verifiedCount += 1;
      else if (appliedItem.item.nextStatus === "needs_scope") needsScopeCount += 1;
    }

    const report: TriageRunReport = {
      id: runId,
      kind: "bot_batch",
      dryRun,
      startedAt,
      completedAt: this.nowIso(),
      scannedCount: unreviewedTodos.length,
      noiseArchivedCount,
      ideaDemotedCount,
      supersededCount,
      verifiedCount,
      needsScopeCount,
      codeCheckedCount,
      dispatchedCount: 0,
      dispatchedTaskIds: [],
      dispatchedRunIds: [],
      botId: usedBotId,
      botTaskId,
      fallbackUsed,
      error: errorMessage,
      items,
      funnel: this.getFunnelCounts(),
    };

    if (!dryRun) {
      this.persistRunReport(report);
    }
    return report;
  }

  private async applyVerdictToTask(
    task: PlanningTask,
    verdict: TriageVerdict,
    ctx: {
      dryRun: boolean;
      config: TriageConfig;
      useAgyCodeCheck: boolean;
      reviewer: string;
      botTaskId: string | null;
    },
  ): Promise<{ item: TriageRunItemResult; codeChecked: boolean }> {
    const prevStatus = getTaskTriageStatus(task) === "triaging" ? "unreviewed" : getTaskTriageStatus(task);
    const now = this.nowIso();

    let effectiveVerdict: TriageVerdictAction = verdict.verdict;
    let effectiveConfidence = verdict.confidence;
    let effectiveReason = verdict.reason;
    let effectiveEvidence = verdict.evidence ?? null;
    let codeChecked = false;
    let codeCheckVerdict: TaskTriageMeta["codeCheckVerdict"] = null;

    // Layer 1.5: Optional lightweight read-only agy code check
    if (effectiveVerdict === "needs_code_check") {
      const repoPath = this.resolveTargetRepoPath(task, verdict.suggestedProject);
      if (ctx.useAgyCodeCheck && repoPath && existsSync(repoPath)) {
        const checkRes = await this.codeCheckRunner({
          task,
          repoPath,
          reason: verdict.reason,
        });
        codeChecked = true;
        effectiveVerdict = checkRes.verdict;
        effectiveConfidence = checkRes.confidence;
        effectiveReason = checkRes.reason;
        effectiveEvidence = checkRes.evidence ?? effectiveEvidence;
        codeCheckVerdict =
          checkRes.verdict === "real_ready"
            ? "still_exists"
            : checkRes.verdict === "already_done"
              ? "already_done"
              : checkRes.verdict === "noise_archive"
                ? "noise"
                : "inconclusive";
      } else {
        effectiveVerdict = "needs_scope";
        effectiveReason = !ctx.useAgyCodeCheck
          ? `${verdict.reason}（已关闭 agy 只读代码复核，转待补范围）`
          : `${verdict.reason}（本地仓库路径不存在，跳过 agy 只读复核，转待补范围）`;
      }
    }

    let nextTriageStatus: TriageStatus = "needs_scope";
    let nextTaskStatus: PlanningTaskStatus = task.status;
    let demotedIdeaId: string | null = null;
    const taskPatch: {
      status?: PlanningTaskStatus;
      project?: string;
      assetId?: string | null;
      mainlineId?: string | null;
      verifyCommand?: string;
    } = {};

    if (effectiveVerdict === "noise_archive") {
      if (effectiveConfidence >= ctx.config.noiseConfidenceThreshold) {
        nextTriageStatus = "noise_archived";
        nextTaskStatus = "archived";
        taskPatch.status = "archived";
      } else {
        nextTriageStatus = "needs_scope";
        effectiveReason = `${effectiveReason}（置信度 ${effectiveConfidence} < ${ctx.config.noiseConfidenceThreshold}，暂不自动归档）`;
      }
    } else if (effectiveVerdict === "idea_demote") {
      if (effectiveConfidence >= ctx.config.ideaConfidenceThreshold) {
        nextTriageStatus = "idea_demoted";
        nextTaskStatus = "archived";
        taskPatch.status = "archived";
        if (!ctx.dryRun) {
          demotedIdeaId = this.upsertDemotedIdea(task, effectiveReason);
        }
      } else {
        nextTriageStatus = "needs_scope";
        effectiveReason = `${effectiveReason}（置信度 ${effectiveConfidence} < ${ctx.config.ideaConfidenceThreshold}，暂不自动降级）`;
      }
    } else if (effectiveVerdict === "already_done") {
      nextTriageStatus = "superseded";
      nextTaskStatus = "archived";
      taskPatch.status = "archived";
    } else if (effectiveVerdict === "real_ready") {
      nextTriageStatus = "verified";
      nextTaskStatus = task.status;

      if (verdict.suggestedProject && this.registry) {
        const resolved = this.registry.resolveCanonicalRef(verdict.suggestedProject);
        if (resolved.asset && !resolved.asset.paused) {
          taskPatch.project = resolved.asset.slug;
          taskPatch.assetId = resolved.asset.id;
          taskPatch.mainlineId = resolved.asset.mainlineId ?? resolved.mainline?.id ?? task.mainlineId;
          if (!task.verifyCommand && resolved.asset.verifyCommand) {
            taskPatch.verifyCommand = resolved.asset.verifyCommand;
          }
        } else if (resolved.product) {
          taskPatch.project = resolved.product.slug;
          taskPatch.mainlineId = resolved.mainline?.id ?? task.mainlineId;
        }
      }
    } else {
      nextTriageStatus = "needs_scope";
    }

    if (!ctx.dryRun) {
      this.writeTaskTriage(
        task,
        {
          status: nextTriageStatus,
          verdict: effectiveVerdict,
          confidence: effectiveConfidence,
          reason: effectiveReason,
          evidence: effectiveEvidence,
          reviewer: codeChecked ? `${ctx.reviewer}+agy-plan` : ctx.reviewer,
          reviewedAt: now,
          botTaskId: ctx.botTaskId,
          demotedIdeaId,
          codeCheckRan: codeChecked,
          codeCheckVerdict,
        },
        taskPatch,
      );
    }

    return {
      codeChecked,
      item: {
        taskId: task.id,
        title: task.title,
        previousStatus: prevStatus,
        nextStatus: nextTriageStatus,
        taskStatusAfter: ctx.dryRun ? task.status : nextTaskStatus,
        verdict: effectiveVerdict,
        confidence: effectiveConfidence,
        reason: effectiveReason,
        evidence: effectiveEvidence,
        demotedIdeaId,
        applied: !ctx.dryRun,
      },
    };
  }

  // ---- Layer 2: Rolling Cycle (Sweep -> Bot Batch -> Optional Verified Auto-Roll Dispatch) ----

  async runRollingCycle(options: RollingCycleOptions = {}): Promise<TriageRunReport> {
    if (this.inFlight) {
      throw new ApiError(409, "triage_in_progress", "已有审查轮动任务正在执行中，请稍候");
    }
    this.inFlight = true;
    const startedAt = this.nowIso();
    const runId = `trg_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const dryRun = options.dryRun === true;

    try {
      const config = this.getConfig();

      // 1. Layer 0 Deterministic Sweep
      const sweepReport = this.runDeterministicSweep({ dryRun });

      // 2. Layer 1 + 1.5 Bot Triage Batch (if unreviewed remain)
      let batchReport: TriageRunReport | null = null;
      const sweptIds = dryRun ? sweepReport.items.map((i) => i.taskId) : [];
      const funnelAfterSweep = this.getFunnelCounts();
      if (funnelAfterSweep.unreviewed > 0) {
        batchReport = await this.runBotTriageBatch({
          batchSize: options.batchSize ?? config.batchSize,
          dryRun,
          useAgyCodeCheck: options.useAgyCodeCheck ?? config.useAgyCodeCheck,
          ...(sweptIds.length > 0 ? { excludeTaskIds: sweptIds } : {}),
        });
      }

      // 3. Layer 2 Auto-Roll Dispatch (strictly verified leaf tasks within concurrency cap)
      const dispatchedTaskIds: string[] = [];
      const dispatchedRunIds: string[] = [];
      const shouldRoll = !dryRun && !options.skipRoll && (config.autoRollEnabled || options.forceRoll === true);

      if (shouldRoll && config.maxAutoDispatchPerCycle > 0) {
        const maxConcurrent = Math.max(
          1,
          Number(
            this.darkFactory?.getOverview().maxConcurrentAgents ??
              this.providers?.get().system.maxConcurrentAgents ??
              3,
          ) || 3,
        );
        const activeRuns = this.darkFactory
          ? this.darkFactory
              .listRuns({ limit: 200 })
              .filter((r) => r.status === "running" || r.status === "queued")
          : [];
        const activeTaskIds = new Set(activeRuns.map((r) => r.taskId));
        const availableSlots = Math.max(0, maxConcurrent - activeRuns.length);
        const budget = Math.min(config.maxAutoDispatchPerCycle, availableSlots);

        if (budget > 0) {
          const verifiedReady = this.taskPlanning
            .listReadyForAutoDispatch(30)
            .filter((t) => !activeTaskIds.has(t.id));

          for (const task of verifiedReady) {
            if (dispatchedTaskIds.length >= budget) break;
            try {
              if (this.resources) {
                const res = this.resources.dispatchSmart({
                  taskId: task.id,
                  isEmergencyBug: task.type === "bug" && task.priority >= 9,
                });
                dispatchedTaskIds.push(task.id);
                dispatchedRunIds.push(res.run.id);
                activeTaskIds.add(task.id);
              } else if (this.darkFactory) {
                const candidateAgent = this.darkFactory
                  .listAgents()
                  .find((a) => a.status !== "disabled" && !this.darkFactory!.isAgentCooledDown(a.id));
                if (!candidateAgent) break;
                const disp = await this.taskPlanning.dispatchTask(task.id, {
                  agentId: candidateAgent.id,
                });
                dispatchedTaskIds.push(task.id);
                dispatchedRunIds.push(disp.runId);
                activeTaskIds.add(task.id);
              }
            } catch {
              // Skip candidate blocked by admission/cooldown/conflict and try next verified task
              continue;
            }
          }
        }
      }

      const items = [...sweepReport.items, ...(batchReport?.items ?? [])];
      const report: TriageRunReport = {
        id: runId,
        kind: "rolling_cycle",
        dryRun,
        startedAt,
        completedAt: this.nowIso(),
        scannedCount: sweepReport.scannedCount + (batchReport?.scannedCount ?? 0),
        noiseArchivedCount: sweepReport.noiseArchivedCount + (batchReport?.noiseArchivedCount ?? 0),
        ideaDemotedCount: batchReport?.ideaDemotedCount ?? 0,
        supersededCount: batchReport?.supersededCount ?? 0,
        verifiedCount: batchReport?.verifiedCount ?? 0,
        needsScopeCount: sweepReport.needsScopeCount + (batchReport?.needsScopeCount ?? 0),
        codeCheckedCount: batchReport?.codeCheckedCount ?? 0,
        dispatchedCount: dispatchedTaskIds.length,
        dispatchedTaskIds,
        dispatchedRunIds,
        botId: batchReport?.botId ?? null,
        botTaskId: batchReport?.botTaskId ?? null,
        fallbackUsed: batchReport?.fallbackUsed ?? false,
        error: batchReport?.error ?? null,
        items,
        funnel: this.getFunnelCounts(),
      };

      if (!dryRun) {
        this.persistRunReport(report);
      }
      return report;
    } finally {
      this.inFlight = false;
    }
  }

  // ---- Manual Per-Task Triage Override / Single-Task Code Check ----

  async triageSingleTask(
    taskId: string,
    rawInput: ManualTriageTaskInput | unknown,
  ): Promise<ManualTriageTaskResult> {
    const parsed = manualTaskTriageSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new ApiError(400, "triage_task_input", formatZodIssues(parsed.error));
    }
    const input = parsed.data;
    const task = this.taskPlanning.getTask(taskId);
    const prevStatus = getTaskTriageStatus(task);
    const reviewer = input.reviewer || "founder-manual";
    const now = this.nowIso();

    let action: ManualTriageAction | undefined = input.action;
    if (!action && input.status) {
      if (input.status === "verified") action = "verify";
      else if (input.status === "needs_scope") action = "needs_scope";
      else if (input.status === "idea_demoted") action = "idea_demote";
      else if (input.status === "noise_archived") action = "noise_archive";
      else if (input.status === "superseded") action = "superseded";
      else if (input.status === "unreviewed") action = "reset_unreviewed";
    }
    if (!action) {
      throw new ApiError(400, "triage_task_input", "请提供 action 或 status 参数");
    }

    if (action === "code_check") {
      const repoPath = this.resolveTargetRepoPath(task, input.project);
      if (!repoPath || !existsSync(repoPath)) {
        throw new ApiError(
          400,
          "missing_repo_path",
          `无法定位任务 ${task.id} 对应的本地仓库路径，无法执行只读代码复核`,
        );
      }
      const config = this.getConfig();
      const { item } = await this.applyVerdictToTask(
        task,
        {
          taskId: task.id,
          verdict: "needs_code_check",
          confidence: 0.9,
          reason: input.reason || "手动触发 agy 只读代码复核",
          suggestedProject: input.project ?? null,
          suggestedVerifyCommand: input.verifyCommand ?? null,
        },
        {
          dryRun: false,
          config,
          useAgyCodeCheck: true,
          reviewer,
          botTaskId: null,
        },
      );
      const updated = this.taskPlanning.getTask(task.id);
      return {
        task: updated,
        item,
        funnel: this.getFunnelCounts(),
        demotedIdeaId: item.demotedIdeaId ?? null,
      };
    }

    let nextTriageStatus: TriageStatus = "verified";
    let verdictAction: TriageVerdictAction = "real_ready";
    let nextTaskStatus: PlanningTaskStatus = task.status;
    let demotedIdeaId: string | null = null;
    const reason =
      input.reason ||
      (action === "verify"
        ? "人工验真放行"
        : action === "idea_demote"
          ? "人工降级沉淀至想法库"
          : action === "noise_archive"
            ? "人工标记为噪音归档"
            : action === "superseded"
              ? "人工标记为已完成/已过时"
              : action === "reset_unreviewed"
                ? "重置为待审查"
                : "人工标记为需补充范围");

    if (action === "verify") {
      nextTriageStatus = "verified";
      verdictAction = "real_ready";
      if (task.status === "archived") nextTaskStatus = "todo";
    } else if (action === "needs_scope") {
      nextTriageStatus = "needs_scope";
      verdictAction = "needs_scope";
      if (task.status === "archived") nextTaskStatus = "todo";
    } else if (action === "idea_demote") {
      nextTriageStatus = "idea_demoted";
      verdictAction = "idea_demote";
      nextTaskStatus = "archived";
      demotedIdeaId = this.upsertDemotedIdea(task, reason);
    } else if (action === "noise_archive") {
      nextTriageStatus = "noise_archived";
      verdictAction = "noise_archive";
      nextTaskStatus = "archived";
    } else if (action === "superseded") {
      nextTriageStatus = "superseded";
      verdictAction = "already_done";
      nextTaskStatus = "archived";
    } else if (action === "reset_unreviewed") {
      nextTriageStatus = "unreviewed";
      verdictAction = "needs_scope";
      if (task.status === "archived") nextTaskStatus = "todo";
    }

    const updated = this.writeTaskTriage(
      task,
      {
        status: nextTriageStatus,
        verdict: action === "reset_unreviewed" ? null : verdictAction,
        confidence: action === "reset_unreviewed" ? null : 1,
        reason: action === "reset_unreviewed" ? null : reason,
        evidence: input.evidence ?? null,
        reviewer: action === "reset_unreviewed" ? null : reviewer,
        reviewedAt: action === "reset_unreviewed" ? null : now,
        demotedIdeaId,
      },
      {
        status: nextTaskStatus,
        ...(input.project ? { project: input.project } : {}),
        ...(input.verifyCommand !== undefined ? { verifyCommand: input.verifyCommand } : {}),
      },
    );

    const item: TriageRunItemResult = {
      taskId: updated.id,
      title: updated.title,
      previousStatus: prevStatus,
      nextStatus: nextTriageStatus,
      taskStatusAfter: updated.status,
      verdict: verdictAction,
      confidence: 1,
      reason,
      evidence: input.evidence ?? null,
      demotedIdeaId,
      applied: true,
    };

    const funnel = this.getFunnelCounts();
    return {
      task: updated,
      item,
      funnel,
      demotedIdeaId,
    };
  }
}

export function registerTaskTriageRoutes(
  app: Hono,
  db: DatabaseSync,
  deps: RegisterTaskTriageDeps,
): TaskTriageService {
  const service = deps.service ?? new TaskTriageService(db, deps);
  const { permits } = submitAuth(deps.submitToken);
  const authUser = deps.user ?? deps.requireUser;
  const base = "/api/opc/planning/triage" as const;

  const guard = async (c: Context, next: () => Promise<void>) => {
    if (!permits(c) && authUser) authUser(c);
    c.header("Cache-Control", "no-store");
    await next();
  };

  app.use(base, guard);
  app.use(`${base}/*`, guard);

  app.get(`${base}/status`, (c) => c.json(service.getStatus()));

  app.patch(`${base}/config`, async (c) => {
    const body = await readOptionalJsonBody(c);
    const config = service.updateConfig(body);
    return c.json({ config });
  });

  app.post(`${base}/sweep`, async (c) => {
    const body = await readOptionalJsonBody(c);
    const parsed = sweepBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "triage_sweep_input", formatZodIssues(parsed.error));
    }
    return c.json(service.runDeterministicSweep({ dryRun: parsed.data.dryRun }));
  });

  app.post(`${base}/run-once`, async (c) => {
    const body = await readOptionalJsonBody(c);
    const parsed = runOnceBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "triage_run_input", formatZodIssues(parsed.error));
    }
    return c.json(
      await service.runRollingCycle({
        dryRun: parsed.data.dryRun,
        batchSize: parsed.data.batchSize,
        useAgyCodeCheck: parsed.data.useAgyCodeCheck,
        forceRoll: parsed.data.forceRoll,
        skipRoll: parsed.data.skipRoll,
      }),
    );
  });

  app.post(`${base}/tasks/:id`, async (c) => {
    const body = await readOptionalJsonBody(c);
    return c.json(await service.triageSingleTask(c.req.param("id"), body));
  });

  return service;
}
