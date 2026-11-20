import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

const [, , input, output] = process.argv;
const payload = JSON.parse(readFileSync(input, "utf8"));
const retry = payload.feedback.some(event => event.kind === "retry" && event.nodeId === payload.node.id);
if (payload.node.id === "guide") {
  writeFileSync("GUIDE.md", "运行 node --test greeting.test.mjs 验证问候语。\n");
  const content = readFileSync("GUIDE.md", "utf8");
  const ok = content.includes("node --test greeting.test.mjs");
  writeFileSync(output, JSON.stringify({
    outcome: ok ? "succeeded" : "failed", summary: "已写入独立的使用说明",
    checks: [{ name: "检查说明中的测试命令", exitCode: ok ? 0 : 1, output: content }],
    artifacts: [{ name: "GUIDE.md", content }],
  }));
  process.exit(0);
}
const deliberateFailure = payload.request.constraints.includes("演示一次失败重试") && !retry;
if (deliberateFailure && payload.request.constraints.includes("等待演示继续信号")) {
  const marker = join(dirname(output), "continue");
  const deadline = Date.now() + 45_000;
  while (!existsSync(marker)) {
    if (Date.now() >= deadline) throw new Error("演示继续信号超时");
    await setTimeout(100);
  }
}
writeFileSync("greeting.txt", deliberateFailure ? "Hello there\n" : "Hello, OPC OS!\n");
const check = spawnSync(process.execPath, ["--test", "greeting.test.mjs"], { encoding: "utf8" });
writeFileSync(output, JSON.stringify({
  outcome: check.status === 0 ? "succeeded" : "failed",
  summary: check.status === 0 ? "已更新 greeting.txt，测试通过" : "问候语测试失败，等待人工安排重试",
  checks: [{ name: "node --test greeting.test.mjs", exitCode: check.status ?? 1, output: check.stdout ?? "" }],
  artifacts: [{ name: "greeting.txt", content: readFileSync("greeting.txt", "utf8") }],
}));
