import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CompanyDepartmentId, DomainEventRecord, DomainEventTopic } from "./types.ts";

export type EventSubscriber<TPayload = Record<string, unknown>> = (
  event: DomainEventRecord<TPayload>,
) => void | Promise<void>;

export class DomainEventBus {
  private db: DatabaseSync;
  private subscribers = new Map<string, Set<EventSubscriber<any>>>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_domain_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        source_domain TEXT NOT NULL,
        mainline_id TEXT,
        product_id TEXT,
        asset_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_domain_events_topic ON opc_domain_events(topic, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_opc_domain_events_domain ON opc_domain_events(source_domain, seq DESC);

      CREATE TABLE IF NOT EXISTS opc_domain_event_errors (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        error_message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  subscribe<TPayload = Record<string, unknown>>(
    topic: DomainEventTopic | "*" | (string & {}),
    handler: EventSubscriber<TPayload>,
  ): () => void {
    const set = this.subscribers.get(topic) ?? new Set();
    set.add(handler);
    this.subscribers.set(topic, set);
    return () => {
      set.delete(handler);
    };
  }

  emit<TPayload extends Record<string, unknown> = Record<string, unknown>>(input: {
    topic: DomainEventTopic | (string & {});
    sourceDomain: CompanyDepartmentId;
    mainlineId?: string | null;
    productId?: string | null;
    assetId?: string | null;
    payload: TPayload;
  }): DomainEventRecord<TPayload> {
    const id = `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const createdAt = new Date().toISOString();
    const payloadJson = JSON.stringify(input.payload ?? {});
    const info = this.db
      .prepare(
        `INSERT INTO opc_domain_events (id, topic, source_domain, mainline_id, product_id, asset_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.topic,
        input.sourceDomain,
        input.mainlineId ?? null,
        input.productId ?? null,
        input.assetId ?? null,
        payloadJson,
        createdAt,
      );

    const record: DomainEventRecord<TPayload> = {
      seq: Number(info.lastInsertRowid),
      id,
      topic: input.topic,
      sourceDomain: input.sourceDomain,
      mainlineId: input.mainlineId ?? null,
      productId: input.productId ?? null,
      assetId: input.assetId ?? null,
      payload: input.payload,
      createdAt,
    };

    const specific = this.subscribers.get(input.topic);
    const wildcard = this.subscribers.get("*");
    const targets = [...(specific ?? []), ...(wildcard ?? [])];
    for (const fn of targets) {
      try {
        const res = fn(record);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((err) => this.recordError(id, input.topic, err));
        }
      } catch (err) {
        this.recordError(id, input.topic, err);
      }
    }
    return record;
  }

  private recordError(eventId: string, topic: string, err: unknown) {
    try {
      this.db
        .prepare(
          `INSERT INTO opc_domain_event_errors (id, event_id, topic, error_message, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          eventId,
          topic,
          err instanceof Error ? err.message : String(err),
          new Date().toISOString(),
        );
    } catch {
      // ignore logging error
    }
  }

  list(filter: {
    topic?: string;
    sourceDomain?: CompanyDepartmentId;
    assetId?: string;
    afterSeq?: number;
    limit?: number;
  } = {}): DomainEventRecord[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter.topic) {
      clauses.push("topic = ?");
      args.push(filter.topic);
    }
    if (filter.sourceDomain) {
      clauses.push("source_domain = ?");
      args.push(filter.sourceDomain);
    }
    if (filter.assetId) {
      clauses.push("asset_id = ?");
      args.push(filter.assetId);
    }
    if (typeof filter.afterSeq === "number" && Number.isFinite(filter.afterSeq)) {
      clauses.push("seq > ?");
      args.push(filter.afterSeq);
    }
    const rawLimit = typeof filter.limit === "number" && Number.isFinite(filter.limit) ? Math.floor(filter.limit) : 50;
    const limit = Math.max(1, Math.min(200, rawLimit));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM opc_domain_events ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...args, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      seq: Number(row.seq),
      id: String(row.id),
      topic: String(row.topic),
      sourceDomain: String(row.source_domain) as CompanyDepartmentId,
      mainlineId: row.mainline_id ? String(row.mainline_id) : null,
      productId: row.product_id ? String(row.product_id) : null,
      assetId: row.asset_id ? String(row.asset_id) : null,
      payload: safeJson(String(row.payload_json), {}),
      createdAt: String(row.created_at),
    }));
  }

  totalCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM opc_domain_events").get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
