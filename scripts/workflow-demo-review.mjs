import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [, , input, output] = process.argv;
const payload = JSON.parse(readFileSync(input, "utf8"));
const sources = payload.upstream.filter(item => item.evidence.outcome === "succeeded" && item.evidence.nodeId !== payload.node.id);
const independent = sources.length > 0 && sources.every(({ evidence, worktree }) =>
  worktree !== payload.worktree && evidence.runId === payload.runId &&
  evidence.attemptId !== payload.attemptId && evidence.checks.length > 0 && evidence.checks.every(check => check.exitCode === 0));
const check = spawnSync(process.execPath, ["--test", "greeting.test.mjs"], { encoding: "utf8", cwd: payload.worktree });
const checks = [
  { name: "全部上游成功证据来源与检查", exitCode: independent ? 0 : 1, output: sources.map(item => item.evidence.attemptId).join("\n") },
  { name: "node --test greeting.test.mjs · 独立工作树复测", exitCode: check.status ?? 1,
    output: (check.stdout + check.stderr).slice(-16000) },
];
const guide = sources.find(item => item.evidence.nodeId === "guide");
if (guide) checks.push({
  name: "并行实现的 GUIDE.md 已进入评审工作树",
  exitCode: existsSync("GUIDE.md") && guide.evidence.patch.includes("b/GUIDE.md") ? 0 : 1,
  output: guide.evidence.attemptId,
});
const valid = checks.every(check => check.exitCode === 0);
writeFileSync(output, JSON.stringify({
  outcome: valid ? "succeeded" : "failed",
  summary: valid ? "已核对上游回执并在独立工作树重跑测试" : "上游证据或独立复测未通过",
  checks,
  artifacts: [{ name: "评审的尝试", content: sources.map(item => item.evidence.attemptId).join("\n") }],
}));
