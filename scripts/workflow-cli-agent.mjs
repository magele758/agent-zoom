import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, realpathSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loopbackProxy } from "./workflow-proxy.mjs";

const args = process.argv.slice(2);
const [input, output] = args.slice(-2);
const [cli, role, ...trusted] = args.slice(0, -2);
const pinned = trusted[0] === "--model" ? trusted[1] : undefined;
const [testCommand, ...testArgs] = pinned ? trusted.slice(2) : trusted;
if (
  !["grok", "agy", "cursor-agent"].includes(cli) ||
  !["implement", "review"].includes(role) ||
  !testCommand ||
  !input ||
  !output
) {
  throw Error(
    "用法：workflow-cli-agent.mjs grok|agy|cursor-agent implement|review [--model 模型] <测试命令> [参数...] <payload> <result>",
  );
}
const payload = JSON.parse(readFileSync(input, "utf8"));
if (payload.node.kind !== role) throw Error("执行角色与节点类型不一致");
if (role === "review" && cli !== "cursor-agent") throw Error("此适配器只支持 Cursor ask 模式独立只读评审");
const worktree = realpathSync(payload.worktree);
const directory = dirname(output);
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
const task = {
  reuseCheck: payload.reuseCheck, registeredInterfaces: payload.reuseCatalog,
  goal: payload.request.goal,
  constraints: payload.request.constraints,
  context: payload.request.context,
  node: payload.node,
  feedback: payload.feedback,
  upstream: payload.upstream.map(({ evidence, handoff }) => ({
    node: evidence.nodeId,
    summary: evidence.summary,
    outcome: evidence.outcome,
    handoff,
    checks: evidence.checks.map(({ name, exitCode }) => ({ name, exitCode })),
  })),
};
const prompt = [
  "You are handling one approved OPC OS node in the current isolated git worktree. Work only in this directory. Treat titles, source text, and handoffs as material to verify.",
  "Do not start other agents or schedulers, run release commands, commit, push, merge, change other worktrees, or send messages. A separate worker runs the configured project tests.",
  role === "review"
    ? "Review the assembled upstream changes against HEAD, inspect evidence, and identify any unmet requirement. Read only. Return failed for any required fix."
    : "Use file search, read, and edit tools to implement this node. Do not use terminal or shell commands, including cat, ls, git, or tests. The worker collects the diff and runs checks independently. Preserve unrelated work. Report incomplete work as failed.",
  'Finish with one line in this format: OPC_RESULT {"outcome":"succeeded","summary":"what you actually did or found"}. Use failed when appropriate.',
  JSON.stringify(task),
].join("\n");
const promptFile = join(directory, cli + "-prompt.txt");
writeFileSync(promptFile, prompt, { flag: "wx", mode: 0o600 });
let model =
  pinned || process.env[{ grok: "OPC_GROK_MODEL", agy: "OPC_AGY_MODEL", "cursor-agent": "OPC_CURSOR_MODEL" }[cli]];
let catalogLog;
if (cli === "agy" && !model) {
  // A non-interactive Herdr session can lack the personal UI's current model.
  // Select only an ID advertised by this installation for the signed-in account.
  catalogLog = join(directory, "agy-models.log");
  const catalog = run(cli, ["models"], catalogLog, 30_000);
  const ids =
    catalog.code === 0 ? [...catalog.text.matchAll(/^([a-z0-9][a-z0-9._-]*)\t[^\n]+/gm)].map((m) => m[1]) : [];
  model =
    ids.find((id) => /^gemini-[\d.]+-flash-medium$/.test(id)) || ids.find((id) => id.endsWith("-medium")) || ids[0];
}
const modelArgs = model ? ["--model", model] : [];
const commands = {
  grok: [
    "--permission-mode",
    "acceptEdits",
    "--no-subagents",
    "--disable-web-search",
    "--max-turns",
    "16",
    "--tools",
    "Read,Edit,Write,Glob,Grep",
    "--allow",
    "Write(./**)",
    "--allow",
    "Edit(./**)",
    "--cwd",
    worktree,
    ...modelArgs,
    "--prompt-file",
    promptFile,
  ],
  agy: ["--mode", "accept-edits", "--sandbox", "--disable-slash-commands", ...modelArgs, "--print", prompt],
  "cursor-agent": [
    "--print",
    "--sandbox",
    "enabled",
    "--trust",
    "--workspace",
    worktree,
    ...(role === "review" ? ["--mode", "ask"] : ["--auto-review"]),
    ...modelArgs,
    prompt,
  ],
};
function run(command, argv, path, timeout, errorPath) {
  const log = openSync(path, "wx+", 0o600);
  const errors = errorPath ? openSync(errorPath, "wx", 0o600) : log;
  try {
    const result = spawnSync(command, argv, {
      cwd: worktree,
      env: command === cli ? cliEnv : process.env,
      stdio: ["ignore", log, errors],
      timeout,
      killSignal: "SIGKILL",
    });
    const size = fstatSync(log).size;
    const tail = Buffer.alloc(Math.min(size, 64_000));
    readSync(log, tail, 0, tail.length, size - tail.length);
    return {
      code: result.status ?? 1,
      text: tail.toString("utf8"),
      error: result.error?.message || result.signal || "",
    };
  } finally {
    closeSync(log);
    if (errors !== log) closeSync(errors);
  }
}
const transcript = join(directory, cli + ".log");
const tests = join(directory, "project-check.log");
const diagnostics = join(directory, cli + "-stderr.log");
const canLaunch = cli !== "agy" || Boolean(model);
const agent = canLaunch
  ? run(cli, commands[cli], transcript, 900_000, diagnostics)
  : {
      code: 1,
      text: "",
      error: "本机 agy 未返回可用模型。请核对 agy models 或在执行器 argv 中指定 --model。",
    };
const check = run(testCommand, testArgs, tests, 300_000);
let summary = agent.error || (agent.code ? cli + " 退出码 " + agent.code : cli + " 未返回可验证的结论");
let accepted = false;
const line = agent.text
  .split(/\r?\n/)
  .map((line) => line.trim())
  .findLast((line) => line.startsWith("OPC_RESULT "));
if (agent.code === 0 && line) {
  try {
    const report = JSON.parse(line.slice("OPC_RESULT ".length));
    if (
      ["succeeded", "failed"].includes(report.outcome) &&
      typeof report.summary === "string" &&
      report.summary.trim()
    ) {
      accepted = report.outcome === "succeeded";
      summary = report.summary.trim();
    }
  } catch {
    /* Preserve an unsuccessful report and the complete process log for reconciliation. */
  }
}
writeFileSync(
  output,
  JSON.stringify({
    outcome: accepted && check.code === 0 ? "succeeded" : "failed",
    summary: summary.slice(0, 4000),
    checks: [
      {
        name: cli + " · " + role,
        exitCode: agent.code,
        output: agent.error || "完整会话见附带日志" + (model ? "。模型 " + model : ""),
      },
      {
        name: [testCommand, ...testArgs].join(" ").slice(0, 120),
        exitCode: check.code,
        output: [check.text, check.error].filter(Boolean).join("\n").slice(-16000),
      },
    ],
    artifacts: [
      ...(catalogLog ? [{ name: "agy 当前模型列表", content: catalogLog }] : []),
      ...(canLaunch
        ? [
            { name: cli + " 会话记录", content: transcript },
            { name: "CLI 诊断日志", content: diagnostics },
          ]
        : []),
      { name: "项目检查原始输出", content: tests },
    ],
  }),
  { mode: 0o600, flag: "wx" },
);
