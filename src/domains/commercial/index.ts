import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import type { CompanionServiceId, CompanionServiceStatus } from "../../commercial-types.ts";
import type {
  DepartmentHealth,
  DepartmentModule,
  OpcKernel,
} from "../../kernel/index.ts";
import type { ResourceDepartmentIndex } from "../../resource-department-types.ts";
import type { CommercialHubService } from "../../server/commercial.ts";
import { ApiError } from "../../server/logic.ts";
import { toUsd } from "../../server/metabolism.ts";
import { readHubResources } from "../../server/resource-department.ts";

export type CustomerLifecycleStage =
  | "waitlist"
  | "activated"
  | "paying"
  | "repeat"
  | "at_risk";

export interface CustomerCrmProfile {
  customerId: string;
  emailMasked: string;
  channel: string;
  products: string[];
  ordersCount: number;
  totalPaidMinor: number;
  currency: string;
  activeLicenses: number;
  openTickets: number;
  activated: boolean;
  stage: CustomerLifecycleStage;
}

export interface CustomerCrmSnapshot {
  companionSources: {
    commerce: "http" | "sqlite" | "offline";
    gtm: "http" | "sqlite" | "offline";
    ops: "http" | "sqlite" | "offline";
  };
  totalCustomers: number;
  byStage: Record<CustomerLifecycleStage, number>;
  customers: CustomerCrmProfile[];
  generatedAt: string;
}

export interface ProductLedgerSummary {
  product: string;
  ordersCount: number;
  refundCount: number;
  activeLicenses: number;
  grossUsd: number;
  refundsUsd: number;
  commerceCostUsd: number;
  netUsd: number;
  currencies: Array<{
    currency: string;
    grossMinor: number;
    refundMinor: number;
    costMinor: number;
    netMinor: number;
  }>;
}

export interface UnifiedLedgerSnapshot {
  companionOnline: boolean;
  source: "companion_http" | "companion_sqlite" | "internal_only";
  products: ProductLedgerSummary[];
  grossRevenueUsd: number;
  refundsUsd: number;
  commerceCostUsd: number;
  internalAiMonthlyUsd: number;
  factoryTokenCostUsd: number;
  unsyncedAiMonthlyUsd: number;
  unsyncedFactoryTokenCostUsd: number;
  netUsd: number;
  generatedAt: string;
}

export interface SyncInternalCostsResult {
  companionOnline: boolean;
  syncedCount: number;
  alreadySyncedCount: number;
  pendingCount: number;
  totalSyncedMinor: number;
  syncedItems: Array<{
    costKey: string;
    product: string;
    category: "llm_factory" | "ai_subscription";
    amountMinor: number;
    syncedAt: string;
  }>;
}

export interface CommercialHubPort {
  checkServices(): Promise<{
    services: CompanionServiceStatus[];
    rawBodies?: Partial<Record<CompanionServiceId, Record<string, unknown>>>;
  }>;
  runClosedLoopVerification(input?: unknown): Promise<Record<string, unknown>>;
  pilot?: () => { product: string; project: string; slug: string };
  serviceOrigins?: () => {
    commerce: string;
    gtm: string;
    ops: string;
    data_analysis: string;
  };
  lastSandboxReceipt?: () => Record<string, unknown> | null;
}

export interface CommercialDepartmentOptions {
  kernel: OpcKernel;
  commercialHub?: CommercialHubService | CommercialHubPort;
  hubQuotaPath?: string;
  commerceOrigin?: string;
  gtmOrigin?: string;
  opsOrigin?: string;
  commerceDbPath?: string;
  gtmDbPath?: string;
  opsDbPath?: string;
  readHubFn?: (nowMs: number) => ResourceDepartmentIndex["hub"];
  fetchImpl?: typeof fetch;
  nowFn?: () => number;
}

interface InternalCostCandidate {
  costKey: string;
  product: string;
  category: "llm_factory" | "ai_subscription";
  amountMinor: number;
  amountUsd: number;
  note: string;
  at: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function minorToUsd(minor: number, currency: string): number {
  const cur = currency.toUpperCase();
  const divisor = cur === "JPY" || cur === "KRW" ? 1 : 100;
  return toUsd(minor / divisor, cur);
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

function isSandboxProduct(product: string | null | undefined): boolean {
  return Boolean(product && product.trim().toLowerCase().startsWith("sandbox-pilot-"));
}

function maskEmail(raw: string): string {
  const trimmed = raw.trim();
  const atIdx = trimmed.indexOf("@");
  if (atIdx <= 0) return "";
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  if (!domain) return "";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

export class CommercialDepartment implements DepartmentModule {
  readonly id = "commercial" as const;
  private readonly db: DatabaseSync;
  private readonly kernel: OpcKernel;
  private readonly commercialHub?: CommercialHubPort;
  private readonly hubQuotaPath: string;
  private readonly commerceOriginOverride?: string;
  private readonly gtmOriginOverride?: string;
  private readonly opsOriginOverride?: string;
  private readonly commerceDbPath: string;
  private readonly gtmDbPath: string;
  private readonly opsDbPath: string;
  private readonly readHubFn: (nowMs: number) => ResourceDepartmentIndex["hub"];
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;

  constructor(options: CommercialDepartmentOptions);
  constructor(kernel: OpcKernel, options?: Omit<CommercialDepartmentOptions, "kernel">);
  constructor(
    first: CommercialDepartmentOptions | OpcKernel,
    second?: Omit<CommercialDepartmentOptions, "kernel">,
  ) {
    const opts: CommercialDepartmentOptions =
      "registry" in first && "decisions" in first
        ? { kernel: first, ...(second ?? {}) }
        : first;

    this.kernel = opts.kernel;
    this.db = opts.kernel.db;
    this.commercialHub = opts.commercialHub;
    this.hubQuotaPath =
      opts.hubQuotaPath ?? process.env.OPC_HUB_QUOTA_DB ?? join(homedir(), ".agent-hub", "hub.db");
    this.commerceOriginOverride = opts.commerceOrigin;
    this.gtmOriginOverride = opts.gtmOrigin;
    this.opsOriginOverride = opts.opsOrigin;

    const runtimeRoot = join(process.cwd(), "data", "companion-runtime");
    this.commerceDbPath = opts.commerceDbPath ?? join(runtimeRoot, "commerce", "commerce.db");
    this.gtmDbPath = opts.gtmDbPath ?? join(runtimeRoot, "gtm", "gtm.db");
    this.opsDbPath = opts.opsDbPath ?? join(runtimeRoot, "ops", "ops.db");

    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.readHubFn = opts.readHubFn ?? ((nowMs) => readHubResources(this.hubQuotaPath, nowMs));
    this.fetchImpl = opts.fetchImpl ?? fetch;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_commercial_synced_costs (
        cost_key TEXT PRIMARY KEY,
        amount_minor INTEGER NOT NULL,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_kill_switches (
        project TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        consecutive_loss_months INTEGER NOT NULL,
        cumulative_loss_usd REAL NOT NULL,
        reason TEXT NOT NULL,
        triggered_at TEXT,
        resumed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_governance_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.registerDecisionHandlers();
  }

  private resolveOrigins() {
    const hubOrigins = this.commercialHub?.serviceOrigins?.();
    return {
      commerce:
        this.commerceOriginOverride ||
        hubOrigins?.commerce ||
        process.env.OPC_COMMERCE_URL ||
        "http://127.0.0.1:52331",
      gtm:
        this.gtmOriginOverride ||
        hubOrigins?.gtm ||
        process.env.OPC_GTM_URL ||
        "http://127.0.0.1:52332",
      ops:
        this.opsOriginOverride ||
        hubOrigins?.ops ||
        process.env.OPC_OPS_URL ||
        "http://127.0.0.1:52333",
    };
  }

  private defaultProductName(): string {
    return this.commercialHub?.pilot?.().product || "PageLens";
  }

  private registerDecisionHandlers() {
    this.kernel.decisions.registerHandler(
      "commercial.kill_switch_freeze",
      async ({ packet, option, note }) => {
        const rawTarget = String(
          option.payload?.project ??
            option.payload?.product ??
            packet.assetId ??
            packet.productId ??
            "",
        ).trim();

        const resolved = rawTarget
          ? this.kernel.registry.resolveCanonicalRef(rawTarget)
          : {
              mainline: packet.mainlineId ? this.kernel.registry.getMainline(packet.mainlineId) : null,
              product: packet.productId ? this.kernel.registry.getProduct(packet.productId) : null,
              asset: packet.assetId ? this.kernel.registry.getAsset(packet.assetId) : null,
            };

        const projectKey =
          (typeof option.payload?.project === "string" && option.payload.project.trim()) ||
          resolved.asset?.name ||
          resolved.product?.name ||
          rawTarget ||
          packet.title;

        const now = new Date(this.nowFn()).toISOString();
        const reason =
          note ||
          (typeof option.payload?.reason === "string" ? option.payload.reason : "") ||
          `总裁审批执行商业熔断停服：${packet.title}`;
        const lossMonths = Number(option.payload?.consecutiveLossMonths ?? 3);
        const lossUsd = Number(option.payload?.cumulativeLossUsd ?? 0);

        const keysToFreeze = new Set<string>([projectKey]);
        if (resolved.product?.name) keysToFreeze.add(resolved.product.name);
        if (resolved.asset?.name) keysToFreeze.add(resolved.asset.name);

        for (const key of keysToFreeze) {
          this.db
            .prepare(
              `INSERT INTO opc_kill_switches
               (project, status, consecutive_loss_months, cumulative_loss_usd, reason, triggered_at, resumed_at, updated_at)
               VALUES (?, 'stopped', ?, ?, ?, ?, NULL, ?)
               ON CONFLICT(project) DO UPDATE SET
                 status = 'stopped',
                 consecutive_loss_months = excluded.consecutive_loss_months,
                 cumulative_loss_usd = excluded.cumulative_loss_usd,
                 reason = excluded.reason,
                 triggered_at = excluded.triggered_at,
                 resumed_at = NULL,
                 updated_at = excluded.updated_at`,
            )
            .run(key, lossMonths, lossUsd, reason, now, now);
        }

        const pausedAssets: string[] = [];
        if (resolved.product) {
          this.kernel.registry.upsertProduct({
            id: resolved.product.id,
            mainlineId: resolved.product.mainlineId,
            name: resolved.product.name,
            role: resolved.product.role,
            status: "paused",
          });
          for (const asset of this.kernel.registry.listAssets(resolved.product.id)) {
            this.kernel.registry.upsertAsset({
              id: asset.id,
              productId: asset.productId,
              name: asset.name,
              paused: true,
            });
            pausedAssets.push(asset.id);
          }
        } else if (resolved.asset) {
          this.kernel.registry.upsertAsset({
            id: resolved.asset.id,
            productId: resolved.asset.productId,
            name: resolved.asset.name,
            paused: true,
          });
          pausedAssets.push(resolved.asset.id);
        }

        return {
          status: "stopped",
          project: projectKey,
          productId: resolved.product?.id ?? null,
          pausedAssets,
        };
      },
    );

    this.kernel.decisions.registerHandler(
      "commercial.kill_switch_exempt",
      async ({ packet, option, note }) => {
        const rawTarget = String(
          option.payload?.project ??
            option.payload?.product ??
            packet.assetId ??
            packet.productId ??
            "",
        ).trim();

        const resolved = rawTarget
          ? this.kernel.registry.resolveCanonicalRef(rawTarget)
          : {
              mainline: packet.mainlineId ? this.kernel.registry.getMainline(packet.mainlineId) : null,
              product: packet.productId ? this.kernel.registry.getProduct(packet.productId) : null,
              asset: packet.assetId ? this.kernel.registry.getAsset(packet.assetId) : null,
            };

        const projectKey =
          (typeof option.payload?.project === "string" && option.payload.project.trim()) ||
          resolved.asset?.name ||
          resolved.product?.name ||
          rawTarget ||
          packet.title;

        const now = new Date(this.nowFn()).toISOString();
        const resumeReason = note || "创始人豁免熔断并恢复项目运行";

        const keysToResume = new Set<string>([projectKey]);
        if (resolved.product?.name) keysToResume.add(resolved.product.name);
        if (resolved.asset?.name) keysToResume.add(resolved.asset.name);

        for (const key of keysToResume) {
          this.db
            .prepare(
              `INSERT INTO opc_kill_switches
               (project, status, consecutive_loss_months, cumulative_loss_usd, reason, triggered_at, resumed_at, updated_at)
               VALUES (?, 'active', 0, 0, ?, NULL, ?, ?)
               ON CONFLICT(project) DO UPDATE SET
                 status = 'active',
                 reason = excluded.reason,
                 resumed_at = excluded.resumed_at,
                 updated_at = excluded.updated_at`,
            )
            .run(key, resumeReason, now, now);
        }

        const unpausedAssets: string[] = [];
        if (resolved.product) {
          this.kernel.registry.upsertProduct({
            id: resolved.product.id,
            mainlineId: resolved.product.mainlineId,
            name: resolved.product.name,
            role: resolved.product.role,
            status: "active",
          });
          for (const asset of this.kernel.registry.listAssets(resolved.product.id)) {
            this.kernel.registry.upsertAsset({
              id: asset.id,
              productId: asset.productId,
              name: asset.name,
              paused: false,
            });
            unpausedAssets.push(asset.id);
          }
        } else if (resolved.asset) {
          this.kernel.registry.upsertAsset({
            id: resolved.asset.id,
            productId: resolved.asset.productId,
            name: resolved.asset.name,
            paused: false,
          });
          unpausedAssets.push(resolved.asset.id);
        }

        return {
          status: "active",
          project: projectKey,
          productId: resolved.product?.id ?? null,
          unpausedAssets,
        };
      },
    );
  }

  private async fetchJsonSafe<T = Record<string, unknown>>(
    url: string,
    timeoutMs = 1500,
  ): Promise<{ ok: true; data: T } | { ok: false }> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false };
      const parsed = (await res.json()) as T;
      return { ok: true, data: parsed };
    } catch {
      return { ok: false };
    }
  }

  private collectInternalCosts(nowMs: number): {
    candidates: InternalCostCandidate[];
    syncedKeys: Map<string, number>;
    internalAiMonthlyUsd: number;
    factoryTokenCostUsd: number;
    unsyncedAiMonthlyUsd: number;
    unsyncedFactoryTokenCostUsd: number;
  } {
    const syncedRows = this.db
      .prepare("SELECT cost_key, amount_minor FROM opc_commercial_synced_costs")
      .all() as Array<{ cost_key: string; amount_minor: number }>;
    const syncedKeys = new Map(syncedRows.map((r) => [String(r.cost_key), Number(r.amount_minor)]));

    const candidates: InternalCostCandidate[] = [];
    const fallbackProduct = this.defaultProductName();
    const nowIso = new Date(nowMs).toISOString();
    const billingMonth = nowIso.slice(0, 7);

    // 1. Dark Factory Agent Runs (cost_usd > 0)
    let factoryTokenCostUsd = 0;
    let unsyncedFactoryTokenCostUsd = 0;
    if (hasTable(this.db, "opc_agent_runs")) {
      const runRows = this.db
        .prepare(
          `SELECT id, project, agent_name, task_title, cost_usd, COALESCE(completed_at, updated_at, created_at) AS ts
           FROM opc_agent_runs
           WHERE cost_usd > 0
           ORDER BY created_at ASC`,
        )
        .all() as Array<{
        id: string;
        project: string;
        agent_name: string;
        task_title: string;
        cost_usd: number;
        ts: string;
      }>;

      for (const r of runRows) {
        const usd = Number(r.cost_usd ?? 0);
        if (!Number.isFinite(usd) || usd <= 0) continue;
        factoryTokenCostUsd += usd;
        const costKey = `agent_run:${r.id}`;
        const amountMinor = Math.max(1, Math.round(usd * 100));
        if (!syncedKeys.has(costKey)) {
          unsyncedFactoryTokenCostUsd += usd;
        }
        const resolved = r.project ? this.kernel.registry.resolveCanonicalRef(r.project) : null;
        const product = resolved?.product?.name || r.project || fallbackProduct;
        candidates.push({
          costKey,
          product,
          category: "llm_factory",
          amountMinor,
          amountUsd: round2(usd),
          note: `Dark Factory Run ${r.id} (${r.agent_name}): ${r.task_title.slice(0, 80)}`,
          at: String(r.ts || nowIso),
        });
      }
    }

    // 2. Paid AI Subscriptions from Agent Hub (hub.fees)
    let internalAiMonthlyUsd = 0;
    let unsyncedAiMonthlyUsd = 0;
    const hub = this.readHubFn(nowMs);
    for (const fee of hub.fees) {
      if (!fee.paid || typeof fee.monthlyUsd !== "number" || fee.monthlyUsd <= 0) continue;
      internalAiMonthlyUsd += fee.monthlyUsd;
      const costKey = `ai_sub:${fee.tool}:${billingMonth}`;
      const amountMinor = Math.max(1, Math.round(fee.monthlyUsd * 100));
      if (!syncedKeys.has(costKey)) {
        unsyncedAiMonthlyUsd += fee.monthlyUsd;
      }
      candidates.push({
        costKey,
        product: fallbackProduct,
        category: "ai_subscription",
        amountMinor,
        amountUsd: round2(fee.monthlyUsd),
        note: `AI CLI 订阅月费计提 (${fee.tool} · ${fee.plan} · ${billingMonth})`,
        at: nowIso,
      });
    }

    return {
      candidates,
      syncedKeys,
      internalAiMonthlyUsd: round2(internalAiMonthlyUsd),
      factoryTokenCostUsd: round2(factoryTokenCostUsd),
      unsyncedAiMonthlyUsd: round2(unsyncedAiMonthlyUsd),
      unsyncedFactoryTokenCostUsd: round2(unsyncedFactoryTokenCostUsd),
    };
  }

  private async postCostToCommerce(
    commerceOrigin: string,
    item: InternalCostCandidate,
  ): Promise<boolean> {
    const url = `${commerceOrigin.replace(/\/+$/, "")}/api/v1/costs`;
    const costId = item.costKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const basePayload = {
      costId,
      product: item.product,
      category: item.category,
      currency: "USD",
      amountMinor: item.amountMinor,
      note: item.note,
      at: item.at,
      reference: `opc-internal://${item.costKey}`,
    };

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(basePayload),
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;

      // Compatibility fallback if opc-commerce-kit enforces strict enum ('llm_tokens' | 'infra')
      if (res.status === 400) {
        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        if (String(errBody.message ?? "").includes("Invalid cost category")) {
          const mappedCategory = item.category === "llm_factory" ? "llm_tokens" : "infra";
          const retry = await this.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...basePayload,
              category: mappedCategory,
              note: `[${item.category}] ${item.note}`,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(3000),
          });
          return retry.ok;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async syncInternalCostsToCommerce(): Promise<SyncInternalCostsResult> {
    const nowMs = this.nowFn();
    const origins = this.resolveOrigins();
    const { candidates, syncedKeys } = this.collectInternalCosts(nowMs);

    const unsynced = candidates.filter((c) => !syncedKeys.has(c.costKey));
    const alreadySyncedCount = candidates.length - unsynced.length;

    const healthProbe = await this.fetchJsonSafe(`${origins.commerce.replace(/\/+$/, "")}/api/health`);
    if (!healthProbe.ok) {
      return {
        companionOnline: false,
        syncedCount: 0,
        alreadySyncedCount,
        pendingCount: unsynced.length,
        totalSyncedMinor: 0,
        syncedItems: [],
      };
    }

    const syncedItems: SyncInternalCostsResult["syncedItems"] = [];
    let totalSyncedMinor = 0;

    for (const item of unsynced) {
      const ok = await this.postCostToCommerce(origins.commerce, item);
      if (!ok) continue;
      const syncedAt = new Date(this.nowFn()).toISOString();
      this.db
        .prepare(
          `INSERT INTO opc_commercial_synced_costs (cost_key, amount_minor, synced_at)
           VALUES (?, ?, ?)
           ON CONFLICT(cost_key) DO UPDATE SET
             amount_minor = excluded.amount_minor,
             synced_at = excluded.synced_at`,
        )
        .run(item.costKey, item.amountMinor, syncedAt);

      totalSyncedMinor += item.amountMinor;
      syncedItems.push({
        costKey: item.costKey,
        product: item.product,
        category: item.category,
        amountMinor: item.amountMinor,
        syncedAt,
      });
    }

    if (syncedItems.length > 0) {
      this.kernel.events.emit({
        topic: "commercial.cost_synced",
        sourceDomain: "commercial",
        payload: {
          syncedCount: syncedItems.length,
          totalSyncedMinor,
          totalSyncedUsd: round2(totalSyncedMinor / 100),
          items: syncedItems,
        },
      });
    }

    return {
      companionOnline: true,
      syncedCount: syncedItems.length,
      alreadySyncedCount,
      pendingCount: unsynced.length - syncedItems.length,
      totalSyncedMinor,
      syncedItems,
    };
  }

  private readLedgerFromSqlite(): ProductLedgerSummary[] | null {
    if (!existsSync(this.commerceDbPath)) return null;
    let extDb: DatabaseSync | null = null;
    try {
      extDb = new DatabaseSync(this.commerceDbPath, { readOnly: true });
      if (!hasTable(extDb, "commerce_orders")) return [];

      const orders = extDb.prepare("SELECT * FROM commerce_orders").all() as Array<
        Record<string, unknown>
      >;
      const refunds = hasTable(extDb, "commerce_refunds")
        ? (extDb.prepare("SELECT * FROM commerce_refunds").all() as Array<Record<string, unknown>>)
        : [];
      const costs = hasTable(extDb, "commerce_costs")
        ? (extDb.prepare("SELECT * FROM commerce_costs").all() as Array<Record<string, unknown>>)
        : [];
      const licenses = hasTable(extDb, "commerce_licenses")
        ? (extDb.prepare("SELECT * FROM commerce_licenses").all() as Array<Record<string, unknown>>)
        : [];

      const productNames = new Set<string>();
      for (const row of [...orders, ...refunds, ...costs, ...licenses]) {
        const prod = String(row.product ?? "").trim();
        if (prod && !isSandboxProduct(prod)) productNames.add(prod);
      }

      const nowIso = new Date(this.nowFn()).toISOString();
      const summaries: ProductLedgerSummary[] = [];

      for (const product of [...productNames].sort()) {
        const pOrders = orders.filter((o) => String(o.product) === product);
        const pRefunds = refunds.filter((r) => String(r.product) === product);
        const pCosts = costs.filter((c) => String(c.product) === product);
        const pActiveLicenses = licenses.filter(
          (l) =>
            String(l.product) === product &&
            Number(l.revoked ?? 0) === 0 &&
            (!l.expires_at || String(l.expires_at) > nowIso),
        ).length;

        const byCur = new Map<
          string,
          { grossMinor: number; refundMinor: number; costMinor: number }
        >();
        const touch = (c: string) => {
          const cur = (c || "USD").toUpperCase();
          let entry = byCur.get(cur);
          if (!entry) {
            entry = { grossMinor: 0, refundMinor: 0, costMinor: 0 };
            byCur.set(cur, entry);
          }
          return entry;
        };

        for (const o of pOrders) {
          touch(String(o.currency ?? "USD")).grossMinor += Number(o.gross_minor ?? 0);
        }
        for (const r of pRefunds) {
          touch(String(r.currency ?? "USD")).refundMinor += Number(r.amount_minor ?? 0);
        }
        for (const c of pCosts) {
          touch(String(c.currency ?? "USD")).costMinor += Number(c.amount_minor ?? 0);
        }

        let grossUsd = 0;
        let refundsUsd = 0;
        let commerceCostUsd = 0;
        const currencies: ProductLedgerSummary["currencies"] = [];

        for (const [currency, v] of byCur.entries()) {
          const netMinor = v.grossMinor - v.refundMinor - v.costMinor;
          currencies.push({
            currency,
            grossMinor: v.grossMinor,
            refundMinor: v.refundMinor,
            costMinor: v.costMinor,
            netMinor,
          });
          grossUsd += minorToUsd(v.grossMinor, currency);
          refundsUsd += minorToUsd(v.refundMinor, currency);
          commerceCostUsd += minorToUsd(v.costMinor, currency);
        }

        summaries.push({
          product,
          ordersCount: pOrders.length,
          refundCount: pRefunds.length,
          activeLicenses: pActiveLicenses,
          grossUsd: round2(grossUsd),
          refundsUsd: round2(refundsUsd),
          commerceCostUsd: round2(commerceCostUsd),
          netUsd: round2(grossUsd - refundsUsd - commerceCostUsd),
          currencies,
        });
      }

      return summaries;
    } catch {
      return null;
    } finally {
      try {
        extDb?.close();
      } catch {
        // ignore
      }
    }
  }

  private parseHttpSummary(
    product: string,
    raw: Record<string, unknown>,
  ): ProductLedgerSummary {
    const rawCurrencies = Array.isArray(raw.currencies)
      ? (raw.currencies as Array<Record<string, unknown>>)
      : [];
    let grossUsd = 0;
    let refundsUsd = 0;
    let commerceCostUsd = 0;

    const currencies = rawCurrencies.map((c) => {
      const currency = String(c.currency ?? "USD").toUpperCase();
      const grossMinor = Number(c.grossMinor ?? 0);
      const refundMinor = Number(c.refundMinor ?? 0);
      const costMinor = Number(c.costMinor ?? 0);
      const netMinor =
        c.netMinor !== undefined ? Number(c.netMinor) : grossMinor - refundMinor - costMinor;

      grossUsd += minorToUsd(grossMinor, currency);
      refundsUsd += minorToUsd(refundMinor, currency);
      commerceCostUsd += minorToUsd(costMinor, currency);
      return { currency, grossMinor, refundMinor, costMinor, netMinor };
    });

    return {
      product,
      ordersCount: Number(raw.orderCount ?? 0),
      refundCount: Number(raw.refundCount ?? 0),
      activeLicenses: Number(raw.activeLicenses ?? 0),
      grossUsd: round2(grossUsd),
      refundsUsd: round2(refundsUsd),
      commerceCostUsd: round2(commerceCostUsd),
      netUsd: round2(grossUsd - refundsUsd - commerceCostUsd),
      currencies,
    };
  }

  async getUnifiedLedgerSnapshot(): Promise<UnifiedLedgerSnapshot> {
    const nowMs = this.nowFn();
    const origins = this.resolveOrigins();
    const internal = this.collectInternalCosts(nowMs);

    let companionOnline = false;
    let source: UnifiedLedgerSnapshot["source"] = "internal_only";
    let products: ProductLedgerSummary[] = [];

    const summaryBase = `${origins.commerce.replace(/\/+$/, "")}/api/v1/summary`;
    const topRes = await this.fetchJsonSafe<Record<string, unknown>>(summaryBase);

    if (topRes.ok) {
      companionOnline = true;
      source = "companion_http";
      const listedProducts = Array.isArray(topRes.data.products)
        ? (topRes.data.products as unknown[])
            .map((p) => String(p))
            .filter((p) => p && !isSandboxProduct(p))
        : [];

      if (listedProducts.length > 0) {
        const fetched = await Promise.all(
          listedProducts.map(async (prod) => {
            const sub = await this.fetchJsonSafe<Record<string, unknown>>(
              `${summaryBase}?product=${encodeURIComponent(prod)}`,
            );
            return sub.ok ? this.parseHttpSummary(prod, sub.data) : null;
          }),
        );
        products = fetched.filter((item): item is ProductLedgerSummary => item !== null);
      } else if (
        Number(topRes.data.orderCount ?? 0) > 0 ||
        (Array.isArray(topRes.data.currencies) && topRes.data.currencies.length > 0)
      ) {
        // Single-product or mock summary without explicit products[] list
        const fallbackName = String(topRes.data.product || this.defaultProductName());
        if (!isSandboxProduct(fallbackName)) {
          products = [this.parseHttpSummary(fallbackName, topRes.data)];
        }
      }
    } else {
      const sqliteProducts = this.readLedgerFromSqlite();
      if (sqliteProducts !== null) {
        source = "companion_sqlite";
        products = sqliteProducts;
      }
    }

    const grossRevenueUsd = round2(products.reduce((s, p) => s + p.grossUsd, 0));
    const refundsUsd = round2(products.reduce((s, p) => s + p.refundsUsd, 0));
    const commerceCostUsd = round2(products.reduce((s, p) => s + p.commerceCostUsd, 0));
    const effectiveAiCostUsd =
      source === "internal_only" ? internal.internalAiMonthlyUsd : internal.unsyncedAiMonthlyUsd;
    const effectiveFactoryCostUsd =
      source === "internal_only"
        ? internal.factoryTokenCostUsd
        : internal.unsyncedFactoryTokenCostUsd;
    const netUsd = round2(
      grossRevenueUsd -
        refundsUsd -
        commerceCostUsd -
        effectiveAiCostUsd -
        effectiveFactoryCostUsd,
    );

    return {
      companionOnline,
      source,
      products,
      grossRevenueUsd,
      refundsUsd,
      commerceCostUsd,
      internalAiMonthlyUsd: internal.internalAiMonthlyUsd,
      factoryTokenCostUsd: internal.factoryTokenCostUsd,
      unsyncedAiMonthlyUsd: internal.unsyncedAiMonthlyUsd,
      unsyncedFactoryTokenCostUsd: internal.unsyncedFactoryTokenCostUsd,
      netUsd,
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  async getCustomerCrmSnapshot(): Promise<CustomerCrmSnapshot> {
    const nowMs = this.nowFn();
    const nowIso = new Date(nowMs).toISOString();
    const origins = this.resolveOrigins();

    type AccCustomer = {
      customerId: string;
      emailMasked: string;
      channel: string;
      products: Set<string>;
      paidOrdersCount: number;
      refundedOrdersCount: number;
      totalPaidMinor: number;
      currency: string;
      activeLicenses: number;
      openTickets: number;
      activated: boolean;
      inWaitlist: boolean;
    };

    const map = new Map<string, AccCustomer>();
    const getOrCreate = (rawId: unknown, product?: unknown): AccCustomer | null => {
      const customerId = String(rawId ?? "").trim();
      if (!customerId) return null;
      const prodStr = String(product ?? "").trim();
      if (prodStr && isSandboxProduct(prodStr)) return null;

      let entry = map.get(customerId);
      if (!entry) {
        entry = {
          customerId,
          emailMasked: customerId.includes("@") ? maskEmail(customerId) : "",
          channel: "direct",
          products: new Set<string>(),
          paidOrdersCount: 0,
          refundedOrdersCount: 0,
          totalPaidMinor: 0,
          currency: "USD",
          activeLicenses: 0,
          openTickets: 0,
          activated: false,
          inWaitlist: false,
        };
        map.set(customerId, entry);
      }
      if (prodStr) entry.products.add(prodStr);
      return entry;
    };

    const companionSources: CustomerCrmSnapshot["companionSources"] = {
      commerce: "offline",
      gtm: "offline",
      ops: "offline",
    };

    // ---- 1. Commerce (orders + licenses) ----
    const ordersHttp = await this.fetchJsonSafe<{ orders?: Array<Record<string, unknown>> }>(
      `${origins.commerce.replace(/\/+$/, "")}/api/v1/orders`,
    );
    const licensesHttp = await this.fetchJsonSafe<{ licenses?: Array<Record<string, unknown>> }>(
      `${origins.commerce.replace(/\/+$/, "")}/api/v1/licenses`,
    );

    if (ordersHttp.ok || licensesHttp.ok) {
      companionSources.commerce = "http";
      for (const o of ordersHttp.ok ? (ordersHttp.data.orders ?? []) : []) {
        const entry = getOrCreate(o.customerId ?? o.customer_id, o.product);
        if (!entry) continue;
        if (String(o.status ?? "paid") === "refunded") {
          entry.refundedOrdersCount += 1;
        } else {
          entry.paidOrdersCount += 1;
          entry.totalPaidMinor += Number(o.grossMinor ?? o.gross_minor ?? 0);
          entry.currency = String(o.currency ?? entry.currency).toUpperCase();
        }
      }
      for (const l of licensesHttp.ok ? (licensesHttp.data.licenses ?? []) : []) {
        const entry = getOrCreate(l.customerId ?? l.customer_id, l.product);
        if (!entry) continue;
        const revoked = Number(l.revoked ?? 0) !== 0;
        const expiresAt = l.expiresAt ?? l.expires_at;
        const expired = typeof expiresAt === "string" && expiresAt.length > 0 && expiresAt <= nowIso;
        if (!revoked && !expired) {
          entry.activeLicenses += 1;
        }
      }
    } else if (existsSync(this.commerceDbPath)) {
      let extDb: DatabaseSync | null = null;
      try {
        extDb = new DatabaseSync(this.commerceDbPath, { readOnly: true });
        companionSources.commerce = "sqlite";
        if (hasTable(extDb, "commerce_orders")) {
          const rows = extDb.prepare("SELECT * FROM commerce_orders").all() as Array<
            Record<string, unknown>
          >;
          for (const o of rows) {
            const entry = getOrCreate(o.customer_id, o.product);
            if (!entry) continue;
            if (String(o.status ?? "paid") === "refunded") {
              entry.refundedOrdersCount += 1;
            } else {
              entry.paidOrdersCount += 1;
              entry.totalPaidMinor += Number(o.gross_minor ?? 0);
              entry.currency = String(o.currency ?? entry.currency).toUpperCase();
            }
          }
        }
        if (hasTable(extDb, "commerce_licenses")) {
          const rows = extDb.prepare("SELECT * FROM commerce_licenses").all() as Array<
            Record<string, unknown>
          >;
          for (const l of rows) {
            const entry = getOrCreate(l.customer_id, l.product);
            if (!entry) continue;
            const revoked = Number(l.revoked ?? 0) !== 0;
            const expired =
              typeof l.expires_at === "string" && l.expires_at.length > 0 && l.expires_at <= nowIso;
            if (!revoked && !expired) {
              entry.activeLicenses += 1;
            }
          }
        }
      } catch {
        companionSources.commerce = "offline";
      } finally {
        try {
          extDb?.close();
        } catch {
          // ignore
        }
      }
    }

    // ---- 2. GTM (acquisitions + waitlist) ----
    const gtmWaitlistHttp = await this.fetchJsonSafe<{
      subscribers?: Array<Record<string, unknown>>;
      waitlist?: Array<Record<string, unknown>>;
    }>(`${origins.gtm.replace(/\/+$/, "")}/api/v1/waitlist`);
    const gtmTracesHttp = await this.fetchJsonSafe<{
      traces?: Array<Record<string, unknown>>;
      records?: Array<Record<string, unknown>>;
      acquisitions?: Array<Record<string, unknown>>;
    }>(`${origins.gtm.replace(/\/+$/, "")}/api/v1/export/traces`);

    if (gtmWaitlistHttp.ok || gtmTracesHttp.ok) {
      companionSources.gtm = "http";
      const subs = gtmWaitlistHttp.ok
        ? (gtmWaitlistHttp.data.subscribers ?? gtmWaitlistHttp.data.waitlist ?? [])
        : [];
      for (const w of subs) {
        const entry = getOrCreate(w.customerId ?? w.customer_id, w.product);
        if (!entry) continue;
        entry.inWaitlist = true;
        const masked = String(w.emailMasked ?? w.email_masked ?? "").trim();
        if (masked) entry.emailMasked = masked;
        const ch = String(w.channel ?? "").trim();
        if (ch && entry.channel === "direct") entry.channel = ch;
      }

      const traces = gtmTracesHttp.ok
        ? (gtmTracesHttp.data.traces ??
            gtmTracesHttp.data.records ??
            gtmTracesHttp.data.acquisitions ??
            [])
        : [];
      for (const tr of traces) {
        let props: Record<string, unknown> = {};
        if (typeof tr.properties === "string") {
          try {
            props = JSON.parse(tr.properties) as Record<string, unknown>;
          } catch {
            props = {};
          }
        }
        const prod = tr.product ?? tr.service_name ?? props.product;
        const entry = getOrCreate(tr.customerId ?? tr.customer_id ?? tr.user_id, prod);
        if (!entry) continue;
        const ch = String(tr.channel ?? props.channel ?? "").trim();
        if (ch && entry.channel === "direct") entry.channel = ch;
      }
    } else if (existsSync(this.gtmDbPath)) {
      let extDb: DatabaseSync | null = null;
      try {
        extDb = new DatabaseSync(this.gtmDbPath, { readOnly: true });
        companionSources.gtm = "sqlite";
        if (hasTable(extDb, "gtm_acquisitions")) {
          const rows = extDb.prepare("SELECT * FROM gtm_acquisitions").all() as Array<
            Record<string, unknown>
          >;
          for (const a of rows) {
            const entry = getOrCreate(a.customer_id, a.product);
            if (!entry) continue;
            const ch = String(a.channel ?? "").trim();
            if (ch && entry.channel === "direct") entry.channel = ch;
          }
        }
        if (hasTable(extDb, "gtm_waitlist")) {
          const rows = extDb.prepare("SELECT * FROM gtm_waitlist").all() as Array<
            Record<string, unknown>
          >;
          for (const w of rows) {
            const entry = getOrCreate(w.customer_id, w.product);
            if (!entry) continue;
            entry.inWaitlist = true;
            const masked = String(w.email_masked ?? "").trim();
            if (masked) entry.emailMasked = masked;
            const ch = String(w.channel ?? "").trim();
            if (ch && entry.channel === "direct") entry.channel = ch;
          }
        }
      } catch {
        companionSources.gtm = "offline";
      } finally {
        try {
          extDb?.close();
        } catch {
          // ignore
        }
      }
    }

    // ---- 3. Ops (tickets + activation telemetry) ----
    const opsTicketsHttp = await this.fetchJsonSafe<{ tickets?: Array<Record<string, unknown>> }>(
      `${origins.ops.replace(/\/+$/, "")}/api/v1/tickets`,
    );
    const opsTracesHttp = await this.fetchJsonSafe<{
      records?: Array<Record<string, unknown>>;
      events?: Array<Record<string, unknown>>;
    }>(`${origins.ops.replace(/\/+$/, "")}/api/v1/export/traces?includeCrashes=false`);

    if (opsTicketsHttp.ok || opsTracesHttp.ok) {
      companionSources.ops = "http";
      for (const t of opsTicketsHttp.ok ? (opsTicketsHttp.data.tickets ?? []) : []) {
        const entry = getOrCreate(t.customerId ?? t.customer_id, t.product);
        if (!entry) continue;
        if (String(t.status ?? "open") !== "resolved") {
          entry.openTickets += 1;
        }
      }
      const evList = opsTracesHttp.ok
        ? (opsTracesHttp.data.records ?? opsTracesHttp.data.events ?? [])
        : [];
      for (const ev of evList) {
        let props: Record<string, unknown> = {};
        if (typeof ev.properties === "string") {
          try {
            props = JSON.parse(ev.properties) as Record<string, unknown>;
          } catch {
            props = {};
          }
        }
        const prod = ev.product ?? ev.service_name ?? props.product;
        const entry = getOrCreate(ev.customerId ?? ev.customer_id ?? ev.user_id, prod);
        if (!entry) continue;
        const isActivation =
          Boolean(ev.isActivation ?? ev.is_activation ?? props.isActivation) ||
          String(ev.event_name ?? ev.eventName ?? "") === "activated" ||
          String(ev.event_name ?? ev.eventName ?? "") === "first_meaningful_action";
        if (isActivation) entry.activated = true;
      }
    } else if (existsSync(this.opsDbPath)) {
      let extDb: DatabaseSync | null = null;
      try {
        extDb = new DatabaseSync(this.opsDbPath, { readOnly: true });
        companionSources.ops = "sqlite";
        if (hasTable(extDb, "ops_tickets")) {
          const rows = extDb.prepare("SELECT * FROM ops_tickets").all() as Array<
            Record<string, unknown>
          >;
          for (const t of rows) {
            const entry = getOrCreate(t.customer_id, t.product);
            if (!entry) continue;
            if (String(t.status ?? "open") !== "resolved") {
              entry.openTickets += 1;
            }
          }
        }
        if (hasTable(extDb, "ops_telemetry_events")) {
          const rows = extDb.prepare("SELECT * FROM ops_telemetry_events").all() as Array<
            Record<string, unknown>
          >;
          for (const ev of rows) {
            const entry = getOrCreate(ev.customer_id, ev.product);
            if (!entry) continue;
            if (Number(ev.is_activation ?? 0) !== 0) {
              entry.activated = true;
            }
          }
        }
      } catch {
        companionSources.ops = "offline";
      } finally {
        try {
          extDb?.close();
        } catch {
          // ignore
        }
      }
    }

    const byStage: Record<CustomerLifecycleStage, number> = {
      waitlist: 0,
      activated: 0,
      paying: 0,
      repeat: 0,
      at_risk: 0,
    };

    const customers: CustomerCrmProfile[] = [...map.values()].map((c) => {
      const refundedAll = c.refundedOrdersCount > 0 && c.paidOrdersCount === 0;
      let stage: CustomerLifecycleStage;
      if ((c.paidOrdersCount > 0 && c.openTickets > 0) || refundedAll || c.openTickets >= 2) {
        stage = "at_risk";
      } else if (c.paidOrdersCount >= 2) {
        stage = "repeat";
      } else if (c.paidOrdersCount === 1 || c.activeLicenses > 0) {
        stage = "paying";
      } else if (c.activated) {
        stage = "activated";
      } else {
        stage = "waitlist";
      }
      byStage[stage] += 1;

      return {
        customerId: c.customerId,
        emailMasked: c.emailMasked,
        channel: c.channel,
        products: [...c.products].sort(),
        ordersCount: c.paidOrdersCount,
        totalPaidMinor: c.totalPaidMinor,
        currency: c.currency,
        activeLicenses: c.activeLicenses,
        openTickets: c.openTickets,
        activated: c.activated,
        stage,
      };
    });

    customers.sort(
      (a, b) => b.totalPaidMinor - a.totalPaidMinor || a.customerId.localeCompare(b.customerId),
    );

    return {
      companionSources,
      totalCustomers: customers.length,
      byStage,
      customers,
      generatedAt: nowIso,
    };
  }

  async runSandboxVerification(overrides: Record<string, unknown> = {}) {
    if (!this.commercialHub) {
      throw new ApiError(503, "commercial_hub_unmounted", "CommercialHubService 未挂载");
    }
    return this.commercialHub.runClosedLoopVerification({
      ...overrides,
      sandbox: true,
    });
  }

  lastSandboxReceipt(): Record<string, unknown> | null {
    if (this.commercialHub?.lastSandboxReceipt) {
      return this.commercialHub.lastSandboxReceipt();
    }
    const row = this.db
      .prepare("SELECT value FROM opc_governance_kv WHERE key='closed_loop_sandbox_receipt'")
      .get() as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(String(row.value)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async bridgeOverview() {
    const [ledger, crm, companion] = await Promise.all([
      this.getUnifiedLedgerSnapshot(),
      this.getCustomerCrmSnapshot(),
      this.commercialHub
        ? this.commercialHub.checkServices()
        : Promise.resolve({ services: [] as CompanionServiceStatus[] }),
    ]);

    const syncedCountRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM opc_commercial_synced_costs")
      .get() as { n?: number } | undefined;

    return {
      ledger,
      crm,
      crmSummary: {
        totalCustomers: crm.totalCustomers,
        byStage: crm.byStage,
        companionSources: crm.companionSources,
        recentCustomers: crm.customers.slice(0, 15),
      },
      companionServices: companion.services,
      lastSandboxCheck: this.lastSandboxReceipt(),
      syncedCostsCount: Number(syncedCountRow?.n ?? 0),
    };
  }

  async health(): Promise<DepartmentHealth> {
    const ledger = await this.getUnifiedLedgerSnapshot();
    const stoppedRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM opc_kill_switches WHERE status = 'stopped'")
      .get() as { n?: number } | undefined;
    const stoppedProjects = Number(stoppedRow?.n ?? 0);

    return {
      healthy: true,
      summary: ledger.companionOnline
        ? `总账在线 · 净收益 $${ledger.netUsd} · 已纳管 ${ledger.products.length} 款产品`
        : `待机模式（外部三件套未启动，使用内部算力账本 · AI月费 $${ledger.internalAiMonthlyUsd}）`,
      metrics: {
        companionOnline: ledger.companionOnline,
        ledgerSource: ledger.source,
        productsCount: ledger.products.length,
        netUsd: ledger.netUsd,
        internalAiMonthlyUsd: ledger.internalAiMonthlyUsd,
        factoryTokenCostUsd: ledger.factoryTokenCostUsd,
        stoppedProjects,
      },
    };
  }

  registerRoutes(app: Hono, requireUser: (c: Context) => { id: string; name: string }) {
    const base = "/api/opc/domains/commercial";

    app.use(`${base}/*`, async (c, next) => {
      c.header("Cache-Control", "no-store");
      requireUser(c);
      await next();
    });

    app.get(`${base}/bridge`, async (c) => {
      return c.json(await this.bridgeOverview());
    });

    app.get(`${base}/customers`, async (c) => {
      return c.json(await this.getCustomerCrmSnapshot());
    });

    app.post(`${base}/sync-costs`, async (c) => {
      return c.json(await this.syncInternalCostsToCommerce());
    });

    app.post(`${base}/sandbox-verify`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      return c.json(await this.runSandboxVerification(body));
    });
  }
}
