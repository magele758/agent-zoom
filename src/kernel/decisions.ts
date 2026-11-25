import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "../server/logic.ts";
import { isDigestOrNonActionableNoise } from "./admission-filter.ts";
import type { DomainEventBus } from "./events.ts";
import type { AssetRegistry } from "./registry.ts";
import type {
  AutonomyMode,
  BatchResolveDecisionInput,
  BatchResolveDecisionResult,
  BatchResolveItemOutcome,
  BotArbitrationMode,
  CompanyDepartmentId,
  DecisionActionHandler,
  DecisionBatchAction,
  DecisionBotContext,
  DecisionOption,
  DecisionPacket,
  DecisionProposeInput,
  DecisionResolveInput,
  DecisionRiskLevel,
  DecisionStatus,
  GovernancePolicy,
} from "./types.ts";

export const NON_DELEGABLE_DECISION_KINDS = new Set<string>([
  "pricing_change",
  "security_override",
]);

export function isBotArbitrationMode(value: unknown): value is BotArbitrationMode {
  return value === "off" || value === "advisory" || value === "delegated_safe" || value === "full_delegated";
}

const DEFAULT_REDLINE_KINDS = [
  "production_release",
  "mainline_change",
  "kill_switch",
  "pricing_change",
  "security_override",
  "freeze_override",
];
const updatedDecisionReason = "审批单的内容已有更新，请刷新后重新核对审批范围。";

const AUTONOMY_MODE_PRESETS: Record<
  AutonomyMode,
  {
    autoApproveLowRisk: boolean;
    autoPromoteSignals: boolean;
    autoHarvestQuota: boolean;
    autoHealOps: boolean;
  }
> = {
  assisted: {
    autoApproveLowRisk: false,
    autoPromoteSignals: false,
    autoHarvestQuota: false,
    autoHealOps: false,
  },
  semi_auto: {
    autoApproveLowRisk: false,
    autoPromoteSignals: false,
    autoHarvestQuota: false,
    autoHealOps: true,
  },
  full_auto: {
    autoApproveLowRisk: true,
    autoPromoteSignals: true,
    autoHarvestQuota: true,
    autoHealOps: true,
  },
};

function isAutonomyMode(value: unknown): value is AutonomyMode {
  return value === "assisted" || value === "semi_auto" || value === "full_auto";
}

function inferAutonomyMode(flags: {
  autoApproveLowRisk: boolean;
  autoPromoteSignals: boolean;
  autoHarvestQuota: boolean;
  autoHealOps: boolean;
}): AutonomyMode {
  if (
    !flags.autoApproveLowRisk &&
    !flags.autoPromoteSignals &&
    !flags.autoHarvestQuota &&
    !flags.autoHealOps
  ) {
    return "assisted";
  }
  if (
    flags.autoApproveLowRisk &&
    flags.autoPromoteSignals &&
    flags.autoHarvestQuota &&
    flags.autoHealOps
  ) {
    return "full_auto";
  }
  return "semi_auto";
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class DecisionGateway {
  private db: DatabaseSync;
  private events: DomainEventBus;
  private registry: AssetRegistry;
  private handlers = new Map<string, DecisionActionHandler>();
  private actionGuards = new Map<string, (packet: DecisionPacket) => string | undefined>();

  constructor(db: DatabaseSync, events: DomainEventBus, registry: AssetRegistry) {
    this.db = db;
    this.events = events;
    this.registry = registry;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_governance_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        autonomy_mode TEXT NOT NULL DEFAULT 'full_auto',
        auto_approve_low_risk INTEGER NOT NULL DEFAULT 1,
        auto_approve_max_cost_usd REAL NOT NULL DEFAULT 2.0,
        auto_promote_signals INTEGER NOT NULL DEFAULT 1,
        auto_harvest_quota INTEGER NOT NULL DEFAULT 1,
        auto_heal_ops INTEGER NOT NULL DEFAULT 1,
        redline_kinds_json TEXT NOT NULL,
        bot_arbitration_mode TEXT NOT NULL DEFAULT 'off',
        auto_approve_verified_releases INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_decision_packets (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL,
        domain TEXT NOT NULL,
        kind TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        mainline_id TEXT,
        product_id TEXT,
        asset_id TEXT,
        title TEXT NOT NULL,
        background_summary TEXT NOT NULL,
        why_recommended TEXT NOT NULL DEFAULT '',
        cost_estimate_usd REAL,
        diff_or_evidence TEXT NOT NULL DEFAULT '',
        rollback_plan TEXT NOT NULL DEFAULT '',
        options_json TEXT NOT NULL,
        recommended_option_id TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        viewed_at TEXT,
        chosen_option_id TEXT,
        decision_note TEXT NOT NULL DEFAULT '',
        decided_by TEXT,
        auto_approved INTEGER NOT NULL DEFAULT 0,
        handler_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_decision_packets_status ON opc_decision_packets(status, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_packets_pending_dedupe
        ON opc_decision_packets(dedupe_key) WHERE status = 'pending';
    `);

    // Migrate existing databases that predate autonomy_mode & granular automation flags
    const policyCols = new Set(
      (
        this.db
          .prepare("PRAGMA table_info(opc_governance_policy)")
          .all() as Array<{ name?: string }>
      ).map((col) => String(col.name ?? "")),
    );
    if (!policyCols.has("autonomy_mode")) {
      this.db.exec("ALTER TABLE opc_governance_policy ADD COLUMN autonomy_mode TEXT NOT NULL DEFAULT 'full_auto'");
    }
    if (!policyCols.has("auto_promote_signals")) {
      this.db.exec("ALTER TABLE opc_governance_policy ADD COLUMN auto_promote_signals INTEGER NOT NULL DEFAULT 1");
    }
    if (!policyCols.has("auto_harvest_quota")) {
      this.db.exec("ALTER TABLE opc_governance_policy ADD COLUMN auto_harvest_quota INTEGER NOT NULL DEFAULT 1");
    }
    if (!policyCols.has("auto_heal_ops")) {
      this.db.exec("ALTER TABLE opc_governance_policy ADD COLUMN auto_heal_ops INTEGER NOT NULL DEFAULT 1");
    }
    if (!policyCols.has("bot_arbitration_mode")) {
      this.db.exec("ALTER TABLE opc_governance_policy ADD COLUMN bot_arbitration_mode TEXT NOT NULL DEFAULT 'off'");
    }
    if (!policyCols.has("auto_approve_verified_releases")) {
      this.db.exec("ALTER TABLE opc_governance_policy ADD COLUMN auto_approve_verified_releases INTEGER NOT NULL DEFAULT 0");
    }

    const existingPolicy = this.db
      .prepare("SELECT 1 FROM opc_governance_policy WHERE singleton = 1")
      .get();
    if (!existingPolicy) {
      this.db
        .prepare(
          `INSERT INTO opc_governance_policy
           (singleton, autonomy_mode, auto_approve_low_risk, auto_approve_max_cost_usd,
            auto_promote_signals, auto_harvest_quota, auto_heal_ops, redline_kinds_json,
            bot_arbitration_mode, auto_approve_verified_releases, updated_at)
           VALUES (1, 'full_auto', 1, 2.0, 1, 1, 1, ?, 'off', 0, ?)`,
        )
        .run(JSON.stringify(DEFAULT_REDLINE_KINDS), new Date().toISOString());
    }
  }

  registerHandler(handlerKey: string, handler: DecisionActionHandler) {
    this.handlers.set(handlerKey, handler);
  }

  registerActionGuard(domain: CompanyDepartmentId, kind: string, guard: (packet: DecisionPacket) => string | undefined) {
    this.actionGuards.set(`${domain}:${kind}`, guard);
  }

  private actionBlockReason(packet: DecisionPacket): string | undefined {
    return this.actionGuards.get(`${packet.domain}:${packet.kind}`)?.(packet);
  }

  getPolicy(): GovernancePolicy {
    const row = this.db
      .prepare("SELECT * FROM opc_governance_policy WHERE singleton = 1")
      .get() as Record<string, unknown>;
    const autoApproveLowRisk = Boolean(row.auto_approve_low_risk);
    const autoPromoteSignals = row.auto_promote_signals === undefined ? true : Boolean(row.auto_promote_signals);
    const autoHarvestQuota = row.auto_harvest_quota === undefined ? true : Boolean(row.auto_harvest_quota);
    const autoHealOps = row.auto_heal_ops === undefined ? true : Boolean(row.auto_heal_ops);
    const rawMode = row.autonomy_mode;
    const autonomyMode: AutonomyMode = isAutonomyMode(rawMode)
      ? rawMode
      : inferAutonomyMode({
          autoApproveLowRisk,
          autoPromoteSignals,
          autoHarvestQuota,
          autoHealOps,
        });
    const botArbitrationMode: BotArbitrationMode = isBotArbitrationMode(row.bot_arbitration_mode)
      ? row.bot_arbitration_mode
      : "off";
    const autoApproveVerifiedReleases = Boolean(row.auto_approve_verified_releases);
    return {
      autonomyMode,
      autoApproveLowRisk,
      autoApproveMaxCostUsd: Number(row.auto_approve_max_cost_usd ?? 2.0),
      autoPromoteSignals,
      autoHarvestQuota,
      autoHealOps,
      redlineKinds: safeJson<string[]>(String(row.redline_kinds_json ?? "[]"), DEFAULT_REDLINE_KINDS),
      botArbitrationMode,
      autoApproveVerifiedReleases,
      updatedAt: String(row.updated_at),
    };
  }

  updatePolicy(patch: {
    autonomyMode?: AutonomyMode;
    autoApproveLowRisk?: boolean;
    autoApproveMaxCostUsd?: number;
    autoPromoteSignals?: boolean;
    autoHarvestQuota?: boolean;
    autoHealOps?: boolean;
    redlineKinds?: string[];
    botArbitrationMode?: BotArbitrationMode;
    autoApproveVerifiedReleases?: boolean;
  }): GovernancePolicy {
    const current = this.getPolicy();
    const preset =
      patch.autonomyMode !== undefined
        ? isAutonomyMode(patch.autonomyMode)
          ? AUTONOMY_MODE_PRESETS[patch.autonomyMode]
          : (() => {
              throw new ApiError(400, "bad_autonomy_mode", `无效自治档位: ${String(patch.autonomyMode)}`);
            })()
        : null;

    const autoApproveLowRisk =
      patch.autoApproveLowRisk ?? (preset ? preset.autoApproveLowRisk : current.autoApproveLowRisk);
    const autoPromoteSignals =
      patch.autoPromoteSignals ?? (preset ? preset.autoPromoteSignals : current.autoPromoteSignals);
    const autoHarvestQuota =
      patch.autoHarvestQuota ?? (preset ? preset.autoHarvestQuota : current.autoHarvestQuota);
    const autoHealOps = patch.autoHealOps ?? (preset ? preset.autoHealOps : current.autoHealOps);

    const hasFlagOverride =
      patch.autoApproveLowRisk !== undefined ||
      patch.autoPromoteSignals !== undefined ||
      patch.autoHarvestQuota !== undefined ||
      patch.autoHealOps !== undefined;

    const autonomyMode: AutonomyMode =
      patch.autonomyMode !== undefined && !hasFlagOverride
        ? patch.autonomyMode
        : inferAutonomyMode({
            autoApproveLowRisk,
            autoPromoteSignals,
            autoHarvestQuota,
            autoHealOps,
          });

    let maxCost = current.autoApproveMaxCostUsd;
    if (patch.autoApproveMaxCostUsd !== undefined) {
      const parsedCost = Number(patch.autoApproveMaxCostUsd);
      if (!Number.isFinite(parsedCost) || parsedCost < 0) {
        throw new ApiError(400, "bad_policy", "autoApproveMaxCostUsd 必须是非负有效数字");
      }
      maxCost = Math.min(500, parsedCost);
    }
    let nextRedlines = current.redlineKinds;
    if (patch.redlineKinds !== undefined) {
      if (!Array.isArray(patch.redlineKinds) || !patch.redlineKinds.every((k) => typeof k === "string" && k.trim())) {
        throw new ApiError(400, "bad_policy", "redlineKinds 必须是非空字符串数组");
      }
      nextRedlines = patch.redlineKinds.map((k) => k.trim());
    }
    let nextBotMode = current.botArbitrationMode;
    if (patch.botArbitrationMode !== undefined) {
      if (!isBotArbitrationMode(patch.botArbitrationMode)) {
        throw new ApiError(400, "bad_policy", `无效 Bot 代理拍板档位: ${String(patch.botArbitrationMode)}`);
      }
      nextBotMode = patch.botArbitrationMode;
    }
    const nextAutoApproveVerifiedReleases =
      patch.autoApproveVerifiedReleases !== undefined
        ? Boolean(patch.autoApproveVerifiedReleases)
        : current.autoApproveVerifiedReleases;

    const next: GovernancePolicy = {
      autonomyMode,
      autoApproveLowRisk,
      autoApproveMaxCostUsd: maxCost,
      autoPromoteSignals,
      autoHarvestQuota,
      autoHealOps,
      redlineKinds: nextRedlines,
      botArbitrationMode: nextBotMode,
      autoApproveVerifiedReleases: nextAutoApproveVerifiedReleases,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE opc_governance_policy
         SET autonomy_mode = ?,
             auto_approve_low_risk = ?,
             auto_approve_max_cost_usd = ?,
             auto_promote_signals = ?,
             auto_harvest_quota = ?,
             auto_heal_ops = ?,
             redline_kinds_json = ?,
             bot_arbitration_mode = ?,
             auto_approve_verified_releases = ?,
             updated_at = ?
         WHERE singleton = 1`,
      )
      .run(
        next.autonomyMode,
        next.autoApproveLowRisk ? 1 : 0,
        next.autoApproveMaxCostUsd,
        next.autoPromoteSignals ? 1 : 0,
        next.autoHarvestQuota ? 1 : 0,
        next.autoHealOps ? 1 : 0,
        JSON.stringify(next.redlineKinds),
        next.botArbitrationMode,
        next.autoApproveVerifiedReleases ? 1 : 0,
        next.updatedAt,
      );
    this.events.emit({
      topic: "strategy.policy_updated",
      sourceDomain: "strategy",
      payload: {
        autonomyMode: next.autonomyMode,
        autoApproveLowRisk: next.autoApproveLowRisk,
        autoApproveMaxCostUsd: next.autoApproveMaxCostUsd,
        autoPromoteSignals: next.autoPromoteSignals,
        autoHarvestQuota: next.autoHarvestQuota,
        autoHealOps: next.autoHealOps,
        botArbitrationMode: next.botArbitrationMode,
        autoApproveVerifiedReleases: next.autoApproveVerifiedReleases,
      },
    });
    return next;
  }

  async propose(input: DecisionProposeInput): Promise<DecisionPacket> {
    if (!input.title.trim()) throw new ApiError(400, "bad_decision", "审批标题不能为空");
    if (!input.options.length) throw new ApiError(400, "bad_decision", "至少需要提供一个可执行决策选项");

    const resolved = input.projectOrAssetRef
      ? this.registry.resolveCanonicalRef(input.projectOrAssetRef)
      : { mainline: null, product: null, asset: null };
    const mainlineId = input.mainlineId ?? resolved.mainline?.id ?? null;
    const productId = input.productId ?? resolved.product?.id ?? null;
    const assetId = input.assetId ?? resolved.asset?.id ?? null;
    const dedupeKey = (input.dedupeKey ?? "").trim() || `${input.domain}:${input.kind}:${randomUUID()}`;
    const now = new Date().toISOString();

    // Respect 24-hour snooze cooldown so snoozed alerts do not re-fire on the next 5m watchdog tick
    if (!input.bypassAutoApprove) {
      const snoozeCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentSnoozed = this.db
        .prepare(
          `SELECT * FROM opc_decision_packets
           WHERE dedupe_key = ? AND status = 'snoozed' AND decided_at > ?
           ORDER BY decided_at DESC LIMIT 1`,
        )
        .get(dedupeKey, snoozeCutoff) as Record<string, unknown> | undefined;
      if (recentSnoozed) {
        return this.mapPacket(recentSnoozed);
      }
    }

    const existingRow = this.db
      .prepare("SELECT * FROM opc_decision_packets WHERE dedupe_key = ? AND status = 'pending' LIMIT 1")
      .get(dedupeKey) as Record<string, unknown> | undefined;

    let id: string;
    if (existingRow) {
      id = String(existingRow.id);
      // updatedAt identifies the exact revision shown on the founder's screen, including same-millisecond proposals.
      const previousMs = Date.parse(String(existingRow.updated_at));
      const revision = previousMs >= Date.parse(now) ? new Date(previousMs + 1).toISOString() : now;
      this.db
        .prepare(
          `UPDATE opc_decision_packets
           SET risk_level = ?, mainline_id = ?, product_id = ?, asset_id = ?,
               title = ?, background_summary = ?, why_recommended = ?, cost_estimate_usd = ?,
               diff_or_evidence = ?, rollback_plan = ?, options_json = ?, recommended_option_id = ?,
               tags_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.riskLevel,
          mainlineId,
          productId,
          assetId,
          input.title.trim(),
          input.backgroundSummary.trim(),
          (input.whyRecommended ?? "").trim(),
          input.costEstimateUsd ?? null,
          input.diffOrEvidence ?? "",
          input.rollbackPlan ?? "",
          JSON.stringify(input.options),
          input.recommendedOptionId ?? input.options[0]?.id ?? null,
          JSON.stringify(input.tags ?? []),
          revision,
          id,
        );
    } else {
      id = `dec_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      this.db
        .prepare(
          `INSERT INTO opc_decision_packets
           (id, dedupe_key, domain, kind, risk_level, mainline_id, product_id, asset_id, title,
            background_summary, why_recommended, cost_estimate_usd, diff_or_evidence, rollback_plan,
            options_json, recommended_option_id, tags_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          id,
          dedupeKey,
          input.domain,
          input.kind,
          input.riskLevel,
          mainlineId,
          productId,
          assetId,
          input.title.trim(),
          input.backgroundSummary.trim(),
          (input.whyRecommended ?? "").trim(),
          input.costEstimateUsd ?? null,
          input.diffOrEvidence ?? "",
          input.rollbackPlan ?? "",
          JSON.stringify(input.options),
          input.recommendedOptionId ?? input.options[0]?.id ?? null,
          JSON.stringify(input.tags ?? []),
          now,
          now,
        );
    }

    const packet = this.get(id)!;

    // Policy check: low-risk non-redline decisions within cost budget can auto-approve deterministically
    const policy = this.getPolicy();
    const isRedline = policy.redlineKinds.includes(packet.kind);
    const withinBudget = (packet.costEstimateUsd ?? 0) <= policy.autoApproveMaxCostUsd;
    const recOption = packet.options.find((o) => o.id === packet.recommendedOptionId) ?? packet.options[0];

    if (
      !input.bypassAutoApprove &&
      policy.autoApproveLowRisk &&
      packet.riskLevel === "low" &&
      !isRedline &&
      withinBudget &&
      recOption &&
      recOption.outcome === "approved" &&
      this.handlers.has(recOption.handlerKey)
    ) {
      return this.executeResolution(packet, recOption, "策略引擎低风险免打扰自动放行", "policy-engine", true);
    }

    this.events.emit({
      topic: "decision.proposed",
      sourceDomain: packet.domain,
      mainlineId: packet.mainlineId,
      productId: packet.productId,
      assetId: packet.assetId,
      payload: {
        decisionId: packet.id,
        kind: packet.kind,
        riskLevel: packet.riskLevel,
        title: packet.title,
      },
    });

    return packet;
  }

  /**
   * Viewing a packet ONLY sets viewed_at; it NEVER drops the packet from 'pending'!
   */
  markViewed(id: string): DecisionPacket {
    const packet = this.get(id);
    if (!packet) throw new ApiError(404, "decision_not_found", "未找到该审批单");
    if (!packet.viewedAt) {
      this.db
        .prepare("UPDATE opc_decision_packets SET viewed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    }
    return this.get(id)!;
  }

  private readBotReleasePolicy(): { arbitrationMode: BotArbitrationMode; autoApproveVerifiedReleases: boolean } {
    const hasTable = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_bot_arbitrator_policy'")
        .get(),
    );
    if (hasTable) {
      const row = this.db
        .prepare("SELECT arbitration_mode, auto_approve_verified_releases FROM opc_bot_arbitrator_policy WHERE singleton = 1")
        .get() as { arbitration_mode?: string; auto_approve_verified_releases?: number } | undefined;
      if (row) {
        return {
          arbitrationMode: isBotArbitrationMode(row.arbitration_mode) ? row.arbitration_mode : "off",
          autoApproveVerifiedReleases: Boolean(row.auto_approve_verified_releases),
        };
      }
    }
    const policy = this.getPolicy();
    return {
      arbitrationMode: policy.botArbitrationMode,
      autoApproveVerifiedReleases: policy.autoApproveVerifiedReleases,
    };
  }

  private assertBotDelegationSafe(
    packet: DecisionPacket,
    option: DecisionOption,
    botContext?: DecisionBotContext,
  ): void {
    if (NON_DELEGABLE_DECISION_KINDS.has(packet.kind)) {
      throw new ApiError(
        403,
        "bot_delegation_forbidden",
        `审批类型「${packet.kind}」属于不可委托硬红线，禁止由 Bot 代理拍板。`,
      );
    }
    if (
      packet.kind === "kill_switch" &&
      (option.id === "exempt" ||
        option.handlerKey === "commercial.kill_switch_exempt" ||
        option.outcome === "rejected")
    ) {
      throw new ApiError(
        403,
        "bot_delegation_forbidden",
        "商业止损熔断豁免（kill_switch exempt）属于不可委托硬红线，禁止由 Bot 代理放行。",
      );
    }

    if (packet.kind === "production_release" && option.outcome === "approved") {
      const botPolicy = this.readBotReleasePolicy();
      const effectiveMode = botPolicy.arbitrationMode;
      if (effectiveMode !== "delegated_safe" && effectiveMode !== "full_delegated") {
        throw new ApiError(
          403,
          "bot_release_policy_disabled",
          `当前 Bot 拍板模式为「${effectiveMode}」，不允许代理批准代码发布。`,
        );
      }
      if (!botPolicy.autoApproveVerifiedReleases) {
        throw new ApiError(
          403,
          "bot_release_policy_disabled",
          "未开启 autoApproveVerifiedReleases，禁止 Bot 代理批准代码发布。",
        );
      }

      const releaseId =
        String(option.payload?.releaseId ?? "").trim() ||
        (/^factory:production_release:(.+)$/.exec(packet.dedupeKey)?.[1]?.trim() ?? "");

      const hasReleasesTable = Boolean(
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_releases'").get(),
      );
      const hasRunsTable = Boolean(
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_agent_runs'").get(),
      );

      let checkedFromDb = false;
      if (hasReleasesTable && releaseId) {
        const rel = this.db
          .prepare("SELECT id, run_id, status FROM opc_releases WHERE id = ?")
          .get(releaseId) as { id?: string; run_id?: string | null; status?: string } | undefined;
        if (rel) {
          if (!rel.run_id || !hasRunsTable) {
            throw new ApiError(
              403,
              "bot_release_gate_failed",
              `发布单 ${releaseId} 缺少可核验的暗工厂运行记录，禁止 Bot 代理批准。`,
            );
          }
          const run = this.db
            .prepare(
              "SELECT status, protected_violations, circuit_breaker_reason, verification_json FROM opc_agent_runs WHERE id = ?",
            )
            .get(String(rel.run_id)) as
            | {
                status?: string;
                protected_violations?: string | null;
                circuit_breaker_reason?: string | null;
                verification_json?: string | null;
              }
            | undefined;
          if (!run) {
            throw new ApiError(
              403,
              "bot_release_gate_failed",
              `发布单 ${releaseId} 关联的运行 ${rel.run_id} 不存在，禁止 Bot 代理批准。`,
            );
          }
          const runStatus = String(run.status ?? "");
          if (runStatus !== "completed" && runStatus !== "pr_open") {
            throw new ApiError(
              403,
              "bot_release_gate_failed",
              `关联运行状态为 ${runStatus}（需为 completed/pr_open），禁止 Bot 代理批准发布。`,
            );
          }
          const violations = safeJson<string[]>(run.protected_violations, []);
          if (violations.length > 0 || run.circuit_breaker_reason === "protected_path_violation") {
            throw new ApiError(
              403,
              "bot_release_gate_failed",
              `关联运行存在人类保护路径违规（${violations.join(", ") || "protected_path_violation"}），严禁 Bot 代理批准发布。`,
            );
          }
          const verification = safeJson<{ passed?: boolean } | null>(run.verification_json, null);
          if (verification?.passed !== true) {
            throw new ApiError(
              403,
              "bot_release_gate_failed",
              "关联运行未通过外部确定性校验（verification.passed !== true），严禁 Bot 代理批准发布。",
            );
          }
          checkedFromDb = true;
        }
      }

      if (!checkedFromDb) {
        const statusOk = botContext?.runStatus === "completed" || botContext?.runStatus === "pr_open";
        const violationsOk = botContext?.protectedViolationsCount === 0;
        const verifiedOk = botContext?.releaseVerificationPassed === true;
        if (!statusOk || !violationsOk || !verifiedOk) {
          throw new ApiError(
            403,
            "bot_release_gate_failed",
            "缺少确定性校验通过证明（需 verification.passed=true、protectedViolations=0 且状态为 completed/pr_open），禁止 Bot 代理批准发布。",
          );
        }
      }
    }
  }

  async resolve(id: string, input: DecisionResolveInput): Promise<DecisionPacket> {
    const packet = this.get(id);
    if (!packet) throw new ApiError(404, "decision_not_found", "未找到该审批单");
    if (packet.status !== "pending") {
      throw new ApiError(409, "decision_already_resolved", `该审批单已处理（状态：${packet.status}）`);
    }
    if (input.expectedUpdatedAt !== undefined && packet.updatedAt !== input.expectedUpdatedAt) {
      throw new ApiError(409, "decision_updated", updatedDecisionReason);
    }
    const option = packet.options.find((o) => o.id === input.optionId);
    if (!option) {
      throw new ApiError(400, "invalid_decision_option", "所选审批项不存在");
    }
    const actor = (input.actor ?? "founder").trim() || "founder";
    const isBotDelegated = Boolean(input.botDelegated) || actor.startsWith("bot:");
    if (isBotDelegated) {
      this.assertBotDelegationSafe(packet, option, input.botContext);
    }
    const autoApproved =
      input.autoApproved !== undefined ? Boolean(input.autoApproved) : isBotDelegated;
    return this.executeResolution(
      packet,
      option,
      (input.note ?? "").trim(),
      actor,
      autoApproved,
    );
  }

  supersede(
    id: string,
    input: { note?: string; actor?: string; expectedUpdatedAt?: string; autoApproved?: boolean } = {},
  ): DecisionPacket {
    const packet = this.get(id);
    if (!packet) throw new ApiError(404, "decision_not_found", "未找到该审批单");
    if (packet.status !== "pending") {
      throw new ApiError(409, "decision_already_resolved", `该审批单已处理（状态：${packet.status}）`);
    }
    if (input.expectedUpdatedAt !== undefined && packet.updatedAt !== input.expectedUpdatedAt) {
      throw new ApiError(409, "decision_updated", updatedDecisionReason);
    }
    const actor = (input.actor ?? "bot:arbitrator").trim() || "bot:arbitrator";
    const note = (input.note ?? "已被后续版本或已合入记录覆盖，自动收敛。").trim();
    const autoApproved = input.autoApproved !== undefined ? Boolean(input.autoApproved) : actor.startsWith("bot:");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE opc_decision_packets
         SET status = 'superseded', chosen_option_id = NULL, decision_note = ?, decided_by = ?,
             auto_approved = ?, handler_result_json = ?, viewed_at = COALESCE(viewed_at, ?),
             updated_at = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(
        note,
        actor,
        autoApproved ? 1 : 0,
        JSON.stringify({ executed: false, superseded: true }),
        now,
        now,
        now,
        packet.id,
      );
    const updated = this.get(packet.id)!;
    this.events.emit({
      topic: "decision.resolved",
      sourceDomain: updated.domain,
      mainlineId: updated.mainlineId,
      productId: updated.productId,
      assetId: updated.assetId,
      payload: {
        decisionId: updated.id,
        domain: updated.domain,
        kind: updated.kind,
        riskLevel: updated.riskLevel,
        title: updated.title,
        outcome: updated.status,
        chosenOptionId: null,
        chosenOptionLabel: "已覆盖收敛",
        note,
        actor,
        autoApproved,
        tags: updated.tags,
        costEstimateUsd: updated.costEstimateUsd,
      },
    });
    return updated;
  }

  private pickOptionForBatchAction(
    packet: DecisionPacket,
    action: DecisionBatchAction,
  ): DecisionOption | null {
    const rec =
      packet.options.find((o) => o.id === packet.recommendedOptionId) ?? packet.options[0] ?? null;
    if (action === "recommended") return rec;
    if (action === "approve") {
      if (rec && rec.outcome === "approved") return rec;
      return packet.options.find((o) => o.outcome === "approved") ?? null;
    }
    if (action === "reject") {
      if (rec && rec.outcome === "rejected") return rec;
      return packet.options.find((o) => o.outcome === "rejected") ?? null;
    }
    if (action === "snooze") {
      if (rec && rec.outcome === "snoozed") return rec;
      return packet.options.find((o) => o.outcome === "snoozed") ?? null;
    }
    return null;
  }

  async batchResolve(input: BatchResolveDecisionInput): Promise<BatchResolveDecisionResult> {
    const validActions: DecisionBatchAction[] = ["recommended", "approve", "reject", "snooze"];
    if (!validActions.includes(input.action)) {
      throw new ApiError(400, "invalid_batch_action", `不支持的批量审批动作: ${String(input.action)}`);
    }
    const uniqueIds = [...new Set((input.ids ?? []).map((s) => String(s ?? "").trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      throw new ApiError(400, "empty_batch_ids", "请至少勾选一项待审批事项");
    }
    if (uniqueIds.length > 100) {
      throw new ApiError(400, "batch_limit_exceeded", "单次批量审批最多支持 100 项");
    }
    const revisions = input.expectedUpdatedAtById;
    if (revisions !== undefined && (!revisions || typeof revisions !== "object" || Array.isArray(revisions)
      || Object.values(revisions).some(value => typeof value !== "string"))) {
      throw new ApiError(400, "invalid_batch_revisions", "所选审批单的版本信息无效，请刷新后重新选择。");
    }

    const policy = this.getPolicy();
    const redlineSet = new Set(policy.redlineKinds);
    const note = (input.note ?? "").trim();
    const actor = (input.actor ?? "founder").trim() || "founder";

    // Pre-flight redline safety check before executing any mutations
    if (!input.allowRedline && (input.action === "approve" || input.action === "recommended")) {
      const blockedRedlines: string[] = [];
      for (const id of uniqueIds) {
        const packet = this.get(id);
        if (!packet || packet.status !== "pending") continue;
        if (packet.actionBlockReason || (revisions && revisions[id] !== packet.updatedAt)) continue;
        const chosen = this.pickOptionForBatchAction(packet, input.action);
        const isHighRisk =
          redlineSet.has(packet.kind) || packet.riskLevel === "high" || packet.riskLevel === "critical";
        if (chosen && chosen.outcome === "approved" && isHighRisk) {
          blockedRedlines.push(`${packet.id}（${packet.title}）`);
        }
      }
      if (blockedRedlines.length > 0) {
        throw new ApiError(
          409,
          "redline_confirmation_required",
          `所选事项包含 ${blockedRedlines.length} 项高风险/红线批准项，需显式二次确认（allowRedline=true）后方可执行：${blockedRedlines.slice(0, 3).join("、")}`,
        );
      }
    }

    const results: BatchResolveItemOutcome[] = [];
    for (const id of uniqueIds) {
      const packet = this.get(id);
      if (!packet) {
        results.push({ id, title: id, status: "skipped", reason: "未找到该审批单" });
        continue;
      }
      if (packet.status !== "pending") {
        results.push({
          id: packet.id,
          title: packet.title,
          status: "skipped",
          outcome: packet.status,
          reason: `已处理（当前状态：${packet.status}）`,
        });
        continue;
      }
      if (revisions && revisions[id] !== packet.updatedAt) {
        results.push({ id, title: packet.title, status: "skipped", reason: updatedDecisionReason });
        continue;
      }
      const option = this.pickOptionForBatchAction(packet, input.action);
      if (!option) {
        results.push({
          id: packet.id,
          title: packet.title,
          status: "skipped",
          reason: `该审批单无对应的「${input.action}」选项，请单独查看处理`,
        });
        continue;
      }
      try {
        const resolved = await this.executeResolution(packet, option, note, actor, false);
        results.push({
          id: resolved.id,
          title: resolved.title,
          status: "resolved",
          outcome: resolved.status,
          chosenOptionId: option.id,
          chosenOptionLabel: option.label,
        });
      } catch (err) {
        results.push({
          id: packet.id,
          title: packet.title,
          status: "failed",
          reason: err instanceof Error ? err.message : "批量执行动作失败",
        });
      }
    }

    return {
      action: input.action,
      requested: uniqueIds.length,
      resolvedCount: results.filter((r) => r.status === "resolved").length,
      skippedCount: results.filter((r) => r.status === "skipped").length,
      failedCount: results.filter((r) => r.status === "failed").length,
      results,
      counts: this.counts(),
    };
  }

  private async executeResolution(
    packet: DecisionPacket,
    option: DecisionOption,
    note: string,
    actor: string,
    autoApproved: boolean,
  ): Promise<DecisionPacket> {
    const reason = this.actionBlockReason(packet);
    if (reason) throw new ApiError(409, "decision_action_blocked", reason);
    const handler = this.handlers.get(option.handlerKey);
    let handlerResult: Record<string, unknown> = { executed: false, handlerKey: option.handlerKey };
    if (handler) {
      const out = await handler({ packet, option, note, actor });
      handlerResult = {
        executed: true,
        handlerKey: option.handlerKey,
        ...(out && typeof out === "object" ? out : {}),
      };
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE opc_decision_packets
         SET status = ?, chosen_option_id = ?, decision_note = ?, decided_by = ?,
             auto_approved = ?, handler_result_json = ?, viewed_at = COALESCE(viewed_at, ?),
             updated_at = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(
        option.outcome,
        option.id,
        note,
        actor,
        autoApproved ? 1 : 0,
        JSON.stringify(handlerResult),
        now,
        now,
        now,
        packet.id,
      );

    const updated = this.get(packet.id)!;
    this.events.emit({
      topic: "decision.resolved",
      sourceDomain: updated.domain,
      mainlineId: updated.mainlineId,
      productId: updated.productId,
      assetId: updated.assetId,
      payload: {
        decisionId: updated.id,
        domain: updated.domain,
        kind: updated.kind,
        riskLevel: updated.riskLevel,
        title: updated.title,
        outcome: updated.status,
        chosenOptionId: option.id,
        chosenOptionLabel: option.label,
        note,
        actor,
        autoApproved,
        tags: updated.tags,
        costEstimateUsd: updated.costEstimateUsd,
      },
    });
    return updated;
  }

  get(id: string): DecisionPacket | null {
    const row = this.db
      .prepare("SELECT * FROM opc_decision_packets WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPacket(row) : null;
  }

  list(filter: {
    status?: DecisionStatus | "all" | "handled";
    domain?: CompanyDepartmentId;
    limit?: number;
  } = {}): DecisionPacket[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter.status && filter.status !== "all") {
      if (filter.status === "handled") {
        clauses.push("status != 'pending'");
      } else {
        clauses.push("status = ?");
        args.push(filter.status);
      }
    }
    if (filter.domain) {
      clauses.push("domain = ?");
      args.push(filter.domain);
    }
    const limit = Math.max(1, Math.min(200, filter.limit ?? 100));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM opc_decision_packets
         ${where}
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC, updated_at DESC
         LIMIT ?`,
      )
      .all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPacket(r));
  }

  counts(): { pending: number; autoApproved: number; total: number } {
    const pendingRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM opc_decision_packets WHERE status = 'pending'")
      .get() as { n?: number } | undefined;
    const autoRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM opc_decision_packets WHERE auto_approved = 1")
      .get() as { n?: number } | undefined;
    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM opc_decision_packets")
      .get() as { n?: number } | undefined;
    return {
      pending: Number(pendingRow?.n ?? 0),
      autoApproved: Number(autoRow?.n ?? 0),
      total: Number(totalRow?.n ?? 0),
    };
  }

  private mapPacket(row: Record<string, unknown>): DecisionPacket {
    const mainlineId = row.mainline_id ? String(row.mainline_id) : null;
    const productId = row.product_id ? String(row.product_id) : null;
    const assetId = row.asset_id ? String(row.asset_id) : null;
    const kind = String(row.kind);
    const title = String(row.title);
    const backgroundSummary = String(row.background_summary);
    const policy = this.getPolicy();

    const asset = assetId ? this.registry.getAsset(assetId) : null;
    const product = productId
      ? this.registry.getProduct(productId)
      : asset
        ? this.registry.getProduct(asset.productId)
        : null;
    const mainline = mainlineId
      ? this.registry.getMainline(mainlineId)
      : product
        ? this.registry.getMainline(product.mainlineId)
        : asset
          ? this.registry.getMainline(asset.mainlineId)
          : null;

    let admissionWarning: string | null = null;
    if (kind === "feature_admission") {
      const noiseCheck = isDigestOrNonActionableNoise(title, backgroundSummary);
      if (noiseCheck.noisy) {
        admissionWarning = `准入预警：${noiseCheck.reason ?? "疑似资讯摘要或非具体研发任务"}`;
      } else if (!asset && !product) {
        admissionWarning = "准入预警：未绑定具体产品或代码仓库，无法明确改动落点";
      } else if (asset?.paused) {
        admissionWarning = `准入预警：归属仓库「${asset.name}」当前处于暂停状态`;
      }
    }

    const options = safeJson<DecisionOption[]>(String(row.options_json ?? "[]"), []);
    const storedRecommendedId = row.recommended_option_id ? String(row.recommended_option_id) : null;
    const rejectOption = options.find((o) => o.outcome === "rejected");
    const effectiveRecommendedId =
      admissionWarning && String(row.status) === "pending" && rejectOption
        ? rejectOption.id
        : storedRecommendedId;

    const packet: DecisionPacket = {
      id: String(row.id),
      dedupeKey: String(row.dedupe_key),
      domain: String(row.domain) as CompanyDepartmentId,
      kind,
      riskLevel: String(row.risk_level) as DecisionRiskLevel,
      mainlineId,
      productId,
      assetId,
      title,
      backgroundSummary,
      whyRecommended: String(row.why_recommended ?? ""),
      costEstimateUsd:
        row.cost_estimate_usd !== null && row.cost_estimate_usd !== undefined
          ? Number(row.cost_estimate_usd)
          : null,
      diffOrEvidence: String(row.diff_or_evidence ?? ""),
      rollbackPlan: String(row.rollback_plan ?? ""),
      options,
      recommendedOptionId: effectiveRecommendedId,
      tags: safeJson<string[]>(String(row.tags_json ?? "[]"), []),
      status: String(row.status) as DecisionStatus,
      viewedAt: row.viewed_at ? String(row.viewed_at) : null,
      chosenOptionId: row.chosen_option_id ? String(row.chosen_option_id) : null,
      decisionNote: String(row.decision_note ?? ""),
      decidedBy: row.decided_by ? String(row.decided_by) : null,
      autoApproved: Boolean(row.auto_approved),
      handlerResult: safeJson<Record<string, unknown> | null>(
        row.handler_result_json ? String(row.handler_result_json) : null,
        null,
      ),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      decidedAt: row.decided_at ? String(row.decided_at) : null,
      targetSummary: {
        mainlineName: mainline?.name ?? null,
        productName: product?.name ?? null,
        assetName: asset?.name ?? null,
        repoFullName: asset?.repoFullName || null,
        verifyCommand: asset?.verifyCommand || null,
        isRedline: policy.redlineKinds.includes(kind),
      },
      admissionWarning,
    };
    if (packet.status === "pending") {
      const reason = this.actionBlockReason(packet);
      if (reason) packet.actionBlockReason = reason;
    }
    return packet;
  }
}
