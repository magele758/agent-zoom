import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBackup, verifyBackup } from "../scripts/opc-backup.mjs";
import { DomainEventBus } from "./kernel/events.ts";
import { OpportunityStore } from "./server/autonomy.ts";
import { CompanyStore } from "./server/company.ts";
import { openDatabase } from "./server/db.ts";
import { ExecutiveReceiptTracer } from "./server/executive-receipt-trace.ts";
import { Store } from "./server/logic.ts";
import { createPgPool, isPgDatabase, PgDatabaseSync, resolvePgUrl } from "./server/pg-db.ts";
import {
  splitSqlStatements,
  translateSingleStatement,
  translateSqliteToPg,
  translateSqliteToPgStatements,
} from "./server/pg-dialect.ts";
import { ProjectStore } from "./server/projects.ts";
import { SecurityReviews } from "./server/security-department.ts";
import { StageWorkStore } from "./server/stage-work.ts";

const PG_URL = resolvePgUrl() ?? "postgres://opc:opc_local_pg@127.0.0.1:15433/opc_os";

test("pg-dialect: placeholder translation skips string literals and comments", () => {
  const sql = `
    -- comment with ? inside
    SELECT id, 'what? ''really?''' AS q, /* block ? comment */ name
    FROM users
    WHERE id = ? AND (? IS NULL OR name = ?)
  `;
  const pg = translateSqliteToPg(sql);
  assert.ok(pg.includes("'what? ''really?'''"), "string literal ? must stay intact");
  assert.ok(pg.includes("-- comment with ? inside"), "line comment ? must stay intact");
  assert.ok(pg.includes("/* block ? comment */"), "block comment ? must stay intact");
  assert.ok(pg.includes("WHERE id = $1 AND ($2::text IS NULL OR name = $3)"), `unexpected translation: ${pg}`);
});

test("pg-dialect: INSERT OR IGNORE, PRAGMA, sqlite_master, transactions, COLLATE NOCASE, AUTOINCREMENT, generated cols, triggers", () => {
  assert.equal(
    translateSqliteToPg("INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'member')"),
    "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
  );

  assert.match(translateSqliteToPg("PRAGMA table_info(opc_opportunities)"), /information_schema\.columns/);
  assert.match(translateSqliteToPg("PRAGMA quick_check(1)"), /SELECT 'ok'::text AS quick_check/);
  assert.match(translateSqliteToPg("PRAGMA journal_mode"), /SELECT 'wal'::text AS journal_mode/);
  assert.equal(translateSqliteToPg("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;"), "");

  assert.match(
    translateSqliteToPg("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"),
    /information_schema\.tables/,
  );

  assert.equal(translateSingleStatement("BEGIN IMMEDIATE").sql, "BEGIN");
  assert.equal(translateSingleStatement("BEGIN IMMEDIATE").kind, "begin");
  assert.equal(translateSingleStatement("COMMIT").kind, "commit");
  assert.equal(translateSingleStatement("ROLLBACK").kind, "rollback");

  const ddl = translateSqliteToPg(`
    CREATE TABLE IF NOT EXISTS demo_t (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      impact INTEGER NOT NULL,
      confidence INTEGER NOT NULL,
      effort INTEGER NOT NULL,
      score REAL GENERATED ALWAYS AS (round(impact * confidence * 1.0 / effort, 2)) STORED,
      localRoom TEXT NOT NULL
    )
  `);
  assert.match(ddl, /id BIGSERIAL PRIMARY KEY/);
  assert.match(ddl, /full_name CITEXT NOT NULL UNIQUE/);
  assert.match(ddl, /score DOUBLE PRECISION GENERATED ALWAYS AS \(round\(\(impact \* confidence \* 1\.0 \/ effort\)::numeric, 2\)::double precision\) STORED/);
  assert.match(ddl, /"localRoom" TEXT NOT NULL/);

  const singletonDdl = translateSqliteToPg(
    "CREATE TABLE local_console (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))",
  );
  assert.match(singletonDdl, /singleton INTEGER PRIMARY KEY CHECK/);

  const dmlCollate = translateSqliteToPg(
    "SELECT a.handle FROM agents a WHERE a.handle = ? COLLATE NOCASE AND json_extract(w.brief,'$.requestedAgent')=? COLLATE NOCASE",
  );
  assert.match(dmlCollate, /\(\(a\.handle\)::citext = \(\$1\)::citext\)/);
  assert.match(dmlCollate, /\(\(json_extract\(w\.brief,'\$\.requestedAgent'\)\)::citext = \(\$2\)::citext\)/);

  const maxRewrite = translateSqliteToPg(
    "UPDATE room_members SET last_read_seq = MAX(last_read_seq, ?) WHERE room_id = ?",
  );
  assert.match(maxRewrite, /GREATEST\(last_read_seq, \$1\)/);
  assert.match(translateSqliteToPg("SELECT MAX(seq) FROM messages"), /SELECT MAX\(seq\) FROM messages/);

  const globRewrite = translateSqliteToPg("SELECT 1 FROM zoom_messages WHERE event_key GLOB ?");
  assert.match(globRewrite, /public\.sqlite_glob\(\(event_key\)::text, \(\$1\)::text\)/);

  const triggerSql = `
    CREATE TRIGGER IF NOT EXISTS local_reader_for_new_room AFTER INSERT ON rooms
    WHEN EXISTS (SELECT 1 FROM local_console WHERE singleton=1)
    BEGIN
      INSERT OR IGNORE INTO room_members(room_id,principal_type,principal_id,joined_at)
        SELECT NEW.id,'user',user_id,NEW.created_at FROM local_console WHERE singleton=1;
    END;
    CREATE TABLE after_trig (id TEXT PRIMARY KEY);
  `;
  const split = splitSqlStatements(triggerSql);
  assert.equal(split.length, 2, "trigger body semicolons must not split trigger statement");
  const stmts = translateSqliteToPgStatements(triggerSql);
  assert.equal(stmts.length, 4);
  assert.match(stmts[0].sql, /CREATE OR REPLACE FUNCTION local_reader_for_new_room_fn\(\) RETURNS TRIGGER/);
  assert.match(stmts[0].sql, /ON CONFLICT DO NOTHING/);
  assert.match(stmts[1].sql, /DROP TRIGGER IF EXISTS local_reader_for_new_room ON rooms/);
  assert.match(stmts[2].sql, /CREATE TRIGGER local_reader_for_new_room AFTER INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION/);
});

test("PG 18 live: PgDatabaseSync CRUD, COUNT(*) number type, transactions, savepoint error recovery, trigger, citext, json_*", (t) => {
  const db = openDatabase(":memory:", { pgUrl: PG_URL });
  t.after(() => db.close());
  assert.equal(isPgDatabase(db), true);

  // COUNT(*) returns JS number, not string/bigint
  const countRow = db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: unknown };
  assert.equal(typeof countRow.n, "number");
  assert.equal(countRow.n, 0);

  // Store constructor exercises BEGIN IMMEDIATE, COMMIT, local_console, and local_reader_for_new_room trigger
  const store = new Store(db);
  const user = store.localUser();
  const room = store.createRoom(user, "PG测试频道", "topic");
  const members = db
    .prepare("SELECT principal_id FROM room_members WHERE room_id = ? AND principal_type = 'user'")
    .all(room.id) as Array<{ principal_id: string }>;
  assert.equal(members.some((m) => m.principal_id === user.id), true, "trigger should auto-add local_console user");

  // Direct INSERT INTO rooms without app code should still trigger local_reader_for_new_room
  const directRoomId = "room_direct_trigger_test";
  db.prepare(
    "INSERT INTO rooms(id, org_id, name, topic, created_by, created_at) VALUES (?, ?, '直插频道', '', ?, ?)",
  ).run(directRoomId, store.listRooms(user.id)[0].org_id, user.id, new Date().toISOString());
  const triggerMember = db
    .prepare("SELECT 1 AS ok FROM room_members WHERE room_id = ? AND principal_type = 'user' AND principal_id = ?")
    .get(directRoomId, user.id);
  assert.ok(triggerMember, "PG trigger local_reader_for_new_room must fire on raw INSERT INTO rooms");

  // Transaction + rollback + savepoint recovery on caught error
  assert.equal(db.isTransaction, false);
  db.exec("BEGIN IMMEDIATE");
  assert.equal(db.isTransaction, true);
  db.prepare("INSERT INTO orgs(id, name, created_at) VALUES (?, ?, ?)").run("org_tx_1", "TxOrg", new Date().toISOString());
  assert.throws(() => {
    // Duplicate PK inside transaction — should NOT poison transaction due to savepoint
    db.prepare("INSERT INTO orgs(id, name, created_at) VALUES (?, ?, ?)").run("org_tx_1", "Dup", new Date().toISOString());
  });
  // Transaction remains usable after caught error!
  db.prepare("INSERT INTO orgs(id, name, created_at) VALUES (?, ?, ?)").run("org_tx_2", "TxOrg2", new Date().toISOString());
  db.exec("ROLLBACK");
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT 1 FROM orgs WHERE id = ?").get("org_tx_1"), undefined);
  assert.equal(db.prepare("SELECT 1 FROM orgs WHERE id = ?").get("org_tx_2"), undefined);

  // json_extract, json_valid, json_array_length, instr, sqlite_glob
  const jsonCheck = db
    .prepare(
      `SELECT
        json_extract('{"a":{"b":"hello"},"arr":[10,20],"flag":true}', '$.a.b') AS str_val,
        json_extract('{"a":{"b":"hello"},"arr":[10,20]}', '$.arr[1]') AS arr_val,
        json_valid('{"ok":1}') AS valid_ok,
        json_valid('{broken') AS valid_bad,
        CASE WHEN json_valid('{"ok":1}') THEN 'yes' ELSE 'no' END AS valid_branch,
        json_array_length('[1,2,3]') AS len1,
        json_array_length('{"events":[1,2,3,4]}', '$.events') AS len2,
        instr(lower('Hello PG18'), lower('pg18')) AS pos`,
    )
    .get() as Record<string, unknown>;
  assert.equal(jsonCheck.str_val, "hello");
  assert.equal(jsonCheck.arr_val, "20");
  assert.equal(jsonCheck.valid_ok, true);
  assert.equal(jsonCheck.valid_bad, false);
  assert.equal(jsonCheck.valid_branch, "yes");
  assert.equal(jsonCheck.len1, 3);
  assert.equal(jsonCheck.len2, 4);
  assert.equal(jsonCheck.pos, 7);

  // CITEXT case-insensitive PK & FK across projects / project_repositories / company_project_repos
  const projects = new ProjectStore(db);
  projects.create({ name: "opc-os" });
  projects.sync({
    name: "opc-os",
    repository: {
      fullName: "Magele758/Agent-Chatroom",
      url: "https://github.com/Magele758/Agent-Chatroom",
      visibility: "public",
      owner: "Magele758",
      fork: false,
      openIssues: 1,
      openPullRequests: 0,
      latestRelease: null,
      syncedAt: new Date().toISOString(),
      items: [],
    },
  });
  const repoRow = db
    .prepare("SELECT full_name FROM project_repositories WHERE full_name = ?")
    .get("magele758/agent-chatroom") as { full_name: string } | undefined;
  assert.equal(repoRow?.full_name, "Magele758/Agent-Chatroom");

  // DomainEventBus: BIGSERIAL + lastInsertRowid
  const bus = new DomainEventBus(db);
  const e1 = bus.emit({ topic: "pg.test", sourceDomain: "ops", payload: { ok: true } });
  const e2 = bus.emit({ topic: "pg.test", sourceDomain: "ops", payload: { ok: 2 } });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(bus.totalCount(), 2);

  // OpportunityStore: GENERATED ALWAYS AS (round(...)) STORED
  const opportunities = new OpportunityStore(db);
  const opp = opportunities.add({
    project: "opc-os",
    sourceId: "pg-test:1",
    kind: "feature",
    title: "PG generated column test",
    rationale: "verify score computation",
    evidence: ["README.md"],
    impact: 5,
    confidence: 4,
    effort: 3,
  });
  assert.equal(opp.score, 6.67);

  // CompanyStore + SecurityReviews (json_array_length + ORDER BY rowid DESC) + StageWorkStore (json_each + json_group_array)
  const company = new CompanyStore(db);
  company.createProject({ product: "opc-os", name: "core", repos: ["magele758/agent-chatroom"] });
  const security = new SecurityReviews(db);
  const review = security.create({
    id: "11111111-1111-4111-8111-111111111111",
    product: "opc-os",
    project: "core",
    scope: "PG 18 migration security review",
  });
  const decided = security.decide(review.id, {
    revision: 0,
    outcome: "passed",
    note: "All checks passed on PG 18",
    evidence: "pg-db.test.ts",
  });
  assert.equal(decided.history.length, 1);

  const stageWork = new StageWorkStore(db);
  const createdWork = stageWork.create({
    requestId: "req-pg-1",
    product: "opc-os",
    project: "core",
    stage: "development",
    templateId: "inbox-delegation",
    title: "PG stage work check",
    goal: "Verify json_each and json_group_array",
    inputs: "none",
    deliverable: "green test",
    acceptance: "all pass",
    target: "coding-agent",
    requestedAgent: "Codex",
  });
  const listed = stageWork.list({ requestedAgent: "codex" });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, createdWork.work.id);
  assert.deepEqual(listed.items[0].evidence, []);

  // ExecutiveReceiptTracer on PG
  const tracer = new ExecutiveReceiptTracer(db, "home", "founder");
  assert.deepEqual(tracer.sourceTraces(), {});
});

test("PG 18 live: createPgPool supports native async queries, pgvector, pg_trgm, and BIGINT->number", async () => {
  const pool = createPgPool(PG_URL);
  try {
    const extRes = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'citext', 'pg_trgm') ORDER BY extname",
    );
    assert.deepEqual(
      extRes.rows.map((r: { extname: string }) => r.extname),
      ["citext", "pg_trgm", "vector"],
    );

    const vecRes = await pool.query(
      "SELECT ('[1,0,0]'::vector(3) <=> '[0,1,0]'::vector(3)) AS dist, COUNT(*) AS cnt",
    );
    assert.equal(vecRes.rows[0].dist, 1);
    assert.equal(typeof vecRes.rows[0].cnt, "number");
    assert.equal(vecRes.rows[0].cnt, 1);
  } finally {
    await pool.end();
  }
});

test("PG 18 live: isolated PgDatabaseSync schemas do not leak tables across instances", () => {
  const a = new PgDatabaseSync({
    connectionString: PG_URL,
    schema: `opc_iso_a_${process.pid}`,
    createSchema: true,
    dropSchemaOnClose: true,
  });
  const b = new PgDatabaseSync({
    connectionString: PG_URL,
    schema: `opc_iso_b_${process.pid}`,
    createSchema: true,
    dropSchemaOnClose: true,
  });
  try {
    a.exec("CREATE TABLE iso_only (id TEXT PRIMARY KEY)");
    assert.ok(a.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='iso_only'").get());
    assert.equal(b.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='iso_only'").get(), undefined);
  } finally {
    a.close();
    b.close();
  }
});

test("PG 18 live: migrate-sqlite-to-pg migrates fixture SQLite idempotently with 100% row reconciliation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opc-pg-migrate-test-"));
  const sqliteFile = join(dir, "fixture.db");
  const testSchema = `opc_mig_test_${process.pid}_${Date.now()}`;
  const pool = createPgPool(PG_URL);
  t.after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`).catch(() => {});
    await pool.end();
  });

  // Build a multi-table SQLite fixture with FKs, AUTOINCREMENT, CITEXT/COLLATE NOCASE, generated column, trigger
  const src = new DatabaseSync(sqliteFile);
  src.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE rooms (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE local_console (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), user_id TEXT NOT NULL REFERENCES users(id), room_id TEXT NOT NULL REFERENCES rooms(id));
    CREATE TABLE room_members (room_id TEXT NOT NULL REFERENCES rooms(id), principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (room_id, principal_type, principal_id));
    CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
    CREATE TABLE projects (name TEXT PRIMARY KEY);
    CREATE TABLE project_repositories (full_name TEXT NOT NULL PRIMARY KEY COLLATE NOCASE, project TEXT NOT NULL REFERENCES projects(name), snapshot TEXT NOT NULL);
    CREATE TABLE opc_opportunities (id TEXT PRIMARY KEY, impact INTEGER NOT NULL, confidence INTEGER NOT NULL, effort INTEGER NOT NULL, score REAL GENERATED ALWAYS AS (round(impact * confidence * 1.0 / effort, 2)) STORED);
    CREATE TRIGGER local_reader_for_new_room AFTER INSERT ON rooms
    WHEN EXISTS (SELECT 1 FROM local_console WHERE singleton=1)
    BEGIN
      INSERT OR IGNORE INTO room_members(room_id,principal_type,principal_id,joined_at)
        SELECT NEW.id,'user',user_id,NEW.created_at FROM local_console WHERE singleton=1;
    END;
    INSERT INTO orgs VALUES ('o1', 'OPC', '2026-01-01T00:00:00Z');
    INSERT INTO users VALUES ('u1', 'Founder', 'founder', '2026-01-01T00:00:00Z');
    INSERT INTO rooms VALUES ('r1', 'o1', 'Hall', 'u1', '2026-01-01T00:00:00Z');
    INSERT INTO local_console VALUES (1, 'u1', 'r1');
    INSERT INTO room_members VALUES ('r1', 'user', 'u1', '2026-01-01T00:00:00Z');
    INSERT INTO inbox (body) VALUES ('first'), ('second');
    INSERT INTO projects VALUES ('opc-os');
    INSERT INTO project_repositories VALUES ('Owner/Repo', 'opc-os', '{}');
    INSERT INTO opc_opportunities (id, impact, confidence, effort) VALUES ('opp1', 5, 4, 3);
  `);
  src.close();

  const { migrateSqliteToPg } = await import("../scripts/migrate-sqlite-to-pg.mjs");
  const first = await migrateSqliteToPg({ sqlitePath: sqliteFile, pgUrl: PG_URL, schema: testSchema });
  assert.equal(first.ok, true);
  assert.equal(first.tableCount, 9);
  assert.equal(first.matchedTables, 9);
  assert.equal(first.totalSqliteRows, first.totalPgRows);

  // Re-run idempotently: row counts must stay 100% identical
  const second = await migrateSqliteToPg({ sqlitePath: sqliteFile, pgUrl: PG_URL, schema: testSchema });
  assert.equal(second.ok, true);
  assert.equal(second.matchedTables, 9);
  assert.equal(second.totalPgRows, first.totalPgRows);

  // Verify sequence sync & generated column & trigger work after migration
  const oppRes = await pool.query(`SELECT score FROM "${testSchema}".opc_opportunities WHERE id = 'opp1'`);
  assert.equal(oppRes.rows[0].score, 6.67);
  const nextInbox = await pool.query(`INSERT INTO "${testSchema}".inbox (body) VALUES ('third') RETURNING id`);
  assert.equal(nextInbox.rows[0].id, 3, "BIGSERIAL sequence should continue at MAX(id) + 1");
});

test("PG 18 live: opc-backup creates and verifies pg_dump custom archive alongside files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opc-pg-backup-test-"));
  const outArchive = join(dir, "pg-backup.tar.gz");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const backup = createBackup({
    rootDir: dir,
    homeDir: dir,
    env: { OPC_PG_URL: PG_URL },
    outPath: outArchive,
    verify: true,
  });
  assert.equal(backup.ok, true);
  assert.equal(backup.verified, true);
  assert.equal(backup.postgresCount, 1);
  assert.equal(backup.slots.some((s) => s.id === "opc-postgres"), true);

  const verified = verifyBackup({ archivePath: outArchive, env: { OPC_PG_URL: PG_URL } });
  assert.equal(verified.ok, true);
  assert.equal(verified.checkedPostgres, 1);
});

test("PG 18 live: ExecutiveBotService mergeLinkedMailHistory ON CONFLICT DO UPDATE resolves qualified snapshot column cleanly", (t) => {
  const schema = `test_pg_exec_hist_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const db = new PgDatabaseSync({
    connectionString: PG_URL,
    schema,
    createSchema: true,
    dropSchemaOnClose: true,
  });
  t.after(() => db.close());

  db.exec(`
    CREATE TABLE IF NOT EXISTS opc_executive_mail_history (
      user_id TEXT NOT NULL,
      connection TEXT NOT NULL,
      mail_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      PRIMARY KEY (user_id, connection, mail_id)
    );
  `);
  const upsert = db.prepare(`INSERT INTO opc_executive_mail_history(user_id,connection,mail_id,snapshot) VALUES(?,?,?,?)
    ON CONFLICT(user_id,connection,mail_id) DO UPDATE SET snapshot=excluded.snapshot
    WHERE opc_executive_mail_history.snapshot<>excluded.snapshot`);

  upsert.run("u1", "conn1", "m1", JSON.stringify({ id: "m1", v: 1 }));
  // Same snapshot -> no-op without 42702 ambiguous column error
  upsert.run("u1", "conn1", "m1", JSON.stringify({ id: "m1", v: 1 }));
  // Changed snapshot -> updates cleanly
  upsert.run("u1", "conn1", "m1", JSON.stringify({ id: "m1", v: 2 }));

  const row = db
    .prepare("SELECT snapshot FROM opc_executive_mail_history WHERE user_id=? AND connection=? AND mail_id=?")
    .get("u1", "conn1", "m1") as { snapshot: string } | undefined;
  assert.ok(row);
  assert.equal(JSON.parse(row.snapshot).v, 2);
});
