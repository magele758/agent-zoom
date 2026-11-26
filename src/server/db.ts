import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PgDatabaseSync,
  createPgPool,
  deriveTestSchemaForPath,
  isPgDatabase,
  isTempDatabasePath,
  resolvePgUrl,
} from "./pg-db.ts";

export { PgDatabaseSync, createPgPool, isPgDatabase, resolvePgUrl };

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");

function isExistingSqliteFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const bytes = readSync(fd, buf, 0, SQLITE_HEADER.length, 0);
    return bytes === SQLITE_HEADER.length && buf.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export interface OpenDatabaseOptions {
  pgUrl?: string;
  schema?: string;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  current_topic TEXT NOT NULL DEFAULT '',
  general INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  direct INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_console (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  user_id TEXT NOT NULL REFERENCES users(id),
  room_id TEXT NOT NULL REFERENCES rooms(id)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  handle TEXT NOT NULL,
  runtime TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  paused INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  inbox_cursor INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, handle)
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, principal_type, principal_id)
);

-- Keep the shared room reader present even if an older local client creates a room.
CREATE TRIGGER IF NOT EXISTS local_reader_for_new_room AFTER INSERT ON rooms
WHEN EXISTS (SELECT 1 FROM local_console WHERE singleton=1)
BEGIN
  INSERT OR IGNORE INTO room_members(room_id,principal_type,principal_id,joined_at)
    SELECT NEW.id,'user',user_id,NEW.created_at FROM local_console WHERE singleton=1;
END;

CREATE TABLE IF NOT EXISTS join_codes (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by_agent_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  addressed_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (room_id, seq)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  message_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_question_replies (
  question_id TEXT PRIMARY KEY REFERENCES messages(id),
  reply_id TEXT NOT NULL UNIQUE REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS task_claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  state TEXT NOT NULL,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_implementer
  ON task_claims(task_id) WHERE role = 'implementer' AND state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_tester
  ON task_claims(task_id) WHERE role = 'tester' AND state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_reviewer_agent
  ON task_claims(task_id, agent_id) WHERE role = 'reviewer' AND state = 'active';

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_recipient ON inbox(recipient_type, recipient_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_stage_offer ON inbox(ref_id) WHERE event_type='stage_offer';


CREATE TABLE IF NOT EXISTS desktop_bridges (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  thread_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  after_id INTEGER NOT NULL,
  last_poll_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_receipts (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  event_id INTEGER NOT NULL REFERENCES inbox(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(agent_id,event_id)
);

CREATE TABLE IF NOT EXISTS file_locks (
  org_id TEXT NOT NULL,
  path TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  lease_until TEXT NOT NULL,
  PRIMARY KEY (org_id, path)
);

CREATE TABLE IF NOT EXISTS coordinator_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  plan_json TEXT,
  error TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  trace_json TEXT NOT NULL DEFAULT '[]',
  transcript_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS coordinator_one_running ON coordinator_runs(user_id, room_id) WHERE status='running';

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_active_attempt ON workflow_claims(task_id) WHERE state='active';

CREATE TABLE IF NOT EXISTS zoom_tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  folder TEXT NOT NULL,
  context TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source, external_id)
);
CREATE TABLE IF NOT EXISTS zoom_messages (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES zoom_tasks(id),
  event_key TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  choices TEXT,
  reply_to TEXT UNIQUE REFERENCES zoom_messages(id),
  choice TEXT,
  actor TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, event_key)
);
CREATE INDEX IF NOT EXISTS zoom_feedback ON zoom_messages(task_id,seq) WHERE kind='reply';
CREATE INDEX IF NOT EXISTS zoom_messages_task_seq ON zoom_messages(task_id,seq);
CREATE INDEX IF NOT EXISTS zoom_messages_kind_seq ON zoom_messages(kind,seq);
CREATE INDEX IF NOT EXISTS workflow_runs_created ON workflow_runs(created_at DESC, id);
CREATE TABLE IF NOT EXISTS stage_work (
  task_id TEXT PRIMARY KEY REFERENCES zoom_tasks(id),
  request_id TEXT NOT NULL UNIQUE,
  brief TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES stage_work(task_id),
  role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id,agent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stage_one_active_owner ON stage_claims(task_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS stage_receipts (
  task_id TEXT NOT NULL REFERENCES stage_work(task_id),
  event_key TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES stage_claims(id),
  PRIMARY KEY(task_id,event_key)
);
`;

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const pgUrl = resolvePgUrl(options.pgUrl);
  if (pgUrl) {
    // Keep SQLite fallback only when a test explicitly creates a legacy SQLite fixture file on disk in tmpdir
    // and passes that file to openDatabase() to verify legacy SQLite migration.
    const isLegacySqliteFixture =
      path !== ":memory:" && !options.schema && isTempDatabasePath(path) && isExistingSqliteFile(path);
    if (!isLegacySqliteFixture) {
      const target = options.schema
        ? { schema: options.schema, createSchema: options.schema !== "public", dropSchemaOnClose: false }
        : deriveTestSchemaForPath(path);
      const db = new PgDatabaseSync({
        connectionString: pgUrl,
        schema: target.schema,
        createSchema: target.createSchema,
        dropSchemaOnClose: target.dropSchemaOnClose,
      }) as unknown as DatabaseSync;
      db.exec(SCHEMA);
      migrate(db);
      return db;
    }
  }

  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  const columnCache = new Map<string, Set<string>>();
  const names = (table: string) => {
    let set = columnCache.get(table);
    if (!set) {
      set = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      columnCache.set(table, set);
    }
    return set;
  };
  const add = (table: string, column: string, definition: string) => {
    const cols = names(table);
    if (!cols.has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      cols.add(column);
    }
  };
  add("messages", "design_group", "design_group TEXT NOT NULL DEFAULT ''");
  add("zoom_tasks", "stage", "stage TEXT");
  add("zoom_messages", "evidence", "evidence TEXT");
  add("zoom_messages", "requires_approval", "requires_approval INTEGER NOT NULL DEFAULT 0");
  add("messages", "reply_group", "reply_group TEXT NOT NULL DEFAULT ''");
  add("room_members", "hidden", "hidden INTEGER NOT NULL DEFAULT 0");
  add("agents", "tags", "tags TEXT NOT NULL DEFAULT ''");
  add("agents", "level", "level INTEGER NOT NULL DEFAULT 1");
  add("tasks", "complex", "complex INTEGER NOT NULL DEFAULT 0");
  add("tasks", "acceptance", "acceptance TEXT NOT NULL DEFAULT ''");
  add("tasks", "mode", "mode TEXT NOT NULL DEFAULT 'single'");
  add("tasks", "max_lanes", "max_lanes INTEGER NOT NULL DEFAULT 1");
  add("tasks", "tags", "tags TEXT NOT NULL DEFAULT ''");
  add("tasks", "parent_id", "parent_id TEXT");
  add("tasks", "lane", "lane INTEGER");
  add("tasks", "bid_until", "bid_until TEXT");
  add("tasks", "direction", "direction TEXT NOT NULL DEFAULT ''");
  add("tasks", "deliverable_ref", "deliverable_ref TEXT");
  add("tasks", "deliverable_summary", "deliverable_summary TEXT");
  add("tasks", "winner_task_id", "winner_task_id TEXT");
  add("agents", "level", "level INTEGER NOT NULL DEFAULT 1");
  add("tasks", "complex", "complex INTEGER NOT NULL DEFAULT 0");
  add("tasks", "review_returns", "review_returns INTEGER NOT NULL DEFAULT 0");
  add("rooms", "project", "project TEXT NOT NULL DEFAULT ''");
  add("rooms", "directories", "directories TEXT NOT NULL DEFAULT '[]'");
  add("rooms", "branch", "branch TEXT NOT NULL DEFAULT ''");
  add("rooms", "current_topic", "current_topic TEXT NOT NULL DEFAULT ''");
  add("rooms", "general", "general INTEGER NOT NULL DEFAULT 0");
  add("rooms", "archived", "archived INTEGER NOT NULL DEFAULT 0");
  add("rooms", "direct", "direct INTEGER NOT NULL DEFAULT 0");
  add("agents", "machine", "machine TEXT NOT NULL DEFAULT ''");
  add("agents", "cwd", "cwd TEXT NOT NULL DEFAULT ''");
  add("tasks", "design_pending", "design_pending TEXT NOT NULL DEFAULT ''");
  add("tasks", "pipeline_id", "pipeline_id TEXT");
  add("tasks", "step_index", "step_index INTEGER");
  add("tasks", "step_role", "step_role TEXT");
  add("tasks", "assignee_handle", "assignee_handle TEXT NOT NULL DEFAULT ''");
  add("tasks", "handles_json", "handles_json TEXT NOT NULL DEFAULT '[]'");
  add("tasks", "steps_json", "steps_json TEXT NOT NULL DEFAULT ''");
  add("tasks", "deliverable_body", "deliverable_body TEXT");
  add("tasks", "gate", "gate INTEGER NOT NULL DEFAULT 0");
  add("tasks", "qa_returns", "qa_returns INTEGER NOT NULL DEFAULT 0");
  add("tasks", "cross_returns", "cross_returns INTEGER NOT NULL DEFAULT 0");
  add("tasks", "offer_until", "offer_until TEXT");
  add("tasks", "offer_index", "offer_index INTEGER");
  add("tasks", "claim_timeout_ms", "claim_timeout_ms INTEGER NOT NULL DEFAULT 120000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_conclusions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      verdict TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, handle)
    );
    CREATE TABLE IF NOT EXISTS bids (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      approach TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, agent_id)
    );
  `);
  markGeneralRooms(db);
}

function markGeneralRooms(db: DatabaseSync) {
  const orgs = db.prepare("SELECT id FROM orgs").all() as Array<{ id: string }>;
  const roomsInOrg = db.prepare("SELECT id, created_at FROM rooms WHERE org_id = ?");
  const generalRoom = db.prepare("SELECT id FROM rooms WHERE org_id = ? AND general = 1 LIMIT 1");
  const markGeneral = db.prepare("UPDATE rooms SET general = 1 WHERE id = ?");
  for (const org of orgs) {
    if (generalRoom.get(org.id)) continue;
    const rooms = roomsInOrg.all(org.id) as Array<{ id: string; created_at: string }>;
    if (rooms.length === 0) continue;
    rooms.sort((left, right) => {
      if (left.created_at < right.created_at) return -1;
      if (left.created_at > right.created_at) return 1;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    });
    markGeneral.run(rooms[0].id);
  }
}
