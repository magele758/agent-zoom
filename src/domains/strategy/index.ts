import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { OpcKernel } from "../../kernel/index.ts";
import type {
  CanonicalResolution,
  DecisionOutcome,
  DepartmentHealth,
  DepartmentModule,
  DomainEventRecord,
  GovernancePolicy,
  MainlineRecord,
  PortfolioTree,
} from "../../kernel/types.ts";
import { ApiError } from "../../server/logic.ts";

export const PREFERENCE_RULE_KINDS = [
  "prefer_tag",
  "avoid_keyword",
  "prefer_mainline",
  "budget_cap",
  "scope_rule",
] as const;

export type PreferenceRuleKind = (typeof PREFERENCE_RULE_KINDS)[number];

export interface PreferenceRule {
  id: string;
  kind: PreferenceRuleKind;
  pattern: string;
  weight: number;
  mainlineId: string | null;
  autoAction: string | null;
  note: string;
  enabled: boolean;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PreferenceEvent {
  id: string;
  source: string;
  decisionId: string | null;
  mainlineId: string | null;
  assetId: string | null;
  outcome: string;
  title: string;
  tags: string[];
  note: string;
  learnedDelta: Record<string, unknown>;
  createdAt: string;
}

export interface FreezeOverrideRecord {
  id: string;
  targetRef: string;
  decisionId: string | null;
  reason: string;
  oneOff: boolean;
  consumed: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface UpsertPreferenceRuleInput {
  id?: string;
  kind: PreferenceRuleKind;
  pattern: string;
  weight: number;
  mainlineId?: string | null;
  autoAction?: string | null;
  note?: string;
  enabled?: boolean;
}

export interface UpdatePreferenceRuleInput {
  kind?: PreferenceRuleKind;
  pattern?: string;
  weight?: number;
  mainlineId?: string | null;
  autoAction?: string | null;
  note?: string;
  enabled?: boolean;
}

export type CandidateRecommendation =
  | "auto_promote"
  | "needs_review"
  | "drop_noise"
  | "blocked";

export interface MatchedPreferenceRule {
  id: string;
  kind: PreferenceRuleKind;
  pattern: string;
  weight: number;
  matchedTerm: string;
  autoAction: string | null;
}

export interface CandidateEvaluationInput {
  title: string;
  description?: string;
  projectOrAssetRef?: string;
  tags?: string[];
  estimatedCostUsd?: number;
  isEmergencyBug?: boolean;
  recordHits?: boolean;
}

export interface CandidateEvaluationResult {
  allowed: boolean;
  blockReason?: string;
  blockCode?: string;
  totalScore: number;
  mainlineScore: number;
  habitScore: number;
  clarityScore: number;
  resolution: CanonicalResolution;
  matchedRules: MatchedPreferenceRule[];
  recommendation: CandidateRecommendation;
  summary: string;
}

export interface StrategyOverviewSnapshot {
  mainlines: MainlineRecord[];
  portfolio: PortfolioTree;
  rules: PreferenceRule[];
  recentEvents: PreferenceEvent[];
  policy: GovernancePolicy;
  freezeOverrides: FreezeOverrideRecord[];
}

export interface StrategyDepartmentOptions {
  kernel: OpcKernel;
}

const ENGLISH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "please",
  "avoid",
  "reject",
  "rejected",
  "approve",
  "approved",
  "dont",
  "doesnt",
  "cannot",
  "should",
  "would",
  "could",
  "because",
  "about",
  "need",
  "needs",
  "task",
  "feature",
  "item",
  "issue",
  "only",
  "just",
  "very",
  "more",
  "less",
]);

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function extractRejectionKeywords(note: string, packetTags: string[]): string[] {
  const trimmed = note.trim();
  if (!trimmed) return [];

  const found: string[] = [];
  const pushUnique = (raw: string) => {
    const cleaned = raw.trim().replace(/^[#"'`「【\s]+|[#"'`」】\s.,;!?，。；！？]+$/g, "");
    if (!cleaned || cleaned.length < 2 || cleaned.length > 40) return;
    if (!found.some((x) => x.toLowerCase() === cleaned.toLowerCase())) {
      found.push(cleaned);
    }
  };

  // 1. Any packet tag explicitly mentioned in the note
  const noteLower = trimmed.toLowerCase();
  for (const tag of packetTags) {
    if (tag.trim() && noteLower.includes(tag.trim().toLowerCase())) {
      pushUnique(tag);
    }
  }

  // 2. Quoted / backticked / bracketed / hashtag terms
  const quotedRegex = /(?:"([^"]{2,40})"|'([^']{2,40})'|`([^`]{2,40})`|「([^」]{2,40})」|【([^】]{2,40})】|#([a-zA-Z0-9_\u4e00-\u9fa5-]{2,40}))/g;
  let qMatch: RegExpExecArray | null;
  while ((qMatch = quotedRegex.exec(trimmed)) !== null) {
    const captured = qMatch[1] || qMatch[2] || qMatch[3] || qMatch[4] || qMatch[5] || qMatch[6];
    if (captured) pushUnique(captured);
  }

  // 3. Chinese directive phrases after negation prefixes (e.g. 不要搞外围基建 -> 外围基建)
  const zhDirectiveRegex = /(?:不要做?|禁止|避免|拒绝|不做|别搞|别做|暂停|砍掉)\s*([a-zA-Z0-9_\u4e00-\u9fa5-]{2,16})/g;
  let zhMatch: RegExpExecArray | null;
  while ((zhMatch = zhDirectiveRegex.exec(trimmed)) !== null) {
    if (zhMatch[1]) pushUnique(zhMatch[1]);
  }

  // 4. Salient English/kebab identifiers
  const enRegex = /[a-zA-Z][a-zA-Z0-9_-]{2,30}/g;
  let enMatch: RegExpExecArray | null;
  while ((enMatch = enRegex.exec(trimmed)) !== null) {
    const word = enMatch[0].toLowerCase();
    if (!ENGLISH_STOPWORDS.has(word)) {
      pushUnique(word);
    }
  }

  // 5. Fallback: if note is a concise Chinese phrase itself, use cleaned phrase
  if (found.length === 0) {
    const compact = trimmed
      .replace(/^(?:理由[:：]?|原因[:：]?|备注[:：]?)/, "")
      .split(/[，。；,;\n]/)[0]
      ?.trim();
    if (compact && compact.length >= 2 && compact.length <= 20) {
      pushUnique(compact);
    }
  }

  return found.slice(0, 4);
}

function extractApprovalKeywords(title: string, note: string): string[] {
  const combined = `${note}\n${title}`;
  const found: string[] = [];
  const pushUnique = (raw: string) => {
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned || cleaned.length < 3 || cleaned.length > 32) return;
    if (!ENGLISH_STOPWORDS.has(cleaned) && !found.includes(cleaned)) {
      found.push(cleaned);
    }
  };

  const enRegex = /[a-zA-Z][a-zA-Z0-9_-]{2,28}/g;
  let m: RegExpExecArray | null;
  while ((m = enRegex.exec(combined)) !== null) {
    pushUnique(m[0]);
    if (found.length >= 2) break;
  }

  if (found.length === 0) {
    const zhRegex = /[\u4e00-\u9fa5]{2,8}/g;
    while ((m = zhRegex.exec(combined)) !== null) {
      const token = m[0];
      if (!["审批", "通过", "同意", "放行", "准入", "候选", "需求", "任务"].includes(token)) {
        found.push(token);
        if (found.length >= 2) break;
      }
    }
  }

  return found.slice(0, 2);
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

export class StrategyDepartment implements DepartmentModule {
  readonly id = "strategy" as const;
  private readonly kernel: OpcKernel;
  private unsubscribeDecisionResolved: (() => void) | null = null;

  constructor(kernelOrOptions: OpcKernel | StrategyDepartmentOptions) {
    this.kernel = "kernel" in kernelOrOptions ? kernelOrOptions.kernel : kernelOrOptions;

    this.kernel.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_preference_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        weight REAL NOT NULL,
        mainline_id TEXT,
        auto_action TEXT,
        note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_preference_rules_kind ON opc_preference_rules(kind, enabled);

      CREATE TABLE IF NOT EXISTS opc_preference_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        decision_id TEXT,
        mainline_id TEXT,
        asset_id TEXT,
        outcome TEXT NOT NULL,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        learned_delta_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_preference_events_created ON opc_preference_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS opc_freeze_overrides (
        id TEXT PRIMARY KEY,
        target_ref TEXT NOT NULL,
        decision_id TEXT,
        reason TEXT NOT NULL DEFAULT '',
        one_off INTEGER NOT NULL DEFAULT 1,
        consumed INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_freeze_overrides_ref ON opc_freeze_overrides(target_ref, consumed);
    `);

    this.seedDefaultsIfEmpty();
    this.registerDecisionHandlers();
    this.ensureSubscriptions();
  }

  start(): void {
    this.ensureSubscriptions();
  }

  stop(): void {
    if (this.unsubscribeDecisionResolved) {
      this.unsubscribeDecisionResolved();
      this.unsubscribeDecisionResolved = null;
    }
  }

  health(): DepartmentHealth {
    const mainlines = this.kernel.registry.listMainlines();
    const activeMainlines = mainlines.filter((m) => m.status === "active");
    const rules = this.listRules({ enabledOnly: true });
    const eventsCount = Number(
      (
        this.kernel.db
          .prepare("SELECT COUNT(*) AS n FROM opc_preference_events")
          .get() as { n?: number } | undefined
      )?.n ?? 0,
    );
    const pendingDecisions = this.kernel.decisions.counts().pending;

    return {
      healthy: activeMainlines.length > 0,
      summary: `活跃主线 ${activeMainlines.length} 条 · 启用偏好规则 ${rules.length} 条 · 待批示 ${pendingDecisions} 单`,
      metrics: {
        activeMainlines: activeMainlines.length,
        enabledRules: rules.length,
        learnedEvents: eventsCount,
        pendingDecisions,
      },
    };
  }

  private ensureSubscriptions(): void {
    if (this.unsubscribeDecisionResolved) return;
    this.unsubscribeDecisionResolved = this.kernel.events.subscribe(
      "decision.resolved",
      (event) => {
        this.handleDecisionResolved(event);
      },
    );
  }

  private seedDefaultsIfEmpty(): void {
    const row = this.kernel.db
      .prepare("SELECT COUNT(*) AS n FROM opc_preference_rules")
      .get() as { n?: number } | undefined;
    if (Number(row?.n ?? 0) > 0) return;

    const defaults: UpsertPreferenceRuleInput[] = [
      {
        id: "rule_prefer_local_first_deterministic",
        kind: "prefer_tag",
        pattern:
          "local-first|offline|deterministic|e2e|testable|monetization|本地优先|离线授权|确定性|首单|闭环",
        weight: 15,
        note: "偏好本地优先、具备外部确定性测试门禁或直接推进首单商业闭环的特性",
      },
      {
        id: "rule_prefer_stability_bugfix",
        kind: "prefer_tag",
        pattern: "bug|crash|self-heal|security|patrol|自愈|崩溃|稳定性|修复",
        weight: 10,
        note: "优先保障线上服务稳定性、崩溃自愈与高确定性缺陷修复",
      },
      {
        id: "rule_avoid_vague_infra_sprawl",
        kind: "avoid_keyword",
        pattern:
          "infra-sprawl|new-infra|microservice|k8s|rewrite-all|sprawl|新建外围仓库|重构全部|过度基建|玩具框架",
        weight: -25,
        note: "严厉惩罚脱离主线的重复造轮子、外围基建膨胀与无明确验收标准的大规模重写",
      },
      {
        id: "rule_prefer_core_mainlines",
        kind: "prefer_mainline",
        pattern: "ml_dark_factory|ml_flagship_monetization|agent-dark-factory|flagship-monetization",
        weight: 8,
        note: "优先向暗工厂中枢与旗舰变现两条核心主线倾斜算力",
      },
      {
        id: "rule_budget_low_risk_maintenance",
        kind: "budget_cap",
        pattern: "max_usd:2.0",
        weight: 5,
        autoAction: "auto_approve_under_2_usd",
        note: "单次预估算力成本不超过 $2 的低风险常规维护自动加分并支持免打扰放行",
      },
    ];

    for (const item of defaults) {
      this.createRule(item);
    }
  }

  private registerDecisionHandlers(): void {
    this.kernel.decisions.registerHandler("strategy.override_freeze", ({ packet, option, note }) => {
      const payload = option.payload ?? {};
      const mode = String(payload.mode ?? "one_off");

      if (mode === "toggle_mainline" || typeof payload.freezeNonMainline === "boolean") {
        const nextFreeze =
          typeof payload.freezeNonMainline === "boolean" ? payload.freezeNonMainline : false;
        const targetMainlineId = String(payload.mainlineId ?? packet.mainlineId ?? "").trim();

        if (targetMainlineId && targetMainlineId !== "all") {
          const existing = this.kernel.registry.getMainline(targetMainlineId);
          if (!existing) {
            throw new ApiError(404, "mainline_not_found", `未找到主线: ${targetMainlineId}`);
          }
          const updated = this.kernel.registry.upsertMainline({
            id: existing.id,
            name: existing.name,
            freezeNonMainline: nextFreeze,
          });
          return {
            mode: "toggle_mainline",
            mainlineId: updated.id,
            freezeNonMainline: updated.freezeNonMainline,
          };
        }

        const updatedIds: string[] = [];
        for (const ml of this.kernel.registry.listMainlines()) {
          if (ml.status === "active" && ml.freezeNonMainline !== nextFreeze) {
            this.kernel.registry.upsertMainline({
              id: ml.id,
              name: ml.name,
              freezeNonMainline: nextFreeze,
            });
            updatedIds.push(ml.id);
          }
        }
        return {
          mode: "toggle_mainline",
          updatedMainlineIds: updatedIds,
          freezeNonMainline: nextFreeze,
        };
      }

      const targetRef = String(
        payload.targetRef ?? payload.projectOrAssetRef ?? packet.assetId ?? packet.productId ?? "*",
      ).trim();
      const oneOff = payload.oneOff !== false;
      const ttlHours = Number(payload.ttlHours ?? 24);
      const now = new Date();
      const expiresAt =
        Number.isFinite(ttlHours) && ttlHours > 0
          ? new Date(now.getTime() + ttlHours * 3_600_000).toISOString()
          : null;
      const overrideId = `fov_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

      this.kernel.db
        .prepare(
          `INSERT INTO opc_freeze_overrides
           (id, target_ref, decision_id, reason, one_off, consumed, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          overrideId,
          targetRef,
          packet.id,
          note || String(payload.reason ?? "总裁特批单次豁免冻结纪律"),
          oneOff ? 1 : 0,
          expiresAt,
          now.toISOString(),
        );

      return {
        mode: "one_off",
        overrideId,
        targetRef,
        oneOff,
        expiresAt,
      };
    });
  }

  private consumeFreezeOverrideIfAvailable(
    rawRef: string,
    resolution: CanonicalResolution,
    consume: boolean,
  ): FreezeOverrideRecord | null {
    const now = new Date().toISOString();
    const candidates = new Set<string>(
      [
        "*",
        rawRef.trim(),
        resolution.asset?.id,
        resolution.asset?.slug,
        resolution.asset?.name,
        resolution.product?.id,
        resolution.product?.slug,
        resolution.product?.name,
      ]
        .filter((x): x is string => Boolean(x && x.trim()))
        .map((x) => x.toLowerCase()),
    );

    const rows = this.kernel.db
      .prepare(
        `SELECT * FROM opc_freeze_overrides
         WHERE consumed = 0 AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC`,
      )
      .all(now) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const record = this.mapFreezeOverride(row);
      if (candidates.has(record.targetRef.toLowerCase())) {
        if (consume && record.oneOff) {
          this.kernel.db
            .prepare("UPDATE opc_freeze_overrides SET consumed = 1 WHERE id = ?")
            .run(record.id);
          record.consumed = true;
        }
        return record;
      }
    }
    return null;
  }

  private handleDecisionResolved(event: DomainEventRecord<Record<string, unknown>>): void {
    const payload = event.payload ?? {};
    if (payload.autoApproved === true) return;

    const outcome = String(payload.outcome ?? "") as DecisionOutcome | string;
    if (outcome !== "approved" && outcome !== "rejected" && outcome !== "changes_requested") {
      return;
    }

    const decisionId = payload.decisionId ? String(payload.decisionId) : null;
    const title = String(payload.title ?? "").trim() || "未命名决策";
    const note = String(payload.note ?? "").trim();
    const tags = Array.isArray(payload.tags)
      ? payload.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
    const kind = String(payload.kind ?? "");
    const now = new Date().toISOString();

    const adjustedRules: Array<{
      ruleId: string;
      kind: PreferenceRuleKind;
      pattern: string;
      previousWeight: number | null;
      newWeight: number;
    }> = [];

    if (outcome === "approved") {
      // Operational patrol alerts shouldn't inflate generic tag scores unless tags exist
      const candidateTerms =
        tags.length > 0
          ? tags.slice(0, 5)
          : kind === "patrol_alert"
            ? []
            : extractApprovalKeywords(title, note);

      for (const term of candidateTerms) {
        const existing = this.findExactRule("prefer_tag", term);
        if (existing) {
          const nextWeight = Math.min(30, round2(existing.weight + 4));
          this.updateRule(existing.id, {
            weight: nextWeight,
            enabled: true,
          });
          adjustedRules.push({
            ruleId: existing.id,
            kind: "prefer_tag",
            pattern: existing.pattern,
            previousWeight: existing.weight,
            newWeight: nextWeight,
          });
        } else {
          const created = this.createRule({
            kind: "prefer_tag",
            pattern: term,
            weight: 4,
            mainlineId: null,
            note: `从创始人审批通过自动习得${decisionId ? ` (${decisionId})` : ""}`,
          });
          adjustedRules.push({
            ruleId: created.id,
            kind: "prefer_tag",
            pattern: created.pattern,
            previousWeight: null,
            newWeight: created.weight,
          });
        }
      }
    } else {
      const keywords = extractRejectionKeywords(note, tags);
      for (const kw of keywords) {
        const existing = this.findExactRule("avoid_keyword", kw);
        if (existing) {
          const nextWeight = Math.max(-40, round2(existing.weight - 8));
          this.updateRule(existing.id, {
            weight: nextWeight,
            enabled: true,
          });
          adjustedRules.push({
            ruleId: existing.id,
            kind: "avoid_keyword",
            pattern: existing.pattern,
            previousWeight: existing.weight,
            newWeight: nextWeight,
          });
        } else {
          const created = this.createRule({
            kind: "avoid_keyword",
            pattern: kw,
            weight: -8,
            mainlineId: null,
            note: `从创始人驳回批注自动习得${decisionId ? ` (${decisionId})` : ""}`,
          });
          adjustedRules.push({
            ruleId: created.id,
            kind: "avoid_keyword",
            pattern: created.pattern,
            previousWeight: null,
            newWeight: created.weight,
          });
        }
      }
    }

    const learnedDelta = {
      outcome,
      adjustedCount: adjustedRules.length,
      adjustedRules,
    };
    const prefEventId = `pev_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.kernel.db
      .prepare(
        `INSERT INTO opc_preference_events
         (id, source, decision_id, mainline_id, asset_id, outcome, title, tags_json, note, learned_delta_json, created_at)
         VALUES (?, 'decision.resolved', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prefEventId,
        decisionId,
        event.mainlineId ?? null,
        event.assetId ?? null,
        outcome,
        title,
        JSON.stringify(tags),
        note,
        JSON.stringify(learnedDelta),
        now,
      );

    this.kernel.events.emit({
      topic: "strategy.preference_learned",
      sourceDomain: "strategy",
      mainlineId: event.mainlineId ?? null,
      productId: event.productId ?? null,
      assetId: event.assetId ?? null,
      payload: {
        preferenceEventId: prefEventId,
        decisionId,
        outcome,
        title,
        adjustedRules,
      },
    });
  }

  private findExactRule(kind: PreferenceRuleKind, pattern: string): PreferenceRule | null {
    const row = this.kernel.db
      .prepare(
        "SELECT * FROM opc_preference_rules WHERE kind = ? AND lower(pattern) = lower(?) LIMIT 1",
      )
      .get(kind, pattern.trim()) as Record<string, unknown> | undefined;
    return row ? this.mapRule(row) : null;
  }

  listRules(options: { enabledOnly?: boolean; kind?: PreferenceRuleKind } = {}): PreferenceRule[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (options.enabledOnly) {
      clauses.push("enabled = 1");
    }
    if (options.kind) {
      clauses.push("kind = ?");
      args.push(options.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.kernel.db
      .prepare(`SELECT * FROM opc_preference_rules ${where} ORDER BY ABS(weight) DESC, created_at ASC`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRule(r));
  }

  getRule(id: string): PreferenceRule | null {
    const row = this.kernel.db
      .prepare("SELECT * FROM opc_preference_rules WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRule(row) : null;
  }

  createRule(input: UpsertPreferenceRuleInput): PreferenceRule {
    if (!PREFERENCE_RULE_KINDS.includes(input.kind)) {
      throw new ApiError(400, "bad_preference_rule", `不支持的偏好规则类型: ${String(input.kind)}`);
    }
    const pattern = input.pattern.trim();
    if (!pattern) {
      throw new ApiError(400, "bad_preference_rule", "偏好规则匹配模式 pattern 不能为空");
    }
    const weight = Number(input.weight);
    if (!Number.isFinite(weight)) {
      throw new ApiError(400, "bad_preference_rule", "偏好规则权重必须是合法数字");
    }
    const id = input.id?.trim() || `prf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();

    this.kernel.db
      .prepare(
        `INSERT INTO opc_preference_rules
         (id, kind, pattern, weight, mainline_id, auto_action, note, enabled, hit_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           pattern = excluded.pattern,
           weight = excluded.weight,
           mainline_id = excluded.mainline_id,
           auto_action = excluded.auto_action,
           note = excluded.note,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.kind,
        pattern,
        clamp(round2(weight), -100, 100),
        input.mainlineId ? input.mainlineId.trim() : null,
        input.autoAction ? input.autoAction.trim() : null,
        (input.note ?? "").trim(),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );

    return this.getRule(id)!;
  }

  updateRule(id: string, patch: UpdatePreferenceRuleInput): PreferenceRule {
    const existing = this.getRule(id);
    if (!existing) {
      throw new ApiError(404, "preference_rule_not_found", `未找到偏好规则: ${id}`);
    }
    const nextKind = patch.kind ?? existing.kind;
    if (!PREFERENCE_RULE_KINDS.includes(nextKind)) {
      throw new ApiError(400, "bad_preference_rule", `不支持的偏好规则类型: ${String(nextKind)}`);
    }
    const nextPattern = patch.pattern !== undefined ? patch.pattern.trim() : existing.pattern;
    if (!nextPattern) {
      throw new ApiError(400, "bad_preference_rule", "偏好规则匹配模式 pattern 不能为空");
    }
    const nextWeight =
      patch.weight !== undefined ? clamp(round2(Number(patch.weight)), -100, 100) : existing.weight;
    if (!Number.isFinite(nextWeight)) {
      throw new ApiError(400, "bad_preference_rule", "偏好规则权重必须是合法数字");
    }
    const nextMainlineId =
      patch.mainlineId !== undefined ? (patch.mainlineId ? patch.mainlineId.trim() : null) : existing.mainlineId;
    const nextAutoAction =
      patch.autoAction !== undefined ? (patch.autoAction ? patch.autoAction.trim() : null) : existing.autoAction;
    const nextNote = patch.note !== undefined ? patch.note.trim() : existing.note;
    const nextEnabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    const now = new Date().toISOString();

    this.kernel.db
      .prepare(
        `UPDATE opc_preference_rules
         SET kind = ?, pattern = ?, weight = ?, mainline_id = ?, auto_action = ?,
             note = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextKind,
        nextPattern,
        nextWeight,
        nextMainlineId,
        nextAutoAction,
        nextNote,
        nextEnabled ? 1 : 0,
        now,
        id,
      );

    return this.getRule(id)!;
  }

  deleteRule(id: string): { deleted: true; id: string } {
    const existing = this.getRule(id);
    if (!existing) {
      throw new ApiError(404, "preference_rule_not_found", `未找到偏好规则: ${id}`);
    }
    this.kernel.db.prepare("DELETE FROM opc_preference_rules WHERE id = ?").run(id);
    return { deleted: true, id };
  }

  listRecentEvents(limit = 30): PreferenceEvent[] {
    const safeLimit = clamp(Math.floor(Number(limit) || 30), 1, 200);
    const rows = this.kernel.db
      .prepare("SELECT * FROM opc_preference_events ORDER BY created_at DESC LIMIT ?")
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapEvent(r));
  }

  listFreezeOverrides(limit = 20): FreezeOverrideRecord[] {
    const safeLimit = clamp(Math.floor(Number(limit) || 20), 1, 100);
    const rows = this.kernel.db
      .prepare("SELECT * FROM opc_freeze_overrides ORDER BY created_at DESC LIMIT ?")
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapFreezeOverride(r));
  }

  overview(): StrategyOverviewSnapshot {
    return {
      mainlines: this.kernel.registry.listMainlines(),
      portfolio: this.kernel.registry.portfolio(),
      rules: this.listRules(),
      recentEvents: this.listRecentEvents(30),
      policy: this.kernel.decisions.getPolicy(),
      freezeOverrides: this.listFreezeOverrides(20),
    };
  }

  evaluateCandidate(input: CandidateEvaluationInput): CandidateEvaluationResult {
    const title = (input.title ?? "").trim();
    if (!title) {
      throw new ApiError(400, "bad_candidate", "候选需求标题不能为空");
    }
    const description = (input.description ?? "").trim();
    const ref = (input.projectOrAssetRef ?? "").trim();
    const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
    const recordHits = input.recordHits ?? true;

    const admission = this.kernel.registry.checkAdmission(ref, {
      isEmergencyBug: input.isEmergencyBug,
    });

    if (!admission.allowed) {
      const freezeOverride =
        admission.code === "mainline_frozen"
          ? this.consumeFreezeOverrideIfAvailable(ref, admission.resolution, recordHits)
          : null;

      if (!freezeOverride) {
        const reason = admission.reason ?? "候选需求未通过战略准入治理检查";
        return {
          allowed: false,
          blockReason: reason,
          blockCode: admission.code,
          totalScore: 0,
          mainlineScore: 0,
          habitScore: 0,
          clarityScore: 0,
          resolution: admission.resolution,
          matchedRules: [],
          recommendation: "blocked",
          summary: reason,
        };
      }
    }

    const resolution = admission.resolution;

    // 1. Mainline Alignment Score (0..40)
    const mainlineScore = resolution.mainline
      ? clamp(Math.round(resolution.mainline.priorityWeight * 0.4), 0, 40)
      : 12;

    // 2. Habit & Preference Score (-40..+35)
    const enabledRules = this.listRules({ enabledOnly: true });
    const haystack = `${title}\n${description}`.toLowerCase();
    const lowerTags = tags.map((t) => t.toLowerCase());
    const matchedRules: MatchedPreferenceRule[] = [];
    let rawHabit = 0;

    for (const rule of enabledRules) {
      if (
        rule.mainlineId &&
        rule.kind !== "prefer_mainline" &&
        rule.mainlineId !== resolution.mainline?.id
      ) {
        continue;
      }

      const match = this.matchRule(rule, {
        haystack,
        lowerTags,
        resolution,
        estimatedCostUsd: input.estimatedCostUsd,
      });
      if (match) {
        matchedRules.push({
          id: rule.id,
          kind: rule.kind,
          pattern: rule.pattern,
          weight: match.appliedWeight,
          matchedTerm: match.matchedTerm,
          autoAction: rule.autoAction,
        });
        rawHabit += match.appliedWeight;
      }
    }

    if (recordHits && matchedRules.length > 0) {
      const stmt = this.kernel.db.prepare(
        "UPDATE opc_preference_rules SET hit_count = hit_count + 1 WHERE id = ?",
      );
      for (const m of matchedRules) {
        stmt.run(m.id);
      }
    }

    const habitScore = clamp(Math.round(rawHabit), -40, 35);

    // 3. Clarity & Deterministic Testability Score (0..25)
    const clarityScore = this.computeClarityScore(title, description, Boolean(input.isEmergencyBug));

    const totalScore = clamp(Math.round(mainlineScore + habitScore + clarityScore), 0, 100);
    const recommendation: CandidateRecommendation =
      totalScore >= 75 ? "auto_promote" : totalScore >= 45 ? "needs_review" : "drop_noise";

    const mainlineLabel = resolution.mainline
      ? `${resolution.mainline.name} (${mainlineScore}/40)`
      : `未绑定主线 (${mainlineScore}/40)`;
    const summary = `总分 ${totalScore}/100 [${recommendation}] —— 主线: ${mainlineLabel}，习惯加权: ${habitScore >= 0 ? `+${habitScore}` : habitScore}（命中 ${matchedRules.length} 条规则），清晰度: ${clarityScore}/25`;

    return {
      allowed: true,
      totalScore,
      mainlineScore,
      habitScore,
      clarityScore,
      resolution,
      matchedRules,
      recommendation,
      summary,
    };
  }

  private matchRule(
    rule: PreferenceRule,
    ctx: {
      haystack: string;
      lowerTags: string[];
      resolution: CanonicalResolution;
      estimatedCostUsd?: number;
    },
  ): { matchedTerm: string; appliedWeight: number } | null {
    const terms = rule.pattern
      .split("|")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length === 0) return null;

    if (rule.kind === "prefer_mainline") {
      const ml = ctx.resolution.mainline;
      if (!ml) return null;
      if (rule.mainlineId && rule.mainlineId === ml.id) {
        return { matchedTerm: ml.id, appliedWeight: rule.weight };
      }
      const mlKeys = [ml.id.toLowerCase(), ml.slug.toLowerCase(), ml.name.toLowerCase()];
      const hit = terms.find((term) => mlKeys.some((k) => k === term || k.includes(term)));
      return hit ? { matchedTerm: hit, appliedWeight: rule.weight } : null;
    }

    if (rule.kind === "budget_cap") {
      if (ctx.estimatedCostUsd === undefined || !Number.isFinite(ctx.estimatedCostUsd)) {
        return null;
      }
      const capMatch = /max_usd\s*:\s*([0-9.]+)/i.exec(rule.pattern);
      const parsedCap = capMatch ? Number(capMatch[1]) : Number(rule.pattern);
      const cap = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : 2.0;
      if (ctx.estimatedCostUsd <= cap && rule.weight >= 0) {
        return { matchedTerm: `<=$${cap}`, appliedWeight: rule.weight };
      }
      if (ctx.estimatedCostUsd > cap * 5) {
        return {
          matchedTerm: `>$${round2(cap * 5)}`,
          appliedWeight: rule.weight < 0 ? rule.weight : -Math.abs(rule.weight),
        };
      }
      return null;
    }

    // prefer_tag | avoid_keyword | scope_rule
    for (const term of terms) {
      if (ctx.lowerTags.some((t) => t === term || t.includes(term))) {
        return { matchedTerm: `tag:${term}`, appliedWeight: rule.weight };
      }
      if (ctx.haystack.includes(term)) {
        return { matchedTerm: term, appliedWeight: rule.weight };
      }
    }

    return null;
  }

  private computeClarityScore(title: string, description: string, isEmergencyBug: boolean): number {
    const combined = `${title}\n${description}`;
    let score = 0;

    // 1. Substantive title (0..5)
    const cjkCount = (title.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    if (title.length >= 12 || cjkCount >= 6) {
      score += 5;
    } else if (title.length >= 5 || cjkCount >= 3) {
      score += 2;
    }

    // 2. Scope & context richness (0..6)
    if (description.length >= 80) {
      score += 6;
    } else if (description.length >= 30) {
      score += 4;
    } else if (description.length >= 10) {
      score += 2;
    }

    // 3. Concrete technical target: file path, API route, issue ref, CLI/table/error identifier (0..7)
    const hasHardTarget =
      /(?:src\/|\/api\/|\.[a-z]{2,4}\b|#[0-9]+|`[^`]+`|\b(?:TypeError|ReferenceError|ApiError|SQLITE_|ECONN|HTTP\s*[45]\d\d)\b)/i.test(
        combined,
      );
    const hasModuleSignal =
      /(?:endpoint|route|table|schema|hook|worker|cli|webhook|handler|component|接口|路由|表结构|组件|脚本|告警|崩溃)/i.test(
        combined,
      );
    if (hasHardTarget) {
      score += 7;
    } else if (hasModuleSignal) {
      score += 4;
    }

    // 4. Deterministic verification / acceptance criteria (0..7)
    const hasVerifyCriteria =
      /(?:npm\s+(?:run|test)|npx\s+|verify|test|assert|typecheck|tsc|expect|验收|测试|断言|门禁|复现|预期|闭环|-\s*\[\s*\])/i.test(
        combined,
      );
    if (hasVerifyCriteria) {
      score += 7;
    } else if (isEmergencyBug) {
      score += 5;
    }

    // Vague one-liner cap
    if (
      description.length === 0 &&
      /(?:随便看看|以后再说|有空研究|maybe\s+later|someday|research\s+everything)/i.test(title)
    ) {
      return Math.min(score, 3);
    }

    return clamp(score, 0, 25);
  }

  registerRoutes(app: Hono, requireUser: (c: Context) => { id: string; name: string }): void {
    const base = "/api/opc/domains/strategy" as const;

    app.use(`${base}/*`, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });

    app.get(`${base}/overview`, (c) => {
      requireUser(c);
      return c.json(this.overview());
    });

    app.get(`${base}/rules`, (c) => {
      requireUser(c);
      const enabledOnly = c.req.query("enabledOnly") === "true" || c.req.query("enabledOnly") === "1";
      return c.json({ rules: this.listRules({ enabledOnly }) });
    });

    app.post(`${base}/rules`, async (c) => {
      requireUser(c);
      const body = await readJsonBody(c);
      const rule = this.createRule({
        id: typeof body.id === "string" ? body.id : undefined,
        kind: String(body.kind ?? "") as PreferenceRuleKind,
        pattern: String(body.pattern ?? ""),
        weight: Number(body.weight),
        mainlineId:
          body.mainlineId === null
            ? null
            : typeof body.mainlineId === "string"
              ? body.mainlineId
              : undefined,
        autoAction:
          body.autoAction === null
            ? null
            : typeof body.autoAction === "string"
              ? body.autoAction
              : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      });
      return c.json({ rule }, 201);
    });

    app.put(`${base}/rules/:id`, async (c) => {
      requireUser(c);
      const body = await readJsonBody(c);
      const patch: UpdatePreferenceRuleInput = {};
      if (body.kind !== undefined) patch.kind = String(body.kind) as PreferenceRuleKind;
      if (body.pattern !== undefined) patch.pattern = String(body.pattern);
      if (body.weight !== undefined) patch.weight = Number(body.weight);
      if (body.mainlineId !== undefined) {
        patch.mainlineId = body.mainlineId === null ? null : String(body.mainlineId);
      }
      if (body.autoAction !== undefined) {
        patch.autoAction = body.autoAction === null ? null : String(body.autoAction);
      }
      if (body.note !== undefined) patch.note = String(body.note);
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);

      const rule = this.updateRule(c.req.param("id"), patch);
      return c.json({ rule });
    });

    app.delete(`${base}/rules/:id`, (c) => {
      requireUser(c);
      return c.json(this.deleteRule(c.req.param("id")));
    });

    app.post(`${base}/evaluate`, async (c) => {
      requireUser(c);
      const body = await readJsonBody(c);
      const evaluation = this.evaluateCandidate({
        title: String(body.title ?? ""),
        description: typeof body.description === "string" ? body.description : undefined,
        projectOrAssetRef:
          typeof body.projectOrAssetRef === "string"
            ? body.projectOrAssetRef
            : typeof body.projectRef === "string"
              ? body.projectRef
              : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        estimatedCostUsd:
          typeof body.estimatedCostUsd === "number" ? body.estimatedCostUsd : undefined,
        isEmergencyBug: typeof body.isEmergencyBug === "boolean" ? body.isEmergencyBug : undefined,
        recordHits: typeof body.recordHits === "boolean" ? body.recordHits : undefined,
      });
      return c.json(evaluation);
    });
  }

  private mapRule(row: Record<string, unknown>): PreferenceRule {
    return {
      id: String(row.id),
      kind: String(row.kind) as PreferenceRuleKind,
      pattern: String(row.pattern),
      weight: Number(row.weight ?? 0),
      mainlineId: row.mainline_id ? String(row.mainline_id) : null,
      autoAction: row.auto_action ? String(row.auto_action) : null,
      note: String(row.note ?? ""),
      enabled: Boolean(row.enabled),
      hitCount: Number(row.hit_count ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapEvent(row: Record<string, unknown>): PreferenceEvent {
    return {
      id: String(row.id),
      source: String(row.source),
      decisionId: row.decision_id ? String(row.decision_id) : null,
      mainlineId: row.mainline_id ? String(row.mainline_id) : null,
      assetId: row.asset_id ? String(row.asset_id) : null,
      outcome: String(row.outcome),
      title: String(row.title),
      tags: safeJson<string[]>(String(row.tags_json ?? "[]"), []),
      note: String(row.note ?? ""),
      learnedDelta: safeJson<Record<string, unknown>>(String(row.learned_delta_json ?? "{}"), {}),
      createdAt: String(row.created_at),
    };
  }

  private mapFreezeOverride(row: Record<string, unknown>): FreezeOverrideRecord {
    return {
      id: String(row.id),
      targetRef: String(row.target_ref),
      decisionId: row.decision_id ? String(row.decision_id) : null,
      reason: String(row.reason ?? ""),
      oneOff: Boolean(row.one_off),
      consumed: Boolean(row.consumed),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
    };
  }
}
