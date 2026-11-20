import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const path = process.argv[2];
const directory = dirname(path);
const payload = JSON.parse(readFileSync(path, "utf8"));
const writeAtomic = (name, value) => {
  const target = join(directory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
};

try {
  writeFileSync(join(directory, "claim"), "started\n", { mode: 0o600, flag: "wx" });
} catch (error) {
  if (error.code === "EEXIST") process.exit(0);
  throw error;
}
const host = finished => {
  if (payload.backend === "local-demo") writeAtomic("host.json", { pid: process.pid, finished });
};
host(false);
console.log(`OPC OS ${payload.node.title} · ${payload.attemptId}`);
console.log(`决策看板 ${payload.boardUrl}`);
console.log(`工作区 ${payload.worktree}`);

const results = join(directory, "result.json");
const label = z.string().trim().min(1).max(120);
const runnerReport = z.object({
  outcome: z.enum(["succeeded", "failed"]),
  summary: z.string().trim().min(1).max(4000),
  checks: z.array(z.object({ name: label, exitCode: z.int().min(0).max(255), output: z.string().max(16000) })).max(12),
  artifacts: z.array(z.object({ name: label, content: z.string().max(16000) })).max(12),
});
const git = (...args) => {
  const result = spawnSync("git", args, {
    encoding: "utf8", maxBuffer: 1_000_000, cwd: payload.worktree,
    env: { ...process.env, GIT_INDEX_FILE: join(directory, "evidence.index") },
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout;
};

let report;
let patch = "";
try {
  const [command, ...args] = payload.runner;
  const env = { ...process.env, HFLOW_WORKER: "1", KUNLUN_WORKFLOW_WORKER: "1", KUNLUN_BOARD_URL: payload.boardUrl };
  delete env.WORKFLOW_SUBMIT_TOKEN;
  const runner = spawnSync(command, [...args, path, results], { env, cwd: payload.worktree, stdio: "inherit" });
  if (runner.error) throw runner.error;
  if (statSync(results).size > 1_600_000) throw new Error("执行器结果文件过大");
  report = runnerReport.parse(JSON.parse(readFileSync(results, "utf8")));
  if (runner.status !== 0) {
    report.outcome = "failed";
    report.summary = `执行器退出（${runner.status ?? runner.signal}）。${report.summary}`.slice(0, 4000);
  }
  if (report.outcome === "succeeded" && (!report.checks.length || report.checks.some(check => check.exitCode !== 0))) {
    throw new Error("执行器宣告成功，但缺少通过的检查");
  }
} catch (error) {
  report = { outcome: "failed", summary: String(error.message ?? error).slice(0, 4000), checks: [], artifacts: [] };
}
try {
  const inputTree = payload.inputTree ?? payload.base;
  git("read-tree", inputTree);
  git("add", "-A", "--", ".");
  patch = git("diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", inputTree);
  if (patch.length > 256_000) throw new Error("差异超过回执上限");
  if (payload.node.kind === "review" && patch) throw new Error("评审执行器留下了工作树改动");
} catch (error) {
  report.outcome = "failed";
  report.summary = `${error.message ?? error}。所用工作树：${payload.worktree}。${report.summary}`.slice(0, 4000);
  if (patch.length > 256_000) patch = "";
} finally {
  writeAtomic("receipt.json", {
    runId: payload.runId, attemptId: payload.attemptId, nodeId: payload.node.id, revision: payload.revision,
    outcome: report.outcome, summary: report.summary, checks: report.checks, artifacts: report.artifacts, patch,
  });
  host(true);
}

if (payload.backend === "herdr" && process.stdin.isTTY && process.env.OPC_WORKER_NO_HOLD !== "1") {
  console.log(`\n${report.outcome} · ${report.summary}`);
  for (const check of report.checks) console.log(`  [${check.exitCode}] ${check.name}`);
  console.log(`\n决策看板 ${payload.boardUrl}\n按回车打开看板，输入 q 退出此 pane。`);
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const closeHold = () => lines.close();
  process.once("SIGTERM", closeHold);
  process.once("SIGINT", closeHold);
  process.once("SIGHUP", closeHold);
  lines.on("line", line => {
    if (line.trim() === "q") return lines.close();
    if (line.trim()) return;
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const result = spawnSync(opener, [payload.boardUrl], { encoding: "utf8" });
    if (result.status !== 0) console.log(`请在浏览器打开 ${payload.boardUrl}`);
  });
}
