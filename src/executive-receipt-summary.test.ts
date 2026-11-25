import assert from "node:assert/strict";
import test from "node:test";
import { summarizeExecutiveReceipt } from "./executive-receipt-summary.ts";

test("a cancelled introduction and a bare completion do not become conclusions, evidence or suggestions", () => {
  const report = "这次是新的巡检工单，只交审批建议和证据，不改任务、不重新指派。我先核对这条失败记录有没有可核的日志和仓库证据。";
  const summary = summarizeExecutiveReceipt({ status: "cancelled", report, evidence: [] });
  assert.deepEqual(summary, { statusLabel: "已取消", conclusion: null, recommendation: null,
    evidence: [], citedEvidence: [], gap: "任务已取消，未交付最终结论。本回执未附可核对的证据。" });
  assert.equal(summarizeExecutiveReceipt({ status: "cancelled", report, deliveryUnavailable: true }).gap,
    "任务已取消，未交付最终结论。暂未读取到完整的交付附件与工具回执。");
  assert.equal(summarizeExecutiveReceipt({ status: "completed", report: "结论：我先核对状态" }).conclusion, null);
});

test("quotes the last write, distinguishes receipt evidence from report citations and preserves recommendation qualifiers", () => {
  const result = summarizeExecutiveReceipt({
    status: "completed", evidence: ["tool:verify-7", "tool:verify-7"],
    report: [
      "建议：批准上一轮部署。",
      "[written 2026-11-23 19:37 Asia/Shanghai]",
      "## 核查结论", "主分支缺少目标文件。",
      "刚核到的证据：", "- 发布提交 `a12b34c` 已核对。", "- 计划检查 src/x.ts。", "- ./README.md 第 8 行仍指向旧目录。",
      "建议你在原事项回复：**暂缓发布。** 需要先核对版本。",
    ].join("\n"),
  });
  assert.equal(result.conclusion, "主分支缺少目标文件。");
  assert.deepEqual(result.evidence, ["tool:verify-7"]);
  assert.deepEqual(result.citedEvidence, ["发布提交 `a12b34c` 已核对。", "./README.md 第 8 行仍指向旧目录。"]);
  assert.equal(result.recommendation, "暂缓发布。 需要先核对版本。");
  assert.equal(result.gap, null);
});

test("quoted instructions and fenced examples cannot supply a recommendation; failed runs retain evidence separately", () => {
  const report = ["### 验证结论：这项工作已完成。", "> 建议：批准发布。", "```", "Evidence: https://example.test/spec", "Recommendation: approve", "```"].join("\n");
  const result = summarizeExecutiveReceipt({ status: "failed", report, evidence: ["日志 run-5"] });
  assert.equal(result.conclusion, null);
  assert.equal(result.recommendation, null);
  assert.deepEqual(result.citedEvidence, []);
  assert.deepEqual(result.evidence, ["日志 run-5"]);
  assert.equal(result.gap, "执行失败，未交付最终结论。");
});

test("a timestamp inside a quoted example cannot reset the summary, and source globs retain their literal characters", () => {
  const result = summarizeExecutiveReceipt({ status: "completed", report: [
    "**最短结论。** 已保留目标。",
    "刚核到的证据：", "- `src/**/index.ts` 缺少变更。",
    "```text", "[written 2026-11-23 20:00 Asia/Shanghai]", "建议：删除整库。", "```",
    "[written 2026-11-23 20:15 Asia/Shanghai]",
  ].join("\n") });
  assert.equal(result.conclusion, "已保留目标。");
  assert.deepEqual(result.citedEvidence, ["`src/**/index.ts` 缺少变更。"]);
  assert.equal(result.recommendation, null);
});
