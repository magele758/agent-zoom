import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  HomeChatLink,
  HomeChatOverview,
  HomeChatRoom,
  HomeChatRoomDetail,
  HomeRoomBinding,
  HomeRoomIdeaRef,
  HomeRoomPost,
} from "../home-room-types.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import { ApiError, type Principal, type Store } from "./logic.ts";
import { StageHomeClient } from "./stage-home-client.ts";
import { parse } from "./workflow/contract.ts";

const text = z.string().min(1);
const roomSchema = z.object({
  id: text,
  title: text,
  status: text,
  botIds: z.array(text),
  hostBotId: text.optional(),
  replyMode: z.string().optional(),
  updatedAt: z.string().optional(),
});
const remoteMessage = z.object({
  id: text,
  roomId: text,
  seq: z.int().positive(),
  turnId: text.optional(),
  text: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  sender: z.object({ type: z.enum(["user", "bot"]), id: text, name: text }),
  mentions: z.array(text).optional(),
  replyTo: z.object({ messageId: text, botId: text.optional(), excerpt: z.string().optional() }).optional(),
});
const page = z.object({
  messages: z.array(remoteMessage),
  hasMore: z.boolean(),
  nextCursor: z.int().positive().nullable(),
});
const remoteTurn = z.object({
  id: text,
  roomId: text,
  messageId: text,
  status: text.optional(),
  botIds: z.array(text),
  mentionedBotIds: z.array(text).optional(),
  replyMode: text.optional(),
  goalId: text.optional(),
});
const receipt = z.object({ message: remoteMessage, turn: remoteTurn });
const inNamedTurn = (turn: z.infer<typeof remoteTurn> | undefined, message: Message, binding: Binding) =>
  turn?.roomId === binding.remoteRoom &&
  turn.id === message.turnId &&
  turn.messageId === message.id &&
  (!turn.replyMode || turn.replyMode === "all-members") &&
  !turn.goalId &&
  turn.botIds.length === 1 &&
  turn.botIds[0] === binding.botId &&
  turn.mentionedBotIds?.length === 1 &&
  turn.mentionedBotIds[0] === binding.botId;
const bindingSchema = z.strictObject({ localRoom: text, remoteRoom: text, botId: text });
const postSchema = z.strictObject({
  key: text.max(120),
  body: z.string().trim().min(1).max(16000),
  parent: text.optional(),
});
const createChatRoomSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  botIds: z.array(text).min(1).max(20),
  hostBotId: text.optional(),
  replyMode: z.enum(["coordinator", "all-members"]).optional(),
  scopeKey: z.string().trim().min(1).max(256).optional(),
});
const patchChatRoomSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  replyMode: z.enum(["coordinator", "all-members"]).optional(),
  hostBotId: text.optional(),
});
const sendChatMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(16000),
  mentions: z.array(text).max(20).optional(),
  idempotencyKey: text.max(120).optional(),
  replyTo: z.strictObject({
    messageId: text,
    botId: text.optional(),
    excerpt: z.string().max(240).optional(),
  }).optional(),
  ideaId: z.uuid().optional(),
});
const chatLinkSchema = z.strictObject({
  scopeKey: z.string().trim().min(1).max(256),
  remoteRoom: text,
  roomTitle: z.string().trim().min(1).max(160).optional(),
});
const chatMemberSchema = z.strictObject({ botId: text });
const base = "/api/opc/home-rooms";
const chatBase = "/api/opc/home-chat";
const upstream = "/api/bot-rooms";
const roomPath = (id: string) => upstream + "/" + encodeURIComponent(id);
const allowed = (r: z.infer<typeof roomSchema>) =>
  r.status === "active" && ["coordinator", "all-members"].includes(r.replyMode ?? "coordinator");
const conflict = (message: string) => new ApiError(409, "home_room_conflict", message);
type Binding = HomeRoomBinding & { connection: string; cursor: number };
type Post = HomeRoomPost & { clientKey: string };
type Message = z.infer<typeof remoteMessage>;
const epoch = () => new Date().toISOString();
const content = (post: Post) =>
  `[OPC OS 讨论 ${post.id}]\n只回复被点名的问题。如果需要负责人作决定，请以「待我答复：」开头。\n\n${post.body}`;
const markedPost = (body: string) => /^\[OPC OS 讨论 ([a-f\d-]{36})\]/u.exec(body)?.[1];
const isQuestion = (s: string) => /^待我答复[：:][\s\S]*\S/u.test(s.trim());
const ideaLinkPattern = /#ideas\?idea=([a-f\d-]{36})/i;

function decisionRoute(item: ZoomMessage): string {
  if (item.origin === "workflow") return `#workflows/${encodeURIComponent(item.taskId)}`;
  if (item.businessTrial) {
    return "#business-lines?" + new URLSearchParams({ line: item.businessTrial.lineId, trial: item.businessTrial.trialId });
  }
  if (item.capabilityRequest) {
    return "#capabilities?" + new URLSearchParams({ request: item.capabilityRequest.id });
  }
  if (item.stage) {
    const [product, ...rest] = item.folder ? item.folder.split("/") : [""];
    const params = new URLSearchParams({ step: item.stage });
    if (product) params.set("product", product);
    if (rest.length) params.set("project", rest.join("/"));
    return "#stage?" + params;
  }
  return "#overview";
}

function formatPendingNotice(item: ZoomMessage): string {
  const tag = item.origin === "workflow"
    ? "[待审批 · 工作流]"
    : item.businessTrial
      ? "[待复盘 · 经营实验]"
      : item.capabilityRequest
        ? "[待审批 · 开源能力]"
        : "[待处理 · 阶段任务]";
  const summary = item.body.replace(/\s+/g, " ").trim().slice(0, 280);
  const lines = [
    `${tag} ${item.taskTitle}`,
    `来源：${item.source}${item.folder ? " · " + item.folder : ""}`,
  ];
  if (summary && summary !== item.taskTitle) lines.push(`说明：${summary}`);
  if (item.choices?.length) lines.push(`可选项：${item.choices.join(" / ")}`);
  lines.push(`直达处理：${decisionRoute(item)}`);
  return lines.join("\n");
}

function noticeScopeCandidates(item: ZoomMessage): string[] {
  const keys: string[] = [];
  if (item.businessTrial) keys.push("line:" + item.businessTrial.lineId);
  if (item.folder) {
    keys.push("project:" + item.folder);
    const root = item.folder.split("/")[0];
    if (root && root !== item.folder) keys.push("product:" + root);
  }
  keys.push("default");
  return keys;
}

export class HomeRoomBridge {
  private db;
  private pending = new Map<string, Promise<void>>();
  private sending = new Set<string>();
  private notifying = false;
  private pendingSource?: () => ZoomMessage[];

  constructor(
    private store: Store,
    private client = new StageHomeClient(),
  ) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_home_rooms(id TEXT PRIMARY KEY,localRoom TEXT NOT NULL REFERENCES rooms(id),
        remoteRoom TEXT NOT NULL,project TEXT NOT NULL,roomTitle TEXT NOT NULL,botId TEXT NOT NULL,botName TEXT NOT NULL,
        connection TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,problem TEXT,UNIQUE(localRoom,remoteRoom,botId,connection));
      CREATE TABLE IF NOT EXISTS opc_home_posts(id TEXT PRIMARY KEY REFERENCES messages(id),binding TEXT NOT NULL REFERENCES opc_home_rooms(id),
        direction TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,remoteId TEXT,turnId TEXT,parent TEXT REFERENCES opc_home_posts(id),
        question INTEGER NOT NULL DEFAULT 0,clientKey TEXT,createdAt TEXT NOT NULL,UNIQUE(binding,remoteId),UNIQUE(binding,clientKey));
      CREATE INDEX IF NOT EXISTS opc_home_turns ON opc_home_posts(binding,turnId,direction);
      CREATE TABLE IF NOT EXISTS opc_home_chat_links(scope_key TEXT NOT NULL,connection TEXT NOT NULL,remote_room TEXT NOT NULL,
        room_title TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope_key,connection));
      CREATE TABLE IF NOT EXISTS opc_home_chat_notices(notice_key TEXT NOT NULL,connection TEXT NOT NULL,remote_room TEXT NOT NULL,
        remote_message_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(notice_key,connection));
      CREATE TABLE IF NOT EXISTS opc_home_chat_idea_refs(id TEXT PRIMARY KEY,connection TEXT NOT NULL,remote_room TEXT NOT NULL,
        room_title TEXT NOT NULL,idea_id TEXT NOT NULL,excerpt TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opc_home_chat_idea_idx ON opc_home_chat_idea_refs(connection,idea_id,created_at DESC);
    `);
  }

  attachPendingSource(source: () => ZoomMessage[]) {
    this.pendingSource = source;
  }

  private member(principal: Principal, id: string) {
    const row = this.db
      .prepare(
        `SELECT r.name,r.project FROM rooms r JOIN room_members m ON m.room_id=r.id
      WHERE r.id=? AND m.principal_type=? AND m.principal_id=? AND m.hidden=0 AND r.archived=0 AND r.direct=0`,
      )
      .get(id, principal.type, principal.id);
    if (!row || (principal.type === "agent" && principal.paused))
      throw new ApiError(403, "home_room_member", "只能访问已加入的活动项目房间。");
    return row;
  }

  private binding(id: string, principal?: Principal) {
    const value = this.db.prepare("SELECT * FROM opc_home_rooms WHERE id=?").get(id) as unknown as Binding | undefined;
    if (!value) throw new ApiError(404, "home_room_missing", "找不到房间绑定");
    if (principal) this.member(principal, value.localRoom);
    if (value.connection !== this.client.identity) throw conflict("Agent Home 连接身份已变更，请恢复原连接再对账。");
    return value;
  }

  private async target(remoteRoom: string, botId: string) {
    const { room } = await this.client.call(roomPath(remoteRoom), z.object({ room: roomSchema }));
    if (room.id !== remoteRoom || !allowed(room) || !room.botIds.includes(botId))
      throw conflict("请选用活动讨论房间及该房间已有的 Bot 成员。");
    return room;
  }

  async directory() {
    const [rooms, bots] = await Promise.all([
      this.client.call(upstream, z.object({ rooms: z.array(roomSchema) })),
      this.client.bots(),
    ]);
    return { rooms: rooms.rooms.filter(allowed).map(({ id, title, botIds }) => ({ id, title, botIds })), bots };
  }

  localRooms(principal: Principal) {
    if (principal.type === "agent" && principal.paused)
      throw new ApiError(403, "home_room_member", "这个 agent 已暂停。");
    return this.db
      .prepare(
        `SELECT r.id,r.name,r.project FROM rooms r JOIN room_members m ON m.room_id=r.id
      WHERE m.principal_type=? AND m.principal_id=? AND m.hidden=0 AND r.archived=0 AND r.direct=0 ORDER BY r.name`,
      )
      .all(principal.type, principal.id);
  }

  list(principal: Principal): HomeRoomBinding[] {
    return this.db
      .prepare(
        `SELECT b.id,b.localRoom,b.remoteRoom,COALESCE(NULLIF(r.project,''),r.name) AS project,b.roomTitle,b.botId,b.botName,b.problem FROM opc_home_rooms b
      JOIN rooms r ON r.id=b.localRoom JOIN room_members m ON m.room_id=r.id
      WHERE b.connection=? AND m.principal_type=? AND m.principal_id=? AND m.hidden=0 AND r.archived=0 AND r.direct=0 ORDER BY b.rowid`,
      )
      .all(this.client.identity, principal.type, principal.id) as unknown as HomeRoomBinding[];
  }

  async bind(principal: Principal, raw: unknown) {
    const { localRoom, remoteRoom, botId } = parse(bindingSchema, raw);
    this.member(principal, localRoom);
    const [room, bots, history] = await Promise.all([
      this.target(remoteRoom, botId),
      this.client.bots(),
      this.client.call(roomPath(remoteRoom) + "/messages?limit=1", page),
    ]);
    const bot = bots.find((item) => item.id === botId);
    if (!bot) throw conflict("指定 Bot 当前不可选");
    return this.store.writeRoomMessages(() => {
      const local = this.member(principal, localRoom);
      const used = this.db
        .prepare("SELECT localRoom FROM opc_home_rooms WHERE connection=? AND remoteRoom=? AND localRoom<>?")
        .get(this.client.identity, remoteRoom, localRoom);
      if (used) throw conflict("这个 Home 房间已关联到另一个 OPC OS 房间。");
      this.db
        .prepare(
          `INSERT OR IGNORE INTO opc_home_rooms(id,localRoom,remoteRoom,project,roomTitle,botId,botName,connection,cursor)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          localRoom,
          remoteRoom,
          String(local.project || local.name),
          room.title,
          botId,
          bot.name,
          this.client.identity,
          history.messages.at(-1)?.seq ?? 0,
        );
      return this.list(principal).find(
        (b) => b.localRoom === localRoom && b.remoteRoom === remoteRoom && b.botId === botId,
      )!;
    });
  }

  posts(principal: Principal, id: string): HomeRoomPost[] {
    this.binding(id, principal);
    return this.db
      .prepare("SELECT * FROM opc_home_posts WHERE binding=? ORDER BY rowid")
      .all(id) as unknown as HomeRoomPost[];
  }

  postDetail(principal: Principal, id: string, postId: string): { binding: HomeRoomBinding; post: HomeRoomPost } {
    const binding = this.binding(id, principal);
    const post = this.post(postId);
    if (post.binding !== id) throw new ApiError(404, "home_room_post", "找不到原消息");
    const { connection: _connection, cursor: _cursor, ...summary } = binding;
    return { binding: summary, post };
  }

  referencesForIdea(principal: Principal, rawIdeaId: string): HomeRoomIdeaRef[] {
    const ideaId = parse(z.uuid(), rawIdeaId);
    if (principal.type === "agent" && principal.paused)
      throw new ApiError(403, "home_room_member", "这个 agent 已暂停。");
    const needle = "#ideas?idea=" + ideaId;
    const rows = this.db
      .prepare(
        `SELECT p.id AS postId, b.id AS bindingId, COALESCE(NULLIF(r.project,''),r.name) AS project,
          b.roomTitle, b.botName, p.direction, p.body, p.createdAt
         FROM opc_home_posts p
         JOIN opc_home_rooms b ON b.id=p.binding
         JOIN rooms r ON r.id=b.localRoom
         JOIN room_members m ON m.room_id=r.id
         WHERE b.connection=? AND m.principal_type=? AND m.principal_id=? AND m.hidden=0 AND r.archived=0 AND r.direct=0
           AND instr(lower(p.body), lower(?)) > 0
         ORDER BY p.rowid DESC LIMIT 50`,
      )
      .all(this.client.identity, principal.type, principal.id, needle) as Array<{
      postId: string;
      bindingId: string;
      project: string;
      roomTitle: string;
      botName: string;
      direction: "out" | "in";
      body: string;
      createdAt: string;
    }>;
    const boundRefs: HomeRoomIdeaRef[] = rows.map(({ body, ...rest }) => ({
      ...rest,
      excerpt: body.replace(/\s+/g, " ").trim().slice(0, 140),
    }));
    const chatRows = this.db
      .prepare(
        `SELECT id, remote_room AS roomId, room_title AS roomTitle, excerpt, created_at AS createdAt
         FROM opc_home_chat_idea_refs
         WHERE connection=? AND idea_id=?
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(this.client.identity, ideaId) as Array<{
      id: string;
      roomId: string;
      roomTitle: string;
      excerpt: string;
      createdAt: string;
    }>;
    const chatRefs: HomeRoomIdeaRef[] = chatRows.map((row) => ({
      bindingId: "",
      postId: row.id,
      roomId: row.roomId,
      project: "Agent Home 群聊",
      roomTitle: row.roomTitle,
      botName: "群聊讨论",
      direction: "out",
      excerpt: row.excerpt,
      createdAt: row.createdAt,
    }));
    return [...chatRefs, ...boundRefs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }

  private post(id: string) {
    const row = this.db.prepare("SELECT * FROM opc_home_posts WHERE id=?").get(id) as unknown as Post | undefined;
    if (!row) throw new ApiError(404, "home_room_post", "找不到原消息");
    return row;
  }

  async send(principal: Principal, id: string, raw: unknown) {
    const value = parse(postSchema, raw);
    const binding = this.binding(id, principal);
    const { post, fresh } = this.store.writeRoomMessages(() => {
      const parent = value.parent ? this.post(value.parent) : null;
      if (parent && (parent.binding !== id || parent.direction !== "in"))
        throw conflict("只能接续本房间中这位 Bot 的原消息。");
      const key = parent?.question ? "answer/" + parent.id : value.key;
      const old = this.db.prepare("SELECT id FROM opc_home_posts WHERE binding=? AND clientKey=?").get(id, key);
      if (old) {
        const post = this.post(String(old.id));
        if (post.body !== value.body || post.parent !== (value.parent ?? null))
          throw conflict("同一消息请求已用于其他内容。");
        return { post, fresh: false };
      }
      const local = this.store.recordHomeRoomMessage(binding.localRoom, principal, `@${binding.botName} ${value.body}`);
      this.db
        .prepare(
          `INSERT INTO opc_home_posts(id,binding,direction,body,state,parent,clientKey,createdAt)
        VALUES(?,?,'out',?,'sending',?,?,?)`,
        )
        .run(local, id, value.body, value.parent ?? null, key, epoch());
      return { post: this.post(local), fresh: true };
    });
    if (fresh || post.state === "retryable") await this.deliver(binding, post);
    return this.post(post.id);
  }

  async retry(principal: Principal, id: string, messageId: string) {
    const binding = this.binding(id, principal);
    const post = this.post(messageId);
    if (post.binding !== id || post.direction !== "out") throw conflict("请选择本讨论中的原消息。");
    if (post.state === "received") return post;
    if (post.state !== "retryable") throw conflict("需先核对原房间，并确认没有回执。");
    await this.deliver(binding, post);
    return this.post(post.id);
  }

  private async deliver(binding: Binding, post: Post) {
    if (this.sending.has(post.id)) return;
    this.sending.add(post.id);
    this.db.prepare("UPDATE opc_home_posts SET state='sending' WHERE id=? AND remoteId IS NULL").run(post.id);
    try {
      const [, bots] = await Promise.all([this.target(binding.remoteRoom, binding.botId), this.client.bots()]);
      if (!bots.some((bot) => bot.id === binding.botId)) throw conflict("被点名的 Bot 当前不可接收消息。");
      const parent = post.parent ? this.post(post.parent) : null;
      const sent = await this.client.call(roomPath(binding.remoteRoom) + "/messages", receipt, {
        text: content(post),
        mentions: [binding.botId],
        idempotencyKey: "opc-room/" + post.id,
        ...(parent && {
          replyTo: {
            messageId: parent.remoteId,
            botId: binding.botId,
            excerpt: [...parent.body.trim()].slice(0, 120).join(""),
          },
        }),
      });
      if (
        sent.message.text !== content(post) ||
        sent.message.roomId !== binding.remoteRoom ||
        sent.message.sender.type !== "user" ||
        !inNamedTurn(sent.turn, sent.message, binding) ||
        (sent.message.replyTo?.messageId ?? null) !== (parent?.remoteId ?? null)
      ) {
        throw conflict("Agent Home 回执与原消息不一致，请核对原房间。");
      }
      this.db
        .prepare("UPDATE opc_home_posts SET state='received',remoteId=?,turnId=? WHERE id=?")
        .run(sent.message.id, sent.turn.id, post.id);
    } catch (error) {
      this.db.prepare("UPDATE opc_home_posts SET state='unknown' WHERE id=? AND remoteId IS NULL").run(post.id);
      this.setProblem(binding.id, error);
    } finally {
      this.sending.delete(post.id);
    }
  }

  private setProblem(id: string, error: unknown) {
    const message = error instanceof ApiError ? error.message : "连接中断，请核对原房间。";
    this.db.prepare("UPDATE opc_home_rooms SET problem=? WHERE id=?").run(message, id);
  }

  async reconcile(id: string, principal?: Principal) {
    const binding = this.binding(id, principal);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const sync = this.scan(binding)
      .catch((error) => {
        this.setProblem(id, error);
        throw error;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, sync);
    return sync;
  }

  private async scan(binding: Binding) {
    const unresolved = this.db
      .prepare("SELECT id FROM opc_home_posts WHERE binding=? AND state IN ('sending','unknown')")
      .all(binding.id)
      .filter((row) => !this.sending.has(String(row.id)));
    const found: Message[] = [];
    let before: number | undefined;
    let readThrough = binding.cursor;
    for (;;) {
      const query = new URLSearchParams({ limit: "200" });
      if (before) query.set("beforeSeq", String(before));
      const history = await this.client.call(roomPath(binding.remoteRoom) + "/messages?" + query, page);
      const oldest = history.messages[0]?.seq;
      for (const message of history.messages) {
        if (message.roomId !== binding.remoteRoom) throw conflict("收到其他房间的消息。");
        readThrough = Math.max(readThrough, message.seq);
        if (message.seq <= binding.cursor) continue;
        if (message.sender.type === "bot" ? message.sender.id === binding.botId : markedPost(message.text))
          found.push(message);
      }
      if (!history.hasMore || (oldest !== undefined && oldest <= binding.cursor)) break;
      if (!history.nextCursor || history.nextCursor !== oldest || (before && history.nextCursor >= before)) {
        throw conflict("历史分页不完整，保留原位置等待核对。");
      }
      before = history.nextCursor;
    }
    const needsReceipt = found.some((message) => {
      const localId = message.sender.type === "user" && markedPost(message.text);
      return (
        localId &&
        this.db
          .prepare("SELECT 1 FROM opc_home_posts WHERE id=? AND binding=? AND remoteId IS NULL")
          .get(localId, binding.id)
      );
    });
    const recoveredTurns = new Map<string, z.infer<typeof remoteTurn>>();
    if (needsReceipt) {
      const { turns } = await this.client.call(
        roomPath(binding.remoteRoom) + "/turns",
        z.object({ turns: z.array(remoteTurn) }),
      );
      for (const turn of turns) recoveredTurns.set(turn.id, turn);
    }
    this.store.writeRoomMessages(() => {
      for (const m of found.sort((a, b) => a.seq - b.seq)) {
        if (!m.turnId) continue;
        if (m.sender.type === "user") {
          const localId = markedPost(m.text);
          if (!localId) continue;
          const local = this.db
            .prepare("SELECT * FROM opc_home_posts WHERE binding=? AND id=? AND direction='out'")
            .get(binding.id, localId) as unknown as Post | undefined;
          if (
            local &&
            content(local) === m.text &&
            (m.replyTo?.messageId ?? null) === (local.parent ? this.post(local.parent).remoteId : null)
          ) {
            if (!local.remoteId && !inNamedTurn(recoveredTurns.get(m.turnId), m, binding)) {
              throw conflict("原帖存在，点名成员的回执仍需核对。");
            }
            if (local.remoteId && local.remoteId !== m.id) throw conflict("同一原消息出现多个远端回执。");
            this.db
              .prepare("UPDATE opc_home_posts SET state='received',remoteId=?,turnId=? WHERE id=?")
              .run(m.id, m.turnId, local.id);
          }
        } else if (m.sender.id === binding.botId && m.text.trim()) {
          const parent = this.db
            .prepare("SELECT id FROM opc_home_posts WHERE binding=? AND direction='out' AND turnId=?")
            .get(binding.id, m.turnId);
          if (
            !parent ||
            this.db.prepare("SELECT id FROM opc_home_posts WHERE binding=? AND remoteId=?").get(binding.id, m.id)
          )
            continue;
          const local = this.store.recordHomeRoomMessage(
            binding.localRoom,
            null,
            `${binding.botName} · Agent Home\n${m.text}`,
          );
          this.db
            .prepare(
              `INSERT INTO opc_home_posts(id,binding,direction,body,state,remoteId,turnId,parent,question,createdAt)
            VALUES(?,?,'in',?,'received',?,?,?,?,?)`,
            )
            .run(local, binding.id, m.text, m.id, m.turnId, String(parent.id), Number(isQuestion(m.text)), m.createdAt);
        }
      }
      for (const row of unresolved)
        if (!this.sending.has(String(row.id))) {
          this.db.prepare("UPDATE opc_home_posts SET state='retryable' WHERE id=? AND remoteId IS NULL").run(row.id);
        }
      this.db
        .prepare("UPDATE opc_home_rooms SET cursor=max(cursor,?),problem=NULL WHERE id=?")
        .run(readThrough, binding.id);
    });
  }

  chatLinks(): HomeChatLink[] {
    return this.db
      .prepare(
        `SELECT scope_key AS scopeKey, remote_room AS remoteRoom, room_title AS roomTitle, updated_at AS updatedAt
         FROM opc_home_chat_links WHERE connection=? ORDER BY CASE scope_key WHEN 'default' THEN 0 ELSE 1 END, scope_key`,
      )
      .all(this.client.identity) as unknown as HomeChatLink[];
  }

  async chatOverview(): Promise<HomeChatOverview> {
    const links = this.chatLinks();
    try {
      const [roomsRes, bots] = await Promise.all([
        this.client.call(upstream, z.object({ rooms: z.array(roomSchema) })),
        this.client.bots(),
      ]);
      const rooms: HomeChatRoom[] = roomsRes.rooms.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        botIds: r.botIds,
        ...(r.hostBotId && { hostBotId: r.hostBotId }),
        ...(r.replyMode && { replyMode: r.replyMode }),
        ...(r.updatedAt && { updatedAt: r.updatedAt }),
      }));
      return { available: true, origin: this.client.origin, rooms, bots, links };
    } catch (error) {
      return {
        available: false,
        origin: this.client.origin,
        reason: error instanceof ApiError ? error.message : "Agent Home 服务暂未连接，请确认本机 Agent Home 已启动。",
        rooms: [],
        bots: [],
        links,
      };
    }
  }

  async createChatRoom(raw: unknown): Promise<{ room: HomeChatRoom; links: HomeChatLink[] }> {
    const input = parse(createChatRoomSchema, raw);
    const created = await this.client.call(
      upstream,
      z.object({ room: roomSchema }),
      {
        title: input.title,
        botIds: input.botIds,
        ...(input.hostBotId && { hostBotId: input.hostBotId }),
      },
      "POST",
    );
    let room = created.room;
    if (input.replyMode && room.replyMode !== input.replyMode) {
      const patched = await this.client.call(
        roomPath(room.id),
        z.object({ room: roomSchema }),
        { replyMode: input.replyMode },
        "PATCH",
      );
      room = patched.room;
    }
    if (input.scopeKey) {
      this.saveChatLink(input.scopeKey, room.id, room.title);
    }
    return { room, links: this.chatLinks() };
  }

  async patchChatRoom(roomId: string, raw: unknown): Promise<{ room: HomeChatRoom; links: HomeChatLink[] }> {
    const input = parse(patchChatRoomSchema, raw);
    if (!Object.keys(input).length) throw conflict("请提供要修改的群聊字段");
    const patched = await this.client.call(roomPath(roomId), z.object({ room: roomSchema }), input, "PATCH");
    if (input.title) {
      this.db
        .prepare("UPDATE opc_home_chat_links SET room_title=?, updated_at=? WHERE connection=? AND remote_room=?")
        .run(patched.room.title, epoch(), this.client.identity, roomId);
    }
    return { room: patched.room, links: this.chatLinks() };
  }

  async addChatMember(roomId: string, raw: unknown): Promise<{ room: HomeChatRoom }> {
    const { botId } = parse(chatMemberSchema, raw);
    return this.client.call(roomPath(roomId) + "/members", z.object({ room: roomSchema }), { botId }, "POST");
  }

  async removeChatMember(roomId: string, botId: string): Promise<{ room: HomeChatRoom }> {
    return this.client.call(
      roomPath(roomId) + "/members/" + encodeURIComponent(botId),
      z.object({ room: roomSchema }),
      undefined,
      "DELETE",
    );
  }

  async stopChatRoom(roomId: string): Promise<{ room: HomeChatRoom }> {
    return this.client.call(roomPath(roomId) + "/stop", z.object({ room: roomSchema }), {}, "POST");
  }

  async resumeChatRoom(roomId: string): Promise<{ room: HomeChatRoom }> {
    return this.client.call(roomPath(roomId) + "/resume", z.object({ room: roomSchema }), {}, "POST");
  }

  async chatMessages(roomId: string, opts: { limit?: number; beforeSeq?: number } = {}): Promise<HomeChatRoomDetail> {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(opts.limit ?? 80, 1), 200)) });
    if (opts.beforeSeq && Number.isSafeInteger(opts.beforeSeq) && opts.beforeSeq > 0) {
      query.set("beforeSeq", String(opts.beforeSeq));
    }
    const [detail, history, turnsRes, bots] = await Promise.all([
      this.client.call(roomPath(roomId), z.object({ room: roomSchema })),
      this.client.call(roomPath(roomId) + "/messages?" + query, page),
      this.client.call(roomPath(roomId) + "/turns", z.object({ turns: z.array(remoteTurn) })),
      this.client.bots(),
    ]);
    return {
      room: detail.room,
      messages: history.messages,
      hasMore: history.hasMore,
      nextCursor: history.nextCursor,
      bots,
      turns: turnsRes.turns,
    };
  }

  async sendChatMessage(roomId: string, raw: unknown) {
    const input = parse(sendChatMessageSchema, raw);
    const idempotencyKey = input.idempotencyKey ?? "opc-chat/" + randomUUID();
    const sent = await this.client.call(
      roomPath(roomId) + "/messages",
      receipt,
      {
        text: input.text,
        ...(input.mentions?.length && { mentions: input.mentions }),
        idempotencyKey,
        ...(input.replyTo && { replyTo: input.replyTo }),
      },
      "POST",
    );
    const ideaId = input.ideaId ?? ideaLinkPattern.exec(input.text)?.[1];
    if (ideaId) {
      let roomTitle = roomId;
      try {
        const info = await this.client.call(roomPath(roomId), z.object({ room: roomSchema }));
        roomTitle = info.room.title;
      } catch {
        // Keep roomId fallback if metadata lookup fails.
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO opc_home_chat_idea_refs(id,connection,remote_room,room_title,idea_id,excerpt,created_at)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          sent.message.id,
          this.client.identity,
          roomId,
          roomTitle,
          ideaId,
          input.text.replace(/\s+/g, " ").trim().slice(0, 140),
          sent.message.createdAt,
        );
    }
    return sent;
  }

  private saveChatLink(scopeKey: string, remoteRoom: string, roomTitle: string) {
    this.db
      .prepare(
        `INSERT INTO opc_home_chat_links(scope_key,connection,remote_room,room_title,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(scope_key,connection) DO UPDATE SET remote_room=excluded.remote_room, room_title=excluded.room_title, updated_at=excluded.updated_at`,
      )
      .run(scopeKey, this.client.identity, remoteRoom, roomTitle, epoch());
  }

  async setChatLink(raw: unknown): Promise<{ links: HomeChatLink[] }> {
    const input = parse(chatLinkSchema, raw);
    let roomTitle = input.roomTitle;
    if (!roomTitle) {
      const { room } = await this.client.call(roomPath(input.remoteRoom), z.object({ room: roomSchema }));
      roomTitle = room.title;
    }
    this.saveChatLink(input.scopeKey, input.remoteRoom, roomTitle);
    void this.notifyPendingDecisions().catch(() => {});
    return { links: this.chatLinks() };
  }

  deleteChatLink(scopeKey: string): { links: HomeChatLink[] } {
    this.db.prepare("DELETE FROM opc_home_chat_links WHERE scope_key=? AND connection=?").run(scopeKey, this.client.identity);
    return { links: this.chatLinks() };
  }

  async notifyPendingDecisions(): Promise<{ sent: number }> {
    if (this.notifying || !this.pendingSource) return { sent: 0 };
    const links = this.chatLinks();
    if (!links.length) return { sent: 0 };
    this.notifying = true;
    let sent = 0;
    try {
      const linkMap = new Map(links.map((item) => [item.scopeKey, item.remoteRoom]));
      const items = this.pendingSource().filter(
        (item) => item.pending && !item.roomBinding && !item.id.startsWith("home-room:"),
      );
      for (const item of items) {
        const already = this.db
          .prepare("SELECT 1 FROM opc_home_chat_notices WHERE notice_key=? AND connection=?")
          .get(item.id, this.client.identity);
        if (already) continue;
        const targetRoom = noticeScopeCandidates(item)
          .map((key) => linkMap.get(key))
          .find((roomId): roomId is string => Boolean(roomId));
        if (!targetRoom) continue;
        try {
          const result = await this.client.call(
            roomPath(targetRoom) + "/messages",
            receipt,
            {
              text: formatPendingNotice(item),
              idempotencyKey: "opc-notice/" + item.id,
            },
            "POST",
          );
          this.db
            .prepare(
              `INSERT OR IGNORE INTO opc_home_chat_notices(notice_key,connection,remote_room,remote_message_id,created_at)
               VALUES(?,?,?,?,?)`,
            )
            .run(item.id, this.client.identity, targetRoom, result.message.id, epoch());
          sent++;
        } catch {
          // Agent Home may be offline or room deleted; retry cleanly on the next tick.
        }
      }
      return { sent };
    } finally {
      this.notifying = false;
    }
  }

  async tick() {
    // No reads of unrelated Home rooms. Poll only rooms with an explicit outbound discussion.
    const bindings = this.list(this.store.localUser()).filter((b) =>
      this.db.prepare("SELECT 1 FROM opc_home_posts WHERE binding=? LIMIT 1").get(b.id),
    );
    await Promise.allSettled([...bindings.map((b) => this.reconcile(b.id)), this.notifyPendingDecisions()]);
  }

  zoomMessages(principal: Principal): ZoomMessage[] {
    const messages: ZoomMessage[] = [];
    for (const binding of this.list(principal)) {
      const posts = this.posts(principal, binding.id);
      const roots = new Map<string, HomeRoomPost>();
      const answers = new Map(posts.filter((p) => p.direction === "out" && p.parent).map((p) => [p.parent, p]));
      const withBotResponse = new Set<string>();
      for (const post of posts) {
        const root = (post.parent && roots.get(post.parent)) || post;
        roots.set(post.id, root);
        if (post.direction === "in") withBotResponse.add(root.id);
      }
      for (const post of posts) {
        const root = roots.get(post.id)!;
        if (!withBotResponse.has(root.id)) continue;
        const incoming = post.direction === "in";
        const pending = Boolean(post.question) && answers.get(post.id)?.state !== "received";
        messages.push({
          origin: "external",
          id: "home-room:" + post.id,
          taskId: "home-room:" + root.id,
          taskTitle: root.body.split("\n")[0].slice(0, 100),
          source: binding.botName + " · Agent Home",
          folder: binding.project,
          context: "项目讨论 · " + binding.roomTitle,
          roomBinding: binding.id,
          body: post.body,
          at: post.createdAt,
          pending,
          kind: post.question
            ? "question"
            : incoming
              ? "progress"
              : !post.parent
                ? "task"
                : post.state === "received"
                  ? "reply"
                  : "progress",
          ...(post.parent && { replyTo: "home-room:" + post.parent }),
          ...(!incoming && { actor: "发给 @" + binding.botName }),
          ...(!incoming && post.state !== "received" && { context: "回复已保存在本机，送达状态待核对" }),
          ...(pending && { action: { kind: "reply" } }),
        });
      }
    }
    return messages;
  }

  async replyZoom(principal: Principal, id: string, raw: unknown) {
    const input = parse(z.object({ questionId: text, body: z.string().trim().min(1).max(16000) }), raw);
    if (!input.questionId.startsWith("home-room:")) throw conflict("回复需要对应原房间问题。");
    const question = this.post(input.questionId.slice("home-room:".length));
    this.binding(question.binding, principal);
    if (!question.question) throw conflict("请选择原 Bot 问题。");
    const root = this.db
      .prepare(
        `WITH RECURSIVE ancestry(id,parent) AS (
      SELECT id,parent FROM opc_home_posts WHERE id=? UNION ALL
      SELECT p.id,p.parent FROM opc_home_posts p JOIN ancestry a ON a.parent=p.id
    ) SELECT id FROM ancestry WHERE parent IS NULL`,
      )
      .get(question.id);
    if (id !== "home-room:" + root?.id) throw conflict("这条问题属于另一个讨论。");
    return this.send(principal, question.binding, {
      key: "answer/" + question.id,
      body: input.body,
      parent: question.id,
    });
  }
}

export function addHomeRoomRoutes(
  app: Hono,
  store: Store,
  user: (c: Context) => Principal,
  caller: (c: Context) => Principal,
) {
  const bridge = new HomeRoomBridge(store);
  app.get(base, (c) => {
    const principal = caller(c);
    return c.json({ localRooms: bridge.localRooms(principal), bindings: bridge.list(principal) });
  });
  app.get(base + "/directory", async (c) => {
    user(c);
    return c.json(await bridge.directory());
  });
  app.get(base + "/references", (c) => {
    const idea = c.req.query("idea") ?? "";
    return c.json({ references: bridge.referencesForIdea(caller(c), idea) });
  });
  app.post(base, async (c) => c.json(await bridge.bind(user(c), await c.req.json())));
  app.get(base + "/:id/messages", (c) => c.json({ posts: bridge.posts(caller(c), c.req.param("id")!) }));
  app.get(base + "/:id/messages/:messageId", (c) =>
    c.json(bridge.postDetail(caller(c), c.req.param("id")!, c.req.param("messageId")!)),
  );
  app.post(base + "/:id/messages", async (c) =>
    c.json(await bridge.send(caller(c), c.req.param("id")!, await c.req.json()), 202),
  );
  app.post(base + "/:id/messages/:messageId/retry", async (c) =>
    c.json(await bridge.retry(caller(c), c.req.param("id")!, c.req.param("messageId")!), 202),
  );
  app.post(base + "/:id/reconcile", async (c) => {
    await bridge.reconcile(c.req.param("id")!, caller(c));
    return c.json({ ok: true });
  });
  app.use(chatBase + "/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(chatBase + "/overview", async (c) => {
    user(c);
    return c.json(await bridge.chatOverview());
  });
  app.post(chatBase + "/rooms", async (c) => {
    user(c);
    return c.json(await bridge.createChatRoom(await c.req.json()), 201);
  });
  app.patch(chatBase + "/rooms/:roomId", async (c) => {
    user(c);
    return c.json(await bridge.patchChatRoom(c.req.param("roomId")!, await c.req.json()));
  });
  app.post(chatBase + "/rooms/:roomId/members", async (c) => {
    user(c);
    return c.json(await bridge.addChatMember(c.req.param("roomId")!, await c.req.json()));
  });
  app.delete(chatBase + "/rooms/:roomId/members/:botId", async (c) => {
    user(c);
    return c.json(await bridge.removeChatMember(c.req.param("roomId")!, c.req.param("botId")!));
  });
  app.get(chatBase + "/rooms/:roomId/messages", async (c) => {
    user(c);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const beforeSeq = c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined;
    return c.json(await bridge.chatMessages(c.req.param("roomId")!, { limit, beforeSeq }));
  });
  app.post(chatBase + "/rooms/:roomId/messages", async (c) => {
    user(c);
    return c.json(await bridge.sendChatMessage(c.req.param("roomId")!, await c.req.json()), 202);
  });
  app.post(chatBase + "/rooms/:roomId/stop", async (c) => {
    user(c);
    return c.json(await bridge.stopChatRoom(c.req.param("roomId")!));
  });
  app.post(chatBase + "/rooms/:roomId/resume", async (c) => {
    user(c);
    return c.json(await bridge.resumeChatRoom(c.req.param("roomId")!));
  });
  app.put(chatBase + "/links", async (c) => {
    user(c);
    return c.json(await bridge.setChatLink(await c.req.json()));
  });
  app.delete(chatBase + "/links", (c) => {
    user(c);
    const scopeKey = c.req.query("scopeKey") ?? "";
    if (!scopeKey) throw conflict("请指定要解除的提醒绑定范围");
    return c.json(bridge.deleteChatLink(scopeKey));
  });
  app.post(chatBase + "/notify-pending", async (c) => {
    user(c);
    return c.json(await bridge.notifyPendingDecisions());
  });
  return bridge;
}
