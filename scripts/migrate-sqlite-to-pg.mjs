#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  PG_COMPAT_BOOTSTRAP_SQL,
  stripMissingForeignKeys,
  translateSqliteToPgStatements,
} from "../src/server/pg-dialect.ts";

pg.types.setTypeParser(20, (val) => Number(val));
pg.types.setTypeParser(1700, (val) => Number(val));

const DEFAULT_SQLITE_PATH = "/Users/penglei/developer/ai-github/agent-chatroom/data/zoom-local/chatroom.db";
const DEFAULT_PG_URL = "postgres://opc:opc_local_pg@127.0.0.1:15433/opc_os";

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function parseArgs(argv) {
  const opts = {
    sqlitePath: process.env.OPC_SQLITE_PATH || DEFAULT_SQLITE_PATH,
    pgUrl: process.env.OPC_PG_URL || process.env.DATABASE_URL || DEFAULT_PG_URL,
    schema: process.env.OPC_PG_SCHEMA || "public",
    truncate: false,
    json: false,
    batchSize: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sqlite" && argv[i + 1]) {
      opts.sqlitePath = resolve(argv[++i]);
    } else if (arg.startsWith("--sqlite=")) {
      opts.sqlitePath = resolve(arg.slice("--sqlite=".length));
    } else if (arg === "--pg" && argv[i + 1]) {
      opts.pgUrl = argv[++i];
    } else if (arg.startsWith("--pg=")) {
      opts.pgUrl = arg.slice("--pg=".length);
    } else if (arg === "--schema" && argv[i + 1]) {
      opts.schema = argv[++i];
    } else if (arg.startsWith("--schema=")) {
      opts.schema = arg.slice("--schema=".length);
    } else if (arg === "--truncate") {
      opts.truncate = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--batch-size" && argv[i + 1]) {
      opts.batchSize = Math.max(1, Math.min(1000, Number(argv[++i]) || 200));
    }
  }
  return opts;
}

function ensureIfNotExists(sql, kind) {
  if (kind === "table") {
    return sql.replace(/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i, "CREATE TABLE IF NOT EXISTS ");
  }
  if (kind === "index") {
    return sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i, "CREATE $1INDEX IF NOT EXISTS ");
  }
  return sql;
}

/**
 * Topological sort of tables so referenced parent tables come before child tables.
 * Self-referential FKs are ignored for table ordering.
 */
function topoSortTables(tables, fkMap) {
  const names = tables.map((t) => t.name);
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const inDegree = new Map(names.map((n) => [n, 0]));
  const dependents = new Map(names.map((n) => [n, []]));

  for (const name of names) {
    const parents = new Set();
    for (const ref of fkMap.get(name) ?? []) {
      const canonical = byLower.get(ref.table.toLowerCase());
      if (!canonical || canonical === name) continue;
      parents.add(canonical);
    }
    inDegree.set(name, parents.size);
    for (const parent of parents) {
      dependents.get(parent).push(name);
    }
  }

  const queue = names.filter((n) => inDegree.get(n) === 0).sort();
  const ordered = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    ordered.push(cur);
    const nextReady = [];
    for (const child of dependents.get(cur) ?? []) {
      const deg = inDegree.get(child) - 1;
      inDegree.set(child, deg);
      if (deg === 0) nextReady.push(child);
    }
    if (nextReady.length > 0) {
      queue.push(...nextReady);
      queue.sort();
    }
  }

  // Append any remaining tables involved in a cycle deterministically
  const seen = new Set(ordered);
  const remaining = names.filter((n) => !seen.has(n)).sort();
  return [...ordered, ...remaining];
}

/**
 * For tables with a self-referential FK (e.g. zoom_messages.reply_to -> zoom_messages.id,
 * opc_home_posts.parent -> opc_home_posts.id), sort rows so parent rows are inserted first.
 */
function sortRowsForSelfFk(rows, selfFks) {
  if (selfFks.length === 0 || rows.length <= 1) return rows;
  const fk = selfFks[0];
  const childCol = fk.from;
  const parentCol = fk.to || "id";

  const byKey = new Map();
  for (const row of rows) {
    const k = row[parentCol];
    if (k !== null && k !== undefined) byKey.set(String(k), row);
  }

  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(row) {
    const key = row[parentCol] !== null && row[parentCol] !== undefined ? String(row[parentCol]) : null;
    if (key !== null && visited.has(key)) return;
    if (key !== null && visiting.has(key)) return;
    if (key !== null) visiting.add(key);

    const parentVal = row[childCol];
    if (parentVal !== null && parentVal !== undefined) {
      const parentRow = byKey.get(String(parentVal));
      if (parentRow && parentRow !== row) {
        visit(parentRow);
      }
    }

    if (key !== null) {
      visiting.delete(key);
      visited.add(key);
    }
    ordered.push(row);
  }

  for (const row of rows) visit(row);
  return ordered;
}

export async function migrateSqliteToPg(options = {}) {
  const sqlitePath = resolve(options.sqlitePath || process.env.OPC_SQLITE_PATH || DEFAULT_SQLITE_PATH);
  const pgUrl = options.pgUrl || process.env.OPC_PG_URL || process.env.DATABASE_URL || DEFAULT_PG_URL;
  const schema = (options.schema || process.env.OPC_PG_SCHEMA || "public").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() || "public";
  const truncate = Boolean(options.truncate);
  const batchSize = options.batchSize || 200;

  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite 源库文件不存在：${sqlitePath}`);
  }

  // Strictly read-only access — never mutate the source SQLite database.
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const client = new pg.Client({ connectionString: pgUrl });

  try {
    await client.connect();

    // 1. Ensure required extensions and SQLite compatibility functions exist in public.
    for (const ext of ["vector", "citext", "pg_trgm"]) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    await client.query(PG_COMPAT_BOOTSTRAP_SQL);

    if (schema !== "public") {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
      await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
    } else {
      await client.query("SET search_path TO public");
    }

    // 2. Inspect SQLite schema objects.
    const objects = sqlite
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
      .all();
    const tables = objects.filter((o) => o.type === "table" && !String(o.name).startsWith("sqlite_"));
    const indexes = objects.filter((o) => o.type === "index" && !String(o.name).startsWith("sqlite_"));
    const triggers = objects.filter((o) => o.type === "trigger");

    const tableMap = new Map(tables.map((t) => [String(t.name), String(t.sql)]));
    const fkMap = new Map();
    const colInfoMap = new Map();
    const hasPkOrUniqueMap = new Map();

    for (const t of tables) {
      const name = String(t.name);
      const fks = sqlite.prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`).all();
      fkMap.set(name, fks);
      // PRAGMA table_info automatically excludes GENERATED columns (which PG computes automatically).
      const cols = sqlite.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
      colInfoMap.set(name, cols);
      const idxList = sqlite.prepare(`PRAGMA index_list(${quoteIdent(name)})`).all();
      const hasUniqueIdx = idxList.some((ix) => Number(ix.unique) === 1);
      const hasPk = cols.some((c) => Number(c.pk) > 0);
      hasPkOrUniqueMap.set(name, hasPk || hasUniqueIdx);
    }

    const orderedTables = topoSortTables(tables, fkMap);

    // 3. Create tables in topological order (idempotent, deferring any cyclic FKs until after creation).
    const existingRes = await client.query(
      "SELECT lower(table_name) AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
    );
    const existingTables = new Set(existingRes.rows.map((r) => String(r.name)));
    const deferredFks = [];

    for (const tableName of orderedTables) {
      const rawDdl = ensureIfNotExists(tableMap.get(tableName), "table");
      const translated = translateSqliteToPgStatements(rawDdl);
      for (const stmt of translated) {
        try {
          await client.query(stmt.sql);
        } catch (err) {
          if (err && typeof err === "object" && err.code === "42P01") {
            const stripped = stripMissingForeignKeys(stmt.sql, existingTables);
            if (stripped.deferred.length === 0) throw err;
            await client.query(stripped.sql);
            deferredFks.push(...stripped.deferred);
          } else {
            throw new Error(`创建表 ${tableName} 失败: ${err instanceof Error ? err.message : String(err)}\nSQL: ${stmt.sql}`);
          }
        }
      }
      existingTables.add(tableName.toLowerCase());
    }

    for (const fk of deferredFks) {
      try {
        await client.query(`ALTER TABLE ${quoteIdent(fk.table)} ADD ${fk.constraintSql}`);
      } catch {
        // Constraint may already exist on idempotent re-run
      }
    }

    // Drop triggers temporarily if re-running so migration inserts don't fire side-effect triggers
    for (const trig of triggers) {
      await client.query(`DROP TRIGGER IF EXISTS ${quoteIdent(String(trig.name))} ON ${quoteIdent(String(trig.tbl_name))}`);
    }

    if (truncate && orderedTables.length > 0) {
      const reverseQuoted = [...orderedTables].reverse().map(quoteIdent).join(", ");
      await client.query(`TRUNCATE TABLE ${reverseQuoted} RESTART IDENTITY CASCADE`);
    }

    // 4. Create indexes before or after data? Creating unique indexes before data enables ON CONFLICT DO NOTHING!
    for (const idx of indexes) {
      const rawIdx = ensureIfNotExists(String(idx.sql), "index");
      const translated = translateSqliteToPgStatements(rawIdx);
      for (const stmt of translated) {
        await client.query(stmt.sql);
      }
    }

    // 5. Import data table-by-table in topological order.
    const importStats = [];
    for (const tableName of orderedTables) {
      const cols = colInfoMap.get(tableName) ?? [];
      const colNames = cols.map((c) => String(c.name));
      const selectCols = colNames.map(quoteIdent).join(", ");
      const sqliteCount = Number(
        sqlite.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(tableName)}`).get().c,
      );

      if (sqliteCount === 0 || colNames.length === 0) {
        importStats.push({ table: tableName, sqliteRows: sqliteCount, insertedAttempted: 0, skippedNoPk: false });
        continue;
      }

      // If table has no PK/UNIQUE and PG already matches SQLite count, skip to keep re-runs idempotent
      const hasConflictKey = hasPkOrUniqueMap.get(tableName);
      if (!hasConflictKey) {
        const existingCount = Number(
          (await client.query(`SELECT COUNT(*) AS c FROM ${quoteIdent(tableName)}`)).rows[0].c,
        );
        if (existingCount === sqliteCount) {
          importStats.push({ table: tableName, sqliteRows: sqliteCount, insertedAttempted: 0, skippedNoPk: true });
          continue;
        }
      }

      let rows = sqlite
        .prepare(`SELECT ${selectCols} FROM ${quoteIdent(tableName)} ORDER BY rowid ASC`)
        .all();

      const selfFks = (fkMap.get(tableName) ?? []).filter(
        (fk) => String(fk.table).toLowerCase() === tableName.toLowerCase(),
      );
      if (selfFks.length > 0) {
        rows = sortRowsForSelfFk(rows, selfFks);
      }

      const pgColsSql = colNames.map(quoteIdent).join(", ");
      const conflictClause = hasConflictKey ? " ON CONFLICT DO NOTHING" : "";

      // Batch insert rows inside a per-table transaction for speed and atomicity
      await client.query("BEGIN");
      try {
        for (let offset = 0; offset < rows.length; offset += batchSize) {
          const chunk = rows.slice(offset, offset + batchSize);
          const values = [];
          const placeholders = [];
          let paramIdx = 1;
          for (const row of chunk) {
            const rowPh = [];
            for (const colName of colNames) {
              const v = row[colName];
              values.push(v === undefined ? null : typeof v === "bigint" ? Number(v) : v);
              rowPh.push(`$${paramIdx++}`);
            }
            placeholders.push(`(${rowPh.join(", ")})`);
          }
          const insertSql = `INSERT INTO ${quoteIdent(tableName)} (${pgColsSql}) VALUES ${placeholders.join(", ")}${conflictClause}`;
          await client.query(insertSql, values);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`导入表 ${tableName} 数据失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      importStats.push({ table: tableName, sqliteRows: sqliteCount, insertedAttempted: rows.length, skippedNoPk: false });
    }

    // 6. Synchronize all BIGSERIAL / IDENTITY sequences to MAX(col)
    const seqRes = await client.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`,
    );
    for (const row of seqRes.rows) {
      const tbl = String(row.table_name);
      const col = String(row.column_name);
      const maxRes = await client.query(
        `SELECT MAX(${quoteIdent(col)}) AS max_val, COUNT(*) AS cnt FROM ${quoteIdent(tbl)}`,
      );
      const maxVal = Number(maxRes.rows[0]?.max_val ?? 0);
      const hasRows = Number(maxRes.rows[0]?.cnt ?? 0) > 0;
      const seqNameRes = await client.query("SELECT pg_get_serial_sequence($1, $2) AS seq_name", [
        `${quoteIdent(schema)}.${quoteIdent(tbl)}`,
        col,
      ]);
      const seqName = seqNameRes.rows[0]?.seq_name;
      if (seqName) {
        await client.query("SELECT setval($1, $2, $3)", [seqName, hasRows ? Math.max(1, maxVal) : 1, hasRows]);
      }
    }

    // 7. Create triggers AFTER data import
    for (const trig of triggers) {
      const translated = translateSqliteToPgStatements(String(trig.sql));
      for (const stmt of translated) {
        await client.query(stmt.sql);
      }
    }

    // 8. Reconcile row counts across ALL tables (SQLite vs PG)
    const reconciliation = [];
    let totalSqliteRows = 0;
    let totalPgRows = 0;
    const mismatches = [];

    for (const tableName of [...orderedTables].sort()) {
      const sqliteCount = Number(
        sqlite.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(tableName)}`).get().c,
      );
      const pgCount = Number(
        (await client.query(`SELECT COUNT(*) AS c FROM ${quoteIdent(tableName)}`)).rows[0].c,
      );
      const matched = sqliteCount === pgCount;
      totalSqliteRows += sqliteCount;
      totalPgRows += pgCount;
      const entry = { table: tableName, sqliteRows: sqliteCount, pgRows: pgCount, matched };
      reconciliation.push(entry);
      if (!matched) mismatches.push(entry);
    }

    return {
      ok: mismatches.length === 0,
      sqlitePath,
      schema,
      tableCount: orderedTables.length,
      indexCount: indexes.length,
      triggerCount: triggers.length,
      matchedTables: reconciliation.length - mismatches.length,
      mismatchedTables: mismatches.length,
      totalSqliteRows,
      totalPgRows,
      mismatches,
      tables: reconciliation,
    };
  } finally {
    sqlite.close();
    await client.end().catch(() => {});
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const report = await migrateSqliteToPg(opts);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`=== SQLite -> PostgreSQL 18 全量迁移逐表对账报告 (schema: ${report.schema}) ===`);
      console.log(`源 SQLite (只读): ${report.sqlitePath}`);
      console.log(`表总数: ${report.tableCount} | 索引: ${report.indexCount} | 触发器: ${report.triggerCount}`);
      console.log("");
      const maxLen = Math.max(...report.tables.map((t) => t.table.length), 10);
      console.log(`${"表名".padEnd(maxLen)}  ${"SQLite".padStart(8)}  ${"PG 18".padStart(8)}  状态`);
      console.log(`${"-".repeat(maxLen)}  ${"-".repeat(8)}  ${"-".repeat(8)}  ----`);
      for (const row of report.tables) {
        const mark = row.matched ? "OK" : "MISMATCH";
        console.log(
          `${row.table.padEnd(maxLen)}  ${String(row.sqliteRows).padStart(8)}  ${String(row.pgRows).padStart(8)}  ${mark}`,
        );
      }
      console.log("");
      console.log(
        `汇总: ${report.matchedTables}/${report.tableCount} 张表行数一致 | 总行数 SQLite=${report.totalSqliteRows} vs PG=${report.totalPgRows}`,
      );
      if (!report.ok) {
        console.error(`❌ 发现 ${report.mismatchedTables} 张表行数不一致！`);
      } else {
        console.log("✅ 全部表 100% 迁移并对账一致！");
      }
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`❌ 迁移失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
