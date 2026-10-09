import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "./http.ts";
import { ApiError, openStore, type Principal, type Store } from "./logic.ts";

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

test("a complex task with one strong agent stays open, mentions ignore level, and review does too", () => {
  const { store, user, roomId } = studio();
  const junior = enroll(store, user, roomId, "junior", "lab", 1);
  const senior = enroll(store, user, roomId, "senior", "lab", 4);
  const posted = store.postMessage(user, roomId, {
    kind: "instruction",
    body: "@junior 你先看一下方案，实现交给更合适的人",
    tags: "lab",
    complex: true,
  });
  assert.equal(posted.task?.status, "open");
  assert.equal(events(store, senior.id, "task_open").length, 1);
  assert.equal(events(store, junior.id, "task_open").length, 0);
  assert.equal(events(store, junior.id, "mention").length, 1);
  assert.equal(store.readMessages(junior, roomId, 0).some((message) => String(message.body).includes("@junior")), true);
  store.claim(senior, posted.task!.id, "implementer");
  store.deliver(senior, posted.task!.id, "workspace:auth", "权限模型交了一版。");
  store.claim(junior, posted.task!.id, "reviewer");
  const reviewed = store.review(junior, posted.task!.id, "approve", "范围够了。");
  assert.equal(reviewed.status, "in_test");
  assert.equal(levelOf(store, senior.id), 5);
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
