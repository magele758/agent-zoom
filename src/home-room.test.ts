import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "./server/http.ts";
import { openStore } from "./server/logic.ts";
import type { HomeRoomBinding, HomeRoomPost } from "./home-room-types.ts";
import type { ZoomMessage } from "./zoom-types.ts";

type Quote = { messageId: string; botId: string; excerpt: string };
type Input = { text: string; mentions: string[]; idempotencyKey: string; replyTo?: Quote };
type Msg = {
  id: string;
  roomId: string;
  seq: number;
  sender: { type: "user" | "bot"; id: string; name: string };
  text: string;
  createdAt: string;
  turnId: string;
  replyTo?: Quote;
};
type Receipt = {
  message: Msg;
  turn: { id: string; roomId: string; messageId: string; botIds: string[]; mentionedBotIds: string[] };
};

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "opc-home-discussion-"));
  const store = openStore(join(root, "opc.db"));
  const user = store.localUser();
  const local = store.createRoom(user, "发现与验证", "", { project: "Test project" });
  const state = { fail: "", mode: "all-members", posts: 0, foreignCalls: 0 };
  const id = "room-fixture";
  const messages: Msg[] = [];
  const turns = new Map<string, Receipt>();
  const requests: Input[] = [];
  const remote = () => ({
    id,
    title: "临时测试房间",
    status: "active",
    replyMode: state.mode,
    botIds: ["test-a", "test-b"],
  });
  function append(type: Msg["sender"]["type"], who: string, text: string, turnId: string, replyTo?: Quote): Msg {
    const seq = messages.length + 1;
    const message: Msg = {
      id: "msg-" + seq,
      seq,
      sender: { type, id: who, name: who },
      roomId: id,
      text,
      turnId,
      createdAt: new Date().toISOString(),
      ...(replyTo && { replyTo }),
    };
    messages.push(message);
    return message;
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    function json(status: number, obj: unknown) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    }
    if (req.headers.authorization !== "Bearer test-only") return json(403, {});
    if (url.pathname === "/api/bot-work/status")
      return json(200, { bots: ["test-a", "test-b"].map((id) => ({ bot: { id, name: id }, control: {} })) });
    if (url.pathname === "/api/bot-rooms") return json(200, { rooms: [remote()] });
    if (url.pathname === "/api/bot-rooms/" + id) return json(200, { room: remote(), models: [] });
    if (url.pathname === "/api/bot-rooms/" + id + "/turns")
      return json(200, { turns: [...turns.values()].map((r) => r.turn) });
    if (url.pathname !== "/api/bot-rooms/" + id + "/messages") {
      state.foreignCalls++;
      return json(404, {});
    }
    if (req.method === "GET") {
      const cutoff = Number(url.searchParams.get("beforeSeq")) || Infinity;
      const items = messages.filter((m) => m.seq < cutoff);
      const visible = items.slice(-Math.min(Number(url.searchParams.get("limit")) || 50, 200));
      return json(200, {
        messages: visible,
        hasMore: items.length > visible.length,
        nextCursor: items.length > visible.length ? visible[0].seq : null,
      });
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Input;
    state.posts++;
    requests.push(body);
    if (state.fail === "before") return json(503, {});
    let result = turns.get(body.idempotencyKey);
    if (!result) {
      const turnId = "turn-" + (turns.size + 1);
      const message = append("user", "owner", body.text, turnId, body.replyTo);
      result = {
        message,
        turn: { id: turnId, roomId: id, messageId: message.id, botIds: body.mentions, mentionedBotIds: body.mentions },
      };
      turns.set(body.idempotencyKey, result);
    }
    if (state.fail === "after") return res.destroy();
    return json(202, result);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const old = [process.env.PPENG_BASE_URL, process.env.PPENG_TOKEN];
  process.env.PPENG_BASE_URL = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  process.env.PPENG_TOKEN = "test-only";
  let app = createApp(store);
  const cookie = (await app.app.request("/api/me")).headers.get("set-cookie")!.split(";")[0];
  t.after(() => {
    ["PPENG_BASE_URL", "PPENG_TOKEN"].forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
    server.closeAllConnections();
    server.close();
    store.db.close();
    rmSync(root, { force: true, recursive: true });
  });
  const call = (path: string, input?: object) =>
    app.app.request(path, {
      method: input ? "POST" : "GET",
      headers: { cookie, "content-type": "application/json" },
      body: input && JSON.stringify(input),
    });
  const base = "/api/opc/home-rooms";
  const bind = () => call(base, { localRoom: local.id, remoteRoom: id, botId: "test-a" });
  const restart = () => {
    app = createApp(store);
  };
  const tick = () => app.homeRooms.tick();
  return { store, local, base, bind, restart, tick, call, state, requests, messages, turns, append, remote };
}

test("named room conversation mirrors one Bot, Zoom continues its original question, replay never dispatches a task", async (t) => {
  const h = await setup(t);
  h.append("bot", "test-a", "待我答复：早于绑定的消息", "old-turn");
  assert.equal((await (await h.call(h.base + "/directory")).json()).rooms.length, 1);
  const b = (await (await h.bind()).json()) as HomeRoomBinding;
  assert.equal(b.project, "Test project");
  assert.equal((await (await h.bind()).json()).id, b.id);
  const path = h.base + "/" + b.id + "/messages";
  const body = { key: "agent/request-1", body: "/factory 作为文本讨论这个想法" };
  const responses = await Promise.all([h.call(path, body), h.call(path, body)]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [202, 202],
  );
  const out = (await responses[0].json()) as HomeRoomPost;
  assert.equal(h.state.posts, 1);
  assert.equal(out.state, "received");
  assert.deepEqual(h.requests[0].mentions, ["test-a"]);
  assert.equal(h.requests[0].text.trim().startsWith("/factory "), false);
  assert.ok(h.requests[0].text.endsWith(body.body));
  assert.deepEqual((await (await h.call("/api/zoom/messages")).json()).messages, []);
  h.append("bot", "test-b", "待我答复：其他 Bot 的问题", out.turnId!);
  h.append("bot", "test-a", "待我答复：其他讨论", "foreign-turn");
  h.append("bot", "test-a", "找到一篇同主题笔记。", out.turnId!);
  const original = h.append("bot", "test-a", "待我答复：要先验证工具包吗？", out.turnId!);
  h.restart();
  await h.tick();
  await h.tick();
  const list = (await (await h.call(path)).json()).posts as HomeRoomPost[];
  assert.deepEqual(
    list.map((p) => p.body),
    [body.body, "找到一篇同主题笔记。", original.text],
  );
  assert.equal(list[2].remoteId, original.id);
  const question = ((await (await h.call("/api/zoom/messages")).json()).messages as ZoomMessage[]).find(
    (m) => m.pending,
  )!;
  assert.equal(question.body, original.text);
  assert.equal(question.roomBinding, b.id);
  const replies = "/api/zoom/tasks/" + encodeURIComponent(question.taskId) + "/replies";
  const answer = { questionId: question.id, body: "先验证清单里的第一个。" };
  assert.equal((await h.call(replies, answer)).status, 202);
  h.restart();
  assert.equal((await h.call(replies, answer)).status, 202);
  assert.equal((await h.call(path, { key: "room-ui", body: answer.body, parent: list[2].id })).status, 202);
  assert.equal((await h.call(replies, { ...answer, body: "改写答复" })).status, 409);
  assert.equal(h.state.posts, 2);
  assert.deepEqual(h.requests[1].replyTo, { messageId: original.id, botId: "test-a", excerpt: original.text });
  assert.deepEqual(h.requests[1].mentions, ["test-a"]);
  const done = (await (await h.call("/api/zoom/messages")).json()).messages as ZoomMessage[];
  assert.equal(done.filter((m) => m.pending).length, 0);
  assert.ok(done.find((m) => m.replyTo === question.id && m.body === answer.body));
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n, 0);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get()?.n, 0);
  assert.equal(h.state.foreignCalls, 0);
});

test("lost receipt reconciles; retry only after absence is checked and with the same durable key", async (t) => {
  const h = await setup(t);
  const b = (await (await h.bind()).json()) as HomeRoomBinding;
  const path = h.base + "/" + b.id + "/messages";
  h.state.fail = "after";
  const body = { key: "same", body: "核对原帖" };
  const sent = (await (await h.call(path, body)).json()) as HomeRoomPost;
  assert.equal(sent.state, "unknown");
  assert.equal((await h.call(path + "/" + sent.id + "/retry", {})).status, 409);
  assert.equal(h.turns.size, 1);
  h.state.fail = "";
  h.restart();
  for (let i = 0; i < 208; i++) h.append("bot", "test-b", "其他讨论", "irrelevant");
  await h.tick();
  const same = (await (await h.call(path, body)).json()) as HomeRoomPost;
  assert.equal(same.state, "received");
  assert.equal(same.id, sent.id);
  assert.ok(same.remoteId);
  assert.equal(h.state.posts, 1);
  h.state.fail = "before";
  const missing = (await (await h.call(path, { key: "second", body: "下一条" })).json()) as HomeRoomPost;
  assert.equal(missing.state, "unknown");
  await h.tick();
  h.state.fail = "";
  const retry = (await (await h.call(path + "/" + missing.id + "/retry", {})).json()) as HomeRoomPost;
  assert.equal(retry.state, "received");
  assert.equal(h.turns.size, 2);
  assert.equal(h.requests[1].idempotencyKey, h.requests[2].idempotencyKey);
  assert.equal(h.state.foreignCalls, 0);
});

test("a different local channel, hidden channel or task-collaboration mode cannot adopt a Home discussion", async (t) => {
  const h = await setup(t);
  h.state.mode = "task-collaboration";
  assert.equal((await h.bind()).status, 409);
  h.state.mode = "coordinator";
  const b = (await (await h.bind()).json()) as HomeRoomBinding;
  const other = h.store.createRoom(h.store.localUser(), "另一项目", "", { project: "Elsewhere" });
  assert.equal((await h.call(h.base, { localRoom: other.id, remoteRoom: h.remote().id, botId: "test-b" })).status, 409);
  h.state.mode = "task-collaboration";
  const path = h.base + "/" + b.id + "/messages";
  const guarded = (await (await h.call(path, { key: "test", body: "先讨论" })).json()) as HomeRoomPost;
  assert.equal(guarded.state, "unknown");
  assert.equal(h.state.posts, 0);
  h.store.db.prepare("UPDATE room_members SET hidden=1 WHERE room_id=?").run(h.local.id);
  assert.equal((await h.call(path)).status, 403);
  assert.equal((await h.call(path, { key: "hidden", body: "新讨论" })).status, 403);
  assert.equal(h.state.posts, 0);
});

test("idea references and individual post detail resolve bidirectionally within member rooms", async (t) => {
  const h = await setup(t);
  const b = (await (await h.bind()).json()) as HomeRoomBinding;
  const ideaId = "11111111-2222-4333-8444-555555555555";
  const path = h.base + "/" + b.id + "/messages";
  const posted = (await (
    await h.call(path, { key: "idea-ref-1", body: `围绕想法讨论\n来源：#ideas?idea=${ideaId}` })
  ).json()) as HomeRoomPost;
  assert.equal(posted.state, "received");
  const refsRes = await h.call(h.base + "/references?idea=" + ideaId);
  assert.equal(refsRes.status, 200);
  const { references } = await refsRes.json();
  assert.equal(references.length, 1);
  assert.equal(references[0].bindingId, b.id);
  assert.equal(references[0].postId, posted.id);
  assert.equal(references[0].botName, "test-a");
  assert.equal((await h.call(h.base + "/references?idea=not-a-uuid")).status, 400);
  const detailRes = await h.call(path + "/" + posted.id);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.binding.id, b.id);
  assert.equal(detail.post.id, posted.id);
  assert.equal((await h.call(path + "/missing-post")).status, 404);
  h.store.db.prepare("UPDATE room_members SET hidden=1 WHERE room_id=?").run(h.local.id);
  const hiddenRefs = await (await h.call(h.base + "/references?idea=" + ideaId)).json();
  assert.equal(hiddenRefs.references.length, 0);
  assert.equal((await h.call(path + "/" + posted.id)).status, 403);
});

test("direct Agent Home group chat manages multi-bot rooms, links, idea refs and idempotent pending notifications", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opc-home-chat-"));
  const store = openStore(join(root, "opc.db"));
  type RemoteRoom = { id: string; title: string; status: string; botIds: string[]; hostBotId?: string; replyMode: string };
  const rooms = new Map<string, RemoteRoom>();
  const messagesByRoom = new Map<string, Msg[]>();
  const turnsByRoom = new Map<string, Receipt["turn"][]>();
  const byIdem = new Map<string, Receipt>();
  let roomSeq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const readJson = async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      return raw ? JSON.parse(raw) : {};
    };
    if (req.headers.authorization !== "Bearer chat-only") return json(403, {});
    if (url.pathname === "/api/bot-work/status") {
      return json(200, {
        bots: [
          { bot: { id: "bot-pm", name: "产品经理" }, control: {} },
          { bot: { id: "bot-eng", name: "架构师" }, control: {} },
          { bot: { id: "bot-qa", name: "测试员" }, control: {} },
        ],
      });
    }
    if (url.pathname === "/api/bot-rooms" && req.method === "GET") {
      return json(200, { rooms: [...rooms.values()] });
    }
    if (url.pathname === "/api/bot-rooms" && req.method === "POST") {
      const input = await readJson();
      const id = "chat-room-" + ++roomSeq;
      const room: RemoteRoom = {
        id,
        title: input.title,
        status: "active",
        botIds: [...input.botIds],
        ...(input.hostBotId ? { hostBotId: input.hostBotId } : {}),
        replyMode: "coordinator",
      };
      rooms.set(id, room);
      messagesByRoom.set(id, []);
      turnsByRoom.set(id, []);
      return json(201, { room });
    }
    const match = /^\/api\/bot-rooms\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json(404, {});
    const roomId = decodeURIComponent(match[1]);
    const rest = match[2] ?? "";
    const room = rooms.get(roomId);
    if (!room) return json(404, {});
    if (!rest && req.method === "GET") return json(200, { room, models: [] });
    if (!rest && req.method === "PATCH") {
      const patch = await readJson();
      Object.assign(room, patch);
      return json(200, { room });
    }
    if (rest === "members" && req.method === "POST") {
      const { botId } = await readJson();
      if (!room.botIds.includes(botId)) room.botIds.push(botId);
      return json(200, { room });
    }
    if (rest.startsWith("members/") && req.method === "DELETE") {
      const botId = decodeURIComponent(rest.slice("members/".length));
      room.botIds = room.botIds.filter((id) => id !== botId);
      return json(200, { room });
    }
    if (rest === "stop" && req.method === "POST") {
      room.status = "paused";
      return json(200, { room });
    }
    if (rest === "resume" && req.method === "POST") {
      room.status = "active";
      return json(200, { room });
    }
    if (rest === "turns" && req.method === "GET") {
      return json(200, { turns: turnsByRoom.get(roomId) ?? [] });
    }
    if (rest === "messages" && req.method === "GET") {
      const list = messagesByRoom.get(roomId) ?? [];
      return json(200, { messages: list, hasMore: false, nextCursor: null });
    }
    if (rest === "messages" && req.method === "POST") {
      const input = await readJson();
      const key = `${roomId}:${input.idempotencyKey}`;
      let existing = byIdem.get(key);
      if (!existing) {
        const list = messagesByRoom.get(roomId)!;
        const seq = list.length + 1;
        const turnId = `t-${roomId}-${seq}`;
        const message: Msg = {
          id: `m-${roomId}-${seq}`,
          roomId,
          seq,
          sender: { type: "user", id: "founder", name: "创始人" },
          text: input.text,
          createdAt: new Date().toISOString(),
          turnId,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        };
        list.push(message);
        const turn = {
          id: turnId,
          roomId,
          messageId: message.id,
          botIds: input.mentions?.length ? input.mentions : room.botIds,
          mentionedBotIds: input.mentions ?? [],
        };
        turnsByRoom.get(roomId)!.push(turn);
        existing = { message, turn };
        byIdem.set(key, existing);
      }
      return json(202, existing);
    }
    return json(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const old = [process.env.PPENG_BASE_URL, process.env.PPENG_TOKEN];
  process.env.PPENG_BASE_URL = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  process.env.PPENG_TOKEN = "chat-only";
  const created = createApp(store);
  const cookie = (await created.app.request("/api/me")).headers.get("set-cookie")!.split(";")[0];
  t.after(() => {
    ["PPENG_BASE_URL", "PPENG_TOKEN"].forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
    server.close();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const call = (path: string, method = "GET", body?: unknown) =>
    created.app.request(path, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  // 1. Overview lists bots directly without any local channel bindings.
  const initRes = await call("/api/opc/home-chat/overview");
  assert.equal(initRes.status, 200);
  const initOverview = await initRes.json();
  assert.equal(initOverview.available, true);
  assert.equal(initOverview.bots.length, 3);
  assert.equal(initOverview.rooms.length, 0);

  // 2. Create two multi-bot group chats: one default, one scoped to business line 'shop'.
  const createDefault = await call("/api/opc/home-chat/rooms", "POST", {
    title: "OPC 总控群",
    botIds: ["bot-pm", "bot-eng"],
    hostBotId: "bot-pm",
    replyMode: "all-members",
    scopeKey: "default",
  });
  assert.equal(createDefault.status, 201);
  const defaultRoom = (await createDefault.json()).room;
  assert.equal(defaultRoom.replyMode, "all-members");

  const createShop = await call("/api/opc/home-chat/rooms", "POST", {
    title: "店铺运营群",
    botIds: ["bot-pm"],
    scopeKey: "line:shop",
  });
  assert.equal(createShop.status, 201);
  const shopRoom = (await createShop.json()).room;

  // 3. Member management, pause/resume, and multi-bot message with idea link capture.
  assert.equal((await call(`/api/opc/home-chat/rooms/${defaultRoom.id}/members`, "POST", { botId: "bot-qa" })).status, 200);
  assert.equal((await call(`/api/opc/home-chat/rooms/${defaultRoom.id}/members/bot-qa`, "DELETE")).status, 200);
  assert.equal((await call(`/api/opc/home-chat/rooms/${defaultRoom.id}/stop`, "POST", {})).status, 200);
  assert.equal(rooms.get(defaultRoom.id)?.status, "paused");
  assert.equal((await call(`/api/opc/home-chat/rooms/${defaultRoom.id}/resume`, "POST", {})).status, 200);

  const ideaId = "22222222-3333-4444-8555-666666666666";
  const sendRes = await call(`/api/opc/home-chat/rooms/${defaultRoom.id}/messages`, "POST", {
    text: `请两位一起评审这个想法\n来源：#ideas?idea=${ideaId}`,
    mentions: ["bot-pm", "bot-eng"],
  });
  assert.equal(sendRes.status, 202);
  const ideaRefs = await (await call(`/api/opc/home-rooms/references?idea=${ideaId}`)).json();
  assert.equal(ideaRefs.references.length, 1);
  assert.equal(ideaRefs.references[0].roomId, defaultRoom.id);

  // 4. Scoped automatic pending decision notifications (idempotent & zero echo loops).
  const fakePending: ZoomMessage[] = [
    {
      origin: "workflow",
      id: "workflow:card:c1",
      taskId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      taskTitle: "上线新支付网关",
      source: "codex",
      folder: "产品甲/支付",
      context: "ctx-1",
      kind: "decision",
      body: "请确认 r1 计划",
      at: new Date().toISOString(),
      pending: true,
    },
    {
      origin: "external",
      id: "trial-q-1",
      taskId: "t-shop-1",
      taskTitle: "商品草稿抽查",
      source: "OPC OS · 经营实验",
      folder: "店铺运营",
      context: "",
      kind: "question",
      body: "是否继续抽查？",
      choices: ["继续", "调整", "暂停"],
      businessTrial: { lineId: "shop", trialId: "trial-1" },
      at: new Date().toISOString(),
      pending: true,
    },
    {
      origin: "external",
      id: "home-room:echo-guard",
      taskId: "home-room:echo-guard",
      taskTitle: "不该回环的消息",
      source: "Bot · Agent Home",
      folder: "产品甲",
      context: "",
      kind: "question",
      roomBinding: "binding-1",
      body: "待我答复：不要回推",
      at: new Date().toISOString(),
      pending: true,
    },
  ];
  created.homeRooms.attachPendingSource(() => fakePending);
  const firstPush = await created.homeRooms.notifyPendingDecisions();
  assert.equal(firstPush.sent, 2);
  const secondPush = await created.homeRooms.notifyPendingDecisions();
  assert.equal(secondPush.sent, 0);

  const defaultMsgs = messagesByRoom.get(defaultRoom.id)!;
  const shopMsgs = messagesByRoom.get(shopRoom.id)!;
  assert.ok(defaultMsgs.some((m) => m.text.includes("#workflows/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")));
  assert.equal(defaultMsgs.some((m) => m.text.includes("不要回推")), false);
  assert.equal(shopMsgs.length, 1);
  assert.match(shopMsgs[0].text, /#business-lines\?line=shop&trial=trial-1/);
  assert.match(shopMsgs[0].text, /继续 \/ 调整 \/ 暂停/);
});
