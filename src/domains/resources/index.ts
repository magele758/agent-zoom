import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AgentRecord, AgentRunRecord, DispatchRunInput } from "../../dark-factory-types.ts";
import type {
  AdmissionCheckResult,
  DepartmentHealth,
  DepartmentModule,
  OpcKernel,
} from "../../kernel/index.ts";
import type { HubQuotaTool, ManualPlan, ResourceDepartmentIndex } from "../../resource-department-types.ts";
import { ApiError } from "../../server/logic.ts";
import { readHubResources, ResourcePlanStore } from "../../server/resource-department.ts";

export type HubToolResource = HubQuotaTool;

export interface ReadyTaskCandidate {
  id: string;
  title: string;
  description: string;
  project: string;
  priority: number;
  verifyCommand?: string;
}

export interface DarkFactoryQuotaPort {
  listAgents(): AgentRecord[];
  listRuns(filter?: { limit?: number; status?: string; project?: string }): AgentRunRecord[];
  dispatch(input: DispatchRunInput): AgentRunRecord;
}

export interface QuotaDispatchLogEntry {
  id: string;
  taskId: string;
  runId: string | null;
  agentId: string;
  agentName: string;
  matchedTool: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  reason: string;
  triggeredBy: string;
  createdAt: string;
}

export interface AgentCandidateScore {
  agentId: string;
  agentName: string;
  matchedTool: string | null;
  diagnostic: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  healthy: boolean;
  eligible: boolean;
  excludeReason: string | null;
  activeLoad: number;
  matchedCapabilities: string[];
  breakdown: {
    capabilityScore: number;
    quotaHeadroomScore: number;
    urgencyBonus: number;
    activeLoadPenalty: number;
  };
  score: number;
}

export interface SelectOptimalAgentInput {
  project: string;
  title: string;
  description?: string;
  requiredCapabilities?: string[];
  isEmergencyBug?: boolean;
  reserveFloorPct?: number;
}

export interface SelectOptimalAgentResult {
  chosenAgent: AgentRecord | null;
  candidateScores: AgentCandidateScore[];
  admission: AdmissionCheckResult;
}

export interface HarvestExpiringQuotaOptions {
  windowHours?: number;
  minRemainingPct?: number;
  maxDispatches?: number;
  dryRun?: boolean;
  force?: boolean;
}

export interface ExpiringQuotaSignal {
  source: "hub" | "manual_plan";
  tool: string;
  name: string;
  window: string;
  remainingPct: number;
  resetsAt: string | null;
  hoursUntilReset: number | null;
}

export interface HarvestExpiringQuotaResult {
  triggered: boolean;
  dryRun: boolean;
  forced: boolean;
  windowHours: number;
  minRemainingPct: number;
  expiringTools: ExpiringQuotaSignal[];
  plannedDispatches: Array<{
    taskId: string;
    taskTitle: string;
    project: string;
    priorityScore: number;
    agentId: string;
    agentName: string;
    matchedTool: string | null;
    remainingPct: number | null;
    resetsAt: string | null;
    runId: string | null;
  }>;
  dispatchedRuns: AgentRunRecord[];
  reason: string;
}

export interface ResourcesDepartmentOptions {
  kernel: OpcKernel;
  darkFactory?: DarkFactoryQuotaPort;
  planStore?: ResourcePlanStore;
  hubQuotaPath?: string;
  reserveFloorPct?: number;
  listReadyTasks?: () => ReadyTaskCandidate[];
  onTaskDispatched?: (task: ReadyTaskCandidate, run: AgentRunRecord) => void;
  readHubFn?: (nowMs: number) => ResourceDepartmentIndex["hub"];
  nowFn?: () => number;
}

const routePreviewSchema = z.object({
  project: z.string().trim().min(1, "project 不能为空").max(160),
  title: z.string().trim().min(1, "title 不能为空").max(300),
  description: z.string().max(12_000).optional().default(""),
  requiredCapabilities: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  isEmergencyBug: z.boolean().optional().default(false),
  reserveFloorPct: z.number().min(0).max(100).optional(),
});

const smartDispatchSchema = z.object({
  taskId: z.string().trim().min(1, "taskId 不能为空").max(160),
  project: z.string().trim().max(160).optional(),
  title: z.string().trim().max(300).optional(),
  description: z.string().max(12_000).optional(),
  repoPath: z.string().trim().max(500).optional(),
  requiredCapabilities: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  isEmergencyBug: z.boolean().optional().default(false),
  autoCreatePr: z.boolean().optional().default(false),
});

const harvestSchema = z.object({
  windowHours: z.number().positive().max(168).optional(),
  minRemainingPct: z.number().min(0).max(100).optional(),
  maxDispatches: z.number().int().min(1).max(20).optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
});

const TOOL_ALIASES: Array<{ canonical: string[]; pattern: RegExp }> = [
  { canonical: ["codex"], pattern: /\b(codex|openai)\b/i },
  { canonical: ["claude"], pattern: /\b(claude|anthropic)\b/i },
  { canonical: ["antigravity", "gemini", "agy"], pattern: /\b(agy|antigravity|gemini)\b/i },
  { canonical: ["cursor"], pattern: /\b(cursor)\b/i },
  { canonical: ["grok-build", "grok"], pattern: /\b(grok)\b/i },
];

const CAPABILITY_KEYWORD_RULES: Array<{ capability: string; pattern: RegExp }> = [
  { capability: "bugfix", pattern: /\b(bug|fix|crash|error|exception|hotfix|regress)\b|修复|报错|崩溃|故障|缺陷/i },
  { capability: "test", pattern: /\b(test|spec|assert|e2e|unit|verify)\b|测试|单测|验收/i },
  { capability: "ui", pattern: /\b(ui|ux|css|react|frontend|component|page|view|layout)\b|界面|前端|组件|页面|样式/i },
  { capability: "refactor", pattern: /\b(refactor|cleanup|decouple|modular)\b|重构|解耦|整理/i },
  { capability: "architecture", pattern: /\b(arch|architecture|kernel|schema|protocol|design)\b|架构|内核|设计|模型/i },
  { capability: "review", pattern: /\b(review|audit|security|vuln)\b|评审|审计|安全/i },
  { capability: "automation", pattern: /\b(ci|cd|deploy|script|cron|watchdog|automation|workflow)\b|自动化|部署|巡检|流水线/i },
  { capability: "fullstack", pattern: /\b(api|endpoint|server|route|sqlite|database|fullstack)\b|接口|后端|全栈|数据库/i },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    );
  } catch {
    return false;
  }
}

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const res = schema.safeParse(raw ?? {});
  if (!res.success) {
    throw new ApiError(
      400,
      "resources_input",
      res.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join(" / "),
    );
  }
  return res.data;
}

function inferCapabilitiesFromTask(title: string, description = ""): string[] {
  const combined = `${title}\n${description}`;
  const matched: string[] = [];
  for (const rule of CAPABILITY_KEYWORD_RULES) {
    if (rule.pattern.test(combined)) {
      matched.push(rule.capability);
    }
  }
  return matched;
}

function matchAgentToHubTool(
  agent: AgentRecord,
  tools: HubQuotaTool[],
  manualPlans: ManualPlan[],
  nowMs: number,
): {
  matchedTool: string | null;
  diagnostic: string | null;
  remainingPct: number | null;
  resetsAt: string | null;
  isLiveQuota: boolean;
  healthy: boolean;
} {
  const haystack = `${agent.name} ${agent.cliCommand}`.toLowerCase();

  let matchedHub: HubQuotaTool | undefined;
  for (const entry of TOOL_ALIASES) {
    if (entry.pattern.test(haystack)) {
      matchedHub = tools.find((t) =>
        entry.canonical.some(
          (cand) => t.tool.toLowerCase() === cand || t.name.toLowerCase().includes(cand),
        ),
      );
      if (matchedHub) break;
    }
  }

  if (!matchedHub) {
    matchedHub = tools.find((t) => {
      const toolNorm = t.tool.toLowerCase();
      return toolNorm.length >= 3 && haystack.includes(toolNorm);
    });
  }

  if (matchedHub) {
    const diagnostic = matchedHub.diagnostic ?? null;
    const unhealthyDiag =
      diagnostic === "auth_expired" || (diagnostic as string) === "offline";
    const activeWindows = matchedHub.windows.filter(
      (w) => !w.resetsAt || Date.parse(w.resetsAt) > nowMs,
    );

    let remainingPct: number | null = null;
    let resetsAt: string | null = null;

    const numericWindows = activeWindows.filter(
      (w): w is typeof w & { reportedRemaining: number } =>
        typeof w.reportedRemaining === "number" && Number.isFinite(w.reportedRemaining),
    );

    if (numericWindows.length > 0) {
      // Most constraining window determines effective remaining headroom;
      // prefer urgent soon-to-expire window's reset timestamp when applicable
      const minWin = numericWindows.reduce((best, cur) =>
        cur.reportedRemaining < best.reportedRemaining ? cur : best,
      );
      remainingPct = round2(minWin.reportedRemaining);
      resetsAt = minWin.resetsAt ?? null;

      const urgentWin = numericWindows
        .filter((w) => {
          if (!w.resetsAt) return false;
          const diff = Date.parse(w.resetsAt) - nowMs;
          return diff > 0 && diff <= 12 * 3_600_000 && w.reportedRemaining >= 20;
        })
        .sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0];

      if (urgentWin && remainingPct >= (matchedHub.fromHistory ? 0 : 10)) {
        resetsAt = urgentWin.resetsAt;
      }
    }

    const isLiveQuota =
      !matchedHub.fromHistory &&
      (numericWindows.some((w) => w.live) || numericWindows.length > 0);

    return {
      matchedTool: matchedHub.tool,
      diagnostic,
      remainingPct,
      resetsAt,
      isLiveQuota,
      healthy: !unhealthyDiag,
    };
  }

  // Check manual resource plans if user registered custom subscription plans
  const matchedPlan = manualPlans.find((p) => {
    const pNorm = p.name.toLowerCase();
    return pNorm.length >= 3 && haystack.includes(pNorm);
  });
  if (matchedPlan) {
    const active = !matchedPlan.resetsAt || Date.parse(matchedPlan.resetsAt) > nowMs;
    let pct: number | null = null;
    if (active && matchedPlan.reportedRemaining !== null) {
      if (matchedPlan.unit === "%") {
        pct = round2(matchedPlan.reportedRemaining);
      } else if (matchedPlan.capacity && matchedPlan.capacity > 0) {
        pct = round2((matchedPlan.reportedRemaining / matchedPlan.capacity) * 100);
      }
    }
    return {
      matchedTool: matchedPlan.name,
      diagnostic: null,
      remainingPct: pct,
      resetsAt: active ? matchedPlan.resetsAt : null,
      isLiveQuota: pct !== null,
      healthy: true,
    };
  }

  // Neutral local script / custom agent with no hub.db quota entry
  return {
    matchedTool: null,
    diagnostic: null,
    remainingPct: null,
    resetsAt: null,
    isLiveQuota: false,
    healthy: true,
  };
}

export class ResourcesDepartment implements DepartmentModule {
  readonly id = "resources" as const;
  private readonly db: DatabaseSync;
  private readonly kernel: OpcKernel;
  private readonly darkFactory: DarkFactoryQuotaPort;
  private readonly planStore: ResourcePlanStore;
  private readonly hubQuotaPath: string;
  private readonly reserveFloorPct: number;
  private readonly listReadyTasksFn: () => ReadyTaskCandidate[];
  private readonly onTaskDispatched?: (task: ReadyTaskCandidate, run: AgentRunRecord) => void;
  private readonly readHubFn: (nowMs: number) => ResourceDepartmentIndex["hub"];
  private readonly nowFn: () => number;

  constructor(options: ResourcesDepartmentOptions);
  constructor(kernel: OpcKernel, options?: Omit<ResourcesDepartmentOptions, "kernel">);
  constructor(
    first: ResourcesDepartmentOptions | OpcKernel,
    second?: Omit<ResourcesDepartmentOptions, "kernel">,
  ) {
    const opts: ResourcesDepartmentOptions =
      "registry" in first && "decisions" in first
        ? { kernel: first, ...(second ?? {}) }
        : first;

    this.kernel = opts.kernel;
    this.db = opts.kernel.db;
    this.planStore = opts.planStore ?? new ResourcePlanStore(this.db);
    this.hubQuotaPath =
      opts.hubQuotaPath ?? process.env.OPC_HUB_QUOTA_DB ?? join(homedir(), ".agent-hub", "hub.db");
    this.reserveFloorPct = opts.reserveFloorPct ?? 10;
    this.onTaskDispatched = opts.onTaskDispatched;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.readHubFn = opts.readHubFn ?? ((nowMs) => readHubResources(this.hubQuotaPath, nowMs));
    this.darkFactory = opts.darkFactory ?? this.createSqliteFallbackFactoryPort();
    this.listReadyTasksFn = opts.listReadyTasks ?? (() => this.queryPlanningReadyTasks());

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_quota_dispatch_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        matched_tool TEXT,
        remaining_pct REAL,
        resets_at TEXT,
        reason TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_quota_dispatch_created
        ON opc_quota_dispatch_log(created_at DESC);
    `);
  }

  private createSqliteFallbackFactoryPort(): DarkFactoryQuotaPort {
    return {
      listAgents: () => {
        if (!hasTable(this.db, "opc_agent_registry")) return [];
        const rows = this.db
          .prepare("SELECT * FROM opc_agent_registry ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>;
        return rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          description: String(r.description ?? ""),
          type: String(r.type ?? "cli") as AgentRecord["type"],
          cliCommand: String(r.cli_command ?? ""),
          promptTemplate: String(r.prompt_template ?? ""),
          maxCostPerTask: Number(r.max_cost_per_task ?? 5),
          maxDurationSecs: Number(r.max_duration_secs ?? 1800),
          maxRetries: Number(r.max_retries ?? 3),
          status: String(r.status ?? "idle") as AgentRecord["status"],
          capabilities: (() => {
            try {
              return JSON.parse(String(r.capabilities ?? "[]")) as string[];
            } catch {
              return [];
            }
          })(),
          config: {},
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
        }));
      },
      listRuns: (filter) => {
        if (!hasTable(this.db, "opc_agent_runs")) return [];
        const limit = Math.max(1, Math.min(200, filter?.limit ?? 50));
        const rows = filter?.status
          ? (this.db
              .prepare("SELECT * FROM opc_agent_runs WHERE status = ? ORDER BY created_at DESC LIMIT ?")
              .all(filter.status, limit) as Array<Record<string, unknown>>)
          : (this.db
              .prepare("SELECT * FROM opc_agent_runs ORDER BY created_at DESC LIMIT ?")
              .all(limit) as Array<Record<string, unknown>>);
        return rows.map((r) => ({
          id: String(r.id),
          taskId: String(r.task_id),
          taskTitle: String(r.task_title),
          taskDescription: String(r.task_description ?? ""),
          project: String(r.project ?? ""),
          agentId: String(r.agent_id),
          agentName: String(r.agent_name),
          repoPath: r.repo_path ? String(r.repo_path) : null,
          worktreePath: r.worktree_path ? String(r.worktree_path) : null,
          branchName: r.branch_name ? String(r.branch_name) : null,
          status: String(r.status) as AgentRunRecord["status"],
          pid: typeof r.pid === "number" ? r.pid : null,
          tokenUsed: Number(r.token_used ?? 0),
          costUsd: Number(r.cost_usd ?? 0),
          retryCount: Number(r.retry_count ?? 0),
          logFilePath: r.log_file_path ? String(r.log_file_path) : null,
          errorSummary: r.error_summary ? String(r.error_summary) : null,
          prUrl: r.pr_url ? String(r.pr_url) : null,
          changedFiles: [],
          protectedViolations: [],
          circuitBreakerReason: null,
          autoCreatePr: Boolean(r.auto_create_pr),
          verifyCommand: r.verify_command ? String(r.verify_command) : "",
          verification: null,
          startedAt: r.started_at ? String(r.started_at) : null,
          completedAt: r.completed_at ? String(r.completed_at) : null,
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
        }));
      },
      dispatch: () => {
        throw new ApiError(503, "dark_factory_unmounted", "DarkFactoryStore 未挂载，无法执行派发");
      },
    };
  }

  private findBlockingTaskDependencies(row: Record<string, unknown>): string[] {
    const rawDeps = row.depends_on_json;
    if (typeof rawDeps !== "string" || !rawDeps.trim()) return [];
    let dependsOn: string[] = [];
    try {
      const parsed = JSON.parse(rawDeps) as unknown;
      if (Array.isArray(parsed)) {
        dependsOn = parsed.map((d) => String(d ?? "").trim()).filter(Boolean);
      }
    } catch {
      return [];
    }
    if (dependsOn.length === 0) return [];

    const blocking: string[] = [];
    const stmt = this.db.prepare("SELECT status FROM opc_planning_tasks WHERE id = ?");
    for (const depId of dependsOn) {
      const depRow = stmt.get(depId) as { status?: unknown } | undefined;
      const depStatus = depRow ? String(depRow.status ?? "") : "";
      if (depStatus !== "done" && depStatus !== "published") {
        blocking.push(depId);
      }
    }
    return blocking;
  }

  private queryPlanningReadyTasks(): ReadyTaskCandidate[] {
    if (!hasTable(this.db, "opc_planning_tasks")) return [];
    const nowIso = new Date(this.nowFn()).toISOString();
    const rows = this.db
      .prepare(
        `SELECT *
         FROM opc_planning_tasks
         WHERE status = 'todo' AND type != 'epic'
         ORDER BY priority DESC, created_at ASC
         LIMIT 50`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows
      .filter((r) => {
        const snoozedUntil = typeof r.snoozed_until === "string" ? r.snoozed_until.trim() : "";
        if (snoozedUntil && snoozedUntil > nowIso) return false;
        return this.findBlockingTaskDependencies(r).length === 0;
      })
      .map((r) => ({
        id: String(r.id),
        title: String(r.title),
        description: String(r.description ?? ""),
        project: String(r.project ?? "opc-os"),
        priority: Number(r.priority ?? 5),
        ...(r.verify_command ? { verifyCommand: String(r.verify_command) } : {}),
      }));
  }

  selectOptimalAgent(rawInput: SelectOptimalAgentInput): SelectOptimalAgentResult {
    const input = parseInput(routePreviewSchema, rawInput);
    const admission = this.kernel.registry.checkAdmission(input.project, {
      isEmergencyBug: input.isEmergencyBug,
    });
    if (!admission.allowed) {
      throw new ApiError(
        409,
        admission.code ?? "admission_blocked",
        admission.reason ?? "准入被拒",
      );
    }

    const nowMs = this.nowFn();
    const hub = this.readHubFn(nowMs);
    const manualPlans = this.planStore.list();
    const agents = this.darkFactory.listAgents().filter((a) => a.status !== "disabled");
    const activeRuns = this.darkFactory
      .listRuns({ limit: 200 })
      .filter((r) => r.status === "running" || r.status === "queued");

    const loadByAgent = new Map<string, number>();
    for (const run of activeRuns) {
      loadByAgent.set(run.agentId, (loadByAgent.get(run.agentId) ?? 0) + 1);
    }

    const targetCapabilities =
      input.requiredCapabilities && input.requiredCapabilities.length > 0
        ? [...new Set(input.requiredCapabilities.map((c) => c.trim().toLowerCase()).filter(Boolean))]
        : inferCapabilitiesFromTask(input.title, input.description);

    const floorPct = input.isEmergencyBug
      ? 2
      : (input.reserveFloorPct ?? this.reserveFloorPct);

    const agentById = new Map(agents.map((a) => [a.id, a]));
    const candidateScores: AgentCandidateScore[] = [];

    for (const agent of agents) {
      const mapped = matchAgentToHubTool(agent, hub.tools, manualPlans, nowMs);
      const activeLoad = loadByAgent.get(agent.id) ?? 0;

      // Hard exclusions
      let excludeReason: string | null = null;
      if (mapped.diagnostic === "auth_expired" || mapped.diagnostic === "offline") {
        excludeReason = `配额工具「${mapped.matchedTool ?? agent.name}」状态异常 (${mapped.diagnostic})`;
      } else if (
        mapped.isLiveQuota &&
        mapped.remainingPct !== null &&
        mapped.remainingPct < floorPct
      ) {
        excludeReason = `配额余量 ${mapped.remainingPct}% 低于保留红线 ${floorPct}%`;
      }

      const agentCaps = new Set(agent.capabilities.map((c) => c.toLowerCase()));
      const matchedCapabilities = targetCapabilities.filter(
        (cap) =>
          agentCaps.has(cap) ||
          agent.description.toLowerCase().includes(cap) ||
          agent.name.toLowerCase().includes(cap),
      );

      const capabilityScore = matchedCapabilities.length * 15;
      const quotaHeadroomScore = round2((mapped.remainingPct ?? 60) * 0.4);

      let urgencyBonus = 0;
      if (mapped.resetsAt && (mapped.remainingPct ?? 0) >= 20) {
        const msUntilReset = Date.parse(mapped.resetsAt) - nowMs;
        if (msUntilReset > 0 && msUntilReset <= 12 * 3_600_000) {
          urgencyBonus = 25;
        }
      }

      const activeLoadPenalty = activeLoad * 15;
      const rawScore = round2(
        capabilityScore + quotaHeadroomScore + urgencyBonus - activeLoadPenalty,
      );

      candidateScores.push({
        agentId: agent.id,
        agentName: agent.name,
        matchedTool: mapped.matchedTool,
        diagnostic: mapped.diagnostic,
        remainingPct: mapped.remainingPct,
        resetsAt: mapped.resetsAt,
        healthy: mapped.healthy,
        eligible: excludeReason === null,
        excludeReason,
        activeLoad,
        matchedCapabilities,
        breakdown: {
          capabilityScore,
          quotaHeadroomScore,
          urgencyBonus,
          activeLoadPenalty,
        },
        score: excludeReason === null ? rawScore : -10_000,
      });
    }

    candidateScores.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.activeLoad - b.activeLoad;
    });

    const topEligible = candidateScores.find((c) => c.eligible);
    const chosenAgent = topEligible ? (agentById.get(topEligible.agentId) ?? null) : null;

    return {
      chosenAgent,
      candidateScores,
      admission,
    };
  }

  private recordDispatchLog(entry: Omit<QuotaDispatchLogEntry, "id" | "createdAt">): QuotaDispatchLogEntry {
    const id = `qdl_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const createdAt = new Date(this.nowFn()).toISOString();
    this.db
      .prepare(
        `INSERT INTO opc_quota_dispatch_log
         (id, task_id, run_id, agent_id, agent_name, matched_tool, remaining_pct, resets_at, reason, triggered_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.taskId,
        entry.runId,
        entry.agentId,
        entry.agentName,
        entry.matchedTool,
        entry.remainingPct,
        entry.resetsAt,
        entry.reason,
        entry.triggeredBy,
        createdAt,
      );
    return { id, createdAt, ...entry };
  }

  listDispatchLogs(limit = 30): QuotaDispatchLogEntry[] {
    const cap = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.db
      .prepare("SELECT * FROM opc_quota_dispatch_log ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(cap) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      runId: r.run_id ? String(r.run_id) : null,
      agentId: String(r.agent_id),
      agentName: String(r.agent_name),
      matchedTool: r.matched_tool ? String(r.matched_tool) : null,
      remainingPct:
        r.remaining_pct !== null && r.remaining_pct !== undefined ? Number(r.remaining_pct) : null,
      resetsAt: r.resets_at ? String(r.resets_at) : null,
      reason: String(r.reason),
      triggeredBy: String(r.triggered_by),
      createdAt: String(r.created_at),
    }));
  }

  private resolveTaskForDispatch(input: z.infer<typeof smartDispatchSchema>): ReadyTaskCandidate {
    const fromCallback = this.listReadyTasksFn().find((t) => t.id === input.taskId);
    if (fromCallback) {
      return {
        ...fromCallback,
        project: input.project?.trim() || fromCallback.project,
        title: input.title?.trim() || fromCallback.title,
        description: input.description ?? fromCallback.description,
      };
    }

    if (hasTable(this.db, "opc_planning_tasks")) {
      const row = this.db
        .prepare("SELECT * FROM opc_planning_tasks WHERE id = ?")
        .get(input.taskId) as Record<string, unknown> | undefined;
      if (row) {
        if (String(row.type ?? "") === "epic") {
          const childCountRow = this.db
            .prepare("SELECT COUNT(*) AS cnt FROM opc_planning_tasks WHERE parent_id = ?")
            .get(String(row.id)) as { cnt?: number } | undefined;
          if (Number(childCountRow?.cnt ?? 0) > 0) {
            throw new ApiError(400, "epic_has_subtasks", "请派发具体子任务而非父级 Epic");
          }
        }

        const blocking = this.findBlockingTaskDependencies(row);
        if (blocking.length > 0) {
          throw new ApiError(
            409,
            "dependency_blocked",
            "前置依赖任务尚未完成: " + blocking.join(", "),
          );
        }

        return {
          id: String(row.id),
          title: input.title?.trim() || String(row.title),
          description: input.description ?? String(row.description ?? ""),
          project: input.project?.trim() || String(row.project ?? "opc-os"),
          priority: Number(row.priority ?? 5),
          ...(row.verify_command ? { verifyCommand: String(row.verify_command) } : {}),
        };
      }
    }

    if (input.title?.trim() && input.project?.trim()) {
      return {
        id: input.taskId,
        title: input.title.trim(),
        description: input.description ?? "",
        project: input.project.trim(),
        priority: 5,
      };
    }

    throw new ApiError(404, "task_not_found", `未找到待派发任务：${input.taskId}`);
  }

  private syncDispatchedTaskState(task: ReadyTaskCandidate, run: AgentRunRecord) {
    if (hasTable(this.db, "opc_planning_tasks")) {
      try {
        this.db
          .prepare(
            `UPDATE opc_planning_tasks
             SET status = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END,
                 assignee_type = 'agent',
                 assignee_id = ?,
                 assignee_name = ?,
                 latest_run_id = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(run.agentId, run.agentName, run.id, new Date(this.nowFn()).toISOString(), task.id);
      } catch {
        // Ignore if table schema differs
      }
    }
    this.onTaskDispatched?.(task, run);
  }

  dispatchSmart(rawInput: unknown) {
    const input = parseInput(smartDispatchSchema, rawInput);
    const task = this.resolveTaskForDispatch(input);

    const selection = this.selectOptimalAgent({
      project: task.project,
      title: task.title,
      description: task.description,
      requiredCapabilities: input.requiredCapabilities,
      isEmergencyBug: input.isEmergencyBug,
    });

    if (!selection.chosenAgent) {
      throw new ApiError(
        409,
        "no_eligible_agent",
        "当前无满足配额红线与健康门禁的可用 Agent",
      );
    }

    const topScore = selection.candidateScores.find(
      (c) => c.agentId === selection.chosenAgent!.id,
    )!;

    const repoPath =
      input.repoPath?.trim() ||
      selection.admission.resolution.asset?.localRepoPath ||
      undefined;

    const verifyCommand =
      task.verifyCommand || selection.admission.resolution.asset?.verifyCommand || undefined;

    const run = this.darkFactory.dispatch({
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      project: task.project,
      repoPath,
      agentId: selection.chosenAgent.id,
      autoCreatePr: input.autoCreatePr,
      ...(verifyCommand ? { verifyCommand } : {}),
    });

    this.syncDispatchedTaskState(task, run);

    const reasonParts = [
      `综合评分 ${topScore.score}`,
      topScore.matchedTool
        ? `工具=${topScore.matchedTool}(余量=${topScore.remainingPct ?? "未知"}%)`
        : "本地无配额限制脚本",
      topScore.breakdown.urgencyBonus > 0 ? "命中临期重置抢收加分(+25)" : null,
      topScore.matchedCapabilities.length
        ? `能力匹配=${topScore.matchedCapabilities.join(",")}`
        : null,
    ].filter(Boolean);

    const logEntry = this.recordDispatchLog({
      taskId: task.id,
      runId: run.id,
      agentId: selection.chosenAgent.id,
      agentName: selection.chosenAgent.name,
      matchedTool: topScore.matchedTool,
      remainingPct: topScore.remainingPct,
      resetsAt: topScore.resetsAt,
      reason: reasonParts.join(" · "),
      triggeredBy: input.isEmergencyBug ? "smart_dispatch_emergency" : "smart_dispatch",
    });

    return {
      run,
      chosenAgent: selection.chosenAgent,
      candidateScores: selection.candidateScores,
      admission: selection.admission,
      dispatchLog: logEntry,
    };
  }

  private collectExpiringSignals(
    hub: ResourceDepartmentIndex["hub"],
    manualPlans: ManualPlan[],
    nowMs: number,
    windowHours: number,
    minRemainingPct: number,
  ): ExpiringQuotaSignal[] {
    const signals: ExpiringQuotaSignal[] = [];
    const maxWindowMs = windowHours * 3_600_000;

    for (const tool of hub.tools) {
      if (tool.diagnostic === "auth_expired" || (tool.diagnostic as string) === "offline") {
        continue;
      }
      for (const win of tool.windows) {
        if (!win.resetsAt || typeof win.reportedRemaining !== "number") continue;
        const diffMs = Date.parse(win.resetsAt) - nowMs;
        if (diffMs > 0 && diffMs <= maxWindowMs && win.reportedRemaining >= minRemainingPct) {
          signals.push({
            source: "hub",
            tool: tool.tool,
            name: tool.name,
            window: win.name,
            remainingPct: round2(win.reportedRemaining),
            resetsAt: win.resetsAt,
            hoursUntilReset: round2(diffMs / 3_600_000),
          });
        }
      }
    }

    for (const plan of manualPlans) {
      if (!plan.resetsAt || plan.reportedRemaining === null) continue;
      const diffMs = Date.parse(plan.resetsAt) - nowMs;
      const pct =
        plan.unit === "%"
          ? plan.reportedRemaining
          : plan.capacity && plan.capacity > 0
            ? (plan.reportedRemaining / plan.capacity) * 100
            : null;
      if (pct !== null && diffMs > 0 && diffMs <= maxWindowMs && pct >= minRemainingPct) {
        signals.push({
          source: "manual_plan",
          tool: plan.name,
          name: plan.name,
          window: plan.window,
          remainingPct: round2(pct),
          resetsAt: plan.resetsAt,
          hoursUntilReset: round2(diffMs / 3_600_000),
        });
      }
    }

    signals.sort((a, b) => (a.hoursUntilReset ?? 999) - (b.hoursUntilReset ?? 999));
    return signals;
  }

  harvestExpiringQuota(rawOptions?: HarvestExpiringQuotaOptions): HarvestExpiringQuotaResult {
    const opts = parseInput(harvestSchema, rawOptions ?? {});
    const windowHours = opts.windowHours ?? 6;
    const minRemainingPct = opts.minRemainingPct ?? 25;
    const maxDispatches = opts.maxDispatches ?? 2;
    const dryRun = opts.dryRun === true;
    const forced = opts.force === true;

    if (!dryRun && !forced && !this.kernel.decisions.getPolicy().autoHarvestQuota) {
      return {
        triggered: false,
        dryRun,
        forced,
        windowHours,
        minRemainingPct,
        expiringTools: [],
        plannedDispatches: [],
        dispatchedRuns: [],
        reason: "当前自治档位已暂停后台自动榨取派工（可切换至「全自治」或在算力部手动触发）",
      };
    }

    const nowMs = this.nowFn();
    const hub = this.readHubFn(nowMs);
    const manualPlans = this.planStore.list();
    const expiringTools = this.collectExpiringSignals(
      hub,
      manualPlans,
      nowMs,
      windowHours,
      minRemainingPct,
    );

    if (expiringTools.length === 0 && !forced) {
      return {
        triggered: false,
        dryRun,
        forced,
        windowHours,
        minRemainingPct,
        expiringTools: [],
        plannedDispatches: [],
        dispatchedRuns: [],
        reason: `未来 ${windowHours}h 内无剩余 >= ${minRemainingPct}% 的临期闲置额度`,
      };
    }

    const activeTaskIds = new Set(
      this.darkFactory
        .listRuns({ limit: 200 })
        .filter((r) => r.status === "running" || r.status === "queued")
        .map((r) => r.taskId),
    );

    const admittedTasks = this.listReadyTasksFn()
      .filter((t) => !activeTaskIds.has(t.id))
      .map((task) => {
        const admission = this.kernel.registry.checkAdmission(task.project);
        const mainlineWeight = admission.resolution.mainline?.priorityWeight ?? 50;
        const priorityScore = round2(mainlineWeight * 0.6 + (task.priority ?? 5) * 4);
        return { task, admission, priorityScore };
      })
      .filter((item) => item.admission.allowed)
      .sort((a, b) => b.priorityScore - a.priorityScore);

    const plannedDispatches: HarvestExpiringQuotaResult["plannedDispatches"] = [];
    const dispatchedRuns: AgentRunRecord[] = [];

    for (const candidate of admittedTasks) {
      if (plannedDispatches.length >= maxDispatches) break;

      let selection: SelectOptimalAgentResult;
      try {
        selection = this.selectOptimalAgent({
          project: candidate.task.project,
          title: candidate.task.title,
          description: candidate.task.description,
        });
      } catch {
        continue;
      }

      if (!selection.chosenAgent) continue;
      const topScore = selection.candidateScores.find(
        (c) => c.agentId === selection.chosenAgent!.id,
      )!;

      let runId: string | null = null;
      if (!dryRun) {
        const repoPath = selection.admission.resolution.asset?.localRepoPath || undefined;
        const verifyCommand =
          candidate.task.verifyCommand ||
          selection.admission.resolution.asset?.verifyCommand ||
          undefined;
        const run = this.darkFactory.dispatch({
          taskId: candidate.task.id,
          taskTitle: candidate.task.title,
          taskDescription: candidate.task.description ?? "",
          project: candidate.task.project,
          repoPath,
          agentId: selection.chosenAgent.id,
          ...(verifyCommand ? { verifyCommand } : {}),
        });
        runId = run.id;
        dispatchedRuns.push(run);
        this.syncDispatchedTaskState(candidate.task, run);

        this.recordDispatchLog({
          taskId: candidate.task.id,
          runId: run.id,
          agentId: selection.chosenAgent.id,
          agentName: selection.chosenAgent.name,
          matchedTool: topScore.matchedTool,
          remainingPct: topScore.remainingPct,
          resetsAt: topScore.resetsAt,
          reason: `临期配额自动榨取 (主线任务分=${candidate.priorityScore} · Agent分=${topScore.score})`,
          triggeredBy: forced ? "harvest_force" : "harvest_expiring",
        });
      }

      plannedDispatches.push({
        taskId: candidate.task.id,
        taskTitle: candidate.task.title,
        project: candidate.task.project,
        priorityScore: candidate.priorityScore,
        agentId: selection.chosenAgent.id,
        agentName: selection.chosenAgent.name,
        matchedTool: topScore.matchedTool,
        remainingPct: topScore.remainingPct,
        resetsAt: topScore.resetsAt,
        runId,
      });
    }

    const triggered = dryRun ? plannedDispatches.length > 0 : dispatchedRuns.length > 0;

    if (!dryRun && dispatchedRuns.length > 0) {
      this.kernel.events.emit({
        topic: "resources.quota_harvest_triggered",
        sourceDomain: "resources",
        payload: {
          forced,
          windowHours,
          minRemainingPct,
          expiringToolsCount: expiringTools.length,
          expiringTools: expiringTools.map((t) => ({
            tool: t.tool,
            window: t.window,
            remainingPct: t.remainingPct,
            hoursUntilReset: t.hoursUntilReset,
          })),
          dispatchedCount: dispatchedRuns.length,
          dispatches: plannedDispatches,
        },
      });
    }

    return {
      triggered,
      dryRun,
      forced,
      windowHours,
      minRemainingPct,
      expiringTools,
      plannedDispatches,
      dispatchedRuns,
      reason:
        plannedDispatches.length > 0
          ? dryRun
            ? `演练完成：可抢收派发 ${plannedDispatches.length} 项高优主线任务`
            : `已自动派发 ${dispatchedRuns.length} 项高优主线任务消费临期额度`
          : "虽有可用额度，但当前无通过准入门禁的就绪任务或可用 Agent",
    };
  }

  schedulerStatus() {
    const nowMs = this.nowFn();
    const hub = this.readHubFn(nowMs);
    const manualPlans = this.planStore.list();
    const mainlines = this.kernel.registry.listMainlines();
    const activeRuns = this.darkFactory
      .listRuns({ limit: 200 })
      .filter((r) => r.status === "running" || r.status === "queued");

    const tools = hub.tools.map((t) => {
      const windows = t.windows.map((w) => {
        const diffMs = w.resetsAt ? Date.parse(w.resetsAt) - nowMs : null;
        return {
          ...w,
          hoursUntilReset: diffMs !== null && diffMs > 0 ? round2(diffMs / 3_600_000) : null,
          expiringSoon:
            diffMs !== null &&
            diffMs > 0 &&
            diffMs <= 6 * 3_600_000 &&
            (w.reportedRemaining ?? 0) >= 25,
        };
      });
      return {
        tool: t.tool,
        name: t.name,
        plan: t.plan,
        diagnostic: t.diagnostic ?? null,
        windows,
        balances: t.balances,
        monthlyUsd: t.usage?.monthlyUsd ?? null,
      };
    });

    const readyTasks = this.listReadyTasksFn();
    const admittedReadyCount = readyTasks.filter(
      (t) => this.kernel.registry.checkAdmission(t.project).allowed,
    ).length;

    return {
      generatedAt: hub.generatedAt ?? new Date(nowMs).toISOString(),
      reserveFloorPct: this.reserveFloorPct,
      tools,
      fees: hub.fees,
      manualPlans,
      mainlineShares: mainlines.map((m) => ({
        id: m.id,
        slug: m.slug,
        name: m.name,
        status: m.status,
        priorityWeight: m.priorityWeight,
        quotaSharePct: m.quotaSharePct,
        freezeNonMainline: m.freezeNonMainline,
      })),
      readyTasksCount: readyTasks.length,
      admittedReadyTasksCount: admittedReadyCount,
      activeAgentRunsCount: activeRuns.length,
      expiringSignals: this.collectExpiringSignals(hub, manualPlans, nowMs, 6, 25),
      recentDispatches: this.listDispatchLogs(30),
    };
  }

  health(): DepartmentHealth {
    const nowMs = this.nowFn();
    const hub = this.readHubFn(nowMs);
    const manualPlans = this.planStore.list();
    const authExpired = hub.tools.filter((t) => t.diagnostic === "auth_expired").length;
    const expiring = this.collectExpiringSignals(hub, manualPlans, nowMs, 6, 25).length;
    const totalDispatches = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM opc_quota_dispatch_log").get() as
          | { n?: number }
          | undefined
      )?.n ?? 0,
    );

    return {
      healthy: authExpired === 0,
      summary:
        authExpired > 0
          ? `${authExpired} 个 AI CLI 登录态已过期，需重新认证`
          : `监控 ${hub.tools.length} 项工具配额 · 临期可抢收 ${expiring} 项 · 累计智能派发 ${totalDispatches} 次`,
      metrics: {
        monitoredTools: hub.tools.length,
        manualPlans: manualPlans.length,
        authExpiredTools: authExpired,
        expiringWindows: expiring,
        smartDispatches: totalDispatches,
      },
    };
  }

  registerRoutes(app: Hono, requireUser: (c: Context) => { id: string; name: string }) {
    const base = "/api/opc/domains/resources";

    app.use(`${base}/*`, async (c, next) => {
      c.header("Cache-Control", "no-store");
      requireUser(c);
      await next();
    });

    app.get(`${base}/scheduler-status`, (c) => {
      return c.json(this.schedulerStatus());
    });

    app.post(`${base}/route-preview`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(this.selectOptimalAgent(body as SelectOptimalAgentInput));
    });

    app.post(`${base}/dispatch-smart`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(this.dispatchSmart(body));
    });

    app.post(`${base}/harvest`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(this.harvestExpiringQuota(body as HarvestExpiringQuotaOptions));
    });
  }
}
