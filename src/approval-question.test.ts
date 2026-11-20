import assert from "node:assert/strict";
import test from "node:test";
import { requiresHumanApproval } from "./approval-question.ts";

test("显式标记优先，旧消息中的直接授权请求只可代拟建议", () => {
  assert.equal(requiresHumanApproval({ kind: "question", body: "按 A 办？", requiresApproval: true }), true);
  for (const body of [
    "请批准本次发布",
    "可以直接上线吗？",
    "草稿已备好，需要你正式批准。",
    "请确认是否发布。",
    "是否授权我越过原有权限限制？",
    "申请临时管理员权限",
    "先解释回滚流程。是否可以部署到生产？",
    "能给我发布权限吗？",
    "审批请求：部署版本 2",
    "Do we have your permission to publish?",
    "Can I deploy this to production?",
    "Please approve the release.",
    "We need your explicit approval before granting access.",
    "Would you authorize the exception?",
  ]) {
    assert.equal(requiresHumanApproval({ kind: "question", body }), true, body);
  }
});

test("流程咨询、权限状态、历史决定及普通问题可以由 agent 回答", () => {
  for (const body of [
    "解释审批流程",
    "请说明如何申请临时管理员权限。",
    "这个版本由谁负责审批？",
    "请确认上线时间。",
    "哪些版本已经批准发布？",
    "请解释是否可以部署到生产的判断规则。",
    "发布之后的客户数是多少？",
    "What is the release approval process?",
    "Please explain how I can request your authorization.",
    "Can you describe who grants permission for a release?",
    "How many PRs did you approve yesterday?",
    "My changes were approved. What is the status of the release?",
    "还原现场需要什么日志？",
  ]) {
    assert.equal(requiresHumanApproval({ kind: "question", body }), false, body);
  }
  assert.equal(requiresHumanApproval({ kind: "progress", body: "请批准发布" }), false);
});
