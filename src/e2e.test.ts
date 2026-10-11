import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { GROUPS } from "./groups.ts";
import { MAX_LEVEL, MIN_LEVEL, PRESENCE_MS } from "./server/logic.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OWNER = "彭磊";

type Json = Record<string, any>;
type Agent = { handle: string; id: string; token: string };

let child: ChildProcess;
let base = "";
let dir = "";
let dbPath = "";
let log = "";
let cookie = "";
let roomId = "";
const agents: Record<string, Agent> = {};

function freePort() {
  return new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 6000) {
  const end = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < end) {
    await sleep(150);
    value = await read();
  }
  return value;
}

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  else if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, headers: response.headers };
}

const snapshot = async () => (await call(`/api/rooms/${roomId}`)).data;
const agentRow = async (handle: string) => (await snapshot()).members.agents.find((agent: Json) => agent.handle === handle);
const post = (body: string, kind = "instruction", extra: Json = {}) =>
  call(`/api/rooms/${roomId}/messages`, { body: { body, kind, ...extra } });
const inbox = async (handle: string, type?: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const events = db
      .prepare("SELECT event_type, ref_id FROM inbox WHERE recipient_id = ? ORDER BY id")
      .all(agents[handle].id) as Array<{ event_type: string; ref_id: string }>;
    return type ? events.filter((event) => event.event_type === type) : events;
  } finally {
    db.close();
  }
};
const bidsOn = (messages: Json[], taskId: string) => messages.filter((m) => m.taskId === taskId && m.kind === "bid");

function ageSeen(handle: string, ms: number) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - ms).toISOString(), agents[handle].id);
  } finally {
    db.close();
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "gongwei-e2e-"));
  dbPath = join(dir, "chatroom.db");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["src/server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_PATH: dbPath, AGENT_CHATROOM_CREDENTIALS: join(dir, "credentials.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (log += chunk));
  child.stderr?.on("data", (chunk) => (log += chunk));
  const ready = await until(
    async () => {
      try {
        return (await fetch(`${base}/api/health`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    20_000,
  );
  assert.ok(ready, `server did not start\n${log}`);
});

after(() => {
  child?.kill("SIGTERM");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("entering as the owner names the user and lands in 大厅 with the demo cast", async () => {
  assert.equal((await call("/api/me")).status, 401);
  const entered = await call("/api/session", { body: { name: OWNER } });
  assert.equal(entered.status, 200);
  const set = entered.headers.get("set-cookie") ?? "";
  assert.match(set, /ac_session=/);
  cookie = set.split(";")[0];
  roomId = entered.data.roomId;

  const me = (await call("/api/me")).data;
  assert.equal(me.user.name, OWNER);
  assert.equal(me.orgs[0].name, "工作室");
  const hall = me.rooms.find((room: Json) => room.id === roomId);
  assert.equal(hall.name, "大厅");
  assert.equal(hall.general, true);

  const again = await call("/api/session", { body: { name: OWNER } });
  assert.equal(again.data.user.id, me.user.id, "same name is the same studio");
  assert.equal(again.data.roomId, null, "an existing studio has no new hall");
  assert.equal((await call("/api/me")).data.rooms[0].id, roomId, "the page opens on 大厅");

  const snap = await snapshot();
  assert.deepEqual(snap.members.users.map((user: Json) => user.name), [OWNER]);
  const demo = snap.members.agents.filter((agent: Json) => agent.demo);
  assert.deepEqual(demo.map((agent: Json) => agent.handle).sort(), ["builder", "maker", "qa", "reviewer"]);
  for (const agent of demo) {
    assert.equal(agent.ownerName, OWNER);
    assert.equal(agent.level, 1);
  }
});

test("seven roles exist and an agent can be re-grouped, and the demo cast stays level 1 to 5", async () => {
  assert.deepEqual(
    GROUPS.map((group) => group.id),
    ["research", "product", "design", "architect", "build", "review", "test"],
  );
  assert.deepEqual(
    GROUPS.map((group) => group.phase),
    ["design", "design", "design", "design", "build", "check", "check"],
  );
  const qa = await agentRow("qa");
  assert.equal(qa.tags, "test");
  assert.equal((await call(`/api/agents/${qa.id}`, { method: "PATCH", body: { group: "architect" } })).status, 200);
  assert.equal((await agentRow("qa")).tags, "architect");
  assert.equal((await call(`/api/agents/${qa.id}`, { method: "PATCH", body: { group: "nope" } })).status, 400);
  await call(`/api/agents/${qa.id}`, { method: "PATCH", body: { group: "test" } });

  const builder = await agentRow("builder");
  for (const level of [MIN_LEVEL, MAX_LEVEL]) {
    const set = await call(`/api/agents/${builder.id}/level`, { method: "PATCH", body: { level } });
    assert.equal(set.status, 200);
    assert.equal((await agentRow("builder")).level, level);
  }
  await call(`/api/agents/${builder.id}/level`, { method: "PATCH", body: { level: 1 } });
  const wild = await call(`/api/agents/${builder.id}/level`, { method: "PATCH", body: { level: 99 } });
  assert.ok((await agentRow("builder")).level <= MAX_LEVEL);
  assert.ok(wild.status === 200 || wild.status === 400);
});

test("a join code enrolls agents under the owner with a role, level, machine and directory", async () => {
  for (const handle of ["cursor", "chatgpt", "claude-desk"]) {
    const code = await call(`/api/rooms/${roomId}/join-codes`, { method: "POST", body: {} });
    assert.equal(code.status, 200);
    const joined = await call("/api/enroll", {
      body: { code: code.data.code, handle, runtime: handle, tags: "build", level: 1, machine: "e2e-mac", cwd: "/tmp/e2e" },
    });
    assert.equal(joined.status, 200);
    agents[handle] = { handle, id: "", token: joined.data.token };
  }
  const snap = await snapshot();
  for (const handle of Object.keys(agents)) {
    const row = snap.members.agents.find((agent: Json) => agent.handle === handle);
    assert.ok(row, `${handle} is in 大厅`);
    agents[handle].id = row.id;
    assert.equal(row.ownerName, OWNER);
    assert.equal(row.level, 1);
    assert.equal(row.tags, "build");
    assert.equal(row.machine, "e2e-mac");
    assert.equal(row.demo, false);
  }
  const reused = await call("/api/enroll", { body: { code: "join_used_or_wrong", handle: "x" } });
  assert.ok(reused.status >= 400);
});

test("the local-client list for 这台电脑 answers with a catalog and marks what is already in the room", async () => {
  const listed = await call(`/api/rooms/${roomId}/local-agents`);
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.data.agents));
  for (const agent of listed.data.agents) {
    assert.equal(typeof agent.id, "string");
    assert.equal(typeof agent.connected, "boolean");
  }
  cookie = "";
  assert.equal((await call(`/api/rooms/${roomId}/local-agents`)).status, 401);
  cookie = (await call("/api/session", { body: { name: OWNER } })).headers.get("set-cookie")!.split(";")[0];
});

test("presence: silent until the first sign of life, a ping brings it online, and it expires", async () => {
  assert.equal((await agentRow("cursor")).online, false);
  const bad = await call("/api/agent/ping", { method: "POST", body: {}, token: "agt_nope" });
  assert.equal(bad.status, 401);
  const pinged = await call("/api/agent/ping", { method: "POST", body: {}, token: agents.cursor.token });
  assert.equal(pinged.status, 200);
  assert.equal(pinged.data.presenceMs, PRESENCE_MS);
  assert.equal((await agentRow("cursor")).online, true);
  assert.equal((await agentRow("chatgpt")).online, false, "someone else's ping is not mine");
  ageSeen("cursor", PRESENCE_MS - 10_000);
  assert.equal((await agentRow("cursor")).online, true);
  ageSeen("cursor", PRESENCE_MS + 10_000);
  assert.equal((await agentRow("cursor")).online, false);
  await call("/api/agent/me", { token: agents.cursor.token });
  assert.equal((await agentRow("cursor")).online, true);

  const paused = await call(`/api/agents/${agents["claude-desk"].id}`, { method: "PATCH", body: { paused: true } });
  assert.equal(paused.status, 200);
  await call("/api/agent/ping", { method: "POST", body: {}, token: agents["claude-desk"].token });
  assert.equal((await agentRow("claude-desk")).online, false, "a paused agent never shows online");
  await call(`/api/agents/${agents["claude-desk"].id}`, { method: "PATCH", body: { paused: false } });
});

test("posting an instruction that @-names an agent: direct dispatch, no bids, one copy, one wake", async () => {
  const text = "@cursor 你在线了吗 e2e-named";
  const posted = await post(text);
  assert.equal(posted.status, 200);
  const task = posted.data.task;
  assert.equal(task.status, "open");
  assert.equal(task.title, text);

  await sleep(1500);
  const snap = await snapshot();
  const copies = snap.messages.filter((m: Json) => m.authorType === "user" && m.body === text);
  assert.equal(copies.length, 1, "the instruction appears once");
  assert.equal(copies[0].kind, "instruction");
  assert.deepEqual(copies[0].addressed.map((who: Json) => who.handle), ["cursor"]);
  assert.equal(bidsOn(snap.messages, task.id).length, 0, "nobody bids on a named instruction");
  assert.equal(snap.messages.filter((m: Json) => m.taskId === task.id && /不开放投标/.test(m.body)).length, 1);
  assert.equal(snap.messages.filter((m: Json) => m.taskId === task.id && /内用 bid/.test(m.body)).length, 0);
  const card = snap.tasks.find((item: Json) => item.id === task.id);
  assert.equal(card.status, "open");
  assert.equal(card.claims.length, 0, "demo agents did not grab it");

  assert.equal((await inbox("cursor", "task_open")).filter((e) => e.ref_id === task.id).length, 1);
  for (const other of ["chatgpt", "claude-desk"]) {
    const events = (await inbox(other)).filter((e) => e.ref_id === task.id || e.event_type === "bid_open");
    assert.equal(events.length, 0, `${other} is not woken`);
  }

  const stolen = await call(`/api/agent/tasks/${task.id}/claim`, { body: { role: "implementer" }, token: agents.chatgpt.token });
  assert.equal(stolen.status >= 400, true);
  assert.equal(stolen.data.error, "not_addressed");
  const claimed = await call(`/api/agent/tasks/${task.id}/claim`, { body: { role: "implementer" }, token: agents.cursor.token });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.status, "claimed");
  await call(`/api/tasks/${task.id}/cancel`, { method: "POST" });
});

test("posting an instruction without @ opens bidding: every eligible agent hears it, demo agents bid, one winner", async () => {
  const text = "整理一下 README e2e-open";
  const posted = await post(text, "instruction", { tags: "build" });
  assert.equal(posted.status, 200);
  const task = posted.data.task;
  assert.equal(task.status, "bidding");

  for (const handle of ["cursor", "chatgpt", "claude-desk"]) {
    assert.equal((await inbox(handle, "bid_open")).filter((e) => e.ref_id === task.id).length, 1, `${handle} gets bid_open once`);
  }
  const bid = await call(`/api/agent/tasks/${task.id}/bid`, { body: { approach: "我先读 README，再改。" }, token: agents.chatgpt.token });
  assert.equal(bid.status, 200);
  const again = await call(`/api/agent/tasks/${task.id}/bid`, { body: { approach: "再来一次" }, token: agents.chatgpt.token });
  assert.equal(again.data.error, "already_bid");

  const snap = await until(snapshot, (value) => bidsOn(value.messages, task.id).length >= 3);
  const bids = bidsOn(snap.messages, task.id);
  assert.ok(bids.length >= 3, `chatgpt + the two demo builders bid, got ${bids.length}`);
  assert.equal(snap.messages.filter((m: Json) => m.authorType === "user" && m.body === text).length, 1);
  assert.equal(snap.messages.filter((m: Json) => m.taskId === task.id && /内用 bid/.test(m.body)).length, 1);
  assert.equal(snap.messages.filter((m: Json) => m.taskId === task.id && /不开放投标/.test(m.body)).length, 0);
  for (const handle of ["cursor", "claude-desk"]) {
    await call(`/api/agent/tasks/${task.id}/bid`, { body: { approach: `${handle} 来做` }, token: agents[handle].token });
  }
  const awarded = await until(snapshot, (value) => value.tasks.find((t: Json) => t.id === task.id)?.claims.some((c: Json) => c.role === "implementer"));
  const card = awarded.tasks.find((t: Json) => t.id === task.id);
  assert.equal(card.claims.filter((c: Json) => c.role === "implementer").length, 1, "exactly one implementer wins");
  await call(`/api/tasks/${task.id}/cancel`, { method: "POST" });
});

test("an untagged instruction without @ is also open to everyone idle, not just one role", async () => {
  const posted = await post("随便谁来 e2e-untagged");
  assert.equal(posted.data.task.status, "bidding");
  const targets = ["cursor", "chatgpt", "claude-desk"];
  for (const handle of targets) {
    assert.equal((await inbox(handle, "bid_open")).filter((e) => e.ref_id === posted.data.task.id).length, 1);
  }
  await call(`/api/tasks/${posted.data.task.id}/cancel`, { method: "POST" });
});

test("a slot lifecycle: implementer, then reviewer, then tester, and done", async () => {
  await call(`/api/agents/${(await agentRow("reviewer")).id}`, { method: "PATCH", body: { paused: true } });
  await call(`/api/agents/${(await agentRow("qa")).id}`, { method: "PATCH", body: { paused: true } });
  const code = await call(`/api/rooms/${roomId}/join-codes`, { method: "POST", body: {} });
  const rev = await call("/api/enroll", { body: { code: code.data.code, handle: "rev-e2e", runtime: "x", tags: "review", level: 1 } });
  const code2 = await call(`/api/rooms/${roomId}/join-codes`, { method: "POST", body: {} });
  const qa = await call("/api/enroll", { body: { code: code2.data.code, handle: "qa-e2e", runtime: "x", tags: "test", level: 1 } });

  const posted = await post("@claude-desk 做一个按钮 e2e-slots", "instruction", { acceptance: "按钮能点" });
  const id = posted.data.task.id;
  const vacant = async () => (await snapshot()).tasks.find((t: Json) => t.id === id);
  assert.equal((await vacant()).claims.length, 0);

  const slot = agents["claude-desk"].token;
  assert.equal((await call(`/api/agent/tasks/${id}/claim`, { body: { role: "implementer" }, token: slot })).status, 200);
  assert.deepEqual((await vacant()).claims.map((c: Json) => c.role), ["implementer"]);
  const early = await call(`/api/agent/tasks/${id}/claim`, { body: { role: "reviewer" }, token: rev.data.token });
  assert.equal(early.data.error, "bad_state", "review slot is shut before delivery");
  const delivered = await call(`/api/agent/tasks/${id}/deliver`, { body: { ref: "workspace:e2e", summary: "好了" }, token: slot });
  assert.equal(delivered.status, 200);
  assert.equal((await vacant()).status, "in_review");
  const own = await call(`/api/agent/tasks/${id}/claim`, { body: { role: "reviewer" }, token: slot });
  assert.equal(own.data.error, "own_work");
  assert.equal((await call(`/api/agent/tasks/${id}/claim`, { body: { role: "reviewer" }, token: rev.data.token })).status, 200);
  const reviewed = await call(`/api/agent/tasks/${id}/review`, { body: { verdict: "approve", body: "过" }, token: rev.data.token });
  assert.equal(reviewed.data.status, "in_test");
  assert.equal((await call(`/api/agent/tasks/${id}/claim`, { body: { role: "tester" }, token: qa.data.token })).status, 200);
  const tested = await call(`/api/agent/tasks/${id}/test`, { body: { verdict: "pass", body: "过" }, token: qa.data.token });
  assert.equal(tested.data.status, "done");
  assert.deepEqual(
    (await vacant()).claims.map((c: Json) => c.role).sort(),
    ["implementer", "reviewer", "tester"],
  );
});

test("chat, question, and bad kinds; an unknown @name names nobody and falls back to the whole room", async () => {
  const chat = await post("大家好 e2e-chat", "chat");
  assert.equal(chat.status, 200);
  assert.equal(chat.data.task ?? null, null, "chat never opens a task");
  const asked = await post("这个怎么用？ e2e-q", "question");
  assert.equal(asked.status, 200);
  assert.equal(asked.data.task ?? null, null);

  const count = (handle: string, type: string) => inbox(handle).then((events) => events.filter((e) => e.event_type === type).length);
  const rooms = await Promise.all(Object.keys(agents).map((handle) => count(handle, "room")));
  const ghost = await post("@nobody-here 在吗 e2e-ghost", "chat");
  assert.equal(ghost.status, 200);
  const rooms2 = await Promise.all(Object.keys(agents).map((handle) => count(handle, "room")));
  assert.deepEqual(rooms2, rooms.map((n) => n + 1), "an unknown handle names nobody, so it is shared like an un-addressed line");
  const stored = (await snapshot()).messages.filter((m: Json) => m.body === "@nobody-here 在吗 e2e-ghost");
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].addressed, []);
  const mixed = await post("@cursor @nobody-here 一起看 e2e-mixed", "chat");
  assert.equal(mixed.status, 200);
  assert.equal(await count("cursor", "mention"), 1);
  assert.deepEqual(await Promise.all(["chatgpt", "claude-desk"].map((h) => count(h, "room"))), [rooms2[1], rooms2[2]], "a hit narrows delivery to the hit");

  const bad = await post("x", "shout");
  assert.ok(bad.status >= 400);
  const empty = await post("   ", "chat");
  assert.ok(empty.status >= 400);
  const named = await post("@chatgpt 看一眼 e2e-mention", "chat");
  assert.equal(named.status, 200);
  assert.equal((await inbox("chatgpt", "mention")).length, 1);

  const unknownOnly = await post("@nobody-here 做个东西 e2e-unknown-task", "instruction", { tags: "build" });
  assert.equal(unknownOnly.data.task.status, "bidding", "an instruction naming only strangers is open to bids");
  await call(`/api/tasks/${unknownOnly.data.task.id}/cancel`, { method: "POST" });
});

test("channels: create a project channel, read the scope, and the hall cannot be archived", async () => {
  const made = await call("/api/rooms", {
    body: { name: "e2e-项目", topic: "测试频道", project: "demo", directories: ["/tmp/e2e"], branch: "main" },
  });
  assert.equal(made.status, 200);
  const rooms = (await call("/api/rooms")).data.rooms;
  assert.ok(rooms.some((room: Json) => room.name === "e2e-项目" && room.project === "demo"));
  const hall = rooms.find((room: Json) => room.general);
  assert.equal(hall.id, roomId);
  const refused = await call(`/api/rooms/${roomId}`, { method: "PATCH", body: { archived: true } });
  assert.ok(refused.status >= 400);
});

test("the live server logged no unhandled errors", () => {
  assert.doesNotMatch(log, /Error:|TypeError|unhandled/i);
});
