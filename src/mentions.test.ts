import assert from "node:assert/strict";
import test from "node:test";
import { mentionAtCaret, mentionReach, settledMentions, splitMentions } from "../web/src/mentions.ts";

test("typing @ opens an empty query, and a prefix stays active", () => {
  assert.deepEqual(mentionAtCaret("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionAtCaret("你好 @cur", 7), { start: 3, query: "cur" });
  assert.equal(mentionAtCaret("email@cursor", 12), null);
  assert.equal(mentionAtCaret("@cursor ", 8), null);
});

test("a finished @ is settled, the one under the caret is not", () => {
  assert.deepEqual(settledMentions("@cursor 看一下 @cha", 16), ["cursor"]);
  assert.deepEqual(settledMentions("@Cursor @chatgpt ", 17), ["cursor", "chatgpt"]);
  assert.deepEqual(settledMentions("@nobody,", 8), ["nobody"]);
  assert.deepEqual(settledMentions("@cu", 3), []);
});

test("message text keeps the typed @ and marks the handle", () => {
  assert.deepEqual(splitMentions("请 @Cursor 看"), [
    { text: "请 ", handle: null },
    { text: "@Cursor", handle: "cursor" },
    { text: " 看", handle: null },
  ]);
});

test("reach: a hit narrows delivery, only strangers fall back to everyone", () => {
  const known = new Set(["cursor", "chatgpt"]);
  assert.deepEqual(mentionReach(["cursor"], known), { hit: ["cursor"], miss: [], everyone: false });
  assert.deepEqual(mentionReach(["cursor", "nope"], known), { hit: ["cursor"], miss: ["nope"], everyone: false });
  assert.deepEqual(mentionReach(["nope"], known), { hit: [], miss: ["nope"], everyone: true });
  assert.deepEqual(mentionReach([], known), { hit: [], miss: [], everyone: false });
});
