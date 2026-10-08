import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";

export const LEASE_MS = 45_000;
export const LOCK_MS = 120_000;
const JOIN_MS = 30 * 60 * 1000;
const REVIEWER_LIMIT = 3;

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

type InboxKind = "mention" | "thread" | "task_open" | "review_needed" | "test_needed";

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
            "INSERT INTO rooms (id, org_id, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
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
    for (const handle of ["builder", "reviewer", "qa"]) {
      const id = uuid();
      const token = `agt_${randomBytes(24).toString("base64url")}`;
      this.db
        .prepare(
          `INSERT INTO agents
           (id, org_id, owner_user_id, handle, runtime, token_hash, paused, demo, created_at)
           VALUES (?, ?, ?, ?, 'demo', ?, 0, 1, ?)`,
        )
        .run(id, orgId, ownerId, handle, hashToken(token), nowIso());
      this.addRoomMember(roomId, "agent", id);
    }
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
        `SELECT id, handle, runtime, paused, demo, org_id, last_seen_at FROM agents WHERE owner_user_id = ? ORDER BY created_at`,
      )
      .all(user.id);
    return { user: { id: user.id, name: user.name }, orgs, rooms, agents };
  }

  listRooms(userId: string) {
    return this.db
      .prepare(
        `SELECT r.id, r.org_id, r.name, r.topic, r.created_at
         FROM rooms r
         JOIN room_members m ON m.room_id = r.id
         WHERE m.principal_type = 'user' AND m.principal_id = ?
         ORDER BY r.created_at`,
      )
      .all(userId) as Array<{ id: string; org_id: string; name: string; topic: string; created_at: string }>;
  }

  createRoom(user: Principal & { type: "user" }, name: string, topic: string) {
    const clean = name.trim();
    if (!clean || clean.length > 40) throw new ApiError(400, "bad_name", "频道名需要 1 到 40 个字");
    const org = this.db
      .prepare("SELECT org_id FROM org_members WHERE user_id = ? ORDER BY role DESC LIMIT 1")
      .get(user.id) as { org_id: string } | undefined;
    if (!org) throw new ApiError(400, "no_org", "还没有工作室");
    const room = this.transaction(() => {
      const id = uuid();
      this.db
        .prepare("INSERT INTO rooms (id, org_id, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, org.org_id, clean, topic.trim().slice(0, 200), user.id, nowIso());
      this.addRoomMember(id, "user", user.id);
      return { id, name: clean, topic: topic.trim().slice(0, 200), org_id: org.org_id };
    });
    this.flush();
    return room;
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

  enroll(code: string, handle: string, runtime: string) {
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
      this.db
        .prepare(
          `INSERT INTO agents
           (id, org_id, owner_user_id, handle, runtime, token_hash, paused, demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        )
        .run(id, row.org_id, row.created_by, cleanHandle, cleanRuntime, hashToken(token), nowIso());
      this.db.prepare("UPDATE join_codes SET used_by_agent_id = ? WHERE code = ?").run(id, code);
      this.addRoomMember(row.room_id, "agent", id);
      this.insertMessage({
        roomId: row.room_id,
        authorType: "system",
        authorId: "system",
        taskId: null,
        kind: "system",
        body: `${cleanHandle} 接入了频道（${cleanRuntime}）`,
        addressed: [],
      });
      return {
        token,
        agent: { id, handle: cleanHandle, runtime: cleanRuntime, orgId: row.org_id },
        roomId: row.room_id,
      };
    });
    this.flush();
    return result;
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

  snapshot(principal: Principal, roomId: string, onlineUserIds: ReadonlySet<string>) {
    this.assertMember(principal, roomId);
    if (principal.type === "agent") this.touchSeen(principal.id);
    const room = this.roomRow(roomId);
    const members = this.membersOf(roomId, onlineUserIds);
    const messages = this.decorateMessages(roomId, 0, 300);
    const tasks = this.tasksInRoom(roomId);
    const locks = this.locksForOrg(room.org_id);
    return { room: { id: room.id, orgId: room.org_id, name: room.name, topic: room.topic }, members, messages, tasks, locks };
  }

  readMessages(principal: Principal, roomId: string, afterSeq: number, limit = 100) {
    this.assertMember(principal, roomId);
    return this.decorateMessages(roomId, afterSeq, Math.min(limit, 200));
  }

  postMessage(
    principal: Principal,
    roomId: string,
    input: { body: string; kind?: string; taskId?: string | null },
  ) {
    this.assertMember(principal, roomId);
    const kind = input.kind ?? "chat";
    const body = input.body?.trim() ?? "";
    if (!body) throw new ApiError(400, "empty", "内容是空的");
    if (body.length > 8000) throw new ApiError(400, "too_long", "一条消息最多 8000 字");
    if (principal.type === "user" && !["chat", "instruction", "question"].includes(kind)) {
      throw new ApiError(400, "bad_kind", "人可以发言、提问或下指令");
    }
    if (principal.type === "agent" && !["chat", "question", "progress"].includes(kind)) {
      throw new ApiError(400, "bad_kind", "agent 用 say 发言、提问或汇报进度。评审和测试走单独的动作");
    }
    if (kind === "instruction" && principal.type !== "user") {
      throw new ApiError(403, "human_only", "只有人能下指令");
    }
    const addressed = this.resolveMentions(roomId, body);
    const result = this.transaction(() => {
      let taskId = input.taskId ?? null;
      if (kind === "instruction") taskId = null;
      if (taskId) {
        const task = this.taskRow(taskId);
        if (task.room_id !== roomId) throw new ApiError(400, "wrong_room", "任务不在这个频道");
      }
      if (kind === "progress") {
        if (!taskId) throw new ApiError(400, "need_task", "进度要挂在一条任务上");
        if (principal.type !== "agent" || !this.activeClaim(taskId, "implementer", principal.id)) {
          throw new ApiError(403, "not_implementer", "只有当前实现者能汇报进度");
        }
      }
      const createdTaskId = kind === "instruction" ? uuid() : null;
      const message = this.insertMessage({
        roomId,
        authorType: principal.type,
        authorId: principal.id,
        taskId: createdTaskId ?? taskId,
        kind,
        body,
        addressed,
      });
      let task = createdTaskId
        ? this.insertTask({
            id: createdTaskId,
            roomId,
            messageId: message.id,
            title: titleFrom(body),
            body,
            createdBy: principal.id,
          })
        : null;
      if (kind === "progress" && taskId) {
        const current = this.taskRow(taskId);
        if (current.status === "claimed") this.setStatus(taskId, "working");
        task = this.publicTask(taskId);
      }
      this.fanout({
        roomId,
        author: principal,
        message,
        addressed,
        taskCreated: Boolean(createdTaskId),
        taskId: message.task_id,
      });
      return { message: this.decorateOne(message.id), task: task ?? (message.task_id ? this.publicTask(message.task_id) : null) };
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
      const implementer = this.holder(taskId, "implementer");
      if ((role === "reviewer" || role === "tester") && implementer === agent.id) {
        throw new ApiError(403, "own_work", "实现者不能评审或测试自己的任务");
      }
      if (role === "implementer" || role === "tester") {
        const existing = this.holder(taskId, role);
        if (existing) throw new ApiError(409, "already_claimed", `这个槽位在 ${this.handleOf(existing)} 手上`);
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
        const mine = this.activeClaim(taskId, "reviewer", agent.id);
        if (mine) throw new ApiError(409, "already_claimed", "你已经在评审这条任务");
        const count = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM task_claims WHERE task_id = ? AND role = 'reviewer' AND state = 'active'`,
          )
          .get(taskId) as { n: number };
        if (count.n >= REVIEWER_LIMIT) throw new ApiError(409, "reviewers_full", "评审人已经满了");
      }
      const claimId = uuid();
      const stamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO task_claims (id, task_id, role, agent_id, state, lease_until, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(claimId, taskId, role, agent.id, plus(LEASE_MS), stamp, stamp);
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

  markReady(agent: Principal & { type: "agent" }, taskId: string) {
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(agent, task.room_id);
      if (!this.activeClaim(taskId, "implementer", agent.id)) {
        throw new ApiError(403, "not_implementer", "只有实现者能提交评审");
      }
      if (!["claimed", "working", "changes"].includes(task.status)) {
        throw new ApiError(409, "bad_state", "现在不能提交评审");
      }
      this.setStatus(taskId, "in_review");
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "agent",
        authorId: agent.id,
        taskId,
        kind: "progress",
        body: "实现完成，请评审。",
        addressed: [],
      });
      this.fanout({
        roomId: task.room_id,
        author: agent,
        message,
        addressed: [],
        taskId,
        statusEvent: "review_needed",
      });
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
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
      if (task.status !== "in_review") throw new ApiError(409, "bad_state", "现在不在评审");
      if (!this.activeClaim(taskId, "reviewer", agent.id)) {
        throw new ApiError(403, "not_reviewer", "先认领评审槽位");
      }
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
      } else if (verdict === "request_changes") {
        this.finishClaim(taskId, "reviewer", agent.id, "changes");
        this.setStatus(taskId, "changes");
      }
      this.fanout({
        roomId: task.room_id,
        author: agent,
        message,
        addressed: [],
        taskId,
        statusEvent: verdict === "approve" ? "test_needed" : undefined,
      });
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
        this.setStatus(taskId, "changes");
      }
      this.fanout({
        roomId: task.room_id,
        author: agent,
        message,
        addressed: [],
        taskId,
      });
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
        taskCreated: reopened,
      });
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  cancel(user: Principal & { type: "user" }, taskId: string) {
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(user, task.room_id);
      if (["done", "canceled"].includes(task.status)) throw new ApiError(409, "bad_state", "这条任务已经结束");
      this.setStatus(taskId, "canceled");
      this.finishRole(taskId, "implementer", "released");
      this.finishRole(taskId, "reviewer", "released");
      this.finishRole(taskId, "tester", "released");
      const message = this.insertMessage({
        roomId: task.room_id,
        authorType: "system",
        authorId: "system",
        taskId,
        kind: "system",
        body: `${user.name} 取消了任务`,
        addressed: [],
      });
      this.fanout({ roomId: task.room_id, author: user, message, addressed: [], taskId });
      return this.publicTask(taskId);
    });
    this.flush();
    return result;
  }

  forceDone(user: Principal & { type: "user" }, taskId: string) {
    const result = this.transaction(() => {
      const task = this.taskRow(taskId);
      this.assertMember(user, task.room_id);
      if (task.status === "canceled") throw new ApiError(409, "bad_state", "已取消的任务不能放行");
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
        `SELECT r.id, r.name, r.topic FROM rooms r
         JOIN room_members m ON m.room_id = r.id
         WHERE m.principal_type = 'agent' AND m.principal_id = ?`,
      )
      .all(agent.id);
    return {
      id: agent.id,
      handle: agent.handle,
      orgId: agent.orgId,
      paused: agent.paused,
      rooms,
      visibility:
        "房间历史对成员可读。wait 只返回点名、新任务、评审/测试需求和你占着的任务线程，不推送无关闲聊。",
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
    const locks = this.db.prepare("SELECT org_id FROM file_locks WHERE lease_until < ?").all(iso) as Array<{
      org_id: string;
    }>;
    if (expired.length === 0 && locks.length === 0) return { released: 0 };
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
          taskCreated: reopen,
        });
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

  private assertMember(principal: Principal, roomId: string) {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM room_members WHERE room_id = ? AND principal_type = ? AND principal_id = ?`,
      )
      .get(roomId, principal.type, principal.id);
    if (!row) throw new ApiError(403, "not_member", "你不在这个频道里");
  }

  private roomRow(roomId: string) {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as
      | { id: string; org_id: string; name: string; topic: string }
      | undefined;
    if (!row) throw new ApiError(404, "no_room", "没有这个频道");
    return row;
  }

  private taskRow(taskId: string) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          id: string;
          room_id: string;
          message_id: string;
          title: string;
          body: string;
          status: string;
          created_by: string;
        }
      | undefined;
    if (!row) throw new ApiError(404, "no_task", "没有这条任务");
    return row;
  }

  private setStatus(taskId: string, status: string) {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), taskId);
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
  }) {
    const stamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (id, room_id, message_id, title, body, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(input.id, input.roomId, input.messageId, input.title, input.body, input.createdBy, stamp, stamp);
    return this.publicTask(input.id);
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
    taskCreated?: boolean;
    statusEvent?: "review_needed" | "test_needed";
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
    for (const item of input.addressed) {
      push(item.id, "mention", input.message.body);
    }
    if (input.taskId) {
      const holders = this.db
        .prepare(`SELECT agent_id FROM task_claims WHERE task_id = ? AND state = 'active'`)
        .all(input.taskId) as Array<{ agent_id: string }>;
      for (const holder of holders) push(holder.agent_id, "thread", input.message.body);
    }
    if (input.taskCreated || input.statusEvent) {
      const agents = this.roomAgentIds(input.roomId);
      const eventType: InboxKind = input.statusEvent ?? "task_open";
      for (const agentId of agents) push(agentId, eventType, input.message.body);
    }
  }

  private roomAgentIds(roomId: string) {
    return (
      this.db
        .prepare(
          `SELECT principal_id FROM room_members WHERE room_id = ? AND principal_type = 'agent'`,
        )
        .all(roomId) as Array<{ principal_id: string }>
    ).map((row) => row.principal_id);
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
      .prepare("SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at")
      .all(roomId) as Array<Record<string, string>>;
    return tasks.map((task) => this.presentTask(task));
  }

  private publicTask(taskId: string) {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, string>;
    return this.presentTask(task);
  }

  private presentTask(task: Record<string, string>) {
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
    return {
      id: task.id,
      roomId: task.room_id,
      title: task.title,
      body: task.body,
      status: task.status,
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
        `SELECT a.id, a.handle, a.runtime, a.paused, a.demo, a.last_seen_at, u.name AS owner
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
