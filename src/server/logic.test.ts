import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, openStore, type Principal, type Store } from "./logic.ts";

function studio(name = "磊") {
  const store = openStore(":memory:");
  const session = store.session(name);
  const user = store.userBySession(session.token);
  assert.ok(user && user.type === "user");
  const roomId = store.listRooms(user.id)[0].id;
  return { store, user, roomId };
}

function enroll(store: Store, user: Principal & { type: "user" }, roomId: string, handle: string) {
  const code = store.createJoinCode(user, roomId);
  const joined = store.enroll(code.code, handle, "codex");
  const agent = store.agentByToken(joined.token);
  assert.ok(agent && agent.type === "agent");
  return agent;
}

function events(store: Store, agentId: string, type?: string) {
  const rows = store.inboxAfter(agentId, 0);
  return type ? rows.filter((row) => row.event_type === type) : rows;
}

test("two agents cannot claim the same implementer slot", () => {
  const { store, user, roomId } = studio();
  const first = enroll(store, user, roomId, "one");
  const second = enroll(store, user, roomId, "two");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "给按钮补上禁用态" });
  const task = posted.task;
  assert.ok(task);
  store.claim(first, task.id, "implementer");
  assert.throws(() => store.claim(second, task.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "already_claimed";
  });
});

test("room history is visible to members and hidden from outsiders", () => {
  const { store, user, roomId } = studio();
  const agent = enroll(store, user, roomId, "coder");
  store.postMessage(user, roomId, { kind: "chat", body: "房间里的话" });
  assert.equal(store.readMessages(agent, roomId, 0).some((message) => message.body === "房间里的话"), true);

  const other = store.session("别人");
  const outsider = store.userBySession(other.token);
  assert.ok(outsider && outsider.type === "user");
  assert.throws(() => store.snapshot(outsider, roomId, new Set()), (error: unknown) => {
    return error instanceof ApiError && error.status === 403;
  });

  const otherRoom = store.createRoom(user, "密室", "");
  assert.throws(() => store.readMessages(agent, otherRoom.id, 0), (error: unknown) => {
    return error instanceof ApiError && error.status === 403;
  });
});

test("plain chat does not wake agents, a mention does", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder");
  const reader = enroll(store, user, roomId, "reader");
  store.postMessage(user, roomId, { kind: "chat", body: "今天先不动代码" });
  assert.equal(events(store, coder.id, "mention").length, 0);
  assert.equal(events(store, reader.id, "mention").length, 0);
  store.postMessage(user, roomId, { kind: "chat", body: "@coder 看一下这个报错" });
  assert.equal(events(store, coder.id, "mention").length, 1);
  assert.equal(events(store, reader.id, "mention").length, 0);
});

test("an instruction wakes the room and finishes only after review and test", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder");
  const reviewer = enroll(store, user, roomId, "critic");
  const qa = enroll(store, user, roomId, "probe");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "登录按钮禁用时不要发请求" });
  assert.equal(posted.task?.status, "open");
  assert.equal(events(store, coder.id, "task_open").length, 1);

  store.claim(coder, posted.task!.id, "implementer");
  store.markReady(coder, posted.task!.id);
  assert.throws(() => store.claim(coder, posted.task!.id, "reviewer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "own_work";
  });
  store.claim(reviewer, posted.task!.id, "reviewer");
  const reviewed = store.review(reviewer, posted.task!.id, "approve", "范围没漏。通过。");
  assert.equal(reviewed.status, "in_test");
  assert.notEqual(reviewed.status, "done");
  store.claim(qa, posted.task!.id, "tester");
  const done = store.reportTest(qa, posted.task!.id, "pass", "禁用点击没有请求。通过。");
  assert.equal(done.status, "done");
});

test("request changes sends the task back to the implementer", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder");
  const reviewer = enroll(store, user, roomId, "critic");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "补空状态" });
  store.claim(coder, posted.task!.id, "implementer");
  store.markReady(coder, posted.task!.id);
  store.claim(reviewer, posted.task!.id, "reviewer");
  const back = store.review(reviewer, posted.task!.id, "request_changes", "空列表还是旧文案。");
  assert.equal(back.status, "changes");
  store.postMessage(coder, roomId, { kind: "progress", taskId: posted.task!.id, body: "空状态改了。" });
  const again = store.markReady(coder, posted.task!.id);
  assert.equal(again.status, "in_review");
});

test("a join code works once", () => {
  const { store, user, roomId } = studio();
  const code = store.createJoinCode(user, roomId);
  store.enroll(code.code, "codex", "codex");
  assert.throws(() => store.enroll(code.code, "codex-2", "codex"), (error: unknown) => {
    return error instanceof ApiError && error.code === "code_used";
  });
});

test("an expired implementer lease reopens the task", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "修一下复制" });
  store.claim(coder, posted.task!.id, "implementer");
  store.db.prepare("UPDATE task_claims SET lease_until = ?").run("2000-01-01T00:00:00.000Z");
  store.reap(new Date("2026-10-08T00:00:00.000Z"));
  const task = store.listTasks(user, roomId).find((item) => item.id === posted.task!.id);
  assert.equal(task?.status, "open");
  assert.equal(task?.claims.length, 0);
});

test("file locks are exclusive until released", () => {
  const { store, user, roomId } = studio();
  const first = enroll(store, user, roomId, "one");
  const second = enroll(store, user, roomId, "two");
  store.lockFile(first, "src/button.tsx");
  assert.throws(() => store.lockFile(second, "src/button.tsx"), (error: unknown) => {
    return error instanceof ApiError && error.code === "locked";
  });
  store.unlockFile(first, "src/button.tsx");
  const held = store.lockFile(second, "src/button.tsx");
  assert.equal(held.path, "src/button.tsx");
});

test("the stop hook only consumes events once", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder");
  store.postMessage(user, roomId, { kind: "chat", body: "@coder 回来看一眼" });
  assert.equal(store.takePending(coder.id).length, 1);
  assert.equal(store.takePending(coder.id).length, 0);
});
