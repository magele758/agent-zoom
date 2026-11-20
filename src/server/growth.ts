import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { GrowthCounts, GrowthCustomer, GrowthEvent, GrowthExcluded, GrowthReport } from "../growth-types.ts";
import { ApiError } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";

const id = z.string().trim().min(1).max(512);
const productName = z.string().trim().min(1).max(160);
const common = {
  product: productName,
  customerId: id,
  eventId: id,
  at: z.iso.datetime({ offset: true }).max(80),
  reference: z.string().trim().min(1).max(2000),
};
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("acquired"), channel: z.string().trim().min(1).max(160) }),
  z.strictObject({ ...common, kind: z.literal("activated") }),
  z.strictObject({ ...common, kind: z.literal("order"), orderId: id }),
]);

// Normalize equivalent offsets for replay. Preserve source precision beyond JS milliseconds.
function instant(source: string) {
  const value = new Date(source);
  if (!Number.isFinite(value.getTime())) throw new ApiError(400, "growth_input", "发生时间需要有效的 ISO 日期和时区");
  const subMilliseconds = (source.match(/\.(\d+)/)?.[1] ?? "").slice(3).replace(/0+$/, "");
  return value.toISOString().slice(0, -1) + subMilliseconds + "Z";
}

type EventRow = {
  product: string;
  eventId: string;
  customerId: string;
  at: string;
  reference: string;
  kind: GrowthEvent["kind"];
  channel: string | null;
  orderId: string | null;
};
const fields = "product,event_id AS eventId,customer_id AS customerId,kind,at,reference,channel,order_id AS orderId";
function eventView(row: EventRow): GrowthEvent {
  const event = {
    product: row.product,
    eventId: row.eventId,
    customerId: row.customerId,
    at: row.at,
    reference: row.reference,
  };
  switch (row.kind) {
    case "acquired":
      return { ...event, kind: row.kind, channel: row.channel! };
    case "activated":
      return { ...event, kind: row.kind };
    case "order":
      return { ...event, kind: row.kind, orderId: row.orderId! };
  }
}

const emptyCounts = (): GrowthCounts => ({ acquired: 0, activated: 0, firstOrder: 0, repeatOrder: 0 });

export class GrowthLedger {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS growth_events (
      product TEXT NOT NULL, event_id TEXT NOT NULL, customer_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('acquired','activated','order')),
      at TEXT NOT NULL, reference TEXT NOT NULL, channel TEXT, order_id TEXT,
      CHECK((kind='acquired') = (channel IS NOT NULL)),
      CHECK((kind='order') = (order_id IS NOT NULL)),
      PRIMARY KEY(product,event_id), UNIQUE(product,order_id)
    )`);
  }

  record(input: unknown) {
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success)
      throw new ApiError(
        400,
        "growth_input",
        parsed.error.issues.map(issue => issue.path.join(".") + " " + issue.message).join(" / ")
      );
    const event = { ...parsed.data, at: instant(parsed.data.at) };
    const channel = event.kind === "acquired" ? event.channel : null;
    const orderId = event.kind === "order" ? event.orderId : null;
    const inserted = this.db
      .prepare(
        `INSERT INTO growth_events(product,event_id,customer_id,kind,at,reference,channel,order_id)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`
      )
      .run(event.product, event.eventId, event.customerId, event.kind, event.at, event.reference, channel, orderId);
    if (inserted.changes) return { event, created: true };
    const existing = this.db
      .prepare(`SELECT ${fields} FROM growth_events WHERE product=? AND event_id=?`)
      .get(event.product, event.eventId) as EventRow | undefined;
    if (!existing) throw new ApiError(409, "growth_order_conflict", "该产品的订单号已由另一事件登记，请沿用原事件 ID");
    if (
      existing.customerId !== event.customerId ||
      existing.kind !== event.kind ||
      existing.at !== event.at ||
      existing.reference !== event.reference ||
      existing.channel !== channel ||
      existing.orderId !== orderId
    ) {
      throw new ApiError(409, "growth_event_conflict", "同一产品的事件 ID 已登记不同内容");
    }
    return { event: eventView(existing), created: false };
  }

  report(requested?: string): GrowthReport {
    const products = this.db
      .prepare("SELECT DISTINCT product FROM growth_events ORDER BY product")
      .all()
      .map(row => String(row.product));
    const product = requested === undefined ? (products[0] ?? null) : productName.safeParse(requested).data;
    if (product === undefined) throw new ApiError(400, "growth_input", "请提供有效的产品名");
    const total = emptyCounts();
    if (product === null) return { products, product, total, channels: [], customers: [], excluded: [], eventCount: 0 };
    // Remove the trailing Z before sorting, because fractional seconds can have different precision.
    // Simultaneous events follow funnel order. Within a stage the source event ID breaks ties.
    const rows = this.db
      .prepare(
        `SELECT ${fields} FROM growth_events WHERE product=?
      ORDER BY customer_id,substr(at,1,length(at)-1),
        CASE kind WHEN 'acquired' THEN 0 WHEN 'activated' THEN 1 ELSE 2 END,event_id`
      )
      .all(product) as EventRow[];
    const customers = new Map<string, GrowthCustomer>();
    const channelCounts = new Map<string, GrowthCounts>();
    const unmatched: GrowthEvent[] = [];
    for (const row of rows) {
      const event = eventView(row);
      const customer = customers.get(event.customerId);
      if (event.kind === "acquired") {
        if (!customer)
          customers.set(event.customerId, { customerId: event.customerId, channel: event.channel, acquired: event });
      } else if (!customer) {
        unmatched.push(event);
      } else if (event.kind === "activated") {
        customer.activated ??= event;
      } else if (!customer.activated) {
        unmatched.push(event);
      } else if (!customer.firstOrder) {
        customer.firstOrder = event;
      } else {
        customer.repeatOrder ??= event;
      }
    }
    const excluded: GrowthExcluded[] = unmatched.map(event => {
      const customer = customers.get(event.customerId);
      if (!customer) return { event, reason: "missing_acquisition" };
      if (event.kind === "activated") return { event, reason: "activation_before_acquisition" };
      return { event, reason: customer.activated ? "order_before_activation" : "missing_activation" };
    });
    for (const customer of customers.values()) {
      const counts = channelCounts.get(customer.channel) ?? emptyCounts();
      channelCounts.set(customer.channel, counts);
      for (const stage of ["acquired", "activated", "firstOrder", "repeatOrder"] as const) {
        if (customer[stage]) {
          counts[stage]++;
          total[stage]++;
        }
      }
    }
    const channels = Array.from(channelCounts, ([channel, counts]) => ({ channel, ...counts })).sort(
      (a, b) => b.acquired - a.acquired || a.channel.localeCompare(b.channel, "zh-CN")
    );
    return {
      products,
      product,
      total,
      channels,
      customers: [...customers.values()],
      excluded,
      eventCount: rows.length,
    };
  }
}

export function addGrowthRoutes(app: Hono, db: DatabaseSync, token: string | undefined, user: (c: Context) => unknown) {
  const ledger = new GrowthLedger(db);
  const { permits, requireSubmit } = submitAuth(token);
  app.post("/api/zoom/growth/events", async c => {
    requireSubmit(c);
    return c.json(ledger.record(await c.req.json()));
  });
  app.get("/api/zoom/growth", c => {
    if (!permits(c)) user(c);
    const report = ledger.report(c.req.query("product"));
    return c.json(process.env.KUNLUN_PREVIEW === "1" ? { ...report, preview: true } : report);
  });
}
