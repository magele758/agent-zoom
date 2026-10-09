import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS file_locks (
  org_id TEXT NOT NULL,
  path TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  lease_until TEXT NOT NULL,
  PRIMARY KEY (org_id, path)
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  const names = (table: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
  const add = (table: string, column: string, definition: string) => {
    if (!names(table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  };
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
  add("agents", "machine", "machine TEXT NOT NULL DEFAULT ''");
  add("agents", "cwd", "cwd TEXT NOT NULL DEFAULT ''");
  db.exec(`
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
