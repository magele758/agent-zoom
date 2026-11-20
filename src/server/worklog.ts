import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { HubDay, HubItem, WorklogBinding, WorklogIndex } from "../worklog-types.ts";
import { ApiError } from "./logic.ts";
import { parse } from "./workflow/contract.ts";

const daySchema = z.iso.date();
const text = z.string().trim().min(1).max(160);
const target = z.strictObject({ product: text, project: text, lineId: text.nullable() });
const bindSchema = target.extend({
  date: daySchema, key: z.string().regex(/^[a-f0-9]{64}$/), previous: target.nullable().default(null),
});
const unbindSchema = z.strictObject({
  date: daySchema, key: z.string().regex(/^[a-f0-9]{64}$/), previous: target,
});
function resolvedHubOrigin(raw = process.env.OPC_HUB_URL || "http://127.0.0.1:28790") {
  try {
    const url = new URL(raw);
    if (
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
    ) {
      return url.origin;
    }
  } catch { /* fall back to default local hub */ }
  return "http://127.0.0.1:28790";
}
const sourceSchema = z.object({
  generated_by: z.literal("agent-hub"), date: daySchema,
  taskboard: z.object({
    date: daySchema,
    mainlines: z.array(z.object({
      name: z.string(), local_only: z.boolean().optional(),
      tasks: z.record(z.string(), z.unknown()),
    })),
  }).nullable(),
});
const cardSchema = z.object({ key: z.string().min(1), title: z.string().min(1),
  project: z.string().optional(), local_only: z.boolean().optional() });
const states = ["doing", "done", "stuck", "todo"] as const;
const snapshotLimit = 32 * 1024 * 1024;
const invalid = () => new ApiError(422, "hub_format", "这份文件不是所选日期的公开工作日报。");

export async function readHubDay(directory: string, rawDate: unknown): Promise<HubDay> {
  const date = parse(daySchema, rawDate);
  const name = join(directory, date + ".json");
  const file = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new ApiError(404, "hub_day_missing", "这一天还没有生成 Agent Hub 公开日报。");
    throw new ApiError(422, "hub_file", "无法打开这一天的本地公开日报。");
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > snapshotLimit) throw invalid();
    const buffer = Buffer.alloc(stat.size);
    let pos = 0;
    while (pos < buffer.length) {
      const { bytesRead } = await file.read(buffer, pos, buffer.length - pos, pos);
      if (!bytesRead) throw invalid();
      pos += bytesRead;
    }
    let raw: unknown;
    try { raw = JSON.parse(buffer.toString("utf8")); } catch { throw invalid(); }
    const result = sourceSchema.safeParse(raw);
    if (!result.success || result.data.date !== date || (result.data.taskboard && result.data.taskboard.date !== date)) throw invalid();
    if (!result.data.taskboard) throw new ApiError(422, "hub_board_missing", "这份日报没有生成工作看板，可回原看板核对。");
    const records = new Map<string, HubItem>();
    for (const line of result.data.taskboard.mainlines) {
      if (line.local_only) continue;
      for (const state of states) {
        const cards = line.tasks[state];
        if (cards === undefined || cards === null) continue;
        if (!Array.isArray(cards)) throw invalid();
        for (const value of cards) {
          const card = cardSchema.safeParse(value);
          if (!card.success || card.data.local_only) continue;
          const key = createHash("sha256").update(card.data.key).digest("hex");
          if (records.has(key)) throw new ApiError(422, "hub_duplicate", "该日报含重复事项标识，请先在原看板核对。");
          records.set(key, { key, state, title: card.data.title.slice(0, 300), projectHint: (card.data.project ?? "").slice(0, 160), mainline: line.name.slice(0, 160) });
        }
      }
    }
    return { date, records: [...records.values()] };
  } finally { await file.close(); }
}

const columns = "date, source_key AS key, title, mainline, product, project, line_id AS lineId";

export class WorklogStore {
  constructor(private db: DatabaseSync, private directory: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_worklog_bindings (
      date TEXT NOT NULL, source_key TEXT NOT NULL, title TEXT NOT NULL, mainline TEXT NOT NULL,
      product TEXT NOT NULL, project TEXT NOT NULL, line_id TEXT REFERENCES opc_lines(id), PRIMARY KEY(date,source_key),
      FOREIGN KEY(product,project) REFERENCES company_projects(product,name)
    )`);
  }
  index(): WorklogIndex {
    return {
      hubOrigin: resolvedHubOrigin(),
      projects: this.db.prepare("SELECT product,name AS project FROM company_projects ORDER BY product,name").all() as WorklogIndex["projects"],
      lines: this.db.prepare("SELECT id,name FROM opc_lines ORDER BY name").all() as WorklogIndex["lines"],
      bindings: this.db.prepare(`SELECT ${columns} FROM opc_worklog_bindings ORDER BY date DESC,title`).all() as WorklogBinding[],
    };
  }
  day(date: unknown) { return readHubDay(this.directory, date); }

  unbind(raw: unknown) {
    const input = parse(unbindSchema, raw);
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare(`SELECT ${columns} FROM opc_worklog_bindings WHERE date=? AND source_key=?`).get(input.date, input.key) as WorklogBinding | undefined;
      if (!existing) { db.exec("COMMIT"); return { removed: false }; }
      if (existing.product !== input.previous.product || existing.project !== input.previous.project || existing.lineId !== input.previous.lineId) {
        throw new ApiError(409, "worklog_stale", "人工归属已有变化。请刷新后再取消关联。");
      }
      db.prepare("DELETE FROM opc_worklog_bindings WHERE date=? AND source_key=?").run(input.date, input.key);
      db.exec("COMMIT");
      return { removed: true };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  async bind(raw: unknown) {
    const input = parse(bindSchema, raw);
    const snapshot = await this.day(input.date);
    const record = snapshot.records.find(r => r.key === input.key);
    if (!record) throw new ApiError(409, "hub_item_changed", "原日报中已找不到该事项。请重新读取后核对。");
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM company_projects WHERE product=? AND name=?").get(input.product, input.project) ||
          (input.lineId && !db.prepare("SELECT 1 FROM opc_lines WHERE id=?").get(input.lineId))) {
        throw new ApiError(409, "worklog_target", "所选项目或业务线不存在。");
      }
      const existing = db.prepare(`SELECT ${columns} FROM opc_worklog_bindings WHERE date=? AND source_key=?`).get(input.date, input.key) as WorklogBinding | undefined;
      const match = (a: typeof input.previous, b: typeof input.previous) =>
        a?.product === b?.product && a?.project === b?.project && a?.lineId === b?.lineId;
      if (existing && match(existing, input)) { db.exec("COMMIT"); return existing; }
      if (!match(existing ?? null, input.previous)) throw new ApiError(409, "worklog_stale", "人工归属已有变化。请刷新后再修改。");
      db.prepare(`INSERT INTO opc_worklog_bindings VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(date,source_key) DO UPDATE SET product=excluded.product,project=excluded.project,line_id=excluded.line_id`)
        .run(input.date, input.key, record.title, record.mainline, input.product, input.project, input.lineId);
      const saved = db.prepare(`SELECT ${columns} FROM opc_worklog_bindings WHERE date=? AND source_key=?`).get(input.date, input.key) as WorklogBinding;
      db.exec("COMMIT");
      return saved;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}

export function addWorklogRoutes(app: Hono, db: DatabaseSync, user: (c: Context) => unknown) {
  const store = new WorklogStore(db, process.env.OPC_HUB_DAILY_DIR ?? join(homedir(), ".agent-hub", "daily"));
  app.use("/api/opc/worklog/*", async (c, next) => { user(c); c.header("Cache-Control", "no-store"); await next(); });
  app.get("/api/opc/worklog", c => { user(c); c.header("Cache-Control", "no-store"); return c.json(store.index()); });
  app.get("/api/opc/worklog/day", async c => c.json(await store.day(c.req.query("date"))));
  app.post("/api/opc/worklog/bind", async c => c.json(await store.bind(await c.req.json())));
  app.delete("/api/opc/worklog/bind", async c => c.json(store.unbind(await c.req.json())));
}
