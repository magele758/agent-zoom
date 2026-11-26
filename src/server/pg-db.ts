import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import pg from "pg";

// Configure PG type parsers on the main thread too so async createPgPool() matches PgDatabaseSync.
pg.types.setTypeParser(20, (val: string) => Number(val));
pg.types.setTypeParser(1700, (val: string) => Number(val));

export interface CreatePgPoolOptions {
  connectionString?: string;
  schema?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
}

export interface PgDatabaseSyncOptions {
  connectionString?: string;
  schema?: string;
  createSchema?: boolean;
  dropSchemaOnClose?: boolean;
  /** Optional temp file path in tmpdir so test runner exit can reap deleted-tmpdir schemas. */
  tempPath?: string;
}

const openPgDbs = new Set<PgDatabaseSync>();
const activeDropOnCloseDbs = new Set<PgDatabaseSync>();
const trackedTempSchemas = new Map<string, { connectionString: string; schema: string; tempDir: string }>();
let pgCleanupHookInstalled = false;

function runPgExitCleanup(): void {
  // First, drop any tracked opc_tmp_* schemas whose temp directory has already been removed by test cleanup,
  // using an already-open worker synchronously (safe inside process 'exit' where async handles cannot start).
  if (trackedTempSchemas.size > 0 && openPgDbs.size > 0) {
    const byUrl = new Map<string, PgDatabaseSync>();
    for (const db of openPgDbs) {
      if (db.isOpen && !byUrl.has(db.connectionString)) byUrl.set(db.connectionString, db);
    }
    for (const [key, entry] of [...trackedTempSchemas.entries()]) {
      if (!existsSync(entry.tempDir)) {
        const helper = byUrl.get(entry.connectionString);
        if (helper && helper.isOpen) {
          trackedTempSchemas.delete(key);
          try {
            helper.exec(`DROP SCHEMA IF EXISTS "${entry.schema.replace(/"/g, '""')}" CASCADE`);
          } catch {
            // ignore shutdown race
          }
        }
      }
    }
  }

  // Synchronously close all unclosed dropSchemaOnClose (:memory:) instances so opc_mem_* schemas never leak.
  if (activeDropOnCloseDbs.size > 0) {
    const pending = [...activeDropOnCloseDbs];
    activeDropOnCloseDbs.clear();
    for (const db of pending) {
      try {
        db.close();
      } catch {
        // ignore shutdown race
      }
    }
  }
}

function ensurePgCleanupHook(): void {
  if (pgCleanupHookInstalled) return;
  pgCleanupHookInstalled = true;
  process.on("beforeExit", runPgExitCleanup);
  process.on("exit", runPgExitCleanup);
}

export interface PgRunResult {
  changes: number;
  lastInsertRowid: number;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  inTransaction: boolean;
  error?: {
    message: string;
    code?: string;
    detail?: string;
    constraint?: string;
    table?: string;
  };
}

export function resolvePgUrl(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env.OPC_PG_URL ?? process.env.DATABASE_URL;
  const trimmed = typeof candidate === "string" ? candidate.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeSchemaIdentifier(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  if (!clean) return "public";
  return /^[a-z_]/.test(clean) ? clean.slice(0, 63) : `s_${clean}`.slice(0, 63);
}

/**
 * Create an async native `pg.Pool` (used directly by PG-native modules such as `repo-evolution`).
 */
export function createPgPool(urlOrOptions?: string | CreatePgPoolOptions): pg.Pool {
  const opts: CreatePgPoolOptions =
    typeof urlOrOptions === "string" ? { connectionString: urlOrOptions } : (urlOrOptions ?? {});
  const connectionString = resolvePgUrl(opts.connectionString);
  if (!connectionString) {
    throw new Error("PostgreSQL connection URL not configured (set OPC_PG_URL or DATABASE_URL)");
  }

  const schema = opts.schema ? sanitizeSchemaIdentifier(opts.schema) : undefined;
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
    allowExitOnIdle: opts.allowExitOnIdle ?? true,
    ...(schema && schema !== "public" ? { options: `-c search_path=${schema},public` } : {}),
  });
  pool.on("error", (err) => {
    console.error("PostgreSQL pool idle client error", err);
  });
  return pool;
}

let tempDirRealPrefix: string | null = null;
function getTempPrefixes(): string[] {
  const prefixes = [resolve(tmpdir()), "/tmp", "/private/tmp"];
  if (tempDirRealPrefix === null) {
    try {
      tempDirRealPrefix = realpathSync(tmpdir());
    } catch {
      tempDirRealPrefix = "";
    }
  }
  if (tempDirRealPrefix && !prefixes.includes(tempDirRealPrefix)) {
    prefixes.push(tempDirRealPrefix);
  }
  return prefixes;
}

export function isTempDatabasePath(path: string): boolean {
  if (path === ":memory:") return true;
  const abs = resolve(path);
  return getTempPrefixes().some((prefix) => abs === prefix || abs.startsWith(prefix + "/"));
}

let memorySchemaCounter = 0;

export function deriveTestSchemaForPath(path: string): {
  schema: string;
  createSchema: boolean;
  dropSchemaOnClose: boolean;
} {
  if (path === ":memory:") {
    memorySchemaCounter += 1;
    const rand = randomBytes(4).toString("hex");
    return {
      schema: `opc_mem_${process.pid}_${memorySchemaCounter}_${rand}`,
      createSchema: true,
      dropSchemaOnClose: true,
    };
  }
  const explicitSchema = process.env.OPC_PG_SCHEMA?.trim();
  if (explicitSchema && !isTempDatabasePath(path)) {
    const clean = sanitizeSchemaIdentifier(explicitSchema);
    return { schema: clean, createSchema: clean !== "public", dropSchemaOnClose: false };
  }
  if (isTempDatabasePath(path)) {
    const hash = createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
    return {
      schema: `opc_tmp_${hash}`,
      createSchema: true,
      dropSchemaOnClose: false,
    };
  }
  return { schema: "public", createSchema: false, dropSchemaOnClose: false };
}

class PgStatementSync {
  private readonly owner: PgDatabaseSync;
  private readonly sql: string;

  constructor(owner: PgDatabaseSync, sql: string) {
    this.owner = owner;
    this.sql = sql;
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.owner._call("get", this.sql, params) as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.owner._call("all", this.sql, params) as Record<string, unknown>[];
  }

  run(...params: unknown[]): PgRunResult {
    return this.owner._call("run", this.sql, params) as PgRunResult;
  }
}

export class PgDatabaseSync {
  readonly schema: string;
  readonly connectionString: string;
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly signal: Int32Array;
  private reqId = 0;
  private _isTransaction = false;
  private _closed = false;

  constructor(options: PgDatabaseSyncOptions = {}) {
    const connectionString = resolvePgUrl(options.connectionString);
    if (!connectionString) {
      throw new Error("PostgreSQL connection URL not configured (set OPC_PG_URL or DATABASE_URL)");
    }
    this.connectionString = connectionString;
    this.schema = options.schema ? sanitizeSchemaIdentifier(options.schema) : "public";
    const createSchema = options.createSchema ?? this.schema !== "public";
    const dropSchemaOnClose = options.dropSchemaOnClose ?? false;

    const signalBuffer = new SharedArrayBuffer(8);
    this.signal = new Int32Array(signalBuffer);
    const channel = new MessageChannel();
    this.port = channel.port1;

    const workerUrl = new URL("./pg-worker.ts", import.meta.url);
    this.worker = new Worker(workerUrl, {
      workerData: {
        connectionString: this.connectionString,
        schema: this.schema,
        createSchema,
        dropSchemaOnClose,
        port: channel.port2,
        signalBuffer,
      },
      transferList: [channel.port2],
    });
    // Prevent forgotten db.close() in tests/CLI scripts from hanging process exit.
    this.worker.unref();
    this.port.unref();

    this._send({ op: "init" });
    openPgDbs.add(this);
    if (dropSchemaOnClose && this.schema !== "public") {
      activeDropOnCloseDbs.add(this);
      ensurePgCleanupHook();
    } else if (options.tempPath && this.schema.startsWith("opc_tmp_")) {
      const tempDir = dirname(resolve(options.tempPath));
      if (!getTempPrefixes().includes(tempDir)) {
        trackedTempSchemas.set(`${this.connectionString}::${this.schema}`, {
          connectionString: this.connectionString,
          schema: this.schema,
          tempDir,
        });
        ensurePgCleanupHook();
      }
    }
  }

  get isTransaction(): boolean {
    return this._isTransaction;
  }

  get isOpen(): boolean {
    return !this._closed;
  }

  exec(sql: string): void {
    this._send({ op: "exec", sql });
  }

  prepare(sql: string): PgStatementSync {
    if (this._closed) throw new Error("PostgreSQL database is closed");
    return new PgStatementSync(this, sql);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    openPgDbs.delete(this);
    activeDropOnCloseDbs.delete(this);
    try {
      this._send({ op: "close" }, true);
    } catch {
      // Ignore worker shutdown race
    } finally {
      this.port.close();
      void this.worker.terminate().catch(() => {});
    }
  }

  /** @internal */
  _call(op: "get" | "all" | "run", sql: string, params: unknown[]): unknown {
    return this._send({ op, sql, params });
  }

  private _send(payload: Record<string, unknown>, allowClosed = false): unknown {
    if (this._closed && !allowClosed) {
      throw new Error("PostgreSQL database is closed");
    }
    const id = ++this.reqId;
    Atomics.store(this.signal, 0, 0);
    this.port.postMessage({ id, ...payload });

    const deadline = Date.now() + 60_000;
    while (Atomics.load(this.signal, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`PostgreSQL sync call timed out after 60s (op=${String(payload.op)})`);
      }
      Atomics.wait(this.signal, 0, 0, Math.min(remaining, 1000));
    }

    let wrapped = receiveMessageOnPort(this.port);
    let spins = 0;
    while (!wrapped && spins < 50) {
      Atomics.wait(this.signal, 1, 0, 1);
      wrapped = receiveMessageOnPort(this.port);
      spins++;
    }
    if (!wrapped) {
      throw new Error(`PostgreSQL worker closed without replying (op=${String(payload.op)})`);
    }

    const resp = wrapped.message as WorkerResponse;
    this._isTransaction = Boolean(resp.inTransaction);

    if (!resp.ok) {
      const err = new Error(resp.error?.message || "PostgreSQL query failed") as Error & {
        code?: string;
        detail?: string;
        constraint?: string;
        table?: string;
      };
      if (resp.error?.code) err.code = resp.error.code;
      if (resp.error?.detail) err.detail = resp.error.detail;
      if (resp.error?.constraint) err.constraint = resp.error.constraint;
      if (resp.error?.table) err.table = resp.error.table;
      throw err;
    }

    return resp.data;
  }
}

export function isPgDatabase(db: unknown): db is PgDatabaseSync {
  return db instanceof PgDatabaseSync;
}
