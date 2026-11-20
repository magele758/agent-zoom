import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { openDatabase } from "./server/db.ts";
import { createApp } from "./server/http.ts";
import { ApiError, openStore } from "./server/logic.ts";
import { StageWorkStore } from "./server/stage-work.ts";
import { ZoomStore } from "./server/zoom.ts";
import type { StageWorkInput } from "./stage-work-types.ts";

const brief: StageWorkInput = {
  requestId: "research-1",
  product: "",
  stage: "research",
  templateId: "sources",
  title: "核对导出反馈",
  goal: "了解谁提出批量导出",
  inputs: "访谈和原始 Issue",
  deliverable: "反馈清单",
  acceptance: "每条附一个源链接",
  target: "coding-agent",
  requestedAgent: "Codex",
};
const fails = (code: number) => (e: unknown) => e instanceof ApiError && e.status === code;
const agent = { agent: "Codex", session: "codex://thread/11" };

test("stage brief, exclusive claim, pending answer and delivery evidence survive restart and repeat submissions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "stage-work-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "kunlun.db");
  let db = openDatabase(path);
  let stages = new StageWorkStore(db);
  let zoom = new ZoomStore(db);
  const { work, created } = stages.create(brief);
  const id = work.id;
  assert.ok(created);
  assert.equal(work.status, "open");
  assert.equal(stages.create(brief).created, false);
  assert.throws(() => stages.create({ ...brief, title: "新任务" }), fails(409));
  assert.throws(() => stages.create({ ...brief, requestId: "other", stage: "gtm" }), fails(400));
  assert.throws(() => stages.claim(id, { agent: "Home", session: "b", via: "agent-home" }), fails(409));
  assert.throws(() => stages.claim(id, { agent: "Grok", session: "other" }), fails(409));
  const { claimId } = stages.claim(id, agent);
  assert.equal(stages.claim(id, { ...agent, agent: "codex" }).claimId, claimId);
  assert.throws(() => stages.claim(id, { ...agent, session: "second" }), fails(409));
  const ask = { eventId: "q1", kind: "question", body: "同意本次纳入老客户吗？", claimId, requiresApproval: true };
  const question = stages.report(id, ask);
  assert.equal(question.requiresApproval, true);
  assert.equal(stages.report(id, ask).id, question.id);
  assert.throws(() => stages.report(id, { ...ask, requiresApproval: false }), fails(409));
  assert.equal(stages.get(id).status, "waiting");
  assert.equal(stages.get(id).messageId, question.id);
  assert.equal(question.actor, "Codex");
  assert.equal(question.folder, "公司/信息收集");
  const delivery = {
    eventId: "delivery",
    kind: "completed",
    body: "附上整理结果",
    evidence: ["evidence/customer-requests.md"],
    claimId,
  };
  assert.throws(() => stages.report(id, delivery), fails(409));
  zoom.reply(id, { questionId: question.id, body: "包括" }, "本机");
  assert.deepEqual(
    zoom.feedback(id, 0).events.map((e) => [e.questionEventId, e.body]),
    [["q1", "包括"]],
  );
  assert.throws(() => stages.report(id, { ...delivery, evidence: undefined }), fails(400));
  const result = stages.report(id, delivery);
  db.close();
  db = openDatabase(path);
  t.after(() => db.close());
  stages = new StageWorkStore(db);
  zoom = new ZoomStore(db);
  assert.equal(stages.report(id, delivery).id, result.id);
  assert.equal(stages.claim(id, agent).work.status, "completed");
  assert.throws(() => stages.report(id, { ...delivery, body: "覆盖回执" }), fails(409));
  assert.deepEqual(stages.get(id).evidence, delivery.evidence);
  assert.equal(stages.get(id).owner, "Codex");
  assert.equal(stages.list({requestedAgent:"codex"}).items[0].id,id);
  assert.equal(stages.list({requestedAgent:"other"}).items.length,0);
  assert.equal(stages.detail(id).messages.filter((m) => m.kind === "completed").length, 1);
  assert.equal(stages.list({ product: "", stage: "research", status: "completed" }).items.length, 1);
  assert.equal(stages.list({ product: "空项目" }).items.length, 0);
});

test("late receipts require reconciliation before reassignment and stale owners cannot write", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const stages = new StageWorkStore(db);
  const {
    work: { id },
  } = stages.create(brief);
  const { claimId } = stages.claim(id, agent);
  const update = { claimId, eventId: "p1", kind: "progress", body: "已保存输入清单" };
  const progress = stages.report(id, update);
  const expired = "2020-03-04T01:00:00.000Z";
  const expire = () => db.prepare("UPDATE stage_claims SET lease_until=? WHERE id=?").run(expired, claimId);
  expire();
  assert.equal(stages.get(id).status, "reconcile");
  assert.throws(() => stages.claim(id, { ...agent, session: "second" }), fails(409));
  assert.equal(stages.report(id, update).id, progress.id);
  assert.throws(() => stages.report(id, { ...update, eventId: "p2" }), fails(409));
  assert.equal(stages.renew(id, { claimId }).status, "active");
  assert.throws(() => stages.reopen(id, { expectedLeaseUntil: expired, reason: "核对" }, "本机"), fails(409));
  expire();
  assert.equal(
    stages.reopen(id, { expectedLeaseUntil: expired, reason: "原会话明确停止，保留变更" }, "本机").status,
    "open",
  );
  assert.throws(() => stages.claim(id, agent), fails(409));
  const next = stages.claim(id, { ...agent, session: "second" });
  assert.notEqual(next.claimId, claimId);
  assert.throws(() => stages.renew(id, { claimId }), fails(409));
  assert.throws(() => stages.report(id, { ...update, eventId: "p3" }), fails(409));
  assert.throws(() => stages.report(id, { ...update, claimId: next.claimId }), fails(409));
  assert.equal(stages.release(id, { claimId: next.claimId, reason: "自愿交回" }).status, "open");
  assert.equal(stages.detail(id).messages.filter((m) => m.body.includes("原会话明确停止")).length, 1);
});

test("a browser starts a stage and real local CLI processes claim, ask, receive feedback and deliver", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const token = "stage-work-temporary-fixture-token";
  const old = process.env.WORKFLOW_SUBMIT_TOKEN;
  process.env.WORKFLOW_SUBMIT_TOKEN = token;
  let app: ReturnType<typeof createApp>["app"];
  try {
    ({ app } = createApp(store));
  } finally {
    if (old === undefined) delete process.env.WORKFLOW_SUBMIT_TOKEN;
    else process.env.WORKFLOW_SUBMIT_TOKEN = old;
  }
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const me = await fetch(origin + "/api/me");
  const cookie = me.headers.get("set-cookie")!.split(";")[0];
  const post = (url: string, value: unknown, headers: Record<string, string>) =>
    fetch(origin + url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const path = "/api/zoom/stage-work";
  assert.equal((await post(path, brief, {})).status, 401);
  const creation = await post(path, brief, { cookie });
  assert.equal(creation.status, 200);
  const {
    work: { id },
  } = await creation.json();
  assert.equal((await post(path + "/" + id + "/claim", agent, { cookie })).status, 401);
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, [resolve("scripts/zoom.mjs"), ...args], {
          env: { ...process.env, WORKFLOW_SUBMIT_TOKEN: token, KUNLUN_URL: origin },
        })
      ).stdout,
    );
  assert.equal((await cli("stage", "list", "--product", "", "--stage", "research")).items[0].id, id);
  await assert.rejects(cli("done", id, "未认领的任务", "--evidence", "x"));
  const { claimId } = await cli("stage", "claim", id, "--agent", "Codex", "--session", "thread");
  const question = await cli("ask", id, "需要对比哪些版本？", "--id", "ask-1", "--claim", claimId);
  assert.equal(
    (await post(`/api/zoom/tasks/${id}/replies`, { questionId: question.id, body: "最近两版" }, { cookie })).status,
    200,
  );
  assert.equal((await cli("replies", id)).events[0].body, "最近两版");
  await cli(
    "done",
    id,
    "已汇总两版反馈",
    "--claim",
    claimId,
    "--evidence",
    "review-v1.md",
    "--evidence",
    "review-v2.md",
  );
  const current = await cli("stage", "show", id);
  assert.equal(current.work.status, "completed");
  assert.equal(current.messages.length, 5);
  assert.deepEqual(current.work.evidence, ["review-v1.md", "review-v2.md"]);
});
