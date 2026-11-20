import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { OpportunityStore } from "./server/autonomy.ts";
import { channelMessages } from "./server/zoom-channel.ts";
import { DelegationService } from "./server/delegation.ts";
import { StageWorkStore } from "./server/stage-work.ts";
import { ZoomStore } from "./server/zoom.ts";
import { openStore } from "./server/logic.ts";
import type { ZoomMessage } from "./zoom-types.ts";
import type { StageHomeService } from "./server/stage-home.ts";
import type { StageHomeReceipt } from "./stage-home-types.ts";

const method = { via: "coding-agent" as const, target: "grok", instructions: "核实原记录并附出处" };
function setup(t: TestContext, home?: Pick<StageHomeService, "cached" | "send" | "reconcile">) {
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const user = store.localUser();
  const work = new StageWorkStore(store.db),
    zoom = new ZoomStore(store.db);
  const task = zoom.register({ source: "fixture-cli", externalId: "main", title: "核实资料" });
  const extra: ZoomMessage[] = [];
  const raw = () => [...extra, ...zoom.messages(), ...channelMessages(store, user)];
  const off = () => {
    throw Error("unexpected Home call");
  };
  const service = () =>
    new DelegationService(store, work, home ?? { send: off, reconcile: off, cached: off }, raw);
  return {
    store,
    user,
    work,
    zoom,
    task,
    extra,
    raw,
    service,
    question: (body: string) => zoom.report(task.id, { kind: "question", body, eventId: body }),
  };
}
function finish(work: StageWorkStore, id: string, body = "已核实原始记录") {
  const { claimId } = work.claim(id, { agent: "grok", session: "grok/test" });
  work.report(id, { claimId, eventId: "done", kind: "completed", body, evidence: ["evidence/original"] });
}
test("manual delegation is idempotent, owns the inbox item, returns one evidence-backed answer to the original after restart", async (t) => {
  const f = setup(t),
    s = f.service(),
    q = f.question("首周有多少条？");
  const d = await s.submit(f.user, { messageId: q.id, method });
  assert.equal(d.status, "queued");
  assert.equal(f.work.get(d.workId).stage, null);
  assert.equal(
    f.work.list({ stage: "research" }).items.some((w) => w.id === d.workId),
    false,
  );
  assert.equal(f.zoom.thread(d.workId)[0].folder, "公司/委派");
  assert.equal(s.decorate(f.raw()).find((m) => m.id === q.id)?.pending, false);
  assert.equal((await s.submit(f.user, { messageId: q.id, method })).workId, d.workId);
  await assert.rejects(s.submit(f.user, { messageId: q.id, method: { ...method, target: "codex" } }));
  const { claimId } = f.work.claim(d.workId, { agent: "grok", session: "grok/test" });
  await s.tick();
  assert.equal(s.list(f.user).items[0].status, "working");
  const need = f.work.report(d.workId, { kind: "question", eventId: "need", claimId, body: "试验口径是哪一个？" });
  await s.tick();
  assert.deepEqual(
    s
      .decorate(f.raw())
      .filter((m) => m.pending)
      .map((m) => m.id),
    [need.id],
  );
  f.zoom.reply(d.workId, { questionId: need.id, body: "第一组" }, "负责人");
  f.work.report(d.workId, {
    claimId,
    eventId: "done",
    kind: "completed",
    body: "首周五条",
    evidence: ["source/1"],
  });
  const restart = f.service();
  await Promise.all([restart.tick(), restart.tick()]);
  await restart.tick();
  assert.deepEqual(
    f.zoom.feedback(f.task.id, 0).events.map((e) => [e.questionId, e.body, e.actor]),
    [[q.id, "首周五条", "grok"]],
  );
  assert.equal(restart.list(f.user).items[0].status, "completed");
  assert.equal(
    restart.decorate(f.raw()).some((m) => m.pending),
    false,
  );
});

test("opt-in applies only to future pending messages; decisions and choices stay open and resolve only with the real card", async (t) => {
  const f = setup(t),
    s = f.service();
  const old = f.question("昨日待办");
  await s.tick();
  assert.deepEqual(s.list(f.user).items, []);
  s.setPreference(f.user, { ...method, automatic: true });
  const q = f.zoom.report(f.task.id, {
    kind: "question",
    eventId: "choose",
    body: "请选择产品",
    choices: ["A", "B"],
  });
  await s.tick();
  const d = s.list(f.user).items[0];
  assert.equal(d.sourceId, q.id);
  assert.equal(s.decorate(f.raw()).find((m) => m.id === old.id)?.pending, true);
  finish(f.work, d.workId);
  await s.tick();
  assert.equal(s.list(f.user).items[0].status, "approval");
  assert.equal(f.zoom.feedback(f.task.id, 0).events.length, 0);
  assert.deepEqual(
    s
      .decorate(f.raw())
      .filter((m) => m.pending)
      .map((m) => m.id)
      .sort(),
    [q.id, old.id].sort(),
  );
  f.zoom.reply(f.task.id, { questionId: q.id, choice: "B" }, "负责人");
  assert.equal(s.list(f.user).items[0].status, "completed");
  await s.tick();
  assert.deepEqual(s.list(f.user).items[0].evidence, ["evidence/original"]);
  const explicit = f.question("请批准上线");
  await s.tick();
  const planned = s.list(f.user).items.find((i) => i.sourceId === explicit.id)!;
  finish(f.work, planned.workId);
  await s.tick();
  assert.equal(s.list(f.user).items.find((i) => i.sourceId === explicit.id)?.status, "approval");
  const count = s.list(f.user).items.length;
  s.setPreference(f.user, { ...method, automatic: false });
  f.question("关闭自动后的问题");
  await s.tick();
  assert.equal(s.list(f.user).items.length, count);
});

test("superseded workflow versions preserve the original recommendation and never complete the new card", async (t) => {
  const f = setup(t),
    s = f.service();
  const card: ZoomMessage = {
    ...f.question("计划信息"),
    id: "card:one",
    origin: "workflow",
    kind: "decision",
    revision: 1,
    action: { kind: "decision", cardId: "one", revision: 1 },
  };
  f.store.db
    .prepare("INSERT INTO workflow_runs(id,request_id,created_at,snapshot) VALUES(?,?,?,?)")
    .run(
      card.taskId,
      "pinned",
      card.at,
      JSON.stringify({
        request: { constraints: ["保留既有接口"] },
        revisions: [
          {
            number: 1,
            reason: "首版",
            plan: {
              acceptance: ["review"],
              nodes: [
                {
                  id: "review",
                  kind: "review",
                  title: "独立复核",
                  instruction: "核实准入材料",
                  dependsOn: ["write"],
                },
              ],
            },
          },
        ],
        attempts: [
          {
            id: "attempt-one",
            nodeId: "review",
            revision: 1,
            evidence: { outcome: "succeeded", summary: "已核实", checks: [{ name: "lint", exitCode: 0 }] },
          },
        ],
      }),
    );
  f.extra.push({ ...card, folder: "样例/项目A", stage: "testing" });
  const d = await s.submit(f.user, { messageId: card.id, method });
  const brief = f.work.get(d.workId);
  assert.equal(brief.stage, "testing");
  assert.equal(f.zoom.thread(d.workId)[0].folder, "样例/项目A");
  assert.match(brief.inputs, /核实准入材料/);
  assert.match(brief.inputs, /lint exit=0/);
  assert.match(brief.inputs, /status [a-f0-9-]+/);
  finish(f.work, d.workId);
  await s.tick();
  assert.equal(s.list(f.user).items[0].status, "approval");
  f.extra[0] = { ...card, pending: false, action: undefined };
  f.extra.push({ ...card, id: "card:two", revision: 2, action: { kind: "decision", cardId: "two", revision: 2 } });
  await s.tick();
  assert.equal(s.list(f.user).items[0].status, "completed");
  assert.equal(s.decorate(f.raw()).find((m) => m.id === "card:two")!.pending, true);
});

test("page research closes with evidence; a protected operation or unknown Home receipt returns to personal inbox, only once", async (t) => {
  let sends = 0,
    reads = 0,
    cached: StageHomeReceipt | null = null;
  const f = setup(t, {
    cached: () => cached,
    send: async () => {
      sends++;
      return (cached = {
        botId: "bot-1",
        botName: "Bot",
        checkedAt: new Date().toISOString(),
        status: "unknown",
        evidence: [],
        detail: "请核对原回执",
      });
    },
    reconcile: async () => {
      reads++;
      return cached;
    },
  });
  const s = f.service(),
    op = { key: "idea:one", title: "研究留存", href: "#ideas?idea=one", detail: "分析原记录" };
  const simple = await s.submit(f.user, { operation: op, method });
  finish(f.work, simple.workId);
  await s.tick();
  assert.equal(s.list(f.user).items[0].status, "completed");
  assert.equal(
    s.decorate(f.raw()).some((m) => m.pending),
    false,
  );
  const repeatKey = op.key + "/next/" + simple.id;
  const repeat = await s.submit(f.user, { operation: { ...op, key: repeatKey }, method });
  assert.equal((await s.submit(f.user, { operation: { ...op, key: repeatKey }, method })).id, repeat.id);
  await assert.rejects(s.submit(f.user, { operation: { ...op, key: "other/next/" + simple.id }, method }));
  const opportunities = new OpportunityStore(f.store.db);
  const opp = opportunities.add({
    project: "test",
    sourceId: "op",
    kind: "feature",
    title: "优先级",
    rationale: "反馈",
    evidence: ["evidence/one"],
    impact: 3,
  });
  const guarded = await s.submit(f.user, {
    operation: { ...op, key: "opportunity:" + opp.id, requiresApproval: true },
    method,
  });
  finish(f.work, guarded.workId);
  await s.tick();
  const a = s.decorate(f.raw()).filter((m) => m.pending);
  assert.equal(a.length, 1);
  assert.equal(a[0].delegation?.sourceHref, op.href);
  const bot = { via: "agent-home", target: "bot-1", instructions: "核实后给出建议" };
  const h = await s.submit(f.user, { operation: { ...op, key: "home" }, method: bot });
  assert.equal(h.status, "reconcile");
  assert.equal(sends, 1);
  await f.service().tick();
  assert.ok(reads > 0);
  assert.equal(sends, 1);
  assert.equal(s.decorate(f.raw()).filter((m) => m.pending).length, 2);
  opportunities.skip(opp.id);
  await s.tick();
  assert.equal(s.list(f.user).items.find((i) => i.id === guarded.id)?.status, "completed");
  assert.equal(s.decorate(f.raw()).filter((m) => m.pending).length, 1);
});

test("channel answer returns to the same original post and wakes only its author once", async (t) => {
  const f = setup(t),
    s = f.service();
  const room = f.store.createRoom(f.user, "来源", "", { project: "P" });
  const author = f.store.agentByToken(
    f.store.enroll(f.store.createJoinCode(f.user, room.id).code, "author", "native").token,
  );
  assert.ok(author?.type === "agent");
  const post = f.store.postMessage(author, room.id, { kind: "question", body: "哪天记录下来的？" }).message;
  const d = await s.submit(f.user, { messageId: "channel:" + post.id, method });
  const brief = f.work.get(d.workId).inputs;
  assert.ok(brief.includes(String(post.id)) && brief.includes(room.id));
  finish(f.work, d.workId, "周三");
  await s.tick();
  await f.service().tick();
  const answers = f.raw().filter((m) => m.replyTo === "channel:" + post.id);
  assert.equal(answers.length, 1);
  assert.match(answers[0].body, /grok.*代答[\s\S]*周三/);
});

test("delegation exposes workMessageId and enforces agent-home instruction budget", async (t) => {
  const f = setup(t),
    s = f.service();
  const op = { key: "channel-task:r1:t1", title: "核对任务", href: "#channels?room=r1&task=t1", detail: "核对详情" };
  const created = await s.submit(f.user, { operation: op, method });
  assert.ok(created.workMessageId);
  assert.equal(s.list(f.user).items[0].workMessageId, created.workMessageId);
  const tooLong = { via: "agent-home" as const, target: "bot-1", instructions: "长".repeat(1600) };
  assert.throws(() => s.setPreference(f.user, { ...tooLong, automatic: false }), /1500/);
  await assert.rejects(
    s.submit(f.user, { operation: { ...op, key: "channel-task:r1:t2" }, method: tooLong }),
    /1500/,
  );
});
