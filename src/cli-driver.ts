import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import type { AdapterTask, AdapterAction } from "./adapter.ts";

/** Use a real installed CLI; a zero exit status alone is never a delivery. */
export async function completeCli(task: AdapterTask, runtime: "codex" | "claude", options: { repoRoot?: string; timeoutMs?: number; outputRoot?: string; binary?: string; signal?: AbortSignal; replyOnly?: boolean } = {}): Promise<AdapterAction> {
  if (task.stepRole && task.stepRole !== "build") throw new Error("CLI 适配器目前只执行开发步；评审和 QA 请用独立客户端验证");
  const cwd = task.scope?.directories?.[0] || options.repoRoot;
  if (!cwd || !existsSync(cwd)) throw new Error("真实 CLI 任务需要存在的频道工作目录或 CLI_REPO_ROOT");
  const root = realpathSync(cwd);
  const runDir = resolve(options.outputRoot ?? "data/runs", task.id.replace(/[^a-zA-Z0-9-]/g, "_"), `${Date.now()}-${runtime}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const answer = join(runDir, "answer.txt");
  const prompt = `${options.replyOnly ? "这是聊天模式，只回答消息，可以读取相关文件；禁止修改文件、运行开发任务或调用 chatroom 工具。需要改代码请提醒用户使用发起任务。" : ""}你是 agent-chatroom 的真实 ${runtime} coding agent。只在工作目录 ${root} 内执行本任务，不要创建其他任务或子 agent。不要自己调用 chatroom 的 claim/deliver，适配器负责交付。\n标题：${task.title}\n要求：${task.body}\n验收：${task.acceptance ?? ""}\n请实际执行必要的文件操作或命令，以事实、结果文件和测试结果报告。未完成请明确说明，禁止编造成功。`;
  writeFileSync(join(runDir, "prompt.txt"), prompt, { mode: 0o600 });
  const args = runtime === "codex"
    ? ["exec", "--sandbox", options.replyOnly ? "read-only" : "workspace-write", "--json", "--output-last-message", answer, "-"]
    : ["--print", "--output-format", "json", "--permission-mode", options.replyOnly ? "plan" : "acceptEdits", prompt];
  const log = join(runDir, "events.log");
  let output = "";
  let errors = "";
  await new Promise<void>((done, fail) => {
    const child = spawn(options.binary ?? runtime, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let timedOut = false;
    const kill = () => { try { if (process.platform === "win32") child.kill("SIGKILL"); else if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {} };
    const stop = () => { timedOut = true; kill(); };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const timer = setTimeout(stop, options.timeoutMs ?? 15 * 60_000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 8_000_000) stop(); });
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-20_000); });
    const clean = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", stop); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); writeFileSync(log, output + "\n" + errors, { mode: 0o600 }); };
    child.once("error", (error) => { clean(); fail(error); });
    child.once("close", (code) => { clean(); if (timedOut) fail(new Error(`${runtime} 已终止（超时或停止），日志：${log}`)); else if (code !== 0) fail(new Error(`${runtime} 退出码 ${code}，日志：${log}`)); else done(); });
    child.stdin.on("error", () => {});
    child.stdin.end(runtime === "codex" ? prompt : undefined);
  });
  let body = "";
  if (runtime === "codex") body = existsSync(answer) ? readFileSync(answer, "utf8").trim() : "";
  else {
    const result = JSON.parse(output);
    if (result.is_error) throw new Error(`Claude 报告执行失败，日志：${log}`);
    body = String(result.result ?? "").trim();
    writeFileSync(answer, body, { mode: 0o600 });
  }
  if (!body) throw new Error(`${runtime} 没有可交付的正文，日志：${log}`);
  return { type: "deliver", ref: answer, summary: `${runtime} 执行报告已交付。`, body: body.slice(0, 32_000), screenshots: [] };
}
