import assert from "node:assert/strict";
import test from "node:test";
import {
  composerPlaceholder,
  defaultKind,
  foldBody,
  pipelineOverview,
  shouldFold,
  stepSlots,
  stepsOf,
  type ViewTask,
} from "../web/src/view.ts";

function task(over: Partial<ViewTask>): ViewTask {
  return { id: "t", status: "open", claims: [], ...over };
}

const parent = task({ id: "p", mode: "pipeline", status: "working" });

function steps(): ViewTask[] {
  return [
    task({ id: "s0", pipelineId: "p", stepIndex: 0, stepRole: "research", status: "done", assigneeHandle: "antigravity", handles: ["antigravity"], claims: [{ role: "implementer", state: "completed", handle: "antigravity" }] }),
    task({ id: "s1", pipelineId: "p", stepIndex: 1, stepRole: "review", status: "open", handles: ["chatgpt", "grok"], conclusions: [{ handle: "chatgpt", verdict: "pass" }] }),
    task({ id: "s2", pipelineId: "p", stepIndex: 2, stepRole: "product", status: "blocked", handles: ["chatgpt"] }),
    task({ id: "s3", pipelineId: "p", stepIndex: 3, stepRole: "qa", status: "claimed", assigneeHandle: "grok", handles: ["grok"], claims: [{ role: "implementer", state: "active", handle: "grok" }] }),
  ];
}

test("pipeline step cards show the step and its owner, never implement/review/test slots", () => {
  const all = [parent, ...steps()];
  const list = stepsOf("p", all);
  assert.deepEqual(list.map((item) => item.id), ["s0", "s1", "s2", "s3"]);
  const qa = stepSlots(list[3], list);
  assert.deepEqual(qa, [
    { label: "步骤", value: "QA · 第 4/4 步", held: true },
    { label: "负责人", value: "grok", held: true },
  ]);
  const review = stepSlots(list[1], list);
  assert.equal(review[1].label, "复核人");
  assert.equal(review[1].value, "chatgpt 通过、grok 待交");
  const waiting = stepSlots(list[2], list);
  assert.equal(waiting[1].value, "chatgpt（等上一步）");
  assert.equal(waiting[1].held, false);
  assert.equal(stepSlots(list[0], list)[1].value, "antigravity");
  for (const slots of [qa, review, waiting]) {
    assert.equal(slots.some((slot) => ["实现", "评审", "测试"].includes(slot.label)), false);
  }
});

test("the pipeline summary card names the current step and each owner", () => {
  const view = pipelineOverview(parent, steps());
  assert.equal(view.where, "当前：复核");
  assert.deepEqual(view.rows.map((row) => `${row.label}:${row.state}`), ["研究:done", "复核:now", "产品:", "QA:"]);
  assert.equal(view.rows[1].owner, "chatgpt 通过、grok 待交");
  assert.equal(view.rows[1].status, "复核中");
  assert.equal(view.rows[2].owner, "chatgpt");
  assert.equal(view.rows[2].status, "等待");
  const done = pipelineOverview({ ...parent, status: "done" }, steps().map((step) => ({ ...step, status: "done" })));
  assert.equal(done.where, "已做完");
  assert.equal(done.rows.every((row) => row.state === "done"), true);
  assert.equal(done.rows[1].owner, "chatgpt 通过、grok 未接入");
});

test("long agent output folds to a short head, human and instruction text does not", () => {
  const long = Array.from({ length: 12 }, (_, index) => `第 ${index} 行`).join("\n");
  const folded = foldBody(long);
  assert.equal(folded.long, true);
  assert.equal(folded.head.split("\n").length, 3);
  assert.ok(folded.head.endsWith("…"));
  assert.equal(foldBody("短").long, false);
  assert.equal(foldBody("一".repeat(500)).long, true);
  assert.equal(shouldFold("agent", "deliverable", long), true);
  assert.equal(shouldFold("agent", "deliverable", "短交付"), false);
  assert.equal(shouldFold("user", "chat", long), false);
  assert.equal(shouldFold("agent", "instruction", long), false);
});

test("the composer opens on chat, and question differs from chat in its hint", () => {
  assert.equal(defaultKind(false), "chat");
  assert.equal(defaultKind(true), "question");
  const chat = composerPlaceholder("chat", false);
  const question = composerPlaceholder("question", false);
  const instruction = composerPlaceholder("instruction", false);
  assert.equal(new Set([chat, question, instruction]).size, 3);
  assert.match(question, /问/);
  assert.match(composerPlaceholder("question", true), /私聊/);
});
