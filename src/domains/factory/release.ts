import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { DomainEventBus } from "../../kernel/events.ts";
import { buildSandboxEnv, type DarkFactoryStore } from "../../server/dark-factory.ts";
import { ApiError } from "../../server/logic.ts";

const execFileAsync = promisify(execFile);
const MAX_STEP_OUTPUT_CHARS = 256 * 1024;
const DEFAULT_STEP_TIMEOUT_MS = 300_000;

export type ReleaseMode = "merge_only" | "merge_and_deploy";

export type ReleaseStatus =
  | "pending_approval"
  | "running"
  | "succeeded"
  | "rolled_back"
  | "failed"
  | "rejected";

export type ReleaseStepName =
  | "preflight"
  | "merge"
  | "verify"
  | "build"
  | "deploy"
  | "health_probe"
  | "rollback";

export type ReleaseStepStatus = "passed" | "failed" | "skipped";

export interface ReleaseStepRecord {
  step: ReleaseStepName;
  status: ReleaseStepStatus;
  commandOrUrl: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  at: string;
}

export interface ReleaseRecord {
  id: string;
  runId: string | null;
  taskId: string | null;
  assetId: string | null;
  mainlineId: string | null;
  project: string;
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  previousHeadSha: string | null;
  releaseSha: string | null;
  verifyCommand: string;
  buildCommand: string;
  deployCommand: string;
  rollbackCommand: string;
  healthUrl: string;
  mode: ReleaseMode;
  status: ReleaseStatus;
  steps: ReleaseStepRecord[];
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateReleaseInput {
  id?: string;
  runId?: string | null;
  taskId?: string | null;
  assetId?: string | null;
  mainlineId?: string | null;
  project: string;
  repoPath: string;
  sourceBranch: string;
  targetBranch?: string;
  verifyCommand?: string;
  buildCommand?: string;
  deployCommand?: string;
  rollbackCommand?: string;
  healthUrl?: string;
  mode?: ReleaseMode;
  status?: ReleaseStatus;
}

export interface ReleasePipelineOptions {
  events?: DomainEventBus;
  darkFactory?: DarkFactoryStore;
  stepTimeoutMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function assertValidBranchName(branch: string, fieldName = "branch"): string {
  if (typeof branch !== "string" || !branch || branch.length > 200) {
    throw new ApiError(400, "invalid_branch", `非法的 Git 分支名称 (${fieldName})：长度必须在 1~200 个字符之间`);
  }
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.startsWith(".") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch === "@" ||
    /[\x00-\x1f\x7f\s~^:?*[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.includes("/.") ||
    branch.includes(".lock/")
  ) {
    throw new ApiError(400, "invalid_branch", `非法的 Git 分支名称 (${fieldName})：${branch}`);
  }
  return branch;
}

export function assertValidHealthUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(400, "invalid_health_url", `健康探针 URL 格式无效：${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(400, "invalid_health_url", `健康探针 URL 仅允许 http: 或 https: 协议（收到 ${parsed.protocol}）`);
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, "invalid_health_url", "健康探针 URL 禁止内嵌用户名或密码凭据");
  }
  return parsed;
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function appendBounded(current: string, chunk: string, maxChars = MAX_STEP_OUTPUT_CHARS): string {
  if (current.length >= maxChars) return current;
  const remaining = maxChars - current.length;
  return chunk.length <= remaining ? current + chunk : current + chunk.slice(0, remaining);
}

function forceKillChild(child: ChildProcess): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // fall through
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
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

async function execGitDetailed(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    const stdout = typeof e.stdout === "string" ? e.stdout.trim() : "";
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : (e.message ?? String(err));
    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
  }
}

async function runShellStep(
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; output: string; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      resolvePromise({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output: out,
        durationMs: Date.now() - started,
      });
    };

    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-lc", command], {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolvePromise({
        exitCode: 127,
        stdout: "",
        stderr: msg,
        output: msg,
        durationMs: Date.now() - started,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      forceKillChild(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      stderr = appendBounded(stderr, `\n${err.message}`);
      finish(127);
    });

    child.on("close", (code) => {
      if (timedOut) {
        stderr = appendBounded(stderr, `\nstep timed out after ${timeoutMs}ms`);
        finish(124);
        return;
      }
      finish(typeof code === "number" ? code : 1);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function rowToRelease(row: Record<string, unknown>): ReleaseRecord {
  return {
    id: String(row.id),
    runId: row.run_id == null ? null : String(row.run_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    assetId: row.asset_id == null ? null : String(row.asset_id),
    mainlineId: row.mainline_id == null ? null : String(row.mainline_id),
    project: String(row.project ?? ""),
    repoPath: String(row.repo_path ?? ""),
    sourceBranch: String(row.source_branch ?? ""),
    targetBranch: String(row.target_branch || "main"),
    previousHeadSha: row.previous_head_sha == null ? null : String(row.previous_head_sha),
    releaseSha: row.release_sha == null ? null : String(row.release_sha),
    verifyCommand: String(row.verify_command ?? ""),
    buildCommand: String(row.build_command ?? ""),
    deployCommand: String(row.deploy_command ?? ""),
    rollbackCommand: String(row.rollback_command ?? ""),
    healthUrl: String(row.health_url ?? ""),
    mode: (row.mode === "merge_only" ? "merge_only" : "merge_and_deploy") as ReleaseMode,
    status: String(row.status ?? "pending_approval") as ReleaseStatus,
    steps: safeJson<ReleaseStepRecord[]>(row.steps_json, []),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

export class ReleasePipeline {
  private events?: DomainEventBus;
  private darkFactory?: DarkFactoryStore;
  private stepTimeoutMs: number;
  private activeExecutions = new Set<string>();
  private activeRepoPaths = new Set<string>();

  constructor(
    private db: DatabaseSync,
    options: ReleasePipelineOptions = {},
  ) {
    this.events = options.events;
    this.darkFactory = options.darkFactory;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_releases (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        asset_id TEXT,
        mainline_id TEXT,
        project TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL DEFAULT 'main',
        previous_head_sha TEXT,
        release_sha TEXT,
        verify_command TEXT NOT NULL DEFAULT '',
        build_command TEXT NOT NULL DEFAULT '',
        deploy_command TEXT NOT NULL DEFAULT '',
        rollback_command TEXT NOT NULL DEFAULT '',
        health_url TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'merge_and_deploy',
        status TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_opc_releases_status ON opc_releases(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opc_releases_project ON opc_releases(project, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opc_releases_run ON opc_releases(run_id);
    `);
  }

  setDependencies(deps: { events?: DomainEventBus; darkFactory?: DarkFactoryStore }) {
    if (deps.events) this.events = deps.events;
    if (deps.darkFactory) this.darkFactory = deps.darkFactory;
  }

  createRelease(input: CreateReleaseInput): ReleaseRecord {
    const project = input.project.trim();
    const repoPathRaw = input.repoPath.trim();
    const sourceBranchRaw = input.sourceBranch.trim();
    if (!repoPathRaw) {
      throw new ApiError(400, "bad_release", "repoPath 不能为空");
    }
    if (!sourceBranchRaw) {
      throw new ApiError(400, "bad_release", "sourceBranch 不能为空");
    }

    const sourceBranch = assertValidBranchName(sourceBranchRaw, "sourceBranch");
    const targetBranch = assertValidBranchName((input.targetBranch ?? "").trim() || "main", "targetBranch");
    const healthUrl = (input.healthUrl ?? "").trim();
    if (healthUrl) {
      assertValidHealthUrl(healthUrl);
    }

    const id = input.id?.trim() || `rel_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
    const repoPath = resolve(repoPathRaw);
    const mode: ReleaseMode = input.mode === "merge_only" ? "merge_only" : "merge_and_deploy";
    const status: ReleaseStatus = input.status ?? "pending_approval";
    const createdAt = nowIso();

    this.db
      .prepare(
        `INSERT INTO opc_releases (
          id, run_id, task_id, asset_id, mainline_id, project, repo_path,
          source_branch, target_branch, previous_head_sha, release_sha,
          verify_command, build_command, deploy_command, rollback_command,
          health_url, mode, status, steps_json, error_message, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, NULL)`,
      )
      .run(
        id,
        input.runId ?? null,
        input.taskId ?? null,
        input.assetId ?? null,
        input.mainlineId ?? null,
        project,
        repoPath,
        sourceBranch,
        targetBranch,
        (input.verifyCommand ?? "").trim(),
        (input.buildCommand ?? "").trim(),
        (input.deployCommand ?? "").trim(),
        (input.rollbackCommand ?? "").trim(),
        healthUrl,
        mode,
        status,
        createdAt,
      );

    return this.requireRelease(id);
  }

  getRelease(id: string): ReleaseRecord | null {
    const row = this.db.prepare("SELECT * FROM opc_releases WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRelease(row) : null;
  }

  requireRelease(id: string): ReleaseRecord {
    const rec = this.getRelease(id);
    if (!rec) {
      throw new ApiError(404, "release_not_found", `未找到发布记录：${id}`);
    }
    return rec;
  }

  listReleases(filter: {
    status?: string;
    project?: string;
    runId?: string;
    limit?: number;
  } = {}): ReleaseRecord[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];

    if (filter.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter.project) {
      clauses.push("project = ?");
      args.push(filter.project);
    }
    if (filter.runId) {
      clauses.push("run_id = ?");
      args.push(filter.runId);
    }

    const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM opc_releases ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToRelease);
  }

  counts(): {
    total: number;
    pendingApproval: number;
    running: number;
    succeeded: number;
    rolledBack: number;
    failed: number;
    rejected: number;
  } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS cnt FROM opc_releases GROUP BY status")
      .all() as Array<{ status?: string; cnt?: number }>;
    const map = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      const n = Number(r.cnt ?? 0);
      total += n;
      if (r.status) map.set(String(r.status), n);
    }
    return {
      total,
      pendingApproval: map.get("pending_approval") ?? 0,
      running: map.get("running") ?? 0,
      succeeded: map.get("succeeded") ?? 0,
      rolledBack: map.get("rolled_back") ?? 0,
      failed: map.get("failed") ?? 0,
      rejected: map.get("rejected") ?? 0,
    };
  }

  rejectRelease(releaseId: string, reason = "创始人驳回发布申请"): ReleaseRecord {
    const rel = this.requireRelease(releaseId);
    if (rel.status === "running") {
      throw new ApiError(409, "release_running", "该发布流水线正在执行中，无法直接标记驳回");
    }
    if (rel.status === "succeeded") {
      throw new ApiError(409, "release_already_succeeded", "该发布单已成功上线，若需撤销请执行回滚");
    }
    const ts = nowIso();
    this.db
      .prepare("UPDATE opc_releases SET status = 'rejected', error_message = ?, completed_at = ? WHERE id = ?")
      .run(reason, ts, releaseId);
    return this.requireRelease(releaseId);
  }

  /**
   * Executes the full real release pipeline:
   * preflight -> merge -> verify -> build -> deploy -> health_probe (with automatic git reset & rollbackCommand on failure).
   */
  async executeRelease(
    releaseId: string,
    options: { mode?: ReleaseMode } = {},
  ): Promise<ReleaseRecord> {
    const initial = this.requireRelease(releaseId);
    if (this.activeExecutions.has(releaseId) || initial.status === "running") {
      throw new ApiError(409, "release_running", `发布单 ${releaseId} 正在执行中`);
    }
    if (initial.status === "rejected") {
      throw new ApiError(409, "release_rejected", "该发布单已被驳回，禁止执行");
    }
    if (initial.status === "succeeded") {
      return initial;
    }

    const mode: ReleaseMode = options.mode ?? initial.mode;
    const validatedSourceBranch = assertValidBranchName(initial.sourceBranch.trim(), "sourceBranch");
    let targetBranch = assertValidBranchName((initial.targetBranch || "main").trim(), "targetBranch");
    if (mode === "merge_and_deploy" && initial.healthUrl) {
      assertValidHealthUrl(initial.healthUrl);
    }

    const normalizedRepoPath = resolve(initial.repoPath);
    if (this.activeRepoPaths.has(normalizedRepoPath)) {
      throw new ApiError(
        409,
        "repo_release_busy",
        `目标仓库 ${normalizedRepoPath} 当前已有其他发布或回滚任务正在执行中`,
      );
    }

    const steps: ReleaseStepRecord[] = [];
    this.activeExecutions.add(releaseId);
    this.activeRepoPaths.add(normalizedRepoPath);

    this.db
      .prepare(
        "UPDATE opc_releases SET mode = ?, status = 'running', steps_json = '[]', error_message = NULL, completed_at = NULL WHERE id = ?",
      )
      .run(mode, releaseId);

    const persistProgress = () => {
      this.db
        .prepare("UPDATE opc_releases SET steps_json = ? WHERE id = ?")
        .run(JSON.stringify(steps), releaseId);
    };

    const markFailedWithoutRollback = (errorMessage: string): ReleaseRecord => {
      const ts = nowIso();
      this.db
        .prepare(
          "UPDATE opc_releases SET status = 'failed', steps_json = ?, error_message = ?, completed_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(steps), errorMessage, ts, releaseId);
      return this.requireRelease(releaseId);
    };

    const buildExecEnv = (previousHeadSha: string | null, releaseSha: string | null) =>
      buildSandboxEnv({
        taskId: initial.taskId ?? releaseId,
        runId: initial.runId ?? releaseId,
        worktreePath: normalizedRepoPath,
        branchName: targetBranch,
        explicitEnv: {
          OPC_RELEASE_ID: releaseId,
          OPC_PROJECT: initial.project,
          OPC_SOURCE_BRANCH: validatedSourceBranch,
          OPC_TARGET_BRANCH: targetBranch,
          ...(previousHeadSha ? { OPC_PREVIOUS_SHA: previousHeadSha } : {}),
          ...(releaseSha ? { OPC_RELEASE_SHA: releaseSha } : {}),
        },
      });

    try {
      const repoPath = normalizedRepoPath;
      let previousHeadSha: string | null = null;
      let releaseSha: string | null = null;

      // ---- 1. preflight ----
      const preflightStart = Date.now();
      if (!existsSync(repoPath)) {
        steps.push({
          step: "preflight",
          status: "failed",
          commandOrUrl: `git -C ${repoPath} rev-parse --is-inside-work-tree`,
          exitCode: 1,
          output: `目标仓库目录不存在：${repoPath}`,
          durationMs: Date.now() - preflightStart,
          at: nowIso(),
        });
        return markFailedWithoutRollback(`预检失败：目标仓库目录不存在 (${repoPath})`);
      }

      const insideRes = await execGitDetailed(repoPath, ["rev-parse", "--is-inside-work-tree"], 5_000);
      if (!insideRes.ok || insideRes.stdout !== "true") {
        steps.push({
          step: "preflight",
          status: "failed",
          commandOrUrl: "git rev-parse --is-inside-work-tree",
          exitCode: insideRes.exitCode || 1,
          output: insideRes.stderr || insideRes.stdout || `路径 ${repoPath} 不是有效的 Git 仓库`,
          durationMs: Date.now() - preflightStart,
          at: nowIso(),
        });
        return markFailedWithoutRollback(`预检失败：${repoPath} 不是有效的 Git 仓库`);
      }

      const dirtyTracked = await execGitDetailed(
        repoPath,
        ["status", "--porcelain", "--untracked-files=no"],
        10_000,
      );
      if (!dirtyTracked.ok || dirtyTracked.stdout.length > 0) {
        steps.push({
          step: "preflight",
          status: "failed",
          commandOrUrl: "git status --porcelain --untracked-files=no",
          exitCode: dirtyTracked.exitCode || 1,
          output: dirtyTracked.stdout || dirtyTracked.stderr || "目标仓库存在未提交的跟踪文件修改",
          durationMs: Date.now() - preflightStart,
          at: nowIso(),
        });
        return markFailedWithoutRollback("预检失败：目标仓库工作区存在未提交的跟踪文件改动，拒绝合入");
      }

      let currentBranch = "";
      try {
        currentBranch = await execGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], 5_000);
      } catch {
        currentBranch = "";
      }

      if (currentBranch !== targetBranch) {
        const targetRefCheck = await execGitDetailed(
          repoPath,
          ["show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`],
          5_000,
        );
        if (targetRefCheck.ok) {
          const checkoutRes = await execGitDetailed(repoPath, ["checkout", targetBranch, "--"], 15_000);
          if (!checkoutRes.ok) {
            steps.push({
              step: "preflight",
              status: "failed",
              commandOrUrl: `git checkout ${targetBranch}`,
              exitCode: checkoutRes.exitCode,
              output: checkoutRes.stderr || checkoutRes.stdout,
              durationMs: Date.now() - preflightStart,
              at: nowIso(),
            });
            return markFailedWithoutRollback(`预检失败：无法切换到目标分支 ${targetBranch}（${checkoutRes.stderr}）`);
          }
          currentBranch = targetBranch;
        } else if (
          targetBranch === "main" &&
          currentBranch &&
          currentBranch !== "HEAD" &&
          currentBranch !== validatedSourceBranch
        ) {
          // Adapt default targetBranch ('main') when repo uses 'master' or another active trunk branch
          targetBranch = assertValidBranchName(currentBranch, "targetBranch");
          this.db
            .prepare("UPDATE opc_releases SET target_branch = ? WHERE id = ?")
            .run(targetBranch, releaseId);
        } else {
          steps.push({
            step: "preflight",
            status: "failed",
            commandOrUrl: `git checkout ${targetBranch}`,
            exitCode: 1,
            output: `目标分支 ${targetBranch} 不存在（当前分支：${currentBranch || "detached"}）`,
            durationMs: Date.now() - preflightStart,
            at: nowIso(),
          });
          return markFailedWithoutRollback(`预检失败：目标分支 ${targetBranch} 不存在`);
        }
      }

      const headRes = await execGitDetailed(repoPath, ["rev-parse", "HEAD"], 5_000);
      if (!headRes.ok || !headRes.stdout) {
        steps.push({
          step: "preflight",
          status: "failed",
          commandOrUrl: "git rev-parse HEAD",
          exitCode: headRes.exitCode || 1,
          output: headRes.stderr || "无法读取当前 HEAD SHA",
          durationMs: Date.now() - preflightStart,
          at: nowIso(),
        });
        return markFailedWithoutRollback("预检失败：无法读取目标分支 HEAD 提交 SHA");
      }

      previousHeadSha = headRes.stdout;
      releaseSha = previousHeadSha;
      this.db
        .prepare("UPDATE opc_releases SET previous_head_sha = ?, target_branch = ? WHERE id = ?")
        .run(previousHeadSha, targetBranch, releaseId);

      steps.push({
        step: "preflight",
        status: "passed",
        commandOrUrl: "git status --porcelain --untracked-files=no && git rev-parse HEAD",
        exitCode: 0,
        output: `targetBranch=${targetBranch} previousHeadSha=${previousHeadSha}`,
        durationMs: Date.now() - preflightStart,
        at: nowIso(),
      });
      persistProgress();

      // ---- 2. merge ----
      const mergeStart = Date.now();
      const sourceBranch = validatedSourceBranch;

      if (initial.runId && this.darkFactory) {
        try {
          const linkedRun = this.darkFactory.getRun(initial.runId);
          if (linkedRun.worktreePath && linkedRun.branchName && existsSync(linkedRun.worktreePath)) {
            await this.darkFactory.commitWorktreeChanges(initial.runId);
          }
        } catch (err) {
          if (err instanceof ApiError && err.code === "protected_path_violation") {
            steps.push({
              step: "merge",
              status: "failed",
              commandOrUrl: `commitWorktreeChanges(${initial.runId})`,
              exitCode: 1,
              output: err.message,
              durationMs: Date.now() - mergeStart,
              at: nowIso(),
            });
            return markFailedWithoutRollback(err.message);
          }
          // If worktree was already cleaned up, continue and merge existing sourceBranch ref
        }
      }

      if (!sourceBranch || sourceBranch === targetBranch) {
        steps.push({
          step: "merge",
          status: "skipped",
          commandOrUrl: sourceBranch || targetBranch,
          exitCode: null,
          output: `源分支与目标分支一致 (${targetBranch})，跳过合并`,
          durationMs: Date.now() - mergeStart,
          at: nowIso(),
        });
        this.db.prepare("UPDATE opc_releases SET release_sha = ? WHERE id = ?").run(releaseSha, releaseId);
        persistProgress();
      } else {
        const localSourceCheck = await execGitDetailed(
          repoPath,
          ["show-ref", "--verify", "--quiet", `refs/heads/${sourceBranch}`],
          5_000,
        );
        const sourceRef = localSourceCheck.ok ? `refs/heads/${sourceBranch}` : sourceBranch;
        const sourceShaRes = await execGitDetailed(
          repoPath,
          ["rev-parse", "--verify", `${sourceRef}^{commit}`],
          5_000,
        );
        if (!sourceShaRes.ok || !sourceShaRes.stdout) {
          steps.push({
            step: "merge",
            status: "failed",
            commandOrUrl: `git rev-parse --verify ${sourceRef}^{commit}`,
            exitCode: sourceShaRes.exitCode || 1,
            output: sourceShaRes.stderr || `源分支 ${sourceBranch} 不存在`,
            durationMs: Date.now() - mergeStart,
            at: nowIso(),
          });
          return markFailedWithoutRollback(`合并失败：找不到源分支 ${sourceBranch}`);
        }

        if (sourceShaRes.stdout === previousHeadSha) {
          steps.push({
            step: "merge",
            status: "skipped",
            commandOrUrl: `git merge --no-edit ${sourceRef}`,
            exitCode: 0,
            output: `源分支 ${sourceBranch} 与当前 HEAD (${previousHeadSha}) 相同，无需合并`,
            durationMs: Date.now() - mergeStart,
            at: nowIso(),
          });
          this.db.prepare("UPDATE opc_releases SET release_sha = ? WHERE id = ?").run(releaseSha, releaseId);
          persistProgress();
        } else {
          const mergeRes = await execGitDetailed(
            repoPath,
            [
              "-c",
              "user.name=OPC Release Pipeline",
              "-c",
              "user.email=release@opc.local",
              "merge",
              "--no-edit",
              sourceRef,
            ],
            60_000,
          );
          if (!mergeRes.ok) {
            await execGitDetailed(repoPath, ["merge", "--abort"], 10_000);
            await execGitDetailed(repoPath, ["reset", "--hard", previousHeadSha], 10_000);
            const mergeErr = [mergeRes.stdout, mergeRes.stderr].filter(Boolean).join("\n");
            steps.push({
              step: "merge",
              status: "failed",
              commandOrUrl: `git merge --no-edit ${sourceRef}`,
              exitCode: mergeRes.exitCode,
              output: mergeErr,
              durationMs: Date.now() - mergeStart,
              at: nowIso(),
            });
            return markFailedWithoutRollback(`Git 合并冲突或失败：${mergeErr || sourceBranch}`);
          }

          releaseSha = await execGit(repoPath, ["rev-parse", "HEAD"], 5_000);
          this.db.prepare("UPDATE opc_releases SET release_sha = ? WHERE id = ?").run(releaseSha, releaseId);

          steps.push({
            step: "merge",
            status: "passed",
            commandOrUrl: `git merge --no-edit ${sourceRef}`,
            exitCode: 0,
            output: [mergeRes.stdout, `releaseSha=${releaseSha}`].filter(Boolean).join("\n"),
            durationMs: Date.now() - mergeStart,
            at: nowIso(),
          });
          persistProgress();
        }
      }

      const triggerAutoRollback = async (failedStep: ReleaseStepName, failureMessage: string): Promise<ReleaseRecord> => {
        const rbStart = Date.now();
        const rbCommands: string[] = [];
        const rbOutputs: string[] = [];
        let rbExitCode: number | null = 0;
        let rbFailed = false;

        if (previousHeadSha && releaseSha && releaseSha !== previousHeadSha) {
          rbCommands.push(`git reset --hard ${previousHeadSha}`);
          const resetRes = await execGitDetailed(repoPath, ["reset", "--hard", previousHeadSha], 30_000);
          if (resetRes.ok) {
            rbOutputs.push(`已将 ${targetBranch} 回滚至合并前提交 ${previousHeadSha}`);
          } else {
            rbFailed = true;
            rbExitCode = resetRes.exitCode;
            rbOutputs.push(`git reset --hard 失败：${resetRes.stderr || resetRes.stdout}`);
          }
        }

        if (initial.rollbackCommand) {
          rbCommands.push(initial.rollbackCommand);
          const rbEnv = buildExecEnv(previousHeadSha, releaseSha);
          const cmdRes = await runShellStep(repoPath, initial.rollbackCommand, rbEnv, this.stepTimeoutMs);
          rbExitCode = cmdRes.exitCode;
          if (cmdRes.output) rbOutputs.push(cmdRes.output);
          if (cmdRes.exitCode !== 0) {
            rbFailed = true;
          }
        }

        steps.push({
          step: "rollback",
          status: rbFailed ? "failed" : "passed",
          commandOrUrl: rbCommands.join(" && ") || `git reset --hard ${previousHeadSha ?? "HEAD"}`,
          exitCode: rbExitCode,
          output: rbOutputs.join("\n") || `已保持在合并前提交 ${previousHeadSha}`,
          durationMs: Date.now() - rbStart,
          at: nowIso(),
        });

        const ts = nowIso();
        const finalStatus: ReleaseStatus = rbFailed ? "failed" : "rolled_back";
        this.db
          .prepare(
            "UPDATE opc_releases SET status = ?, steps_json = ?, error_message = ?, completed_at = ? WHERE id = ?",
          )
          .run(finalStatus, JSON.stringify(steps), failureMessage, ts, releaseId);

        const updated = this.requireRelease(releaseId);
        this.events?.emit({
          topic: "factory.release_rolled_back",
          sourceDomain: "factory",
          mainlineId: updated.mainlineId,
          assetId: updated.assetId,
          payload: {
            releaseId: updated.id,
            runId: updated.runId,
            taskId: updated.taskId,
            project: updated.project,
            failedStep,
            previousHeadSha: updated.previousHeadSha,
            releaseSha: updated.releaseSha,
            status: updated.status,
            errorMessage: updated.errorMessage,
          },
        });
        return updated;
      };

      const env = buildExecEnv(previousHeadSha, releaseSha);

      // ---- 3. verify ----
      if (initial.verifyCommand) {
        const verifyRes = await runShellStep(repoPath, initial.verifyCommand, env, this.stepTimeoutMs);
        steps.push({
          step: "verify",
          status: verifyRes.exitCode === 0 ? "passed" : "failed",
          commandOrUrl: initial.verifyCommand,
          exitCode: verifyRes.exitCode,
          output: verifyRes.output,
          durationMs: verifyRes.durationMs,
          at: nowIso(),
        });
        persistProgress();

        if (verifyRes.exitCode !== 0) {
          return await triggerAutoRollback(
            "verify",
            `合并后确定性校验未通过 (exit ${verifyRes.exitCode})`,
          );
        }
      } else {
        steps.push({
          step: "verify",
          status: "skipped",
          commandOrUrl: "",
          exitCode: null,
          output: "未配置 verify_command，跳过校验",
          durationMs: 0,
          at: nowIso(),
        });
        persistProgress();
      }

      // ---- 4. build ----
      if (mode === "merge_and_deploy" && initial.buildCommand) {
        const buildRes = await runShellStep(repoPath, initial.buildCommand, env, this.stepTimeoutMs);
        steps.push({
          step: "build",
          status: buildRes.exitCode === 0 ? "passed" : "failed",
          commandOrUrl: initial.buildCommand,
          exitCode: buildRes.exitCode,
          output: buildRes.output,
          durationMs: buildRes.durationMs,
          at: nowIso(),
        });
        persistProgress();

        if (buildRes.exitCode !== 0) {
          return await triggerAutoRollback("build", `构建阶段失败 (exit ${buildRes.exitCode})`);
        }
      } else {
        steps.push({
          step: "build",
          status: "skipped",
          commandOrUrl: initial.buildCommand,
          exitCode: null,
          output: mode !== "merge_and_deploy" ? "merge_only 模式跳过构建" : "未配置 build_command，跳过构建",
          durationMs: 0,
          at: nowIso(),
        });
        persistProgress();
      }

      // ---- 5. deploy ----
      if (mode === "merge_and_deploy" && initial.deployCommand) {
        const deployRes = await runShellStep(repoPath, initial.deployCommand, env, this.stepTimeoutMs);
        steps.push({
          step: "deploy",
          status: deployRes.exitCode === 0 ? "passed" : "failed",
          commandOrUrl: initial.deployCommand,
          exitCode: deployRes.exitCode,
          output: deployRes.output,
          durationMs: deployRes.durationMs,
          at: nowIso(),
        });
        persistProgress();

        if (deployRes.exitCode !== 0) {
          return await triggerAutoRollback("deploy", `部署阶段失败 (exit ${deployRes.exitCode})`);
        }
      } else {
        steps.push({
          step: "deploy",
          status: "skipped",
          commandOrUrl: initial.deployCommand,
          exitCode: null,
          output: mode !== "merge_and_deploy" ? "merge_only 模式跳过部署" : "未配置 deploy_command，跳过部署",
          durationMs: 0,
          at: nowIso(),
        });
        persistProgress();
      }

      // ---- 6. health_probe ----
      if (mode === "merge_and_deploy" && initial.healthUrl) {
        const parsedHealthUrl = assertValidHealthUrl(initial.healthUrl);
        const probeStart = Date.now();
        let probePassed = false;
        let lastStatusCode: number | null = null;
        let probeOutput = "";
        const maxRetries = 3; // initial attempt + up to 3 retries, 400ms apart

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            await sleep(400);
          }
          try {
            const res = await fetch(parsedHealthUrl.toString(), {
              redirect: "error",
              signal: AbortSignal.timeout(5_000),
            });
            lastStatusCode = res.status;
            const bodySnippet = (await res.text().catch(() => "")).trim().slice(0, 500);
            if (res.ok) {
              probePassed = true;
              probeOutput = `HTTP ${res.status} OK (attempt ${attempt + 1}/${maxRetries + 1})${bodySnippet ? `: ${bodySnippet}` : ""}`;
              break;
            }
            probeOutput = `HTTP ${res.status} (attempt ${attempt + 1}/${maxRetries + 1})${bodySnippet ? `: ${bodySnippet}` : ""}`;
          } catch (err) {
            lastStatusCode = null;
            const msg = err instanceof Error ? err.message : String(err);
            probeOutput = `请求异常 (attempt ${attempt + 1}/${maxRetries + 1}): ${msg}`;
          }
        }

        steps.push({
          step: "health_probe",
          status: probePassed ? "passed" : "failed",
          commandOrUrl: initial.healthUrl,
          exitCode: lastStatusCode,
          output: probeOutput,
          durationMs: Date.now() - probeStart,
          at: nowIso(),
        });
        persistProgress();

        if (!probePassed) {
          return await triggerAutoRollback(
            "health_probe",
            `健康探针验收未通过 (${initial.healthUrl})：${probeOutput}`,
          );
        }
      } else {
        steps.push({
          step: "health_probe",
          status: "skipped",
          commandOrUrl: initial.healthUrl,
          exitCode: null,
          output:
            mode !== "merge_and_deploy" ? "merge_only 模式跳过健康探针" : "未配置 health_url，跳过健康探针",
          durationMs: 0,
          at: nowIso(),
        });
        persistProgress();
      }

      // ---- 7. Succeeded ----
      const completedAt = nowIso();
      this.db
        .prepare(
          "UPDATE opc_releases SET status = 'succeeded', steps_json = ?, error_message = NULL, completed_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(steps), completedAt, releaseId);

      const succeeded = this.requireRelease(releaseId);
      this.events?.emit({
        topic: "factory.release_completed",
        sourceDomain: "factory",
        mainlineId: succeeded.mainlineId,
        assetId: succeeded.assetId,
        payload: {
          releaseId: succeeded.id,
          runId: succeeded.runId,
          taskId: succeeded.taskId,
          project: succeeded.project,
          mode: succeeded.mode,
          sourceBranch: succeeded.sourceBranch,
          targetBranch: succeeded.targetBranch,
          previousHeadSha: succeeded.previousHeadSha,
          releaseSha: succeeded.releaseSha,
        },
      });
      return succeeded;
    } finally {
      this.activeExecutions.delete(releaseId);
      this.activeRepoPaths.delete(normalizedRepoPath);
    }
  }

  /**
   * Manual emergency rollback to previous_head_sha (plus rollbackCommand if configured).
   */
  async rollbackRelease(releaseId: string, reason = "人工触发紧急回滚"): Promise<ReleaseRecord> {
    const rel = this.requireRelease(releaseId);
    if (this.activeExecutions.has(releaseId) || rel.status === "running") {
      throw new ApiError(409, "release_running", "该发布单正在执行中，请等待当前步骤结束");
    }
    if (!rel.previousHeadSha || !/^[0-9a-f]{7,64}$/i.test(rel.previousHeadSha)) {
      throw new ApiError(400, "no_previous_sha", "该发布单未记录合法的合并前基准提交 (previous_head_sha)，无法执行回滚");
    }
    const normalizedRepoPath = resolve(rel.repoPath);
    if (!existsSync(normalizedRepoPath)) {
      throw new ApiError(400, "repo_missing", `目标仓库目录不存在：${normalizedRepoPath}`);
    }
    if (this.activeRepoPaths.has(normalizedRepoPath)) {
      throw new ApiError(
        409,
        "repo_release_busy",
        `目标仓库 ${normalizedRepoPath} 当前已有其他发布或回滚任务正在执行中`,
      );
    }
    const safeTargetBranch = rel.targetBranch ? assertValidBranchName(rel.targetBranch.trim(), "targetBranch") : "";

    this.activeExecutions.add(releaseId);
    this.activeRepoPaths.add(normalizedRepoPath);
    try {
      const rbStart = Date.now();
      const rbCommands: string[] = [`git reset --hard ${rel.previousHeadSha}`];
      const rbOutputs: string[] = [];
      let rbExitCode: number | null = 0;

      if (safeTargetBranch) {
        const targetRef = await execGitDetailed(
          normalizedRepoPath,
          ["show-ref", "--verify", "--quiet", `refs/heads/${safeTargetBranch}`],
          5_000,
        );
        if (targetRef.ok) {
          await execGitDetailed(normalizedRepoPath, ["checkout", safeTargetBranch, "--"], 15_000);
        }
      }

      const resetRes = await execGitDetailed(normalizedRepoPath, ["reset", "--hard", rel.previousHeadSha], 30_000);
      if (!resetRes.ok) {
        throw new ApiError(500, "git_rollback_failed", `Git 回滚失败：${resetRes.stderr || resetRes.stdout}`);
      }
      rbOutputs.push(`已将 ${safeTargetBranch || rel.targetBranch} 强制回滚至 ${rel.previousHeadSha}`);

      if (rel.rollbackCommand) {
        rbCommands.push(rel.rollbackCommand);
        const env = buildSandboxEnv({
          taskId: rel.taskId ?? rel.id,
          runId: rel.runId ?? rel.id,
          worktreePath: normalizedRepoPath,
          branchName: safeTargetBranch || rel.targetBranch,
          explicitEnv: {
            OPC_RELEASE_ID: rel.id,
            OPC_PROJECT: rel.project,
            OPC_PREVIOUS_SHA: rel.previousHeadSha,
            ...(rel.releaseSha ? { OPC_RELEASE_SHA: rel.releaseSha } : {}),
          },
        });
        const cmdRes = await runShellStep(normalizedRepoPath, rel.rollbackCommand, env, this.stepTimeoutMs);
        rbExitCode = cmdRes.exitCode;
        if (cmdRes.output) rbOutputs.push(cmdRes.output);
        if (cmdRes.exitCode !== 0) {
          const failStep: ReleaseStepRecord = {
            step: "rollback",
            status: "failed",
            commandOrUrl: rbCommands.join(" && "),
            exitCode: cmdRes.exitCode,
            output: rbOutputs.join("\n"),
            durationMs: Date.now() - rbStart,
            at: nowIso(),
          };
          const nextSteps = [...rel.steps, failStep];
          this.db
            .prepare("UPDATE opc_releases SET status = 'failed', steps_json = ?, error_message = ?, completed_at = ? WHERE id = ?")
            .run(JSON.stringify(nextSteps), `回滚脚本执行失败 (exit ${cmdRes.exitCode})`, nowIso(), rel.id);
          throw new ApiError(502, "rollback_command_failed", `回滚脚本执行失败 (exit ${cmdRes.exitCode})`);
        }
      }

      const stepRecord: ReleaseStepRecord = {
        step: "rollback",
        status: "passed",
        commandOrUrl: rbCommands.join(" && "),
        exitCode: rbExitCode,
        output: rbOutputs.join("\n"),
        durationMs: Date.now() - rbStart,
        at: nowIso(),
      };

      const nextSteps = [...rel.steps, stepRecord];
      const ts = nowIso();
      this.db
        .prepare(
          "UPDATE opc_releases SET status = 'rolled_back', steps_json = ?, error_message = ?, completed_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(nextSteps), reason, ts, rel.id);

      const updated = this.requireRelease(rel.id);
      this.events?.emit({
        topic: "factory.release_rolled_back",
        sourceDomain: "factory",
        mainlineId: updated.mainlineId,
        assetId: updated.assetId,
        payload: {
          releaseId: updated.id,
          runId: updated.runId,
          taskId: updated.taskId,
          project: updated.project,
          failedStep: "manual",
          previousHeadSha: updated.previousHeadSha,
          releaseSha: updated.releaseSha,
          status: updated.status,
          errorMessage: updated.errorMessage,
        },
      });
      return updated;
    } finally {
      this.activeExecutions.delete(releaseId);
      this.activeRepoPaths.delete(normalizedRepoPath);
    }
  }
}
