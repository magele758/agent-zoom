import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  currentReading,
  type CollectionReceipt,
  type HubDiagnostic,
  type HubToolUsage,
  type ManualPlan,
  type ResourceDepartmentIndex,
} from "../resource-department-types.ts";
import { ApiError } from "./logic.ts";

const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const amount = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const planInput = z.strictObject({
  revision: z.int().nonnegative(),
  name: z.string().trim().min(1).max(120),
  window: z.string().trim().max(100),
  unit: z.string().trim().min(1).max(32),
  capacity: amount,
  reportedRemaining: amount,
  resetsAt: instant.nullable(),
  renewsOn: z.iso.date().nullable(),
  observedAt: instant.nullable(),
  fee: amount.optional().default(null),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable().optional().default(null),
  billingCycle: z.enum(["monthly", "yearly"]).nullable().optional().default(null),
});

const hubWindow = z.object({
  name: z.string(),
  remaining_pct: z.number().min(0).max(100).nullish(),
  resets_at: z.number().nullish(),
});
const hubCreditFields = z.object({
  credits_balance: z.unknown().optional(),
  reset_credits_available: z.unknown().optional(),
}).nullish().catch(null);
const hubSnapshot = z.object({
  generated_at: z.number(),
  tools: z.array(z.object({
    tool: z.string(), name: z.string(), plan: z.string().nullish(), status: z.string(),
    reason: z.string().nullish(),
    snapshot_at: z.number().nullish(), live: z.boolean().optional(), windows: z.array(hubWindow), extra: hubCreditFields,
  })),
});
const feeList = z.array(z.object({
  tool: z.string(), plan: z.string(), monthly_usd: z.number().nonnegative().nullish(),
  paid: z.boolean().optional(), checked: z.iso.date().nullish(), since: z.iso.date().nullish(),
  until: z.iso.date().nullish(),
}));

function isoTime(seconds: number | null | undefined) {
  const millis = (seconds ?? 0) * 1000;
  return millis > 0 && Number.isFinite(new Date(millis).getTime()) ? new Date(millis).toISOString() : null;
}

function explicitBalances(tool: z.infer<typeof hubSnapshot>["tools"][number]) {
  const balances: ResourceDepartmentIndex["hub"]["tools"][number]["balances"] = [];
  if (tool.tool !== "codex" || tool.status !== "ok" || !tool.extra) return balances;
  const observedAt = isoTime(tool.snapshot_at);
  const raw = tool.extra.credits_balance;
  const credits = typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof credits === "number" && credits >= 0 && credits <= Number.MAX_SAFE_INTEGER) {
    balances.push({ name: "积分余额", unit: "credits", reportedRemaining: credits, observedAt, resetsAt: null });
  }
  const resets = tool.extra.reset_credits_available;
  if (typeof resets === "number" && Number.isSafeInteger(resets) && resets >= 0) {
    balances.push({ name: "可用免费重置", unit: "次", reportedRemaining: resets, observedAt, resetsAt: null });
  }
  return balances;
}

function hubJson(db: DatabaseSync, query: string) {
  try {
    const value = db.prepare(query).get()?.value;
    return typeof value === "string" ? JSON.parse(value) as unknown : null;
  } catch { return null; }
}

function classifyDiagnostic(status: string, reason: string | null | undefined): HubDiagnostic | undefined {
  if (status === "error") {
    if (reason && /\b(?:401|403)\b|unauthorized/i.test(reason)) return "auth_expired";
    return "quota_error";
  }
  if (status === "unavailable" && reason && /language.?server/i.test(reason)) {
    return "local_server_offline";
  }
  return undefined;
}

function advanceMonthlyCycle(resetSec: number, nowMs: number): { startIso: string; resetIso: string } | null {
  const base = new Date(resetSec * 1000);
  if (!Number.isFinite(base.getTime())) return null;
  const next = new Date(base.getTime());
  let guard = 0;
  while (next.getTime() <= nowMs && guard < 48) {
    next.setMonth(next.getMonth() + 1);
    guard++;
  }
  if (next.getTime() <= nowMs) return null;
  const prev = new Date(next.getTime());
  prev.setMonth(prev.getMonth() - 1);
  return { startIso: prev.toISOString(), resetIso: next.toISOString() };
}

const SESSION_AGENTS: Record<string, string[]> = {
  cursor: ["cursor", "cursor-cloud", "cursor-agent"],
  antigravity: ["antigravity", "antigravity-cli"],
  codex: ["codex"],
  "grok-build": ["grok-build"],
  claude: ["claude-code", "claude-desktop"],
};

function hasTable(db: DatabaseSync, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

function readHistoricalWindows(db: DatabaseSync, toolId: string, nowMs: number) {
  if (!hasTable(db, "quota_snapshots")) return null;
  try {
    const rows = db.prepare(`
      SELECT window, snapshot_at, used_pct, resets_at, plan
      FROM quota_snapshots
      WHERE tool = ? AND status = 'ok'
        AND snapshot_at = (SELECT MAX(snapshot_at) FROM quota_snapshots WHERE tool = ? AND status = 'ok')
      ORDER BY rowid
    `).all(toolId, toolId) as Array<{
      window: string;
      snapshot_at: number | null;
      used_pct: number | null;
      resets_at: number | null;
      plan: string | null;
    }>;
    if (!rows.length) return null;
    const plan = typeof rows[0].plan === "string" && rows[0].plan.length <= 48 ? rows[0].plan : null;
    const active = rows.filter(r =>
      typeof r.used_pct === "number" && r.used_pct >= 0 && r.used_pct <= 100 &&
      (r.resets_at == null || r.resets_at * 1000 > nowMs)
    );
    const latestReset = rows.reduce<number | null>((acc, r) =>
      typeof r.resets_at === "number" && r.resets_at > 0 && (acc === null || r.resets_at > acc) ? r.resets_at : acc, null);
    return {
      plan,
      windows: active.map(r => ({
        name: r.window,
        live: false,
        reportedRemaining: Math.round((100 - (r.used_pct as number)) * 100) / 100,
        observedAt: isoTime(r.snapshot_at),
        resetsAt: isoTime(r.resets_at),
      })),
      cycle: active.length === 0 && latestReset ? advanceMonthlyCycle(latestReset, nowMs) : null,
    };
  } catch {
    return null;
  }
}

function readToolUsage(
  db: DatabaseSync,
  toolId: string,
  nowMs: number,
  monthlyUsd: number | null,
  cycle: { startIso: string; resetIso: string } | null,
): HubToolUsage | undefined {
  const hasSessions = hasTable(db, "sessions");
  const hasCostDaily = hasTable(db, "cost_daily");
  const hasPlatform = hasTable(db, "cost_platform_snapshots");
  if (!hasSessions && !hasCostDaily && !hasPlatform) return undefined;

  const sevenDaysAgo = new Date(nowMs - 7 * 86400 * 1000).toISOString().slice(0, 10);
  let sessions7d = 0;
  let tokens7d = 0;
  let calls7d = 0;
  let cycleCalls: number | null = null;
  let lastCycleUsedUsd: number | null = null;

  const agents = SESSION_AGENTS[toolId] ?? [toolId];
  if (hasSessions && agents.length) {
    try {
      const placeholders = agents.map(() => "?").join(",");
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(tokens), 0) AS tok FROM sessions WHERE agent IN (${placeholders}) AND day >= ?`
      ).get(...agents, sevenDaysAgo) as { cnt?: number; tok?: number } | undefined;
      sessions7d = Number(row?.cnt ?? 0);
      tokens7d = Number(row?.tok ?? 0);
    } catch { /* ignore */ }
  }

  if (hasCostDaily) {
    try {
      const row = db.prepare(
        `SELECT COALESCE(SUM(calls), 0) AS calls FROM cost_daily WHERE tool = ? AND day >= ?`
      ).get(toolId, sevenDaysAgo) as { calls?: number } | undefined;
      calls7d = Number(row?.calls ?? 0);
      if (cycle) {
        const cycleDay = cycle.startIso.slice(0, 10);
        const cRow = db.prepare(
          `SELECT COALESCE(SUM(calls), 0) AS calls FROM cost_daily WHERE tool = ? AND day >= ?`
        ).get(toolId, cycleDay) as { calls?: number } | undefined;
        cycleCalls = Number(cRow?.calls ?? 0);
      }
    } catch { /* ignore */ }
  }

  if (hasPlatform) {
    try {
      const pRow = db.prepare(
        `SELECT value_usd FROM cost_platform_snapshots WHERE tool = ? AND metric = 'usage_total' ORDER BY snapshot_at DESC LIMIT 1`
      ).get(toolId) as { value_usd?: number } | undefined;
      if (typeof pRow?.value_usd === "number" && Number.isFinite(pRow.value_usd)) {
        lastCycleUsedUsd = Math.round(pRow.value_usd * 100) / 100;
      }
    } catch { /* ignore */ }
  }

  return {
    sessions7d,
    calls7d,
    tokens7d,
    cycleCalls,
    cycleStartAt: cycle?.startIso ?? null,
    cycleResetAt: cycle?.resetIso ?? null,
    monthlyUsd,
    lastCycleUsedUsd,
  };
}

export function readHubResources(path: string, nowMs = Date.now()): ResourceDepartmentIndex["hub"] {
  const hub: ResourceDepartmentIndex["hub"] = { generatedAt: null, tools: [], fees: [], feesAvailable: false };
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true }); }
  catch { return hub; }
  try {
    const feeMap = new Map<string, { plan: string; monthlyUsd: number | null }>();
    const fees = feeList.safeParse(hubJson(db, "SELECT json_extract(v,'$.plans') AS value FROM meta WHERE k='cost_meta'"));
    if (fees.success) {
      hub.feesAvailable = true;
      hub.fees = fees.data.map(fee => {
        feeMap.set(fee.tool, { plan: fee.plan, monthlyUsd: fee.monthly_usd ?? null });
        return {
          tool: fee.tool, plan: fee.plan, monthlyUsd: fee.monthly_usd ?? null, paid: fee.paid !== false,
          checked: fee.checked ?? null, since: fee.since ?? null, until: fee.until ?? null,
        };
      });
    }
    const quota = hubSnapshot.safeParse(hubJson(db, "SELECT v AS value FROM meta WHERE k='quota_latest'"));
    if (quota.success) {
      hub.generatedAt = isoTime(quota.data.generated_at);
      hub.tools = quota.data.tools.map(tool => {
        const applicable = tool.status !== "not_applicable";
        const directWindows = (tool.status === "ok" || tool.status === "fallback_log" ? tool.windows : []).map(window => ({
          name: window.name, live: tool.live === true, reportedRemaining: window.remaining_pct ?? null,
          resetsAt: isoTime(window.resets_at), observedAt: isoTime(tool.snapshot_at),
        }));
        const fallback = applicable && directWindows.length === 0 ? readHistoricalWindows(db, tool.tool, nowMs) : null;
        const windows = directWindows.length > 0 ? directWindows : (fallback?.windows ?? []);
        const fromHistory = directWindows.length === 0 && windows.length > 0;
        const feeInfo = feeMap.get(tool.tool);
        const plan = tool.plan ?? fallback?.plan ?? (applicable ? feeInfo?.plan ?? null : null);
        const diagnostic = classifyDiagnostic(tool.status, tool.reason);
        const usage = applicable ? readToolUsage(db, tool.tool, nowMs, feeInfo?.monthlyUsd ?? null, fallback?.cycle ?? null) : undefined;
        return {
          tool: tool.tool,
          name: tool.name,
          plan,
          applicable,
          balances: explicitBalances(tool),
          windows,
          ...(fromHistory ? { fromHistory: true } : {}),
          ...(diagnostic ? { diagnostic } : {}),
          ...(usage ? { usage } : {}),
        };
      });
    }
    return hub;
  } finally { db.close(); }
}

const columns = `id, revision, name, window, unit, capacity, reported_remaining AS reportedRemaining,
  resets_at AS resetsAt, renews_on AS renewsOn, observed_at AS observedAt, fee, currency, billing_cycle AS billingCycle`;

export class ResourcePlanStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_resource_plans (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, window TEXT NOT NULL,
      unit TEXT NOT NULL, capacity REAL, reported_remaining REAL, resets_at TEXT, renews_on TEXT, observed_at TEXT,
      fee REAL, currency TEXT, billing_cycle TEXT
    )`);
  }

  list() {
    return this.db.prepare(`SELECT ${columns} FROM opc_resource_plans ORDER BY name,window,id`).all() as ManualPlan[];
  }

  save(id: string, raw: unknown) {
    const parsed = planInput.safeParse(raw);
    if (!z.uuid().safeParse(id).success || !parsed.success)
      throw new ApiError(400, "resource_plan_input", "请核对套餐名称、单位、额度和日期。");
    const { revision, ...plan } = parsed.data;
    const { capacity, reportedRemaining, observedAt, resetsAt, unit } = plan;
    if ((capacity !== null && reportedRemaining !== null && reportedRemaining > capacity) ||
        (unit === "%" && ((capacity !== null && capacity !== 100) || (reportedRemaining ?? 0) > 100)))
      throw new ApiError(400, "resource_plan_capacity", "剩余额度应在总额度以内，百分比的总额度为 100。");
    if (reportedRemaining !== null && (!observedAt || Date.parse(observedAt) > Date.now() + 60000 ||
        (resetsAt && Date.parse(resetsAt) <= Date.parse(observedAt))))
      throw new ApiError(400, "resource_plan_observation", "请填写已核对的时间，本期重置时间应晚于核对时间。");
    if (plan.fee === null ? (plan.currency !== null || plan.billingCycle !== null) : (!plan.currency || !plan.billingCycle))
      throw new ApiError(400, "resource_plan_fee", "请一起填写费用金额、币种和计费周期。");
    const values = [plan.name, plan.window, unit, capacity, reportedRemaining, resetsAt, plan.renewsOn, observedAt,
      plan.fee, plan.currency, plan.billingCycle];
    const saved = revision === 0
      ? this.db.prepare(`INSERT INTO opc_resource_plans
          (id,revision,name,window,unit,capacity,reported_remaining,resets_at,renews_on,observed_at,fee,currency,billing_cycle)
          VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING ${columns}`).get(id, ...values)
      : this.db.prepare(`UPDATE opc_resource_plans SET revision=revision+1, name=?, window=?, unit=?, capacity=?,
          reported_remaining=?, resets_at=?, renews_on=?, observed_at=?, fee=?, currency=?, billing_cycle=? WHERE id=? AND revision=? RETURNING ${columns}`).get(...values, id, revision);
    if (saved) return saved as ManualPlan;
    const existing = this.db.prepare(`SELECT ${columns} FROM opc_resource_plans WHERE id=?`).get(id);
    if (existing?.revision === revision + 1 && Object.entries(plan).every(([key, value]) => existing[key] === value))
      return existing as ManualPlan;
    throw new ApiError(409, "resource_plan_conflict", "这项套餐已发生变化。请刷新后重新核对。");
  }
}

function runHubQuota(executable: string, directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["quota"], {
      cwd: directory, env: { ...process.env, AGENT_HUB_HOME: directory },
      stdio: "ignore", timeout: 150000, killSignal: "SIGKILL",
    });
    const failed = () => reject(new ApiError(502, "resource_collect_failed", "Agent Hub 额度采集未完成，可重读快照或稍后重试。"));
    child.once("error", failed);
    child.once("close", code => code === 0 ? resolve() : failed());
  });
}

export function registerResourceDepartmentRoutes(app: Hono, db: DatabaseSync, user: (c: Context) => unknown,
  directory = join(homedir(), ".agent-hub")) {
  const store = new ResourcePlanStore(db);
  const base = "/api/opc/departments/resources";
  const standardPath = join(directory, "hub.db");
  const path = process.env.OPC_HUB_QUOTA_DB ?? standardPath;
  const collector = join(directory, "bin", "agent-hub");
  const preview = process.env.KUNLUN_PREVIEW === "1" || process.env.DEMO_MODE === "1";
  function canCollect() {
    if (preview || path !== standardPath) return false;
    try {
      accessSync(collector, constants.X_OK);
      accessSync(path, constants.R_OK);
      return statSync(collector).isFile() && statSync(path).isFile();
    } catch { return false; }
  }
  let pending: Promise<CollectionReceipt> | undefined;
  async function collect(): Promise<CollectionReceipt> {
    const previous = readHubResources(path).generatedAt;
    await runHubQuota(collector, directory);
    const hub = readHubResources(path);
    const snapshotUpdated = hub.generatedAt !== null && (previous === null || hub.generatedAt > previous);
    const now = Date.now();
    const recentReadings = hub.tools.flatMap(tool => [...tool.windows, ...tool.balances])
      .filter(reading => currentReading(reading, now, true).state === "observed").length;
    return { hub, snapshotUpdated, recentReadings };
  }
  app.get(base, c => {
    user(c);
    c.header("Cache-Control", "no-store");
    return c.json({ plans: store.list(), hub: readHubResources(path), canCollect: canCollect() } satisfies ResourceDepartmentIndex);
  });
  app.post(`${base}/collect`, async c => {
    user(c);
    c.header("Cache-Control", "no-store");
    if (!canCollect()) throw new ApiError(409, "resource_collect_unavailable", "此来源未接入本机额度采集。");
    if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
        !z.strictObject({}).safeParse(await c.req.json()).success)
      throw new ApiError(400, "resource_collect_input", "额度采集只接受空的 JSON 对象。");
    pending ??= collect().finally(() => { pending = undefined; });
    return c.json(await pending);
  });
  app.put(`${base}/plans/:id`, async c => {
    user(c);
    return c.json(store.save(c.req.param("id"), await c.req.json()));
  });
}
