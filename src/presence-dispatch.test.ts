import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./server/http.ts";
import { ApiError, PRESENCE_MS, openStore, type Principal, type Store } from "./server/logic.ts";

function studio(name = "磊") {
  const store = openStore(":memory:", { demo: true });
  const session = store.session(name);
  const user = store.userBySession(session.token);
  assert.ok(user && user.type === "user");
  const roomId = store.listRooms(user.id)[0].id;
  return { store, user, roomId };
}

function enroll(store: Store, user: Principal & { type: "user" }, roomId: string, handle: string, tags = "build") {
  const joined = store.enroll(store.createJoinCode(user, roomId).code, handle, "cursor", tags, 1);
  const agent = store.agentByToken(joined.token);
  assert.ok(agent && agent.type === "agent");
  return { agent, token: joined.token };
}

function events(store: Store, agentId: string, type?: string) {
  const rows = store.inboxAfter(agentId, 0);
  return type ? rows.filter((row) => row.event_type === type) : rows;
}

function onlineOf(store: Store, user: Principal & { type: "user" }, roomId: string, handle: string) {
  const agents = store.snapshot(user, roomId, new Set()).members.agents;
  return agents.find((agent) => agent.handle === handle)?.online;
}

function ageSeen(store: Store, agentId: string, ms: number) {
  store.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - ms).toISOString(), agentId);
}

test("a desktop client that never long-polls is online after it speaks, and drops off after the timeout", () => {
  const { store, user, roomId } = studio();
  const { agent } = enroll(store, user, roomId, "cursor");
  assert.equal(onlineOf(store, user, roomId, "cursor"), false);
  store.postMessage(agent, roomId, { kind: "chat", body: "我在" });
  assert.equal(onlineOf(store, user, roomId, "cursor"), true);
  ageSeen(store, agent.id, PRESENCE_MS - 5_000);
  assert.equal(onlineOf(store, user, roomId, "cursor"), true);
  ageSeen(store, agent.id, PRESENCE_MS + 5_000);
  assert.equal(onlineOf(store, user, roomId, "cursor"), false);
});

test("bids and claims count as activity, a paused agent never shows online", () => {
  const { store, user, roomId } = studio();
  const { agent } = enroll(store, user, roomId, "chatgpt");
  const other = enroll(store, user, roomId, "claude-desk");
  const task = store.postMessage(user, roomId, { kind: "instruction", body: "做点事", tags: "build" }).task;
  assert.ok(task);
  assert.equal(onlineOf(store, user, roomId, "chatgpt"), false);
  try {
    store.bid(agent, task.id, "我来做");
  } catch {
    /* bidding may be closed for a lone idle agent; the attempt itself is activity */
  }
  assert.equal(onlineOf(store, user, roomId, "chatgpt"), true);
  store.setPaused(user, other.agent.id, true);
  store.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), other.agent.id);
  assert.equal(onlineOf(store, user, roomId, "claude-desk"), false);
});

test("any authenticated agent API call and the lightweight ping refresh presence", async () => {
  const { store, user, roomId } = studio();
  const { agent, token } = enroll(store, user, roomId, "cursor");
  const { app } = createApp(store);
  assert.equal(onlineOf(store, user, roomId, "cursor"), false);
  const pinged = await app.request("/api/agent/ping", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(pinged.status, 200);
  assert.equal(onlineOf(store, user, roomId, "cursor"), true);
  ageSeen(store, agent.id, PRESENCE_MS + 5_000);
  assert.equal(onlineOf(store, user, roomId, "cursor"), false);
  const me = await app.request("/api/agent/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal(onlineOf(store, user, roomId, "cursor"), true);
  const bad = await app.request("/api/agent/ping", { method: "POST", headers: { authorization: "Bearer nope" } });
  assert.equal(bad.status, 401);
});

test("an instruction that @-names an agent skips bidding and reaches only that agent, once", () => {
  const { store, user, roomId } = studio();
  const cursor = enroll(store, user, roomId, "cursor").agent;
  const others = ["chatgpt", "claude-desk", "codex"].map((handle) => enroll(store, user, roomId, handle).agent);
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "@cursor 你在线了吗" });
  const task = posted.task;
  assert.ok(task);
  assert.equal(task.status, "open");
  assert.equal(events(store, cursor.id, "task_open").length, 1);
  assert.equal(events(store, cursor.id, "mention").length, 0);
  assert.equal(events(store, cursor.id, "bid_open").length, 0);
  assert.equal(events(store, cursor.id, "room").length, 0);
  const demo = store.db.prepare("SELECT id FROM agents WHERE demo = 1").all() as Array<{ id: string }>;
  for (const id of [...others.map((agent) => agent.id), ...demo.map((row) => row.id)]) {
    const mine = events(store, id).filter((row) => ["task_open", "bid_open", "mention", "room"].includes(row.event_type));
    assert.equal(mine.length, 0, "unnamed agents hear nothing");
  }
  const rows = store.db.prepare("SELECT kind, body FROM messages WHERE room_id = ? AND body LIKE '%你在线了吗%'").all(roomId) as Array<{ kind: string; body: string }>;
  assert.equal(rows.length, 1);
  const bidding = store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND body LIKE '%秒内用 bid%'").get(roomId) as { n: number };
  assert.equal(bidding.n, 0);
  assert.throws(() => store.claim(others[0], task.id, "implementer"), (error: unknown) => error instanceof ApiError && error.code === "not_addressed");
  const claimed = store.claim(cursor, task.id, "implementer");
  assert.equal(claimed.status, "claimed");
});

test("re-announcing a named instruction does not notify the same agent twice", () => {
  const { store, user, roomId } = studio();
  const cursor = enroll(store, user, roomId, "cursor").agent;
  store.postMessage(user, roomId, { kind: "instruction", body: "@cursor 跑一下检查" });
  enroll(store, user, roomId, "late-joiner");
  assert.equal(events(store, cursor.id, "task_open").length, 1);
});

test("naming several agents sends the task to each of them and nobody else", () => {
  const { store, user, roomId } = studio();
  const a = enroll(store, user, roomId, "alpha").agent;
  const b = enroll(store, user, roomId, "beta").agent;
  const c = enroll(store, user, roomId, "gamma").agent;
  const task = store.postMessage(user, roomId, { kind: "instruction", body: "@alpha @beta 看一下" }).task;
  assert.ok(task);
  assert.equal(events(store, a.id, "task_open").length, 1);
  assert.equal(events(store, b.id, "task_open").length, 1);
  assert.equal(events(store, c.id).filter((row) => row.event_type === "task_open").length, 0);
});

test("naming a paused agent does not fall back to open bidding", () => {
  const { store, user, roomId } = studio();
  const a = enroll(store, user, roomId, "alpha").agent;
  const b = enroll(store, user, roomId, "beta").agent;
  store.setPaused(user, a.id, true);
  const task = store.postMessage(user, roomId, { kind: "instruction", body: "@alpha 做这个" }).task;
  assert.ok(task);
  assert.equal(task.status, "open");
  assert.equal(events(store, b.id).filter((row) => ["bid_open", "task_open"].includes(row.event_type)).length, 0);
  const note = store.db.prepare("SELECT body FROM messages WHERE task_id = ? AND kind = 'system'").get(task.id) as { body: string };
  assert.match(note.body, /已暂停/);
});

test("an instruction without @ still opens bidding for everyone eligible", () => {
  const { store, user, roomId } = studio();
  const a = enroll(store, user, roomId, "alpha").agent;
  const b = enroll(store, user, roomId, "beta").agent;
  const task = store.postMessage(user, roomId, { kind: "instruction", body: "做这个", tags: "build" }).task;
  assert.ok(task);
  assert.equal(task.status, "bidding");
  assert.equal(events(store, a.id, "bid_open").length, 1);
  assert.equal(events(store, b.id, "bid_open").length, 1);
});

test("an @ in plain chat still only wakes the named agent", () => {
  const { store, user, roomId } = studio();
  const a = enroll(store, user, roomId, "alpha").agent;
  const b = enroll(store, user, roomId, "beta").agent;
  store.postMessage(user, roomId, { kind: "chat", body: "@alpha 在吗" });
  assert.equal(events(store, a.id, "mention").length, 1);
  assert.equal(events(store, b.id).length, 0);
});

test("reassigning agents moves a client to the right owner and keeps its token", () => {
  const owner = studio("彭磊");
  const store = owner.store;
  const wrong = store.session("magele758");
  const wrongUser = store.userBySession(wrong.token);
  assert.ok(wrongUser && wrongUser.type === "user");
  const wrongRoom = store.listRooms(wrongUser.id)[0].id;
  const mine = enroll(store, owner.user, owner.roomId, "cursor");
  const theirs = enroll(store, wrongUser, wrongRoom, "cursor");
  const desk = enroll(store, wrongUser, wrongRoom, "claude-desk");
  store.postMessage(theirs.agent, wrongRoom, { kind: "chat", body: "hi" });

  const preview = store.reassignAgents({ from: "magele758", to: "彭磊" });
  assert.equal(preview.applied, false);
  assert.equal(preview.steps.find((step) => step.handle === "cursor")?.action, "skip");
  assert.equal(preview.steps.find((step) => step.handle === "claude-desk")?.action, "move");
  const unchanged = store.db.prepare("SELECT owner_user_id FROM agents WHERE id = ?").get(desk.agent.id) as { owner_user_id: string };
  assert.equal(unchanged.owner_user_id, wrongUser.id);

  const applied = store.reassignAgents({ from: "magele758", to: "彭磊", displace: true, apply: true });
  assert.equal(applied.applied, true);
  const moved = store.db.prepare("SELECT owner_user_id, org_id, handle FROM agents WHERE id = ?").get(theirs.agent.id) as {
    owner_user_id: string;
    org_id: string;
    handle: string;
  };
  assert.equal(moved.owner_user_id, owner.user.id);
  assert.equal(moved.handle, "cursor");
  const displaced = store.db.prepare("SELECT handle, paused FROM agents WHERE id = ?").get(mine.agent.id) as { handle: string; paused: number };
  assert.deepEqual({ ...displaced }, { handle: "cursor-old", paused: 1 });
  assert.equal(store.agentByToken(theirs.token)?.type, "agent");
  assert.equal(store.credentialOwner(theirs.token)?.ownerName, "彭磊");
  const inLobby = store.snapshot(owner.user, owner.roomId, new Set()).members.agents.map((agent) => agent.handle);
  assert.ok(inLobby.includes("cursor") && inLobby.includes("claude-desk"));
  const demoLeft = store.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_user_id = ? AND demo = 1").get(wrongUser.id) as { n: number };
  assert.equal(demoLeft.n, 4);
});

test("owner repair preserves multiple old identities and refuses to displace a busy target", () => {
  const { store, user, roomId } = studio("正确主人");
  const wrong = store.session("错误主人");
  const wrongUser = store.userBySession(wrong.token)! as Principal & { type: "user" };
  const wrongRoom = store.listRooms(wrongUser.id)[0].id;
  const old = enroll(store, user, roomId, "cursor-old");
  const current = enroll(store, user, roomId, "cursor");
  const real = enroll(store, wrongUser, wrongRoom, "cursor");
  const task = store.postMessage(user, roomId, { kind: "instruction", body: "@cursor 活跃任务" }).task!;
  store.claim(current.agent, task.id, "implementer");
  const blocked = store.reassignAgents({ from: "错误主人", to: "正确主人", displace: true, apply: true });
  assert.equal(blocked.steps[0].action, "skip");
  store.release(current.agent, task.id, "implementer");
  const moved = store.reassignAgents({ from: "错误主人", to: "正确主人", displace: true, apply: true });
  assert.equal(moved.steps[0].action, "move_displacing");
  assert.equal(store.credentialOwner(real.token)?.ownerId, user.id);
  assert.equal(store.db.prepare("SELECT handle FROM agents WHERE id = ?").get(current.agent.id)?.handle, "cursor-old-2");
  assert.equal(store.db.prepare("SELECT handle FROM agents WHERE id = ?").get(old.agent.id)?.handle, "cursor-old");
});
