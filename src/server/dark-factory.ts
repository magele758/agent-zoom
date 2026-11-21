import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  AGENT_PRESETS,
  type AgentRecord,
  type AgentRegistryStatus,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentType,
  type AuditStatus,
  type CircuitBreakerReason,
  type CleanupWorktreesResult,
  type DarkFactoryOverview,
  type DispatchRunInput,
  type FactoryAuditDetails,
  type FactoryAuditRecord,
  type FactoryDayMetric,
  type FactoryMetrics,
  type FactoryProjectMonthMetric,
  type FactoryWorktreeEntry,
  type LogStreamKind,
  type RunLogEntry,
  type RunLogsResponse,
  type RunStreamEvent,
} from "../dark-factory-types.ts";
import { ApiError } from "./logic.ts";
import type { ProvidersStore } from "./providers.ts";
import { submitAuth } from "./workflow/http.ts";

export { AGENT_PRESETS };

const execFileAsync = promisify(execFile);

export const DEFAULT_COST_PER_MILLION_TOKENS = 5.0;

export const SENSITIVE_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "WORKFLOW_SUBMIT_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY",
  "LEMON_API_KEY",
  "HUPI_APP_SECRET",
  "OPC_LLM_API_KEY",
  "OPC_EMBEDDING_API_KEY",
  "OPC_WORKFLOW_API_KEY",
  "OPC_DISTRIBUTION_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;

const TERMINAL_RUN_STATUSES = new Set<AgentRunStatus>([
  "pr_open",
  "completed",
  "no_output",
  "failed",
  "cancelled",
]);

const DEAD_LOOP_STDERR_RE = /(?:error|exception|traceback)/i;
const SANDBOX_RC_NAME = ".sandboxrc";

export interface DarkFactoryHooks {
  onRunStatusChanged?: (run: AgentRunRecord) => void;
  resolveRepoPath?: (project: string) => string | null;
}

export interface DarkFactoryOptions {
  hooks?: DarkFactoryHooks;
  worktreeBase?: string;
  defaultRepoRoot?: string;
  defaultCostPerMillionTokens?: number;
  durationUnitMs?: number;
}

export interface RegisterDarkFactoryOptions extends DarkFactoryOptions {
  submitToken?: string;
  store?: DarkFactoryStore;
}

const agentTypeSchema = z.enum(["cli", "api", "mcp"]);
const agentStatusSchema = z.enum(["idle", "running", "error", "disabled"]);

const createAgentSchema = z.object({
  name: z.string().trim().min(1, "Agent 名称不能为空").max(80),
  description: z.string().trim().max(500).default(""),
  type: agentTypeSchema.default("cli"),
  cliCommand: z.string().trim().min(1, "CLI 命令不能为空").max(2000),
  promptTemplate: z.string().max(8000).default(""),
  maxCostPerTask: z.number().finite().positive().max(10000).default(5.0),
  maxDurationSecs: z.number().finite().min(0.05).max(86400).default(1800),
  maxRetries: z.number().int().min(1).max(100).default(3),
  status: agentStatusSchema.default("idle"),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
});

const updateAgentSchema = createAgentSchema.partial();

const dispatchSchema = z.object({
  taskId: z.string().trim().min(1, "taskId 不能为空").max(120),
  taskTitle: z.string().trim().min(1, "taskTitle 不能为空").max(240),
  taskDescription: z.string().max(12000).default(""),
  project: z.string().trim().max(120).default(""),
  repoPath: z.string().trim().max(500).optional(),
  agentId: z.string().trim().min(1, "agentId 不能为空").max(120),
  autoCreatePr: z.boolean().default(false),
});

const cleanupWorktreesSchema = z
  .object({
    runId: z.string().trim().min(1).max(120).optional(),
  })
  .optional();

const bootstrapAuditSchema = z
  .object({
    repoRoot: z.string().trim().min(1).max(500).optional(),
  })
  .optional();

const createPrSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(16000).optional(),
    baseBranch: z.string().trim().min(1).max(120).optional(),
  })
  .optional();

function nowIso(): string {
  return new Date().toISOString();
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return slug || "agent";
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeRelPath(input: string): string {
  return input
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function isPathWithin(baseDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(baseDir), resolve(candidatePath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Splits a CLI command string into argv tokens without invoking a shell.
 * Supports single quotes, double quotes (unescaping \" and \\), and backslash escapes.
 */
export function splitCommandArgs(command: string): string[] {
  const input = command.trim();
  if (!input) {
    throw new ApiError(400, "invalid_command", "CLI 命令不能为空");
  }

  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === "\\") {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      current += input[i + 1];
      hasToken = true;
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    throw new ApiError(400, "invalid_command", "CLI 命令存在未闭合的引号");
  }

  if (hasToken) {
    args.push(current);
  }

  if (args.length === 0) {
    throw new ApiError(400, "invalid_command", "CLI 命令解析结果为空");
  }

  return args;
}

export function renderPromptTemplate(
  template: string,
  vars: {
    taskId: string;
    taskTitle: string;
    taskDescription: string;
    worktreePath: string;
    branchName: string;
  },
): string {
  return template
    .replaceAll("{{task.id}}", vars.taskId)
    .replaceAll("{{task.title}}", vars.taskTitle)
    .replaceAll("{{task.description}}", vars.taskDescription)
    .replaceAll("{{worktree_path}}", vars.worktreePath)
    .replaceAll("{{branch_name}}", vars.branchName);
}

function isInlineScriptCommand(binary: string, args: string[]): boolean {
  const base = binary.split(/[\\/]/).pop()?.toLowerCase() ?? binary.toLowerCase();
  if (["sh", "bash", "zsh", "dash"].includes(base) && args.includes("-c")) return true;
  if (
    ["node", "tsx", "bun", "deno", "python", "python3"].includes(base) &&
    (args.includes("-e") || args.includes("--eval") || args.includes("-c"))
  ) {
    return true;
  }
  return false;
}

export function buildSandboxEnv(options: {
  taskId: string;
  runId: string;
  worktreePath: string;
  branchName?: string | null;
  prompt?: string;
  baseEnv?: NodeJS.ProcessEnv;
  explicitEnv?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };

  for (const key of SENSITIVE_ENV_KEYS) {
    delete env[key];
  }

  env.OPC_SANDBOX = "1";
  env.OPC_TASK_ID = options.taskId;
  env.OPC_RUN_ID = options.runId;
  env.OPC_WORKTREE = options.worktreePath;
  env.HFLOW_WORKER = "1";
  if (options.branchName) {
    env.OPC_BRANCH = options.branchName;
  }
  if (options.prompt !== undefined) {
    env.OPC_TASK_PROMPT = options.prompt;
  }

  if (options.explicitEnv) {
    for (const [k, v] of Object.entries(options.explicitEnv)) {
      if (typeof v === "string") {
        env[k] = v;
      }
    }
  }

  return env;
}

export function matchProtectedPaths(changedFiles: string[], protectedPaths: string[]): string[] {
  const normalizedRules = protectedPaths
    .map((rule) => normalizeRelPath(rule))
    .filter(Boolean);

  if (normalizedRules.length === 0 || changedFiles.length === 0) return [];

  const violations = new Set<string>();
  for (const rawFile of changedFiles) {
    const file = normalizeRelPath(rawFile);
    if (!file || file === SANDBOX_RC_NAME) continue;

    for (const rule of normalizedRules) {
      if (rule.endsWith("/")) {
        if (file.startsWith(rule)) {
          violations.add(file);
          break;
        }
      } else if (file === rule || file.startsWith(rule + "/")) {
        violations.add(file);
        break;
      }
    }
  }

  return [...violations].sort();
}

export interface ParsedLineUsage {
  totalTokens?: number;
  tokens?: number;
  costUsd?: number;
}

export function parseUsageFromLine(line: string): ParsedLineUsage {
  const result: ParsedLineUsage = {};

  const totalTokensMatch = line.match(/\btotal_tokens"?\s*[:=\s]\s*([\d,]+)/i);
  if (totalTokensMatch) {
    const value = Number(totalTokensMatch[1].replaceAll(",", ""));
    if (Number.isFinite(value) && value >= 0) {
      result.totalTokens = Math.floor(value);
    }
  } else {
    const tokensMatch = line.match(/(?<![a-z0-9_])tokens?"?\s*[:=\s]\s*([\d,]+)/i);
    if (tokensMatch) {
      const value = Number(tokensMatch[1].replaceAll(",", ""));
      if (Number.isFinite(value) && value >= 0) {
        result.tokens = Math.floor(value);
      }
    }
  }

  const costMatch =
    line.match(/\bcost_usd"?\s*[:=\s]\s*"?\$?([\d]+(?:\.[\d]+)?)/i) ??
    line.match(/\bcost"?\s*[:=]\s*"?\$([\d]+(?:\.[\d]+)?)/i);
  if (costMatch) {
    const value = Number(costMatch[1]);
    if (Number.isFinite(value) && value >= 0) {
      result.costUsd = value;
    }
  }

  return result;
}

function forceKillChild(child: ChildProcess): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct child kill
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Process already exited
  }
}

async function execGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function isGitRepository(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    const out = await execGit(dir, ["rev-parse", "--is-inside-work-tree"], 5_000);
    return out === "true";
  } catch {
    return false;
  }
}

function parsePorcelainFiles(porcelainOutput: string): string[] {
  const files: string[] = [];
  for (const rawLine of porcelainOutput.split(/\r?\n/)) {
    if (!rawLine || rawLine.length < 4) continue;
    let filePart = rawLine.slice(3).trim();
    if (filePart.includes(" -> ")) {
      filePart = filePart.split(" -> ").at(-1)?.trim() ?? filePart;
    }
    if (filePart.startsWith('"') && filePart.endsWith('"')) {
      filePart = filePart.slice(1, -1);
    }
    const normalized = normalizeRelPath(filePart);
    if (normalized && normalized !== SANDBOX_RC_NAME) {
      files.push(normalized);
    }
  }
  return files;
}

async function collectGitChanges(
  cwd: string,
  baseCommit: string | null,
): Promise<{ newCommitCount: number; committedFiles: string[]; dirtyFiles: string[]; changedFiles: string[] }> {
  let newCommitCount = 0;
  const committedSet = new Set<string>();
  const dirtySet = new Set<string>();

  if (baseCommit) {
    try {
      const countText = await execGit(cwd, ["rev-list", "--count", `${baseCommit}..HEAD`]);
      newCommitCount = Number(countText) || 0;
    } catch {
      newCommitCount = 0;
    }

    if (newCommitCount > 0) {
      try {
        const diffOut = await execGit(cwd, ["diff", "--name-only", `${baseCommit}..HEAD`]);
        for (const line of diffOut.split(/\r?\n/)) {
          const normalized = normalizeRelPath(line);
          if (normalized && normalized !== SANDBOX_RC_NAME) committedSet.add(normalized);
        }
      } catch {
        // ignore diff errors
      }
    }
  }

  try {
    const headDiff = await execGit(cwd, ["diff", "--name-only", "HEAD"]);
    for (const line of headDiff.split(/\r?\n/)) {
      const normalized = normalizeRelPath(line);
      if (normalized && normalized !== SANDBOX_RC_NAME) dirtySet.add(normalized);
    }
  } catch {
    // HEAD may not exist on empty repo
  }

  try {
    const cachedDiff = await execGit(cwd, ["diff", "--cached", "--name-only"]);
    for (const line of cachedDiff.split(/\r?\n/)) {
      const normalized = normalizeRelPath(line);
      if (normalized && normalized !== SANDBOX_RC_NAME) dirtySet.add(normalized);
    }
  } catch {
    // ignore
  }

  try {
    const porcelain = await execGit(cwd, ["status", "--porcelain", "-uall"]);
    for (const file of parsePorcelainFiles(porcelain)) {
      dirtySet.add(file);
    }
  } catch {
    // ignore
  }

  const committedFiles = [...committedSet].sort();
  const dirtyFiles = [...dirtySet].sort();
  const changedFiles = [...new Set([...committedFiles, ...dirtyFiles])].sort();
  return { newCommitCount, committedFiles, dirtyFiles, changedFiles };
}

interface ActiveRunRuntime {
  runId: string;
  agentId: string;
  child: ChildProcess | null;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  finalized: boolean;
  seq: number;
  tokenUsed: number;
  costUsd: number;
  hasExplicitCost: boolean;
  retryCount: number;
  lastStderr: string;
  baseCommit: string | null;
  isGitWorktree: boolean;
  logFilePath: string;
  donePromise: Promise<void>;
  resolveDone: () => void;
}

function rowToAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    type: String(row.type ?? "cli") as AgentType,
    cliCommand: String(row.cli_command),
    promptTemplate: String(row.prompt_template ?? ""),
    maxCostPerTask: Number(row.max_cost_per_task ?? 5),
    maxDurationSecs: Number(row.max_duration_secs ?? 1800),
    maxRetries: Number(row.max_retries ?? 3),
    status: String(row.status ?? "idle") as AgentRegistryStatus,
    capabilities: safeJsonParse<string[]>(row.capabilities, []),
    config: safeJsonParse<Record<string, unknown>>(row.config, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToRun(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    taskTitle: String(row.task_title),
    taskDescription: String(row.task_description ?? ""),
    project: String(row.project ?? ""),
    agentId: String(row.agent_id),
    agentName: String(row.agent_name),
    repoPath: row.repo_path == null ? null : String(row.repo_path),
    worktreePath: row.worktree_path == null ? null : String(row.worktree_path),
    branchName: row.branch_name == null ? null : String(row.branch_name),
    status: String(row.status ?? "queued") as AgentRunStatus,
    pid: row.pid == null ? null : Number(row.pid),
    tokenUsed: Number(row.token_used ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    retryCount: Number(row.retry_count ?? 0),
    logFilePath: row.log_file_path == null ? null : String(row.log_file_path),
    errorSummary: row.error_summary == null ? null : String(row.error_summary),
    prUrl: row.pr_url == null ? null : String(row.pr_url),
    changedFiles: safeJsonParse<string[]>(row.changed_files, []),
    protectedViolations: safeJsonParse<string[]>(row.protected_violations, []),
    circuitBreakerReason:
      row.circuit_breaker_reason == null ? null : (String(row.circuit_breaker_reason) as CircuitBreakerReason),
    autoCreatePr: Number(row.auto_create_pr ?? 0) === 1,
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToAudit(row: Record<string, unknown>): FactoryAuditRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status) as AuditStatus,
    summary: String(row.summary),
    details: safeJsonParse<FactoryAuditDetails>(row.details, {
      repoRoot: "",
      protectedPaths: [],
      changedFiles: [],
      violations: [],
      isGitRepo: false,
      recentViolationsCount: 0,
    }),
    createdAt: String(row.created_at),
  };
}

export class DarkFactoryStore {
  hooks: DarkFactoryHooks;
  private worktreeBase: string;
  private defaultRepoRoot: string;
  private defaultCostPerMillionTokens: number;
  private durationUnitMs: number;
  private activeRuns = new Map<string, ActiveRunRuntime>();
  private cancelRequested = new Set<string>();
  private logListeners = new Map<string, Set<(event: RunStreamEvent) => void>>();

  constructor(
    private db: DatabaseSync,
    private providers: ProvidersStore,
    options: DarkFactoryOptions = {},
  ) {
    this.hooks = options.hooks ?? {};
    this.worktreeBase = resolve(options.worktreeBase ?? "data/factory-worktrees");
    this.defaultRepoRoot = resolve(options.defaultRepoRoot ?? process.cwd());
    this.defaultCostPerMillionTokens = options.defaultCostPerMillionTokens ?? DEFAULT_COST_PER_MILLION_TOKENS;
    this.durationUnitMs = options.durationUnitMs ?? 1000;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_agent_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'cli',
        cli_command TEXT NOT NULL,
        prompt_template TEXT NOT NULL DEFAULT '',
        max_cost_per_task REAL NOT NULL DEFAULT 5.0,
        max_duration_secs REAL NOT NULL DEFAULT 1800,
        max_retries INTEGER NOT NULL DEFAULT 3,
        status TEXT NOT NULL DEFAULT 'idle',
        capabilities TEXT NOT NULL DEFAULT '[]',
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_title TEXT NOT NULL,
        task_description TEXT NOT NULL DEFAULT '',
        project TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        repo_path TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        pid INTEGER,
        token_used INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        log_file_path TEXT,
        error_summary TEXT,
        pr_url TEXT,
        changed_files TEXT NOT NULL DEFAULT '[]',
        protected_violations TEXT NOT NULL DEFAULT '[]',
        circuit_breaker_reason TEXT,
        auto_create_pr INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_opc_agent_runs_status ON opc_agent_runs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_opc_agent_runs_created ON opc_agent_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opc_agent_runs_project ON opc_agent_runs(project, created_at);

      CREATE TABLE IF NOT EXISTS opc_factory_audits (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);

    // Defensive migration in case table pre-existed without task_description.
    const cols = this.db.prepare("PRAGMA table_info(opc_agent_runs)").all() as Array<{ name?: string }>;
    if (!cols.some((col) => col.name === "task_description")) {
      this.db.exec("ALTER TABLE opc_agent_runs ADD COLUMN task_description TEXT NOT NULL DEFAULT ''");
    }
  }

  // ---- Agent Registry CRUD ----

  listAgents(): AgentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM opc_agent_registry ORDER BY created_at ASC, name ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToAgent);
  }

  getAgent(id: string): AgentRecord {
    const row = this.db.prepare("SELECT * FROM opc_agent_registry WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new ApiError(404, "agent_not_found", `找不到 Agent：${id}`);
    }
    return rowToAgent(row);
  }

  createAgent(raw: unknown): AgentRecord {
    const parsed = createAgentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "agent_input",
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
      );
    }
    const data = parsed.data;
    // Validate command parses cleanly up front
    splitCommandArgs(data.cliCommand);

    const existing = this.db.prepare("SELECT id FROM opc_agent_registry WHERE name = ?").get(data.name) as
      | { id?: string }
      | undefined;
    if (existing?.id) {
      throw new ApiError(409, "agent_name_conflict", `已存在同名 Agent「${data.name}」`);
    }

    const id = `agt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO opc_agent_registry (
          id, name, description, type, cli_command, prompt_template,
          max_cost_per_task, max_duration_secs, max_retries, status,
          capabilities, config, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.name,
        data.description,
        data.type,
        data.cliCommand,
        data.promptTemplate,
        data.maxCostPerTask,
        data.maxDurationSecs,
        data.maxRetries,
        data.status,
        JSON.stringify(data.capabilities),
        JSON.stringify(data.config),
        ts,
        ts,
      );
    return this.getAgent(id);
  }

  updateAgent(id: string, raw: unknown): AgentRecord {
    const current = this.getAgent(id);
    const parsed = updateAgentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "agent_input",
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
      );
    }
    const patch = parsed.data;

    if (patch.cliCommand !== undefined) {
      splitCommandArgs(patch.cliCommand);
    }
    if (patch.name !== undefined && patch.name !== current.name) {
      const clash = this.db
        .prepare("SELECT id FROM opc_agent_registry WHERE name = ? AND id != ?")
        .get(patch.name, id) as { id?: string } | undefined;
      if (clash?.id) {
        throw new ApiError(409, "agent_name_conflict", `已存在同名 Agent「${patch.name}」`);
      }
    }

    const next: AgentRecord = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      type: patch.type ?? current.type,
      cliCommand: patch.cliCommand ?? current.cliCommand,
      promptTemplate: patch.promptTemplate ?? current.promptTemplate,
      maxCostPerTask: patch.maxCostPerTask ?? current.maxCostPerTask,
      maxDurationSecs: patch.maxDurationSecs ?? current.maxDurationSecs,
      maxRetries: patch.maxRetries ?? current.maxRetries,
      status: patch.status ?? current.status,
      capabilities: patch.capabilities ?? current.capabilities,
      config: patch.config ?? current.config,
      updatedAt: nowIso(),
    };

    this.db
      .prepare(
        `UPDATE opc_agent_registry SET
          name = ?, description = ?, type = ?, cli_command = ?, prompt_template = ?,
          max_cost_per_task = ?, max_duration_secs = ?, max_retries = ?, status = ?,
          capabilities = ?, config = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        next.type,
        next.cliCommand,
        next.promptTemplate,
        next.maxCostPerTask,
        next.maxDurationSecs,
        next.maxRetries,
        next.status,
        JSON.stringify(next.capabilities),
        JSON.stringify(next.config),
        next.updatedAt,
        id,
      );

    return this.getAgent(id);
  }

  deleteAgent(id: string): { deleted: true; id: string } {
    this.getAgent(id);
    const active = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM opc_agent_runs WHERE agent_id = ? AND status IN ('running', 'queued')")
      .get(id) as { cnt?: number } | undefined;
    if (Number(active?.cnt ?? 0) > 0) {
      throw new ApiError(409, "agent_busy", "该 Agent 仍有运行中或排队中的任务，请先终止后再删除");
    }
    this.db.prepare("DELETE FROM opc_agent_registry WHERE id = ?").run(id);
    return { deleted: true, id };
  }

  // ---- Dispatch & Concurrency Queue ----

  dispatch(raw: DispatchRunInput | unknown): AgentRunRecord {
    const parsed = dispatchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "dispatch_input",
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
      );
    }
    const input = parsed.data;
    const agent = this.getAgent(input.agentId);
    if (agent.status === "disabled") {
      throw new ApiError(400, "agent_disabled", `Agent「${agent.name}」已被禁用，无法派发任务`);
    }

    const resolvedRepoPath =
      (input.repoPath && input.repoPath.trim()) ||
      (input.project ? this.hooks.resolveRepoPath?.(input.project) ?? null : null);

    const id = `run_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ts = nowIso();

    this.db
      .prepare(
        `INSERT INTO opc_agent_runs (
          id, task_id, task_title, task_description, project, agent_id, agent_name,
          repo_path, worktree_path, branch_name, status, pid, token_used, cost_usd,
          retry_count, log_file_path, error_summary, pr_url, changed_files,
          protected_violations, circuit_breaker_reason, auto_create_pr,
          started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', NULL, 0, 0, 0, NULL, NULL, NULL, '[]', '[]', NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.taskTitle,
        input.taskDescription,
        input.project,
        agent.id,
        agent.name,
        resolvedRepoPath ? resolve(resolvedRepoPath) : null,
        input.autoCreatePr ? 1 : 0,
        ts,
        ts,
      );

    const created = this.getRun(id);
    this.notifyRunChanged(created);
    this.tickQueue();
    return this.getRun(id);
  }

  tickQueue(): number {
    const maxConcurrent = Math.max(1, Number(this.providers.get().system.maxConcurrentAgents ?? 3) || 3);
    const runningRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM opc_agent_runs WHERE status = 'running'")
      .get() as { cnt?: number } | undefined;
    let runningCount = Number(runningRow?.cnt ?? 0);

    let launched = 0;
    while (runningCount < maxConcurrent) {
      const nextQueued = this.db
        .prepare("SELECT * FROM opc_agent_runs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      if (!nextQueued) break;

      const run = rowToRun(nextQueued);
      let agent: AgentRecord;
      try {
        agent = this.getAgent(run.agentId);
      } catch {
        this.markRunFailedBeforeStart(run.id, "关联的 Agent 已被删除，无法执行");
        continue;
      }

      if (agent.status === "disabled") {
        this.markRunFailedBeforeStart(run.id, `Agent「${agent.name}」在排队期间已被禁用`);
        continue;
      }

      const logDir = resolve(this.providers.get().system.agentLogDir || "data/agent-logs");
      mkdirSync(logDir, { recursive: true });
      const logFilePath = join(logDir, `${run.id}.log`);
      const startedAt = nowIso();

      this.db
        .prepare(
          `UPDATE opc_agent_runs
           SET status = 'running', log_file_path = ?, started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(logFilePath, startedAt, startedAt, run.id);

      this.syncAgentStatus(agent.id, "running");

      let resolveDone!: () => void;
      const donePromise = new Promise<void>((res) => {
        resolveDone = res;
      });
      const runtime: ActiveRunRuntime = {
        runId: run.id,
        agentId: agent.id,
        child: null,
        timeoutHandle: null,
        finalized: false,
        seq: 0,
        tokenUsed: 0,
        costUsd: 0,
        hasExplicitCost: false,
        retryCount: 0,
        lastStderr: "",
        baseCommit: null,
        isGitWorktree: false,
        logFilePath,
        donePromise,
        resolveDone,
      };
      this.activeRuns.set(run.id, runtime);

      const runningRun = this.getRun(run.id);
      this.notifyRunChanged(runningRun);
      this.emitStreamEvent(run.id, { type: "state", run: runningRun });

      runningCount += 1;
      launched += 1;

      void this.executeRun(runningRun, agent, runtime);
    }

    return launched;
  }

  private markRunFailedBeforeStart(runId: string, summary: string): void {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE opc_agent_runs
         SET status = 'failed', error_summary = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(summary, ts, ts, runId);
    const updated = this.getRun(runId);
    this.notifyRunChanged(updated);
    this.emitStreamEvent(runId, { type: "done", run: updated });
  }

  private syncAgentStatus(agentId: string, preferred: AgentRegistryStatus): void {
    const row = this.db.prepare("SELECT status FROM opc_agent_registry WHERE id = ?").get(agentId) as
      | { status?: string }
      | undefined;
    if (!row || row.status === "disabled") return;

    if (preferred !== "running") {
      const otherRunning = this.db
        .prepare("SELECT COUNT(*) AS cnt FROM opc_agent_runs WHERE agent_id = ? AND status = 'running'")
        .get(agentId) as { cnt?: number } | undefined;
      if (Number(otherRunning?.cnt ?? 0) > 0) {
        return;
      }
    }

    this.db
      .prepare("UPDATE opc_agent_registry SET status = ?, updated_at = ? WHERE id = ?")
      .run(preferred, nowIso(), agentId);
  }

  private appendLog(runtime: ActiveRunRuntime, stream: LogStreamKind, line: string): RunLogEntry {
    runtime.seq += 1;
    const entry: RunLogEntry = {
      seq: runtime.seq,
      timestamp: nowIso(),
      stream,
      line,
    };
    try {
      appendFileSync(runtime.logFilePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Ignore transient disk write error while keeping live stream responsive
    }
    this.emitStreamEvent(runtime.runId, { type: "log", entry });
    return entry;
  }

  private writeSandboxRc(
    workdir: string,
    run: AgentRunRecord,
    branchName: string | null,
    protectedPaths: string[],
  ): void {
    const content = [
      "# OPC OS Dark Factory Sandbox Metadata",
      "OPC_SANDBOX=1",
      `OPC_RUN_ID=${run.id}`,
      `OPC_TASK_ID=${run.taskId}`,
      `OPC_WORKTREE=${workdir}`,
      `OPC_BRANCH=${branchName ?? ""}`,
      "HFLOW_WORKER=1",
      `OPC_PROTECTED_PATHS=${JSON.stringify(protectedPaths)}`,
      "",
    ].join("\n");
    writeFileSync(join(workdir, SANDBOX_RC_NAME), content, "utf8");
  }

  private async prepareWorkspace(
    run: AgentRunRecord,
    agent: AgentRecord,
    runtime: ActiveRunRuntime,
  ): Promise<{ workdir: string; branchName: string | null; isGitWorktree: boolean }> {
    mkdirSync(this.worktreeBase, { recursive: true });
    const targetDir = join(this.worktreeBase, run.id);

    if (run.repoPath && (await isGitRepository(run.repoPath))) {
      const repoRoot = await execGit(run.repoPath, ["rev-parse", "--show-toplevel"]);
      let baseCommit: string | null = null;
      try {
        baseCommit = await execGit(repoRoot, ["rev-parse", "HEAD"]);
      } catch {
        baseCommit = null;
      }

      const baseSlug = slugify(agent.name);
      let branchName = `agent/${baseSlug}/${run.id.slice(0, 8)}`;
      try {
        await execGit(repoRoot, ["worktree", "add", "-b", branchName, targetDir, "HEAD"]);
      } catch {
        branchName = `agent/${baseSlug}/${run.id.slice(0, 12)}-${Date.now().toString(36)}`;
        await execGit(repoRoot, ["worktree", "add", "-b", branchName, targetDir, "HEAD"]);
      }

      runtime.baseCommit = baseCommit;
      runtime.isGitWorktree = true;

      this.db
        .prepare("UPDATE opc_agent_runs SET repo_path = ?, worktree_path = ?, branch_name = ?, updated_at = ? WHERE id = ?")
        .run(repoRoot, targetDir, branchName, nowIso(), run.id);

      this.appendLog(runtime, "system", `已创建隔离 Git Worktree：${targetDir}（分支 ${branchName}）`);
      return { workdir: targetDir, branchName, isGitWorktree: true };
    }

    // Fallback: non-git repo or no repoPath supplied
    let workdir: string;
    if (run.repoPath && existsSync(run.repoPath)) {
      workdir = run.repoPath;
      this.appendLog(
        runtime,
        "system",
        `目标路径 ${run.repoPath} 非 Git 仓库，已降级在该工作目录沙盒运行（跳过 Git Worktree 隔离）。`,
      );
    } else {
      mkdirSync(targetDir, { recursive: true });
      workdir = targetDir;
      this.appendLog(
        runtime,
        "system",
        `未提供有效 Git 仓库路径，已降级在临时沙盒目录 ${targetDir} 运行。`,
      );
    }

    runtime.baseCommit = null;
    runtime.isGitWorktree = false;
    this.db
      .prepare("UPDATE opc_agent_runs SET worktree_path = ?, branch_name = NULL, updated_at = ? WHERE id = ?")
      .run(workdir, nowIso(), run.id);

    return { workdir, branchName: null, isGitWorktree: false };
  }

  private buildSpawnCommand(
    agent: AgentRecord,
    vars: {
      taskId: string;
      taskTitle: string;
      taskDescription: string;
      worktreePath: string;
      branchName: string;
    },
  ): { command: string; args: string[]; renderedPrompt: string } {
    const hasPromptTemplate = Boolean(agent.promptTemplate.trim());
    const renderedPrompt = hasPromptTemplate
      ? renderPromptTemplate(agent.promptTemplate, vars)
      : vars.taskDescription
        ? `${vars.taskTitle}\n\n${vars.taskDescription}`
        : vars.taskTitle;

    const rawTokens = splitCommandArgs(agent.cliCommand);
    let usedPromptPlaceholder = false;
    const expanded = rawTokens.map((token) => {
      if (token.includes("{{prompt}}")) {
        usedPromptPlaceholder = true;
      }
      return renderPromptTemplate(token.replaceAll("{{prompt}}", renderedPrompt), vars);
    });

    const [rawBin, ...args] = expanded;
    const command = rawBin === "node" ? process.execPath : rawBin;

    if (!usedPromptPlaceholder && hasPromptTemplate && !isInlineScriptCommand(rawBin, args)) {
      args.push("--prompt", renderedPrompt);
    }

    return { command, args, renderedPrompt };
  }

  private finalizeRun(
    runtime: ActiveRunRuntime,
    update: {
      status: AgentRunStatus;
      errorSummary?: string | null;
      prUrl?: string | null;
      changedFiles?: string[];
      protectedViolations?: string[];
      circuitBreakerReason?: CircuitBreakerReason | null;
      systemMessage?: string;
    },
  ): AgentRunRecord {
    if (runtime.finalized) {
      return this.getRun(runtime.runId);
    }
    runtime.finalized = true;

    if (runtime.timeoutHandle) {
      clearTimeout(runtime.timeoutHandle);
      runtime.timeoutHandle = null;
    }

    if (update.systemMessage) {
      this.appendLog(runtime, "system", update.systemMessage);
    }

    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE opc_agent_runs SET
          status = ?,
          token_used = ?,
          cost_usd = ?,
          retry_count = ?,
          error_summary = ?,
          pr_url = COALESCE(?, pr_url),
          changed_files = ?,
          protected_violations = ?,
          circuit_breaker_reason = ?,
          completed_at = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        update.status,
        runtime.tokenUsed,
        roundUsd(runtime.costUsd),
        runtime.retryCount,
        update.errorSummary ?? null,
        update.prUrl ?? null,
        JSON.stringify(update.changedFiles ?? []),
        JSON.stringify(update.protectedViolations ?? []),
        update.circuitBreakerReason ?? null,
        ts,
        ts,
        runtime.runId,
      );

    this.activeRuns.delete(runtime.runId);
    this.cancelRequested.delete(runtime.runId);

    this.syncAgentStatus(runtime.agentId, update.status === "failed" ? "error" : "idle");

    const finished = this.getRun(runtime.runId);
    this.notifyRunChanged(finished);
    this.emitStreamEvent(runtime.runId, { type: "done", run: finished });
    runtime.resolveDone();

    // Immediately drain next queued task in FIFO order
    this.tickQueue();
    return finished;
  }

  private triggerCircuitBreaker(
    runtime: ActiveRunRuntime,
    reason: CircuitBreakerReason,
    errorSummary: string,
  ): void {
    if (runtime.finalized) return;
    if (runtime.child) {
      forceKillChild(runtime.child);
    }
    this.finalizeRun(runtime, {
      status: "failed",
      circuitBreakerReason: reason,
      errorSummary,
      systemMessage: `[CIRCUIT_BREAKER:${reason}] ${errorSummary}`,
    });
  }

  private handleOutputLine(runtime: ActiveRunRuntime, agent: AgentRecord, stream: "stdout" | "stderr", line: string): void {
    if (runtime.finalized) return;

    this.appendLog(runtime, stream, line);

    // 1. Parse token / cost usage from stdout & stderr
    const usage = parseUsageFromLine(line);
    let usageChanged = false;
    if (usage.totalTokens !== undefined) {
      if (usage.totalTokens > runtime.tokenUsed) {
        runtime.tokenUsed = usage.totalTokens;
        usageChanged = true;
      }
    } else if (usage.tokens !== undefined) {
      runtime.tokenUsed += usage.tokens;
      usageChanged = true;
    }

    if (usage.costUsd !== undefined) {
      runtime.hasExplicitCost = true;
      runtime.costUsd = Math.max(runtime.costUsd, usage.costUsd);
      usageChanged = true;
    } else if (usageChanged && !runtime.hasExplicitCost) {
      runtime.costUsd = roundUsd((runtime.tokenUsed / 1_000_000) * this.defaultCostPerMillionTokens);
    }

    if (usageChanged) {
      this.db
        .prepare("UPDATE opc_agent_runs SET token_used = ?, cost_usd = ?, updated_at = ? WHERE id = ?")
        .run(runtime.tokenUsed, roundUsd(runtime.costUsd), nowIso(), runtime.runId);

      if (runtime.costUsd > agent.maxCostPerTask) {
        this.triggerCircuitBreaker(
          runtime,
          "cost_limit_exceeded",
          `费用熔断：当前 $${runtime.costUsd.toFixed(4)}（${runtime.tokenUsed} tokens）超过上限 $${agent.maxCostPerTask.toFixed(4)}`,
        );
        return;
      }
    }

    // 2. Dead-loop error detection on stderr
    if (stream === "stderr") {
      runtime.lastStderr = line;
      if (DEAD_LOOP_STDERR_RE.test(line)) {
        runtime.retryCount += 1;
        this.db
          .prepare("UPDATE opc_agent_runs SET retry_count = ?, updated_at = ? WHERE id = ?")
          .run(runtime.retryCount, nowIso(), runtime.runId);

        if (runtime.retryCount >= agent.maxRetries) {
          this.triggerCircuitBreaker(
            runtime,
            "dead_loop_detected",
            `死循环熔断：stderr 捕获 ${runtime.retryCount} 次错误/异常（熔断阈值 ${agent.maxRetries}）`,
          );
          return;
        }
      }
    }
  }

  private async executeRun(run: AgentRunRecord, agent: AgentRecord, runtime: ActiveRunRuntime): Promise<void> {
    try {
      if (this.cancelRequested.has(run.id)) {
        this.finalizeRun(runtime, {
          status: "cancelled",
          errorSummary: "任务在启动前已被取消",
          systemMessage: "任务在启动前已被人工取消。",
        });
        return;
      }

      const workspace = await this.prepareWorkspace(run, agent, runtime);

      if (this.cancelRequested.has(run.id)) {
        this.finalizeRun(runtime, {
          status: "cancelled",
          errorSummary: "任务在工作区准备后已被取消",
          systemMessage: "任务已被人工取消。",
        });
        return;
      }

      const protectedPaths = this.providers.get().system.protectedPaths;
      this.writeSandboxRc(workspace.workdir, run, workspace.branchName, protectedPaths);

      const spawnSpec = this.buildSpawnCommand(agent, {
        taskId: run.taskId,
        taskTitle: run.taskTitle,
        taskDescription: run.taskDescription,
        worktreePath: workspace.workdir,
        branchName: workspace.branchName ?? "",
      });

      const explicitEnv =
        agent.config && typeof agent.config.env === "object" && agent.config.env !== null
          ? Object.fromEntries(
              Object.entries(agent.config.env as Record<string, unknown>).filter(
                (pair): pair is [string, string] => typeof pair[1] === "string",
              ),
            )
          : undefined;

      const env = buildSandboxEnv({
        taskId: run.taskId,
        runId: run.id,
        worktreePath: workspace.workdir,
        branchName: workspace.branchName,
        prompt: spawnSpec.renderedPrompt,
        explicitEnv,
      });

      this.appendLog(
        runtime,
        "system",
        `启动执行：${spawnSpec.command} ${spawnSpec.args.map((a) => (a.length > 80 ? a.slice(0, 80) + "…" : a)).join(" ")}`,
      );

      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: workspace.workdir,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      runtime.child = child;

      if (child.pid) {
        this.db
          .prepare("UPDATE opc_agent_runs SET pid = ?, updated_at = ? WHERE id = ?")
          .run(child.pid, nowIso(), run.id);
      }

      // Duration watchdog
      const timeoutMs = Math.max(50, Math.round(agent.maxDurationSecs * this.durationUnitMs));
      runtime.timeoutHandle = setTimeout(() => {
        this.triggerCircuitBreaker(
          runtime,
          "duration_limit_exceeded",
          `超时熔断：运行时间超过上限 ${agent.maxDurationSecs}s`,
        );
      }, timeoutMs);

      let stdoutBuf = "";
      let stderrBuf = "";

      const flushChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (stream === "stdout") {
          stdoutBuf += text;
          const parts = stdoutBuf.split(/\r?\n/);
          stdoutBuf = parts.pop() ?? "";
          for (const line of parts) {
            if (runtime.finalized) break;
            if (line.length > 0) this.handleOutputLine(runtime, agent, "stdout", line);
          }
        } else {
          stderrBuf += text;
          const parts = stderrBuf.split(/\r?\n/);
          stderrBuf = parts.pop() ?? "";
          for (const line of parts) {
            if (runtime.finalized) break;
            if (line.length > 0) this.handleOutputLine(runtime, agent, "stderr", line);
          }
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => flushChunk("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => flushChunk("stderr", chunk));

      child.on("error", (err) => {
        this.finalizeRun(runtime, {
          status: "failed",
          errorSummary: `进程启动失败：${err.message}`,
          systemMessage: `进程启动异常：${err.message}`,
        });
      });

      child.on("close", (code, signal) => {
        if (!runtime.finalized) {
          if (stdoutBuf.trim()) this.handleOutputLine(runtime, agent, "stdout", stdoutBuf);
          if (stderrBuf.trim()) this.handleOutputLine(runtime, agent, "stderr", stderrBuf);
        }
        if (runtime.finalized) return;

        void this.handleProcessExit(runtime, run, workspace, code, signal);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finalizeRun(runtime, {
        status: "failed",
        errorSummary: `暗工厂调度异常：${msg}`,
        systemMessage: `暗工厂调度失败：${msg}`,
      });
    }
  }

  private async handleProcessExit(
    runtime: ActiveRunRuntime,
    run: AgentRunRecord,
    workspace: { workdir: string; branchName: string | null; isGitWorktree: boolean },
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (runtime.finalized) return;

    if (code !== 0) {
      const summary =
        runtime.lastStderr ||
        (signal ? `进程被信号终止 (${signal})` : `进程异常退出 (exit code ${code ?? "unknown"})`);
      this.finalizeRun(runtime, {
        status: "failed",
        errorSummary: summary,
        systemMessage: `执行失败：${summary}`,
      });
      return;
    }

    // Exit code 0 — inspect Git Worktree if applicable
    if (!workspace.isGitWorktree) {
      this.finalizeRun(runtime, {
        status: "completed",
        systemMessage: "非 Git 沙盒执行完成 (exit code 0)。",
      });
      return;
    }

    const gitChanges = await collectGitChanges(workspace.workdir, runtime.baseCommit);

    // 1. Self-bootstrap human-exclusive protected paths verification
    const protectedPaths = this.providers.get().system.protectedPaths;
    const violations = matchProtectedPaths(gitChanges.changedFiles, protectedPaths);
    if (violations.length > 0) {
      this.finalizeRun(runtime, {
        status: "failed",
        changedFiles: gitChanges.changedFiles,
        protectedViolations: violations,
        circuitBreakerReason: "protected_path_violation",
        errorSummary: `自举安全拦截：改动触碰人类独占路径（${violations.join(", ")}），已禁止自动创建 PR`,
        systemMessage: `[PROTECTED_PATH_VIOLATION] 检测到受保护路径变更：${violations.join(", ")}，已拦截自动 PR。`,
      });
      return;
    }

    // 2. Accurate no_output detection: zero commits & zero worktree modifications
    if (gitChanges.newCommitCount === 0 && gitChanges.changedFiles.length === 0) {
      this.finalizeRun(runtime, {
        status: "no_output",
        changedFiles: [],
        errorSummary: "进程退出码为 0，但在 Git Worktree 中未产生任何新 commit 或文件改动",
        systemMessage: "完工检测：零改动且零新 commit，已标记为 no_output。",
      });
      return;
    }

    // 3. Valid output — optionally push & create PR when autoCreatePr is enabled
    let prUrl: string | null = null;
    let finalStatus: AgentRunStatus = "completed";
    let systemMessage = `完工检测通过：新 commit ${gitChanges.newCommitCount} 个，变更文件 ${gitChanges.changedFiles.length} 个。`;

    if (run.autoCreatePr && workspace.branchName) {
      const prAttempt = await this.tryPushAndCreatePr({
        runId: run.id,
        taskTitle: run.taskTitle,
        taskDescription: run.taskDescription,
        workdir: workspace.workdir,
        branchName: workspace.branchName,
        newCommitCount: gitChanges.newCommitCount,
        dirtyFiles: gitChanges.dirtyFiles,
        changedFiles: gitChanges.changedFiles,
      });

      if (prAttempt.ok) {
        prUrl = prAttempt.prUrl;
        finalStatus = "pr_open";
        systemMessage = `已自动推送分支并创建 PR：${prUrl}`;
      } else {
        systemMessage = `${systemMessage}（自动建 PR 跳过/失败：${prAttempt.reason}，可稍后手动建 PR）`;
      }
    }

    this.finalizeRun(runtime, {
      status: finalStatus,
      prUrl,
      changedFiles: gitChanges.changedFiles,
      protectedViolations: [],
      systemMessage,
    });
  }

  private async tryPushAndCreatePr(params: {
    runId: string;
    taskTitle: string;
    taskDescription: string;
    workdir: string;
    branchName: string;
    newCommitCount: number;
    dirtyFiles: string[];
    changedFiles: string[];
    title?: string;
    body?: string;
    baseBranch?: string;
  }): Promise<{ ok: true; prUrl: string } | { ok: false; reason: string; code: string }> {
    let remoteUrl = "";
    try {
      remoteUrl = await execGit(params.workdir, ["remote", "get-url", "origin"], 5_000);
    } catch {
      return { ok: false, code: "no_git_remote", reason: "仓库未配置 remote origin" };
    }
    if (!remoteUrl) {
      return { ok: false, code: "no_git_remote", reason: "仓库未配置 remote origin" };
    }

    // If worktree has uncommitted changes and zero commits yet, commit changed files (excluding .sandboxrc)
    if (params.newCommitCount === 0 && params.dirtyFiles.length > 0) {
      try {
        await execGit(params.workdir, ["add", "--", ...params.dirtyFiles], 15_000);
        await execGit(
          params.workdir,
          [
            "-c",
            "user.name=OPC Dark Factory",
            "-c",
            "user.email=dark-factory@opc.local",
            "commit",
            "-m",
            `feat(factory): ${params.taskTitle}`,
          ],
          15_000,
        );
      } catch (err) {
        return {
          ok: false,
          code: "git_commit_failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    try {
      await execGit(params.workdir, ["push", "-u", "origin", params.branchName], 60_000);
    } catch (err) {
      return {
        ok: false,
        code: "git_push_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const prTitle = params.title || `[Dark Factory] ${params.taskTitle}`;
    const prBody =
      params.body ||
      [
        `由 OPC OS 自治 Agent 暗工厂自动生成（Run \`${params.runId}\`）。`,
        "",
        params.taskDescription ? `### 任务说明\n${params.taskDescription}\n` : "",
        `### 变更文件 (${params.changedFiles.length})`,
        ...params.changedFiles.map((f) => `- \`${f}\``),
      ]
        .filter(Boolean)
        .join("\n");

    const ghArgs = ["pr", "create", "--title", prTitle, "--body", prBody, "--head", params.branchName];
    if (params.baseBranch) {
      ghArgs.push("--base", params.baseBranch);
    }

    try {
      const { stdout } = await execFileAsync("gh", ghArgs, {
        cwd: params.workdir,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const urlMatch = stdout.match(/https?:\/\/\S+/);
      const prUrl = urlMatch ? urlMatch[0].trim() : stdout.trim();
      if (!prUrl) {
        return { ok: false, code: "pr_create_failed", reason: "gh pr create 未返回 PR URL" };
      }
      return { ok: true, prUrl };
    } catch (err) {
      return {
        ok: false,
        code: "pr_create_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---- Run Queries, Kill, Retry, Manual PR ----

  listRuns(filter: { limit?: number; status?: string; project?: string } = {}): AgentRunRecord[] {
    const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.project) {
      clauses.push("project = ?");
      params.push(filter.project);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM opc_agent_runs ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToRun);
  }

  getRun(id: string): AgentRunRecord {
    const row = this.db.prepare("SELECT * FROM opc_agent_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new ApiError(404, "run_not_found", `找不到执行记录：${id}`);
    }
    return rowToRun(row);
  }

  getRunLogs(runId: string): RunLogsResponse {
    const run = this.getRun(runId);
    const logs: RunLogEntry[] = [];

    if (run.logFilePath && existsSync(run.logFilePath)) {
      const content = readFileSync(run.logFilePath, "utf8");
      let fallbackSeq = 0;
      for (const rawLine of content.split(/\r?\n/)) {
        if (!rawLine) continue;
        fallbackSeq += 1;
        try {
          const parsed = JSON.parse(rawLine) as Partial<RunLogEntry>;
          if (typeof parsed.line === "string" && typeof parsed.stream === "string") {
            logs.push({
              seq: typeof parsed.seq === "number" ? parsed.seq : fallbackSeq,
              timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : run.createdAt,
              stream: parsed.stream as LogStreamKind,
              line: parsed.line,
            });
            continue;
          }
        } catch {
          // Fall back to plain line
        }
        logs.push({
          seq: fallbackSeq,
          timestamp: run.createdAt,
          stream: "stdout",
          line: rawLine,
        });
      }
    }

    return {
      runId: run.id,
      status: run.status,
      logFilePath: run.logFilePath,
      logs,
    };
  }

  subscribeLogs(runId: string, listener: (event: RunStreamEvent) => void): () => void {
    let set = this.logListeners.get(runId);
    if (!set) {
      set = new Set();
      this.logListeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const listeners = this.logListeners.get(runId);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.logListeners.delete(runId);
      }
    };
  }

  private emitStreamEvent(runId: string, event: RunStreamEvent): void {
    const listeners = this.logListeners.get(runId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  private notifyRunChanged(run: AgentRunRecord): void {
    try {
      this.hooks.onRunStatusChanged?.(run);
    } catch {
      // Never allow external hook error to crash scheduler
    }
  }

  killRun(runId: string): AgentRunRecord {
    const run = this.getRun(runId);

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return run;
    }

    if (run.status === "queued") {
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE opc_agent_runs
           SET status = 'cancelled', error_summary = '排队中已被人工取消', completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(ts, ts, runId);
      const cancelled = this.getRun(runId);
      this.notifyRunChanged(cancelled);
      this.emitStreamEvent(runId, { type: "done", run: cancelled });
      return cancelled;
    }

    this.cancelRequested.add(runId);
    const runtime = this.activeRuns.get(runId);
    if (runtime) {
      if (runtime.child) {
        forceKillChild(runtime.child);
      }
      return this.finalizeRun(runtime, {
        status: "cancelled",
        errorSummary: "已被人工强行终止 (SIGKILL)",
        systemMessage: "收到人工 Kill 指令，已发送 SIGKILL 终止进程。",
      });
    }

    // Orphaned running record (e.g., after server restart)
    if (run.pid) {
      try {
        process.kill(run.pid, "SIGKILL");
      } catch {
        // ignore if already gone
      }
    }
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE opc_agent_runs
         SET status = 'cancelled', error_summary = '已被人工终止', completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(ts, ts, runId);
    this.syncAgentStatus(run.agentId, "idle");
    const cancelled = this.getRun(runId);
    this.notifyRunChanged(cancelled);
    this.emitStreamEvent(runId, { type: "done", run: cancelled });
    this.tickQueue();
    return cancelled;
  }

  retryRun(runId: string): AgentRunRecord {
    const original = this.getRun(runId);
    return this.dispatch({
      taskId: original.taskId,
      taskTitle: original.taskTitle,
      taskDescription: original.taskDescription,
      project: original.project,
      repoPath: original.repoPath ?? undefined,
      agentId: original.agentId,
      autoCreatePr: original.autoCreatePr,
    });
  }

  async createPrForRun(runId: string, rawOptions?: unknown): Promise<AgentRunRecord> {
    const parsed = createPrSchema.safeParse(rawOptions);
    if (!parsed.success) {
      throw new ApiError(400, "pr_input", parsed.error.issues.map((i) => i.message).join(" / "));
    }
    const opts = parsed.data ?? {};
    const run = this.getRun(runId);

    if (run.protectedViolations.length > 0 || run.circuitBreakerReason === "protected_path_violation") {
      throw new ApiError(
        403,
        "protected_path_violation",
        `该运行触碰了人类独占保护路径（${run.protectedViolations.join(", ")}），禁止通过暗工厂创建 PR`,
      );
    }

    if (run.prUrl) {
      return run;
    }

    if (run.status === "queued" || run.status === "running") {
      throw new ApiError(409, "run_in_progress", "任务仍在执行中，完成后才可创建 PR");
    }

    if (run.status === "no_output") {
      throw new ApiError(400, "no_output", "本次运行零代码改动，无法创建 PR");
    }

    if (!run.worktreePath || !run.branchName || !existsSync(run.worktreePath)) {
      throw new ApiError(400, "no_worktree", "找不到对应的 Git Worktree 或分支（可能非 Git 运行或已清理）");
    }

    const changes = await collectGitChanges(run.worktreePath, null);
    const allChanged = [...new Set([...run.changedFiles, ...changes.changedFiles])];
    const violations = matchProtectedPaths(allChanged, this.providers.get().system.protectedPaths);
    if (violations.length > 0) {
      this.db
        .prepare(
          `UPDATE opc_agent_runs
           SET protected_violations = ?, circuit_breaker_reason = 'protected_path_violation', updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(violations), nowIso(), run.id);
      throw new ApiError(
        403,
        "protected_path_violation",
        `自举安全复核拦截：变更触碰人类独占路径（${violations.join(", ")}），禁止创建 PR`,
      );
    }

    const attempt = await this.tryPushAndCreatePr({
      runId: run.id,
      taskTitle: run.taskTitle,
      taskDescription: run.taskDescription,
      workdir: run.worktreePath,
      branchName: run.branchName,
      newCommitCount: changes.dirtyFiles.length > 0 ? 0 : 1,
      dirtyFiles: changes.dirtyFiles,
      changedFiles: allChanged,
      title: opts.title,
      body: opts.body,
      baseBranch: opts.baseBranch,
    });

    if (!attempt.ok) {
      const status = attempt.code === "no_git_remote" ? 400 : 502;
      throw new ApiError(status, attempt.code, `创建 PR 失败：${attempt.reason}`);
    }

    const ts = nowIso();
    this.db
      .prepare("UPDATE opc_agent_runs SET pr_url = ?, status = 'pr_open', updated_at = ? WHERE id = ?")
      .run(attempt.prUrl, ts, run.id);

    const updated = this.getRun(run.id);
    this.notifyRunChanged(updated);
    return updated;
  }

  // ---- Git Worktree Management ----

  listWorktrees(includeRemoved = false): FactoryWorktreeEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM opc_agent_runs WHERE worktree_path IS NOT NULL ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;

    const entries: FactoryWorktreeEntry[] = [];
    for (const row of rows) {
      const run = rowToRun(row);
      if (!run.worktreePath) continue;
      const existsOnDisk = existsSync(run.worktreePath);
      const isManaged = isPathWithin(this.worktreeBase, run.worktreePath);
      const active = run.status === "queued" || run.status === "running";
      if (!includeRemoved && !existsOnDisk && !active) continue;

      entries.push({
        runId: run.id,
        taskId: run.taskId,
        taskTitle: run.taskTitle,
        project: run.project,
        agentName: run.agentName,
        repoPath: run.repoPath,
        worktreePath: run.worktreePath,
        branchName: run.branchName,
        runStatus: run.status,
        existsOnDisk,
        cleanable: existsOnDisk && isManaged && !active,
        createdAt: run.createdAt,
      });
    }
    return entries;
  }

  async cleanupWorktrees(runId?: string): Promise<CleanupWorktreesResult> {
    const rows = (
      runId
        ? this.db
            .prepare("SELECT * FROM opc_agent_runs WHERE id = ? AND worktree_path IS NOT NULL")
            .all(runId)
        : this.db
            .prepare("SELECT * FROM opc_agent_runs WHERE worktree_path IS NOT NULL ORDER BY created_at ASC")
            .all()
    ) as Array<Record<string, unknown>>;

    const cleaned: CleanupWorktreesResult["cleaned"] = [];
    const skipped: CleanupWorktreesResult["skipped"] = [];
    const reposToPrune = new Set<string>();

    for (const row of rows) {
      const run = rowToRun(row);
      if (!run.worktreePath) continue;

      if (run.status === "queued" || run.status === "running") {
        skipped.push({ runId: run.id, worktreePath: run.worktreePath, reason: "任务仍在运行或排队中" });
        continue;
      }

      if (!isPathWithin(this.worktreeBase, run.worktreePath)) {
        skipped.push({ runId: run.id, worktreePath: run.worktreePath, reason: "目录不在暗工厂受管 Worktree 根目录内" });
        continue;
      }

      const existed = existsSync(run.worktreePath);
      if (run.repoPath && existsSync(run.repoPath)) {
        try {
          await execGit(run.repoPath, ["worktree", "remove", "--force", run.worktreePath], 15_000);
          reposToPrune.add(run.repoPath);
        } catch {
          reposToPrune.add(run.repoPath);
        }
      }

      if (existsSync(run.worktreePath)) {
        rmSync(run.worktreePath, { recursive: true, force: true });
      }

      if (existed) {
        cleaned.push({ runId: run.id, worktreePath: run.worktreePath, branchName: run.branchName });
      }
    }

    const prunedRepos: string[] = [];
    for (const repo of reposToPrune) {
      try {
        if (await isGitRepository(repo)) {
          await execGit(repo, ["worktree", "prune"], 15_000);
          prunedRepos.push(repo);
        }
      } catch {
        // ignore prune errors on deleted temp repos
      }
    }

    return { cleaned, skipped, prunedRepos };
  }

  // ---- Fractal CI/CD Self-Bootstrap Audit ----

  listAudits(limit = 20): FactoryAuditRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare("SELECT * FROM opc_factory_audits ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map(rowToAudit);
  }

  async runSelfBootstrapAudit(repoRoot?: string): Promise<FactoryAuditRecord> {
    const targetRoot = resolve(repoRoot || this.defaultRepoRoot);
    const protectedPaths = this.providers.get().system.protectedPaths;
    const isGitRepo = await isGitRepository(targetRoot);

    let changedFiles: string[] = [];
    let violations: string[] = [];

    if (isGitRepo) {
      const changes = await collectGitChanges(targetRoot, null);
      changedFiles = changes.changedFiles;
      violations = matchProtectedPaths(changedFiles, protectedPaths);
    }

    const recentRow = this.db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM opc_agent_runs WHERE circuit_breaker_reason = 'protected_path_violation'",
      )
      .get() as { cnt?: number } | undefined;
    const recentViolationsCount = Number(recentRow?.cnt ?? 0);

    let status: AuditStatus = "passed";
    let summary: string;

    if (!isGitRepo) {
      status = "warning";
      summary = `目录 ${targetRoot} 非 Git 仓库，已核验 ${protectedPaths.length} 条人类独占保护规则。`;
    } else if (violations.length > 0) {
      status = "blocked";
      summary = `拦截告警：当前工作区有 ${violations.length} 个改动触碰人类独占路径（${violations.join(", ")}），禁止自治 Agent 自动合并或建 PR。`;
    } else {
      status = "passed";
      summary = `自举安全审计通过：检查 ${changedFiles.length} 个工作区变更文件，未触碰 ${protectedPaths.length} 条人类独占保护路径。`;
    }

    const details: FactoryAuditDetails = {
      repoRoot: targetRoot,
      protectedPaths,
      changedFiles,
      violations,
      isGitRepo,
      recentViolationsCount,
    };

    const id = `aud_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO opc_factory_audits (id, kind, status, summary, details, created_at)
         VALUES (?, 'self_bootstrap_check', ?, ?, ?, ?)`,
      )
      .run(id, status, summary, JSON.stringify(details), ts);

    const row = this.db.prepare("SELECT * FROM opc_factory_audits WHERE id = ?").get(id) as Record<string, unknown>;
    return rowToAudit(row);
  }

  // ---- Metrics & Overview ----

  getMetrics(days = 30): FactoryMetrics {
    const safeDays = Math.max(1, Math.min(3650, Math.floor(days || 30)));
    const cutoffIso = new Date(Date.now() - safeDays * 86_400_000).toISOString();

    const rows = this.db
      .prepare("SELECT * FROM opc_agent_runs WHERE created_at >= ? ORDER BY created_at ASC")
      .all(cutoffIso) as Array<Record<string, unknown>>;

    let completedRuns = 0;
    let prOpenRuns = 0;
    let noOutputRuns = 0;
    let failedRuns = 0;
    let cancelledRuns = 0;
    let activeRuns = 0;
    let queuedRuns = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;

    const dayMap = new Map<string, FactoryDayMetric>();

    for (const raw of rows) {
      const run = rowToRun(raw);
      totalTokens += run.tokenUsed;
      totalCostUsd += run.costUsd;

      if (run.status === "completed") completedRuns += 1;
      else if (run.status === "pr_open") prOpenRuns += 1;
      else if (run.status === "no_output") noOutputRuns += 1;
      else if (run.status === "failed") failedRuns += 1;
      else if (run.status === "cancelled") cancelledRuns += 1;
      else if (run.status === "running") activeRuns += 1;
      else if (run.status === "queued") queuedRuns += 1;

      const day = run.createdAt.slice(0, 10);
      const dayEntry = dayMap.get(day) ?? {
        date: day,
        runs: 0,
        completedRuns: 0,
        failedRuns: 0,
        noOutputRuns: 0,
        tokenUsed: 0,
        costUsd: 0,
      };
      dayEntry.runs += 1;
      if (run.status === "completed" || run.status === "pr_open") dayEntry.completedRuns += 1;
      if (run.status === "failed") dayEntry.failedRuns += 1;
      if (run.status === "no_output") dayEntry.noOutputRuns += 1;
      dayEntry.tokenUsed += run.tokenUsed;
      dayEntry.costUsd = roundUsd(dayEntry.costUsd + run.costUsd);
      dayMap.set(day, dayEntry);
    }

    // Aggregate byProjectMonth across at least 365 days so commercial 3-month loss kill-switch has full history
    const monthCutoffIso = new Date(Date.now() - Math.max(safeDays, 365) * 86_400_000).toISOString();
    const monthRows = this.db
      .prepare(
        `SELECT
           COALESCE(NULLIF(project, ''), 'unassigned') AS project,
           substr(created_at, 1, 7) AS month,
           COUNT(*) AS runs,
           SUM(token_used) AS token_used,
           SUM(cost_usd) AS cost_usd
         FROM opc_agent_runs
         WHERE created_at >= ?
         GROUP BY COALESCE(NULLIF(project, ''), 'unassigned'), substr(created_at, 1, 7)
         ORDER BY month DESC, project ASC`,
      )
      .all(monthCutoffIso) as Array<Record<string, unknown>>;

    const byProjectMonth: FactoryProjectMonthMetric[] = monthRows.map((r) => ({
      project: String(r.project),
      month: String(r.month),
      runs: Number(r.runs ?? 0),
      tokenUsed: Number(r.token_used ?? 0),
      costUsd: roundUsd(Number(r.cost_usd ?? 0)),
    }));

    return {
      days: safeDays,
      totalRuns: rows.length,
      completedRuns,
      prOpenRuns,
      noOutputRuns,
      failedRuns,
      cancelledRuns,
      activeRuns,
      queuedRuns,
      totalTokens,
      totalCostUsd: roundUsd(totalCostUsd),
      byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byProjectMonth,
    };
  }

  getOverview(): DarkFactoryOverview {
    const cfg = this.providers.get();
    const activeRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM opc_agent_runs WHERE status = 'running'")
      .get() as { cnt?: number } | undefined;
    const queuedRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM opc_agent_runs WHERE status = 'queued'")
      .get() as { cnt?: number } | undefined;

    return {
      agents: this.listAgents(),
      presets: AGENT_PRESETS,
      runs: this.listRuns({ limit: 50 }),
      activeCount: Number(activeRow?.cnt ?? 0),
      queuedCount: Number(queuedRow?.cnt ?? 0),
      maxConcurrentAgents: cfg.system.maxConcurrentAgents,
      worktrees: this.listWorktrees(false),
      protectedPaths: cfg.system.protectedPaths,
      audits: this.listAudits(15),
      metrics: this.getMetrics(30),
    };
  }

  /** Helper for tests and graceful shutdown: awaits a run reaching a terminal state. */
  async waitForRun(runId: string, timeoutMs = 15_000): Promise<AgentRunRecord> {
    const current = this.getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(current.status)) {
      return current;
    }

    return new Promise<AgentRunRecord>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        unsub();
        rejectPromise(new Error(`Timed out waiting for run ${runId} (last status: ${this.getRun(runId).status})`));
      }, timeoutMs);

      const unsub = this.subscribeLogs(runId, (event) => {
        if (event.type === "done") {
          clearTimeout(timer);
          unsub();
          resolvePromise(event.run);
        }
      });

      // Re-check after subscribing to avoid race
      const recheck = this.getRun(runId);
      if (TERMINAL_RUN_STATUSES.has(recheck.status)) {
        clearTimeout(timer);
        unsub();
        resolvePromise(recheck);
      }
    });
  }

  /** Kills any active in-flight child processes cleanly (useful for shutdown/test teardown). */
  async dispose(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [runId, runtime] of [...this.activeRuns.entries()]) {
      promises.push(runtime.donePromise);
      this.killRun(runId);
    }
    await Promise.allSettled(promises);
  }
}

// ---- Hono HTTP Routes ----

function buildSseResponse(store: DarkFactoryStore, runId: string, signal: AbortSignal): Response {
  const initialLogs = store.getRunLogs(runId);
  const initialRun = store.getRun(runId);
  const encoder = new TextEncoder();

  const encodeEvent = (eventName: string, payload: unknown): Uint8Array =>
    encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      };

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup();
        }
      };

      safeEnqueue(encodeEvent("state", initialRun));

      let lastSeq = 0;
      for (const entry of initialLogs.logs) {
        lastSeq = Math.max(lastSeq, entry.seq);
        safeEnqueue(encodeEvent("log", entry));
      }

      if (TERMINAL_RUN_STATUSES.has(initialRun.status)) {
        safeEnqueue(encodeEvent("done", initialRun));
        cleanup();
        return;
      }

      unsubscribe = store.subscribeLogs(runId, (ev) => {
        if (closed) return;
        if (ev.type === "log") {
          if (ev.entry.seq <= lastSeq) return;
          lastSeq = ev.entry.seq;
          safeEnqueue(encodeEvent("log", ev.entry));
        } else if (ev.type === "state") {
          safeEnqueue(encodeEvent("state", ev.run));
        } else if (ev.type === "done") {
          safeEnqueue(encodeEvent("done", ev.run));
          cleanup();
        }
      });

      // Re-check in case run finished between initial getRun and subscribeLogs
      const latest = store.getRun(runId);
      if (TERMINAL_RUN_STATUSES.has(latest.status)) {
        safeEnqueue(encodeEvent("done", latest));
        cleanup();
        return;
      }

      keepalive = setInterval(() => {
        safeEnqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);
      keepalive.unref?.();

      if (signal.aborted) {
        cleanup();
      } else {
        signal.addEventListener("abort", cleanup, { once: true });
      }
    },
    cancel() {
      closed = true;
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export function registerDarkFactoryRoutes(
  app: Hono,
  db: DatabaseSync,
  providers: ProvidersStore,
  user: (c: Context) => unknown,
  options: RegisterDarkFactoryOptions = {},
): DarkFactoryStore {
  const store = options.store ?? new DarkFactoryStore(db, providers, options);
  const { permits } = submitAuth(options.submitToken);
  const base = "/api/opc/factory" as const;

  app.use(`${base}/*`, async (c, next) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(base, async (c, next) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get(`${base}/overview`, (c) => c.json(store.getOverview()));
  app.get(`${base}/metrics`, (c) => {
    const days = Number(c.req.query("days") ?? 30) || 30;
    return c.json(store.getMetrics(days));
  });

  // Agent Registry CRUD
  app.get(`${base}/agents`, (c) => c.json({ agents: store.listAgents(), presets: AGENT_PRESETS }));
  app.post(`${base}/agents`, async (c) => c.json(store.createAgent(await c.req.json()), 201));
  app.patch(`${base}/agents/:id`, async (c) => c.json(store.updateAgent(c.req.param("id"), await c.req.json())));
  app.delete(`${base}/agents/:id`, (c) => c.json(store.deleteAgent(c.req.param("id"))));

  // Dispatch & Runs
  app.post(`${base}/dispatch`, async (c) => c.json(store.dispatch(await c.req.json()), 201));
  app.get(`${base}/runs`, (c) => {
    const limit = Number(c.req.query("limit") ?? 50) || 50;
    const status = c.req.query("status") || undefined;
    const project = c.req.query("project") || undefined;
    return c.json({ runs: store.listRuns({ limit, status, project }) });
  });
  app.get(`${base}/runs/:id`, (c) => c.json(store.getRun(c.req.param("id"))));
  app.get(`${base}/runs/:id/logs`, (c) => c.json(store.getRunLogs(c.req.param("id"))));
  app.get(`${base}/runs/:id/stream`, (c) => buildSseResponse(store, c.req.param("id"), c.req.raw.signal));

  app.post(`${base}/runs/:id/kill`, (c) => c.json(store.killRun(c.req.param("id"))));
  app.post(`${base}/runs/:id/retry`, (c) => c.json(store.retryRun(c.req.param("id")), 201));
  app.post(`${base}/runs/:id/pr`, async (c) => {
    let body: unknown = undefined;
    try {
      const text = await c.req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
    }
    return c.json(await store.createPrForRun(c.req.param("id"), body));
  });

  // Worktrees & Bootstrap Protection Audit
  app.get(`${base}/worktrees`, (c) => {
    const includeRemoved = c.req.query("all") === "1";
    return c.json({ worktrees: store.listWorktrees(includeRemoved) });
  });
  app.post(`${base}/worktrees/cleanup`, async (c) => {
    let body: unknown = undefined;
    try {
      const text = await c.req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
    }
    const parsed = cleanupWorktreesSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "cleanup_input", parsed.error.issues.map((i) => i.message).join(" / "));
    }
    return c.json(await store.cleanupWorktrees(parsed.data?.runId));
  });
  app.post(`${base}/bootstrap-audit`, async (c) => {
    let body: unknown = undefined;
    try {
      const text = await c.req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
    }
    const parsed = bootstrapAuditSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "audit_input", parsed.error.issues.map((i) => i.message).join(" / "));
    }
    return c.json(await store.runSelfBootstrapAudit(parsed.data?.repoRoot), 201);
  });

  return store;
}
