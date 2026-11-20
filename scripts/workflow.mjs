import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const [command, ...args] = process.argv.slice(2);
const usage = `workflow goal <目标> --request-id <稳定标识> [--source <发起者>] [--context <原任务>] [--project 工作区绑定名] [--folder 项目/子目录] [--stage <阶段ID>] [--constraint <约束> ...]
workflow submit <file|-> | revise <run-id> <file|-> | status <run-id> | cleanup <run-id>
workflow feedback <run-id> [上次游标] [--wait] | list | board [run-id] [--open]`;
const path = file => file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
const runPath = id => `/api/workflows/${encodeURIComponent(id)}`;

function localUrl(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password) throw new Error("OPC OS地址需要使用本机 HTTP 服务");
  return url;
}

try {
  const base = localUrl(process.env.OPC_URL ?? process.env.KUNLUN_URL ?? "http://127.0.0.1:8791");
  if (!command || command === "--help" || command === "help") {
    console.log(usage);
  } else if (command === "board") {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { open: { type: "boolean" } } });
    const [id] = positionals;
    if (positionals.length > 1 || (id && !/^[a-f0-9-]{36}$/.test(id))) throw new Error(usage);
    const token = process.env.WORKFLOW_SUBMIT_TOKEN;
    let board = localUrl(process.env.KUNLUN_BOARD_URL ?? `${base.origin}/#workflows`);
    if (id && token) {
      const response = await fetch(new URL(runPath(id), base), { headers: { authorization: `Bearer ${token}` },
        redirect: "error", signal: AbortSignal.timeout(15_000) });
      const run = await response.json();
      if (!response.ok) throw new Error(run.message ?? `HTTP ${response.status}`);
      board = localUrl(run.boardUrl);
    } else if (id) {
      board.hash = `workflows/${id}`;
    }
    console.log(board.href);
    if (values.open) execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [board.href]);
  } else {
    let endpoint, body, waitForFeedback = false;
    if (command === "goal" || (command === "submit" && args.length === 1)) {
      if (process.env.KUNLUN_WORKFLOW_WORKER === "1" || process.env.HFLOW_WORKER === "1") {
        throw new Error("执行节点不能发起递归工作流");
      }
      endpoint = "/api/workflows";
      if (command === "goal") {
        const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
          "request-id": { type: "string" }, source: { type: "string", default: "cli" },
          project: { type: "string" }, context: { type: "string" }, folder: { type: "string" }, stage: { type: "string" }, constraint: { type: "string", multiple: true },
        } });
        if (positionals.length !== 1 || !values["request-id"]) throw new Error(usage);
        body = JSON.stringify({ version: 1, requestId: values["request-id"], source: values.source,
          context: values.context ?? values["request-id"], projectKey: values.project, folder: values.folder ?? values.project, stage: values.stage, goal: positionals[0], constraints: values.constraint ?? [] });
      } else {
        body = path(args[0]);
      }
    } else if (command === "status" && args.length === 1) {
      endpoint = runPath(args[0]);
    } else if (command === "cleanup" && args.length === 1) {
      endpoint = `${runPath(args[0])}/cleanup`;
      body = "{}";
    } else if (command === "revise" && args.length === 2) {
      endpoint = `${runPath(args[0])}/revisions`;
      body = path(args[1]);
    } else if (command === "list" && args.length === 0) {
      endpoint = "/api/workflows";
    } else if (command === "feedback") {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { wait: { type: "boolean" } } });
      if (positionals.length < 1 || positionals.length > 2) throw new Error(usage);
      waitForFeedback = Boolean(values.wait);
      endpoint = `${runPath(positionals[0])}/feedback?after=${encodeURIComponent(positionals[1] ?? "0")}`;
    } else {
      throw new Error(usage);
    }
    const token = process.env.WORKFLOW_SUBMIT_TOKEN;
    if (!token) throw new Error("请提供 WORKFLOW_SUBMIT_TOKEN");
    const url = new URL(endpoint, base);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body, redirect: "error", signal: AbortSignal.timeout(command === "goal" || command === "submit" ? 180_000 : 15_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
      if (!waitForFeedback || result.events.length || result.phase === "complete" || Date.now() >= deadline) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      url.searchParams.set("after", String(result.cursor));
      await delay(1000);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
