import { randomUUID } from "node:crypto";
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import type { CompanionServiceId, CompanionServiceStatus } from "../../commercial-types.ts";
import type {
  DecisionPacket,
  DepartmentHealth,
  DepartmentModule,
  OpcKernel,
} from "../../kernel/index.ts";
import type { ResourceDepartmentIndex } from "../../resource-department-types.ts";
import { readHubResourcesWithLiveAuthAsync } from "../../server/resource-department.ts";

export interface CompanionServicesPort {
  checkServices(): Promise<{
    services: CompanionServiceStatus[];
    rawBodies?: Partial<Record<CompanionServiceId, Record<string, unknown>>>;
  }>;
  ensureServices(): Promise<{
    started: CompanionServiceId[];
    services: CompanionServiceStatus[];
  }>;
  serviceOrigins?: () => { ops: string; commerce: string; gtm: string; data_analysis: string };
}

export interface OpsHealthCheckRecord {
  id: string;
  targetId: string;
  targetKind: string;
  healthy: boolean;
  latencyMs: number | null;
  detail: string;
  checkedAt: string;
}

export interface OpsRemediationRecord {
  id: string;
  targetId: string;
  action: string;
  outcome: string;
  detail: string;
  createdAt: string;
}

export interface OpsTargetUptime {
  targetId: string;
  targetKind: string;
  sampleSize: number;
  healthyCount: number;
  uptimePct: number;
  latestHealthy: boolean;
  latestLatencyMs: number | null;
  latestDetail: string;
  latestCheckedAt: string;
}

export interface CrashSummaryItem {
  fingerprint: string;
  product: string;
  errorName: string;
  message: string;
  stack: string;
  latestVersion: string;
  count: number;
}

export interface WatchdogCycleResult {
  checkedAt: string;
  disk: {
    freeGb: number;
    totalGb: number;
    freePct: number;
    healthy: boolean;
  };
  sqlite: {
    quickCheck: string;
    journalMode: string;
    healthy: boolean;
    latencyMs: number;
  };
  companionServices: Array<{
    id: CompanionServiceId;
    name: string;
    healthy: boolean;
    managedCanStart: boolean;
    latencyMs: number | null;
    summary: string;
  }>;
  expiredAuthTools: string[];
  remediationsTriggered: OpsRemediationRecord[];
  escalatedDecisions: DecisionPacket[];
  filedCrashFingerprints: string[];
}

export interface OpsDepartmentOptions {
  kernel: OpcKernel;
  commercialHub?: CompanionServicesPort;
  hubQuotaPath?: string;
  opsOrigin?: string;
  opsDbPath?: string;
  diskPath?: string;
  minDiskFreeGb?: number;
  autoHealEnabled?: boolean;
  enableTimer?: boolean;
  intervalMs?: number;
  readHubFn?: (nowMs: number) => Promise<ResourceDepartmentIndex["hub"]> | ResourceDepartmentIndex["hub"];
  fetchImpl?: typeof fetch;
  nowFn?: () => number;
}

const COMPANION_WATCH_IDS = new Set<CompanionServiceId>([
  "commerce",
  "gtm",
  "ops",
  "data_analysis",
]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export class OpsDepartment implements DepartmentModule {
  readonly id = "ops" as const;
  private readonly db: DatabaseSync;
  private readonly kernel: OpcKernel;
  private readonly commercialHub?: CompanionServicesPort;
  private readonly hubQuotaPath: string;
  private readonly opsOriginOverride?: string;
  private readonly opsDbPath: string;
  private readonly diskPath: string;
  private readonly minDiskFreeGb: number;
  private autoHealEnabled: boolean;
  private readonly enableTimer: boolean;
  private readonly intervalMs: number;
  private readonly readHubFn: (nowMs: number) => Promise<ResourceDepartmentIndex["hub"]> | ResourceDepartmentIndex["hub"];
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningCycle: Promise<WatchdogCycleResult> | null = null;

  constructor(options: OpsDepartmentOptions);
  constructor(kernel: OpcKernel, options?: Omit<OpsDepartmentOptions, "kernel">);
  constructor(
    first: OpsDepartmentOptions | OpcKernel,
    second?: Omit<OpsDepartmentOptions, "kernel">,
  ) {
    const opts: OpsDepartmentOptions =
      "registry" in first && "decisions" in first
        ? { kernel: first, ...(second ?? {}) }
        : first;

    this.kernel = opts.kernel;
    this.db = opts.kernel.db;
    this.commercialHub = opts.commercialHub;
    this.hubQuotaPath =
      opts.hubQuotaPath ?? process.env.OPC_HUB_QUOTA_DB ?? join(homedir(), ".agent-hub", "hub.db");
    this.opsOriginOverride = opts.opsOrigin;
    this.opsDbPath =
      opts.opsDbPath ?? join(process.cwd(), "data", "companion-runtime", "ops", "ops.db");
    this.diskPath = opts.diskPath ?? process.cwd();
    this.minDiskFreeGb = opts.minDiskFreeGb ?? 3.0;
    this.autoHealEnabled = opts.autoHealEnabled ?? true;
    this.enableTimer = opts.enableTimer ?? false;
    this.intervalMs = Math.max(5_000, opts.intervalMs ?? 60_000);
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.readHubFn = opts.readHubFn ?? ((nowMs) => readHubResourcesWithLiveAuthAsync(this.hubQuotaPath, nowMs));
    this.fetchImpl = opts.fetchImpl ?? fetch;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_ops_health_checks (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        healthy INTEGER NOT NULL,
        latency_ms INTEGER,
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ops_health_target
        ON opc_ops_health_checks(target_id, checked_at DESC);

      CREATE TABLE IF NOT EXISTS opc_ops_remediations (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ops_remediations_target
        ON opc_ops_remediations(target_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS opc_ops_reported_crashes (
        fingerprint TEXT PRIMARY KEY,
        reported_at TEXT NOT NULL
      );
    `);

    this.registerDecisionHandlers();
  }

  private registerDecisionHandlers() {
    this.kernel.decisions.registerHandler("ops.retry_restart", async ({ packet, option, note }) => {
      const targetId = String(
        option.payload?.targetId ??
          packet.tags.find((t) => t.startsWith("service:"))?.slice("service:".length) ??
          "companion",
      );
      // Record backoff_reset so the 15-minute backoff counter restarts cleanly
      this.recordRemediation({
        targetId,
        action: "backoff_reset",
        outcome: "reset",
        detail: note ? `人工重置自愈退避窗口：${note}` : "创始人批准重置退避窗口并重新拉起服务",
      });

      if (!this.commercialHub) {
        return { targetId, restarted: false, reason: "commercialHub_not_configured" };
      }

      const ensured = await this.commercialHub.ensureServices();
      const verify = await this.commercialHub.checkServices();
      const matched = verify.services.find((s) => s.id === targetId);
      const healthy = matched ? matched.healthy : verify.services.every((s) => s.healthy);

      this.recordRemediation({
        targetId,
        action: "manual_retry_restart",
        outcome: healthy ? "healed" : "failed",
        detail: healthy
          ? `人工触发重新拉起成功（started=${ensured.started.join(",") || "none"}）`
          : "人工触发重新拉起后探针仍不可达",
      });

      if (healthy) {
        this.kernel.events.emit({
          topic: "ops.service_restarted",
          sourceDomain: "ops",
          payload: {
            targetId,
            trigger: "decision_gateway",
            started: ensured.started,
            healthy: true,
          },
        });
      }

      return {
        targetId,
        started: ensured.started,
        healthy,
      };
    });

    this.kernel.decisions.registerHandler(
      "ops.acknowledge_incident",
      async ({ packet, option, note }) => {
        const targetId = String(option.payload?.targetId ?? packet.kind);
        this.recordRemediation({
          targetId,
          action: "acknowledge_incident",
          outcome: "acknowledged",
          detail: note || `已确认告警：${packet.title}`,
        });
        return {
          acknowledged: true,
          targetId,
          decisionId: packet.id,
        };
      },
    );
  }

  start() {
    if (!this.enableTimer || this.timer) return;
    this.timer = setInterval(() => {
      void this.runWatchdogCycle().catch(() => {
        // Prevent unhandled timer rejection; errors are captured per probe
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private recordHealthCheck(input: {
    targetId: string;
    targetKind: string;
    healthy: boolean;
    latencyMs: number | null;
    detail: string;
    checkedAt: string;
  }): OpsHealthCheckRecord {
    const id = `chk_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    this.db
      .prepare(
        `INSERT INTO opc_ops_health_checks
         (id, target_id, target_kind, healthy, latency_ms, detail, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.targetId,
        input.targetKind,
        input.healthy ? 1 : 0,
        input.latencyMs,
        input.detail,
        input.checkedAt,
      );
    return { id, ...input };
  }

  private recordRemediation(input: {
    targetId: string;
    action: string;
    outcome: string;
    detail: string;
    createdAt?: string;
  }): OpsRemediationRecord {
    const id = `rem_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const createdAt = input.createdAt ?? new Date(this.nowFn()).toISOString();
    this.db
      .prepare(
        `INSERT INTO opc_ops_remediations
         (id, target_id, action, outcome, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.targetId, input.action, input.outcome, input.detail, createdAt);
    return {
      id,
      targetId: input.targetId,
      action: input.action,
      outcome: input.outcome,
      detail: input.detail,
      createdAt,
    };
  }

  private probeDisk(): { freeGb: number; totalGb: number; freePct: number; healthy: boolean } {
    const stats = statfsSync(this.diskPath);
    const bsize = Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * bsize;
    const totalBytes = Number(stats.blocks) * bsize;
    const freeGb = round2(freeBytes / 1024 ** 3);
    const totalGb = round2(totalBytes / 1024 ** 3);
    const freePct = totalBytes > 0 ? round1((freeBytes / totalBytes) * 100) : 100;
    const healthy = freeGb >= this.minDiskFreeGb;
    return { freeGb, totalGb, freePct, healthy };
  }

  private probeSqlite(): {
    quickCheck: string;
    journalMode: string;
    healthy: boolean;
    latencyMs: number;
  } {
    const started = Date.now();
    try {
      const qcRow = this.db.prepare("PRAGMA quick_check(1)").get() as
        | Record<string, unknown>
        | undefined;
      const quickCheck = String(
        qcRow?.quick_check ?? (qcRow ? Object.values(qcRow)[0] : "error") ?? "error",
      );
      const jmRow = this.db.prepare("PRAGMA journal_mode").get() as
        | Record<string, unknown>
        | undefined;
      const journalMode = String(
        jmRow?.journal_mode ?? (jmRow ? Object.values(jmRow)[0] : "unknown") ?? "unknown",
      );
      const latencyMs = Math.max(0, Date.now() - started);
      return {
        quickCheck,
        journalMode,
        healthy: quickCheck.toLowerCase() === "ok",
        latencyMs,
      };
    } catch (err) {
      return {
        quickCheck: err instanceof Error ? err.message : "sqlite_error",
        journalMode: "unknown",
        healthy: false,
        latencyMs: Math.max(0, Date.now() - started),
      };
    }
  }

  private countRecentRestartAttempts(targetId: string, nowMs: number): {
    attempts: number;
    failedAttempts: number;
  } {
    const fifteenMinAgo = new Date(nowMs - 15 * 60_000).toISOString();
    const lastResetRow = this.db
      .prepare(
        `SELECT MAX(created_at) AS reset_at
         FROM opc_ops_remediations
         WHERE target_id = ? AND action = 'backoff_reset' AND created_at >= ?`,
      )
      .get(targetId, fifteenMinAgo) as { reset_at?: string | null } | undefined;

    const windowStart =
      lastResetRow?.reset_at && lastResetRow.reset_at > fifteenMinAgo
        ? lastResetRow.reset_at
        : fifteenMinAgo;

    // When backoff_reset was recorded at exact same millisecond, use strictly greater (`>`)
    const rows = lastResetRow?.reset_at
      ? (this.db
          .prepare(
            `SELECT outcome FROM opc_ops_remediations
             WHERE target_id = ? AND action = 'auto_restart' AND created_at > ?`,
          )
          .all(targetId, windowStart) as Array<{ outcome: string }>)
      : (this.db
          .prepare(
            `SELECT outcome FROM opc_ops_remediations
             WHERE target_id = ? AND action = 'auto_restart' AND created_at >= ?`,
          )
          .all(targetId, windowStart) as Array<{ outcome: string }>);

    return {
      attempts: rows.length,
      failedAttempts: rows.filter((r) => r.outcome === "failed").length,
    };
  }

  private async escalateServiceDown(svc: CompanionServiceStatus, failedCount: number) {
    const packet = await this.kernel.decisions.propose({
      dedupeKey: `ops:service_down:${svc.id}`,
      domain: "ops",
      kind: "service_down",
      riskLevel: "high",
      projectOrAssetRef: svc.repo,
      title: `伴生服务宕机升级：${svc.name}`,
      backgroundSummary: `服务「${svc.name}」(${svc.origin}) 在过去 15 分钟内已连续 ${failedCount} 次自动拉起失败，已触发退避熔断，避免死循环重启风暴。`,
      whyRecommended: "建议排查端口占用或查看伴生进程启动日志后，一键重置退避并重新拉起。",
      diffOrEvidence: `service=${svc.id} · origin=${svc.origin} · failed_restarts_15m=${failedCount}`,
      rollbackPlan: "选择暂缓处理以保持退避静默，不影响 OPC OS 主控运行。",
      tags: ["ops", "self_heal", `service:${svc.id}`],
      recommendedOptionId: "retry_restart",
      options: [
        {
          id: "retry_restart",
          label: "重置退避窗口并立即重试拉起",
          outcome: "approved",
          handlerKey: "ops.retry_restart",
          payload: { targetId: svc.id },
        },
        {
          id: "ack_mute",
          label: "知悉并暂缓（手工排查）",
          outcome: "snoozed",
          handlerKey: "ops.acknowledge_incident",
          payload: { targetId: svc.id },
        },
      ],
    });

    this.kernel.events.emit({
      topic: "ops.incident_escalated",
      sourceDomain: "ops",
      payload: {
        kind: "service_down",
        targetId: svc.id,
        serviceName: svc.name,
        failedCount,
        decisionId: packet.id,
      },
    });

    return packet;
  }

  private async fetchHighFrequencyCrashes(
    opsOrigin: string | null,
    opsOnline: boolean,
  ): Promise<CrashSummaryItem[]> {
    // 1. Try HTTP endpoints when Ops service is online (or origin explicitly set)
    if (opsOrigin && opsOnline) {
      for (const path of ["/api/v1/crashes", "/api/v1/telemetry/crashes"]) {
        try {
          const res = await this.fetchImpl(opsOrigin.replace(/\/+$/, "") + path, {
            headers: { accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(1500),
          });
          if (!res.ok) continue;
          const body = (await res.json()) as unknown;
          const rawList = Array.isArray(body)
            ? body
            : body && typeof body === "object" && Array.isArray((body as { crashes?: unknown }).crashes)
              ? ((body as { crashes: unknown[] }).crashes)
              : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)
                ? ((body as { items: unknown[] }).items)
                : null;

          if (rawList) {
            return rawList
              .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
              .map((c) => ({
                fingerprint: String(c.fingerprint ?? ""),
                product: String(c.product ?? "PageLens"),
                errorName: String(c.errorName ?? c.error_name ?? "RuntimeCrash"),
                message: String(c.message ?? ""),
                stack: String(c.stack ?? ""),
                latestVersion: String(c.latestVersion ?? c.latest_version ?? ""),
                count: Number(c.count ?? 0),
              }))
              .filter((c) => c.fingerprint.length > 0 && c.count >= 3);
          }
        } catch {
          // Try next path or fall back to local SQLite
        }
      }
    }

    // 2. Offline read-only SQLite fallback on local ops.db
    if (existsSync(this.opsDbPath)) {
      let extDb: DatabaseSync | null = null;
      try {
        extDb = new DatabaseSync(this.opsDbPath, { readOnly: true });
        const hasCrashTable = Boolean(
          extDb
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ops_crashes'")
            .get(),
        );
        if (!hasCrashTable) return [];
        const rows = extDb
          .prepare("SELECT * FROM ops_crashes WHERE count >= 3 ORDER BY count DESC LIMIT 50")
          .all() as Array<Record<string, unknown>>;
        return rows
          .map((c) => ({
            fingerprint: String(c.fingerprint ?? ""),
            product: String(c.product ?? "PageLens"),
            errorName: String(c.error_name ?? c.errorName ?? "RuntimeCrash"),
            message: String(c.message ?? ""),
            stack: String(c.stack ?? ""),
            latestVersion: String(c.latest_version ?? c.latestVersion ?? ""),
            count: Number(c.count ?? 0),
          }))
          .filter((c) => c.fingerprint.length > 0 && c.count >= 3);
      } catch {
        return [];
      } finally {
        try {
          extDb?.close();
        } catch {
          // ignore close error
        }
      }
    }

    return [];
  }

  async runWatchdogCycle(options?: { forceHeal?: boolean }): Promise<WatchdogCycleResult> {
    if (this.runningCycle) return this.runningCycle;
    this.runningCycle = this.executeWatchdogCycle(options).finally(() => {
      this.runningCycle = null;
    });
    return this.runningCycle;
  }

  private async executeWatchdogCycle(options?: { forceHeal?: boolean }): Promise<WatchdogCycleResult> {
    const nowMs = this.nowFn();
    const checkedAt = new Date(nowMs).toISOString();
    const remediationsTriggered: OpsRemediationRecord[] = [];
    const escalatedDecisions: DecisionPacket[] = [];
    const filedCrashFingerprints: string[] = [];

    // 1. Disk Free Space Probe
    const diskStart = Date.now();
    const disk = this.probeDisk();
    this.recordHealthCheck({
      targetId: "host:disk",
      targetKind: "disk",
      healthy: disk.healthy,
      latencyMs: Math.max(0, Date.now() - diskStart),
      detail: `可用 ${disk.freeGb} GB / 总计 ${disk.totalGb} GB (${disk.freePct}%)`,
      checkedAt,
    });

    // 2. SQLite Quick Check + WAL Check
    const sqlite = this.probeSqlite();
    this.recordHealthCheck({
      targetId: "sqlite:main",
      targetKind: "database",
      healthy: sqlite.healthy,
      latencyMs: sqlite.latencyMs,
      detail: `quick_check=${sqlite.quickCheck} · journal_mode=${sqlite.journalMode}`,
      checkedAt,
    });

    // 3. Companion Services + Tier-1 Self-Healing with Backoff
    let companionServices: CompanionServiceStatus[] = [];
    if (this.commercialHub) {
      const initialCheck = await this.commercialHub.checkServices();
      companionServices = initialCheck.services.filter((s) => COMPANION_WATCH_IDS.has(s.id));

      const unhealthyManaged = companionServices.filter(
        (svc) => !svc.healthy && svc.managedCanStart,
      );

      const allowHeal =
        this.autoHealEnabled &&
        (Boolean(options?.forceHeal) || this.kernel.decisions.getPolicy().autoHealOps);

      if (allowHeal && unhealthyManaged.length > 0) {
        const candidatesToRestart: CompanionServiceStatus[] = [];

        for (const svc of unhealthyManaged) {
          const { attempts, failedAttempts } = this.countRecentRestartAttempts(svc.id, nowMs);
          if (failedAttempts < 3 && attempts < 5) {
            candidatesToRestart.push(svc);
          } else {
            const dec = await this.escalateServiceDown(svc, Math.max(failedAttempts, attempts));
            escalatedDecisions.push(dec);
          }
        }

        if (candidatesToRestart.length > 0) {
          const ensured = await this.commercialHub.ensureServices();
          const reverified = await this.commercialHub.checkServices();
          companionServices = reverified.services.filter((s) => COMPANION_WATCH_IDS.has(s.id));

          for (const prevSvc of candidatesToRestart) {
            const afterSvc = companionServices.find((s) => s.id === prevSvc.id);
            const healed = Boolean(afterSvc?.healthy);
            const rem = this.recordRemediation({
              targetId: prevSvc.id,
              action: "auto_restart",
              outcome: healed ? "healed" : "failed",
              detail: healed
                ? `自动拉起恢复在线（started=${ensured.started.join(",") || prevSvc.id}）`
                : `自动拉起后健康检查仍失败`,
              createdAt: checkedAt,
            });
            remediationsTriggered.push(rem);

            if (healed) {
              this.kernel.events.emit({
                topic: "ops.service_restarted",
                sourceDomain: "ops",
                payload: {
                  targetId: prevSvc.id,
                  serviceName: prevSvc.name,
                  origin: prevSvc.origin,
                  healed: true,
                },
              });
            } else {
              const afterCounts = this.countRecentRestartAttempts(prevSvc.id, nowMs);
              if (afterCounts.failedAttempts >= 3 || afterCounts.attempts >= 5) {
                const dec = await this.escalateServiceDown(
                  prevSvc,
                  Math.max(afterCounts.failedAttempts, afterCounts.attempts),
                );
                escalatedDecisions.push(dec);
              }
            }
          }
        }
      }

      for (const svc of companionServices) {
        this.recordHealthCheck({
          targetId: `service:${svc.id}`,
          targetKind: "companion_service",
          healthy: svc.healthy,
          latencyMs: svc.latencyMs,
          detail: svc.summary,
          checkedAt,
        });
      }
    }

    // 4. AI CLI Auth Expiry Check (with automatic stale-alert cleanup once live CLI auth recovers)
    const hub = await this.readHubFn(nowMs);
    const expiredTools = hub.tools.filter((t) => t.diagnostic === "auth_expired");
    const expiredToolIds = new Set(expiredTools.map((t) => t.tool));
    for (const tool of hub.tools) {
      if (expiredToolIds.has(tool.tool)) continue;
      const staleKey = `ops:auth_expired:${tool.tool}`;
      const staleRow = this.db
        .prepare("SELECT id FROM opc_decision_packets WHERE dedupe_key = ? AND status = 'pending' LIMIT 1")
        .get(staleKey) as { id?: string } | undefined;
      if (staleRow?.id) {
        try {
          await this.kernel.decisions.resolve(String(staleRow.id), {
            optionId: "ack_relogin",
            note: `实时 CLI 登录核验已恢复正常（${tool.tool}），自动消除旧告警`,
            actor: "ops-watchdog",
          });
        } catch {
          // ignore if concurrently resolved
        }
      }
    }

    this.recordHealthCheck({
      targetId: "cli:auth",
      targetKind: "cli_auth",
      healthy: expiredTools.length === 0,
      latencyMs: 0,
      detail:
        expiredTools.length === 0
          ? `全部 ${hub.tools.length} 个 AI CLI 登录态正常`
          : `过期工具：${expiredTools.map((t) => t.tool).join(", ")}`,
      checkedAt,
    });

    for (const tool of expiredTools) {
      const loginHint =
        tool.tool === "cursor"
          ? "请在终端运行 `cursor-agent status` 核验或执行 `cursor-agent login` 完成登录。"
          : `请在本机终端重新登录 ${tool.name} CLI 后确认恢复。`;
      const dec = await this.kernel.decisions.propose({
        dedupeKey: `ops:auth_expired:${tool.tool}`,
        domain: "ops",
        kind: "cli_auth_expired",
        riskLevel: "medium",
        title: `AI CLI 登录态已失效：${tool.name} (${tool.tool})`,
        backgroundSummary: `资源探针与本机 CLI 核验均检测到「${tool.name}」未处于已登录状态，配额路由器已自动将其临时隔离，避免暗工厂任务失败。\n\n${loginHint}`,
        whyRecommended: "完成本机 CLI 登录验证后可立即恢复调度权重；若暂不使用该工具，可选择暂缓处理。",
        diffOrEvidence: `tool=${tool.tool} · plan=${tool.plan ?? "unknown"} · diagnostic=auth_expired`,
        rollbackPlan: "未重新登录前，调度器会自动路由至其余健康 CLI。",
        tags: ["ops", "cli_auth", `tool:${tool.tool}`],
        recommendedOptionId: "ack_relogin",
        options: [
          {
            id: "ack_relogin",
            label: "已完成重新登录",
            outcome: "approved",
            handlerKey: "ops.acknowledge_incident",
            payload: { targetId: `cli:${tool.tool}`, tool: tool.tool },
          },
          {
            id: "snooze_relogin",
            label: "稍后处理（继续使用备用模型）",
            outcome: "snoozed",
            handlerKey: "ops.acknowledge_incident",
            payload: { targetId: `cli:${tool.tool}`, tool: tool.tool },
          },
        ],
      });
      escalatedDecisions.push(dec);
    }

    // 5. Tier-2 Crash-to-Bug Loop
    const opsSvc = companionServices.find((s) => s.id === "ops");
    const opsOrigin =
      this.opsOriginOverride ||
      opsSvc?.origin ||
      this.commercialHub?.serviceOrigins?.().ops ||
      process.env.OPC_OPS_URL ||
      "http://127.0.0.1:52333";
    const opsOnline = opsSvc ? opsSvc.healthy : Boolean(this.opsOriginOverride);

    const crashes = await this.fetchHighFrequencyCrashes(opsOrigin, opsOnline);
    for (const crash of crashes) {
      const alreadyReported = this.db
        .prepare("SELECT 1 FROM opc_ops_reported_crashes WHERE fingerprint = ?")
        .get(crash.fingerprint);
      if (alreadyReported) continue;

      this.db
        .prepare("INSERT INTO opc_ops_reported_crashes (fingerprint, reported_at) VALUES (?, ?)")
        .run(crash.fingerprint, checkedAt);

      const resolved = this.kernel.registry.resolveCanonicalRef(crash.product);
      this.kernel.events.emit({
        topic: "ops.crash_bug_filed",
        sourceDomain: "ops",
        mainlineId: resolved.mainline?.id ?? null,
        productId: resolved.product?.id ?? null,
        assetId: resolved.asset?.id ?? null,
        payload: {
          fingerprint: crash.fingerprint,
          product: crash.product,
          errorName: crash.errorName,
          message: crash.message,
          stack: crash.stack,
          latestVersion: crash.latestVersion,
          count: crash.count,
          title: `[线上高频崩溃 x${crash.count}] ${crash.errorName}: ${crash.message.slice(0, 120)}`,
          isEmergencyBug: true,
        },
      });

      const rem = this.recordRemediation({
        targetId: `crash:${crash.fingerprint}`,
        action: "crash_bug_filed",
        outcome: "filed",
        detail: `${crash.product} 崩溃指纹 ${crash.fingerprint} 累计 ${crash.count} 次，已自动转交产品/暗工厂立项修复`,
        createdAt: checkedAt,
      });
      remediationsTriggered.push(rem);
      filedCrashFingerprints.push(crash.fingerprint);
    }

    return {
      checkedAt,
      disk,
      sqlite,
      companionServices: companionServices.map((s) => ({
        id: s.id,
        name: s.name,
        healthy: s.healthy,
        managedCanStart: s.managedCanStart,
        latencyMs: s.latencyMs,
        summary: s.summary,
      })),
      expiredAuthTools: expiredTools.map((t) => t.tool),
      remediationsTriggered,
      escalatedDecisions,
      filedCrashFingerprints,
    };
  }

  watchdogSnapshot() {
    const targetRows = this.db
      .prepare("SELECT DISTINCT target_id, target_kind FROM opc_ops_health_checks ORDER BY target_id ASC")
      .all() as Array<{ target_id: string; target_kind: string }>;

    const latestChecks: OpsHealthCheckRecord[] = [];
    const uptimeByTarget: OpsTargetUptime[] = [];

    for (const t of targetRows) {
      const recent = this.db
        .prepare(
          `SELECT id, target_id, target_kind, healthy, latency_ms, detail, checked_at
           FROM opc_ops_health_checks
           WHERE target_id = ?
           ORDER BY checked_at DESC, rowid DESC
           LIMIT 50`,
        )
        .all(t.target_id) as Array<Record<string, unknown>>;

      if (recent.length === 0) continue;
      const latest = recent[0];
      const latestRecord: OpsHealthCheckRecord = {
        id: String(latest.id),
        targetId: String(latest.target_id),
        targetKind: String(latest.target_kind),
        healthy: Boolean(latest.healthy),
        latencyMs:
          latest.latency_ms !== null && latest.latency_ms !== undefined
            ? Number(latest.latency_ms)
            : null,
        detail: String(latest.detail),
        checkedAt: String(latest.checked_at),
      };
      latestChecks.push(latestRecord);

      const healthyCount = recent.filter((r) => Boolean(r.healthy)).length;
      const uptimePct = round1((healthyCount / recent.length) * 100);
      uptimeByTarget.push({
        targetId: latestRecord.targetId,
        targetKind: latestRecord.targetKind,
        sampleSize: recent.length,
        healthyCount,
        uptimePct,
        latestHealthy: latestRecord.healthy,
        latestLatencyMs: latestRecord.latencyMs,
        latestDetail: latestRecord.detail,
        latestCheckedAt: latestRecord.checkedAt,
      });
    }

    const disk = this.probeDisk();
    const sqlite = this.probeSqlite();

    const remediationRows = this.db
      .prepare(
        `SELECT id, target_id, action, outcome, detail, created_at
         FROM opc_ops_remediations
         ORDER BY created_at DESC, rowid DESC
         LIMIT 50`,
      )
      .all() as Array<Record<string, unknown>>;

    const remediations: OpsRemediationRecord[] = remediationRows.map((r) => ({
      id: String(r.id),
      targetId: String(r.target_id),
      action: String(r.action),
      outcome: String(r.outcome),
      detail: String(r.detail),
      createdAt: String(r.created_at),
    }));

    const reportedCrashes = this.db
      .prepare("SELECT fingerprint, reported_at FROM opc_ops_reported_crashes ORDER BY reported_at DESC")
      .all() as Array<{ fingerprint: string; reported_at: string }>;

    return {
      autoHealEnabled: this.autoHealEnabled,
      timerRunning: Boolean(this.timer),
      diskFreeGb: disk.freeGb,
      disk,
      sqlite,
      latestChecks,
      uptimeByTarget,
      uptimes: uptimeByTarget,
      remediations,
      reportedCrashes: reportedCrashes.map((c) => ({
        fingerprint: String(c.fingerprint),
        reportedAt: String(c.reported_at),
      })),
    };
  }

  health(): DepartmentHealth {
    const snap = this.watchdogSnapshot();
    const unhealthyTargets = snap.latestChecks.filter((c) => !c.healthy);
    const healthy = snap.disk.healthy && snap.sqlite.healthy && unhealthyTargets.length === 0;
    return {
      healthy,
      summary: healthy
        ? `磁盘可用 ${snap.disk.freeGb} GB · SQLite ${snap.sqlite.quickCheck} · 自愈动作 ${snap.remediations.length} 次`
        : `检测到异常目标：${unhealthyTargets.map((t) => t.targetId).join(", ") || (!snap.disk.healthy ? "host:disk" : "sqlite:main")}`,
      metrics: {
        diskFreeGb: snap.disk.freeGb,
        sqliteHealthy: snap.sqlite.healthy,
        monitoredTargets: snap.latestChecks.length,
        unhealthyTargets: unhealthyTargets.length,
        remediationsCount: snap.remediations.length,
        reportedCrashesCount: snap.reportedCrashes.length,
      },
    };
  }

  registerRoutes(app: Hono, requireUser: (c: Context) => { id: string; name: string }) {
    const base = "/api/opc/domains/ops";

    app.use(`${base}/*`, async (c, next) => {
      c.header("Cache-Control", "no-store");
      requireUser(c);
      await next();
    });

    app.get(`${base}/watchdog`, (c) => {
      return c.json(this.watchdogSnapshot());
    });

    app.post(`${base}/watchdog/run`, async (c) => {
      let forceHeal = false;
      try {
        const raw = await c.req.text();
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as { forceHeal?: unknown };
          forceHeal = parsed.forceHeal === true;
        }
      } catch {
        // ignore empty/non-json body
      }
      const cycle = await this.runWatchdogCycle({ forceHeal });
      return c.json({
        cycle,
        watchdog: this.watchdogSnapshot(),
      });
    });
  }
}
