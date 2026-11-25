import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AgentRunRecord } from "../dark-factory-types.ts";
import { isDigestOrNonActionableNoise } from "../kernel/admission-filter.ts";
import {
  isBotArbitrationMode,
  NON_DELEGABLE_DECISION_KINDS,
  type DecisionGateway,
} from "../kernel/decisions.ts";
import type { DomainEventBus } from "../kernel/events.ts";
import type { AssetRegistry } from "../kernel/registry.ts";
import type {
  BotArbitrationMode,
  BotArbitrationVerdictKind,
  BotArbitratorPolicy,
  BotReleaseMergeMode,
  CompanyDepartmentId,
  DecisionOption,
  DecisionPacket,
  DecisionRiskLevel,
} from "../kernel/types.ts";
import type { WorkflowCard, WorkflowDetail, WorkflowRun } from "../workflow-types.ts";
import type { DarkFactoryStore } from "./dark-factory.ts";
import { ApiError } from "./logic.ts";
import { StageHomeClient, type HomeTask } from "./stage-home-client.ts";
import { submitAuth } from "./workflow/http.ts";
import type { WorkflowService } from "./workflow/service.ts";

export const DEFAULT_ALLOWED_RELEASE_PROJECTS = [
  "opc-gtm-kit",
  "opc-ops-kit",
  "opc-commerce-kit",
  "pagelens-interpret",
];

export const DEFAULT_BOT_ARBITRATOR_POLICY: Omit<BotArbitratorPolicy, "updatedAt"> = {
  arbitrationMode: "off",
  autoApproveVerifiedReleases: false,
  releaseMergeMode: "merge_only",
  allowedReleaseProjects: [...DEFAULT_ALLOWED_RELEASE_PROJECTS],
  blockedReleaseProjects: [],
  autoCloseStaleWorkflowHours: 24,
  maxAutoApproveCostUsd: 5.0,
  preferredBotRole: "auto",
};

const HARD_NON_DELEGABLE_KINDS = new Set<string>([
  ...NON_DELEGABLE_DECISION_KINDS,
  "kill_switch",
]);

const SAFE_DELEGATED_REDLINE_BLOCKLIST = new Set<string>([
  "mainline_change",
  "freeze_override",
  "kill_switch",
  "pricing_change",
  "security_override",
]);

export interface BotReviewRequest {
  targetKind: "decision" | "workflow";
  targetId: string;
  itemKind: string;
  title: string;
  botRole: "super" | "rd";
  botId: string;
  actor: string;
  prompt: string;
  availableOptions: Array<{
    id: string;
    label: string;
    outcome?: string;
    description?: string;
  }>;
  context: Record<string, unknown>;
}

export interface BotReviewVerdict {
  verdict: BotArbitrationVerdictKind;
  optionId?: string;
  reason: string;
  nextStep: string;
  botId?: string;
  botTaskId?: string;
  rawReport?: string;
}

export type BotReviewer = (req: BotReviewRequest) => Promise<BotReviewVerdict>;

export interface BotArbitrationLogRecord {
  id: string;
  targetKind: "decision" | "workflow";
  targetId: string;
  targetSubId: string | null;
  targetTitle: string;
  itemKind: string;
  mode: BotArbitrationMode;
  dryRun: boolean;
  actor: string;
  botId: string | null;
  botTaskId: string | null;
  verdict: BotArbitrationVerdictKind;
  optionId: string | null;
  executed: boolean;
  escalated: boolean;
  reason: string;
  nextStep: string;
  deterministicGate: string;
  handlerResult: Record<string, unknown> | null;
  createdAt: string;
}

export interface PendingDecisionSummary {
  id: string;
  domain: CompanyDepartmentId;
  kind: string;
  riskLevel: DecisionRiskLevel;
  title: string;
  project: string | null;
  isRedline: boolean;
  updatedAt: string;
  createdAt: string;
  recommendedOptionId: string | null;
  admissionWarning: string | null;
  actionBlockReason?: string;
  latestLog: BotArbitrationLogRecord | null;
}

export interface PendingWorkflowSummary {
  runId: string;
  cardId: string;
  cardKind: WorkflowCard["kind"];
  revision: number;
  goal: string;
  folder: string;
  workspace: string;
  lastActivityAt: string;
  ageHours: number;
  isStale: boolean;
  blockedReason?: string;
  latestLog: BotArbitrationLogRecord | null;
}

export interface BotArbitratorStatusResponse {
  policy: BotArbitratorPolicy;
  pendingDecisions: PendingDecisionSummary[];
  pendingWorkflows: PendingWorkflowSummary[];
  recentLogs: BotArbitrationLogRecord[];
  counts: {
    pendingDecisions: number;
    pendingWorkflows: number;
    staleWorkflows: number;
    totalPending: number;
    resolvedLast24h: number;
    escalatedLast24h: number;
  };
}

export interface BotArbitratorPolicyPatch {
  arbitrationMode?: BotArbitrationMode;
  mode?: BotArbitrationMode;
  autoApproveVerifiedReleases?: boolean;
  releaseMergeMode?: BotReleaseMergeMode;
  allowedReleaseProjects?: string[];
  blockedReleaseProjects?: string[];
  autoCloseStaleWorkflowHours?: number;
  maxAutoApproveCostUsd?: number;
  preferredBotRole?: "auto" | "super" | "rd";
}

export interface ArbitrateOptions {
  dryRun?: boolean;
  mode?: BotArbitrationMode;
  trigger?: "manual" | "scheduled";
}

export interface ArbitratePendingInput extends ArbitrateOptions {
  scope?: "all" | "decisions" | "workflows";
  decisionIds?: string[];
  workflowIds?: string[];
  limit?: number;
}

export interface ArbitrationItemResult {
  logId: string | null;
  targetKind: "decision" | "workflow";
  targetId: string;
  targetSubId: string | null;
  targetTitle: string;
  itemKind: string;
  mode: BotArbitrationMode;
  dryRun: boolean;
  actor: string;
  botId: string | null;
  botTaskId: string | null;
  verdict: BotArbitrationVerdictKind;
  optionId: string | null;
  executed: boolean;
  escalated: boolean;
  skipped?: boolean;
  failed?: boolean;
  reason: string;
  nextStep: string;
  deterministicGate: string;
  handlerResult: Record<string, unknown> | null;
}

export interface ArbitrationBatchReport {
  mode: BotArbitrationMode;
  effectiveMode: BotArbitrationMode;
  dryRun: boolean;
  skippedReason?: string;
  startedAt: string;
  finishedAt: string;
  totalProcessed: number;
  executedCount: number;
  approvedCount: number;
  rejectedCount: number;
  changesRequestedCount: number;
  snoozedCount: number;
  closedStaleCount: number;
  escalatedCount: number;
  advisoryCount: number;
  failedCount: number;
  items: ArbitrationItemResult[];
}

export type WorkflowDeciderFn = (
  runId: string,
  input: { cardId: string; revision: number; action: "approve" | "changes" | "reject"; note: string },
  actor: string,
) => WorkflowDetail;

export interface BotArbitratorDeps {
  decisions: DecisionGateway;
  events?: DomainEventBus;
  registry?: AssetRegistry;
  workflow?: WorkflowService;
  workflowDecider?: WorkflowDeciderFn;
  darkFactory?: Pick<DarkFactoryStore, "getRun">;
  stageHomeClient?: StageHomeClient;
  botReviewer?: BotReviewer;
  nowFn?: () => number;
  botTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RegisterBotArbitratorDeps extends BotArbitratorDeps {
  requireUser: (c: Context) => { id: string; name: string };
  submitToken?: string;
}

const botVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject", "changes", "snooze", "supersede", "escalate"]),
  optionId: z.string().trim().min(1).max(120).optional(),
  reason: z.string().trim().min(1).max(2000),
  nextStep: z.string().trim().max(2000).optional().default(""),
});

const execFileAsync = promisify(execFile);

const policyPatchSchema = z.object({
  arbitrationMode: z.enum(["off", "advisory", "delegated_safe", "full_delegated"]).optional(),
  mode: z.enum(["off", "advisory", "delegated_safe", "full_delegated"]).optional(),
  autoApproveVerifiedReleases: z.boolean().optional(),
  releaseMergeMode: z.enum(["merge_only", "merge_and_deploy"]).optional(),
  allowedReleaseProjects: z.array(z.string().trim().max(160)).max(200).optional(),
  blockedReleaseProjects: z.array(z.string().trim().max(160)).max(200).optional(),
  autoCloseStaleWorkflowHours: z.number().int().min(1).max(720).optional(),
  maxAutoApproveCostUsd: z.number().min(0).max(500).optional(),
  preferredBotRole: z.enum(["auto", "super", "rd"]).optional(),
});

async function isBranchAlreadyMergedInGit(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<boolean> {
  if (!repoPath || !sourceBranch || !targetBranch || !existsSync(repoPath)) return false;
  if (sourceBranch.startsWith("-") || targetBranch.startsWith("-")) return false;
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${sourceBranch}`], {
      cwd: repoPath,
      timeout: 3_000,
    });
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`], {
      cwd: repoPath,
      timeout: 3_000,
    });
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", `refs/heads/${targetBranch}..refs/heads/${sourceBranch}`],
      { cwd: repoPath, timeout: 3_000 },
    );
    return stdout.trim() === "0";
  } catch {
    return false;
  }
}

async function readGitReleaseDiffSummary(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<{ commits: string; diffStat: string } | null> {
  if (!repoPath || !sourceBranch || !targetBranch || !existsSync(repoPath)) return null;
  if (sourceBranch.startsWith("-") || targetBranch.startsWith("-")) return null;
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${sourceBranch}`], {
      cwd: repoPath,
      timeout: 3_000,
    });
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`], {
      cwd: repoPath,
      timeout: 3_000,
    });
    const range = `refs/heads/${targetBranch}..refs/heads/${sourceBranch}`;
    const [logRes, statRes] = await Promise.all([
      execFileAsync("git", ["-c", "core.quotepath=false", "log", "--oneline", "-n", "5", range, "--"], {
        cwd: repoPath,
        timeout: 3_000,
        maxBuffer: 512 * 1024,
      }),
      execFileAsync("git", ["-c", "core.quotepath=false", "diff", "--stat", range, "--"], {
        cwd: repoPath,
        timeout: 3_000,
        maxBuffer: 512 * 1024,
      }),
    ]);
    const commits = logRes.stdout.trim();
    const diffStat = statRes.stdout.trim();
    if (!commits && !diffStat) return null;
    return { commits, diffStat };
  } catch {
    return null;
  }
}

const AGENT_HOME_PROMPT_CAP = 3400;

function extractSectionFromEvidence(evidence: string, heading: string, maxLen: number): string {
  if (!evidence) return "";
  const idx = evidence.indexOf(heading);
  if (idx === -1) return "";
  const rest = evidence.slice(idx);
  const nextHeading = rest.indexOf("\n### ", heading.length);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section.trim().slice(0, maxLen);
}

const runBodySchema = z.object({
  scope: z.enum(["all", "decisions", "workflows"]).optional(),
  decisionIds: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  workflowIds: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  dryRun: z.boolean().optional(),
  mode: z.enum(["off", "advisory", "delegated_safe", "full_delegated"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const singleItemBodySchema = z.object({
  dryRun: z.boolean().optional(),
  mode: z.enum(["off", "advisory", "delegated_safe", "full_delegated"]).optional(),
});

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function dedupeProjectList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBotNote(prefix: string, reason: string, nextStep?: string): string {
  const parts = [`${prefix}：${reason.trim()}`];
  if (nextStep && nextStep.trim()) {
    parts.push(`后续安排：${nextStep.trim()}`);
  }
  return parts.join(" ｜ ").slice(0, 3800);
}

function extractReleaseId(packet: DecisionPacket): string {
  for (const opt of packet.options) {
    const id = String(opt.payload?.releaseId ?? "").trim();
    if (id) return id;
  }
  const match = /^factory:production_release:(.+)$/.exec(packet.dedupeKey);
  return match?.[1]?.trim() ?? "";
}

/**
 * Parses strict JSON arbitration verdict from Bot report text (supports raw JSON,
 * fenced ```json blocks, or embedded JSON object). Returns null if invalid.
 */
export function parseBotVerdictJson(rawText: string): {
  verdict: BotArbitrationVerdictKind;
  optionId?: string;
  reason: string;
  nextStep: string;
} | null {
  const trimmed = (rawText ?? "").trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(trimmed)) !== null) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }

  // Extract balanced JSON object snippets containing "verdict"
  const verdictIdx = trimmed.indexOf('"verdict"');
  if (verdictIdx !== -1) {
    const startBrace = trimmed.lastIndexOf("{", verdictIdx);
    if (startBrace !== -1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = startBrace; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              candidates.push(trimmed.slice(startBrace, i + 1));
              break;
            }
          }
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsedJson = JSON.parse(candidate) as unknown;
      const validated = botVerdictSchema.safeParse(parsedJson);
      if (validated.success) {
        return {
          verdict: validated.data.verdict,
          ...(validated.data.optionId ? { optionId: validated.data.optionId } : {}),
          reason: validated.data.reason,
          nextStep: validated.data.nextStep ?? "",
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

interface ReleaseRow {
  id: string;
  run_id: string | null;
  task_id: string | null;
  project: string;
  repo_path: string;
  source_branch: string;
  target_branch: string;
  mode: string;
  status: string;
}

interface AgentRunGateInfo {
  id: string;
  status: string;
  project: string;
  protectedViolations: string[];
  circuitBreakerReason: string | null;
  verification: { passed: boolean; command: string; exitCode: number } | null;
  changedFiles: string[];
  changedFilesCount: number;
}

interface OpenWorkflowRecord {
  run: WorkflowRun;
  card: WorkflowCard;
  lastActivityAt: string;
  ageHours: number;
  workspaceExists: boolean;
  supersededByRunId: string | null;
  blockedReason?: string;
}

async function parseOptionalJsonBody(c: Context): Promise<Record<string, unknown>> {
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

export class BotArbitratorService {
  private readonly db: DatabaseSync;
  private readonly decisions: DecisionGateway;
  private readonly events?: DomainEventBus;
  private readonly registry?: AssetRegistry;
  private readonly workflow?: WorkflowService;
  private readonly workflowDecider?: WorkflowDeciderFn;
  private readonly darkFactory?: Pick<DarkFactoryStore, "getRun">;
  private stageHomeClient?: StageHomeClient;
  private readonly botReviewer?: BotReviewer;
  private readonly nowFn: () => number;
  private readonly botTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly inFlightTargets = new Set<string>();

  constructor(db: DatabaseSync, deps: BotArbitratorDeps) {
    this.db = db;
    this.decisions = deps.decisions;
    this.events = deps.events;
    this.registry = deps.registry;
    this.workflow = deps.workflow;
    this.workflowDecider = deps.workflowDecider;
    this.darkFactory = deps.darkFactory;
    this.stageHomeClient = deps.stageHomeClient;
    this.botReviewer = deps.botReviewer;
    this.nowFn = deps.nowFn ?? (() => Date.now());
    this.botTimeoutMs = Math.max(1_000, deps.botTimeoutMs ?? 45_000);
    this.pollIntervalMs = Math.max(50, deps.pollIntervalMs ?? 1_200);

    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_bot_arbitrator_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        arbitration_mode TEXT NOT NULL DEFAULT 'off',
        auto_approve_verified_releases INTEGER NOT NULL DEFAULT 0,
        release_merge_mode TEXT NOT NULL DEFAULT 'merge_only',
        allowed_release_projects_json TEXT NOT NULL,
        blocked_release_projects_json TEXT NOT NULL,
        auto_close_stale_workflow_hours INTEGER NOT NULL DEFAULT 24,
        max_auto_approve_cost_usd REAL NOT NULL DEFAULT 5.0,
        preferred_bot_role TEXT NOT NULL DEFAULT 'auto',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_bot_arbitration_log (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_sub_id TEXT,
        target_title TEXT NOT NULL,
        item_kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        actor TEXT NOT NULL,
        bot_id TEXT,
        bot_task_id TEXT,
        verdict TEXT NOT NULL,
        option_id TEXT,
        executed INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        next_step TEXT NOT NULL DEFAULT '',
        deterministic_gate TEXT NOT NULL DEFAULT '',
        handler_result_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bot_arb_log_created
        ON opc_bot_arbitration_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_arb_log_target
        ON opc_bot_arbitration_log(target_kind, target_id, created_at DESC);
    `);

    const existing = this.db
      .prepare("SELECT 1 FROM opc_bot_arbitrator_policy WHERE singleton = 1")
      .get();
    if (!existing) {
      const gov = this.decisions.getPolicy();
      const now = new Date(this.nowFn()).toISOString();
      this.db
        .prepare(
          `INSERT INTO opc_bot_arbitrator_policy
           (singleton, arbitration_mode, auto_approve_verified_releases, release_merge_mode,
            allowed_release_projects_json, blocked_release_projects_json,
            auto_close_stale_workflow_hours, max_auto_approve_cost_usd, preferred_bot_role, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          gov.botArbitrationMode ?? DEFAULT_BOT_ARBITRATOR_POLICY.arbitrationMode,
          gov.autoApproveVerifiedReleases ? 1 : 0,
          DEFAULT_BOT_ARBITRATOR_POLICY.releaseMergeMode,
          JSON.stringify(DEFAULT_BOT_ARBITRATOR_POLICY.allowedReleaseProjects),
          JSON.stringify(DEFAULT_BOT_ARBITRATOR_POLICY.blockedReleaseProjects),
          DEFAULT_BOT_ARBITRATOR_POLICY.autoCloseStaleWorkflowHours,
          DEFAULT_BOT_ARBITRATOR_POLICY.maxAutoApproveCostUsd,
          DEFAULT_BOT_ARBITRATOR_POLICY.preferredBotRole,
          now,
        );
    }
  }

  getPolicy(): BotArbitratorPolicy {
    const row = this.db
      .prepare("SELECT * FROM opc_bot_arbitrator_policy WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        ...DEFAULT_BOT_ARBITRATOR_POLICY,
        allowedReleaseProjects: [...DEFAULT_BOT_ARBITRATOR_POLICY.allowedReleaseProjects],
        blockedReleaseProjects: [...DEFAULT_BOT_ARBITRATOR_POLICY.blockedReleaseProjects],
        updatedAt: new Date(this.nowFn()).toISOString(),
      };
    }
    const mode: BotArbitrationMode = isBotArbitrationMode(row.arbitration_mode)
      ? row.arbitration_mode
      : "off";
    const mergeMode: BotReleaseMergeMode =
      row.release_merge_mode === "merge_and_deploy" ? "merge_and_deploy" : "merge_only";
    const prefRole =
      row.preferred_bot_role === "super" || row.preferred_bot_role === "rd"
        ? row.preferred_bot_role
        : "auto";
    return {
      arbitrationMode: mode,
      autoApproveVerifiedReleases: Boolean(row.auto_approve_verified_releases),
      releaseMergeMode: mergeMode,
      allowedReleaseProjects: safeJson<string[]>(
        row.allowed_release_projects_json,
        [...DEFAULT_ALLOWED_RELEASE_PROJECTS],
      ),
      blockedReleaseProjects: safeJson<string[]>(row.blocked_release_projects_json, []),
      autoCloseStaleWorkflowHours: Math.max(
        1,
        Math.min(720, Number(row.auto_close_stale_workflow_hours ?? 24) || 24),
      ),
      maxAutoApproveCostUsd: Math.max(0, Number(row.max_auto_approve_cost_usd ?? 5.0)),
      preferredBotRole: prefRole,
      updatedAt: String(row.updated_at),
    };
  }

  updatePolicy(rawPatch: BotArbitratorPolicyPatch): BotArbitratorPolicy {
    const parsed = policyPatchSchema.safeParse(rawPatch ?? {});
    if (!parsed.success) {
      throw new ApiError(
        400,
        "bad_arbitrator_policy",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / "),
      );
    }
    const patch = parsed.data;
    const current = this.getPolicy();
    const next: BotArbitratorPolicy = {
      arbitrationMode: patch.arbitrationMode ?? patch.mode ?? current.arbitrationMode,
      autoApproveVerifiedReleases:
        patch.autoApproveVerifiedReleases ?? current.autoApproveVerifiedReleases,
      releaseMergeMode: patch.releaseMergeMode ?? current.releaseMergeMode,
      allowedReleaseProjects:
        patch.allowedReleaseProjects !== undefined
          ? dedupeProjectList(patch.allowedReleaseProjects)
          : current.allowedReleaseProjects,
      blockedReleaseProjects:
        patch.blockedReleaseProjects !== undefined
          ? dedupeProjectList(patch.blockedReleaseProjects)
          : current.blockedReleaseProjects,
      autoCloseStaleWorkflowHours:
        patch.autoCloseStaleWorkflowHours ?? current.autoCloseStaleWorkflowHours,
      maxAutoApproveCostUsd:
        patch.maxAutoApproveCostUsd ?? current.maxAutoApproveCostUsd,
      preferredBotRole: patch.preferredBotRole ?? current.preferredBotRole,
      updatedAt: new Date(this.nowFn()).toISOString(),
    };

    this.db
      .prepare(
        `UPDATE opc_bot_arbitrator_policy
         SET arbitration_mode = ?,
             auto_approve_verified_releases = ?,
             release_merge_mode = ?,
             allowed_release_projects_json = ?,
             blocked_release_projects_json = ?,
             auto_close_stale_workflow_hours = ?,
             max_auto_approve_cost_usd = ?,
             preferred_bot_role = ?,
             updated_at = ?
         WHERE singleton = 1`,
      )
      .run(
        next.arbitrationMode,
        next.autoApproveVerifiedReleases ? 1 : 0,
        next.releaseMergeMode,
        JSON.stringify(next.allowedReleaseProjects),
        JSON.stringify(next.blockedReleaseProjects),
        next.autoCloseStaleWorkflowHours,
        next.maxAutoApproveCostUsd,
        next.preferredBotRole,
        next.updatedAt,
      );

    // Keep DecisionGateway governance policy synchronized
    this.decisions.updatePolicy({
      botArbitrationMode: next.arbitrationMode,
      autoApproveVerifiedReleases: next.autoApproveVerifiedReleases,
    });

    this.events?.emit({
      topic: "arbitrator.policy_updated",
      sourceDomain: "strategy",
      payload: { ...next },
    });
    return next;
  }

  listLogs(limit = 40): BotArbitrationLogRecord[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.db
      .prepare("SELECT * FROM opc_bot_arbitration_log ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapLog(r));
  }

  private mapLog(row: Record<string, unknown>): BotArbitrationLogRecord {
    return {
      id: String(row.id),
      targetKind: row.target_kind === "workflow" ? "workflow" : "decision",
      targetId: String(row.target_id),
      targetSubId: row.target_sub_id == null ? null : String(row.target_sub_id),
      targetTitle: String(row.target_title),
      itemKind: String(row.item_kind),
      mode: isBotArbitrationMode(row.mode) ? row.mode : "off",
      dryRun: Boolean(row.dry_run),
      actor: String(row.actor),
      botId: row.bot_id == null ? null : String(row.bot_id),
      botTaskId: row.bot_task_id == null ? null : String(row.bot_task_id),
      verdict: String(row.verdict) as BotArbitrationVerdictKind,
      optionId: row.option_id == null ? null : String(row.option_id),
      executed: Boolean(row.executed),
      escalated: Boolean(row.escalated),
      reason: String(row.reason),
      nextStep: String(row.next_step ?? ""),
      deterministicGate: String(row.deterministic_gate ?? ""),
      handlerResult: safeJson<Record<string, unknown> | null>(row.handler_result_json, null),
      createdAt: String(row.created_at),
    };
  }

  private latestLogByTarget(): Map<string, BotArbitrationLogRecord> {
    const rows = this.db
      .prepare(
        `SELECT * FROM opc_bot_arbitration_log
         ORDER BY created_at DESC, rowid DESC LIMIT 300`,
      )
      .all() as Array<Record<string, unknown>>;
    const map = new Map<string, BotArbitrationLogRecord>();
    for (const row of rows) {
      const log = this.mapLog(row);
      const key = `${log.targetKind}:${log.targetId}`;
      if (!map.has(key)) map.set(key, log);
    }
    return map;
  }

  private recordLog(
    item: Omit<ArbitrationItemResult, "logId">,
    meta?: {
      sourceDomain?: CompanyDepartmentId;
      mainlineId?: string | null;
      productId?: string | null;
      assetId?: string | null;
    },
  ): ArbitrationItemResult {
    if (item.dryRun) {
      return { ...item, logId: null };
    }
    const id = `arb_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const now = new Date(this.nowFn()).toISOString();
    this.db
      .prepare(
        `INSERT INTO opc_bot_arbitration_log
         (id, target_kind, target_id, target_sub_id, target_title, item_kind, mode, dry_run,
          actor, bot_id, bot_task_id, verdict, option_id, executed, escalated,
          reason, next_step, deterministic_gate, handler_result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        item.targetKind,
        item.targetId,
        item.targetSubId,
        item.targetTitle,
        item.itemKind,
        item.mode,
        0,
        item.actor,
        item.botId,
        item.botTaskId,
        item.verdict,
        item.optionId,
        item.executed ? 1 : 0,
        item.escalated ? 1 : 0,
        item.reason,
        item.nextStep,
        item.deterministicGate,
        item.handlerResult ? JSON.stringify(item.handlerResult) : null,
        now,
      );

    const sourceDomain: CompanyDepartmentId = meta?.sourceDomain ?? "strategy";
    if (item.executed) {
      this.events?.emit({
        topic: "arbitrator.item_resolved",
        sourceDomain,
        mainlineId: meta?.mainlineId ?? null,
        productId: meta?.productId ?? null,
        assetId: meta?.assetId ?? null,
        payload: {
          logId: id,
          targetKind: item.targetKind,
          targetId: item.targetId,
          targetSubId: item.targetSubId,
          itemKind: item.itemKind,
          title: item.targetTitle,
          actor: item.actor,
          verdict: item.verdict,
          optionId: item.optionId,
          reason: item.reason,
          nextStep: item.nextStep,
          deterministicGate: item.deterministicGate,
          handlerResult: item.handlerResult,
        },
      });
    } else if (item.escalated) {
      this.events?.emit({
        topic: "arbitrator.item_escalated",
        sourceDomain,
        mainlineId: meta?.mainlineId ?? null,
        productId: meta?.productId ?? null,
        assetId: meta?.assetId ?? null,
        payload: {
          logId: id,
          targetKind: item.targetKind,
          targetId: item.targetId,
          targetSubId: item.targetSubId,
          itemKind: item.itemKind,
          title: item.targetTitle,
          actor: item.actor,
          verdict: item.verdict,
          reason: item.reason,
          nextStep: item.nextStep,
          deterministicGate: item.deterministicGate,
        },
      });
    }

    return { ...item, logId: id };
  }

  private hasTable(tableName: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(tableName),
    );
  }

  private resolveBotTarget(
    preferredForItem: "super" | "rd",
    policy: BotArbitratorPolicy,
  ): { botRole: "super" | "rd"; botId: string; actor: string } {
    const desiredRole: "super" | "rd" =
      policy.preferredBotRole === "super"
        ? "super"
        : policy.preferredBotRole === "rd"
          ? "rd"
          : preferredForItem;

    let superBotId = "super-bot";
    let rdBotId: string | null = null;
    if (this.hasTable("opc_executive_state")) {
      const row = this.db
        .prepare("SELECT config FROM opc_executive_state WHERE singleton = 1")
        .get() as { config?: string } | undefined;
      const cfg = safeJson<{
        superBotId?: string;
        departmentBotIds?: Record<string, string>;
      } | null>(row?.config, null);
      if (cfg?.superBotId) superBotId = cfg.superBotId;
      if (cfg?.departmentBotIds?.rd) rdBotId = cfg.departmentBotIds.rd;
    }

    if (desiredRole === "rd" && rdBotId) {
      return { botRole: "rd", botId: rdBotId, actor: "bot:rd-vp" };
    }
    return { botRole: "super", botId: superBotId, actor: "bot:super-bot" };
  }

  private async invokeBotReviewer(req: BotReviewRequest): Promise<BotReviewVerdict> {
    if (this.botReviewer) {
      try {
        const res = await this.botReviewer(req);
        const validated = botVerdictSchema.safeParse({
          verdict: res?.verdict,
          optionId: res?.optionId,
          reason: res?.reason,
          nextStep: res?.nextStep ?? "",
        });
        if (!validated.success) {
          return {
            verdict: "escalate",
            reason: "Bot 评审器返回结构不合法，保守转人工拍板",
            nextStep: "请人工核对后拍板",
            botId: req.botId,
          };
        }
        return {
          ...validated.data,
          botId: res.botId ?? req.botId,
          botTaskId: res.botTaskId,
          rawReport: res.rawReport,
        };
      } catch (err) {
        return {
          verdict: "escalate",
          reason: `Bot 评审异常，保守转交人工拍板：${err instanceof Error ? err.message : String(err)}`,
          nextStep: "请检查 Bot 服务状态或由创始人手动处理",
          botId: req.botId,
        };
      }
    }

    const client = (this.stageHomeClient ??= new StageHomeClient());
    const idempotencyKey = `opc-arb-${req.targetKind}-${req.targetId.slice(0, 24)}-${randomUUID().slice(0, 8)}`;
    const boundedPrompt = req.prompt.slice(0, 3400);

    try {
      let task: HomeTask = await client.send(req.botId, boundedPrompt, idempotencyKey);
      const deadline = Date.now() + this.botTimeoutMs;
      while (
        ["queued", "pending", "running", "in_progress"].includes(task.status) &&
        Date.now() < deadline
      ) {
        await sleep(Math.min(this.pollIntervalMs, Math.max(50, deadline - Date.now())));
        task = await client.read(task.id);
      }

      if (task.status !== "completed") {
        const detail =
          task.failureReason ||
          (Date.now() >= deadline ? `超过 ${Math.round(this.botTimeoutMs / 1000)}s 评审超时` : `状态 ${task.status}`);
        return {
          verdict: "escalate",
          reason: `Agent Home Bot 未完成评审（${detail}），保守转交人工拍板`,
          nextStep: "可稍后重试 Bot 拍板，或在待我拍板面板中手动处置",
          botId: req.botId,
          botTaskId: task.id,
        };
      }

      const report = (task.delivery?.report || task.result || "").trim();
      const parsed = parseBotVerdictJson(report);
      if (!parsed) {
        return {
          verdict: "escalate",
          reason: "Agent Home Bot 回执未返回合规 JSON 裁决，保守转交人工拍板",
          nextStep: report.slice(0, 240) || "请查看 Agent Home 任务回执后人工决定",
          botId: req.botId,
          botTaskId: task.id,
          rawReport: report.slice(0, 2000),
        };
      }

      return {
        ...parsed,
        botId: req.botId,
        botTaskId: task.id,
        rawReport: report.slice(0, 2000),
      };
    } catch (err) {
      return {
        verdict: "escalate",
        reason: `Agent Home 暂不可达或请求失败，保守降级为人工拍板：${err instanceof Error ? err.message : String(err)}`,
        nextStep: "确认 Agent Home 运行正常后再重试，或由创始人直接拍板",
        botId: req.botId,
      };
    }
  }

  private loadReleaseAndRun(packet: DecisionPacket): {
    releaseId: string;
    release: ReleaseRow | null;
    priorSucceededReleaseId: string | null;
    run: AgentRunGateInfo | null;
  } {
    const releaseId = extractReleaseId(packet);
    let release: ReleaseRow | null = null;
    let priorSucceededReleaseId: string | null = null;
    let run: AgentRunGateInfo | null = null;

    if (releaseId && this.hasTable("opc_releases")) {
      const row = this.db
        .prepare(
          `SELECT id, run_id, task_id, project, repo_path, source_branch, target_branch, mode, status
           FROM opc_releases WHERE id = ?`,
        )
        .get(releaseId) as Record<string, unknown> | undefined;
      if (row) {
        release = {
          id: String(row.id),
          run_id: row.run_id == null ? null : String(row.run_id),
          task_id: row.task_id == null ? null : String(row.task_id),
          project: String(row.project ?? ""),
          repo_path: String(row.repo_path ?? ""),
          source_branch: String(row.source_branch ?? ""),
          target_branch: String(row.target_branch ?? "main"),
          mode: String(row.mode ?? "merge_and_deploy"),
          status: String(row.status ?? "pending_approval"),
        };

        if (release.run_id) {
          const prior = this.db
            .prepare(
              `SELECT id FROM opc_releases
               WHERE id != ? AND run_id = ? AND source_branch = ? AND target_branch = ? AND status = 'succeeded'
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(release.id, release.run_id, release.source_branch, release.target_branch) as
            | { id?: string }
            | undefined;
          if (prior?.id) {
            priorSucceededReleaseId = String(prior.id);
          }
        }
      }
    }

    const runId = release?.run_id ?? null;
    if (runId) {
      if (this.darkFactory) {
        try {
          const dfRun: AgentRunRecord = this.darkFactory.getRun(runId);
          const changedFiles = Array.isArray(dfRun.changedFiles)
            ? dfRun.changedFiles.map((f) => String(f)).filter(Boolean)
            : [];
          run = {
            id: dfRun.id,
            status: dfRun.status,
            project: dfRun.project,
            protectedViolations: Array.isArray(dfRun.protectedViolations)
              ? dfRun.protectedViolations
              : [],
            circuitBreakerReason: dfRun.circuitBreakerReason ?? null,
            verification: dfRun.verification
              ? {
                  passed: Boolean(dfRun.verification.passed),
                  command: dfRun.verification.command,
                  exitCode: dfRun.verification.exitCode,
                }
              : null,
            changedFiles,
            changedFilesCount: changedFiles.length,
          };
        } catch {
          run = null;
        }
      }
      if (!run && this.hasTable("opc_agent_runs")) {
        const runRow = this.db
          .prepare(
            `SELECT id, status, project, protected_violations, circuit_breaker_reason, verification_json, changed_files
             FROM opc_agent_runs WHERE id = ?`,
          )
          .get(runId) as Record<string, unknown> | undefined;
        if (runRow) {
          const verification = safeJson<{ passed?: boolean; command?: string; exitCode?: number } | null>(
            runRow.verification_json,
            null,
          );
          const changedFiles = safeJson<string[]>(runRow.changed_files, [])
            .map((f) => String(f))
            .filter(Boolean);
          run = {
            id: String(runRow.id),
            status: String(runRow.status ?? ""),
            project: String(runRow.project ?? ""),
            protectedViolations: safeJson<string[]>(runRow.protected_violations, []),
            circuitBreakerReason:
              runRow.circuit_breaker_reason == null ? null : String(runRow.circuit_breaker_reason),
            verification: verification
              ? {
                  passed: Boolean(verification.passed),
                  command: String(verification.command ?? ""),
                  exitCode: Number(verification.exitCode ?? -1),
                }
              : null,
            changedFiles,
            changedFilesCount: changedFiles.length,
          };
        }
      }
    }

    return { releaseId, release, priorSucceededReleaseId, run };
  }

  private collectProjectIdentifiers(packet: DecisionPacket, release: ReleaseRow | null): string[] {
    const raw = [
      release?.project,
      packet.targetSummary?.assetName,
      packet.targetSummary?.repoFullName,
      packet.targetSummary?.productName,
      ...packet.tags,
    ];
    if (packet.assetId && this.registry) {
      const asset = this.registry.getAsset(packet.assetId);
      if (asset) {
        raw.push(asset.slug, asset.name, asset.repoFullName);
      }
    }
    const out = new Set<string>();
    for (const item of raw) {
      const cleaned = (item ?? "").trim().toLowerCase();
      if (!cleaned) continue;
      out.add(cleaned);
      if (cleaned.includes("/")) {
        const tail = cleaned.split("/").pop();
        if (tail) out.add(tail);
      }
    }
    return [...out];
  }

  private listOpenWorkflows(policy: BotArbitratorPolicy): OpenWorkflowRecord[] {
    if (!this.hasTable("workflow_runs")) return [];
    const rows = this.db
      .prepare("SELECT id, created_at, snapshot FROM workflow_runs ORDER BY created_at DESC")
      .all() as Array<{ id: string; created_at: string; snapshot: string }>;

    const parsedRuns: WorkflowRun[] = [];
    for (const row of rows) {
      const run = safeJson<WorkflowRun | null>(row.snapshot, null);
      if (run && Array.isArray(run.revisions) && run.revisions.length > 0 && Array.isArray(run.cards)) {
        parsedRuns.push(run);
      }
    }

    // Track newest run per (workspace + normalized goal) to spot superseded older runs
    const newestByGoalKey = new Map<string, WorkflowRun>();
    for (const run of parsedRuns) {
      const goalKey = `${run.workspace}::${(run.request?.goal ?? "").trim().toLowerCase()}`;
      const existing = newestByGoalKey.get(goalKey);
      if (!existing || run.createdAt > existing.createdAt) {
        newestByGoalKey.set(goalKey, run);
      }
    }

    const nowMs = this.nowFn();
    const out: OpenWorkflowRecord[] = [];
    for (const run of parsedRuns) {
      const latestRevision = run.revisions[run.revisions.length - 1];
      const openCard = run.cards.find(
        (c) => c.status === "open" && c.revision === latestRevision.number,
      );
      if (!openCard) continue;

      const lastActivityAt = run.events.at(-1)?.at ?? run.createdAt;
      const lastMs = Date.parse(lastActivityAt);
      const ageHours = Number.isFinite(lastMs)
        ? Math.max(0, Math.round(((nowMs - lastMs) / 3_600_000) * 10) / 10)
        : policy.autoCloseStaleWorkflowHours;
      const workspaceExists = Boolean(run.workspace && existsSync(run.workspace));
      const goalKey = `${run.workspace}::${(run.request?.goal ?? "").trim().toLowerCase()}`;
      const newest = newestByGoalKey.get(goalKey);
      const supersededByRunId =
        newest && newest.id !== run.id && newest.createdAt > run.createdAt ? newest.id : null;

      let blockedReason: string | undefined;
      if (this.workflow) {
        try {
          blockedReason = this.workflow.get(run.id).summary.blockedReason;
        } catch {
          // ignore if unavailable
        }
      }

      out.push({
        run,
        card: openCard,
        lastActivityAt,
        ageHours,
        workspaceExists,
        supersededByRunId,
        blockedReason,
      });
    }

    return out;
  }

  getStatus(): BotArbitratorStatusResponse {
    const policy = this.getPolicy();
    const latestLogs = this.latestLogByTarget();

    const pendingDecisionPackets = this.decisions.list({ status: "pending", limit: 100 });
    const pendingDecisions: PendingDecisionSummary[] = pendingDecisionPackets.map((p) => ({
      id: p.id,
      domain: p.domain,
      kind: p.kind,
      riskLevel: p.riskLevel,
      title: p.title,
      project: p.targetSummary?.assetName ?? p.targetSummary?.productName ?? p.tags[2] ?? null,
      isRedline: Boolean(p.targetSummary?.isRedline),
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      recommendedOptionId: p.recommendedOptionId,
      admissionWarning: p.admissionWarning ?? null,
      ...(p.actionBlockReason ? { actionBlockReason: p.actionBlockReason } : {}),
      latestLog: latestLogs.get(`decision:${p.id}`) ?? null,
    }));

    const openWorkflows = this.listOpenWorkflows(policy);
    const pendingWorkflows: PendingWorkflowSummary[] = openWorkflows.map((wf) => ({
      runId: wf.run.id,
      cardId: wf.card.id,
      cardKind: wf.card.kind,
      revision: wf.card.revision,
      goal: wf.run.request.goal,
      folder: wf.run.request.folder || basename(wf.run.workspace) || "未归类",
      workspace: wf.run.workspace,
      lastActivityAt: wf.lastActivityAt,
      ageHours: wf.ageHours,
      isStale:
        wf.ageHours >= policy.autoCloseStaleWorkflowHours ||
        !wf.workspaceExists ||
        Boolean(wf.supersededByRunId),
      ...(wf.blockedReason ? { blockedReason: wf.blockedReason } : {}),
      latestLog: latestLogs.get(`workflow:${wf.run.id}`) ?? null,
    }));

    const since24h = new Date(this.nowFn() - 24 * 3_600_000).toISOString();
    const resolvedRow = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM opc_bot_arbitration_log WHERE executed = 1 AND created_at >= ?",
      )
      .get(since24h) as { n?: number } | undefined;
    const escalatedRow = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM opc_bot_arbitration_log WHERE escalated = 1 AND created_at >= ?",
      )
      .get(since24h) as { n?: number } | undefined;

    return {
      policy,
      pendingDecisions,
      pendingWorkflows,
      recentLogs: this.listLogs(40),
      counts: {
        pendingDecisions: pendingDecisions.length,
        pendingWorkflows: pendingWorkflows.length,
        staleWorkflows: pendingWorkflows.filter((w) => w.isStale).length,
        totalPending: pendingDecisions.length + pendingWorkflows.length,
        resolvedLast24h: Number(resolvedRow?.n ?? 0),
        escalatedLast24h: Number(escalatedRow?.n ?? 0),
      },
    };
  }

  private resolveEffectiveMode(
    policy: BotArbitratorPolicy,
    options: ArbitrateOptions,
  ): { effectiveMode: BotArbitrationMode; skippedReason?: string } {
    const requested = options.mode ?? policy.arbitrationMode;
    const dryRun = Boolean(options.dryRun);
    if (requested === "off") {
      if (dryRun && options.trigger !== "scheduled") {
        return { effectiveMode: "advisory" };
      }
      return {
        effectiveMode: "off",
        skippedReason: "当前 Bot 代理拍板策略为人工模式 (off)，未执行自动拍板",
      };
    }
    return { effectiveMode: requested };
  }

  private pickOptionForDecisionVerdict(
    packet: DecisionPacket,
    verdict: BotArbitrationVerdictKind,
    preferredOptionId?: string,
  ): DecisionOption | null {
    if (preferredOptionId) {
      const exact = packet.options.find((o) => o.id === preferredOptionId);
      if (exact) {
        if (
          (verdict === "approve" && exact.outcome === "approved") ||
          (verdict === "reject" && exact.outcome === "rejected") ||
          (verdict === "snooze" && exact.outcome === "snoozed") ||
          (verdict === "changes" && exact.outcome === "changes_requested")
        ) {
          return exact;
        }
      }
    }
    if (verdict === "approve") {
      const rec = packet.options.find((o) => o.id === packet.recommendedOptionId && o.outcome === "approved");
      return rec ?? packet.options.find((o) => o.outcome === "approved") ?? null;
    }
    if (verdict === "reject") {
      return packet.options.find((o) => o.outcome === "rejected") ?? null;
    }
    if (verdict === "snooze") {
      return packet.options.find((o) => o.outcome === "snoozed") ?? null;
    }
    if (verdict === "changes") {
      return packet.options.find((o) => o.outcome === "changes_requested") ?? null;
    }
    return null;
  }

  private buildDecisionPrompt(
    packet: DecisionPacket,
    releaseInfo?: {
      release: ReleaseRow | null;
      run: AgentRunGateInfo | null;
      effectiveMode?: BotArbitrationMode;
      isAllowedProject?: boolean;
      gitDiff?: { commits: string; diffStat: string } | null;
    },
    policy?: BotArbitratorPolicy,
  ): string {
    const optionsLines = packet.options.map(
      (o) => `- ${o.id} [${o.outcome}]: ${o.label}`,
    );

    if (packet.kind === "production_release" && releaseInfo?.release) {
      const { release, run, effectiveMode, isAllowedProject, gitDiff } = releaseInfo;
      const mergeMode = policy?.releaseMergeMode ?? "merge_only";
      const preferredApproveOptionId =
        mergeMode === "merge_only" ? "approve_merge_only" : "approve_deploy";
      const delegatedAuthorized =
        (effectiveMode === "delegated_safe" || effectiveMode === "full_delegated") &&
        Boolean(policy?.autoApproveVerifiedReleases) &&
        Boolean(isAllowedProject);

      const authClause = delegatedAuthorized
        ? `【创始人代理拍板授权】创始人已在 BotArbitratorPolicy 中显式开启 ${effectiveMode} + autoApproveVerifiedReleases=true，且系统确定性门禁已全部通过（单测 verification.passed=true、保护路径违规=0、项目「${release.project}」在允许白名单内）。本次批准仅执行 ${preferredApproveOptionId}（${mergeMode === "merge_only" ? "仅合入代码至主分支并复跑校验，不部署上线，失败自动回滚" : "合入并按流水线验证部署，失败自动回滚"}）。请基于下方变更文件与 Git Diff 做工程质量与安全抽检：若改动清晰、无越界或破坏性风险，直接返回 verdict="approve" 与 optionId="${preferredApproveOptionId}"；若发现代码缺陷、测试造假或敏感风险则返回 "reject" 或 "escalate"。`
        : `【工程审查预演（${effectiveMode ?? "advisory"}）】系统确定性门禁已通过（单测 PASSED、保护路径违规=0、项目「${release.project}」${isAllowedProject ? "在白名单内" : "未在白名单内"}）。本次审查不会跳过创始人策略限制，请基于下方变更文件与 Git Diff 给出纯技术裁决：若改动安全清晰适合 ${preferredApproveOptionId}，返回 verdict="approve" 与 optionId="${preferredApproveOptionId}"；若存在隐患或需人工定夺则返回 "reject" 或 "escalate"。`;

      const changedFiles = run?.changedFiles ?? [];
      let filesBlock = "";
      if (changedFiles.length > 0) {
        const listed: string[] = [];
        let charBudget = 850;
        for (const f of changedFiles.slice(0, 25)) {
          const line = `- ${f.slice(0, 140)}`;
          if (listed.length > 0 && charBudget - line.length < 0) break;
          listed.push(line);
          charBudget -= line.length + 1;
        }
        const remaining = changedFiles.length - listed.length;
        filesBlock =
          `变更文件 (${changedFiles.length}):\n${listed.join("\n")}` +
          (remaining > 0 ? `\n- ...其余 ${remaining} 个文件` : "");
      } else {
        filesBlock = extractSectionFromEvidence(packet.diffOrEvidence, "### 变更文件", 550);
      }

      const diffBlockParts: string[] = [];
      if (gitDiff?.commits) {
        diffBlockParts.push(`提交记录:\n${gitDiff.commits.slice(0, 320)}`);
      }
      if (gitDiff?.diffStat) {
        diffBlockParts.push(`Git Diff 统计:\n${gitDiff.diffStat.slice(0, 620)}`);
      }
      if (diffBlockParts.length === 0) {
        const fromEvidenceCommits = extractSectionFromEvidence(packet.diffOrEvidence, "### 提交记录", 300);
        const fromEvidenceStat = extractSectionFromEvidence(packet.diffOrEvidence, "### Git Diff 统计", 550);
        if (fromEvidenceCommits) diffBlockParts.push(fromEvidenceCommits);
        if (fromEvidenceStat) diffBlockParts.push(fromEvidenceStat);
      }

      const verifySummary = run?.verification
        ? `PASSED (exit=${run.verification.exitCode}, cmd=${run.verification.command.slice(0, 120)})`
        : "FAILED";

      const tail = ["可选动作:", ...optionsLines].join("\n");
      const bodyLines = [
        "你是 OPC OS 产研与工程部代理拍板审查 Bot。请严格只返回单个 JSON 对象（不要额外长文）：",
        '格式：{"verdict":"approve"|"reject"|"changes"|"escalate","optionId":"匹配下方选项 id","reason":"简明中文裁决理由","nextStep":"简明下一步安排"}',
        authClause,
        "",
        `审批单: ${packet.id} ｜ 发布单: ${release.id} ｜ 标题: ${packet.title.slice(0, 160)}`,
        `项目与分支: ${release.project} (${release.source_branch} -> ${release.target_branch}) ｜ 合并模式: ${mergeMode}`,
        run
          ? `确定性门禁: status=${run.status} · protectedViolations=0 · verify=${verifySummary}`
          : "",
        filesBlock,
        ...diffBlockParts,
        `背景摘要: ${packet.backgroundSummary.replace(/\s+/g, " ").slice(0, 260)}`,
      ].filter(Boolean);

      const maxBody = Math.max(400, AGENT_HOME_PROMPT_CAP - tail.length - 1);
      return `${bodyLines.join("\n").slice(0, maxBody)}\n${tail}`;
    }

    const lines = [
      "你是 OPC OS 代理拍板审查 Bot。请审慎评估以下待审批事项，严格只返回单个 JSON 对象（不要额外长文）：",
      '格式：{"verdict":"approve"|"reject"|"changes"|"snooze"|"supersede"|"escalate","optionId":"可选，匹配下列选项 id","reason":"简明中文裁决理由","nextStep":"简明下一步安排"}',
      "规则：只有在改动清晰、风险可控、证据充分时才返回 approve；若存在明显风险、信息不足或涉及高危决策请返回 escalate 或 reject。",
      "",
      `审批单 ID: ${packet.id}`,
      `类型: ${packet.domain}/${packet.kind} (risk=${packet.riskLevel})`,
      `标题: ${packet.title.slice(0, 180)}`,
      packet.costEstimateUsd != null ? `预估成本: $${packet.costEstimateUsd.toFixed(4)}` : "",
      `背景摘要:\n${packet.backgroundSummary.slice(0, 800)}`,
      packet.diffOrEvidence ? `证据/Diff 摘要:\n${packet.diffOrEvidence.slice(0, 800)}` : "",
      packet.rollbackPlan ? `回滚方案:\n${packet.rollbackPlan.slice(0, 260)}` : "",
      "可选动作:",
      ...optionsLines,
    ].filter(Boolean);

    return lines.join("\n").slice(0, AGENT_HOME_PROMPT_CAP);
  }

  private buildWorkflowPrompt(wf: OpenWorkflowRecord): string {
    const rev = wf.run.revisions[wf.run.revisions.length - 1];
    const nodeLines = rev.plan.nodes.slice(0, 8).map(
      (n) =>
        `- ${n.id} [${n.kind}] ${n.title}${n.dependsOn.length ? ` (deps: ${n.dependsOn.join(",")})` : ""}: ${n.instruction.slice(0, 220)}`,
    );
    return [
      "你是 OPC OS 产研与工程部代理拍板审查 Bot。请审查以下工作流审批卡片质量与风险，严格只返回单个 JSON 对象：",
      '格式：{"verdict":"approve"|"changes"|"reject"|"escalate","reason":"简明中文裁决理由","nextStep":"简明后续安排"}',
      "规则：计划清晰、边界明确、具备独立 review 验收且无明显破坏风险返回 approve；计划需补充细节或拆分返回 changes；明显过时/无价值返回 reject；高危或需创始人战略定夺返回 escalate。",
      "",
      `工作流 ID: ${wf.run.id}`,
      `卡片类型: ${wf.card.kind} (revision r${wf.card.revision})`,
      `工作区: ${wf.run.workspace}`,
      `目标: ${wf.run.request.goal.slice(0, 600)}`,
      wf.run.request.context ? `上下文: ${wf.run.request.context.slice(0, 500)}` : "",
      wf.run.request.constraints.length
        ? `约束: ${wf.run.request.constraints.slice(0, 5).join("；").slice(0, 400)}`
        : "",
      `计划节点 (${rev.plan.nodes.length}):`,
      ...nodeLines,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, AGENT_HOME_PROMPT_CAP);
  }

  async arbitrateDecision(
    decisionId: string,
    options: ArbitrateOptions = {},
  ): Promise<ArbitrationItemResult> {
    const packet = this.decisions.get(decisionId);
    if (!packet) {
      throw new ApiError(404, "decision_not_found", `未找到审批单：${decisionId}`);
    }

    const policy = this.getPolicy();
    const dryRun = Boolean(options.dryRun);
    const { effectiveMode, skippedReason } = this.resolveEffectiveMode(policy, options);
    const canExecute = !dryRun && (effectiveMode === "delegated_safe" || effectiveMode === "full_delegated");

    if (packet.status !== "pending") {
      return {
        logId: null,
        targetKind: "decision",
        targetId: packet.id,
        targetSubId: null,
        targetTitle: packet.title,
        itemKind: packet.kind,
        mode: effectiveMode,
        dryRun,
        actor: "policy-guard",
        botId: null,
        botTaskId: null,
        verdict: "supersede",
        optionId: null,
        executed: false,
        escalated: false,
        skipped: true,
        reason: `审批单当前状态为 ${packet.status}，无需再次拍板`,
        nextStep: "",
        deterministicGate: "already_resolved",
        handlerResult: null,
      };
    }

    if (effectiveMode === "off") {
      return {
        logId: null,
        targetKind: "decision",
        targetId: packet.id,
        targetSubId: null,
        targetTitle: packet.title,
        itemKind: packet.kind,
        mode: "off",
        dryRun,
        actor: "policy-guard",
        botId: null,
        botTaskId: null,
        verdict: "escalate",
        optionId: null,
        executed: false,
        escalated: false,
        skipped: true,
        reason: skippedReason ?? "当前策略为人工模式 (off)",
        nextStep: "请切换到 advisory / delegated_safe 模式后再由 Bot 拍板",
        deterministicGate: "mode_off",
        handlerResult: null,
      };
    }

    const lockKey = `decision:${packet.id}`;
    if (this.inFlightTargets.has(lockKey)) {
      return {
        logId: null,
        targetKind: "decision",
        targetId: packet.id,
        targetSubId: null,
        targetTitle: packet.title,
        itemKind: packet.kind,
        mode: effectiveMode,
        dryRun,
        actor: "policy-guard",
        botId: null,
        botTaskId: null,
        verdict: "escalate",
        optionId: null,
        executed: false,
        escalated: false,
        skipped: true,
        reason: "该审批单正在被并发处理中，已跳过重复执行",
        nextStep: "",
        deterministicGate: "already_in_flight",
        handlerResult: null,
      };
    }

    this.inFlightTargets.add(lockKey);
    const meta = {
      sourceDomain: packet.domain,
      mainlineId: packet.mainlineId,
      productId: packet.productId,
      assetId: packet.assetId,
    };

    try {
      // 1. Hard non-delegable invariants (NEVER auto-resolved in ANY mode)
      if (HARD_NON_DELEGABLE_KINDS.has(packet.kind)) {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: `「${packet.kind}」属于不可委托硬红线（定价/安全特例/商业止损），必须由创始人亲自拍板`,
            nextStep: "已保留待人工拍板并推送升级提醒",
            deterministicGate: "non_delegable_redline",
            handlerResult: null,
          },
          meta,
        );
      }

      // 2. Strategic redlines blocked in delegated_safe
      if (effectiveMode === "delegated_safe" && SAFE_DELEGATED_REDLINE_BLOCKLIST.has(packet.kind)) {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: `「${packet.kind}」属于战略红线项，在 delegated_safe 模式下转由创始人拍板`,
            nextStep: "请由创始人确认或评估后手动拍板",
            deterministicGate: "redline_requires_human",
            handlerResult: null,
          },
          meta,
        );
      }

      // 3. Action block guard (e.g., stale patrol_alert snapshot)
      if (packet.actionBlockReason) {
        if (packet.kind === "patrol_alert") {
          const reason = `巡检快照已过期（${packet.actionBlockReason}），自动收敛旧告警`;
          if (canExecute) {
            const superseded = this.decisions.supersede(packet.id, {
              note: formatBotNote("🤖 Bot 代理拍板（已过期自动收敛）", reason),
              actor: "bot:arbitrator",
              expectedUpdatedAt: packet.updatedAt,
              autoApproved: true,
            });
            return this.recordLog(
              {
                targetKind: "decision",
                targetId: packet.id,
                targetSubId: null,
                targetTitle: packet.title,
                itemKind: packet.kind,
                mode: effectiveMode,
                dryRun,
                actor: "bot:arbitrator",
                botId: null,
                botTaskId: null,
                verdict: "supersede",
                optionId: null,
                executed: true,
                escalated: false,
                reason,
                nextStep: "下次巡检将基于最新任务状态生成增量告警",
                deterministicGate: "stale_patrol_snapshot",
                handlerResult: superseded.handlerResult,
              },
              meta,
            );
          }
          return this.recordLog(
            {
              targetKind: "decision",
              targetId: packet.id,
              targetSubId: null,
              targetTitle: packet.title,
              itemKind: packet.kind,
              mode: effectiveMode,
              dryRun,
              actor: "policy-guard",
              botId: null,
              botTaskId: null,
              verdict: "supersede",
              optionId: null,
              executed: false,
              escalated: false,
              reason,
              nextStep: "切换至 delegated_safe 后可自动收敛此过期巡检告警",
              deterministicGate: "stale_patrol_snapshot",
              handlerResult: null,
            },
            meta,
          );
        }

        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: `审批动作受前置校验阻断：${packet.actionBlockReason}`,
            nextStep: "请人工核查阻断原因后处理",
            deterministicGate: "action_blocked",
            handlerResult: null,
          },
          meta,
        );
      }

      // 4. Kind-specific handling: production_release
      if (packet.kind === "production_release") {
        return await this.arbitrateProductionRelease(packet, policy, effectiveMode, dryRun, canExecute, meta);
      }

      // 5. Kind-specific handling: feature_admission (deterministic noise filter FIRST)
      if (packet.kind === "feature_admission") {
        const noise = isDigestOrNonActionableNoise(packet.title, packet.backgroundSummary);
        if (noise.noisy || packet.admissionWarning) {
          const reason = noise.noisy
            ? `确定性清噪拦截：${noise.reason ?? "属于资讯摘要或非具体研发任务"}`
            : `准入预警拦截：${packet.admissionWarning}`;
          const rejectOpt = this.pickOptionForDecisionVerdict(packet, "reject");
          if (canExecute && rejectOpt) {
            const resolved = await this.decisions.resolve(packet.id, {
              optionId: rejectOpt.id,
              note: formatBotNote("🤖 Bot 代理拍板（确定性清噪驳回）", reason),
              actor: "bot:arbitrator",
              expectedUpdatedAt: packet.updatedAt,
              autoApproved: true,
              botDelegated: true,
            });
            return this.recordLog(
              {
                targetKind: "decision",
                targetId: packet.id,
                targetSubId: null,
                targetTitle: packet.title,
                itemKind: packet.kind,
                mode: effectiveMode,
                dryRun,
                actor: "bot:arbitrator",
                botId: null,
                botTaskId: null,
                verdict: "reject",
                optionId: rejectOpt.id,
                executed: true,
                escalated: false,
                reason,
                nextStep: "已丢弃噪音信号，避免污染研发待办池",
                deterministicGate: "digest_noise_rejected",
                handlerResult: resolved.handlerResult,
              },
              meta,
            );
          }
          return this.recordLog(
            {
              targetKind: "decision",
              targetId: packet.id,
              targetSubId: null,
              targetTitle: packet.title,
              itemKind: packet.kind,
              mode: effectiveMode,
              dryRun,
              actor: "policy-guard",
              botId: null,
              botTaskId: null,
              verdict: "reject",
              optionId: rejectOpt?.id ?? null,
              executed: false,
              escalated: false,
              reason,
              nextStep: "建议驳回丢弃该非研发噪音信号",
              deterministicGate: "digest_noise_rejected",
              handlerResult: null,
            },
            meta,
          );
        }
      }

      // 6. Cost cap guard (for non-release items)
      if (packet.costEstimateUsd != null && packet.costEstimateUsd > policy.maxAutoApproveCostUsd) {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: `预估成本 $${packet.costEstimateUsd.toFixed(2)} 超过 Bot 自动拍板上限 $${policy.maxAutoApproveCostUsd.toFixed(2)}`,
            nextStep: "转交创始人确认成本预算",
            deterministicGate: "cost_cap_exceeded",
            handlerResult: null,
          },
          meta,
        );
      }

      // 7. Generic non-redline check in delegated_safe
      const govPolicy = this.decisions.getPolicy();
      const isGenericRedline = govPolicy.redlineKinds.includes(packet.kind);
      if (effectiveMode === "delegated_safe" && isGenericRedline) {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: `「${packet.kind}」命中治理红线列表，在 delegated_safe 模式下转交人工拍板`,
            nextStep: "请由创始人复核后决定",
            deterministicGate: "redline_requires_human",
            handlerResult: null,
          },
          meta,
        );
      }

      // 8. Invoke Agent Home Bot for substantive review
      const preferredRole = packet.kind === "feature_admission" ? "rd" : "super";
      const targetBot = this.resolveBotTarget(preferredRole, policy);
      const review = await this.invokeBotReviewer({
        targetKind: "decision",
        targetId: packet.id,
        itemKind: packet.kind,
        title: packet.title,
        botRole: targetBot.botRole,
        botId: targetBot.botId,
        actor: targetBot.actor,
        prompt: this.buildDecisionPrompt(packet, undefined, policy),
        availableOptions: packet.options.map((o) => ({
          id: o.id,
          label: o.label,
          outcome: o.outcome,
          description: o.description,
        })),
        context: {
          domain: packet.domain,
          kind: packet.kind,
          riskLevel: packet.riskLevel,
          tags: packet.tags,
          costEstimateUsd: packet.costEstimateUsd,
        },
      });

      if (review.verdict === "escalate") {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: review.reason,
            nextStep: review.nextStep,
            deterministicGate: "bot_escalated",
            handlerResult: null,
          },
          meta,
        );
      }

      if (review.verdict === "supersede") {
        if (canExecute) {
          const superseded = this.decisions.supersede(packet.id, {
            note: formatBotNote("🤖 Bot 代理拍板（覆盖收敛）", review.reason, review.nextStep),
            actor: targetBot.actor,
            expectedUpdatedAt: packet.updatedAt,
            autoApproved: true,
          });
          return this.recordLog(
            {
              targetKind: "decision",
              targetId: packet.id,
              targetSubId: null,
              targetTitle: packet.title,
              itemKind: packet.kind,
              mode: effectiveMode,
              dryRun,
              actor: targetBot.actor,
              botId: review.botId ?? targetBot.botId,
              botTaskId: review.botTaskId ?? null,
              verdict: "supersede",
              optionId: null,
              executed: true,
              escalated: false,
              reason: review.reason,
              nextStep: review.nextStep,
              deterministicGate: "passed",
              handlerResult: superseded.handlerResult,
            },
            meta,
          );
        }
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: "supersede",
            optionId: null,
            executed: false,
            escalated: false,
            reason: review.reason,
            nextStep: review.nextStep,
            deterministicGate: "advisory_only",
            handlerResult: null,
          },
          meta,
        );
      }

      const chosen = this.pickOptionForDecisionVerdict(packet, review.verdict, review.optionId);
      if (!chosen) {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: `Bot 建议 ${review.verdict}，但审批单无匹配可执行选项：${review.reason}`,
            nextStep: review.nextStep || "请人工选择具体选项",
            deterministicGate: "no_matching_option",
            handlerResult: null,
          },
          meta,
        );
      }

      if (!canExecute) {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: review.verdict,
            optionId: chosen.id,
            executed: false,
            escalated: false,
            reason: review.reason,
            nextStep: review.nextStep,
            deterministicGate: "advisory_only",
            handlerResult: null,
          },
          meta,
        );
      }

      try {
        const resolved = await this.decisions.resolve(packet.id, {
          optionId: chosen.id,
          note: formatBotNote(`🤖 Bot 代理拍板（${chosen.label}）`, review.reason, review.nextStep),
          actor: targetBot.actor,
          expectedUpdatedAt: packet.updatedAt,
          autoApproved: true,
          botDelegated: true,
        });
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: review.verdict,
            optionId: chosen.id,
            executed: true,
            escalated: false,
            reason: review.reason,
            nextStep: review.nextStep,
            deterministicGate: "passed",
            handlerResult: resolved.handlerResult,
          },
          meta,
        );
      } catch (err) {
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: "escalate",
            optionId: chosen.id,
            executed: false,
            escalated: true,
            failed: true,
            reason: `Bot 执行「${chosen.label}」失败，已转交人工：${err instanceof Error ? err.message : String(err)}`,
            nextStep: "请检查执行错误详情后由创始人处置",
            deterministicGate: "execution_error",
            handlerResult: null,
          },
          meta,
        );
      }
    } finally {
      this.inFlightTargets.delete(lockKey);
    }
  }

  private async arbitrateProductionRelease(
    packet: DecisionPacket,
    policy: BotArbitratorPolicy,
    effectiveMode: BotArbitrationMode,
    dryRun: boolean,
    canExecute: boolean,
    meta: {
      sourceDomain: CompanyDepartmentId;
      mainlineId: string | null;
      productId: string | null;
      assetId: string | null;
    },
  ): Promise<ArbitrationItemResult> {
    const { releaseId, release, priorSucceededReleaseId, run } = this.loadReleaseAndRun(packet);

    // Gate 0: Already merged / superseded / rejected release detection
    const alreadyMergedInGit =
      release && release.status === "pending_approval" && !priorSucceededReleaseId
        ? await isBranchAlreadyMergedInGit(
            release.repo_path,
            release.source_branch,
            release.target_branch || "main",
          )
        : false;

    if (release?.status === "succeeded" || priorSucceededReleaseId || alreadyMergedInGit) {
      const reason = priorSucceededReleaseId
        ? `关联暗工厂运行 ${release?.run_id} 已由先前发布单 ${priorSucceededReleaseId} 成功合入，当前重复发布单自动收敛`
        : alreadyMergedInGit
          ? `分支 ${release?.source_branch} 相对 ${release?.target_branch || "main"} 已无未合入提交（ahead=0，已合入主干），当前发布审批自动收敛`
          : `发布单 ${release?.id} 已经成功合入，当前审批项自动收敛`;
      if (canExecute) {
        const superseded = this.decisions.supersede(packet.id, {
          note: formatBotNote("🤖 Bot 代理拍板（已合入自动收敛）", reason),
          actor: "bot:arbitrator",
          expectedUpdatedAt: packet.updatedAt,
          autoApproved: true,
        });
        if (release && release.status === "pending_approval" && this.hasTable("opc_releases")) {
          this.db
            .prepare(
              "UPDATE opc_releases SET status = 'rejected', error_message = ?, completed_at = ? WHERE id = ? AND status = 'pending_approval'",
            )
            .run(reason, new Date(this.nowFn()).toISOString(), release.id);
        }
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: releaseId || null,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: "bot:arbitrator",
            botId: null,
            botTaskId: null,
            verdict: "supersede",
            optionId: null,
            executed: true,
            escalated: false,
            reason,
            nextStep: "无需重复合并",
            deterministicGate: alreadyMergedInGit ? "already_merged_in_git" : "already_merged",
            handlerResult: superseded.handlerResult,
          },
          meta,
        );
      }
      return this.recordLog(
        {
          targetKind: "decision",
          targetId: packet.id,
          targetSubId: releaseId || null,
          targetTitle: packet.title,
          itemKind: packet.kind,
          mode: effectiveMode,
          dryRun,
          actor: "policy-guard",
          botId: null,
          botTaskId: null,
          verdict: "supersede",
          optionId: null,
          executed: false,
          escalated: false,
          reason,
          nextStep: "可安全自动收敛此已合入发布单",
          deterministicGate: alreadyMergedInGit ? "already_merged_in_git" : "already_merged",
          handlerResult: null,
        },
        meta,
      );
    }

    if (release?.status === "rejected") {
      const reason = `关联发布单 ${release.id} 已被标记驳回，自动收敛残留审批项`;
      if (canExecute) {
        const superseded = this.decisions.supersede(packet.id, {
          note: formatBotNote("🤖 Bot 代理拍板（发布单已驳回收敛）", reason),
          actor: "bot:arbitrator",
          expectedUpdatedAt: packet.updatedAt,
          autoApproved: true,
        });
        return this.recordLog(
          {
            targetKind: "decision",
            targetId: packet.id,
            targetSubId: release.id,
            targetTitle: packet.title,
            itemKind: packet.kind,
            mode: effectiveMode,
            dryRun,
            actor: "bot:arbitrator",
            botId: null,
            botTaskId: null,
            verdict: "supersede",
            optionId: null,
            executed: true,
            escalated: false,
            reason,
            nextStep: "",
            deterministicGate: "release_already_rejected",
            handlerResult: superseded.handlerResult,
          },
          meta,
        );
      }
      return this.recordLog(
        {
          targetKind: "decision",
          targetId: packet.id,
          targetSubId: release.id,
          targetTitle: packet.title,
          itemKind: packet.kind,
          mode: effectiveMode,
          dryRun,
          actor: "policy-guard",
          botId: null,
          botTaskId: null,
          verdict: "supersede",
          optionId: null,
          executed: false,
          escalated: false,
          reason,
          nextStep: "",
          deterministicGate: "release_already_rejected",
          handlerResult: null,
        },
        meta,
      );
    }

    // Hard safety gates: MUST pass before Bot can even consider approving
    const failHardGate = (gate: string, reason: string, nextStep: string): ArbitrationItemResult =>
      this.recordLog(
        {
          targetKind: "decision",
          targetId: packet.id,
          targetSubId: releaseId || null,
          targetTitle: packet.title,
          itemKind: packet.kind,
          mode: effectiveMode,
          dryRun,
          actor: "policy-guard",
          botId: null,
          botTaskId: null,
          verdict: "escalate",
          optionId: null,
          executed: false,
          escalated: true,
          reason,
          nextStep,
          deterministicGate: gate,
          handlerResult: null,
        },
        meta,
      );

    if (!release) {
      return failHardGate(
        "missing_release_record",
        `未找到关联发布记录（releaseId=${releaseId || "空"}），无法核验发布门禁`,
        "请人工核对发布单与分支状态",
      );
    }
    if (release.status !== "pending_approval") {
      return failHardGate(
        "release_status_invalid",
        `关联发布单 ${release.id} 当前状态为 ${release.status}，不允许自动放行`,
        "请人工检查发布流水线记录",
      );
    }
    if (!run) {
      return failHardGate(
        "missing_run_record",
        `发布单 ${release.id} 未关联可核验的暗工厂运行记录，禁止自动放行`,
        "请人工核对分支 diff 与测试结果后拍板",
      );
    }
    if (run.status !== "completed" && run.status !== "pr_open") {
      return failHardGate(
        "run_status_not_releasable",
        `关联运行 ${run.id} 状态为 ${run.status}（要求 completed 或 pr_open），禁止自动放行`,
        "请等待运行结束或重新跑测后再审核",
      );
    }
    if (run.protectedViolations.length > 0 || run.circuitBreakerReason === "protected_path_violation") {
      return failHardGate(
        "protected_path_violation",
        `关联运行触碰人类保护路径（${run.protectedViolations.join(", ") || "protected_path_violation"}），严禁 Bot 代理批准`,
        "必须由创始人亲自审计敏感改动",
      );
    }
    if (run.verification?.passed !== true) {
      return failHardGate(
        "verification_not_passed",
        "关联运行未通过外部确定性校验（verification.passed !== true），严禁 Bot 代理批准",
        "请修复失败测试并重新通过校验",
      );
    }

    const projectIds = this.collectProjectIdentifiers(packet, release);
    const blockedSet = new Set(policy.blockedReleaseProjects.map((p) => p.toLowerCase()));
    const allowedSet = new Set(policy.allowedReleaseProjects.map((p) => p.toLowerCase()));
    const isBlockedProject = projectIds.some((id) => blockedSet.has(id));
    if (isBlockedProject) {
      return failHardGate(
        "project_blocked",
        `项目「${release.project}」位于受保护禁止自动发版列表（blockedReleaseProjects），必须由创始人拍板`,
        "请创始人亲自审计并拍板发布",
      );
    }

    const isAllowedProject = allowedSet.has("*") || projectIds.some((id) => allowedSet.has(id));
    const costExceeded =
      packet.costEstimateUsd != null && packet.costEstimateUsd > policy.maxAutoApproveCostUsd;

    if (canExecute) {
      if (!policy.autoApproveVerifiedReleases) {
        return failHardGate(
          "auto_release_disabled",
          "当前未开启「自动放行校验全绿的代码发布 (autoApproveVerifiedReleases)」，转由创始人拍板",
          "如需 Bot 自动合并测试全绿分支，请勾选开启 autoApproveVerifiedReleases",
        );
      }
      if (!isAllowedProject) {
        return failHardGate(
          "project_not_allowlisted",
          `项目「${release.project}」不在允许自动发版白名单（allowedReleaseProjects）中，转由创始人拍板`,
          "可将该项目加入 allowedReleaseProjects 或由创始人手动批准",
        );
      }
      if (costExceeded) {
        return failHardGate(
          "cost_cap_exceeded",
          `发布单成本 $${packet.costEstimateUsd!.toFixed(2)} 超过上限 $${policy.maxAutoApproveCostUsd.toFixed(2)}`,
          "转交创始人确认成本后拍板",
        );
      }
    }

    // All hard deterministic safety gates passed -> gather live git diff stat & invoke Agent Home Bot
    const gitDiff = await readGitReleaseDiffSummary(
      release.repo_path,
      release.source_branch,
      release.target_branch || "main",
    );
    const targetBot = this.resolveBotTarget("rd", policy);
    const review = await this.invokeBotReviewer({
      targetKind: "decision",
      targetId: packet.id,
      itemKind: packet.kind,
      title: packet.title,
      botRole: targetBot.botRole,
      botId: targetBot.botId,
      actor: targetBot.actor,
      prompt: this.buildDecisionPrompt(
        packet,
        {
          release,
          run,
          effectiveMode,
          isAllowedProject,
          gitDiff,
        },
        policy,
      ),
      availableOptions: packet.options.map((o) => ({
        id: o.id,
        label: o.label,
        outcome: o.outcome,
        description: o.description,
      })),
      context: {
        releaseId: release.id,
        project: release.project,
        sourceBranch: release.source_branch,
        targetBranch: release.target_branch,
        releaseMergeMode: policy.releaseMergeMode,
        verificationPassed: true,
        protectedViolations: 0,
        runStatus: run.status,
        changedFiles: run.changedFiles,
        gitDiffStat: gitDiff?.diffStat ?? "",
      },
    });

    // If Bot does NOT approve or reject -> escalate
    if (review.verdict !== "approve" && review.verdict !== "reject") {
      return this.recordLog(
        {
          targetKind: "decision",
          targetId: packet.id,
          targetSubId: release.id,
          targetTitle: packet.title,
          itemKind: packet.kind,
          mode: effectiveMode,
          dryRun,
          actor: targetBot.actor,
          botId: review.botId ?? targetBot.botId,
          botTaskId: review.botTaskId ?? null,
          verdict: review.verdict === "changes" ? "changes" : "escalate",
          optionId: null,
          executed: false,
          escalated: true,
          reason: review.reason,
          nextStep: review.nextStep || "Bot 审查未放行，已转交创始人/Plannotator 人工拍板",
          deterministicGate: "bot_did_not_approve",
          handlerResult: null,
        },
        meta,
      );
    }

    // Strictly map approved release option to policy.releaseMergeMode (Bot cannot elevate merge_only -> merge_and_deploy!)
    let chosenOption: DecisionOption | null = null;
    if (review.verdict === "approve") {
      if (policy.releaseMergeMode === "merge_only") {
        chosenOption =
          packet.options.find(
            (o) =>
              o.outcome === "approved" &&
              (o.handlerKey === "factory.release_merge_only" || o.id === "approve_merge_only"),
          ) ?? null;
        if (!chosenOption) {
          return failHardGate(
            "missing_merge_only_option",
            "当前策略要求仅合并代码 (merge_only)，但该审批单缺少 merge_only 选项，拒绝隐式升级为上线部署",
            "请人工确认是否执行上线部署",
          );
        }
      } else {
        chosenOption =
          packet.options.find(
            (o) =>
              o.outcome === "approved" &&
              (o.handlerKey === "factory.release_execute" || o.id === "approve_deploy"),
          ) ??
          packet.options.find((o) => o.outcome === "approved") ??
          null;
      }
    } else {
      chosenOption =
        packet.options.find(
          (o) =>
            o.outcome === "rejected" &&
            (o.handlerKey === "factory.release_reject" || o.id === "reject_release"),
        ) ??
        packet.options.find((o) => o.outcome === "rejected") ??
        null;
    }

    if (!chosenOption) {
      return failHardGate(
        "no_matching_option",
        `发布审批单缺少与 ${review.verdict} 匹配的动作选项`,
        "请人工处理该发布单",
      );
    }

    if (!canExecute) {
      const advisoryNote =
        !policy.autoApproveVerifiedReleases || !isAllowedProject
          ? `（注：当前策略${!policy.autoApproveVerifiedReleases ? "未开启 autoApproveVerifiedReleases" : `项目 ${release.project} 不在白名单`}，仅输出建议）`
          : "";
      return this.recordLog(
        {
          targetKind: "decision",
          targetId: packet.id,
          targetSubId: release.id,
          targetTitle: packet.title,
          itemKind: packet.kind,
          mode: effectiveMode,
          dryRun,
          actor: targetBot.actor,
          botId: review.botId ?? targetBot.botId,
          botTaskId: review.botTaskId ?? null,
          verdict: review.verdict,
          optionId: chosenOption.id,
          executed: false,
          escalated: false,
          reason: `${review.reason}${advisoryNote}`,
          nextStep: review.nextStep || `建议动作：${chosenOption.label}`,
          deterministicGate: "advisory_only",
          handlerResult: null,
        },
        meta,
      );
    }

    try {
      const resolved = await this.decisions.resolve(packet.id, {
        optionId: chosenOption.id,
        note: formatBotNote(
          review.verdict === "approve"
            ? `🤖 Bot 代理拍板（校验全绿 · ${chosenOption.label}）`
            : "🤖 Bot 代理拍板（驳回发布）",
          review.reason,
          review.nextStep,
        ),
        actor: targetBot.actor,
        expectedUpdatedAt: packet.updatedAt,
        autoApproved: true,
        botDelegated: true,
        botContext: {
          arbitrationMode: effectiveMode,
          releaseVerificationPassed: true,
          protectedViolationsCount: 0,
          runStatus: run.status,
        },
      });
      return this.recordLog(
        {
          targetKind: "decision",
          targetId: packet.id,
          targetSubId: release.id,
          targetTitle: packet.title,
          itemKind: packet.kind,
          mode: effectiveMode,
          dryRun,
          actor: targetBot.actor,
          botId: review.botId ?? targetBot.botId,
          botTaskId: review.botTaskId ?? null,
          verdict: review.verdict,
          optionId: chosenOption.id,
          executed: true,
          escalated: false,
          reason: review.reason,
          nextStep: review.nextStep,
          deterministicGate: "release_gates_passed",
          handlerResult: resolved.handlerResult,
        },
        meta,
      );
    } catch (err) {
      return this.recordLog(
        {
          targetKind: "decision",
          targetId: packet.id,
          targetSubId: release.id,
          targetTitle: packet.title,
          itemKind: packet.kind,
          mode: effectiveMode,
          dryRun,
          actor: targetBot.actor,
          botId: review.botId ?? targetBot.botId,
          botTaskId: review.botTaskId ?? null,
          verdict: "escalate",
          optionId: chosenOption.id,
          executed: false,
          escalated: true,
          failed: true,
          reason: `发布执行失败，已转人工排查：${err instanceof Error ? err.message : String(err)}`,
          nextStep: "请检查仓库工作区状态与发布日志",
          deterministicGate: "release_execution_failed",
          handlerResult: null,
        },
        meta,
      );
    }
  }

  private executeWorkflowDecision(
    runId: string,
    input: { cardId: string; revision: number; action: "approve" | "changes" | "reject"; note: string },
    actor: string,
  ): WorkflowDetail {
    if (this.workflowDecider) {
      return this.workflowDecider(runId, input, actor);
    }
    if (!this.workflow) {
      throw new ApiError(409, "workflow_executor_paused", "当前未启用工作流执行器，无法代批工作流卡片");
    }
    return this.workflow.decide(runId, input, actor);
  }

  async arbitrateWorkflow(
    runId: string,
    options: ArbitrateOptions = {},
  ): Promise<ArbitrationItemResult> {
    const policy = this.getPolicy();
    const dryRun = Boolean(options.dryRun);
    const { effectiveMode, skippedReason } = this.resolveEffectiveMode(policy, options);
    const canExecute = !dryRun && (effectiveMode === "delegated_safe" || effectiveMode === "full_delegated");

    const openWorkflows = this.listOpenWorkflows(policy);
    const wf = openWorkflows.find((item) => item.run.id === runId);
    if (!wf) {
      // Distinguish missing run vs no open card
      const exists =
        this.hasTable("workflow_runs") &&
        Boolean(this.db.prepare("SELECT 1 FROM workflow_runs WHERE id = ?").get(runId));
      if (!exists) {
        throw new ApiError(404, "workflow_missing", `未找到工作流运行：${runId}`);
      }
      return {
        logId: null,
        targetKind: "workflow",
        targetId: runId,
        targetSubId: null,
        targetTitle: runId,
        itemKind: "workflow:none",
        mode: effectiveMode,
        dryRun,
        actor: "policy-guard",
        botId: null,
        botTaskId: null,
        verdict: "supersede",
        optionId: null,
        executed: false,
        escalated: false,
        skipped: true,
        reason: "该工作流当前没有待处理的审批卡片",
        nextStep: "",
        deterministicGate: "no_open_card",
        handlerResult: null,
      };
    }

    const itemKind = `workflow:${wf.card.kind}`;
    const targetTitle = wf.run.request.goal;

    if (effectiveMode === "off") {
      return {
        logId: null,
        targetKind: "workflow",
        targetId: wf.run.id,
        targetSubId: wf.card.id,
        targetTitle,
        itemKind,
        mode: "off",
        dryRun,
        actor: "policy-guard",
        botId: null,
        botTaskId: null,
        verdict: "escalate",
        optionId: null,
        executed: false,
        escalated: false,
        skipped: true,
        reason: skippedReason ?? "当前策略为人工模式 (off)",
        nextStep: "请切换到 advisory / delegated_safe 模式后再由 Bot 拍板",
        deterministicGate: "mode_off",
        handlerResult: null,
      };
    }

    const lockKey = `workflow:${wf.run.id}`;
    if (this.inFlightTargets.has(lockKey)) {
      return {
        logId: null,
        targetKind: "workflow",
        targetId: wf.run.id,
        targetSubId: wf.card.id,
        targetTitle,
        itemKind,
        mode: effectiveMode,
        dryRun,
        actor: "policy-guard",
        botId: null,
        botTaskId: null,
        verdict: "escalate",
        optionId: null,
        executed: false,
        escalated: false,
        skipped: true,
        reason: "该工作流卡片正在并发处理中，已跳过重复执行",
        nextStep: "",
        deterministicGate: "already_in_flight",
        handlerResult: null,
      };
    }

    this.inFlightTargets.add(lockKey);
    const meta = { sourceDomain: "factory" as CompanyDepartmentId };

    try {
      // 1. Deterministic stale / missing workspace / superseded check
      const isStale =
        wf.ageHours >= policy.autoCloseStaleWorkflowHours ||
        !wf.workspaceExists ||
        Boolean(wf.supersededByRunId);

      if (isStale) {
        const staleGate = !wf.workspaceExists
          ? "workspace_missing"
          : wf.supersededByRunId
            ? "superseded_workflow"
            : "stale_workflow";
        const staleReason = !wf.workspaceExists
          ? `已过期自动收敛：工作区目录已不存在（${wf.run.workspace}）`
          : wf.supersededByRunId
            ? `已过期自动收敛：已被更新的工作流运行 ${wf.supersededByRunId} 覆盖`
            : `已过期自动收敛：该 ${wf.card.kind} 审批卡片已静默 ${Math.floor(wf.ageHours)} 小时（超过阈值 ${policy.autoCloseStaleWorkflowHours} 小时）`;

        if (canExecute) {
          try {
            const updated = this.executeWorkflowDecision(
              wf.run.id,
              {
                cardId: wf.card.id,
                revision: wf.card.revision,
                action: "reject",
                note: staleReason,
              },
              "bot:arbitrator",
            );
            return this.recordLog(
              {
                targetKind: "workflow",
                targetId: wf.run.id,
                targetSubId: wf.card.id,
                targetTitle,
                itemKind,
                mode: effectiveMode,
                dryRun,
                actor: "bot:arbitrator",
                botId: null,
                botTaskId: null,
                verdict: "supersede",
                optionId: "reject",
                executed: true,
                escalated: false,
                reason: staleReason,
                nextStep: "如需继续推进，请基于最新代码基线重新提交计划",
                deterministicGate: staleGate,
                handlerResult: {
                  runId: updated.id,
                  phase: updated.summary.phase,
                  turn: updated.summary.turn,
                },
              },
              meta,
            );
          } catch (err) {
            return this.recordLog(
              {
                targetKind: "workflow",
                targetId: wf.run.id,
                targetSubId: wf.card.id,
                targetTitle,
                itemKind,
                mode: effectiveMode,
                dryRun,
                actor: "bot:arbitrator",
                botId: null,
                botTaskId: null,
                verdict: "escalate",
                optionId: "reject",
                executed: false,
                escalated: true,
                failed: true,
                reason: `关闭过期工作流卡片失败：${err instanceof Error ? err.message : String(err)}`,
                nextStep: "请检查工作流执行器配置或手动关闭该卡片",
                deterministicGate: "workflow_execution_failed",
                handlerResult: null,
              },
              meta,
            );
          }
        }

        return this.recordLog(
          {
            targetKind: "workflow",
            targetId: wf.run.id,
            targetSubId: wf.card.id,
            targetTitle,
            itemKind,
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "supersede",
            optionId: "reject",
            executed: false,
            escalated: false,
            reason: staleReason,
            nextStep: "切换至 delegated_safe 后可自动收敛关闭",
            deterministicGate: staleGate,
            handlerResult: null,
          },
          meta,
        );
      }

      // 2. Fresh workflow card checks
      if (wf.blockedReason && wf.card.kind === "plan") {
        return this.recordLog(
          {
            targetKind: "workflow",
            targetId: wf.run.id,
            targetSubId: wf.card.id,
            targetTitle,
            itemKind,
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: `工作流计划卡片被执行器状态阻断：${wf.blockedReason}`,
            nextStep: "需先恢复执行器配置或重新提交修订计划",
            deterministicGate: "workflow_backend_mismatch",
            handlerResult: null,
          },
          meta,
        );
      }

      // Final acceptance cards: escalate in delegated_safe; in full_delegated require all checks green
      if (wf.card.kind === "final") {
        if (effectiveMode === "delegated_safe") {
          return this.recordLog(
            {
              targetKind: "workflow",
              targetId: wf.run.id,
              targetSubId: wf.card.id,
              targetTitle,
              itemKind,
              mode: effectiveMode,
              dryRun,
              actor: "policy-guard",
              botId: null,
              botTaskId: null,
              verdict: "escalate",
              optionId: null,
              executed: false,
              escalated: true,
              reason: "最终验收卡片在 delegated_safe 模式下保留给创始人终审拍板",
              nextStep: "请核对验收证据后由创始人确认通过",
              deterministicGate: "final_acceptance_requires_human",
              handlerResult: null,
            },
            meta,
          );
        }
        if (effectiveMode === "full_delegated") {
          const rev = wf.run.revisions[wf.run.revisions.length - 1];
          const acceptanceOk = rev.plan.acceptance.every((nodeId) => {
            const latest = wf.run.attempts.findLast((a) => a.nodeId === nodeId);
            return (
              latest?.state === "succeeded" &&
              latest.evidence?.outcome === "succeeded" &&
              latest.evidence.checks.length > 0 &&
              latest.evidence.checks.every((chk) => chk.exitCode === 0)
            );
          });
          if (!acceptanceOk) {
            return this.recordLog(
              {
                targetKind: "workflow",
                targetId: wf.run.id,
                targetSubId: wf.card.id,
                targetTitle,
                itemKind,
                mode: effectiveMode,
                dryRun,
                actor: "policy-guard",
                botId: null,
                botTaskId: null,
                verdict: "escalate",
                optionId: null,
                executed: false,
                escalated: true,
                reason: "最终验收卡片缺少全部通过的独立验收检查证据，禁止自动放行",
                nextStep: "请人工核查验收回执与测试结果",
                deterministicGate: "acceptance_checks_incomplete",
                handlerResult: null,
              },
              meta,
            );
          }
        }
      }

      // 3. Invoke Agent Home Bot for plan/gate/final quality evaluation
      const targetBot = this.resolveBotTarget("rd", policy);
      const review = await this.invokeBotReviewer({
        targetKind: "workflow",
        targetId: wf.run.id,
        itemKind,
        title: targetTitle,
        botRole: targetBot.botRole,
        botId: targetBot.botId,
        actor: targetBot.actor,
        prompt: this.buildWorkflowPrompt(wf),
        availableOptions: [
          { id: "approve", label: "批准执行", outcome: "approved" },
          { id: "changes", label: "要求修改计划", outcome: "changes_requested" },
          { id: "reject", label: "拒绝关闭", outcome: "rejected" },
        ],
        context: {
          runId: wf.run.id,
          cardId: wf.card.id,
          cardKind: wf.card.kind,
          revision: wf.card.revision,
          workspace: wf.run.workspace,
          ageHours: wf.ageHours,
        },
      });

      const mappedAction: "approve" | "changes" | "reject" | null =
        review.verdict === "approve"
          ? "approve"
          : review.verdict === "changes"
            ? "changes"
            : review.verdict === "reject" || review.verdict === "supersede"
              ? "reject"
              : null;

      if (!mappedAction) {
        return this.recordLog(
          {
            targetKind: "workflow",
            targetId: wf.run.id,
            targetSubId: wf.card.id,
            targetTitle,
            itemKind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            reason: review.reason,
            nextStep: review.nextStep || "请创始人审阅工作流计划并拍板",
            deterministicGate: "bot_escalated",
            handlerResult: null,
          },
          meta,
        );
      }

      if (!canExecute) {
        return this.recordLog(
          {
            targetKind: "workflow",
            targetId: wf.run.id,
            targetSubId: wf.card.id,
            targetTitle,
            itemKind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: review.verdict,
            optionId: mappedAction,
            executed: false,
            escalated: false,
            reason: review.reason,
            nextStep: review.nextStep,
            deterministicGate: "advisory_only",
            handlerResult: null,
          },
          meta,
        );
      }

      try {
        const updated = this.executeWorkflowDecision(
          wf.run.id,
          {
            cardId: wf.card.id,
            revision: wf.card.revision,
            action: mappedAction,
            note: formatBotNote("🤖 Bot 代理拍板", review.reason, review.nextStep),
          },
          targetBot.actor,
        );
        return this.recordLog(
          {
            targetKind: "workflow",
            targetId: wf.run.id,
            targetSubId: wf.card.id,
            targetTitle,
            itemKind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: review.verdict,
            optionId: mappedAction,
            executed: true,
            escalated: false,
            reason: review.reason,
            nextStep: review.nextStep,
            deterministicGate: "passed",
            handlerResult: {
              runId: updated.id,
              phase: updated.summary.phase,
              turn: updated.summary.turn,
            },
          },
          meta,
        );
      } catch (err) {
        return this.recordLog(
          {
            targetKind: "workflow",
            targetId: wf.run.id,
            targetSubId: wf.card.id,
            targetTitle,
            itemKind,
            mode: effectiveMode,
            dryRun,
            actor: targetBot.actor,
            botId: review.botId ?? targetBot.botId,
            botTaskId: review.botTaskId ?? null,
            verdict: "escalate",
            optionId: mappedAction,
            executed: false,
            escalated: true,
            failed: true,
            reason: `工作流审批执行失败，已转交人工：${err instanceof Error ? err.message : String(err)}`,
            nextStep: "请检查工作流状态或由创始人手动处理",
            deterministicGate: "workflow_execution_failed",
            handlerResult: null,
          },
          meta,
        );
      }
    } finally {
      this.inFlightTargets.delete(lockKey);
    }
  }

  async arbitratePending(input: ArbitratePendingInput = {}): Promise<ArbitrationBatchReport> {
    const startedAt = new Date(this.nowFn()).toISOString();
    const policy = this.getPolicy();
    const dryRun = Boolean(input.dryRun);
    const { effectiveMode, skippedReason } = this.resolveEffectiveMode(policy, input);

    if (effectiveMode === "off") {
      return {
        mode: policy.arbitrationMode,
        effectiveMode: "off",
        dryRun,
        skippedReason,
        startedAt,
        finishedAt: new Date(this.nowFn()).toISOString(),
        totalProcessed: 0,
        executedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        changesRequestedCount: 0,
        snoozedCount: 0,
        closedStaleCount: 0,
        escalatedCount: 0,
        advisoryCount: 0,
        failedCount: 0,
        items: [],
      };
    }

    const scope = input.scope ?? "all";
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const items: ArbitrationItemResult[] = [];
    const perItemOpts: ArbitrateOptions = {
      dryRun,
      mode: effectiveMode,
      trigger: input.trigger,
    };

    if (scope === "all" || scope === "decisions") {
      const targetDecisionIds = input.decisionIds?.length
        ? [...new Set(input.decisionIds)]
        : this.decisions
            .list({ status: "pending", limit })
            .map((p) => p.id);

      for (const id of targetDecisionIds) {
        if (items.length >= limit) break;
        try {
          items.push(await this.arbitrateDecision(id, perItemOpts));
        } catch (err) {
          items.push({
            logId: null,
            targetKind: "decision",
            targetId: id,
            targetSubId: null,
            targetTitle: id,
            itemKind: "unknown",
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            failed: true,
            reason: err instanceof Error ? err.message : String(err),
            nextStep: "",
            deterministicGate: "lookup_error",
            handlerResult: null,
          });
        }
      }
    }

    if (scope === "all" || scope === "workflows") {
      const targetWorkflowIds = input.workflowIds?.length
        ? [...new Set(input.workflowIds)]
        : this.listOpenWorkflows(policy).map((wf) => wf.run.id);

      for (const runId of targetWorkflowIds) {
        if (items.length >= limit) break;
        try {
          items.push(await this.arbitrateWorkflow(runId, perItemOpts));
        } catch (err) {
          items.push({
            logId: null,
            targetKind: "workflow",
            targetId: runId,
            targetSubId: null,
            targetTitle: runId,
            itemKind: "workflow:unknown",
            mode: effectiveMode,
            dryRun,
            actor: "policy-guard",
            botId: null,
            botTaskId: null,
            verdict: "escalate",
            optionId: null,
            executed: false,
            escalated: true,
            failed: true,
            reason: err instanceof Error ? err.message : String(err),
            nextStep: "",
            deterministicGate: "lookup_error",
            handlerResult: null,
          });
        }
      }
    }

    const executed = items.filter((i) => i.executed);
    return {
      mode: policy.arbitrationMode,
      effectiveMode,
      dryRun,
      startedAt,
      finishedAt: new Date(this.nowFn()).toISOString(),
      totalProcessed: items.length,
      executedCount: executed.length,
      approvedCount: executed.filter((i) => i.verdict === "approve").length,
      rejectedCount: executed.filter((i) => i.verdict === "reject").length,
      changesRequestedCount: executed.filter((i) => i.verdict === "changes").length,
      snoozedCount: executed.filter((i) => i.verdict === "snooze").length,
      closedStaleCount: executed.filter((i) => i.verdict === "supersede").length,
      escalatedCount: items.filter((i) => i.escalated).length,
      advisoryCount: items.filter((i) => !i.executed && !i.escalated && !i.skipped).length,
      failedCount: items.filter((i) => i.failed).length,
      items,
    };
  }
}

export function registerBotArbitratorRoutes(
  app: Hono,
  db: DatabaseSync,
  deps: RegisterBotArbitratorDeps,
): BotArbitratorService {
  const service = new BotArbitratorService(db, deps);
  const { permits } = submitAuth(deps.submitToken);
  const base = "/api/opc/arbitrator";

  app.use(`${base}/*`, async (c, next) => {
    if (!permits(c)) {
      deps.requireUser(c);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get(`${base}/status`, (c) => {
    return c.json(service.getStatus());
  });

  app.patch(`${base}/policy`, async (c) => {
    const body = await parseOptionalJsonBody(c);
    const policy = service.updatePolicy(body as BotArbitratorPolicyPatch);
    return c.json({ policy });
  });

  app.post(`${base}/run`, async (c) => {
    const raw = await parseOptionalJsonBody(c);
    const parsed = runBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "bad_arbitrator_run_input",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / "),
      );
    }
    const report = await service.arbitratePending({
      ...parsed.data,
      trigger: "manual",
    });
    return c.json(report);
  });

  app.post(`${base}/decisions/:id`, async (c) => {
    const raw = await parseOptionalJsonBody(c);
    const parsed = singleItemBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "bad_arbitrator_input",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / "),
      );
    }
    const result = await service.arbitrateDecision(c.req.param("id"), {
      ...parsed.data,
      trigger: "manual",
    });
    return c.json({ result, policy: service.getPolicy() });
  });

  app.post(`${base}/workflows/:id`, async (c) => {
    const raw = await parseOptionalJsonBody(c);
    const parsed = singleItemBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "bad_arbitrator_input",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / "),
      );
    }
    const result = await service.arbitrateWorkflow(c.req.param("id"), {
      ...parsed.data,
      trigger: "manual",
    });
    return c.json({ result, policy: service.getPolicy() });
  });

  return service;
}
