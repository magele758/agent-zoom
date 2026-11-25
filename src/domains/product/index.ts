import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context, Hono } from "hono";
import {
  cleanMarkdownPreview,
  isDigestOrNonActionableNoise,
  stripCandidateTitlePrefix,
} from "../../kernel/admission-filter.ts";
import type { OpcKernel } from "../../kernel/index.ts";
import type {
  DecisionPacket,
  DepartmentHealth,
  DepartmentModule,
  DomainEventRecord,
} from "../../kernel/types.ts";
import { ApiError } from "../../server/logic.ts";
import type { TaskPlanningStore } from "../../server/task-planning.ts";
import { patrolActionBlockReason } from "./patrol-decision.ts";
import type {
  CreateEpicSubtaskInput,
  PatrolReport,
  PlanningTask,
  PlanningTaskType,
} from "../../task-planning-types.ts";
import type {
  CandidateEvaluationResult,
  CandidateRecommendation,
  StrategyDepartment,
} from "../strategy/index.ts";

export type SignalStatus = "new" | "promoted" | "dropped" | "blocked";

export interface SignalRecord {
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
  recommendation: CandidateRecommendation;
  scoreSummary: string;
  status: SignalStatus;
  promotedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestSignalInput {
  dedupeKey?: string;
  source?: string;
  projectRef?: string;
  projectOrAssetRef?: string;
  title: string;
  body?: string;
  description?: string;
  tags?: string[];
  estimatedCostUsd?: number;
  isEmergencyBug?: boolean;
  autoPromote?: boolean;
  proposeDecisionIfBorderline?: boolean;
  priority?: number;
  taskType?: PlanningTaskType;
}

export interface IngestSignalResult {
  signal: SignalRecord;
  created: boolean;
  evaluation: CandidateEvaluationResult | null;
  promotedTask: PlanningTask | null;
  decisionPacket: DecisionPacket | null;
}

export interface PromoteSignalOptions {
  priority?: number;
  type?: PlanningTaskType;
  verifyCommand?: string;
  dependsOn?: string[];
  subtasks?: CreateEpicSubtaskInput[];
  isEmergencyBug?: boolean;
}

export interface CollectSourcesOptions {
  maxJournalFiles?: number;
  autoPromote?: boolean;
  proposeDecisionIfBorderline?: boolean;
}

export interface CollectSourcesResult {
  collectedCount: number;
  journalSignals: number;
  githubIssueSignals: number;
  promotedCount: number;
  signals: SignalRecord[];
}

export interface ProductDepartmentOptions {
  kernel: OpcKernel;
  strategy: StrategyDepartment;
  taskPlanning: TaskPlanningStore;
  journalDir?: string;
  autoCollectIntervalMs?: number;
  autoPromote?: boolean;
  proposeDecisionIfBorderline?: boolean;
}

const JOURNAL_FILE_REGEX = /^\d{4}-\d{2}-\d{2}\.md$/;

const JOURNAL_ACTION_CONTAINER_HEADINGS = new Set([
  "行动项",
  "待办",
  "待办事项",
  "下一步",
  "下一步行动",
  "研发提案",
  "开发计划",
  "action items",
  "action item",
  "todo",
  "todos",
  "next steps",
]);

interface ExtractedJournalItem {
  title: string;
  body: string;
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function shortHash(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

function dedupeStrings(items?: string[]): string[] {
  if (!items?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = String(raw).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function parseTaskIdsFromPayload(payload?: Record<string, unknown>): string[] {
  if (!payload) return [];
  const out: string[] = [];
  if (Array.isArray(payload.taskIds)) {
    for (const id of payload.taskIds) {
      const s = String(id ?? "").trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  if (typeof payload.taskId === "string" && payload.taskId.trim()) {
    const s = payload.taskId.trim();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function extractJournalActionableItems(markdown: string): ExtractedJournalItem[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { heading: match[2].trim(), lines: [] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  const extracted: ExtractedJournalItem[] = [];
  const seenTitles = new Set<string>();
  const pushCandidate = (rawTitle: string, rawBody: string) => {
    const cleanedTitle = stripCandidateTitlePrefix(rawTitle).slice(0, 240);
    if (!cleanedTitle) return;
    if (isDigestOrNonActionableNoise(cleanedTitle, rawBody).noisy) return;
    const key = cleanedTitle.toLowerCase();
    if (seenTitles.has(key)) return;
    seenTitles.add(key);
    extracted.push({
      title: cleanedTitle,
      body: rawBody.slice(0, 2000),
    });
  };

  for (const sec of sections) {
    const headingLower = sec.heading.trim().toLowerCase();
    const rawBody = sec.lines.join("\n").trim();

    // Only extract from explicit action/todo sections or explicit unchecked `- [ ]` task items.
    // Never turn arbitrary news/digest headings (e.g. Twitter / GitHub Trending roundups) into dev proposals.
    if (JOURNAL_ACTION_CONTAINER_HEADINGS.has(headingLower)) {
      const checklistMatches = sec.lines
        .map((l) => /^\s*-\s*\[\s*\]\s+(.+?)\s*$/.exec(l)?.[1]?.trim())
        .filter((x): x is string => Boolean(x));
      if (checklistMatches.length > 0) {
        for (const item of checklistMatches) {
          pushCandidate(item, rawBody);
        }
      } else {
        const plainBullets = sec.lines
          .map((l) => /^\s*[-*]\s+(.+?)\s*$/.exec(l)?.[1]?.trim())
          .filter((x): x is string => Boolean(x && !x.startsWith("[x]") && !x.startsWith("[X]")));
        for (const bullet of plainBullets) {
          pushCandidate(bullet, rawBody);
        }
      }
      continue;
    }

    // Outside action containers, ONLY rescue explicit unchecked `- [ ]` checklist tasks
    for (const l of sec.lines) {
      const unchecked = /^\s*-\s*\[\s*\]\s+(.+?)\s*$/.exec(l)?.[1]?.trim();
      if (unchecked) {
        pushCandidate(unchecked, `${sec.heading}\n\n${rawBody}`.trim());
      }
    }
  }

  return extracted;
}

async function readJsonBody(c: Context, optional = false): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) {
    if (optional) return {};
    throw new ApiError(400, "bad_json", "请求体不能为空");
  }
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

export class ProductDepartment implements DepartmentModule {
  readonly id = "product" as const;
  private readonly kernel: OpcKernel;
  private readonly strategy: StrategyDepartment;
  private readonly taskPlanning: TaskPlanningStore;
  private readonly journalDir: string;
  private readonly autoCollectIntervalMs: number;
  private readonly defaultAutoPromote: boolean;
  private readonly defaultProposeBorderline: boolean;

  private collectTimer: ReturnType<typeof setInterval> | null = null;
  private collectingPromise: Promise<CollectSourcesResult> | null = null;
  private unsubscribeCrashBug: (() => void) | null = null;
  private unsubscribePatrol: (() => void) | null = null;
  private unsubscribeEpicComplete: (() => void) | null = null;

  constructor(options: ProductDepartmentOptions) {
    this.kernel = options.kernel;
    this.strategy = options.strategy;
    this.taskPlanning = options.taskPlanning;
    this.journalDir =
      options.journalDir ??
      path.join(os.homedir(), "developer/self-learning-ground/daily-review-learning");
    this.autoCollectIntervalMs = options.autoCollectIntervalMs ?? 15 * 60_000;
    this.defaultAutoPromote = options.autoPromote ?? true;
    this.defaultProposeBorderline = options.proposeDecisionIfBorderline ?? true;

    this.kernel.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_signals (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        project_ref TEXT NOT NULL,
        mainline_id TEXT,
        asset_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        alignment_score INTEGER NOT NULL DEFAULT 0,
        recommendation TEXT NOT NULL,
        score_summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        promoted_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_signals_status
        ON opc_signals(status, alignment_score DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opc_signals_mainline
        ON opc_signals(mainline_id);
    `);

    this.registerDecisionHandlers();
    this.ensureSubscriptions();
  }

  start(): void {
    this.ensureSubscriptions();
    if (!this.collectTimer && this.autoCollectIntervalMs > 0) {
      this.collectTimer = setInterval(() => {
        void this.collectFromSources().catch(() => {
          // ignore background collector error
        });
      }, this.autoCollectIntervalMs);
      this.collectTimer.unref?.();
    }
  }

  stop(): void {
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = null;
    }
    if (this.unsubscribeCrashBug) {
      this.unsubscribeCrashBug();
      this.unsubscribeCrashBug = null;
    }
    if (this.unsubscribePatrol) {
      this.unsubscribePatrol();
      this.unsubscribePatrol = null;
    }
    if (this.unsubscribeEpicComplete) {
      this.unsubscribeEpicComplete();
      this.unsubscribeEpicComplete = null;
    }
  }

  health(): DepartmentHealth {
    const counts = this.signalCounts();
    const readyTasks = this.taskPlanning.listReadyForAutoDispatch(50).length;
    return {
      healthy: true,
      summary: `信号池共 ${counts.total} 条（已立项 ${counts.promoted} · 待处理 ${counts.new}）· 待派发就绪队列 ${readyTasks} 项`,
      metrics: {
        totalSignals: counts.total,
        newSignals: counts.new,
        promotedSignals: counts.promoted,
        droppedSignals: counts.dropped,
        readyForDispatch: readyTasks,
      },
    };
  }

  private ensureSubscriptions(): void {
    if (!this.unsubscribeCrashBug) {
      this.unsubscribeCrashBug = this.kernel.events.subscribe("ops.crash_bug_filed", (event) => {
        void this.handleOpsCrashBugFiled(event);
      });
    }
    if (!this.unsubscribePatrol) {
      this.unsubscribePatrol = this.taskPlanning.onPatrol((report) => {
        void this.proposePatrolDecision(report);
      });
    }
    if (!this.unsubscribeEpicComplete) {
      this.unsubscribeEpicComplete = this.taskPlanning.onEpicComplete((epic) => {
        this.kernel.events.emit({
          topic: "product.epic_completed",
          sourceDomain: "product",
          mainlineId: epic.mainlineId,
          assetId: epic.assetId,
          payload: {
            epicId: epic.id,
            title: epic.title,
            project: epic.project,
            totalSubtasks: epic.subtaskStats.total,
            completedAt: epic.completedAt,
          },
        });
      });
    }
  }

  private registerDecisionHandlers(): void {
    this.kernel.decisions.registerActionGuard("product", "patrol_alert", packet => patrolActionBlockReason(this.kernel.db, packet));
    this.kernel.decisions.registerHandler("product.patrol_snooze", ({ option }) => {
      const taskIds = parseTaskIdsFromPayload(option.payload);
      const days = Number(option.payload?.days ?? 7) || 7;
      const snoozedIds: string[] = [];
      for (const taskId of taskIds) {
        try {
          this.taskPlanning.snoozeTask(taskId, days);
          snoozedIds.push(taskId);
        } catch {
          // ignore if task was deleted concurrently
        }
      }
      return {
        action: "snoozed",
        days,
        snoozedCount: snoozedIds.length,
        taskIds: snoozedIds,
      };
    });

    this.kernel.decisions.registerHandler("product.patrol_archive", ({ option }) => {
      const taskIds = parseTaskIdsFromPayload(option.payload);
      const archivedIds: string[] = [];
      for (const taskId of taskIds) {
        try {
          this.taskPlanning.updateStatus(taskId, "archived");
          archivedIds.push(taskId);
        } catch {
          // ignore if task was deleted concurrently
        }
      }
      return {
        action: "archived",
        archivedCount: archivedIds.length,
        taskIds: archivedIds,
      };
    });

    this.kernel.decisions.registerHandler("product.patrol_requeue", ({ option }) => {
      const taskIds = parseTaskIdsFromPayload(option.payload);
      const requeuedIds: string[] = [];
      for (const taskId of taskIds) {
        try {
          const updated = this.taskPlanning.updateTask(taskId, {
            status: "todo",
            snoozedUntil: null,
          });
          requeuedIds.push(updated.id);
          this.kernel.events.emit({
            topic: "product.feature_ready",
            sourceDomain: "product",
            mainlineId: updated.mainlineId,
            assetId: updated.assetId,
            payload: {
              taskId: updated.id,
              title: updated.title,
              project: updated.project,
              priority: updated.priority,
              verifyCommand: updated.verifyCommand,
              requeuedFromPatrol: true,
            },
          });
        } catch {
          // ignore if task was deleted concurrently
        }
      }
      return {
        action: "requeued",
        requeuedCount: requeuedIds.length,
        taskIds: requeuedIds,
      };
    });

    this.kernel.decisions.registerHandler("product.signal_promote", ({ option }) => {
      const signalId = String(option.payload?.signalId ?? "").trim();
      if (!signalId) {
        throw new ApiError(400, "missing_signal_id", "审批载荷缺少 signalId");
      }
      const { signal, task } = this.promoteSignal(signalId);
      return {
        action: "promoted",
        signalId: signal.id,
        promotedTaskId: task.id,
      };
    });

    this.kernel.decisions.registerHandler("product.signal_drop", ({ option }) => {
      const signalId = String(option.payload?.signalId ?? "").trim();
      if (!signalId) {
        throw new ApiError(400, "missing_signal_id", "审批载荷缺少 signalId");
      }
      const dropped = this.dropSignal(signalId);
      return {
        action: "dropped",
        signalId: dropped.id,
        status: dropped.status,
      };
    });
  }

  async proposePatrolDecision(report: PatrolReport): Promise<DecisionPacket | null> {
    if (!report.alerts || report.alerts.length === 0) return null;

    const day = (report.createdAt || new Date().toISOString()).slice(0, 10);
    const taskIds = dedupeStrings(report.alerts.map((a) => a.taskId));
    const lines = report.alerts.map((alert) => {
      const badge =
        alert.reason === "failed" ? `[构筑/执行失败]` : `[滞留 ${alert.staleDays} 天 · ${alert.status}]`;
      return `- ${badge} [${alert.project}] ${alert.title} (${alert.taskId})`;
    });

    const summary = [
      `日常巡检发现 ${report.staleCount} 项滞留任务与 ${report.failedCount} 项失败任务：`,
      ...lines,
    ].join("\n");

    return this.kernel.decisions.propose({
      dedupeKey: `product:patrol:${day}`,
      domain: "product",
      kind: "patrol_alert",
      riskLevel: "medium",
      title: `任务巡检告警：${report.staleCount} 项滞留 · ${report.failedCount} 项失败`,
      backgroundSummary: summary,
      whyRecommended:
        report.failedCount > 0
          ? "存在暗工厂执行失败任务，建议重置为 todo 触发配额调度器重试，或对暂缓事项执行 7 天免打扰。"
          : "存在长期未推进任务，建议延后 7 天免打扰、重新入队派工或直接归档清理。",
      tags: ["patrol", ...(report.failedCount > 0 ? ["failed"] : []), ...(report.staleCount > 0 ? ["stale"] : [])],
      recommendedOptionId: report.failedCount > 0 ? "requeue" : "snooze",
      options: [
        {
          id: "requeue",
          label: "重置为待办并重新触发调度",
          description: "将告警任务重置为 todo 并广播 product.feature_ready 供调度器接管",
          outcome: "approved",
          handlerKey: "product.patrol_requeue",
          payload: { taskIds, patrolRunId: report.id },
        },
        {
          id: "snooze",
          label: "延后 7 天免打扰 (Snooze)",
          description: "设置 snoozed_until 延后 7 天，期间巡检不再重复打扰",
          outcome: "snoozed",
          handlerKey: "product.patrol_snooze",
          payload: { taskIds, days: 7, patrolRunId: report.id },
        },
        {
          id: "archive",
          label: "归档清理不再推进的任务",
          description: "将上述滞留/失败任务标记为 archived 移出活跃看板",
          outcome: "rejected",
          handlerKey: "product.patrol_archive",
          payload: { taskIds, patrolRunId: report.id },
        },
      ],
    });
  }

  private async handleOpsCrashBugFiled(
    event: DomainEventRecord<Record<string, unknown>>,
  ): Promise<void> {
    const payload = event.payload ?? {};
    const fingerprint = String(payload.fingerprint ?? payload.crashId ?? "").trim();
    const serviceOrRef = String(
      payload.assetId ??
        payload.projectRef ??
        payload.projectOrAssetRef ??
        payload.product ??
        payload.service ??
        event.assetId ??
        event.productId ??
        "opc-os",
    ).trim();
    const title =
      String(payload.title ?? "").trim() ||
      `[P0 崩溃自愈] ${serviceOrRef}: ${String(payload.errorName ?? payload.error ?? payload.message ?? "运行时异常").slice(0, 120)}`;
    const detailLines = [
      payload.product ? `产品/服务: ${String(payload.product)}` : "",
      payload.latestVersion ? `版本: ${String(payload.latestVersion)}` : "",
      payload.count !== undefined ? `累计崩溃次数: ${String(payload.count)}` : "",
      payload.errorName || payload.message
        ? `异常信息: ${[payload.errorName, payload.message].filter(Boolean).join(": ")}`
        : "",
      payload.stack ? `堆栈摘要:\n${String(payload.stack)}` : "",
      payload.body ? String(payload.body) : "",
      payload.description ? String(payload.description) : "",
      payload.error && !payload.message ? String(payload.error) : "",
    ].filter(Boolean);
    const body =
      detailLines.join("\n").trim() ||
      "OpsWatchdog 捕获线上高频崩溃，需暗工厂立即复现、修复并通过确定性验证门禁。";
    const extraTags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];

    await this.ingestSignal({
      dedupeKey:
        typeof payload.dedupeKey === "string" && payload.dedupeKey.trim()
          ? payload.dedupeKey.trim()
          : fingerprint
            ? `ops_crash:${fingerprint}`
            : `ops_crash:${serviceOrRef}:${shortHash(title)}`,
      source: "ops.crash_bug_filed",
      projectRef: serviceOrRef,
      title,
      body,
      tags: dedupeStrings(["crash", "bug", "p0", "self-heal", ...extraTags]),
      isEmergencyBug: true,
      autoPromote: true,
      priority: 10,
      taskType: "bug",
    });
  }

  getSignal(id: string): SignalRecord | null {
    const row = this.kernel.db
      .prepare("SELECT * FROM opc_signals WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSignal(row) : null;
  }

  getSignalByDedupeKey(dedupeKey: string): SignalRecord | null {
    const row = this.kernel.db
      .prepare("SELECT * FROM opc_signals WHERE dedupe_key = ?")
      .get(dedupeKey) as Record<string, unknown> | undefined;
    return row ? this.mapSignal(row) : null;
  }

  listSignals(
    filter: {
      status?: SignalStatus | "all";
      mainlineId?: string;
      source?: string;
      recommendation?: CandidateRecommendation;
      limit?: number;
    } = {},
  ): SignalRecord[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];

    if (filter.status && filter.status !== "all") {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter.mainlineId && filter.mainlineId.trim()) {
      clauses.push("mainline_id = ?");
      args.push(filter.mainlineId.trim());
    }
    if (filter.source && filter.source.trim()) {
      clauses.push("source = ?");
      args.push(filter.source.trim());
    }
    if (filter.recommendation) {
      clauses.push("recommendation = ?");
      args.push(filter.recommendation);
    }

    const safeLimit = clampInt(filter.limit, 100, 1, 500);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.kernel.db
      .prepare(
        `SELECT * FROM opc_signals
         ${where}
         ORDER BY alignment_score DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...args, safeLimit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapSignal(r));
  }

  signalCounts(): {
    total: number;
    new: number;
    promoted: number;
    dropped: number;
    blocked: number;
  } {
    const rows = this.kernel.db
      .prepare("SELECT status, COUNT(*) AS n FROM opc_signals GROUP BY status")
      .all() as Array<{ status?: string; n?: number }>;
    const map = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      const count = Number(r.n ?? 0);
      map.set(String(r.status ?? ""), count);
      total += count;
    }
    return {
      total,
      new: map.get("new") ?? 0,
      promoted: map.get("promoted") ?? 0,
      dropped: map.get("dropped") ?? 0,
      blocked: map.get("blocked") ?? 0,
    };
  }

  private inferProjectRefFromText(title: string, body: string): string {
    const titleLower = title.toLowerCase();
    const assets = this.kernel.registry.listAssets();
    const products = this.kernel.registry.listProducts();

    // 1. Prefer explicit matches in the title so news digests mentioning random tools in the body don't misbind
    for (const asset of assets) {
      if (
        (asset.slug && titleLower.includes(asset.slug.toLowerCase())) ||
        (asset.name && titleLower.includes(asset.name.toLowerCase())) ||
        (asset.repoFullName && titleLower.includes(asset.repoFullName.toLowerCase()))
      ) {
        return asset.slug;
      }
    }
    for (const prod of products) {
      if (
        (prod.slug && titleLower.includes(prod.slug.toLowerCase())) ||
        (prod.name && titleLower.includes(prod.name.toLowerCase()))
      ) {
        return prod.slug;
      }
    }

    // 2. Fall back to body match ONLY for explicit repoFullName or exact registered asset slug
    const bodyLower = body.toLowerCase();
    for (const asset of assets) {
      if (
        (asset.repoFullName && bodyLower.includes(asset.repoFullName.toLowerCase())) ||
        (asset.slug && asset.slug.length >= 6 && bodyLower.includes(asset.slug.toLowerCase()))
      ) {
        return asset.slug;
      }
    }

    // 3. Only bind to opc-os when the title itself explicitly targets OPC OS / Dark Factory
    if (/(?:opc[- ]?os|dark[- ]?factory|暗工厂|总裁审批|agent[- ]?zoom)/i.test(titleLower)) {
      return "opc-os";
    }
    return "default";
  }

  async ingestSignal(input: IngestSignalInput): Promise<IngestSignalResult> {
    const title = (input.title ?? "").trim();
    if (!title) {
      throw new ApiError(400, "bad_signal", "信号标题不能为空");
    }
    const source = (input.source ?? "manual").trim() || "manual";
    const body = (input.body ?? input.description ?? "").trim();
    const rawRef = (input.projectRef ?? input.projectOrAssetRef ?? "").trim();
    const projectRef = rawRef || this.inferProjectRefFromText(title, body);
    const tags = dedupeStrings(input.tags);
    const dedupeKey =
      (input.dedupeKey ?? "").trim() || `${source}:${projectRef}:${shortHash(title)}`;

    const existing = this.getSignalByDedupeKey(dedupeKey);
    if (existing) {
      let existingTask: PlanningTask | null = null;
      if (existing.promotedTaskId) {
        try {
          existingTask = this.taskPlanning.getTask(existing.promotedTaskId);
        } catch {
          existingTask = null;
        }
      }
      return {
        signal: existing,
        created: false,
        evaluation: null,
        promotedTask: existingTask,
        decisionPacket: null,
      };
    }

    const evaluation = this.strategy.evaluateCandidate({
      title,
      description: body,
      projectOrAssetRef: projectRef,
      tags,
      estimatedCostUsd: input.estimatedCostUsd,
      isEmergencyBug: input.isEmergencyBug,
      recordHits: true,
    });

    // Strict pre-admission gate: never flood approvals or backlog with daily-news digest headers
    // or unbound journal snippets that lack a concrete target repo/product and actionable scope.
    let effectiveRecommendation = evaluation.recommendation;
    let effectiveSummary = evaluation.summary;
    if (evaluation.allowed && !input.isEmergencyBug) {
      const noiseCheck = isDigestOrNonActionableNoise(title, body);
      if (noiseCheck.noisy) {
        effectiveRecommendation = "drop_noise";
        effectiveSummary = `准入门禁拦截（非研发需求噪音）：${noiseCheck.reason}`;
      } else if (
        source.startsWith("journal:") &&
        ((!evaluation.resolution.asset && !evaluation.resolution.product) || evaluation.clarityScore < 10)
      ) {
        effectiveRecommendation = "drop_noise";
        effectiveSummary =
          !evaluation.resolution.asset && !evaluation.resolution.product
            ? "准入门禁拦截：该日报条目未关联任何已注册产品/仓库，已自动过滤避免产生无上下文审批"
            : `准入门禁拦截：清晰度过低（${evaluation.clarityScore}/25），缺少具体改动目标与验收方式`;
      }
    }

    const id = `sig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();
    const mainlineId = evaluation.resolution.mainline?.id ?? null;
    const assetId = evaluation.resolution.asset?.id ?? null;

    let initialStatus: SignalStatus = "new";
    if (!evaluation.allowed) {
      initialStatus = "blocked";
    } else if (effectiveRecommendation === "drop_noise") {
      initialStatus = "dropped";
    }

    this.kernel.db
      .prepare(
        `INSERT INTO opc_signals
         (id, dedupe_key, source, project_ref, mainline_id, asset_id, title, body, tags_json,
          alignment_score, recommendation, score_summary, status, promoted_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        dedupeKey,
        source,
        projectRef,
        mainlineId,
        assetId,
        title,
        body,
        JSON.stringify(tags),
        evaluation.totalScore,
        effectiveRecommendation,
        effectiveSummary,
        initialStatus,
        now,
        now,
      );

    this.kernel.events.emit({
      topic: "product.signal_ingested",
      sourceDomain: "product",
      mainlineId,
      productId: evaluation.resolution.product?.id ?? null,
      assetId,
      payload: {
        signalId: id,
        dedupeKey,
        source,
        projectRef,
        title,
        alignmentScore: evaluation.totalScore,
        recommendation: effectiveRecommendation,
        allowed: evaluation.allowed,
      },
    });

    const policy = this.kernel.decisions.getPolicy();
    const autoPromote = input.autoPromote ?? (this.defaultAutoPromote && policy.autoPromoteSignals);
    const proposeBorderline = input.proposeDecisionIfBorderline ?? this.defaultProposeBorderline;

    let promotedTask: PlanningTask | null = null;
    let decisionPacket: DecisionPacket | null = null;

    if (
      evaluation.allowed &&
      ((autoPromote && effectiveRecommendation === "auto_promote") || Boolean(input.isEmergencyBug))
    ) {
      const promoted = this.promoteSignal(id, {
        priority: input.priority ?? (input.isEmergencyBug ? 10 : undefined),
        type: input.taskType ?? (input.isEmergencyBug ? "bug" : undefined),
        isEmergencyBug: Boolean(input.isEmergencyBug),
      });
      promotedTask = promoted.task;
    } else if (
      evaluation.allowed &&
      effectiveRecommendation === "needs_review" &&
      proposeBorderline
    ) {
      const targetMainline = evaluation.resolution.mainline?.name ?? "未绑定长期主线";
      const targetProduct = evaluation.resolution.product?.name ?? "未绑定产品";
      const targetAsset = evaluation.resolution.asset
        ? `${evaluation.resolution.asset.name}${evaluation.resolution.asset.repoFullName ? ` (${evaluation.resolution.asset.repoFullName})` : ""}`
        : projectRef;
      const verifyHint = evaluation.resolution.asset?.verifyCommand
        ? `\`${evaluation.resolution.asset.verifyCommand}\``
        : "尚未配置自动校验命令";
      const conciseBody = body ? cleanMarkdownPreview(body, 280) : "（提交方未附带补充说明）";

      decisionPacket = await this.kernel.decisions.propose({
        dedupeKey: `product:signal:${id}`,
        domain: "product",
        kind: "feature_admission",
        riskLevel: "medium",
        mainlineId,
        productId: evaluation.resolution.product?.id ?? null,
        assetId,
        title: `需求准入立项：${stripCandidateTitlePrefix(title)}`,
        backgroundSummary: [
          `**要做什么**：${stripCandidateTitlePrefix(title)}`,
          `**归属目标**：主线「${targetMainline}」 → 产品「${targetProduct}」 → 仓库「${targetAsset}」`,
          `**内容摘要**：${conciseBody}`,
          `**信号来源与评分**：来源 \`${source}\` ｜ 对齐总分 **${evaluation.totalScore}/100**（主线 ${evaluation.mainlineScore}/40 · 习惯 ${evaluation.habitScore >= 0 ? `+${evaluation.habitScore}` : evaluation.habitScore} · 清晰度 ${evaluation.clarityScore}/25）`,
          `**批准后实际动作**：在任务规划看板新建待办研发任务（验收门禁：${verifyHint}），不会直接修改主分支或推送上线。`,
        ].join("\n\n"),
        whyRecommended: effectiveSummary,
        diffOrEvidence: body ? `### 原始信号全文 (${source})\n${body.slice(0, 2000)}` : "",
        rollbackPlan: "如立项后决定不做，可随时在「任务规划」中归档或取消该任务，不会改动任何代码仓库。",
        tags,
        recommendedOptionId: evaluation.totalScore >= 60 ? "promote" : "drop",
        options: [
          {
            id: "promote",
            label: "准入立项并转入研发队列",
            description: "在任务规划看板创建正式研发任务并继承仓库校验门禁（不直接改代码）",
            outcome: "approved",
            handlerKey: "product.signal_promote",
            payload: { signalId: id },
          },
          {
            id: "drop",
            label: "驳回丢弃（沉淀避坑偏好）",
            description: "标记为无效需求并丢弃；填写的批注关键词将自动沉淀为反向过滤规则",
            outcome: "rejected",
            handlerKey: "product.signal_drop",
            payload: { signalId: id },
          },
        ],
      });
    }

    return {
      signal: this.getSignal(id)!,
      created: true,
      evaluation,
      promotedTask,
      decisionPacket,
    };
  }

  promoteSignal(
    signalId: string,
    options: PromoteSignalOptions = {},
  ): { signal: SignalRecord; task: PlanningTask } {
    const signal = this.getSignal(signalId);
    if (!signal) {
      throw new ApiError(404, "signal_not_found", `未找到信号: ${signalId}`);
    }

    if (signal.status === "promoted" && signal.promotedTaskId) {
      try {
        const existingTask = this.taskPlanning.getTask(signal.promotedTaskId);
        return { signal, task: existingTask };
      } catch {
        // Task was deleted; allow re-promotion below
      }
    }

    const resolution = this.kernel.registry.resolveCanonicalRef(
      signal.assetId ?? (signal.projectRef !== "default" ? signal.projectRef : signal.mainlineId),
    );
    const asset =
      (signal.assetId ? this.kernel.registry.getAsset(signal.assetId) : null) ?? resolution.asset;
    const product = resolution.product;
    const mainlineId = signal.mainlineId ?? asset?.mainlineId ?? resolution.mainline?.id ?? null;
    const assetId = asset?.id ?? signal.assetId ?? null;
    const verifyCommand = (options.verifyCommand ?? asset?.verifyCommand ?? "").trim();
    const project = asset?.slug || product?.slug || signal.projectRef || "default";

    const inferredBug =
      signal.tags.some((t) => /^(?:bug|crash|p0)$/i.test(t)) ||
      signal.source === "ops.crash_bug_filed";
    const isEmergency =
      Boolean(options.isEmergencyBug) ||
      signal.source === "ops.crash_bug_filed" ||
      (signal.tags.includes("p0") && signal.tags.includes("crash"));
    const taskType: PlanningTaskType = options.type ?? (inferredBug ? "bug" : "task");
    const defaultPriority =
      signal.tags.includes("p0") || signal.tags.includes("crash")
        ? 10
        : clampInt(Math.round(signal.alignmentScore / 10), 6, 1, 10);
    const priority = options.priority ?? defaultPriority;
    const stampedAt = new Date().toISOString();
    const triageMeta = isEmergency
      ? {
          status: "verified",
          verdict: "real_ready",
          confidence: 1,
          reason: "P0 线上崩溃自愈事件自动免审放行",
          reviewer: "ops-emergency-fastpath",
          reviewedAt: stampedAt,
        }
      : {
          status: "unreviewed",
          verdict: null,
          confidence: null,
          reason: null,
          reviewer: null,
          reviewedAt: null,
        };

    let createdTask: PlanningTask;
    if (options.subtasks && options.subtasks.length > 0) {
      const epicRes = this.taskPlanning.createEpicWithSubtasks({
        project,
        title: signal.title,
        description: signal.body,
        priority,
        tags: signal.tags,
        sourceRef: `signal://${signal.id}`,
        dependsOn: options.dependsOn,
        verifyCommand,
        mainlineId,
        assetId,
        metadata: {
          signalId: signal.id,
          signalSource: signal.source,
          alignmentScore: signal.alignmentScore,
          ...(isEmergency ? { isEmergencyBug: true } : {}),
          triage: triageMeta,
        },
        subtasks: options.subtasks.map((sub) => ({
          ...sub,
          metadata: {
            ...(sub.metadata ?? {}),
            triage:
              sub.metadata && typeof sub.metadata.triage === "object" && sub.metadata.triage !== null
                ? sub.metadata.triage
                : triageMeta,
          },
        })),
      });
      createdTask = epicRes.epic;
    } else {
      createdTask = this.taskPlanning.createTask({
        project,
        title: signal.title,
        description: signal.body,
        type: taskType,
        priority,
        tags: signal.tags,
        sourceRef: `signal://${signal.id}`,
        dependsOn: options.dependsOn,
        verifyCommand,
        mainlineId,
        assetId,
        metadata: {
          signalId: signal.id,
          signalSource: signal.source,
          alignmentScore: signal.alignmentScore,
          ...(isEmergency ? { isEmergencyBug: true } : {}),
          triage: triageMeta,
        },
      });
    }

    const now = new Date().toISOString();
    this.kernel.db
      .prepare(
        `UPDATE opc_signals
         SET status = 'promoted', promoted_task_id = ?, mainline_id = COALESCE(mainline_id, ?),
             asset_id = COALESCE(asset_id, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(createdTask.id, mainlineId, assetId, now, signal.id);

    const updatedSignal = this.getSignal(signal.id)!;

    this.kernel.events.emit({
      topic: "product.feature_ready",
      sourceDomain: "product",
      mainlineId: createdTask.mainlineId,
      productId: product?.id ?? null,
      assetId: createdTask.assetId,
      payload: {
        signalId: updatedSignal.id,
        taskId: createdTask.id,
        title: createdTask.title,
        project: createdTask.project,
        type: createdTask.type,
        priority: createdTask.priority,
        verifyCommand: createdTask.verifyCommand,
      },
    });

    return {
      signal: updatedSignal,
      task: createdTask,
    };
  }

  dropSignal(signalId: string): SignalRecord {
    const signal = this.getSignal(signalId);
    if (!signal) {
      throw new ApiError(404, "signal_not_found", `未找到信号: ${signalId}`);
    }
    this.kernel.db
      .prepare("UPDATE opc_signals SET status = 'dropped', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), signalId);
    return this.getSignal(signalId)!;
  }

  async collectFromSources(options: CollectSourcesOptions = {}): Promise<CollectSourcesResult> {
    if (this.collectingPromise) {
      return this.collectingPromise;
    }
    const run = this.runCollectFromSources(options).finally(() => {
      if (this.collectingPromise === run) {
        this.collectingPromise = null;
      }
    });
    this.collectingPromise = run;
    return run;
  }

  private async runCollectFromSources(
    options: CollectSourcesOptions = {},
  ): Promise<CollectSourcesResult> {
    const createdSignals: SignalRecord[] = [];
    let journalSignals = 0;
    let githubIssueSignals = 0;
    let promotedCount = 0;

    // 1. Scan daily review journal markdown files (safe no-op if journalDir doesn't exist)
    const maxJournalFiles = clampInt(options.maxJournalFiles, 5, 1, 30);
    if (this.journalDir && fs.existsSync(this.journalDir)) {
      try {
        const entries = fs
          .readdirSync(this.journalDir)
          .filter((name) => JOURNAL_FILE_REGEX.test(name))
          .sort((a, b) => b.localeCompare(a))
          .slice(0, maxJournalFiles);

        for (const fileName of entries) {
          const fullPath = path.join(this.journalDir, fileName);
          let content = "";
          try {
            content = fs.readFileSync(fullPath, "utf8");
          } catch {
            continue;
          }
          const items = extractJournalActionableItems(content);
          for (const item of items) {
            const dedupeKey = `journal:${fileName}:${shortHash(item.title)}`;
            if (this.getSignalByDedupeKey(dedupeKey)) continue;

            const res = await this.ingestSignal({
              dedupeKey,
              source: `journal:${fileName}`,
              title: item.title,
              body: item.body,
              tags: ["journal", "daily-review"],
              autoPromote: options.autoPromote,
              proposeDecisionIfBorderline: options.proposeDecisionIfBorderline,
            });
            if (res.created) {
              journalSignals += 1;
              createdSignals.push(res.signal);
              if (res.promotedTask) promotedCount += 1;
            }
          }
        }
      } catch {
        // safe no-op on unreadable directory
      }
    }

    // 2. Scan project_repositories SQLite table snapshots for open GitHub issues
    const hasRepoTable = Boolean(
      this.kernel.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_repositories'")
        .get(),
    );

    if (hasRepoTable) {
      const repoCols = new Set(
        (
          this.kernel.db
            .prepare("PRAGMA table_info(project_repositories)")
            .all() as Array<{ name?: string }>
        ).map((c) => String(c.name ?? "")),
      );
      const selectSql = repoCols.has("project")
        ? "SELECT full_name, project, snapshot FROM project_repositories ORDER BY full_name ASC"
        : "SELECT full_name, snapshot FROM project_repositories ORDER BY full_name ASC";

      const rows = this.kernel.db.prepare(selectSql).all() as Array<{
        full_name?: string;
        project?: string;
        snapshot?: string;
      }>;

      for (const row of rows) {
        const repoFullName = String(row.full_name ?? "").trim();
        const projectCol = String(row.project ?? "").trim();
        const parsedSnap = safeJson<{
          fullName?: string;
          items?: Array<{
            kind?: string;
            number?: number;
            title?: string;
            body?: string;
            url?: string;
            labels?: string[];
          }>;
          issues?: Array<{
            number?: number;
            title?: string;
            body?: string;
            url?: string;
            state?: string;
            labels?: Array<string | { name?: string }>;
          }>;
        }>(row.snapshot ? String(row.snapshot) : null, {});

        const canonicalRepo = repoFullName || String(parsedSnap.fullName ?? "").trim();
        const openIssues: Array<{
          number: number;
          title: string;
          body: string;
          url: string;
          labels: string[];
        }> = [];

        if (Array.isArray(parsedSnap.items)) {
          for (const item of parsedSnap.items) {
            if (item.kind === "issue" && item.number && item.title) {
              openIssues.push({
                number: Number(item.number),
                title: String(item.title),
                body: String(item.body ?? item.url ?? ""),
                url: String(item.url ?? ""),
                labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
              });
            }
          }
        }

        if (Array.isArray(parsedSnap.issues)) {
          for (const iss of parsedSnap.issues) {
            if (iss.state && String(iss.state).toLowerCase() === "closed") continue;
            if (iss.number && iss.title) {
              const labels = Array.isArray(iss.labels)
                ? iss.labels
                    .map((l) => (typeof l === "string" ? l : String(l?.name ?? "")))
                    .filter(Boolean)
                : [];
              openIssues.push({
                number: Number(iss.number),
                title: String(iss.title),
                body: String(iss.body ?? iss.url ?? ""),
                url: String(iss.url ?? ""),
                labels,
              });
            }
          }
        }

        for (const issue of openIssues) {
          const dedupeKey = `github_issue:${canonicalRepo}#${issue.number}`;
          if (this.getSignalByDedupeKey(dedupeKey)) continue;

          const inferredBugTag = /(?:bug|crash|error|exception|报错|崩溃|异常|修复)/i.test(
            `${issue.title} ${issue.labels.join(" ")}`,
          )
            ? ["bug"]
            : [];
          const bodyParts = [
            canonicalRepo ? `仓库: ${canonicalRepo} #${issue.number}` : `Issue #${issue.number}`,
            issue.url ? `链接: ${issue.url}` : "",
            issue.body && issue.body !== issue.url ? issue.body : "",
          ].filter(Boolean);

          const res = await this.ingestSignal({
            dedupeKey,
            source: "github_issue",
            projectRef: canonicalRepo || projectCol || "default",
            title: issue.title,
            body: bodyParts.join("\n"),
            tags: dedupeStrings(["github-issue", ...inferredBugTag, ...issue.labels]),
            autoPromote: options.autoPromote,
            proposeDecisionIfBorderline: options.proposeDecisionIfBorderline,
          });
          if (res.created) {
            githubIssueSignals += 1;
            createdSignals.push(res.signal);
            if (res.promotedTask) promotedCount += 1;
          }
        }
      }
    }

    return {
      collectedCount: createdSignals.length,
      journalSignals,
      githubIssueSignals,
      promotedCount,
      signals: createdSignals,
    };
  }

  registerRoutes(app: Hono, requireUser: (c: Context) => { id: string; name: string }): void {
    const base = "/api/opc/domains/product" as const;

    app.use(`${base}/*`, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });

    app.get(`${base}/signals`, (c) => {
      requireUser(c);
      const status = (c.req.query("status") ?? "all") as SignalStatus | "all";
      const mainlineId = c.req.query("mainlineId") ?? undefined;
      const source = c.req.query("source") ?? undefined;
      const recommendation = (c.req.query("recommendation") ?? undefined) as
        | CandidateRecommendation
        | undefined;
      const limit = clampInt(c.req.query("limit"), 100, 1, 500);
      return c.json({
        signals: this.listSignals({ status, mainlineId, source, recommendation, limit }),
        counts: this.signalCounts(),
      });
    });

    app.post(`${base}/signals`, async (c) => {
      requireUser(c);
      const body = await readJsonBody(c);
      const result = await this.ingestSignal({
        dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : undefined,
        source: typeof body.source === "string" ? body.source : undefined,
        projectRef: typeof body.projectRef === "string" ? body.projectRef : undefined,
        projectOrAssetRef:
          typeof body.projectOrAssetRef === "string" ? body.projectOrAssetRef : undefined,
        title: String(body.title ?? ""),
        body: typeof body.body === "string" ? body.body : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        estimatedCostUsd:
          typeof body.estimatedCostUsd === "number" ? body.estimatedCostUsd : undefined,
        isEmergencyBug: typeof body.isEmergencyBug === "boolean" ? body.isEmergencyBug : undefined,
        autoPromote: typeof body.autoPromote === "boolean" ? body.autoPromote : undefined,
        proposeDecisionIfBorderline:
          typeof body.proposeDecisionIfBorderline === "boolean"
            ? body.proposeDecisionIfBorderline
            : undefined,
        priority: typeof body.priority === "number" ? body.priority : undefined,
        taskType: typeof body.taskType === "string" ? (body.taskType as PlanningTaskType) : undefined,
      });
      return c.json(result, result.created ? 201 : 200);
    });

    app.post(`${base}/collect`, async (c) => {
      requireUser(c);
      const body = await readJsonBody(c, true);
      const result = await this.collectFromSources({
        maxJournalFiles:
          typeof body.maxJournalFiles === "number" ? body.maxJournalFiles : undefined,
        autoPromote: typeof body.autoPromote === "boolean" ? body.autoPromote : undefined,
        proposeDecisionIfBorderline:
          typeof body.proposeDecisionIfBorderline === "boolean"
            ? body.proposeDecisionIfBorderline
            : undefined,
      });
      return c.json(result);
    });

    app.post(`${base}/signals/:id/promote`, async (c) => {
      requireUser(c);
      const body = await readJsonBody(c, true);
      const promoted = this.promoteSignal(c.req.param("id"), {
        priority: typeof body.priority === "number" ? body.priority : undefined,
        type: typeof body.type === "string" ? (body.type as PlanningTaskType) : undefined,
        verifyCommand: typeof body.verifyCommand === "string" ? body.verifyCommand : undefined,
        dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn.map(String) : undefined,
        subtasks: Array.isArray(body.subtasks)
          ? (body.subtasks as CreateEpicSubtaskInput[])
          : undefined,
      });
      return c.json(promoted);
    });

    app.post(`${base}/signals/:id/drop`, (c) => {
      requireUser(c);
      const signal = this.dropSignal(c.req.param("id"));
      return c.json({ signal });
    });
  }

  private mapSignal(row: Record<string, unknown>): SignalRecord {
    return {
      id: String(row.id),
      dedupeKey: String(row.dedupe_key),
      source: String(row.source),
      projectRef: String(row.project_ref),
      mainlineId: row.mainline_id ? String(row.mainline_id) : null,
      assetId: row.asset_id ? String(row.asset_id) : null,
      title: String(row.title),
      body: String(row.body ?? ""),
      tags: safeJson<string[]>(String(row.tags_json ?? "[]"), []),
      alignmentScore: Number(row.alignment_score ?? 0),
      recommendation: String(row.recommendation) as CandidateRecommendation,
      scoreSummary: String(row.score_summary ?? ""),
      status: String(row.status ?? "new") as SignalStatus,
      promotedTaskId: row.promoted_task_id ? String(row.promoted_task_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
