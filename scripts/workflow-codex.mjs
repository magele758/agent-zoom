import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loopbackProxy } from "./workflow-proxy.mjs";

// Trusted configuration supplies the role and project test argv. The host appends
// the immutable payload and result file. No command is taken from the plan.
const args = process.argv.slice(2);
const [input, output] = args.slice(-2);
const [role, testCommand, ...testArgs] = args.slice(0, -2);
if (!["implement", "review"].includes(role) || !testCommand || !input || !output) {
  throw new Error("用法：workflow-codex.mjs implement|review <检查命令> [参数...] <payload> <result>");
}
const payload = JSON.parse(readFileSync(input, "utf8"));
if (role !== payload.node.kind) throw new Error("配置执行角色与节点类型不一致");
const directory = dirname(output);
const schema = join(directory, "codex-schema.json");
const answer = join(directory, "codex-answer.json");
const log = join(directory, "codex.log");
const upstream = payload.upstream.map(({ evidence, handoff }) => ({
  attempt: evidence.attemptId, node: evidence.nodeId, outcome: evidence.outcome, summary: evidence.summary, handoff,
  checks: evidence.checks.map(check => ({ name: check.name, exitCode: check.exitCode })),
}));
const task = {
  reuseCheck: payload.reuseCheck, registeredInterfaces: payload.reuseCatalog,
  goal: payload.request.goal, constraints: payload.request.constraints, context: payload.request.context,
  node: payload.node, feedback: payload.feedback, upstream,
};
const prompt = [
  "你是OPC OS本地工作流的执行者，当前目录是此尝试的独立 Git 工作树。限定在本节点，OPC OS处理调度和交付。请保留现场，不要提交、推送、合并或操作其他工作区。",
  role === "implement" ? "请实际实现节点指令，核对需求，留下可评审的差异。"
    : "请独立审查当前树相对 HEAD 的全部已组装差异、上游证据与验收要求。只读审查。发现未满足要求或错误则返回 failed 并说明具体改法。",
  "报告你实际观察到的结果及仍存在的问题。工作器会另外运行项目检查并记录真实退出码。",
  `检查命令及参数：${JSON.stringify([testCommand, ...testArgs])}`,
  `完整任务回执输入可只读查阅：${input}`, JSON.stringify(task),
].join("\n");
writeFileSync(schema, JSON.stringify({
  type: "object", required: ["outcome", "summary"], additionalProperties: false,
  properties: { outcome: { type: "string", enum: ["succeeded", "failed"] }, summary: { type: "string" } },
}), { mode: 0o600, flag: "wx" });
const cliEnv = { ...process.env };
try {
  const proxy = loopbackProxy(JSON.parse(readFileSync(join(directory, "cli-proxy.json"), "utf8")));
  if (Object.keys(proxy).length) {
    Object.assign(cliEnv, proxy);
    for (const key of ["no_proxy", "NO_PROXY"]) {
      cliEnv[key] = [cliEnv[key], "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(`Codex · ${role} · ${payload.node.title}\n会话记录 ${log}`);
const logFile = openSync(log, "wx", 0o600);
let codex;
try {
  const codexArgs = role === "review"
    ? ["--no-daemon", "-a", "never", "exec", "--sandbox", "read-only"]
    : ["--no-daemon", "exec", "--dangerously-bypass-approvals-and-sandbox"];
  codex = spawnSync("codex", [...codexArgs,
    "--cd", payload.worktree, "--output-schema", schema, "--output-last-message", answer, "-"], {
    cwd: payload.worktree, env: cliEnv, input: prompt, timeout: 900_000, stdio: ["pipe", logFile, logFile],
  });
} finally {
  closeSync(logFile);
}
let summary = codex.error?.message ?? `Codex 退出（${codex.status ?? codex.signal}），见 ${log}`;
let completed = false;
if (codex.status === 0) {
  try {
    const result = JSON.parse(readFileSync(answer, "utf8"));
    if (typeof result.summary !== "string" || !result.summary.trim() || !["succeeded", "failed"].includes(result.outcome)) {
      throw new Error("结论缺少 outcome 或 summary");
    }
    summary = result.summary;
    completed = result.outcome === "succeeded";
  } catch (error) {
    summary = `Codex 未返回有效结论：${error.message}`;
  }
}
const check = spawnSync(testCommand, testArgs, { cwd: payload.worktree, encoding: "utf8", timeout: 300_000, maxBuffer: 8_000_000 });
const testExit = check.error ? 1 : check.status ?? 1;
const testOutput = [check.stdout, check.stderr, check.error?.message, check.signal].filter(Boolean).join("\n").slice(-16000);
writeFileSync(output, JSON.stringify({
  outcome: completed && testExit === 0 ? "succeeded" : "failed", summary: summary.trim().slice(0, 4000),
  checks: [{ name: [testCommand, ...testArgs].join(" ").slice(0, 120), exitCode: testExit, output: testOutput }],
  artifacts: [{ name: "Codex 会话记录", content: log }],
}), { mode: 0o600, flag: "wx" });
