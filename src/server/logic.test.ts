import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "./db.ts";
import { echoAction } from "../adapter.ts";
import { DEFAULT_PIPELINE, parsePipeline } from "./pipeline.ts";
import { speakFor } from "./demo.ts";
import { createApp } from "./http.ts";
import { ApiError, openStore, type Principal, type Store, type TaskView } from "./logic.ts";

function studio(name = "磊") {
  const store = openStore(":memory:");
  const session = store.session(name);
  const user = store.userBySession(session.token);
  assert.ok(user && user.type === "user");
  const roomId = store.listRooms(user.id)[0].id;
  return { store, user, roomId };
}

function enroll(
  store: Store,
  user: Principal & { type: "user" },
  roomId: string,
  handle: string,
  tags = "",
  level = 1,
) {
  const code = store.createJoinCode(user, roomId);
  const joined = store.enroll(code.code, handle, "codex", tags, level);
  const agent = store.agentByToken(joined.token);
  assert.ok(agent && agent.type === "agent");
  return agent;
}

function events(store: Store, agentId: string, type?: string) {
  const rows = store.inboxAfter(agentId, 0);
  return type ? rows.filter((row) => row.event_type === type) : rows;
}

function levelOf(store: Store, agentId: string) {
  const row = store.db.prepare("SELECT level FROM agents WHERE id = ?").get(agentId) as { level: number };
  return row.level;
}

test("stopping an implementer frees the slot and blocks the next tool call", () => {
  const { store, user, roomId } = studio();
  const worker = enroll(store, user, roomId, "coder", "lab");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "做一件很贵的事", tags: "lab" });
  const task = posted.task;
  assert.ok(task);
  store.claim(worker, task.id, "implementer");
  store.lockFile(worker, "src/app.ts", task.id);
  const stopped = store.stopAgent(user, worker.id);
  assert.equal(stopped.paused, true);
  assert.equal(stopped.released, 1);
  const after = store.getTask(user, task.id);
  assert.equal(after.status, "open");
  assert.equal(
    after.claims.some((claim) => claim.role === "implementer" && claim.state === "active"),
    false,
  );
  const locks = store.db.prepare("SELECT COUNT(*) AS n FROM file_locks WHERE agent_id = ?").get(worker.id) as {
    n: number;
  };
  assert.equal(locks.n, 0);
  assert.equal(events(store, worker.id, "stop").length, 1);
  const note = store.db.prepare("SELECT body FROM messages WHERE body LIKE '%coder 被停下%'").get() as
    | { body: string }
    | undefined;
  assert.match(note?.body ?? "", /coder 被停下/);
  assert.throws(() => store.claim(worker, task.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "stopped";
  });
  assert.throws(() => store.postMessage(worker, roomId, { kind: "chat", body: "我还在做" }), (error: unknown) => {
    return error instanceof ApiError && error.code === "stopped";
  });
  const spare = enroll(store, user, roomId, "spare", "lab");
  const taken = store.claim(spare, task.id, "implementer");
  assert.equal(taken.claims.some((claim) => claim.handle === "spare" && claim.role === "implementer"), true);
});

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

function demoAgent(store: Store, handle: string) {
  const row = store.db
    .prepare("SELECT id, handle, owner_user_id, org_id, paused FROM agents WHERE handle = ? AND demo = 1")
    .get(handle) as { id: string; handle: string; owner_user_id: string; org_id: string; paused: number };
  return {
    type: "agent" as const,
    id: row.id,
    handle: row.handle,
    ownerUserId: row.owner_user_id,
    orgId: row.org_id,
    paused: row.paused === 1,
  };
}

test("one idle demo answers a chat, and a mention does not get that answer", () => {
  const { store, user, roomId } = studio();
  const builder = demoAgent(store, "builder");
  const maker = demoAgent(store, "maker");
  const posted = store.postMessage(user, roomId, { kind: "chat", body: "谁有空？" });
  const heard = events(store, builder.id, "room").find((event) => event.ref_id === posted.message.id);
  assert.ok(heard);
  assert.equal(speakFor(store, maker, heard), false);
  assert.equal(speakFor(store, builder, heard), true);
  assert.equal(speakFor(store, builder, heard), false);
  const replies = store.readMessages(user, roomId, 0).filter((message) => message.kind === "chat" && message.handle === "builder");
  assert.equal(replies.length, 1);
  assert.match(String(replies[0]?.body ?? ""), /在/);

  store.setPaused(user, builder.id, true);
  const again = store.postMessage(user, roomId, { kind: "chat", body: "还有人吗" });
  const next = events(store, maker.id, "room").find((event) => event.ref_id === again.message.id);
  assert.ok(next);
  assert.equal(speakFor(store, maker, next), true);

  const named = store.postMessage(user, roomId, { kind: "chat", body: "@maker 只叫你" });
  assert.equal(events(store, maker.id, "room").some((event) => event.ref_id === named.message.id), false);
});

test("a message with no mention reaches every agent, a mention reaches only the named one", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder");
  const reader = enroll(store, user, roomId, "reader");
  store.postMessage(user, roomId, { kind: "chat", body: "今天先不动代码" });
  for (const agent of [coder, reader]) {
    const heard = events(store, agent.id, "room");
    assert.equal(heard.length, 1);
    assert.match(heard[0]?.summary ?? "", /今天先不动代码/);
    assert.equal(events(store, agent.id, "mention").length, 0);
  }
  store.postMessage(user, roomId, { kind: "question", body: "这个按钮现在是什么颜色" });
  assert.equal(events(store, reader.id, "room").length, 2);
  store.postMessage(coder, roomId, { kind: "chat", body: "我先看一眼" });
  assert.equal(events(store, reader.id, "room").length, 2);
  store.postMessage(user, roomId, { kind: "chat", body: "@coder 看一下这个报错" });
  assert.equal(events(store, coder.id, "mention").length, 1);
  assert.equal(events(store, reader.id, "mention").length, 0);
  assert.equal(events(store, reader.id, "room").length, 2);
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

test("ordinary tasks ignore level and keep the earlier bid", () => {
  const { store, user, roomId } = studio();
  const junior = enroll(store, user, roomId, "junior", "lab", 1);
  const senior = enroll(store, user, roomId, "senior", "lab", 5);
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "改一下字号", tags: "lab" });
  assert.equal(posted.task?.status, "bidding");
  assert.equal(posted.task?.complex, false);
  assert.equal(events(store, junior.id, "bid_open").length, 1);
  assert.equal(events(store, senior.id, "bid_open").length, 1);
  store.bid(junior, posted.task!.id, "我只改字号，不动布局。");
  const awarded = store.bid(senior, posted.task!.id, "我连行高一起改。");
  assert.equal(awarded.claims.find((claim) => claim.role === "implementer")?.agentId, junior.id);
});

test("complex tasks wake and award level 3 or above, and rank by level", () => {
  const { store, user, roomId } = studio();
  const junior = enroll(store, user, roomId, "junior", "lab", 1);
  const mid = enroll(store, user, roomId, "mid", "lab", 3);
  const senior = enroll(store, user, roomId, "senior", "lab", 5);
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "重做权限模型",
    tags: "lab",
    complex: true,
  });
  assert.equal(posted.task?.complex, true);
  assert.equal(posted.task?.status, "bidding");
  assert.equal(events(store, junior.id, "bid_open").length, 0);
  assert.equal(events(store, mid.id, "bid_open").length, 1);
  assert.equal(events(store, senior.id, "bid_open").length, 1);
  assert.throws(() => store.bid(junior, posted.task!.id, "我也能做。"), (error: unknown) => {
    return error instanceof ApiError && error.code === "not_eligible";
  });
  store.bid(mid, posted.task!.id, "我先收紧读写边界。");
  const awarded = store.bid(senior, posted.task!.id, "我先画清角色再改接口。");
  assert.equal(awarded.claims.find((claim) => claim.role === "implementer")?.agentId, senior.id);
  assert.equal(events(store, mid.id, "bid_lost").length, 1);
});

test("a complex task falls back to everyone when nobody is level 3", () => {
  const { store, user, roomId } = studio();
  const one = enroll(store, user, roomId, "one", "lab", 1);
  const two = enroll(store, user, roomId, "two", "lab", 2);
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "补日志", tags: "lab", complex: true });
  assert.equal(posted.task?.status, "bidding");
  assert.equal(events(store, one.id, "bid_open").length, 1);
  assert.equal(events(store, two.id, "bid_open").length, 1);
  store.bid(one, posted.task!.id, "我补界面日志。");
  const awarded = store.bid(two, posted.task!.id, "我补请求日志。");
  assert.equal(awarded.claims.find((claim) => claim.role === "implementer")?.agentId, two.id);
});

test("a complex task with one strong agent stays open for others, a named agent ignores level, and review does too", () => {
  const { store, user, roomId } = studio();
  const junior = enroll(store, user, roomId, "junior", "lab", 1);
  const senior = enroll(store, user, roomId, "senior", "lab", 4);
  const open = store.postMessage(user, roomId, { kind: "instruction", body: "改一下权限模型", tags: "lab", complex: true });
  assert.equal(open.task?.status, "open");
  assert.equal(events(store, senior.id, "task_open").length, 1);
  assert.equal(events(store, junior.id, "task_open").length, 0);
  assert.throws(() => store.claim(junior, open.task!.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "level_low";
  });
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "@junior 你来做这个",
    tags: "lab",
    complex: true,
  });
  assert.equal(posted.task?.status, "open");
  assert.equal(events(store, junior.id, "task_open").filter((row) => row.ref_id === posted.task!.id).length, 1);
  assert.equal(events(store, senior.id, "task_open").filter((row) => row.ref_id === posted.task!.id).length, 0);
  assert.equal(store.readMessages(junior, roomId, 0).some((message) => String(message.body).includes("@junior")), true);
  assert.throws(() => store.claim(senior, posted.task!.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "not_addressed";
  });
  store.claim(junior, posted.task!.id, "implementer");
  store.deliver(junior, posted.task!.id, "workspace:auth", "权限模型交了一版。");
  store.claim(senior, posted.task!.id, "reviewer");
  const reviewed = store.review(senior, posted.task!.id, "approve", "范围够了。");
  assert.equal(reviewed.status, "in_test");
  assert.equal(levelOf(store, junior.id), 2);
});

test("a claimed task is not taken by a stronger agent", () => {
  const { store, user, roomId } = studio();
  const junior = enroll(store, user, roomId, "junior", "lab", 2);
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "改文案", tags: "lab", complex: true });
  store.claim(junior, posted.task!.id, "implementer");
  const senior = enroll(store, user, roomId, "senior", "lab", 5);
  assert.throws(() => store.claim(senior, posted.task!.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && (error.code === "bad_state" || error.code === "already_claimed");
  });
  const task = store.getTask(user, posted.task!.id);
  assert.equal(task.status, "claimed");
  assert.equal(task.claims.find((claim) => claim.role === "implementer")?.agentId, junior.id);
});

test("a complex task switches to a newly leveled agent before it is claimed", () => {
  const { store, user, roomId } = studio();
  const junior = enroll(store, user, roomId, "junior", "lab", 1);
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "复杂但先没人够格",
    tags: "lab",
    complex: true,
  });
  assert.equal(events(store, junior.id, "task_open").length, 1);
  const senior = enroll(store, user, roomId, "senior", "lab", 4);
  assert.equal(store.getTask(user, posted.task!.id).status, "open");
  assert.ok(events(store, senior.id, "task_open").length >= 1);
  assert.throws(() => store.claim(junior, posted.task!.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "level_low";
  });
  assert.equal(store.claim(senior, posted.task!.id, "implementer").status, "claimed");
});

test("parallel complex lanes go to the highest levels", () => {
  const { store, user, roomId } = studio();
  const junior = enroll(store, user, roomId, "junior", "lab", 1);
  const mid = enroll(store, user, roomId, "mid", "lab", 3);
  const senior = enroll(store, user, roomId, "senior", "lab", 5);
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "两种导出",
    parallel: true,
    tags: "lab",
    complex: true,
  });
  store.bid(mid, posted.task!.id, "我写文件再提示。");
  const awarded = store.bid(senior, posted.task!.id, "我用流式导出。");
  assert.equal(awarded.lanes.length, 2);
  assert.equal(awarded.lanes[0].complex, true);
  assert.equal(awarded.lanes[0].claims.find((claim) => claim.role === "implementer")?.agentId, senior.id);
  assert.equal(awarded.lanes[1].claims.find((claim) => claim.role === "implementer")?.agentId, mid.id);
  assert.equal(events(store, junior.id, "bid_open").length, 0);
});

test("a first-pass review raises level, a rejection lowers it, and a human release does not", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder", "lab", 3);
  const reviewer = enroll(store, user, roomId, "critic", "review", 1);
  const qa = enroll(store, user, roomId, "probe", "test", 1);
  const first = store.postMessage(user, roomId, { kind: "instruction", body: "第一次", tags: "lab" });
  store.claim(coder, first.task!.id, "implementer");
  store.deliver(coder, first.task!.id, "workspace:one", "做完了。");
  store.claim(reviewer, first.task!.id, "reviewer");
  store.review(reviewer, first.task!.id, "question", "验收里的失败提示在哪？");
  assert.equal(levelOf(store, coder.id), 3);
  store.review(reviewer, first.task!.id, "approve", "过了。");
  store.claim(qa, first.task!.id, "tester");
  store.reportTest(qa, first.task!.id, "pass", "主路径过了。");
  assert.equal(levelOf(store, coder.id), 4);
  assert.equal(
    store.readMessages(user, roomId, 0).some((message) => String(message.body) === "coder 的等级从 3 调到 4：交付的任务一次评审通过。"),
    true,
  );

  const second = store.postMessage(user, roomId, { kind: "instruction", body: "第二次", tags: "lab" });
  store.claim(coder, second.task!.id, "implementer");
  store.deliver(coder, second.task!.id, "workspace:two", "又做了一版。");
  store.claim(reviewer, second.task!.id, "reviewer");
  const back = store.review(reviewer, second.task!.id, "request_changes", "验收没过：失败提示还没有。");
  assert.equal(back.status, "changes");
  assert.equal(levelOf(store, coder.id), 3);
  store.deliver(coder, second.task!.id, "workspace:two-b", "补上失败提示。");
  store.claim(reviewer, second.task!.id, "reviewer");
  store.review(reviewer, second.task!.id, "approve", "这次过了。");
  assert.equal(levelOf(store, coder.id), 3);

  const third = store.postMessage(user, roomId, { kind: "instruction", body: "第三次", tags: "lab" });
  store.claim(coder, third.task!.id, "implementer");
  const moved = store.readMessages(user, roomId, 0).filter((message) => String(message.body).includes("调到")).length;
  store.forceDone(user, third.task!.id);
  assert.equal(levelOf(store, coder.id), 3);
  assert.equal(store.readMessages(user, roomId, 0).filter((message) => String(message.body).includes("调到")).length, moved);
});

test("level stays inside 1 to 5, and studio members can set it", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder", "lab", 5);
  const reviewer = enroll(store, user, roomId, "critic", "review");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "到顶", tags: "lab" });
  store.claim(coder, posted.task!.id, "implementer");
  store.deliver(coder, posted.task!.id, "workspace:top", "做完了。");
  store.claim(reviewer, posted.task!.id, "reviewer");
  store.review(reviewer, posted.task!.id, "approve", "过了。");
  assert.equal(levelOf(store, coder.id), 5);

  const low = enroll(store, user, roomId, "low", "lab", 1);
  const again = store.postMessage(user, roomId, { kind: "instruction", body: "到底", tags: "lab" });
  store.claim(low, again.task!.id, "implementer");
  store.deliver(low, again.task!.id, "workspace:floor", "做完了。");
  store.claim(reviewer, again.task!.id, "reviewer");
  store.review(reviewer, again.task!.id, "request_changes", "验收没过：还是空的。");
  assert.equal(levelOf(store, low.id), 1);
  assert.equal(store.readMessages(user, roomId, 0).some((message) => String(message.body).includes("调到")), false);

  assert.equal(store.setLevel(user, coder.id, 6).level, 5);
  assert.equal(store.setLevel(user, coder.id, 0).level, 1);
  store.setLevel(user, coder.id, 2);
  assert.equal(levelOf(store, coder.id), 2);

  const outsiderSession = store.session("外人");
  const outsider = store.userBySession(outsiderSession.token);
  assert.ok(outsider && outsider.type === "user");
  assert.throws(() => store.setLevel(outsider, coder.id, 4), (error: unknown) => {
    return error instanceof ApiError && error.code === "no_agent";
  });

  store.invite(user, roomId, "同事");
  const colleagueSession = store.session("同事");
  const colleague = store.userBySession(colleagueSession.token);
  assert.ok(colleague && colleague.type === "user");
  store.setLevel(colleague, coder.id, 4);
  assert.equal(store.whoami(coder).level, 4);

  const demos = store.db.prepare("SELECT level FROM agents WHERE demo = 1 AND org_id = ?").all(coder.orgId) as Array<{
    level: number;
  }>;
  assert.equal(demos.length, 4);
  assert.ok(demos.every((row) => row.level === 1));
});

function enrollAt(store: Store, user: Principal & { type: "user" }, roomId: string, handle: string, level: number) {
  const code = store.createJoinCode(user, roomId);
  const joined = store.enroll(code.code, handle, "codex", "lab", level);
  const agent = store.agentByToken(joined.token);
  assert.ok(agent && agent.type === "agent");
  return agent;
}

test("levels are clamped on enroll and humans can change them", () => {
  const { store, user, roomId } = studio();
  const high = enrollAt(store, user, roomId, "high", 99);
  const low = enrollAt(store, user, roomId, "low", -3);
  const members = store.snapshot(user, roomId, new Set()).members.agents;
  assert.equal(members.find((a) => a.id === high.id)?.level, 5);
  assert.equal(members.find((a) => a.id === low.id)?.level, 1);
  assert.equal(store.setLevel(user, low.id, 4).level, 4);
  assert.equal(store.setLevel(user, low.id, "bad").level, 1);
  const outsider = store.userBySession(store.session("别人").token);
  assert.ok(outsider && outsider.type === "user");
  assert.throws(() => store.setLevel(outsider, low.id, 3), (error: unknown) => {
    return error instanceof ApiError && error.code === "no_agent";
  });
});

test("a complex task goes to strong agents only, a normal task ignores level", () => {
  const { store, user, roomId } = studio();
  const strong = enrollAt(store, user, roomId, "strong", 4);
  const weak = enrollAt(store, user, roomId, "weak", 1);
  const complex = store.postMessage(user, roomId, { kind: "instruction", body: "重写同步引擎", tags: "lab", complex: true });
  assert.equal(complex.task?.complex, true);
  assert.equal(complex.task?.status, "open");
  assert.equal(events(store, strong.id, "task_open").length, 1);
  assert.equal(events(store, weak.id, "task_open").length, 0);
  assert.throws(() => store.claim(weak, complex.task!.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "level_low";
  });
  const plain = store.postMessage(user, roomId, { kind: "instruction", body: "改个文案", tags: "lab" });
  assert.equal(plain.task?.status, "bidding");
  assert.equal(events(store, weak.id, "bid_open").length, 1);
  store.claim(strong, complex.task!.id, "implementer");
});

test("a complex task falls back to everyone when nobody is strong, and level lifts the bid score", () => {
  const { store, user, roomId } = studio();
  const one = enrollAt(store, user, roomId, "one", 2);
  const two = enrollAt(store, user, roomId, "two", 1);
  const fallback = store.postMessage(user, roomId, { kind: "instruction", body: "复杂但没人够强", tags: "lab", complex: true });
  assert.equal(fallback.task?.status, "bidding");
  store.bid(two, fallback.task!.id, "我先来。");
  const awarded = store.bid(one, fallback.task!.id, "我稍后。");
  assert.equal(awarded.claims.find((claim) => claim.role === "implementer")?.agentId, one.id);
});

test("an @mention lets a low-level agent take a complex task", () => {
  const { store, user, roomId } = studio();
  enrollAt(store, user, roomId, "strong", 5);
  const weak = enrollAt(store, user, roomId, "weak", 1);
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "@weak 你来做这个复杂的", tags: "lab", complex: true });
  assert.equal(store.claim(weak, posted.task!.id, "implementer").status, "claimed");
});

test("a channel keeps a project, several directories, and a branch on every task", () => {
  const { store, user, roomId } = studio();
  const created = store.createRoom(user, "前端", "界面", {
    project: "agent-zoom",
    directories: ["web/src", "src/server"],
    branch: "main",
  });
  const listed = store.listRooms(user.id).find((room) => room.id === created.id);
  assert.equal(listed?.project, "agent-zoom");
  assert.deepEqual(listed?.directories, ["web/src", "src/server"]);
  assert.equal(listed?.branch, "main");
  const posted = store.postMessage(user, created.id, { kind: "instruction", body: "改按钮" });
  assert.deepEqual(store.getTask(user, posted.task!.id).scope, {
    project: "agent-zoom",
    directories: ["web/src", "src/server"],
    branch: "main",
  });
  const coder = enroll(store, user, created.id, "coder", "lab");
  assert.equal(events(store, coder.id, "task_open")[0]?.summary.includes("目录 web/src、src/server"), true);
  store.claim(coder, posted.task!.id, "implementer");
  store.setScope(user, created.id, { directories: "web/src\npackages/ui", branch: "feature/ui" });
  assert.deepEqual(store.getTask(user, posted.task!.id).scope, {
    project: "agent-zoom",
    directories: ["web/src", "packages/ui"],
    branch: "feature/ui",
  });
  assert.equal(events(store, coder.id, "thread").some((event) => event.summary.includes("packages/ui")), true);
  assert.throws(
    () => store.setScope(user, created.id, { directories: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
    (error: unknown) => error instanceof ApiError && error.code === "bad_scope",
  );
  const outsider = store.userBySession(store.session("外人").token);
  assert.ok(outsider && outsider.type === "user");
  assert.throws(() => store.setScope(outsider, created.id, { project: "nope" }), (error: unknown) => {
    return error instanceof ApiError && error.status === 403;
  });
  const hall = store.snapshot(user, roomId, new Set()).room;
  assert.deepEqual(hall.directories, []);
  assert.equal(hall.project, "");
});

test("enroll records the machine and directory an agent is working from", () => {
  const { store, user, roomId } = studio();
  const code = store.createJoinCode(user, roomId);
  const joined = store.enroll(code.code, "local", "codex", "lab", 2, "lei-mac", "/work/agent-zoom");
  const agent = store.agentByToken(joined.token);
  assert.ok(agent && agent.type === "agent");
  const who = store.whoami(agent);
  assert.equal(who.machine, "lei-mac");
  assert.equal(who.cwd, "/work/agent-zoom");
  assert.equal(who.rooms[0]?.project, "");
  const roster = store.snapshot(user, roomId, new Set()).members.agents.find((item) => item.handle === "local");
  assert.equal(roster?.machine, "lei-mac");
  assert.equal(roster?.cwd, "/work/agent-zoom");
  assert.deepEqual(store.setPlace(agent, "other-box", "/work/web"), { machine: "other-box", cwd: "/work/web" });
  assert.equal(store.whoami(agent).cwd, "/work/web");
});

test("complex parallel tasks bid normally, and malformed JSON is a 400", async () => {
  const { store, user, roomId } = studio();
  enrollAt(store, user, roomId, "alpha", 3);
  enrollAt(store, user, roomId, "beta", 3);
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "并行复杂", tags: "lab", complex: true, parallel: true });
  assert.equal(posted.task?.status, "bidding");
  const { app } = createApp(store);
  const response = await app.request("/api/session", { method: "POST", body: "{oops", headers: { "content-type": "application/json" } });
  assert.equal(response.status, 400);
});

test("a new instruction sets currentTopic, and finishing the last active parent clears it", () => {
  const { store, user, roomId } = studio();
  assert.equal(store.snapshot(user, roomId, new Set()).room.currentTopic, "");
  const first = store.postMessage(user, roomId, { kind: "instruction", body: "先改标题" });
  assert.equal(store.snapshot(user, roomId, new Set()).room.currentTopic, first.task?.title);
  const second = store.postMessage(user, roomId, { kind: "instruction", body: "再改按钮" });
  assert.equal(store.listRooms(user.id).find((room) => room.id === roomId)?.currentTopic, second.task?.title);
  const before = store.snapshot(user, roomId, new Set()).messages.length;
  store.forceDone(user, second.task!.id);
  const mid = store.snapshot(user, roomId, new Set());
  assert.equal(mid.room.currentTopic, first.task?.title);
  assert.equal(mid.messages.length, before + 1);
  store.forceDone(user, first.task!.id);
  const after = store.snapshot(user, roomId, new Set());
  assert.equal(after.room.currentTopic, "");
  assert.equal(after.messages.length, mid.messages.length + 1);
  const third = store.postMessage(user, roomId, { kind: "instruction", body: "再取消这一条" });
  const beforeCancel = store.snapshot(user, roomId, new Set()).messages.length;
  store.cancel(user, third.task!.id);
  const canceled = store.snapshot(user, roomId, new Set());
  assert.equal(canceled.room.currentTopic, "");
  assert.equal(canceled.messages.length, beforeCancel + 1);
});

test("the default hall is general and cannot be archived", () => {
  const { store, user, roomId } = studio();
  const hall = store.listRooms(user.id).find((room) => room.id === roomId);
  assert.equal(hall?.name, "大厅");
  assert.equal(hall?.general, true);
  assert.equal(hall?.archived, false);
  assert.equal(store.snapshot(user, roomId, new Set()).room.general, true);
  assert.throws(() => store.setArchived(user, roomId, true), (error: unknown) => {
    return error instanceof ApiError && error.status === 403 && error.code === "general_room" && error.message === "大厅不能归档";
  });
  assert.equal(store.listRooms(user.id).find((room) => room.id === roomId)?.archived, false);
});

test("a project room can be archived, and history stays readable until it is restored", () => {
  const { store, user } = studio();
  const created = store.createRoom(user, "前端", "界面", {
    project: "agent-zoom",
    directories: ["web/src"],
    branch: "main",
    currentTopic: "按钮\n样式",
  });
  assert.equal(created.topic, "界面");
  assert.equal(created.currentTopic, "按钮样式");
  assert.equal(created.general, false);
  assert.equal(created.archived, false);
  assert.equal(created.project, "agent-zoom");
  const kept = store.setChannelText(user, created.id, { topic: "界面相关" });
  assert.equal(kept.topic, "界面相关");
  assert.equal(kept.currentTopic, "按钮样式");
  store.setChannelText(user, created.id, { currentTopic: "" });
  assert.equal(store.snapshot(user, created.id, new Set()).room.currentTopic, "");
  store.postMessage(user, created.id, { kind: "chat", body: "归档前的话" });
  const instruction = store.postMessage(user, created.id, { kind: "instruction", body: "归档前的指令" });
  const agent = enroll(store, user, created.id, "coder");
  const archived = store.setArchived(user, created.id, true);
  assert.equal(archived.archived, true);
  assert.equal(store.listRooms(user.id).some((room) => room.id === created.id && room.archived), true);
  const snap = store.snapshot(user, created.id, new Set());
  assert.equal(snap.room.archived, true);
  assert.equal(snap.messages.some((message) => message.body === "归档前的话"), true);
  assert.equal(snap.messages.some((message) => message.body === "频道已归档。历史还在，取消归档后可以继续发言。"), true);
  assert.throws(() => store.postMessage(user, created.id, { kind: "chat", body: "归档后" }), (error: unknown) => {
    return error instanceof ApiError && error.status === 409 && error.code === "archived" && error.message === "这个频道已归档，先取消归档再发言";
  });
  assert.throws(() => store.claim(agent, instruction.task!.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.status === 409 && error.code === "archived";
  });
  assert.equal(store.readMessages(agent, created.id, 0).some((message) => message.body === "归档前的话"), true);
  assert.ok(Array.isArray(store.listTasks(agent, created.id)));
  const who = store.whoami(agent).rooms.find((room) => room.id === created.id);
  assert.equal(who?.archived, true);
  assert.equal(who?.general, false);
  assert.equal(who?.topic, "界面相关");
  assert.equal(who?.project, "agent-zoom");
  store.setChannelText(user, created.id, { currentTopic: "收尾" });
  assert.equal(store.snapshot(user, created.id, new Set()).room.currentTopic, "收尾");
  store.setArchived(user, created.id, false);
  assert.equal(store.postMessage(user, created.id, { kind: "chat", body: "恢复后的话" }).message.body, "恢复后的话");
  assert.equal(store.snapshot(user, created.id, new Set()).messages.some((message) => message.body === "频道已取消归档。"), true);
});

test("an outsider cannot archive a room", () => {
  const { store, user } = studio();
  const created = store.createRoom(user, "前端", "界面");
  const outsider = store.userBySession(store.session("外人").token);
  assert.ok(outsider && outsider.type === "user");
  assert.throws(() => store.setArchived(outsider, created.id, true), (error: unknown) => {
    return error instanceof ApiError && error.status === 403 && error.code === "not_member";
  });
  assert.equal(store.listRooms(user.id).find((room) => room.id === created.id)?.archived, false);
});

test("patch updates channel text and archive, and an old database marks its earliest room as the hall", async () => {
  const store = openStore(":memory:");
  const { app } = createApp(store);
  const entered = await app.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "磊" }),
  });
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? "";
  const created = await app.request("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "前端",
      topic: `说${"明".repeat(300)}`,
      project: "agent-zoom",
      currentTopic: "按钮\n样式",
    }),
  });
  assert.equal(created.status, 200);
  const room = (await created.json()) as { id: string; topic: string; currentTopic: string; general: boolean; archived: boolean; project: string };
  assert.equal(room.currentTopic, "按钮样式");
  assert.equal(room.topic.length, 250);
  assert.equal(room.general, false);
  assert.equal(room.project, "agent-zoom");
  const patched = await app.request(`/api/rooms/${room.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ topic: "新说明", currentTopic: "", archived: true, directories: ["web/src"] }),
  });
  assert.equal(patched.status, 200);
  const next = (await patched.json()) as {
    id: string;
    topic: string;
    currentTopic: string;
    general: boolean;
    archived: boolean;
    project: string;
    directories: string[];
    branch: string;
  };
  assert.equal(next.topic, "新说明");
  assert.equal(next.currentTopic, "");
  assert.equal(next.archived, true);
  assert.equal(next.general, false);
  assert.equal(next.project, "agent-zoom");
  assert.deepEqual(next.directories, ["web/src"]);
  assert.equal(next.branch, "");
  const listed = await app.request("/api/rooms", { headers: { cookie } });
  const rooms = (await listed.json()) as { rooms: Array<{ id: string; general: boolean; archived: boolean }> };
  const hall = rooms.rooms.find((item) => item.general);
  assert.ok(hall);
  assert.equal(rooms.rooms.some((item) => item.id === room.id && item.archived), true);
  const blocked = await app.request(`/api/rooms/${hall.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(((await blocked.json()) as { error: string }).error, "general_room");

  const dir = mkdtempSync(join(tmpdir(), "agent-zoom-rooms-"));
  const path = join(dir, "old.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO orgs (id, name, created_at) VALUES ('org', '工作室', '2020-01-01T00:00:00.000Z');
    INSERT INTO rooms (id, org_id, name, topic, created_by, created_at) VALUES
      ('later', 'org', '项目', '', 'user', '2020-01-02T00:00:00.000Z'),
      ('hall', 'org', '大厅', '', 'user', '2020-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const opened = openDatabase(path);
  const migrated = opened.prepare("SELECT id, general FROM rooms").all() as Array<{ id: string; general: number }>;
  assert.equal(migrated.find((item) => item.id === "hall")?.general, 1);
  assert.equal(migrated.find((item) => item.id === "later")?.general, 0);
  opened.close();
});

test("peers see different context in a channel and a direct conversation", () => {
  const { store, user, roomId } = studio();
  const coder = enroll(store, user, roomId, "coder", "ui");
  const reader = enroll(store, user, roomId, "reader", "docs");
  const scribe = enroll(store, user, roomId, "scribe", "test");
  const elsewhere = store.createRoom(user, "别处", "");
  const stranger = enroll(store, user, elsewhere.id, "stranger", "ui");
  store.postMessage(user, roomId, { kind: "chat", body: "频道里的公开话" });
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "改按钮", tags: "ui" });
  store.claim(coder, posted.task!.id, "implementer");

  const peers = store.listPeers(reader);
  const found = peers.find((peer) => peer.handle === "coder");
  assert.ok(found);
  assert.equal(found.working[0]?.title, "改按钮");
  assert.equal(found.working[0]?.role, "implementer");
  assert.equal(peers.some((peer) => peer.handle === "stranger"), false);
  assert.equal(peers.some((peer) => peer.handle === "reader"), false);

  const asked = store.ask(reader, { handle: "@coder", body: "你是不是已经在改按钮？" });
  assert.equal(asked.direct, true);
  assert.deepEqual(asked.handles, ["coder", "reader"]);
  assert.equal(store.readMessages(coder, asked.roomId, 0).some((message) => message.body === "你是不是已经在改按钮？"), true);
  assert.equal(store.readMessages(coder, asked.roomId, 0).some((message) => message.body === "频道里的公开话"), false);
  assert.equal(store.readMessages(coder, roomId, 0).some((message) => message.body === "你是不是已经在改按钮？"), false);
  assert.equal(store.readMessages(scribe, roomId, 0).some((message) => message.body === "频道里的公开话"), true);
  assert.throws(() => store.readMessages(scribe, asked.roomId, 0), (error: unknown) => {
    return error instanceof ApiError && error.status === 403;
  });
  assert.equal(events(store, coder.id, "mention").some((event) => event.summary.startsWith("私聊：")), true);
  assert.equal(events(store, scribe.id, "mention").some((event) => event.room_id === asked.roomId), false);
  assert.equal(store.snapshot(user, asked.roomId, new Set()).room.direct, true);
  const again = store.ask(coder, { handle: "reader", body: "是，我在改禁用态。" });
  assert.equal(again.roomId, asked.roomId);

  const group = store.ask(reader, { handles: ["coder", "scribe"], body: "你们两个谁在改按钮？" });
  assert.notEqual(group.roomId, asked.roomId);
  assert.deepEqual(group.handles, ["coder", "reader", "scribe"]);
  assert.equal(store.readMessages(scribe, group.roomId, 0).some((message) => message.body === "你们两个谁在改按钮？"), true);
  assert.throws(() => store.readMessages(stranger, group.roomId, 0), (error: unknown) => {
    return error instanceof ApiError && error.status === 403;
  });
  assert.throws(() => store.postMessage(user, asked.roomId, { kind: "instruction", body: "私聊里下指令" }), (error: unknown) => {
    return error instanceof ApiError && error.code === "direct_room";
  });
  assert.throws(() => store.setArchived(user, asked.roomId, true), (error: unknown) => {
    return error instanceof ApiError && error.code === "direct_room";
  });
  assert.throws(() => store.ask(coder, { handle: "coder", body: "我问我自己" }), (error: unknown) => {
    return error instanceof ApiError && error.code === "bad_handles";
  });
  assert.throws(() => store.ask(coder, { handle: "stranger", body: "你在吗" }), (error: unknown) => {
    return error instanceof ApiError && error.code === "no_peer";
  });
});

function pauseDemos(store: Store, user: Principal & { type: "user" }) {
  const demos = store.db.prepare("SELECT id FROM agents WHERE demo = 1").all() as Array<{ id: string }>;
  for (const demo of demos) store.setPaused(user, demo.id, true);
}

test("design identities write the plan before an implementer can claim", () => {
  const { store, user, roomId } = studio();
  pauseDemos(store, user);
  const scholar = enroll(store, user, roomId, "scholar", "research");
  const coder = enroll(store, user, roomId, "coder", "build");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "做一个导出" });
  const task = posted.task;
  assert.ok(task);
  assert.equal(task.status, "open");
  assert.deepEqual(task.designPending, ["research"]);
  assert.equal(events(store, scholar.id, "design_needed").length, 1);
  assert.match(events(store, scholar.id, "design_needed")[0]?.summary ?? "", /不改代码/);
  assert.equal(events(store, coder.id, "task_open").length, 0);
  assert.equal(events(store, coder.id, "bid_open").length, 0);
  assert.throws(() => store.claim(coder, task.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "design_first";
  });
  assert.throws(() => store.submitDesign(coder, task.id, "我直接做"), (error: unknown) => {
    return error instanceof ApiError && error.code === "not_designer";
  });
  const next = store.submitDesign(scholar, task.id, "先确认导出的是当前房间的消息。");
  assert.equal(next.designPending.length, 0);
  assert.equal(next.tags, "build");
  assert.equal(next.designs[0]?.handle, "scholar");
  assert.equal(events(store, coder.id, "task_open").length, 1);
  assert.equal(store.whoami(scholar).groupLabel, "课题研究");
  assert.throws(() => store.submitDesign(scholar, task.id, "再写一版"), (error: unknown) => {
    return error instanceof ApiError && error.code === "design_done";
  });
});

test("every present design identity submits before implementation opens", () => {
  const { store, user, roomId } = studio();
  pauseDemos(store, user);
  const product = enroll(store, user, roomId, "planner", "product");
  const architect = enroll(store, user, roomId, "framer", "architect");
  const coder = enroll(store, user, roomId, "coder", "build");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "重做入口" });
  const task = posted.task;
  assert.ok(task);
  assert.deepEqual(task.designPending, ["product", "architect"]);
  const mid = store.submitDesign(architect, task.id, "入口独立成一页，数据仍走现有接口。");
  assert.deepEqual(mid.designPending, ["product"]);
  assert.equal(events(store, coder.id, "task_open").length, 0);
  const done = store.submitDesign(product, task.id, "用户先看到名字，再进入大厅。");
  assert.equal(done.designPending.length, 0);
  assert.equal(events(store, coder.id, "task_open").length, 1);
});

test("a tagged instruction skips the design gate", () => {
  const { store, user, roomId } = studio();
  pauseDemos(store, user);
  const scholar = enroll(store, user, roomId, "scholar", "research");
  const coder = enroll(store, user, roomId, "coder", "build");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "只改实现", tags: "build" });
  const task = posted.task;
  assert.ok(task);
  assert.deepEqual(task.designPending, []);
  assert.equal(events(store, scholar.id, "design_needed").length, 0);
  assert.equal(events(store, coder.id, "task_open").length, 1);
});

test("a person can hand the task to implementers before every design is in", () => {
  const { store, user, roomId } = studio();
  pauseDemos(store, user);
  enroll(store, user, roomId, "scholar", "research");
  const coder = enroll(store, user, roomId, "coder", "build");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "先做起来" });
  const task = posted.task;
  assert.ok(task);
  const next = store.handOffDesign(user, task.id);
  assert.equal(next.designPending.length, 0);
  assert.equal(next.tags, "build");
  assert.equal(events(store, coder.id, "task_open").length, 1);
});

test("changing an agent group is what later instructions match", () => {
  const { store, user, roomId } = studio();
  pauseDemos(store, user);
  const coder = enroll(store, user, roomId, "coder", "build");
  const changed = store.setGroup(user, coder.id, "design");
  assert.equal(changed.label, "设计师");
  assert.equal(store.whoami(coder).group, "design");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "出一版界面" });
  const task = posted.task;
  assert.ok(task);
  assert.deepEqual(task.designPending, ["design"]);
  assert.equal(events(store, coder.id, "design_needed").length, 1);
  assert.throws(() => store.setGroup(user, coder.id, "poet"), (error: unknown) => {
    return error instanceof ApiError && error.code === "bad_group";
  });
});

function step(store: Store, agent: Principal & { type: "agent" }, roomId: string, role: string) {
  const found = store.listTasks(agent, roomId).find((task) => task.stepRole === role);
  assert.ok(found, role);
  return found;
}

function pipeline(store: Store, user: Principal & { type: "user" }, roomId: string, steps: unknown) {
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "把支付失败讲清楚再做", steps });
  assert.equal(posted.task?.mode, "pipeline");
  assert.equal(posted.task?.status, "working");
  return posted.task as TaskView;
}

test("echo research output becomes the product step input, even when gate is set", () => {
  const { store, user, roomId } = studio();
  const researcher = enroll(store, user, roomId, "antigravity", "research");
  const designer = enroll(store, user, roomId, "chatgpt", "product");
  pipeline(store, user, roomId, {
    gate: true,
    steps: [
      { role: "research", handle: "antigravity", gate: true },
      { role: "product", handle: "chatgpt" },
    ],
  });
  const research = step(store, researcher, roomId, "research");
  assert.equal(research.status, "open");
  assert.equal(research.gate, true);
  assert.equal(step(store, researcher, roomId, "product").status, "blocked");
  const echoed = echoAction({
    id: research.id,
    title: research.title,
    body: "研究发现：失败集中在超时重试。",
    stepRole: "research",
  });
  assert.equal(echoed.type, "deliver");
  if (echoed.type !== "deliver") return;
  store.claim(researcher, research.id, "implementer");
  store.deliver(researcher, research.id, echoed.ref, echoed.summary, { body: echoed.body });
  const product = step(store, designer, roomId, "product");
  assert.equal(product.status, "open");
  assert.match(product.body, /研究发现：失败集中在超时重试。/);
  assert.equal(events(store, designer.id, "task_open").length, 1);
  assert.equal(events(store, researcher.id, "task_open").filter((row) => row.ref_id === product.id).length, 0);
});

test("review changes return to research, and a full pass feeds the product step", () => {
  const { store, user, roomId } = studio();
  const researcher = enroll(store, user, roomId, "antigravity");
  const designer = enroll(store, user, roomId, "chatgpt");
  const grok = enroll(store, user, roomId, "grok");
  const parent = pipeline(store, user, roomId, {
    steps: [
      { role: "research", handle: "antigravity" },
      { role: "review", handles: ["chatgpt", "grok"] },
      { role: "product", handle: "chatgpt" },
    ],
  });
  const research = step(store, researcher, roomId, "research");
  store.claim(researcher, research.id, "implementer");
  store.deliver(researcher, research.id, "note:1", "研究短说明", { body: "研究发现：失败集中在超时重试。" });
  const review = step(store, designer, roomId, "review");
  assert.equal(review.status, "open");
  store.conclude(designer, review.id, "changes", "补上来源");
  store.conclude(grok, review.id, "pass", "范围可以");
  const returned = step(store, researcher, roomId, "research");
  assert.equal(returned.status, "open");
  assert.match(returned.body, /补上来源/);
  assert.equal(step(store, designer, roomId, "review").status, "blocked");
  assert.equal(step(store, designer, roomId, "product").status, "blocked");
  store.claim(researcher, returned.id, "implementer");
  store.deliver(researcher, returned.id, "note:2", "补了来源", { body: "研究发现：失败集中在超时重试。" });
  const again = step(store, designer, roomId, "review");
  store.conclude(designer, again.id, "pass", "来源够了");
  store.conclude(grok, again.id, "pass", "可以写 PRD");
  const product = step(store, designer, roomId, "product");
  assert.equal(product.status, "open");
  assert.match(product.body, /研究发现：失败集中在超时重试。/);
  assert.match(product.body, /可以写 PRD/);

  const limited = pipeline(store, user, roomId, {
    steps: [
      { role: "research", handle: "antigravity" },
      { role: "review", handles: ["chatgpt", "grok"] },
    ],
  });
  store.db.prepare("UPDATE tasks SET cross_returns = 2 WHERE id = ?").run(limited.id);
  const capped = store.listTasks(researcher, roomId).find((task) => task.pipelineId === limited.id && task.stepRole === "research");
  assert.ok(capped);
  store.claim(researcher, capped.id, "implementer");
  store.deliver(researcher, capped.id, "note:3", "又一份", { body: "另一份研究" });
  const openReview = store.listTasks(researcher, roomId).find((task) => task.pipelineId === limited.id && task.stepRole === "review");
  assert.ok(openReview);
  store.conclude(designer, openReview.id, "changes", "还是不行");
  store.conclude(grok, openReview.id, "changes", "同意打回");
  assert.equal(store.getTask(researcher, capped.id).status, "done");
  assert.equal(store.getTask(designer, openReview.id).status, "open");
});

test("qa failure reopens build and blocks qa until the return limit", () => {
  const { store, user, roomId } = studio();
  const cursor = enroll(store, user, roomId, "cursor");
  const grok = enroll(store, user, roomId, "grok");
  const parent = pipeline(store, user, roomId, {
    steps: [
      { role: "build", handle: "cursor" },
      { role: "qa", handle: "grok" },
    ],
  });
  const deliverBuild = () => {
    const build = step(store, cursor, roomId, "build");
    store.claim(cursor, build.id, "implementer");
    store.deliver(cursor, build.id, "branch/pay", "做完了", { body: "npm start" });
  };
  const failQa = () => {
    const qa = step(store, grok, roomId, "qa");
    store.claim(grok, qa.id, "implementer");
    store.deliver(grok, qa.id, "qa:local", "动画卡住了", {
      body: "结账按钮没有反馈",
      verdict: "fail",
      screenshots: ["/home/grok/shots/checkout.png"],
    });
  };
  deliverBuild();
  failQa();
  assert.equal(step(store, cursor, roomId, "build").status, "open");
  assert.equal(step(store, grok, roomId, "qa").status, "blocked");
  assert.match(step(store, cursor, roomId, "build").body, /动画卡住了/);
  assert.match(step(store, cursor, roomId, "build").body, /\/home\/grok\/shots\/checkout\.png/);
  assert.ok(events(store, cursor.id, "task_open").length >= 2);
  deliverBuild();
  failQa();
  deliverBuild();
  failQa();
  assert.equal(step(store, cursor, roomId, "build").status, "open");
  deliverBuild();
  failQa();
  assert.equal(step(store, cursor, roomId, "build").status, "done");
  assert.equal(step(store, grok, roomId, "qa").status, "blocked");
  const returns = store.db.prepare("SELECT qa_returns FROM tasks WHERE id = ?").get(parent.id) as { qa_returns: number };
  assert.equal(returns.qa_returns, 3);
});

test("build falls through handles when the first is missing, declines, or times out", () => {
  const missing = studio();
  const assistant = enroll(missing.store, missing.user, missing.roomId, "chatgpt");
  pipeline(missing.store, missing.user, missing.roomId, {
    steps: [{ role: "build", handles: ["cursor", "chatgpt", "claude"], claimTimeoutMs: 1000 }],
  });
  const offered = step(missing.store, assistant, missing.roomId, "build");
  assert.equal(offered.assigneeHandle, "chatgpt");
  assert.equal(events(missing.store, assistant.id, "task_open").length, 1);

  const { store, user, roomId } = studio();
  const cursor = enroll(store, user, roomId, "cursor");
  const chatgpt = enroll(store, user, roomId, "chatgpt");
  enroll(store, user, roomId, "claude");
  pipeline(store, user, roomId, {
    steps: [{ role: "build", handles: ["cursor", "chatgpt", "claude"], claimTimeoutMs: 1000 }],
  });
  const build = step(store, cursor, roomId, "build");
  assert.equal(build.assigneeHandle, "cursor");
  assert.equal(events(store, chatgpt.id, "task_open").length, 0);
  store.decline(cursor, build.id, "这轮不做");
  assert.equal(step(store, chatgpt, roomId, "build").assigneeHandle, "chatgpt");
  assert.equal(events(store, chatgpt.id, "task_open").length, 1);

  const timed = studio();
  const first = enroll(timed.store, timed.user, timed.roomId, "cursor");
  const second = enroll(timed.store, timed.user, timed.roomId, "chatgpt");
  pipeline(timed.store, timed.user, timed.roomId, {
    steps: [{ role: "build", handles: ["cursor", "chatgpt"], claimTimeoutMs: 1000 }],
  });
  assert.equal(events(timed.store, second.id, "task_open").length, 0);
  timed.store.reap(new Date(Date.now() + 5_000));
  assert.equal(step(timed.store, second, timed.roomId, "build").assigneeHandle, "chatgpt");
  assert.equal(events(timed.store, second.id, "task_open").length, 1);
  assert.equal(events(timed.store, first.id, "task_open").length, 1);
});

test("a pipeline keeps step handles when the instruction also @-names someone else", () => {
  const { store, user, roomId } = studio();
  const cursor = enroll(store, user, roomId, "cursor");
  const chatgpt = enroll(store, user, roomId, "chatgpt");
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "@chatgpt 把支付失败讲清楚再做",
    steps: [{ role: "build", handle: "cursor" }],
  });
  assert.equal(posted.task?.mode, "pipeline");
  const build = step(store, cursor, roomId, "build");
  assert.equal(build.assigneeHandle, "cursor");
  assert.equal(build.status, "open");
  assert.equal(events(store, cursor.id, "task_open").some((event) => event.ref_id === build.id), true);
  assert.equal(events(store, chatgpt.id, "task_open").filter((event) => event.ref_id === build.id).length, 0);
  assert.equal(events(store, chatgpt.id, "mention").length, 0);
  assert.throws(() => store.claim(chatgpt, build.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "not_eligible";
  });
  assert.equal(store.claim(cursor, build.id, "implementer").status, "claimed");
});

test("an @ instruction without steps still dispatches directly and does not open a pipeline", () => {
  const { store, user, roomId } = studio();
  const cursor = enroll(store, user, roomId, "cursor");
  const chatgpt = enroll(store, user, roomId, "chatgpt");
  const posted = store.postMessage(user, roomId, { kind: "instruction", body: "@cursor 只做这一处" });
  const task = posted.task;
  assert.ok(task);
  assert.equal(task.mode, "single");
  assert.equal(task.pipelineId, null);
  assert.equal(task.status, "open");
  assert.equal(events(store, cursor.id, "task_open").some((event) => event.ref_id === task.id), true);
  assert.equal(events(store, chatgpt.id, "task_open").length, 0);
  assert.equal(events(store, chatgpt.id, "bid_open").length, 0);
  assert.throws(() => store.claim(chatgpt, task.id, "implementer"), (error: unknown) => {
    return error instanceof ApiError && error.code === "not_addressed";
  });
  assert.equal(store.claim(cursor, task.id, "implementer").status, "claimed");
});

test("default pipeline keeps every handle and adds ppeng beside them", () => {
  const parsed = parsePipeline(DEFAULT_PIPELINE);
  assert.deepEqual(
    parsed.steps.map((step) => step.role),
    ["research", "review", "product", "ui", "tech", "build", "qa"],
  );
  assert.deepEqual(parsed.steps.find((step) => step.role === "review")?.handles, ["chatgpt", "grok", "ppeng"]);
  assert.deepEqual(parsed.steps.find((step) => step.role === "build")?.handles, ["cursor", "ppeng", "chatgpt", "claude"]);
});

test("any of three reviewers can send research back, and a missing reviewer does not wait forever", () => {
  const { store, user, roomId } = studio();
  const researcher = enroll(store, user, roomId, "antigravity");
  const designer = enroll(store, user, roomId, "chatgpt");
  const grok = enroll(store, user, roomId, "grok");
  pipeline(store, user, roomId, {
    steps: [
      { role: "research", handle: "antigravity" },
      { role: "review", handles: ["chatgpt", "grok", "ppeng"], claimTimeoutMs: 1000 },
      { role: "product", handle: "chatgpt" },
    ],
  });
  const deliverResearch = () => {
    const research = step(store, researcher, roomId, "research");
    store.claim(researcher, research.id, "implementer");
    store.deliver(researcher, research.id, "note:1", "研究短说明", { body: "研究发现：失败集中在超时重试。" });
  };
  deliverResearch();
  const review = step(store, designer, roomId, "review");
  store.conclude(designer, review.id, "changes", "补上来源");
  assert.equal(step(store, designer, roomId, "review").status, "open");
  store.conclude(grok, review.id, "pass", "范围可以");
  assert.equal(step(store, researcher, roomId, "research").status, "open");
  assert.match(step(store, researcher, roomId, "research").body, /补上来源/);
  assert.equal(step(store, designer, roomId, "product").status, "blocked");

  store.claim(researcher, step(store, researcher, roomId, "research").id, "implementer");
  store.deliver(researcher, step(store, researcher, roomId, "research").id, "note:2", "补了来源", {
    body: "研究发现：失败集中在超时重试。",
  });
  const again = step(store, designer, roomId, "review");
  store.conclude(designer, again.id, "pass", "来源够了");
  store.conclude(grok, again.id, "pass", "可以写 PRD");
  assert.equal(step(store, designer, roomId, "product").status, "open");
});

test("an enrolled reviewer who is still online holds the review, and an offline one is dropped", () => {
  const live = studio();
  const researcher = enroll(live.store, live.user, live.roomId, "antigravity");
  const designer = enroll(live.store, live.user, live.roomId, "chatgpt");
  const grok = enroll(live.store, live.user, live.roomId, "grok");
  const ppeng = enroll(live.store, live.user, live.roomId, "ppeng");
  pipeline(live.store, live.user, live.roomId, {
    steps: [
      { role: "research", handle: "antigravity" },
      { role: "review", handles: ["chatgpt", "grok", "ppeng"], claimTimeoutMs: 1000 },
      { role: "product", handle: "chatgpt" },
    ],
  });
  const research = step(live.store, researcher, live.roomId, "research");
  live.store.claim(researcher, research.id, "implementer");
  live.store.deliver(researcher, research.id, "note:1", "研究", { body: "研究发现。" });
  const review = step(live.store, designer, live.roomId, "review");
  live.store.touchSeen(ppeng.id);
  live.store.conclude(designer, review.id, "pass", "可以");
  live.store.conclude(grok, review.id, "pass", "可以");
  assert.equal(step(live.store, designer, live.roomId, "review").status, "open");
  live.store.reap(new Date(Date.now() + 5_000));
  assert.equal(step(live.store, designer, live.roomId, "review").status, "open");
  assert.equal(step(live.store, designer, live.roomId, "product").status, "blocked");

  const quiet = studio();
  const researcher2 = enroll(quiet.store, quiet.user, quiet.roomId, "antigravity");
  const designer2 = enroll(quiet.store, quiet.user, quiet.roomId, "chatgpt");
  const grok2 = enroll(quiet.store, quiet.user, quiet.roomId, "grok");
  enroll(quiet.store, quiet.user, quiet.roomId, "ppeng");
  pipeline(quiet.store, quiet.user, quiet.roomId, {
    steps: [
      { role: "research", handle: "antigravity" },
      { role: "review", handles: ["chatgpt", "grok", "ppeng"], claimTimeoutMs: 1000 },
      { role: "product", handle: "chatgpt" },
    ],
  });
  const research2 = step(quiet.store, researcher2, quiet.roomId, "research");
  quiet.store.claim(researcher2, research2.id, "implementer");
  quiet.store.deliver(researcher2, research2.id, "note:1", "研究", { body: "研究发现。" });
  const waiting = step(quiet.store, designer2, quiet.roomId, "review");
  quiet.store.conclude(designer2, waiting.id, "pass", "可以");
  quiet.store.conclude(grok2, waiting.id, "pass", "可以");
  assert.equal(step(quiet.store, designer2, quiet.roomId, "review").status, "open");
  quiet.store.reap(new Date(Date.now() + 5_000));
  assert.equal(step(quiet.store, designer2, quiet.roomId, "review").status, "done");
  assert.equal(step(quiet.store, designer2, quiet.roomId, "product").status, "open");
});

test("a review with nobody present blocks instead of passing itself", () => {
  const { store, user, roomId } = studio();
  const researcher = enroll(store, user, roomId, "antigravity");
  pipeline(store, user, roomId, {
    steps: [
      { role: "research", handle: "antigravity" },
      { role: "review", handles: ["ppeng"], claimTimeoutMs: 1000 },
      { role: "product", handle: "chatgpt" },
    ],
  });
  const research = step(store, researcher, roomId, "research");
  store.claim(researcher, research.id, "implementer");
  store.deliver(researcher, research.id, "note:1", "研究", { body: "研究发现。" });
  assert.equal(step(store, researcher, roomId, "review").status, "open");
  store.reap(new Date(Date.now() + 5_000));
  assert.equal(step(store, researcher, roomId, "review").status, "blocked");
  assert.equal(step(store, researcher, roomId, "product").status, "blocked");
});
