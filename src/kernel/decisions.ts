import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "../server/logic.ts";
import type { DomainEventBus } from "./events.ts";
import type { AssetRegistry } from "./registry.ts";
import type {
  AutonomyMode,
  CompanyDepartmentId,
  DecisionActionHandler,
  DecisionOption,
  DecisionPacket,
  DecisionProposeInput,
  DecisionRiskLevel,
  DecisionStatus,
  GovernancePolicy,
} from "./types.ts";

const DEFAULT_REDLINE_KINDS = [
  "production_release",
  "mainline_change",
  "kill_switch",
  "pricing_change",
  "security_override",
  "freeze_override",
];

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

    const existingPolicy = this.db
      .prepare("SELECT 1 FROM opc_governance_policy WHERE singleton = 1")
      .get();
    if (!existingPolicy) {
      this.db
        .prepare(
          `INSERT INTO opc_governance_policy
           (singleton, autonomy_mode, auto_approve_low_risk, auto_approve_max_cost_usd,
            auto_promote_signals, auto_harvest_quota, auto_heal_ops, redline_kinds_json, updated_at)
           VALUES (1, 'full_auto', 1, 2.0, 1, 1, 1, ?, ?)`,
        )
        .run(JSON.stringify(DEFAULT_REDLINE_KINDS), new Date().toISOString());
    }
  }

  registerHandler(handlerKey: string, handler: DecisionActionHandler) {
    this.handlers.set(handlerKey, handler);
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
    return {
      autonomyMode,
      autoApproveLowRisk,
      autoApproveMaxCostUsd: Number(row.auto_approve_max_cost_usd ?? 2.0),
      autoPromoteSignals,
      autoHarvestQuota,
      autoHealOps,
      redlineKinds: safeJson<string[]>(String(row.redline_kinds_json ?? "[]"), DEFAULT_REDLINE_KINDS),
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

    const next: GovernancePolicy = {
      autonomyMode,
      autoApproveLowRisk,
      autoApproveMaxCostUsd: maxCost,
      autoPromoteSignals,
      autoHarvestQuota,
      autoHealOps,
      redlineKinds: nextRedlines,
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
          now,
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

  async resolve(
    id: string,
    input: { optionId: string; note?: string; actor?: string },
  ): Promise<DecisionPacket> {
    const packet = this.get(id);
    if (!packet) throw new ApiError(404, "decision_not_found", "未找到该审批单");
    if (packet.status !== "pending") {
      throw new ApiError(409, "decision_already_resolved", `该审批单已处理（状态：${packet.status}）`);
    }
    const option = packet.options.find((o) => o.id === input.optionId);
    if (!option) {
      throw new ApiError(400, "invalid_decision_option", "所选审批项不存在");
    }
    return this.executeResolution(
      packet,
      option,
      (input.note ?? "").trim(),
      (input.actor ?? "founder").trim() || "founder",
      false,
    );
  }

  private async executeResolution(
    packet: DecisionPacket,
    option: DecisionOption,
    note: string,
    actor: string,
    autoApproved: boolean,
  ): Promise<DecisionPacket> {
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
    return {
      id: String(row.id),
      dedupeKey: String(row.dedupe_key),
      domain: String(row.domain) as CompanyDepartmentId,
      kind: String(row.kind),
      riskLevel: String(row.risk_level) as DecisionRiskLevel,
      mainlineId: row.mainline_id ? String(row.mainline_id) : null,
      productId: row.product_id ? String(row.product_id) : null,
      assetId: row.asset_id ? String(row.asset_id) : null,
      title: String(row.title),
      backgroundSummary: String(row.background_summary),
      whyRecommended: String(row.why_recommended ?? ""),
      costEstimateUsd:
        row.cost_estimate_usd !== null && row.cost_estimate_usd !== undefined
          ? Number(row.cost_estimate_usd)
          : null,
      diffOrEvidence: String(row.diff_or_evidence ?? ""),
      rollbackPlan: String(row.rollback_plan ?? ""),
      options: safeJson<DecisionOption[]>(String(row.options_json ?? "[]"), []),
      recommendedOptionId: row.recommended_option_id ? String(row.recommended_option_id) : null,
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
    };
  }
}
