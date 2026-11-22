import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AgentRunRecord } from "../../dark-factory-types.ts";
import type { OpcKernel } from "../../kernel/index.ts";
import type { CanonicalResolution, DecisionPacket, DepartmentHealth, DepartmentModule } from "../../kernel/types.ts";
import type { DarkFactoryStore } from "../../server/dark-factory.ts";
import { ApiError } from "../../server/logic.ts";
import { submitAuth } from "../../server/workflow/http.ts";
import {
  assertValidBranchName,
  assertValidHealthUrl,
  ReleasePipeline,
  type CreateReleaseInput,
  type ReleaseMode,
  type ReleaseRecord,
} from "./release.ts";

export * from "./release.ts";

const execFileAsync = promisify(execFile);

const TERMINAL_STATUSES = new Set(["pr_open", "completed", "no_output", "failed", "cancelled"]);

const releaseModeSchema = z.enum(["merge_only", "merge_and_deploy"]);

const requestReleaseSchema = z
  .object({
    project: z.string().trim().max(120).optional(),
    repoPath: z.string().trim().max(500).optional(),
    sourceBranch: z.string().trim().optional(),
    targetBranch: z.string().trim().optional(),
    verifyCommand: z.string().trim().max(2000).optional(),
    buildCommand: z.string().trim().max(2000).optional(),
    deployCommand: z.string().trim().max(2000).optional(),
    rollbackCommand: z.string().trim().max(2000).optional(),
    healthUrl: z.string().trim().max(500).optional(),
    mode: releaseModeSchema.optional(),
  })
  .optional();

const createReleaseBodySchema = z.object({
  runId: z.string().trim().min(1).max(160).optional(),
  taskId: z.string().trim().min(1).max(160).optional(),
  project: z.string().trim().max(120).default(""),
  repoPath: z.string().trim().max(500).optional(),
  sourceBranch: z.string().trim().optional(),
  targetBranch: z.string().trim().optional(),
  verifyCommand: z.string().trim().max(2000).optional(),
  buildCommand: z.string().trim().max(2000).optional(),
  deployCommand: z.string().trim().max(2000).optional(),
  rollbackCommand: z.string().trim().max(2000).optional(),
  healthUrl: z.string().trim().max(500).optional(),
  mode: releaseModeSchema.default("merge_and_deploy"),
  executeNow: z.boolean().default(false),
});

const executeReleaseBodySchema = z
  .object({
    mode: releaseModeSchema.optional(),
  })
  .optional();

const rollbackReleaseBodySchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .optional();

export interface RequestReleaseOptions {
  project?: string;
  repoPath?: string;
  sourceBranch?: string;
  targetBranch?: string;
  verifyCommand?: string;
  buildCommand?: string;
  deployCommand?: string;
  rollbackCommand?: string;
  healthUrl?: string;
  mode?: ReleaseMode;
}

export interface FactoryDepartmentOptions {
  kernel: OpcKernel;
  darkFactory: DarkFactoryStore;
  releases?: ReleasePipeline;
  submitToken?: string;
  onTaskPublished?: (taskId: string, release: ReleaseRecord) => void;
}

async function parseOptionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
  }
}

async function execGitSafe(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function assertRunReleasable(run: AgentRunRecord): void {
  if (run.status === "queued" || run.status === "running") {
    throw new ApiError(409, "run_in_progress", "该运行尚未执行完毕，无法申请上线发布");
  }
  if (run.protectedViolations.length > 0 || run.circuitBreakerReason === "protected_path_violation") {
    throw new ApiError(
      403,
      "protected_path_violation",
      `该运行触碰人类独占保护路径（${run.protectedViolations.join(", ")}），禁止申请上线发布`,
    );
  }
  if (run.status !== "completed" && run.status !== "pr_open") {
    throw new ApiError(
      400,
      "run_not_releasable",
      `当前运行状态为 ${run.status}，仅校验通过的有效代码运行允许申请上线发布`,
    );
  }
  if (run.verification?.passed === false) {
    throw new ApiError(400, "run_verification_failed", "外部确定性校验未通过，禁止申请上线发布");
  }
}

async function buildGitDiffEvidence(
  repoPath: string,
  targetBranch: string,
  sourceBranch: string,
): Promise<{ resolvedTargetBranch: string; summary: string }> {
  const safeSource = assertValidBranchName(sourceBranch, "sourceBranch");
  let baseRef = assertValidBranchName(targetBranch || "main", "targetBranch");
  if (!repoPath || !existsSync(repoPath)) {
    return { resolvedTargetBranch: baseRef, summary: "仓库路径不可达，暂无本地 Git diff 摘要" };
  }

  const hasTarget = await execGitSafe(repoPath, ["rev-parse", "--verify", `refs/heads/${baseRef}`]);
  if (!hasTarget) {
    const currentHeadBranch = await execGitSafe(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (currentHeadBranch && currentHeadBranch !== "HEAD" && currentHeadBranch !== safeSource) {
      try {
        baseRef = assertValidBranchName(currentHeadBranch, "targetBranch");
      } catch {
        // keep validated baseRef
      }
    }
  }

  const baseHeadRef = (await execGitSafe(repoPath, ["rev-parse", "--verify", `refs/heads/${baseRef}`]))
    ? `refs/heads/${baseRef}`
    : baseRef;
  const sourceHeadRef = (await execGitSafe(repoPath, ["rev-parse", "--verify", `refs/heads/${safeSource}`]))
    ? `refs/heads/${safeSource}`
    : safeSource;

  const commits =
    (await execGitSafe(repoPath, ["log", "--oneline", "-n", "15", `${baseHeadRef}..${sourceHeadRef}`, "--"])) ||
    (await execGitSafe(repoPath, ["log", "--oneline", "-n", "5", sourceHeadRef, "--"]));
  const diffStat =
    (await execGitSafe(repoPath, ["diff", "--stat", `${baseHeadRef}..${sourceHeadRef}`, "--"])) ||
    (await execGitSafe(repoPath, ["show", "--stat", "--oneline", sourceHeadRef, "--"]));

  const parts: string[] = [];
  if (commits) {
    parts.push(`### 提交记录 (${baseRef}..${safeSource})\n${commits}`);
  }
  if (diffStat) {
    parts.push(`### Git Diff 统计\n${diffStat}`);
  }
  return {
    resolvedTargetBranch: baseRef,
    summary: parts.join("\n\n") || `源分支 ${safeSource} 已就绪待合并至 ${baseRef}`,
  };
}

function formatCanonicalLine(resolution: CanonicalResolution, fallbackProject: string): string {
  const mainlineLabel = resolution.mainline ? `${resolution.mainline.name} (${resolution.mainline.slug})` : "未绑定主线";
  const productLabel = resolution.product ? `${resolution.product.name} (${resolution.product.role})` : "未绑定产品";
  const assetLabel = resolution.asset
    ? `${resolution.asset.name} [${resolution.asset.kind}]`
    : fallbackProject || "未命名资产";
  return `主线：${mainlineLabel} ｜ 产品：${productLabel} ｜ 资产：${assetLabel}`;
}

function formatRollbackPlan(release: ReleaseRecord): string {
  const steps = [
    `1. 预检阶段锁定合并前基准提交 previous_head_sha（分支 ${release.targetBranch}）；`,
    `2. 若 verify / build / deploy / health_probe 任一环节失败，自动在 ${release.repoPath} 执行 \`git reset --hard <previous_head_sha>\` 恢复精确提交；`,
  ];
  if (release.rollbackCommand) {
    steps.push(`3. 自动执行资产回滚脚本：\`${release.rollbackCommand}\`；`);
  }
  steps.push(
    `${release.rollbackCommand ? "4" : "3"}. 支持随时调用 \`POST /api/opc/domains/factory/releases/${release.id}/rollback\` 人工紧急回滚并广播 \`factory.release_rolled_back\` 事件。`,
  );
  return steps.join("\n");
}

export class FactoryDepartment implements DepartmentModule {
  readonly id = "factory" as const;
  readonly kernel: OpcKernel;
  readonly darkFactory: DarkFactoryStore;
  readonly releases: ReleasePipeline;
  private submitToken?: string;
  private onTaskPublished?: (taskId: string, release: ReleaseRecord) => void;
  private unsubscribers: Array<() => void> = [];

  constructor(options: FactoryDepartmentOptions);
  constructor(
    kernel: OpcKernel,
    darkFactory: DarkFactoryStore,
    options?: Omit<FactoryDepartmentOptions, "kernel" | "darkFactory">,
  );
  constructor(
    first: FactoryDepartmentOptions | OpcKernel,
    second?: DarkFactoryStore,
    third?: Omit<FactoryDepartmentOptions, "kernel" | "darkFactory">,
  ) {
    if ("kernel" in first && "darkFactory" in first) {
      this.kernel = first.kernel;
      this.darkFactory = first.darkFactory;
      this.releases =
        first.releases ??
        new ReleasePipeline(this.kernel.db, {
          events: this.kernel.events,
          darkFactory: this.darkFactory,
        });
      this.submitToken = first.submitToken;
      this.onTaskPublished = first.onTaskPublished;
    } else {
      this.kernel = first;
      this.darkFactory = second!;
      this.releases =
        third?.releases ??
        new ReleasePipeline(this.kernel.db, {
          events: this.kernel.events,
          darkFactory: this.darkFactory,
        });
      this.submitToken = third?.submitToken;
      this.onTaskPublished = third?.onTaskPublished;
    }

    this.releases.setDependencies({
      events: this.kernel.events,
      darkFactory: this.darkFactory,
    });

    this.wireDarkFactoryHooks();
    this.registerDecisionHandlers();
    this.subscribeKernelEvents();
  }

  setOnTaskPublished(handler: (taskId: string, release: ReleaseRecord) => void) {
    this.onTaskPublished = handler;
  }

  private wireDarkFactoryHooks() {
    const prevResolveRepoPath = this.darkFactory.hooks.resolveRepoPath;
    this.darkFactory.hooks.resolveRepoPath = (project: string) => {
      const fromPrev = prevResolveRepoPath?.(project);
      if (fromPrev && fromPrev.trim()) return fromPrev.trim();
      const resolved = this.kernel.registry.resolveCanonicalRef(project);
      const localPath = resolved.asset?.localRepoPath?.trim();
      return localPath || null;
    };

    const prevResolveVerifyCommand = this.darkFactory.hooks.resolveVerifyCommand;
    this.darkFactory.hooks.resolveVerifyCommand = (project: string) => {
      const fromPrev = prevResolveVerifyCommand?.(project);
      if (fromPrev && fromPrev.trim()) return fromPrev.trim();
      const resolved = this.kernel.registry.resolveCanonicalRef(project);
      const verifyCmd = resolved.asset?.verifyCommand?.trim();
      return verifyCmd || null;
    };

    const unsubRun = this.darkFactory.addRunStatusListener((run: AgentRunRecord) => {
      if (!TERMINAL_STATUSES.has(run.status) || !run.verification) return;
      const resolved = this.kernel.registry.resolveCanonicalRef(run.project);
      this.kernel.events.emit({
        topic: "factory.run_verified",
        sourceDomain: "factory",
        mainlineId: resolved.mainline?.id ?? null,
        productId: resolved.product?.id ?? null,
        assetId: resolved.asset?.id ?? null,
        payload: {
          runId: run.id,
          taskId: run.taskId,
          project: run.project,
          status: run.status,
          passed: run.verification.passed,
          exitCode: run.verification.exitCode,
          command: run.verification.command,
          durationMs: run.verification.durationMs,
        },
      });
    });
    this.unsubscribers.push(unsubRun);
  }

  private registerDecisionHandlers() {
    this.kernel.decisions.registerHandler("factory.release_execute", async ({ option }) => {
      const releaseId = String(option.payload?.releaseId ?? "").trim();
      if (!releaseId) {
        throw new ApiError(400, "missing_release_id", "审批项缺少关联的 releaseId");
      }
      const executed = await this.releases.executeRelease(releaseId, { mode: "merge_and_deploy" });
      return {
        releaseId: executed.id,
        status: executed.status,
        mode: executed.mode,
        previousHeadSha: executed.previousHeadSha,
        releaseSha: executed.releaseSha,
        errorMessage: executed.errorMessage,
      };
    });

    this.kernel.decisions.registerHandler("factory.release_merge_only", async ({ option }) => {
      const releaseId = String(option.payload?.releaseId ?? "").trim();
      if (!releaseId) {
        throw new ApiError(400, "missing_release_id", "审批项缺少关联的 releaseId");
      }
      const executed = await this.releases.executeRelease(releaseId, { mode: "merge_only" });
      return {
        releaseId: executed.id,
        status: executed.status,
        mode: executed.mode,
        previousHeadSha: executed.previousHeadSha,
        releaseSha: executed.releaseSha,
        errorMessage: executed.errorMessage,
      };
    });

    this.kernel.decisions.registerHandler("factory.release_reject", ({ option, note, actor }) => {
      const releaseId = String(option.payload?.releaseId ?? "").trim();
      if (!releaseId) {
        throw new ApiError(400, "missing_release_id", "审批项缺少关联的 releaseId");
      }
      const reason = note.trim() || `已由 ${actor} 在总裁审批网关驳回发布`;
      const rejected = this.releases.rejectRelease(releaseId, reason);
      return {
        releaseId: rejected.id,
        status: rejected.status,
        errorMessage: rejected.errorMessage,
      };
    });
  }

  private subscribeKernelEvents() {
    const unsubCompleted = this.kernel.events.subscribe("factory.release_completed", (event) => {
      const releaseId = String(event.payload?.releaseId ?? "").trim();
      if (!releaseId) return;
      const release = this.releases.getRelease(releaseId);
      if (!release || release.status !== "succeeded" || !release.taskId) return;

      if (this.onTaskPublished) {
        this.onTaskPublished(release.taskId, release);
        return;
      }

      // Fallback direct SQLite update when opc_planning_tasks exists on the shared DB
      const hasPlanningTable = Boolean(
        this.kernel.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_planning_tasks'")
          .get(),
      );
      if (hasPlanningTable) {
        const now = new Date().toISOString();
        this.kernel.db
          .prepare(
            `UPDATE opc_planning_tasks
             SET status = 'published',
                 completed_at = COALESCE(completed_at, ?),
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(now, now, release.taskId);
      }
    });
    this.unsubscribers.push(unsubCompleted);
  }

  private resolveReleaseSpec(input: {
    project?: string;
    repoPath?: string | null;
    sourceBranch?: string | null;
    targetBranch?: string;
    verifyCommand?: string;
    buildCommand?: string;
    deployCommand?: string;
    rollbackCommand?: string;
    healthUrl?: string;
    mode?: ReleaseMode;
    run?: AgentRunRecord | null;
    taskId?: string | null;
  }): { resolution: CanonicalResolution; createInput: CreateReleaseInput } {
    const projectKey = (input.project ?? input.run?.project ?? "").trim();
    const resolution = this.kernel.registry.resolveCanonicalRef(projectKey);
    const asset = resolution.asset;

    const repoPath =
      (input.repoPath && input.repoPath.trim()) ||
      (input.run?.repoPath && input.run.repoPath.trim()) ||
      (asset?.localRepoPath && asset.localRepoPath.trim()) ||
      "";
    if (!repoPath) {
      throw new ApiError(
        400,
        "missing_repo_path",
        `无法为项目「${projectKey || "未指定"}」解析本地 Git 仓库路径，请提供 repoPath 或在资产注册表中配置 localRepoPath`,
      );
    }

    const sourceBranchRaw =
      (input.sourceBranch && input.sourceBranch.trim()) ||
      (input.run?.branchName && input.run.branchName.trim()) ||
      "";
    if (!sourceBranchRaw) {
      throw new ApiError(400, "missing_source_branch", "发布单必须指定待合并的 sourceBranch 工作分支");
    }
    const sourceBranch = assertValidBranchName(sourceBranchRaw, "sourceBranch");
    const targetBranch = assertValidBranchName((input.targetBranch ?? "").trim() || "main", "targetBranch");

    const verifyCommand =
      input.verifyCommand !== undefined
        ? input.verifyCommand.trim()
        : (input.run?.verifyCommand || asset?.verifyCommand || "").trim();
    const buildCommand =
      input.buildCommand !== undefined ? input.buildCommand.trim() : (asset?.buildCommand || "").trim();
    const deployCommand =
      input.deployCommand !== undefined ? input.deployCommand.trim() : (asset?.deployCommand || "").trim();
    const rollbackCommand =
      input.rollbackCommand !== undefined ? input.rollbackCommand.trim() : (asset?.rollbackCommand || "").trim();
    const healthUrl =
      input.healthUrl !== undefined ? input.healthUrl.trim() : (asset?.healthUrl || "").trim();
    if (healthUrl) {
      assertValidHealthUrl(healthUrl);
    }

    return {
      resolution,
      createInput: {
        runId: input.run?.id ?? null,
        taskId: (input.taskId ?? input.run?.taskId ?? null) || null,
        assetId: asset?.id ?? null,
        mainlineId: resolution.mainline?.id ?? asset?.mainlineId ?? null,
        project: projectKey || asset?.name || "default",
        repoPath,
        sourceBranch,
        targetBranch,
        verifyCommand,
        buildCommand,
        deployCommand,
        rollbackCommand,
        healthUrl,
        mode: input.mode ?? "merge_and_deploy",
        status: "pending_approval",
      },
    };
  }

  private async proposeReleaseDecision(params: {
    release: ReleaseRecord;
    resolution: CanonicalResolution;
    run?: AgentRunRecord | null;
  }): Promise<DecisionPacket> {
    const { release, resolution, run } = params;
    const gitEvidence = await buildGitDiffEvidence(
      release.repoPath,
      release.targetBranch,
      release.sourceBranch,
    );

    const verificationBlock = run?.verification
      ? [
          `### 外部确定性校验 (${run.verification.passed ? "PASSED" : "FAILED"})`,
          `- 命令：\`${run.verification.command}\``,
          `- 退出码：${run.verification.exitCode}（耗时 ${run.verification.durationMs}ms）`,
          run.verification.stdout ? `- stdout：\n${run.verification.stdout.slice(0, 1500)}` : "",
          run.verification.stderr ? `- stderr：\n${run.verification.stderr.slice(0, 1500)}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : release.verifyCommand
        ? `### 外部确定性校验\n合并后将执行门禁命令：\`${release.verifyCommand}\``
        : "### 外部确定性校验\n未配置运行期确定性校验命令";

    const changedFilesBlock =
      run && run.changedFiles.length > 0
        ? `### 变更文件 (${run.changedFiles.length})\n${run.changedFiles.map((f) => `- \`${f}\``).join("\n")}`
        : "";

    const pipelineSummary = [
      `- 合并分支：\`${release.sourceBranch}\` -> \`${gitEvidence.resolvedTargetBranch}\`（仓库：\`${release.repoPath}\`）`,
      `- 校验门禁 (verifyCommand)：${release.verifyCommand ? `\`${release.verifyCommand}\`` : "未配置（跳过）"}`,
      `- 构建命令 (buildCommand)：${release.buildCommand ? `\`${release.buildCommand}\`` : "未配置（跳过）"}`,
      `- 部署命令 (deployCommand)：${release.deployCommand ? `\`${release.deployCommand}\`` : "未配置（跳过）"}`,
      `- 健康探针 (healthUrl)：${release.healthUrl ? release.healthUrl : "未配置（跳过）"}`,
    ].join("\n");

    const backgroundSummary = [
      formatCanonicalLine(resolution, release.project),
      run
        ? `关联任务 [${run.taskId}]：${run.taskTitle}（Run \`${run.id}\`，Agent：${run.agentName}，耗费 $${run.costUsd.toFixed(4)} / ${run.tokenUsed} tokens）`
        : `关联任务：${release.taskId ?? "手动创建发布单"}`,
      pipelineSummary,
    ].join("\n\n");

    const diffOrEvidence = [verificationBlock, changedFilesBlock, gitEvidence.summary]
      .filter(Boolean)
      .join("\n\n");

    const titleSubject = run ? `${release.project} · ${run.taskTitle}` : `${release.project} · ${release.sourceBranch}`;

    return this.kernel.decisions.propose({
      dedupeKey: `factory:production_release:${release.id}`,
      domain: "factory",
      kind: "production_release",
      riskLevel: "high",
      mainlineId: resolution.mainline?.id ?? release.mainlineId,
      productId: resolution.product?.id ?? null,
      assetId: resolution.asset?.id ?? release.assetId,
      projectOrAssetRef: release.project,
      title: `生产发布审批：${titleSubject}`,
      backgroundSummary,
      whyRecommended: run?.verification?.passed
        ? `隔离工作树已通过外部确定性校验（\`${run.verification.command}\`），建议批准合入并执行真发布与健康探针验收。`
        : "代码分支已准备就绪，发布流水线具备自动健康探针与异常硬回滚保护。",
      costEstimateUsd: run ? run.costUsd : 0,
      diffOrEvidence,
      rollbackPlan: formatRollbackPlan(release),
      recommendedOptionId: "approve_deploy",
      tags: ["production_release", "factory", release.project].filter(Boolean),
      options: [
        {
          id: "approve_deploy",
          label: "批准合并并上线部署",
          description: "合并分支至目标分支，依次执行确定性校验、构建、部署与 HTTP 健康探针验收，失败自动回滚",
          outcome: "approved",
          handlerKey: "factory.release_execute",
          payload: { releaseId: release.id, mode: "merge_and_deploy" },
        },
        {
          id: "approve_merge_only",
          label: "仅合并代码（暂不部署）",
          description: "仅合并分支至目标分支并执行确定性校验，跳过构建、部署与健康探针",
          outcome: "approved",
          handlerKey: "factory.release_merge_only",
          payload: { releaseId: release.id, mode: "merge_only" },
        },
        {
          id: "reject_release",
          label: "驳回本次发布",
          description: "拒绝合入与上线，保持目标分支不变并将发布单标记为已驳回",
          outcome: "rejected",
          handlerKey: "factory.release_reject",
          payload: { releaseId: release.id },
        },
      ],
    });
  }

  /**
   * Stages a 'pending_approval' release from a completed DarkFactory run and submits a rich
   * production_release DecisionPacket to the Founder DecisionGateway.
   */
  async requestReleaseFromRun(
    runId: string,
    options: RequestReleaseOptions = {},
  ): Promise<{ release: ReleaseRecord; decision: DecisionPacket }> {
    const run = this.darkFactory.getRun(runId);
    assertRunReleasable(run);

    // Ensure any unstaged/uncommitted edits in the worktree are committed onto the run branch before diffing
    if (run.worktreePath && run.branchName && existsSync(run.worktreePath)) {
      await this.darkFactory.commitWorktreeChanges(run.id);
    }

    const refreshedRun = this.darkFactory.getRun(runId);
    assertRunReleasable(refreshedRun);
    const { resolution, createInput } = this.resolveReleaseSpec({
      ...options,
      run: refreshedRun,
    });

    const release = this.releases.createRelease(createInput);

    this.kernel.events.emit({
      topic: "factory.release_requested",
      sourceDomain: "factory",
      mainlineId: resolution.mainline?.id ?? release.mainlineId,
      productId: resolution.product?.id ?? null,
      assetId: resolution.asset?.id ?? release.assetId,
      payload: {
        releaseId: release.id,
        runId: refreshedRun.id,
        taskId: refreshedRun.taskId,
        project: release.project,
        sourceBranch: release.sourceBranch,
        targetBranch: release.targetBranch,
        mode: release.mode,
      },
    });

    const decision = await this.proposeReleaseDecision({
      release,
      resolution,
      run: refreshedRun,
    });

    return { release, decision };
  }

  start() {
    // Reclaim any orphaned running slots on department start as well
    this.darkFactory.recoverOrphanedRuns();
  }

  stop() {
    for (const unsub of this.unsubscribers.splice(0)) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
  }

  health(): DepartmentHealth {
    const overview = this.darkFactory.getOverview();
    const relCounts = this.releases.counts();
    return {
      healthy: true,
      summary: `Agent ${overview.agents.length} 个 · 运行中 ${overview.activeCount} / 排队 ${overview.queuedCount} · 发布成功 ${relCounts.succeeded} 次 / 待批 ${relCounts.pendingApproval} 单 / 回滚 ${relCounts.rolledBack} 次`,
      metrics: {
        agents: overview.agents.length,
        activeRuns: overview.activeCount,
        queuedRuns: overview.queuedCount,
        pendingReleases: relCounts.pendingApproval,
        runningReleases: relCounts.running,
        succeededReleases: relCounts.succeeded,
        rolledBackReleases: relCounts.rolledBack,
        failedReleases: relCounts.failed,
      },
    };
  }

  registerRoutes(app: Hono, requireUser: (c: Context) => { id: string; name: string }) {
    const { permits } = submitAuth(this.submitToken);
    const base = "/api/opc/domains/factory" as const;

    const allowsSubmitToken = (c: Context): boolean => {
      if (c.req.method === "GET") return true;
      if (
        c.req.method === "POST" &&
        /^\/api\/opc\/domains\/factory\/runs\/[^/]+\/request-release\/?$/.test(c.req.path)
      ) {
        return true;
      }
      return false;
    };

    const enforceAuth = (c: Context) => {
      if (allowsSubmitToken(c)) {
        if (!permits(c)) requireUser(c);
      } else {
        requireUser(c);
      }
    };

    app.use(`${base}/*`, async (c, next) => {
      enforceAuth(c);
      c.header("Cache-Control", "no-store");
      await next();
    });
    app.use(base, async (c, next) => {
      enforceAuth(c);
      c.header("Cache-Control", "no-store");
      await next();
    });

    app.get(`${base}/releases`, (c) => {
      const status = c.req.query("status") || undefined;
      const project = c.req.query("project") || undefined;
      const runId = c.req.query("runId") || undefined;
      const limit = Number(c.req.query("limit") ?? 50) || 50;
      return c.json({
        releases: this.releases.listReleases({ status, project, runId, limit }),
        counts: this.releases.counts(),
      });
    });

    app.get(`${base}/releases/:id`, (c) => {
      const release = this.releases.requireRelease(c.req.param("id"));
      return c.json({ release });
    });

    app.post(`${base}/releases`, async (c) => {
      requireUser(c);
      const rawBody = await parseOptionalJson(c);
      const parsed = createReleaseBodySchema.safeParse(rawBody ?? {});
      if (!parsed.success) {
        throw new ApiError(
          400,
          "release_input",
          parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
        );
      }
      const data = parsed.data;

      let linkedRun = data.runId ? this.darkFactory.getRun(data.runId) : null;
      if (linkedRun) {
        assertRunReleasable(linkedRun);
      }

      if (data.runId && !data.executeNow) {
        const result = await this.requestReleaseFromRun(data.runId, {
          project: data.project || undefined,
          repoPath: data.repoPath,
          sourceBranch: data.sourceBranch,
          targetBranch: data.targetBranch,
          verifyCommand: data.verifyCommand,
          buildCommand: data.buildCommand,
          deployCommand: data.deployCommand,
          rollbackCommand: data.rollbackCommand,
          healthUrl: data.healthUrl,
          mode: data.mode,
        });
        return c.json(result, 201);
      }

      if (linkedRun?.worktreePath && linkedRun.branchName && existsSync(linkedRun.worktreePath)) {
        await this.darkFactory.commitWorktreeChanges(linkedRun.id);
        linkedRun = this.darkFactory.getRun(linkedRun.id);
        assertRunReleasable(linkedRun);
      }

      const { resolution, createInput } = this.resolveReleaseSpec({
        project: data.project || linkedRun?.project,
        repoPath: data.repoPath,
        sourceBranch: data.sourceBranch,
        targetBranch: data.targetBranch,
        verifyCommand: data.verifyCommand,
        buildCommand: data.buildCommand,
        deployCommand: data.deployCommand,
        rollbackCommand: data.rollbackCommand,
        healthUrl: data.healthUrl,
        mode: data.mode,
        run: linkedRun,
        taskId: data.taskId ?? linkedRun?.taskId ?? null,
      });

      const staged = this.releases.createRelease(createInput);

      if (data.executeNow) {
        const executed = await this.releases.executeRelease(staged.id, { mode: staged.mode });
        return c.json({ release: executed, decision: null }, 201);
      }

      this.kernel.events.emit({
        topic: "factory.release_requested",
        sourceDomain: "factory",
        mainlineId: resolution.mainline?.id ?? staged.mainlineId,
        productId: resolution.product?.id ?? null,
        assetId: resolution.asset?.id ?? staged.assetId,
        payload: {
          releaseId: staged.id,
          runId: staged.runId,
          taskId: staged.taskId,
          project: staged.project,
          sourceBranch: staged.sourceBranch,
          targetBranch: staged.targetBranch,
          mode: staged.mode,
        },
      });

      const decision = await this.proposeReleaseDecision({
        release: staged,
        resolution,
        run: linkedRun,
      });

      return c.json({ release: staged, decision }, 201);
    });

    app.post(`${base}/runs/:runId/request-release`, async (c) => {
      const rawBody = await parseOptionalJson(c);
      const parsed = requestReleaseSchema.safeParse(rawBody);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "release_input",
          parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
        );
      }
      const result = await this.requestReleaseFromRun(c.req.param("runId"), parsed.data ?? {});
      return c.json(result, 201);
    });

    app.post(`${base}/releases/:id/execute`, async (c) => {
      requireUser(c);
      const rawBody = await parseOptionalJson(c);
      const parsed = executeReleaseBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "execute_input",
          parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
        );
      }
      const release = await this.releases.executeRelease(c.req.param("id"), {
        mode: parsed.data?.mode,
      });
      return c.json({ release });
    });

    app.post(`${base}/releases/:id/rollback`, async (c) => {
      requireUser(c);
      const rawBody = await parseOptionalJson(c);
      const parsed = rollbackReleaseBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        throw new ApiError(
          400,
          "rollback_input",
          parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
        );
      }
      const release = await this.releases.rollbackRelease(
        c.req.param("id"),
        parsed.data?.reason || "人工触发紧急回滚",
      );
      return c.json({ release });
    });
  }
}
