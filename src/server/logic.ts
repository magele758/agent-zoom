import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";

export const LEASE_MS = 10 * 60 * 1000;
export const LOCK_MS = 120_000;
const JOIN_MS = 30 * 60 * 1000;
const BID_MS = 8_000;
const REVIEWER_LIMIT = 3;
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;
export const STRONG_LEVEL = 3;
const LEVEL_WEIGHT = 4;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Principal =
  | { type: "user"; id: string; name: string }
  | { type: "agent"; id: string; handle: string; ownerUserId: string; orgId: string; paused: boolean };

export type Role = "implementer" | "reviewer" | "tester";

export type RoomScope = { project: string; directories: string[]; branch: string };

export type RoomChannel = RoomScope & {
  topic: string;
  currentTopic: string;
  general: boolean;
  archived: boolean;
  direct: boolean;
};

type RoomRecord = {
  id: string;
  org_id: string;
  name: string;
  topic: string;
  current_topic: string;
  general: number;
  archived: number;
  direct: number;
  project: string;
  directories: string;
  branch: string;
  created_at: string;
};

type InboxKind = "mention" | "thread" | "task_open" | "bid_open" | "awarded" | "bid_lost" | "review_needed" | "test_needed" | "dispute";

type TaskRow = {
  id: string;
  room_id: string;
  message_id: string;
  title: string;
  body: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  acceptance: string;
  mode: string;
  max_lanes: number;
  tags: string;
  complex: number;
  parent_id: string | null;
  lane: number | null;
  bid_until: string | null;
  direction: string;
  deliverable_ref: string | null;
  deliverable_summary: string | null;
  winner_task_id: string | null;
  review_returns: number;
};

export type TaskView = {
  id: string;
  roomId: string;
  title: string;
  body: string;
  status: string;
  acceptance: string;
  mode: string;
  maxLanes: number;
  tags: string;
  complex: boolean;
  parentId: string | null;
  lane: number | null;
  direction: string;
  deliverableRef: string | null;
  deliverableSummary: string | null;
  winnerTaskId: string | null;
  bidUntil: string | null;
  scope: RoomScope;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  claims: Array<{
    role: string;
    state: string;
    handle: string;
    agentId: string;
    ownerName: string;
    leaseUntil: string;
  }>;
  lanes: TaskView[];
};

export type Hooks = {
  onInbox?: (key: string) => void;
  onRoom?: (roomId: string) => void;
};

type Addressed = { type: "agent"; id: string; handle: string };

const nowIso = () => new Date().toISOString();
const uuid = () => randomUUID();

function nameKey(name: string) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function plus(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

const ROLE_LABEL: Record<Role, string> = {
  implementer: "实现",
  reviewer: "评审",
  tester: "测试",
};

function parseTags(value: string | null | undefined) {
  return [...new Set(String(value ?? "").toLowerCase().split(/[\s,，]+/).filter(Boolean))].slice(0, 8);
}

const DIRECTORY_LIMIT = 8;
const TOPIC_LIMIT = 250;

function trimTopic(value: string) {
  return value.trim().slice(0, TOPIC_LIMIT);
}

function trimCurrentTopic(value: unknown) {
  return String(value ?? "").replace(/[\r\n\0]/g, "").trim().slice(0, TOPIC_LIMIT);
}

function cleanLine(value: unknown, max: number) {
  return String(value ?? "").replace(/[\r\n\0]/g, " ").trim().slice(0, max);
}

function parseDirectories(value: unknown) {
  const raw = Array.isArray(value) ? value.map((item) => String(item)) : String(value ?? "").split(/[\n,，]+/);
  const directories: string[] = [];
  for (const item of raw) {
    const path = item.trim().replaceAll("\\", "/");
    if (!path) continue;
    if (path.length > 200) throw new ApiError(400, "bad_path", "单个目录最多 200 个字符");
    if (!directories.includes(path)) directories.push(path);
  }
  if (directories.length > DIRECTORY_LIMIT) throw new ApiError(400, "bad_scope", "一个频道最多 8 个目录");
  return directories;
}

function readDirectories(stored: string | null | undefined) {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean).slice(0, DIRECTORY_LIMIT);
  } catch {
    return stored.split("\n").map((item) => item.trim()).filter(Boolean).slice(0, DIRECTORY_LIMIT);
  }
  return [];
}

function scopeFrom(row: { project?: string | null; directories?: string | null; branch?: string | null }): RoomScope {
  return {
    project: row.project ?? "",
    directories: readDirectories(row.directories),
    branch: row.branch ?? "",
  };
}

function scopeLabel(scope: RoomScope) {
  const parts = [
    scope.project ? `项目 ${scope.project}` : "",
    scope.directories.length ? `目录 ${scope.directories.join("、")}` : "",
    scope.branch ? `分支 ${scope.branch}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join("。")}。` : "未指定项目和目录。";
}

function clampLevel(value: unknown) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return MIN_LEVEL;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, n));
}

function tagsMatch(wanted: string[], have: string[]) {
  if (wanted.length === 0) return true;
  return wanted.some((tag) => have.includes(tag));
}

export function openStore(path: string) {
  return new Store(openDatabase(path));
}

export class Store {
  hooks: Hooks = {};
  private pendingInbox: string[] = [];
  private dirtyRooms = new Set<string>();

  constructor(readonly db: DatabaseSync) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already closed */
      }
      this.pendingInbox = [];
      this.dirtyRooms.clear();
      throw error;
    }
  }

  private flush() {
    const inbox = this.pendingInbox;
    const rooms = [...this.dirtyRooms];
    this.pendingInbox = [];
    this.dirtyRooms.clear();
    for (const key of inbox) this.hooks.onInbox?.(key);
    for (const roomId of rooms) {
      if (roomId) this.hooks.onRoom?.(roomId);
    }
  }

  private queue(recipientType: string, recipientId: string) {
    this.pendingInbox.push(`${recipientType}:${recipientId}`);
  }

  touchSeen(agentId: string) {
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(nowIso(), agentId);
  }

  session(name: string) {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean || clean.length > 40) throw new ApiError(400, "bad_name", "名字需要 1 到 40 个字");
    const key = nameKey(clean);
    const result = this.transaction(() => {
      let user = this.db.prepare("SELECT * FROM users WHERE name_key = ?").get(key) as
        | { id: string; name: string }
        | undefined;
      if (!user) {
        user = { id: uuid(), name: clean };
        this.db
          .prepare("INSERT INTO users (id, name, name_key, created_at) VALUES (?, ?, ?, ?)")
          .run(user.id, clean, key, nowIso());
      }
      const membership = this.db
        .prepare("SELECT org_id FROM org_members WHERE user_id = ? LIMIT 1")
        .get(user.id) as { org_id: string } | undefined;
      let orgId = membership?.org_id;
      let roomId: string | null = null;
      if (!orgId) {
        orgId = uuid();
        const created = nowIso();
        this.db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").run(orgId, "工作室", created);
        this.db
          .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')")
          .run(orgId, user.id);
        roomId = uuid();
        this.db
          .prepare(
            "INSERT INTO rooms (id, org_id, name, topic, general, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
          )
          .run(
            roomId,
            orgId,
            "大厅",
            "把需求发在这里。在场的 agent 自己认领，别的 agent 负责评审和测试。",
            user.id,
            created,
          );
        this.addRoomMember(roomId, "user", user.id);
        this.seedDemo(orgId, user.id, roomId);
      }
      const token = `ses_${randomBytes(24).toString("base64url")}`;
      this.db
        .prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
        .run(token, user.id, nowIso());
      return { token, user, orgId, roomId };
    });
    this.flush();
    return result;
  }

  private seedDemo(orgId: string, ownerId: string, roomId: string) {
    const cast = [
      ["builder", "build"],
      ["maker", "build"],
      ["reviewer", "review"],
      ["qa", "test"],
    ];
    for (const [handle, tags] of cast) {
      const id = uuid();
      const token = `agt_${randomBytes(24).toString("base64url")}`;
      this.db
        .prepare(
          `INSERT INTO agents
           (id, org_id, owner_user_id, handle, runtime, token_hash, tags, paused, demo, created_at)
           VALUES (?, ?, ?, ?, 'demo', ?, ?, 0, 1, ?)`,
        )
        .run(id, orgId, ownerId, handle, hashToken(token), tags, nowIso());
      this.addRoomMember(roomId, "agent", id);
    }
  }

  ensureDemoCast() {
    const builders = this.db
      .prepare("SELECT id, org_id, owner_user_id FROM agents WHERE demo = 1 AND handle = 'builder'")
      .all() as Array<{ id: string; org_id: string; owner_user_id: string }>;
    for (const builder of builders) {
      const maker = this.db
        .prepare("SELECT id FROM agents WHERE org_id = ? AND handle = 'maker'")
        .get(builder.org_id) as { id: string } | undefined;
      if (!maker) {
        const id = uuid();
        const token = `agt_${randomBytes(24).toString("base64url")}`;
        this.db
          .prepare(
            `INSERT INTO agents
             (id, org_id, owner_user_id, handle, runtime, token_hash, tags, paused, demo, created_at)
             VALUES (?, ?, ?, 'maker', 'demo', ?, 'build', 0, 1, ?)`,
          )
          .run(id, builder.org_id, builder.owner_user_id, hashToken(token), nowIso());
        const rooms = this.db
          .prepare("SELECT room_id FROM room_members WHERE principal_type = 'agent' AND principal_id = ?")
          .all(builder.id) as Array<{ room_id: string }>;
        for (const room of rooms) this.addRoomMember(room.room_id, "agent", id);
      }
    }
    this.db.prepare("UPDATE agents SET tags = 'build' WHERE demo = 1 AND handle IN ('builder', 'maker') AND tags = ''").run();
    this.db.prepare("UPDATE agents SET tags = 'review' WHERE demo = 1 AND handle = 'reviewer' AND tags = ''").run();
    this.db.prepare("UPDATE agents SET tags = 'test' WHERE demo = 1 AND handle = 'qa' AND tags = ''").run();
  }

  userBySession(token: string | undefined): Principal | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      )
      .get(token) as { id: string; name: string } | undefined;
    return row ? { type: "user", id: row.id, name: row.name } : null;
  }

  agentByToken(token: string | undefined): Principal | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT id, handle, owner_user_id, org_id, paused FROM agents WHERE token_hash = ?`,
      )
      .get(hashToken(token)) as
      | { id: string; handle: string; owner_user_id: string; org_id: string; paused: number }
      | undefined;
    if (!row) return null;
    return {
      type: "agent",
      id: row.id,
      handle: row.handle,
      ownerUserId: row.owner_user_id,
      orgId: row.org_id,
      paused: row.paused === 1,
    };
  }

  logout(token: string | undefined) {
    if (!token) return;
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  me(user: Principal & { type: "user" }) {
    const orgs = this.db
      .prepare(
        `SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?`,
      )
      .all(user.id) as Array<{ id: string; name: string; role: string }>;
    const rooms = this.listRooms(user.id);
    const agents = this.db
      .prepare(
        `SELECT id, handle, runtime, paused, demo, level, org_id, last_seen_at FROM agents WHERE owner_user_id = ? ORDER BY created_at`,
      )
      .all(user.id);
    return { user: { id: user.id, name: user.name }, orgs, rooms, agents };
  }

  listRooms(userId: string) {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.org_id, r.name, r.topic, r.current_topic, r.general, r.archived, r.direct,
                r.project, r.directories, r.branch, r.created_at
         FROM rooms r
         JOIN room_members m ON m.room_id = r.id
         WHERE m.principal_type = 'user' AND m.principal_id = ?
         ORDER BY r.created_at`,
      )
      .all(userId) as RoomRecord[];
    return rows.map((row) => ({
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      created_at: row.created_at,
      ...this.channelView(row),
    }));
  }

  createRoom(
    user: Principal & { type: "user" },
    name: string,
    topic: string,
    scope: { project?: unknown; directories?: unknown; branch?: unknown; currentTopic?: unknown } = {},
  ) {
    const clean = name.trim();
    if (!clean || clean.length > 40) throw new ApiError(400, "bad_name", "频道名需要 1 到 40 个字");
    const org = this.db
      .prepare("SELECT org_id FROM org_members WHERE user_id = ? ORDER BY role DESC LIMIT 1")
      .get(user.id) as { org_id: string } | undefined;
    if (!org) throw new ApiError(400, "no_org", "还没有工作室");
    const topicText = trimTopic(topic);
    const currentTopic = trimCurrentTopic(scope.currentTopic);
    const project = cleanLine(scope.project, 80);
    const branch = cleanLine(scope.branch, 200);
    const directories = parseDirectories(scope.directories);
    const room = this.transaction(() => {
      const id = uuid();
      this.db
        .prepare(
          `INSERT INTO rooms
             (id, org_id, name, topic, current_topic, project, directories, branch, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, org.org_id, clean, topicText, currentTopic, project, JSON.stringify(directories), branch, user.id, nowIso());
      this.addRoomMember(id, "user", user.id);
      return {
        id,
        name: clean,
        org_id: org.org_id,
        topic: topicText,
        currentTopic,
        general: false,
        archived: false,
        direct: false,
        project,
        directories,
        branch,
      };
    });
    this.flush();
    return room;
  }

  setScope(
    user: Principal & { type: "user" },
    roomId: string,
    input: { project?: unknown; directories?: unknown; branch?: unknown },
  ) {
    this.assertMember(user, roomId);
    const current = scopeFrom(this.roomRow(roomId));
    const next: RoomScope = {
      project: input.project === undefined ? current.project : cleanLine(input.project, 80),
      directories: input.directories === undefined ? current.directories : parseDirectories(input.directories),
      branch: input.branch === undefined ? current.branch : cleanLine(input.branch, 200),
    };
    const same =
      next.project === current.project &&
      next.branch === current.branch &&
      next.directories.join("\n") === current.directories.join("\n");
    if (same) return { roomId, ...next };
    const result = this.transaction(() => {
      this.db
        .prepare("UPDATE rooms SET project = ?, directories = ?, branch = ? WHERE id = ?")
        .run(next.project, JSON.stringify(next.directories), next.branch, roomId);
      const summary = `工作范围已更新。${scopeLabel(next)}`;
      this.insertMessage({
        roomId,
        authorType: "system",
        authorId: "system",
        taskId: null,
        kind: "system",
        body: summary,
        addressed: [],
      });
      const holders = this.db
        .prepare(
          `SELECT c.agent_id, MIN(c.task_id) AS task_id
           FROM task_claims c
           JOIN tasks t ON t.id = c.task_id
           WHERE t.room_id = ? AND c.state = 'active'
           GROUP BY c.agent_id`,
        )
        .all(roomId) as Array<{ agent_id: string; task_id: string }>;
      for (const holder of holders) this.pushInbox(holder.agent_id, roomId, "thread", holder.task_id, summary);
      return { roomId, ...next };
    });
    this.flush();
    return result;
  }

  setChannelText(
    user: Principal & { type: "user" },
    roomId: string,
    input: { topic?: unknown; currentTopic?: unknown },
  ) {
    this.assertMember(user, roomId);
    const room = this.roomRow(roomId);
    const topic = input.topic === undefined ? room.topic : trimTopic(String(input.topic));
    const currentTopic = input.currentTopic === undefined ? room.current_topic : trimCurrentTopic(input.currentTopic);
    if (topic !== room.topic || currentTopic !== room.current_topic) {
      this.db.prepare("UPDATE rooms SET topic = ?, current_topic = ? WHERE id = ?").run(topic, currentTopic, roomId);
      this.dirtyRooms.add(roomId);
      this.flush();
    }
    return this.roomView(user, roomId);
  }

  setArchived(user: Principal & { type: "user" }, roomId: string, archived: boolean) {
    this.assertMember(user, roomId);
    const room = this.roomRow(roomId);
    if (room.direct === 1) throw new ApiError(400, "direct_room", "私聊不用归档");
    if (room.general === 1 && archived) throw new ApiError(403, "general_room", "大厅不能归档");
    const next = archived ? 1 : 0;
    if (room.archived === next) return this.roomView(user, roomId);
    const result = this.transaction(() => {
      this.db.prepare("UPDATE rooms SET archived = ? WHERE id = ?").run(next, roomId);
      this.insertMessage({
        roomId,
        authorType: "system",
        authorId: "system",
        taskId: null,
        kind: "system",
        body: archived ? "频道已归档。历史还在，取消归档后可以继续发言。" : "频道已取消归档。",
        addressed: [],
      });
      return this.presentRoom(this.roomRow(roomId));
    });
    this.flush();
    return result;
  }

  roomView(user: Principal & { type: "user" }, roomId: string) {
    this.assertMember(user, roomId);
    return this.presentRoom(this.roomRow(roomId));
  }

  invite(user: Principal & { type: "user" }, roomId: string, name: string) {
    this.assertMember(user, roomId);
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean || clean.length > 40) throw new ApiError(400, "bad_name", "名字需要 1 到 40 个字");
    const room = this.roomRow(roomId);
    const result = this.transaction(() => {
      const key = nameKey(clean);
      let member = this.db.prepare("SELECT id, name FROM users WHERE name_key = ?").get(key) as
        | { id: string; name: string }
        | undefined;
      if (!member) {
        member = { id: uuid(), name: clean };
        this.db
          .prepare("INSERT INTO users (id, name, name_key, created_at) VALUES (?, ?, ?, ?)")
          .run(member.id, clean, key, nowIso());
      }
      this.db
        .prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'member')")
        .run(room.org_id, member.id);
      this.addRoomMember(roomId, "user", member.id);
      this.insertMessage({
        roomId,
        authorType: "system",
        authorId: "system",
        taskId: null,
        kind: "system",
        body: `${member.name} 加入了频道`,
        addressed: [],
      });
      return { id: member.id, name: member.name };
    });
    this.flush();
    return result;
  }

  createJoinCode(user: Principal & { type: "user" }, roomId: string) {
    this.assertMember(user, roomId);
    const room = this.roomRow(roomId);
    const code = `join_${randomBytes(9).toString("base64url")}`;
    const expiresAt = plus(JOIN_MS);
    this.db
      .prepare(
        `INSERT INTO join_codes (code, org_id, room_id, created_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(code, room.org_id, roomId, user.id, expiresAt, nowIso());
    return { code, expiresAt, roomId };
  }

  enroll(
    code: string,
    handle: string,
    runtime: string,
    tags = "",
    level: unknown = MIN_LEVEL,
    machine = "",
    cwd = "",
  ) {
    const cleanHandle = handle.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(cleanHandle)) {
      throw new ApiError(400, "bad_handle", "句柄要用小写字母开头，只含小写字母、数字和短横线");
    }
    const cleanRuntime = (runtime || "custom").trim().slice(0, 40) || "custom";
    const result = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM join_codes WHERE code = ?").get(code) as
        | {
            org_id: string;
            room_id: string;
            expires_at: string;
            used_by_agent_id: string | null;
            created_by: string;
          }
        | undefined;
      if (!row) throw new ApiError(404, "bad_code", "接入码不存在");
      if (row.used_by_agent_id) throw new ApiError(409, "code_used", "这个接入码已经用过了");
      if (row.expires_at < nowIso()) throw new ApiError(410, "code_expired", "接入码过期了，请重新生成");
      const taken = this.db
        .prepare("SELECT 1 FROM agents WHERE org_id = ? AND handle = ?")
        .get(row.org_id, cleanHandle);
      if (taken) throw new ApiError(409, "handle_taken", "这个句柄在工作室里已经有了");
      const id = uuid();
      const token = `agt_${randomBytes(24).toString("base64url")}`;
      const cleanTags = parseTags(tags).join(",");
      const cleanLevel = clampLevel(level);
      const cleanMachine = cleanLine(machine, 80);
      const cleanCwd = cleanLine(cwd, 200);
      this.db
        .prepare(
          `INSERT INTO agents
           (id, org_id, owner_user_id, handle, runtime, token_hash, tags, level, machine, cwd, paused, demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        )
        .run(
          id,
          row.org_id,
          row.created_by,
          cleanHandle,
          cleanRuntime,
          hashToken(token),
          cleanTags,
          cleanLevel,
          cleanMachine,
          cleanCwd,
          nowIso(),
        );
      this.db.prepare("UPDATE join_codes SET used_by_agent_id = ? WHERE code = ?").run(id, code);
      this.addRoomMember(row.room_id, "agent", id);
      this.insertMessage({
        roomId: row.room_id,
        authorType: "system",
        authorId: "system",
        taskId: null,
        kind: "system",
        body: `${cleanHandle} 接入了频道（${cleanRuntime}）${cleanMachine ? `，机器 ${cleanMachine}` : ""}${cleanCwd ? `，目录 ${cleanCwd}` : ""}`,
        addressed: [],
      });
      this.refreshOpen(row.room_id);
      return {
        token,
        agent: {
          id,
          handle: cleanHandle,
          runtime: cleanRuntime,
          orgId: row.org_id,
          level: cleanLevel,
          machine: cleanMachine,
          cwd: cleanCwd,
        },
        roomId: row.room_id,
      };
    });
    this.flush();
    return result;
  }

  setPlace(agent: Principal & { type: "agent" }, machine: unknown, cwd: unknown) {
    const cleanMachine = cleanLine(machine, 80);
    const cleanCwd = cleanLine(cwd, 200);
    this.db.prepare("UPDATE agents SET machine = ?, cwd = ? WHERE id = ?").run(cleanMachine, cleanCwd, agent.id);
    return { machine: cleanMachine, cwd: cleanCwd };
  }

  setPaused(user: Principal & { type: "user" }, agentId: string, paused: boolean) {
    const row = this.db
      .prepare("SELECT owner_user_id, org_id FROM agents WHERE id = ?")
      .get(agentId) as { owner_user_id: string } | undefined;
    if (!row) throw new ApiError(404, "no_agent", "没有这个 agent");
    if (row.owner_user_id !== user.id) throw new ApiError(403, "not_owner", "只能暂停自己接入的 agent");
    this.db.prepare("UPDATE agents SET paused = ? WHERE id = ?").run(paused ? 1 : 0, agentId);
    return { id: agentId, paused };
  }

  setLevel(user: Principal & { type: "user" }, agentId: string, level: unknown) {
    const next = clampLevel(level);
    const result = this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT a.handle, a.level FROM agents a
           JOIN org_members m ON m.org_id = a.org_id AND m.user_id = ?
           WHERE a.id = ?`,
        )
        .get(user.id, agentId) as { handle: string; level: number } | undefined;
      if (!row) throw new ApiError(404, "no_agent", "没有这个 agent");
      if (row.level === next) return { id: agentId, level: next };
      this.db.prepare("UPDATE agents SET level = ? WHERE id = ?").run(next, agentId);
      const rooms = this.db
        .prepare("SELECT room_id FROM room_members WHERE principal_type = 'agent' AND principal_id = ?")
        .all(agentId) as Array<{ room_id: string }>;
      for (const room of rooms) {
        this.insertMessage({
          roomId: room.room_id,
          authorType: "system",
          authorId: "system",
          taskId: null,
          kind: "system",
          body: `${user.name} 把 ${row.handle} 的等级从 ${row.level} 调到 ${next}`,
          addressed: [],
        });
        this.refreshOpen(room.room_id);
      }
      return { id: agentId, level: next };
    });
    this.flush();
    return result;
  }

  snapshot(principal: Principal, roomId: string, onlineUserIds: ReadonlySet<string>) {
    this.assertMember(principal, roomId);
    if (principal.type === "agent") this.touchSeen(principal.id);
    const room = this.roomRow(roomId);
    const members = this.membersOf(roomId, onlineUserIds);
    const messages = this.decorateMessages(roomId, 0, 300);
    const tasks = this.tasksInRoom(roomId);
    const locks = this.locksForOrg(room.org_id);
    return {
      room: { id: room.id, orgId: room.org_id, name: room.name, ...this.channelView(room) },
      members,
      messages,
      tasks,
      locks,
    };
  }

  readMessages(principal: Principal, roomId: string, afterSeq: number, limit = 100) {
    this.assertMember(principal, roomId);
    return this.decorateMessages(roomId, afterSeq, Math.min(limit, 200));
  }

  postMessage(
    principal: Principal,
    roomId: string,
    input: {
      body: string;
      kind?: string;
      taskId?: string | null;
      acceptance?: string;
      parallel?: boolean;
      tags?: string;
      complex?: boolean;
    },
  ) {
    this.assertMember(principal, roomId);
    if (this.roomRow(roomId).archived === 1) {
      throw new ApiError(409, "archived", "这个频道已归档，先取消归档再发言");
    }
    const kind = input.kind ?? "chat";
    const body = input.body?.trim() ?? "";
    if (!body) throw new ApiError(400, "empty", "内容是空的");
    if (body.length > 8000) throw new ApiError(400, "too_long", "一条消息最多 8000 字");
    if (["progress", "direction", "blocked", "decision"].includes(kind) && body.length > 280) {
      throw new ApiError(400, "too_long", "方向、卡住、决定和进度最多 280 字");
    }
    if (principal.type === "user" && !["chat", "instruction", "question"].includes(kind)) {
      throw new ApiError(400, "bad_kind", "人可以发言、提问或下指令");
    }
    if (
      principal.type === "agent" &&
      !["chat", "question", "progress", "direction", "blocked", "decision"].includes(kind)
    ) {
      throw new ApiError(400, "bad_kind", "agent 可以发言、提问、写方向、说卡住、记一个决定。交付用 deliver");
    }
    if (kind === "instruction" && principal.type !== "user") {
      throw new ApiError(403, "human_only", "只有人能下指令");
    }
    if (kind === "instruction" && this.roomRow(roomId).direct === 1) {
      throw new ApiError(400, "direct_room", "私聊里不能下指令。指令请发到频道。");
    }
    const addressed = this.resolveMentions(roomId, body);
    const acceptance = (input.acceptance?.trim() || body).slice(0, 2000);
    const tags = parseTags(input.tags).join(",");
    const parallel = Boolean(input.parallel);
    const complex = Boolean(input.complex);
    const result = this.transaction(() => {
      let taskId = input.taskId ?? null;
      if (kind === "instruction") taskId = null;
      let current: TaskRow | null = null;
      if (taskId) {
        current = this.taskRow(taskId);
        if (current.room_id !== roomId) throw new ApiError(400, "wrong_room", "任务不在这个频道");
      }
      if (["progress", "direction", "blocked", "decision"].includes(kind)) {
        if (!taskId || !current) throw new ApiError(400, "need_task", "这条更新要挂在任务上");
        if (principal.type !== "agent" || !this.activeClaim(taskId, "implementer", principal.id)) {
          throw new ApiError(403, "not_implementer", "只有当前实现者能更新这条任务");
        }
      }
      const createdTaskId = kind === "instruction" ? uuid() : null;
      const title = createdTaskId ? titleFrom(body) : "";
      const message = this.insertMessage({
        roomId,
        authorType: principal.type,
        authorId: principal.id,
        taskId: createdTaskId ?? taskId,
        kind,
        body,
        addressed,
      });
      let task = null;
      if (createdTaskId) {
        this.insertTask({
          id: createdTaskId,
          roomId,
          messageId: message.id,
          title,
          body,
          createdBy: principal.id,
          acceptance,
          mode: parallel ? "parallel" : "single",
          maxLanes: parallel ? 3 : 1,
          tags,
          complex,
        });
        this.db.prepare("UPDATE rooms SET current_topic = ? WHERE id = ?").run(title, roomId);
        this.announce(createdTaskId);
        task = this.publicTask(createdTaskId);
      }
      if (current && taskId && (kind === "progress" || kind === "direction") && current.status === "claimed") {
        this.setStatus(taskId, "working");
      }
      if (current && taskId && kind === "direction") {
        this.db.prepare("UPDATE tasks SET direction = ?, updated_at = ? WHERE id = ?").run(body, nowIso(), taskId);
      }
      if (current && taskId && kind === "decision" && current.parent_id) {
        this.wakeSiblings(current, body);
      }
      if (!createdTaskId && taskId) task = this.publicTask(taskId);
      this.fanout({
        roomId,
        author: principal,
        message,
        addressed,
        taskId: message.task_id,
      });
      return { message: this.decorateOne(message.id), task };
    });
    this.flush();
    return result;
  }

  claim(agent: Principal & { type: "agent" }, taskId: string, role: Role) {
    if (!["implementer", "reviewer", "tester"].includes(role)) {
      throw new ApiError(400, "bad_role", "槽位只能是 implementer、reviewer 或 tester");
    }
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(agent, task.room_id);
      this.assertRoomOpen(task.room_id);
      const implementer = this.holder(taskId, "implementer");
      if ((role === "reviewer" || role === "tester") && implementer === agent.id) {
        throw new ApiError(403, "own_work", "实现者不能评审或测试自己的任务");
      }
      if (role === "implementer" || role === "tester") {
        const existing = this.holder(taskId, role);
        if (existing) throw new ApiError(409, "already_claimed", `这个槽位在 ${this.handleOf(existing)} 手上`);
      }
      if (role === "reviewer" && this.activeClaim(taskId, "reviewer", agent.id)) {
        throw new ApiError(409, "already_claimed", "你已经在评审这条任务");
      }
      if (role === "implementer" && !tagsMatch(parseTags(task.tags), this.agentTags(agent.id))) {
        throw new ApiError(403, "not_eligible", "标签不匹配，这条任务不交给你");
      }
      if (role === "implementer" && task.status === "open" && this.levelBlocked(task, agent.id)) {
        throw new ApiError(403, "level_low", "复杂任务先交给等级 3 以上的 agent");
      }
      if (role === "implementer" && task.status === "bidding") {
        throw new ApiError(409, "bid_first", "正在投标，用 bid 写下做法");
      }
      if (role === "implementer" && task.status !== "open") {
        throw new ApiError(409, "bad_state", "这条任务现在不能认领实现");
      }
      if (role === "reviewer" && task.status !== "in_review") {
        throw new ApiError(409, "bad_state", "还没到评审");
      }
      if (role === "tester" && task.status !== "in_test") {
        throw new ApiError(409, "bad_state", "还没到测试");
      }
      if (role === "reviewer") {
        const count = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND role = 'reviewer' AND state = 'active'`,
          )
          .get(taskId) as { n: number };
        if (count.n >= REVIEWER_LIMIT) throw new ApiError(409, "reviewers_full", "评审人已经满了");
      }
      this.insertClaim(taskId, role, agent.id);
      if (role === "implementer") this.setStatus(taskId, "claimed");
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "system",
        authorId: "system",
        taskId,
        kind: "system",
        body: `${agent.handle} 认领了${ROLE_LABEL[role]}`,
        addressed: [],
      });
      this.fanout({
        roomId: task.room_id,
        author: { type: "agent", id: agent.id },
        message,
        addressed: [],
        taskId,
      });
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  bid(agent: Principal & { type: "agent" }, taskId: string, approach: string) {
    const text = approach.trim();
    if (!text) throw new ApiError(400, "empty", "写上两到三句做法");
    if (text.length > 280) throw new ApiError(400, "too_long", "做法最多 280 字");
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(agent, task.room_id);
      this.assertRoomOpen(task.room_id);
      if (task.status !== "bidding") throw new ApiError(409, "bad_state", "现在不在投标");
      if (!task.bid_until || task.bid_until < nowIso()) throw new ApiError(409, "bid_closed", "投标已经截止");
      if (!this.eligibleAgents(task).some((item) => item.id === agent.id)) {
        throw new ApiError(403, "not_eligible", "只有空闲、未暂停且标签匹配的 agent 能投标");
      }
      if (this.levelBlocked(task, agent.id)) {
        throw new ApiError(403, "level_low", "复杂任务先交给等级 3 以上的 agent");
      }
      try {
        this.db
          .prepare("INSERT INTO bids (id, task_id, agent_id, approach, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(uuid(), taskId, agent.id, text, nowIso());
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("UNIQUE")) throw new ApiError(409, "already_bid", "你已经投过这条");
        throw error;
      }
      this.insertMessage({
        roomId: task.room_id,
        authorType: "agent",
        authorId: agent.id,
        taskId,
        kind: "bid",
        body: text,
        addressed: [],
      });
      const eligible = this.eligibleAgents(task);
      const bids = this.bidsFor(taskId);
      if (eligible.length > 0 && eligible.every((item) => bids.some((bid) => bid.agent_id === item.id))) {
        this.award(taskId);
      }
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  deliver(agent: Principal & { type: "agent" }, taskId: string, ref: string, summary: string) {
    const cleanRef = ref.trim();
    const text = summary.trim();
    if (!cleanRef || cleanRef.length > 200) throw new ApiError(400, "bad_ref", "交付要有一条引用，最多 200 字");
    if (!text || text.length > 1000) throw new ApiError(400, "bad_summary", "交付说明需要 1 到 1000 字");
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(agent, task.room_id);
      this.assertRoomOpen(task.room_id);
      if (!this.activeClaim(taskId, "implementer", agent.id)) {
        throw new ApiError(403, "not_implementer", "只有实现者能交付");
      }
      if (!["claimed", "working", "changes"].includes(task.status)) {
        throw new ApiError(409, "bad_state", "现在不能交付");
      }
      this.db
        .prepare("UPDATE tasks SET deliverable_ref = ?, deliverable_summary = ?, updated_at = ? WHERE id = ?")
        .run(cleanRef, text, nowIso(), taskId);
      this.setStatus(taskId, "in_review");
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "agent",
        authorId: agent.id,
        taskId,
        kind: "deliverable",
        body: `${cleanRef}\n${text}`,
        addressed: [],
      });
      this.fanout({ roomId: task.room_id, author: agent, message, addressed: [], taskId });
      this.wakeChecks(task.room_id, taskId, "review_needed", `请检查「${task.title}」。交付 ${cleanRef}`);
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  getTask(principal: Principal, taskId: string) {
    const task = this.taskRow(taskId);
    this.assertMember(principal, task.room_id);
    if (principal.type === "agent") this.touchSeen(principal.id);
    return this.presentTask(task);
  }

  heartbeat(agent: Principal & { type: "agent" }, taskId: string) {
    const task = this.taskRow(taskId);
    this.assertMember(agent, task.room_id);
    const claims = this.db
      .prepare(
        `SELECT id FROM task_claims WHERE task_id = ? AND agent_id = ? AND state = 'active'`,
      )
      .all(taskId, agent.id) as Array<{ id: string }>;
    if (claims.length === 0) throw new ApiError(403, "not_holder", "你没有这条任务的槽位");
    const until = plus(LEASE_MS);
    this.db
      .prepare(
        `UPDATE task_claims SET lease_until = ?, updated_at = ? WHERE task_id = ? AND agent_id = ? AND state = 'active'`,
      )
      .run(until, nowIso(), taskId, agent.id);
    this.touchSeen(agent.id);
    return { leaseUntil: until };
  }

  markReady(_agent: Principal & { type: "agent" }, _taskId: string) {
    throw new ApiError(400, "use_deliver", "改用 deliver 提交交付引用和说明，不能空着手进评审");
  }

  review(agent: Principal & { type: "agent" }, taskId: string, verdict: string, body: string) {
    if (!["approve", "request_changes", "question"].includes(verdict)) {
      throw new ApiError(400, "bad_verdict", "评审结论是 approve、request_changes 或 question");
    }
    const text = body.trim();
    if (!text) throw new ApiError(400, "empty", "写上评审意见");
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(agent, task.room_id);
      this.assertRoomOpen(task.room_id);
      if (task.status !== "in_review") throw new ApiError(409, "bad_state", "现在不在评审");
      if (!this.activeClaim(taskId, "reviewer", agent.id)) {
        throw new ApiError(403, "not_reviewer", "先认领评审槽位");
      }
      const implementer = this.holder(taskId, "implementer");
      const kind = verdict === "question" ? "question" : "review";
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "agent",
        authorId: agent.id,
        taskId,
        kind,
        body: text,
        addressed: [],
      });
      if (verdict === "approve") {
        this.finishClaim(taskId, "reviewer", agent.id, "completed");
        this.setStatus(taskId, "in_test");
        this.wakeChecks(task.room_id, taskId, "test_needed", `请测试「${task.title}」`);
        if ((task.review_returns ?? 0) === 0) {
          this.nudgeLevel(implementer, 1, task.room_id, taskId, "交付的任务一次评审通过");
        }
      } else if (verdict === "request_changes") {
        this.finishClaim(taskId, "reviewer", agent.id, "changes");
        this.clearDeliverable(taskId);
        this.setStatus(taskId, "changes");
        this.db
          .prepare("UPDATE tasks SET review_returns = COALESCE(review_returns, 0) + 1, updated_at = ? WHERE id = ?")
          .run(nowIso(), taskId);
        this.nudgeLevel(implementer, -1, task.room_id, taskId, "交付被打回");
      }
      this.fanout({
        roomId: task.room_id,
        author: agent,
        message,
        addressed: [],
        taskId,
      });
      this.offerChecks(agent.id);
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  reportTest(agent: Principal & { type: "agent" }, taskId: string, verdict: string, body: string) {
    if (!["pass", "fail"].includes(verdict)) throw new ApiError(400, "bad_verdict", "测试结论是 pass 或 fail");
    const text = body.trim();
    if (!text) throw new ApiError(400, "empty", "写上测试结果");
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(agent, task.room_id);
      this.assertRoomOpen(task.room_id);
      if (task.status !== "in_test") throw new ApiError(409, "bad_state", "现在不在测试");
      if (!this.activeClaim(taskId, "tester", agent.id)) throw new ApiError(403, "not_tester", "先认领测试槽位");
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "agent",
        authorId: agent.id,
        taskId,
        kind: "test_result",
        body: text,
        addressed: [],
      });
      this.finishClaim(taskId, "tester", agent.id, "completed");
      if (verdict === "pass") {
        this.setStatus(taskId, "done");
        this.finishRole(taskId, "implementer", "completed");
      } else {
        this.clearDeliverable(taskId);
        this.setStatus(taskId, "changes");
      }
      this.fanout({
        roomId: task.room_id,
        author: agent,
        message,
        addressed: [],
        taskId,
      });
      if (task.parent_id && verdict === "pass") this.converge(task.parent_id);
      this.offerChecks(agent.id);
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  release(agent: Principal & { type: "agent" }, taskId: string, role: Role) {
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(agent, task.room_id);
      if (!this.activeClaim(taskId, role, agent.id)) throw new ApiError(403, "not_holder", "你没有这个槽位");
      this.finishClaim(taskId, role, agent.id, "released");
      let reopened = false;
      if (role === "implementer" && ["claimed", "working", "changes"].includes(task.status)) {
        this.setStatus(taskId, "open");
        reopened = true;
      }
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "system",
        authorId: "system",
        taskId,
        kind: "system",
        body: `${agent.handle} 放开了${ROLE_LABEL[role]}`,
        addressed: [],
      });
      this.fanout({
        roomId: task.room_id,
        author: agent,
        message,
        addressed: [],
        taskId,
      });
      if (reopened) this.announce(taskId);
      this.offerChecks(agent.id);
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  cancel(user: Principal & { type: "user" }, taskId: string) {
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(user, task.room_id);
      if (["done", "canceled", "failed"].includes(task.status)) throw new ApiError(409, "bad_state", "这条任务已经结束");
      this.cancelTree(task, user.name);
      if (task.parent_id) this.converge(task.parent_id);
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  forceDone(user: Principal & { type: "user" }, taskId: string) {
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(user, task.room_id);
      if (task.status === "canceled" || task.status === "failed") {
        throw new ApiError(409, "bad_state", "已取消或失败的任务不能放行");
      }
      this.setStatus(taskId, "done");
      this.finishRole(taskId, "implementer", "completed");
      this.finishRole(taskId, "reviewer", "completed");
      this.finishRole(taskId, "tester", "completed");
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "system",
        authorId: "system",
        taskId,
        kind: "system",
        body: `${user.name} 放行了这条任务`,
        addressed: [],
      });
      this.fanout({ roomId: task.room_id, author: user, message, addressed: [], taskId });
      if (task.parent_id) this.converge(task.parent_id);
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  lockFile(agent: Principal & { type: "agent" }, path: string, taskId?: string | null) {
    const clean = cleanPath(path);
    if (taskId) {
      const task = this.taskRow(taskId);
      if (task.room_id && this.roomRow(task.room_id).org_id !== agent.orgId) {
        throw new ApiError(403, "wrong_org", "任务不在你的工作室");
      }
    }
    const until = plus(LOCK_MS);
    const existing = this.db
      .prepare("SELECT agent_id, lease_until FROM file_locks WHERE org_id = ? AND path = ?")
      .get(agent.orgId, clean) as { agent_id: string; lease_until: string } | undefined;
    if (existing && existing.agent_id !== agent.id && existing.lease_until > nowIso()) {
      throw new ApiError(409, "locked", `这个路径锁在 ${this.handleOf(existing.agent_id)} 手上`);
    }
    this.db
      .prepare(
        `INSERT INTO file_locks (org_id, path, agent_id, task_id, lease_until)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, path) DO UPDATE SET
           agent_id = excluded.agent_id,
           task_id = excluded.task_id,
           lease_until = excluded.lease_until`,
      )
      .run(agent.orgId, clean, agent.id, taskId ?? null, until);
    this.dirtyRooms.add(this.anyRoom(agent.orgId) ?? "");
    this.flush();
    return { path: clean, leaseUntil: until };
  }

  unlockFile(agent: Principal & { type: "agent" }, path: string) {
    const clean = cleanPath(path);
    const existing = this.db
      .prepare("SELECT agent_id FROM file_locks WHERE org_id = ? AND path = ?")
      .get(agent.orgId, clean) as { agent_id: string } | undefined;
    if (!existing) return { path: clean, released: false };
    if (existing.agent_id !== agent.id) throw new ApiError(403, "not_holder", "这把锁不是你的");
    this.db.prepare("DELETE FROM file_locks WHERE org_id = ? AND path = ?").run(agent.orgId, clean);
    return { path: clean, released: true };
  }

  takePending(agentId: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(agentId) as
        | { inbox_cursor: number }
        | undefined;
      if (!row) throw new ApiError(404, "no_agent", "没有这个 agent");
      const events = this.inboxAfter(agentId, row.inbox_cursor);
      if (events.length > 0) {
        this.db
          .prepare("UPDATE agents SET inbox_cursor = ? WHERE id = ?")
          .run(events[events.length - 1].id, agentId);
      }
      return events;
    });
  }

  inboxAfter(agentId: string, after: number) {
    return this.db
      .prepare(
        `SELECT id, room_id, event_type, ref_id, summary, created_at
         FROM inbox WHERE recipient_type = 'agent' AND recipient_id = ? AND id > ?
         ORDER BY id LIMIT 50`,
      )
      .all(agentId, after) as Array<{
      id: number;
      room_id: string;
      event_type: string;
      ref_id: string;
      summary: string;
      created_at: string;
    }>;
  }

  whoami(agent: Principal & { type: "agent" }) {
    const rooms = this.db
      .prepare(
        `SELECT r.id, r.name, r.topic, r.current_topic, r.general, r.archived, r.direct, r.project, r.directories, r.branch
         FROM rooms r
         JOIN room_members m ON m.room_id = r.id
         WHERE m.principal_type = 'agent' AND m.principal_id = ?`,
      )
      .all(agent.id) as Array<{
      id: string;
      name: string;
      topic: string;
      current_topic: string;
      general: number;
      archived: number;
      direct: number;
      project: string;
      directories: string;
      branch: string;
    }>;
    const place = this.db.prepare("SELECT machine, cwd FROM agents WHERE id = ?").get(agent.id) as
      | { machine: string; cwd: string }
      | undefined;
    return {
      id: agent.id,
      handle: agent.handle,
      orgId: agent.orgId,
      paused: agent.paused,
      level: this.agentLevel(agent.id),
      tags: this.agentTags(agent.id).join(","),
      machine: place?.machine ?? "",
      cwd: place?.cwd ?? "",
      rooms: rooms.map((room) => ({ id: room.id, name: room.name, ...this.channelView(room) })),
      visibility:
        "频道历史只有该频道的成员能读。私聊和私有小群只有参与者能读。wait 会推送点名、私聊、投标、中标、评审、测试和你占着的任务线程。不推送无关闲聊，也不塞进整段历史。",
    };
  }

  listPeers(agent: Principal & { type: "agent" }) {
    const peers = this.db
      .prepare(
        `SELECT DISTINCT a.id, a.handle, a.level, a.tags, a.machine, a.cwd, a.paused, a.last_seen_at
         FROM agents a
         JOIN room_members theirs ON theirs.principal_type = 'agent' AND theirs.principal_id = a.id
         JOIN room_members mine ON mine.room_id = theirs.room_id AND mine.principal_type = 'agent' AND mine.principal_id = ?
         JOIN rooms r ON r.id = mine.room_id AND r.direct = 0 AND r.archived = 0
         WHERE a.id != ?
         ORDER BY a.handle`,
      )
      .all(agent.id, agent.id) as Array<{
      id: string;
      handle: string;
      level: number;
      tags: string;
      machine: string;
      cwd: string;
      paused: number;
      last_seen_at: string | null;
    }>;
    const sharedRooms = this.db.prepare(
      `SELECT DISTINCT r.id, r.name
       FROM rooms r
       JOIN room_members mine ON mine.room_id = r.id AND mine.principal_type = 'agent' AND mine.principal_id = ?
       JOIN room_members theirs ON theirs.room_id = r.id AND theirs.principal_type = 'agent' AND theirs.principal_id = ?
       WHERE r.direct = 0 AND r.archived = 0
       ORDER BY r.created_at`,
    );
    const working = this.db.prepare(
      `SELECT t.id AS task_id, t.title, t.status, t.room_id, r.name AS room_name, c.role
       FROM task_claims c
       JOIN tasks t ON t.id = c.task_id
       JOIN rooms r ON r.id = t.room_id
       WHERE c.agent_id = ? AND c.state = 'active' AND t.status NOT IN ('done', 'canceled', 'failed')
       ORDER BY t.updated_at DESC`,
    );
    const fresh = Date.now() - 20_000;
    return peers.map((peer) => ({
      id: peer.id,
      handle: peer.handle,
      level: peer.level,
      tags: peer.tags ?? "",
      machine: peer.machine ?? "",
      cwd: peer.cwd ?? "",
      paused: peer.paused === 1,
      online: peer.paused !== 1 && !!peer.last_seen_at && Date.parse(peer.last_seen_at) > fresh,
      rooms: sharedRooms.all(agent.id, peer.id) as Array<{ id: string; name: string }>,
      working: (working.all(peer.id) as Array<{
        task_id: string;
        title: string;
        status: string;
        room_id: string;
        room_name: string;
        role: string;
      }>).map((task) => ({
        taskId: task.task_id,
        title: task.title,
        status: task.status,
        role: task.role,
        roomId: task.room_id,
        roomName: task.room_name,
      })),
    }));
  }

  ask(agent: Principal & { type: "agent" }, input: { handle?: unknown; handles?: unknown; body: unknown }) {
    const raw = [
      ...(Array.isArray(input.handles) ? input.handles : []),
      ...(input.handle == null || input.handle === "" ? [] : [input.handle]),
    ];
    const handles = [
      ...new Set(raw.map((item) => String(item).trim().toLowerCase().replace(/^@/, "")).filter(Boolean)),
    ];
    if (handles.length < 1 || handles.length > 6) {
      throw new ApiError(400, "bad_handles", "私聊要指定 1 到 6 个句柄");
    }
    if (handles.includes(agent.handle)) throw new ApiError(400, "bad_handles", "不用问自己");
    const body = String(input.body ?? "").trim();
    if (!body) throw new ApiError(400, "empty", "内容是空的");
    if (body.length > 8000) throw new ApiError(400, "too_long", "一条消息最多 8000 字");
    const peers = this.listPeers(agent);
    const targets = handles.map((handle) => {
      const peer = peers.find((item) => item.handle === handle);
      if (!peer) throw new ApiError(404, "no_peer", `你和 ${handle} 不在同一个频道，不能私聊`);
      return peer;
    });
    const room = this.openConversation(agent, targets.map((peer) => peer.id));
    const posted = this.postMessage(agent, room.id, { kind: "question", body });
    return {
      roomId: room.id,
      direct: true,
      handles: [agent.handle, ...handles].sort(),
      message: posted.message,
    };
  }

  listTasks(principal: Principal, roomId: string) {
    this.assertMember(principal, roomId);
    return this.tasksInRoom(roomId);
  }

  reap(at = new Date()) {
    const iso = at.toISOString();
    const expired = this.db
      .prepare(
        `SELECT c.role, c.agent_id, c.task_id, t.room_id, t.status, a.handle
         FROM task_claims c
         JOIN tasks t ON t.id = c.task_id
         JOIN agents a ON a.id = c.agent_id
         WHERE c.state = 'active' AND c.lease_until IS NOT NULL AND c.lease_until < ?`,
      )
      .all(iso) as Array<{
      role: Role;
      agent_id: string;
      task_id: string;
      room_id: string;
      status: string;
      handle: string;
    }>;
    const dueBids = this.db
      .prepare(`SELECT id FROM tasks WHERE status = 'bidding' AND bid_until IS NOT NULL AND bid_until < ?`)
      .all(iso) as Array<{ id: string }>;
    const locks = this.db.prepare("SELECT org_id FROM file_locks WHERE lease_until < ?").all(iso) as Array<{
      org_id: string;
    }>;
    if (expired.length === 0 && locks.length === 0 && dueBids.length === 0) return { released: 0 };
    this.transaction(() => {
      for (const row of expired) {
        this.finishClaim(row.task_id, row.role, row.agent_id, "released");
        const reopen = row.role === "implementer" && ["claimed", "working", "changes"].includes(row.status);
        if (reopen) this.setStatus(row.task_id, "open");
        const message = this.insertMessage({
          roomId: row.room_id,
          authorType: "system",
          authorId: "system",
          taskId: row.task_id,
          kind: "system",
          body: `${row.handle} 的${ROLE_LABEL[row.role]}租约到期，槽位已放开`,
          addressed: [],
        });
        this.fanout({
          roomId: row.room_id,
          author: { type: "system", id: "system" },
          message,
          addressed: [],
          taskId: row.task_id,
        });
        if (reopen) this.announce(row.task_id);
        this.offerChecks(row.agent_id);
      }
      for (const bid of dueBids) {
        const task = this.taskRow(bid.id);
        if (task.status === "bidding") this.award(task.id);
      }
      this.db.prepare("DELETE FROM file_locks WHERE lease_until < ?").run(iso);
    });
    this.flush();
    return { released: expired.length };
  }

  private addRoomMember(roomId: string, type: string, id: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO room_members (room_id, principal_type, principal_id, joined_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(roomId, type, id, nowIso());
  }

  private openConversation(agent: Principal & { type: "agent" }, peerIds: string[]) {
    const ids = [...new Set([agent.id, ...peerIds])].sort();
    const existing = this.findDirectRoom(agent.orgId, ids);
    if (existing) return existing;
    const handles = ids.map((id) => this.handleOf(id)).sort();
    const name = handles.join("、").slice(0, 40);
    const result = this.transaction(() => {
      const id = uuid();
      this.db
        .prepare(
          `INSERT INTO rooms (id, org_id, name, topic, direct, created_by, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, agent.orgId, name, "只有参与者能看到的对话。", agent.ownerUserId, nowIso());
      const owners = new Set<string>();
      for (const memberId of ids) {
        this.addRoomMember(id, "agent", memberId);
        const owner = this.db.prepare("SELECT owner_user_id FROM agents WHERE id = ?").get(memberId) as {
          owner_user_id: string;
        };
        owners.add(owner.owner_user_id);
      }
      for (const ownerId of owners) this.addRoomMember(id, "user", ownerId);
      this.insertMessage({
        roomId: id,
        authorType: "system",
        authorId: "system",
        taskId: null,
        kind: "system",
        body: `这段对话只有 ${handles.join("、")} 能看到。频道里的其他人看不到。`,
        addressed: [],
      });
      return this.roomRow(id);
    });
    this.flush();
    return result;
  }

  private findDirectRoom(orgId: string, agentIds: string[]) {
    const wanted = agentIds.slice().sort().join("\0");
    const rooms = this.db.prepare("SELECT id FROM rooms WHERE org_id = ? AND direct = 1").all(orgId) as Array<{
      id: string;
    }>;
    const membersOf = this.db.prepare(
      `SELECT principal_id FROM room_members WHERE room_id = ? AND principal_type = 'agent'`,
    );
    for (const room of rooms) {
      const members = membersOf.all(room.id) as Array<{ principal_id: string }>;
      const key = members
        .map((item) => item.principal_id)
        .sort()
        .join("\0");
      if (key === wanted) return this.roomRow(room.id);
    }
    return null;
  }

  private assertRoomOpen(roomId: string) {
    if (this.roomRow(roomId).archived === 1) {
      throw new ApiError(409, "archived", "这个频道已归档，先取消归档再继续");
    }
  }

  private assertMember(principal: Principal, roomId: string) {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM room_members WHERE room_id = ? AND principal_type = ? AND principal_id = ?`,
      )
      .get(roomId, principal.type, principal.id);
    if (!row) throw new ApiError(403, "not_member", "你不在这个频道里");
  }

  private roomRow(roomId: string) {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as RoomRecord | undefined;
    if (!row) throw new ApiError(404, "no_room", "没有这个频道");
    return row;
  }

  private channelView(row: {
    topic: string;
    current_topic?: string | null;
    general?: number | null;
    archived?: number | null;
    direct?: number | null;
    project?: string | null;
    directories?: string | null;
    branch?: string | null;
  }): RoomChannel {
    return {
      topic: row.topic,
      currentTopic: row.current_topic ?? "",
      general: row.general === 1,
      archived: row.archived === 1,
      direct: row.direct === 1,
      ...scopeFrom(row),
    };
  }

  private presentRoom(row: RoomRecord) {
    return {
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      created_at: row.created_at,
      ...this.channelView(row),
    };
  }

  private taskRow(taskId: string) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) throw new ApiError(404, "no_task", "没有这条任务");
    return row;
  }

  private setStatus(taskId: string, status: string) {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), taskId);
    if (status !== "done" && status !== "canceled" && status !== "failed") return;
    const task = this.db.prepare("SELECT room_id, parent_id FROM tasks WHERE id = ?").get(taskId) as {
      room_id: string;
      parent_id: string | null;
    };
    if (task.parent_id) return;
    this.syncCurrentTopic(task.room_id);
  }

  private syncCurrentTopic(roomId: string) {
    const active = this.db
      .prepare(
        `SELECT title FROM tasks
         WHERE room_id = ? AND parent_id IS NULL AND status NOT IN ('done', 'canceled', 'failed')
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get(roomId) as { title: string } | undefined;
    const next = active?.title ?? "";
    const current = this.db.prepare("SELECT current_topic FROM rooms WHERE id = ?").get(roomId) as
      | { current_topic: string }
      | undefined;
    if (!current || current.current_topic === next) return;
    this.db.prepare("UPDATE rooms SET current_topic = ? WHERE id = ?").run(next, roomId);
    this.dirtyRooms.add(roomId);
  }

  private activeClaim(taskId: string, role: Role, agentId: string) {
    return this.db
      .prepare(
        `SELECT id FROM task_claims WHERE task_id = ? AND role = ? AND agent_id = ? AND state = 'active'`,
      )
      .get(taskId, role, agentId) as { id: string } | undefined;
  }

  private holder(taskId: string, role: Role) {
    const row = this.db
      .prepare(
        `SELECT agent_id FROM task_claims WHERE task_id = ? AND role = ? AND state = 'active' LIMIT 1`,
      )
      .get(taskId, role) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }

  private finishClaim(taskId: string, role: Role, agentId: string, state: string) {
    this.db
      .prepare(
        `UPDATE task_claims SET state = ?, updated_at = ? WHERE task_id = ? AND role = ? AND agent_id = ? AND state = 'active'`,
      )
      .run(state, nowIso(), taskId, role, agentId);
  }

  private finishRole(taskId: string, role: Role, state: string) {
    this.db
      .prepare(
        `UPDATE task_claims SET state = ?, updated_at = ? WHERE task_id = ? AND role = ? AND state = 'active'`,
      )
      .run(state, nowIso(), taskId, role);
  }

  private handleOf(agentId: string) {
    const row = this.db.prepare("SELECT handle FROM agents WHERE id = ?").get(agentId) as
      | { handle: string }
      | undefined;
    return row?.handle ?? "未知";
  }

  private insertTask(input: {
    id: string;
    roomId: string;
    messageId: string;
    title: string;
    body: string;
    createdBy: string;
    acceptance: string;
    mode: string;
    maxLanes: number;
    tags: string;
    complex: boolean;
  }) {
    const stamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, room_id, message_id, title, body, status, created_by, created_at, updated_at,
           acceptance, mode, max_lanes, tags, direction, complex
         ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, '', ?)`,
      )
      .run(
        input.id,
        input.roomId,
        input.messageId,
        input.title,
        input.body,
        input.createdBy,
        stamp,
        stamp,
        input.acceptance,
        input.mode,
        input.maxLanes,
        input.tags,
        input.complex ? 1 : 0,
      );
    return this.publicTask(input.id);
  }

  private insertClaim(taskId: string, role: Role, agentId: string) {
    const stamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO task_claims (id, task_id, role, agent_id, state, lease_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(uuid(), taskId, role, agentId, plus(LEASE_MS), stamp, stamp);
  }

  private agentTags(agentId: string) {
    const row = this.db.prepare("SELECT tags FROM agents WHERE id = ?").get(agentId) as { tags: string } | undefined;
    return parseTags(row?.tags);
  }

  private agentLevel(agentId: string) {
    const row = this.db.prepare("SELECT level FROM agents WHERE id = ?").get(agentId) as { level: number } | undefined;
    return row?.level ?? MIN_LEVEL;
  }

  private levelBlocked(task: TaskRow, agentId: string) {
    if (!task.complex || this.agentLevel(agentId) >= STRONG_LEVEL) return false;
    if (!this.eligibleAgents(task).some((agent) => agent.level >= STRONG_LEVEL)) return false;
    return !this.resolveMentions(task.room_id, task.body).some((item) => item.id === agentId);
  }

  private isIdle(agentId: string) {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM task_claims WHERE agent_id = ? AND state = 'active' LIMIT 1")
      .get(agentId);
    return !row;
  }

  private loadOf(agentId: string) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM task_claims WHERE agent_id = ? AND state = 'active'")
      .get(agentId) as { n: number };
    return row.n;
  }

  private matchedIdle(task: TaskRow) {
    const wanted = parseTags(task.tags);
    const agents = this.db
      .prepare(
        `SELECT a.id, a.tags, a.level FROM agents a
         JOIN room_members m ON m.principal_id = a.id AND m.principal_type = 'agent'
         WHERE m.room_id = ? AND a.paused = 0`,
      )
      .all(task.room_id) as Array<{ id: string; tags: string; level: number }>;
    return agents.filter((agent) => tagsMatch(wanted, parseTags(agent.tags)) && this.isIdle(agent.id));
  }

  private eligibleAgents(task: TaskRow) {
    const matched = this.matchedIdle(task);
    if (!task.complex) return matched;
    const strong = matched.filter((agent) => agent.level >= STRONG_LEVEL);
    return strong.length > 0 ? strong : matched;
  }

  private bidsFor(taskId: string) {
    return this.db
      .prepare("SELECT id, agent_id, approach, created_at, rowid FROM bids WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as Array<{ id: string; agent_id: string; approach: string; created_at: string; rowid: number }>;
  }

  private cardSummary(
    task: { room_id?: string; title: string; body: string; acceptance?: string | null; lane?: number | null; complex?: number },
    prefix: string,
  ) {
    const acceptance = (task.acceptance || task.body || "").replace(/\s+/g, " ").slice(0, 80);
    const lane = task.lane ? `方案${task.lane}。` : "";
    const complex = task.complex ? "复杂。" : "";
    const scope = task.room_id ? scopeFrom(this.roomRow(task.room_id)) : { project: "", directories: [], branch: "" };
    const where = scope.project || scope.directories.length || scope.branch ? scopeLabel(scope) : "";
    return `${prefix}。${where}${complex}${lane}目标：${task.title}。验收：${acceptance}`;
  }

  private pushInbox(agentId: string, roomId: string, eventType: InboxKind, refId: string, summary: string) {
    this.db
      .prepare(
        `INSERT INTO inbox (recipient_type, recipient_id, room_id, event_type, ref_id, summary, created_at)
         VALUES ('agent', ?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, roomId, eventType, refId, summary.slice(0, 240), nowIso());
    this.queue("agent", agentId);
  }

  private announce(taskId: string) {
    const task = this.taskRow(taskId);
    if (task.status !== "open") return;
    const eligible = this.eligibleAgents(task);
    if (eligible.length >= 2) {
      const until = new Date(Date.now() + BID_MS).toISOString();
      this.db
        .prepare("UPDATE tasks SET status = 'bidding', bid_until = ?, updated_at = ? WHERE id = ?")
        .run(until, nowIso(), taskId);
      const narrowed = Boolean(task.complex) && this.matchedIdle(task).some((agent) => agent.level >= STRONG_LEVEL);
      const scope = !task.complex ? "" : narrowed ? "只包括等级 3 及以上。" : "没有等级 3 及以上的人，所以包括全体匹配者。";
      const scoreRule = task.complex ? "标签、负载和等级" : "标签和负载";
      this.insertMessage({
        roomId: task.room_id,
        authorType: "system",
        authorId: "system",
        taskId,
        kind: "system",
        body: `有 ${eligible.length} 位空闲 agent 能做。${scope}${Math.round(BID_MS / 1000)} 秒内用 bid 写两到三句做法，服务器按${scoreRule}授标。`,
        addressed: [],
      });
      for (const agent of eligible) {
        this.pushInbox(agent.id, task.room_id, "bid_open", taskId, this.cardSummary(task, "请投标"));
      }
      return;
    }
    for (const agent of eligible) {
      this.pushInbox(agent.id, task.room_id, "task_open", taskId, this.cardSummary(task, "新指令，可以直接认领"));
    }
  }

  private refreshOpen(roomId: string) {
    const tasks = this.db
      .prepare("SELECT id FROM tasks WHERE room_id = ? AND status = 'open' AND parent_id IS NULL")
      .all(roomId) as Array<{ id: string }>;
    for (const task of tasks) this.announce(task.id);
  }

  private award(taskId: string) {
    const task = this.taskRow(taskId);
    if (task.status !== "bidding") return;
    const bids = this.bidsFor(taskId);
    if (bids.length === 0) {
      this.db.prepare("UPDATE tasks SET status = 'open', bid_until = NULL, updated_at = ? WHERE id = ?").run(nowIso(), taskId);
      return;
    }
    const wanted = parseTags(task.tags);
    const eligible = new Set(this.eligibleAgents(task).map((agent) => agent.id));
    const openBids = bids.filter((bid) => eligible.has(bid.agent_id));
    if (openBids.length === 0) {
      this.db.prepare("UPDATE tasks SET status = 'open', bid_until = NULL, updated_at = ? WHERE id = ?").run(nowIso(), taskId);
      this.announce(taskId);
      return;
    }
    const ranked = openBids
      .map((bid) => {
        const have = this.agentTags(bid.agent_id);
        const overlap = wanted.filter((tag) => have.includes(tag)).length;
        const idle = this.isIdle(bid.agent_id) ? 1 : 0;
        const levelBonus = task.complex ? this.agentLevel(bid.agent_id) * LEVEL_WEIGHT : 0;
        const score = overlap * 10 + idle * 5 - this.loadOf(bid.agent_id) * 3 + levelBonus;
        return { ...bid, score };
      })
      .sort((a, b) => b.score - a.score || a.created_at.localeCompare(b.created_at) || a.rowid - b.rowid);
    this.db.prepare("UPDATE tasks SET bid_until = NULL, updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    if (task.mode === "parallel" && !task.parent_id) {
      const lanes = Math.min(3, Math.max(1, task.max_lanes || 1), ranked.length);
      const winners = ranked.slice(0, lanes);
      winners.forEach((bid, index) => {
        const lane = index + 1;
        const childId = uuid();
        const stamp = nowIso();
        this.db
          .prepare(
            `INSERT INTO tasks (
               id, room_id, message_id, title, body, status, created_by, created_at, updated_at,
               acceptance, mode, max_lanes, tags, complex, parent_id, lane, direction
             ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, 'single', 1, ?, ?, ?, ?, '')`,
          )
          .run(
            childId,
            task.room_id,
            task.message_id,
            `${task.title} · 方案${lane}`,
            task.body,
            task.created_by,
            stamp,
            stamp,
            task.acceptance,
            task.tags,
            task.complex ? 1 : 0,
            task.id,
            lane,
          );
        this.insertClaim(childId, "implementer", bid.agent_id);
        const child = this.taskRow(childId);
        this.pushInbox(
          bid.agent_id,
          task.room_id,
          "awarded",
          childId,
          this.cardSummary(child, "你中标实现。还有其他方案在并行，请自己隔离改动"),
        );
      });
      this.setStatus(task.id, "working");
      const names = winners.map((bid, index) => `${this.handleOf(bid.agent_id)} 做方案${index + 1}`).join("，");
      this.insertMessage({
        roomId: task.room_id,
        authorType: "system",
        authorId: "system",
        taskId: task.id,
        kind: "system",
        body: `授标：${names}。各自隔离改动，做完只交引用和说明。`,
        addressed: [],
      });
      const winnerIds = new Set(winners.map((bid) => bid.agent_id));
      for (const loser of bids) {
        if (winnerIds.has(loser.agent_id)) continue;
        this.pushInbox(loser.agent_id, task.room_id, "bid_lost", task.id, `这次没中标：${task.title}`);
      }
      return;
    }
    const winner = ranked[0];
    this.insertClaim(task.id, "implementer", winner.agent_id);
    this.setStatus(task.id, "claimed");
    this.insertMessage({
      roomId: task.room_id,
      authorType: "system",
      authorId: "system",
      taskId: task.id,
      kind: "system",
      body: `${this.handleOf(winner.agent_id)} 中标，开始实现`,
      addressed: [],
    });
    this.pushInbox(winner.agent_id, task.room_id, "awarded", task.id, this.cardSummary(task, "你中标实现"));
    for (const loser of bids) {
      if (loser.agent_id === winner.agent_id) continue;
      this.pushInbox(loser.agent_id, task.room_id, "bid_lost", task.id, `这次没中标：${task.title}`);
    }
  }

  private nudgeLevel(agentId: string | null, delta: number, roomId: string, taskId: string, reason: string) {
    if (!agentId || delta === 0) return;
    const row = this.db.prepare("SELECT handle, level FROM agents WHERE id = ?").get(agentId) as
      | { handle: string; level: number }
      | undefined;
    if (!row) return;
    const current = row.level >= 1 && row.level <= 5 ? row.level : 1;
    const next = Math.min(5, Math.max(1, current + delta));
    if (next === current) return;
    this.db.prepare("UPDATE agents SET level = ? WHERE id = ?").run(next, agentId);
    const message = this.insertMessage({
      roomId,
      authorType: "system",
      authorId: "system",
      taskId,
      kind: "system",
      body: `${row.handle} 的等级从 ${current} 调到 ${next}：${reason}。`,
      addressed: [],
    });
    this.fanout({
      roomId,
      author: { type: "system", id: "system" },
      message,
      addressed: [],
      taskId,
    });
  }

  private clearDeliverable(taskId: string) {
    this.db
      .prepare("UPDATE tasks SET deliverable_ref = NULL, deliverable_summary = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), taskId);
  }

  private wakeChecks(roomId: string, taskId: string, eventType: "review_needed" | "test_needed", summary: string) {
    const implementer = this.holder(taskId, "implementer");
    const agents = this.db
      .prepare(
        `SELECT a.id FROM agents a
         JOIN room_members m ON m.principal_id = a.id AND m.principal_type = 'agent'
         WHERE m.room_id = ? AND a.paused = 0`,
      )
      .all(roomId) as Array<{ id: string }>;
    for (const agent of agents) {
      if (agent.id === implementer || !this.isIdle(agent.id)) continue;
      this.pushInbox(agent.id, roomId, eventType, taskId, summary);
    }
  }

  private offerChecks(agentId: string) {
    if (!this.isIdle(agentId)) return;
    const paused = this.db.prepare("SELECT paused FROM agents WHERE id = ?").get(agentId) as { paused: number } | undefined;
    if (!paused || paused.paused === 1) return;
    const rooms = this.db
      .prepare("SELECT room_id FROM room_members WHERE principal_type = 'agent' AND principal_id = ?")
      .all(agentId) as Array<{ room_id: string }>;
    for (const room of rooms) {
      const tasks = this.db
        .prepare("SELECT id, status, title FROM tasks WHERE room_id = ? AND status IN ('in_review', 'in_test')")
        .all(room.room_id) as Array<{ id: string; status: string; title: string }>;
      for (const task of tasks.slice(0, 20)) {
        if (this.holder(task.id, "implementer") === agentId) continue;
        this.pushInbox(
          agentId,
          room.room_id,
          task.status === "in_review" ? "review_needed" : "test_needed",
          task.id,
          task.title,
        );
      }
    }
  }

  private wakeSiblings(task: TaskRow, body: string) {
    if (!task.parent_id) return;
    const siblings = this.db
      .prepare(
        `SELECT c.agent_id FROM tasks t
         JOIN task_claims c ON c.task_id = t.id AND c.role = 'implementer' AND c.state = 'active'
         WHERE t.parent_id = ? AND t.id != ?`,
      )
      .all(task.parent_id, task.id) as Array<{ agent_id: string }>;
    for (const sibling of siblings) {
      this.pushInbox(sibling.agent_id, task.room_id, "thread", task.id, body);
    }
  }

  private cancelTree(task: TaskRow, name: string) {
    const children = this.db.prepare("SELECT id FROM tasks WHERE parent_id = ?").all(task.id) as Array<{ id: string }>;
    for (const child of children) {
      const row = this.taskRow(child.id);
      if (!["done", "canceled", "failed"].includes(row.status)) this.cancelTree(row, name);
    }
    if (["done", "canceled", "failed"].includes(task.status)) return;
    this.setStatus(task.id, "canceled");
    this.finishRole(task.id, "implementer", "released");
    this.finishRole(task.id, "reviewer", "released");
    this.finishRole(task.id, "tester", "released");
    const message = this.insertMessage({
      roomId: task.room_id,
      authorType: "system",
      authorId: "system",
      taskId: task.id,
      kind: "system",
      body: `${name} 取消了任务`,
      addressed: [],
    });
    this.fanout({ roomId: task.room_id, author: { type: "user", id: "system" }, message, addressed: [], taskId: task.id });
  }

  private converge(parentId: string) {
    const parent = this.taskRow(parentId);
    if (parent.status !== "working") return;
    const children = this.db
      .prepare("SELECT id, status, title FROM tasks WHERE parent_id = ?")
      .all(parentId) as Array<{ id: string; status: string; title: string }>;
    if (children.length === 0) return;
    const terminal = new Set(["done", "canceled", "failed"]);
    if (children.some((child) => !terminal.has(child.status))) return;
    const done = children.filter((child) => child.status === "done");
    if (done.length === 1) {
      this.setStatus(parentId, "done");
      this.db.prepare("UPDATE tasks SET winner_task_id = ? WHERE id = ?").run(done[0].id, parentId);
      this.insertMessage({
        roomId: parent.room_id,
        authorType: "system",
        authorId: "system",
        taskId: parentId,
        kind: "system",
        body: `只剩一条方案通过，采用「${done[0].title}」。`,
        addressed: [],
      });
      return;
    }
    if (done.length >= 2) {
      this.setStatus(parentId, "dispute");
      this.insertMessage({
        roomId: parent.room_id,
        authorType: "system",
        authorId: "system",
        taskId: parentId,
        kind: "system",
        body: `有 ${done.length} 条方案都通过了评审和测试。留给人裁定，服务器不合并代码。`,
        addressed: [],
      });
      return;
    }
    this.setStatus(parentId, "failed");
    this.insertMessage({
      roomId: parent.room_id,
      authorType: "system",
      authorId: "system",
      taskId: parentId,
      kind: "system",
      body: "各条方案都没有通过。",
      addressed: [],
    });
  }

  private insertMessage(input: {
    roomId: string;
    authorType: string;
    authorId: string;
    taskId: string | null;
    kind: string;
    body: string;
    addressed: Addressed[];
  }) {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE room_id = ?")
      .get(input.roomId) as { seq: number };
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO messages
         (id, room_id, seq, author_type, author_id, task_id, kind, body, addressed_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.roomId,
        seqRow.seq,
        input.authorType,
        input.authorId,
        input.taskId,
        input.kind,
        input.body,
        JSON.stringify(input.addressed),
        nowIso(),
      );
    this.dirtyRooms.add(input.roomId);
    return {
      id,
      room_id: input.roomId,
      seq: seqRow.seq,
      task_id: input.taskId,
      kind: input.kind,
      body: input.body,
    };
  }

  private fanout(input: {
    roomId: string;
    author: { type: string; id: string };
    message: { id: string; body: string; task_id: string | null };
    addressed: Addressed[];
    taskId: string | null;
  }) {
    const sent = new Set<string>();
    const push = (agentId: string, eventType: InboxKind, summary: string) => {
      if (input.author.type === "agent" && input.author.id === agentId) return;
      const key = `${agentId}:${eventType}:${input.message.id}`;
      if (sent.has(key)) return;
      sent.add(key);
      this.db
        .prepare(
          `INSERT INTO inbox (recipient_type, recipient_id, room_id, event_type, ref_id, summary, created_at)
           VALUES ('agent', ?, ?, ?, ?, ?, ?)`,
        )
        .run(agentId, input.roomId, eventType, input.message.task_id ?? input.message.id, summary.slice(0, 240), nowIso());
      this.queue("agent", agentId);
    };
    if (this.roomRow(input.roomId).direct === 1) {
      const members = this.db
        .prepare(`SELECT principal_id FROM room_members WHERE room_id = ? AND principal_type = 'agent'`)
        .all(input.roomId) as Array<{ principal_id: string }>;
      for (const member of members) push(member.principal_id, "mention", `私聊：${input.message.body}`);
    }
    for (const item of input.addressed) {
      push(item.id, "mention", input.message.body);
    }
    if (input.taskId) {
      const holders = this.db
        .prepare(`SELECT agent_id FROM task_claims WHERE task_id = ? AND state = 'active'`)
        .all(input.taskId) as Array<{ agent_id: string }>;
      for (const holder of holders) push(holder.agent_id, "thread", input.message.body);
    }
  }

  private resolveMentions(roomId: string, body: string): Addressed[] {
    const handles = new Set<string>();
    for (const match of body.matchAll(/@([a-zA-Z][a-zA-Z0-9-]{0,31})/g)) {
      handles.add(match[1].toLowerCase());
    }
    if (handles.size === 0) return [];
    const agents = this.db
      .prepare(
        `SELECT a.id, a.handle FROM agents a
         JOIN room_members m ON m.principal_id = a.id AND m.principal_type = 'agent'
         WHERE m.room_id = ?`,
      )
      .all(roomId) as Array<{ id: string; handle: string }>;
    return agents
      .filter((agent) => handles.has(agent.handle))
      .map((agent) => ({ type: "agent" as const, id: agent.id, handle: agent.handle }));
  }

  private decorateMessages(roomId: string, afterSeq: number, limit: number) {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(roomId, afterSeq, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.presentMessage(row));
  }

  private decorateOne(id: string) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown>;
    return this.presentMessage(row);
  }

  private presentMessage(row: Record<string, unknown>) {
    const authorType = String(row.author_type);
    const authorId = String(row.author_id);
    let authorName = "系统";
    let handle: string | null = null;
    if (authorType === "user") {
      const user = this.db.prepare("SELECT name FROM users WHERE id = ?").get(authorId) as
        | { name: string }
        | undefined;
      authorName = user?.name ?? "成员";
    } else if (authorType === "agent") {
      const agent = this.db
        .prepare(
          `SELECT a.handle, u.name AS owner FROM agents a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ?`,
        )
        .get(authorId) as { handle: string; owner: string } | undefined;
      handle = agent?.handle ?? null;
      authorName = agent ? `${agent.owner} / ${agent.handle}` : "agent";
    }
    const taskId = (row.task_id as string | null) ?? null;
    let taskTitle: string | null = null;
    if (taskId) {
      const task = this.db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as
        | { title: string }
        | undefined;
      taskTitle = task?.title ?? null;
    }
    return {
      id: row.id,
      seq: row.seq,
      authorType,
      authorId,
      authorName,
      handle,
      taskId,
      taskTitle,
      kind: row.kind,
      body: row.body,
      addressed: JSON.parse(String(row.addressed_json ?? "[]")) as Addressed[],
      createdAt: row.created_at,
    };
  }

  private tasksInRoom(roomId: string) {
    const tasks = this.db
      .prepare("SELECT * FROM tasks WHERE room_id = ? AND parent_id IS NULL ORDER BY created_at")
      .all(roomId) as TaskRow[];
    return tasks.map((task) => this.presentTask(task));
  }

  private publicTask(taskId: string) {
    return this.presentTask(this.taskRow(taskId));
  }

  private presentTask(task: TaskRow, depth = 0): TaskView {
    const claims = this.db
      .prepare(
        `SELECT c.role, c.state, c.lease_until, c.updated_at, a.handle, a.id AS agent_id, u.name AS owner
         FROM task_claims c
         JOIN agents a ON a.id = c.agent_id
         JOIN users u ON u.id = a.owner_user_id
         WHERE c.task_id = ?
         ORDER BY c.updated_at`,
      )
      .all(task.id) as Array<{
      role: string;
      state: string;
      lease_until: string;
      handle: string;
      agent_id: string;
      owner: string;
    }>;
    const visible = (["implementer", "reviewer", "tester"] as const).flatMap((role) => {
      const rows = claims.filter((claim) => claim.role === role);
      const active = rows.filter((claim) => claim.state === "active");
      if (active.length > 0) return active;
      const finished = [...rows].reverse().find((claim) => claim.state === "completed" || claim.state === "changes");
      return finished ? [finished] : [];
    });
    const lanes =
      depth > 0
        ? []
        : (this.db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY lane, created_at").all(task.id) as TaskRow[]).map(
            (child) => this.presentTask(child, depth + 1),
          );
    return {
      id: task.id,
      roomId: task.room_id,
      title: task.title,
      body: task.body,
      status: task.status,
      acceptance: task.acceptance ?? "",
      mode: task.mode ?? "single",
      maxLanes: task.max_lanes ?? 1,
      tags: task.tags ?? "",
      complex: task.complex === 1,
      parentId: task.parent_id ?? null,
      lane: task.lane ?? null,
      direction: task.direction ?? "",
      deliverableRef: task.deliverable_ref ?? null,
      deliverableSummary: task.deliverable_summary ?? null,
      winnerTaskId: task.winner_task_id ?? null,
      bidUntil: task.bid_until ?? null,
      scope: scopeFrom(this.roomRow(task.room_id)),
      createdBy: task.created_by,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      claims: visible.map((claim) => ({
        role: claim.role,
        state: claim.state,
        handle: claim.handle,
        agentId: claim.agent_id,
        ownerName: claim.owner,
        leaseUntil: claim.lease_until,
      })),
      lanes,
    };
  }

  private membersOf(roomId: string, onlineUserIds: ReadonlySet<string>) {
    const users = this.db
      .prepare(
        `SELECT u.id, u.name FROM room_members m JOIN users u ON u.id = m.principal_id
         WHERE m.room_id = ? AND m.principal_type = 'user' ORDER BY m.joined_at`,
      )
      .all(roomId) as Array<{ id: string; name: string }>;
    const agents = this.db
      .prepare(
        `SELECT a.id, a.handle, a.runtime, a.paused, a.demo, a.tags, a.level, a.machine, a.cwd, a.last_seen_at, u.name AS owner
         FROM room_members m
         JOIN agents a ON a.id = m.principal_id
         JOIN users u ON u.id = a.owner_user_id
         WHERE m.room_id = ? AND m.principal_type = 'agent'
         ORDER BY a.created_at`,
      )
      .all(roomId) as Array<{
      id: string;
      handle: string;
      runtime: string;
      paused: number;
      demo: number;
      tags: string;
      level: number;
      machine: string;
      cwd: string;
      last_seen_at: string | null;
      owner: string;
    }>;
    const fresh = Date.now() - 20_000;
    return {
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        online: onlineUserIds.has(user.id),
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        handle: agent.handle,
        runtime: agent.runtime,
        paused: agent.paused === 1,
        demo: agent.demo === 1,
        tags: agent.tags ?? "",
        level: agent.level,
        machine: agent.machine ?? "",
        cwd: agent.cwd ?? "",
        ownerName: agent.owner,
        online: agent.paused !== 1 && !!agent.last_seen_at && Date.parse(agent.last_seen_at) > fresh,
      })),
    };
  }

  private locksForOrg(orgId: string) {
    const rows = this.db
      .prepare(
        `SELECT l.path, l.task_id, l.lease_until, a.handle
         FROM file_locks l JOIN agents a ON a.id = l.agent_id
         WHERE l.org_id = ? AND l.lease_until > ?`,
      )
      .all(orgId, nowIso()) as Array<{ path: string; task_id: string | null; lease_until: string; handle: string }>;
    return rows.map((row) => ({
      path: row.path,
      taskId: row.task_id,
      leaseUntil: row.lease_until,
      handle: row.handle,
    }));
  }

  private anyRoom(orgId: string) {
    const row = this.db.prepare("SELECT id FROM rooms WHERE org_id = ? LIMIT 1").get(orgId) as
      | { id: string }
      | undefined;
    return row?.id;
  }
}

function titleFrom(body: string) {
  const line = body.split("\n")[0]?.trim() || "未命名任务";
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

function cleanPath(input: string) {
  const path = input.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new ApiError(400, "bad_path", "只能锁仓库里的相对路径");
  }
  return path.slice(0, 200);
}
