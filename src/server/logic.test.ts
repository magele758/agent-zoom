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

function enroll(store: Store, user: Principal & { type: "user" }, roomId: string, handle: string, tags = "") {
  const code = store.createJoinCode(user, roomId);
  const joined = store.enroll(code.code, handle, "codex", tags);
  const agent = store.agentByToken(joined.token);
  assert.ok(agent && agent.type === "agent");
  return agent;
}

function events(store: Store, agentId: string, type?: string) {
  const rows = store.inboxAfter(agentId, 0);
  return type ? rows.filter((row) => row.event_type === type) : rows;
}

test("two matching agents bid, and only one implementer is awarded", () => {
  const { store, user, roomId } = studio();
  const first = enroll(store, user, roomId, "one", "lab");
  const second = enroll(store, user, roomId, "two", "lab");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "给按钮补上禁用态", tags: "lab" });
  const task = posted.task;
  assert.ok(task);
  assert.equal(task.status, "bidding");
  assert.throws(() => store.claim(first, task.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "bid_first";
  });
  store.bid(first, task.id, "我只改按钮的禁用态，不碰请求。");
  const awarded = store.bid(second, task.id, "我在请求层拦住禁用时的点击。");
  assert.equal(awarded.status, "claimed");
  const holder = awarded.claims.find((claim) => claim.role === "implementer");
  assert.ok(holder);
  const loser = holder.agentId === first.id ? second : first;
  assert.throws(() => store.claim(loser, task.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "already_claimed";
  });
  assert.equal(events(store, loser.id, "bid_lost").length, 1);
  assert.equal(events(store, holder.agentId, "awarded").length, 1);
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

test("one matching agent claims directly and finishes only after review and test", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder", "lab");
  const reviewer = enroll(store, user, roomId, "critic", "review");
  const qa = enroll(store, user, roomId, "probe", "test");
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "登录按钮禁用时不要发请求",
    acceptance: "禁用时没有请求",
    tags: "lab",
  });
  assert.equal(posted.task?.status, "open");
  assert.equal(posted.task?.acceptance, "禁用时没有请求");
  assert.equal(events(store, coder.id, "task_open").length, 1);
  assert.equal(events(store, reviewer.id, "task_open").length, 0);

  const taskId = posted.task!.id;
  store.claim(coder, taskId, "implementer");
  assert.throws(() => store.markReady(coder, taskId), (error: unknown) => {
    return error instanceof ApiError && error.code === "use_deliver";
  });
  assert.throws(() => store.claim(reviewer, taskId, "reviewer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "bad_state";
  });
  store.deliver(coder, taskId, "workspace:button", "禁用点击被拦住。");
  assert.throws(() => store.claim(coder, taskId, "reviewer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "own_work";
  });
  assert.equal(events(store, coder.id, "review_needed").length, 0);
  store.claim(reviewer, taskId, "reviewer");
  const reviewed = store.review(reviewer, taskId, "approve", "范围没漏。通过。");
  assert.equal(reviewed.status, "in_test");
  assert.notEqual(reviewed.status, "done");
  store.claim(qa, taskId, "tester");
  const done = store.reportTest(qa, taskId, "pass", "禁用点击没有请求。通过。");
  assert.equal(done.status, "done");
});

test("request changes sends the task back, and the next deliver reopens review", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder", "lab");
  const reviewer = enroll(store, user, roomId, "critic", "review");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "补空状态", tags: "lab" });
  const taskId = posted.task!.id;
  store.claim(coder, taskId, "implementer");
  store.postMessage(coder, roomId, { kind: "direction", taskId, body: "先补空列表文案。" });
  store.deliver(coder, taskId, "workspace:empty", "空状态先交一版。");
  store.claim(reviewer, taskId, "reviewer");
  const back = store.review(reviewer, taskId, "request_changes", "验收没过：空列表还是旧文案。");
  assert.equal(back.status, "changes");
  assert.equal(back.deliverableRef, null);
  assert.equal(back.direction, "先补空列表文案。");
  store.postMessage(coder, roomId, { kind: "progress", taskId, body: "空状态改了。" });
  const again = store.deliver(coder, taskId, "workspace:empty2", "空状态换成新文案。");
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
  const coder = enroll(store, user, roomId, "coder", "lab");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "修一下复制", tags: "lab" });
  store.claim(coder, posted.task!.id, "implementer");
  store.db.prepare("UPDATE task_claims SET lease_until = ?").run("2000-01-01T00:00:00.000Z");
  store.reap(new Date("2026-10-08T00:00:00.000Z"));
  const task = store.listTasks(user, roomId).find((item) => item.id === posted.task!.id);
  assert.equal(task?.status, "open");
  assert.equal(task?.claims.length, 0);
});

test("a bid window with no bids falls back to open", () => {
  const { store, user, roomId } = studio();
  enroll(store, user, roomId, "one", "lab");
  enroll(store, user, roomId, "two", "lab");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "没人投标", tags: "lab" });
  assert.equal(posted.task?.status, "bidding");
  store.db.prepare("UPDATE tasks SET bid_until = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", posted.task!.id);
  store.reap(new Date("2026-10-09T00:00:00.000Z"));
  const task = store.listTasks(user, roomId).find((item) => item.id === posted.task!.id);
  assert.equal(task?.status, "open");
});

test("parallel lanes stay on the parent card and dispute when more than one passes", () => {
  const { store, user, roomId } = studio();
  const first = enroll(store, user, roomId, "one", "lab");
  const second = enroll(store, user, roomId, "two", "lab");
  const reviewer = enroll(store, user, roomId, "critic", "review");
  const qa = enroll(store, user, roomId, "probe", "test");
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "把导出做成两种方案",
    acceptance: "能导出，并且失败时有提示",
    parallel: true,
    tags: "lab",
  });
  assert.equal(posted.task?.status, "bidding");
  store.bid(first, posted.task!.id, "我用流式导出，失败时留在原页。");
  const awarded = store.bid(second, posted.task!.id, "我先写文件再跳转，失败时给提示。");
  assert.equal(awarded.status, "working");
  assert.equal(awarded.lanes.length, 2);
  const listed = store.listTasks(user, roomId);
  assert.equal(listed.some((item) => item.parentId), false);
  assert.equal(listed.find((item) => item.id === posted.task!.id)?.lanes.length, 2);

  for (const lane of awarded.lanes) {
    const holder = lane.claims.find((claim) => claim.role === "implementer");
    assert.ok(holder);
    const agent = holder.agentId === first.id ? first : second;
    const card = store.getTask(agent, lane.id);
    assert.equal(card.parentId, posted.task!.id);
    assert.equal(card.acceptance, "能导出，并且失败时有提示");
    store.deliver(agent, lane.id, `workspace:lane${lane.lane}`, "这条方案做完了。");
    store.claim(reviewer, lane.id, "reviewer");
    store.review(reviewer, lane.id, "approve", "验收都过了。");
    store.claim(qa, lane.id, "tester");
    store.reportTest(qa, lane.id, "pass", "导出和失败提示都看到了。");
  }
  const parent = store.listTasks(user, roomId).find((item) => item.id === posted.task!.id);
  assert.equal(parent?.status, "dispute");
  assert.equal(parent?.winnerTaskId, null);
  assert.equal(events(store, first.id, "dispute").length, 0);
});

test("one finished lane and one canceled lane closes the parent", () => {
  const { store, user, roomId } = studio();
  const first = enroll(store, user, roomId, "one", "lab");
  const second = enroll(store, user, roomId, "two", "lab");
  const reviewer = enroll(store, user, roomId, "critic", "review");
  const qa = enroll(store, user, roomId, "probe", "test");
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "两种导航",
    parallel: true,
    tags: "lab",
  });
  store.bid(first, posted.task!.id, "我做顶部导航。");
  const awarded = store.bid(second, posted.task!.id, "我做侧栏导航。");
  const [kept, dropped] = awarded.lanes;
  const holder = kept.claims.find((claim) => claim.role === "implementer");
  assert.ok(holder);
  const agent = holder.agentId === first.id ? first : second;
  store.deliver(agent, kept.id, "workspace:nav", "导航做完了。");
  store.claim(reviewer, kept.id, "reviewer");
  store.review(reviewer, kept.id, "approve", "验收过了。");
  store.claim(qa, kept.id, "tester");
  store.reportTest(qa, kept.id, "pass", "导航能点。");
  store.cancel(user, dropped.id);
  const parent = store.listTasks(user, roomId).find((item) => item.id === posted.task!.id);
  assert.equal(parent?.status, "done");
  assert.equal(parent?.winnerTaskId, kept.id);
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
