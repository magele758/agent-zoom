import { workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import pg from "pg";
import {
  PG_COMPAT_BOOTSTRAP_SQL,
  stripMissingForeignKeys,
  translateSingleStatement,
  translateSqliteToPgStatements,
  type DeferredForeignKey,
} from "./pg-dialect.ts";

// Return BIGINT (OID 20, e.g. COUNT(*), BIGSERIAL) and NUMERIC (OID 1700) as JS numbers to match SQLite.
pg.types.setTypeParser(20, (val: string) => Number(val));
pg.types.setTypeParser(1700, (val: string) => Number(val));

interface WorkerConfig {
  connectionString: string;
  schema: string;
  createSchema: boolean;
  dropSchemaOnClose: boolean;
  port: MessagePort;
  signalBuffer: SharedArrayBuffer;
}

type WorkerRequest =
  | { id: number; op: "init" }
  | { id: number; op: "exec"; sql: string }
  | { id: number; op: "get"; sql: string; params: unknown[] }
  | { id: number; op: "all"; sql: string; params: unknown[] }
  | { id: number; op: "run"; sql: string; params: unknown[] }
  | { id: number; op: "close" };

const cfg = workerData as WorkerConfig;
const signal = new Int32Array(cfg.signalBuffer);
const port = cfg.port;

let client: pg.Client | null = null;
let inTransaction = false;
let closed = false;
const serialColumnCache = new Map<string, string | null>();
const pendingForeignKeys: DeferredForeignKey[] = [];

async function listSchemaTables(c: pg.Client): Promise<Set<string>> {
  const res = await queryWithTxSavepoint(
    c,
    "SELECT lower(table_name) AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
  );
  return new Set(res.rows.map((r) => String(r.name)));
}

async function applyResolvedDeferredFks(c: pg.Client): Promise<void> {
  if (pendingForeignKeys.length === 0) return;
  const existing = await listSchemaTables(c);
  for (let i = pendingForeignKeys.length - 1; i >= 0; i--) {
    const fk = pendingForeignKeys[i];
    if (existing.has(fk.table.toLowerCase()) && existing.has(fk.refTable.toLowerCase())) {
      try {
        await queryWithTxSavepoint(c, `ALTER TABLE ${quoteIdent(fk.table)} ADD ${fk.constraintSql}`);
      } catch {
        // Constraint may already exist or not be applicable; ignore idempotently
      }
      pendingForeignKeys.splice(i, 1);
    }
  }
}

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

function normalizeParams(params: unknown[]): unknown[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "bigint") return Number(value);
    return value;
  });
}

async function ensureBootstrap(c: pg.Client): Promise<void> {
  // Ensure extensions exist (ignore permission error if non-superuser & already installed)
  for (const ext of ["vector", "citext", "pg_trgm"]) {
    try {
      await c.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    } catch {
      // Extension may already exist or require superuser; ignore if already available.
    }
  }

  // Install SQLite-compat functions in `public` idempotently.
  // Use an advisory lock so parallel test workers do not race on CREATE OR REPLACE FUNCTION.
  await c.query("SELECT pg_advisory_lock(792104819201)");
  try {
    const check = await c.query(
      "SELECT COUNT(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE n.nspname = 'public' AND p.proname IN ('instr','json_valid','json_extract','json_array_length','json_each','json_set','sqlite_glob')",
    );
    const existing = Number(check.rows[0]?.n ?? 0);
    if (existing < 8) {
      await c.query(PG_COMPAT_BOOTSTRAP_SQL);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(792104819201)");
  }
}

async function resolveSerialColumn(c: pg.Client, tableName: string): Promise<string | null> {
  const key = tableName.toLowerCase();
  if (serialColumnCache.has(key)) return serialColumnCache.get(key) ?? null;

  const res = await c.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND lower(table_name) = $1
       AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')
     ORDER BY ordinal_position
     LIMIT 1`,
    [key],
  );
  const col = res.rows[0]?.column_name ? String(res.rows[0].column_name) : null;
  serialColumnCache.set(key, col);
  return col;
}

async function queryWithTxSavepoint(c: pg.Client, sql: string, params?: unknown[]): Promise<pg.QueryResult> {
  if (!inTransaction) {
    return params && params.length > 0 ? c.query(sql, params) : c.query(sql);
  }
  await c.query("SAVEPOINT __opc_stmt");
  try {
    const result = params && params.length > 0 ? await c.query(sql, params) : await c.query(sql);
    await c.query("RELEASE SAVEPOINT __opc_stmt");
    return result;
  } catch (error) {
    try {
      await c.query("ROLLBACK TO SAVEPOINT __opc_stmt");
      await c.query("RELEASE SAVEPOINT __opc_stmt");
    } catch {
      // Connection or transaction already dead
    }
    throw error;
  }
}

async function handleInit(): Promise<void> {
  client = new pg.Client({ connectionString: cfg.connectionString });
  await client.connect();
  await ensureBootstrap(client);

  if (cfg.schema && cfg.schema !== "public") {
    const quoted = quoteIdent(cfg.schema);
    if (cfg.createSchema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`);
    }
    await client.query(`SET search_path TO ${quoted}, public`);
  } else {
    await client.query("SET search_path TO public");
  }
}

async function handleExec(sql: string): Promise<void> {
  if (!client || closed) throw new Error("PostgreSQL connection is closed");
  const stmts = translateSqliteToPgStatements(sql);
  for (const stmt of stmts) {
    if (stmt.kind === "noop" || !stmt.sql) continue;

    if (stmt.kind === "begin") {
      if (!inTransaction) {
        await client.query("BEGIN");
        inTransaction = true;
      }
      continue;
    }
    if (stmt.kind === "commit") {
      if (inTransaction) {
        await client.query("COMMIT");
        inTransaction = false;
      }
      continue;
    }
    if (stmt.kind === "rollback") {
      if (inTransaction) {
        await client.query("ROLLBACK");
        inTransaction = false;
      }
      continue;
    }

    // DDL may add tables/serial columns; clear serial cache on CREATE/ALTER/DROP
    const isCreateTable = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(stmt.sql);
    if (/^\s*(CREATE|ALTER|DROP)\s+/i.test(stmt.sql)) {
      serialColumnCache.clear();
    }

    if (isCreateTable) {
      // Always resolve REFERENCES against tables in `current_schema()` only (never bind an isolated
      // test schema's FK to a same-named table sitting in `public`!).
      const hasReferences = /\bREFERENCES\b/i.test(stmt.sql);
      if (hasReferences && cfg.schema && cfg.schema !== "public") {
        const existing = await listSchemaTables(client);
        const stripped = stripMissingForeignKeys(stmt.sql, existing);
        await queryWithTxSavepoint(client, stripped.sql);
        if (stripped.deferred.length > 0) {
          pendingForeignKeys.push(...stripped.deferred);
        }
      } else {
        try {
          await queryWithTxSavepoint(client, stmt.sql);
        } catch (err) {
          const pgErr = err as { code?: string };
          if (pgErr?.code === "42P01") {
            const existing = await listSchemaTables(client);
            const stripped = stripMissingForeignKeys(stmt.sql, existing);
            if (stripped.deferred.length > 0) {
              await queryWithTxSavepoint(client, stripped.sql);
              pendingForeignKeys.push(...stripped.deferred);
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
      await applyResolvedDeferredFks(client);
    } else {
      await queryWithTxSavepoint(client, stmt.sql);
    }
  }
}

async function handleQuery(
  op: "get" | "all" | "run",
  sql: string,
  rawParams: unknown[],
): Promise<unknown> {
  if (!client || closed) throw new Error("PostgreSQL connection is closed");
  const translated = translateSingleStatement(sql);
  if (translated.kind === "noop" || !translated.sql) {
    if (op === "all") return [];
    if (op === "get") return undefined;
    return { changes: 0, lastInsertRowid: 0 };
  }

  if (translated.kind === "begin") {
    if (!inTransaction) {
      await client.query("BEGIN");
      inTransaction = true;
    }
    return op === "all" ? [] : op === "get" ? undefined : { changes: 0, lastInsertRowid: 0 };
  }
  if (translated.kind === "commit") {
    if (inTransaction) {
      await client.query("COMMIT");
      inTransaction = false;
    }
    return op === "all" ? [] : op === "get" ? undefined : { changes: 0, lastInsertRowid: 0 };
  }
  if (translated.kind === "rollback") {
    if (inTransaction) {
      await client.query("ROLLBACK");
      inTransaction = false;
    }
    return op === "all" ? [] : op === "get" ? undefined : { changes: 0, lastInsertRowid: 0 };
  }

  const params = normalizeParams(rawParams);

  if (op === "run") {
    let execSql = translated.sql;
    let returningSerial = false;
    if (translated.insertTable && !translated.hasReturning) {
      const serialCol = await resolveSerialColumn(client, translated.insertTable);
      if (serialCol) {
        execSql = `${execSql} RETURNING ${quoteIdent(serialCol)} AS __opc_last_rowid`;
        returningSerial = true;
      }
    }

    const res = await queryWithTxSavepoint(client, execSql, params);
    const changes = Number(res.rowCount ?? 0);
    let lastInsertRowid = 0;
    if (returningSerial && res.rows.length > 0 && res.rows[0].__opc_last_rowid !== undefined) {
      lastInsertRowid = Number(res.rows[0].__opc_last_rowid);
    }
    return { changes, lastInsertRowid };
  }

  const res = await queryWithTxSavepoint(client, translated.sql, params);
  if (op === "get") {
    return res.rows.length > 0 ? res.rows[0] : undefined;
  }
  return res.rows;
}

async function handleClose(): Promise<void> {
  if (closed) return;
  closed = true;
  if (client) {
    try {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => {});
        inTransaction = false;
      }
      if (cfg.dropSchemaOnClose && cfg.schema && cfg.schema !== "public") {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(cfg.schema)} CASCADE`).catch(() => {});
      }
    } finally {
      await client.end().catch(() => {});
      client = null;
    }
  }
}

function serializeError(err: unknown): {
  message: string;
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
} {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      message: typeof e.message === "string" ? e.message : String(err),
      ...(typeof e.code === "string" && { code: e.code }),
      ...(typeof e.detail === "string" && { detail: e.detail }),
      ...(typeof e.constraint === "string" && { constraint: e.constraint }),
      ...(typeof e.table === "string" && { table: e.table }),
    };
  }
  return { message: String(err) };
}

port.on("message", async (req: WorkerRequest) => {
  try {
    let data: unknown = null;
    if (req.op === "init") {
      await handleInit();
    } else if (req.op === "exec") {
      await handleExec(req.sql);
    } else if (req.op === "get" || req.op === "all" || req.op === "run") {
      data = await handleQuery(req.op, req.sql, req.params);
    } else if (req.op === "close") {
      await handleClose();
    }
    port.postMessage({ id: req.id, ok: true, data, inTransaction });
  } catch (err) {
    port.postMessage({ id: req.id, ok: false, error: serializeError(err), inTransaction });
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
    if (req.op === "close") {
      port.close();
      process.exit(0);
    }
  }
});
