#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { readGithubRepository } from "./zoom-github.mjs";
import { runCapabilities } from "./opc-capabilities.mjs";
import { runCommercial } from "./opc-commercial.mjs";
import { runSources } from "./opc-sources.mjs";

const [command, ...args] = process.argv.slice(2);
const usage = `opc-os connect <submit.env>
opc-os inbox [--open]
opc-os start <目标> --source <agent> --task <原任务稳定标识> [--folder 项目/子目录] [--stage <阶段ID>] [--context <原会话>]
opc-os update <任务ID> <进展> [--id <事件标识>]
opc-os ask <任务ID> <问题> --id <问题版本> [--approval] [--choice <选项> ...] [--wait]
opc-os replies <任务ID> [上次游标] [--question <消息ID>] [--wait] [--timeout <秒>]
opc-os done <任务ID> <结果及证据> [--id <事件标识>]
opc-os growth record <JSON文件|->
opc-os growth report <产品>
opc-os business list | business trial <业务线ID> <JSON文件|-> | business evidence <实验ID> <JSON文件|-> | business review <实验ID>
opc-os commercial overview | bootstrap | ensure | closed-loop | sync-analytics | playbook <模板ID>
opc-os capability discover|list|requests|show|import|request|revise|adopt|help
opc-os opportunity add <JSON文件|-> | list [--project 产品/项目]
opc-os sources github|daily|help
opc-os project add <产品> | project list | project sync <owner/repo> [--product 产品]
opc-os stage list [--agent 执行者] [--wait --timeout 秒数] [--product 产品] [--project 项目] [--stage 阶段] [--via coding-agent|agent-home] [--status 状态]
opc-os stage show <任务ID>
opc-os stage claim <任务ID> --agent <执行者> --session <稳定会话ID> [--via coding-agent|agent-home]
opc-os stage renew <任务ID> --claim <claimId> | stage release <任务ID> --claim <claimId> --reason <原因>
阶段任务的 update / ask / done 附 --claim <claimId>；done 附一个或多个 --evidence <交付物或证据引用>。
opc-os goal <目标> --request-id <标识> [--source <agent>] [--project 工作区绑定名] [--folder 项目/子目录] [--stage <阶段ID>] [--constraint <约束> ...]
opc-os submit <草案文件|-> | revise <运行ID> <修订文件|-> | status <运行ID> | cleanup <运行ID>
opc-os feedback <运行ID> [游标] [--wait] | board [运行ID] [--open]
start 登记由当前宿主调度的任务。goal / submit 交由OPC OS调度。报告正文可用 - 从标准输入读取。`;
const configFile = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kunlun", "zoom.json");
const workflowCli = fileURLToPath(new URL("./workflow.mjs", import.meta.url));
const workflowCommands = new Set(["goal", "submit", "revise", "status", "feedback", "board", "list", "cleanup"]);
const string = { type: "string" };
const waitOptions = { wait: { type: "boolean" }, timeout: string };

function localOrigin(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Zoom 连接需要本机 HTTP 服务地址");
  }
  return url.origin;
}

function fileConnection(file) {
  const env = parseEnv(readFileSync(file, "utf8"));
  if (!env.WORKFLOW_SUBMIT_TOKEN) throw new Error("连接文件缺少 WORKFLOW_SUBMIT_TOKEN");
  return { origin: localOrigin(env.OPC_URL || env.KUNLUN_URL || "http://127.0.0.1:8791"), token: env.WORKFLOW_SUBMIT_TOKEN };
}

function connection() {
  const envOrigin = process.env.OPC_URL || process.env.KUNLUN_URL;
  if (process.env.WORKFLOW_SUBMIT_TOKEN) {
    return { origin: localOrigin(envOrigin || "http://127.0.0.1:8791"), token: process.env.WORKFLOW_SUBMIT_TOKEN };
  }
  let saved;
  try {
    saved = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("先运行 opc-os connect <submit.env> 连接本机 Zoom");
    throw error;
  }
  const connected = fileConnection(saved.connectionFile);
  if (envOrigin && connected.origin !== localOrigin(envOrigin)) {
    throw new Error("OPC_URL / KUNLUN_URL 与已连接的 Zoom 服务不同，请选择对应的 submit.env");
  }
  return connected;
}

function connect(file) {
  const absolute = resolve(file);
  const { origin } = fileConnection(absolute);
  mkdirSync(dirname(configFile), { mode: 0o700, recursive: true });
  const tmp = configFile + "." + randomUUID();
  try {
    writeFileSync(tmp, JSON.stringify({ connectionFile: absolute }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, configFile);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { origin, connectionFile: absolute };
}

async function request(client, path, payload) {
  const response = await fetch(new URL(path, client.origin), {
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
  return data;
}

function options(definitions, min, max = min) {
  const result = parseArgs({ args, options: definitions, allowPositionals: true });
  if (result.positionals.length < min || result.positionals.length > max) throw new Error(usage);
  return result;
}

function content(value) {
  const text = value === "-" ? readFileSync(0, "utf8").trim() : value.trim();
  if (!text) throw new Error("请提供内容");
  return text;
}

function projectFolder() {
  try {
    return basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || "未归类";
  } catch {
    return basename(process.cwd()) || "未归类";
  }
}

function integer(raw, name) {
  const parsed = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(parsed)) throw new Error(`${name} 需要非负整数`);
  return parsed;
}

async function replies(client, task, after, question, wait, timeout) {
  let cursor = integer(after, "游标");
  const end = Date.now() + integer(timeout || 60, "等待秒数") * 1000;
  for (;;) {
    const path = `/api/zoom/tasks/${encodeURIComponent(task)}/feedback?after=${cursor}`;
    const batch = await request(client, path);
    const events = question ? batch.events.filter(event => event.questionId === question) : batch.events;
    if (events.length) return { ...batch, events };
    if (question && batch.events.length && batch.cursor > cursor) {
      cursor = batch.cursor;
      continue;
    }
    if (batch.completed || !wait || Date.now() >= end) return { ...batch, events };
    cursor = batch.cursor;
    await delay(Math.min(650, Math.max(0, end - Date.now())));
  }
}

async function run() {
  if (!command || command === "help" || command === "--help") return console.log(usage);
  if (command === "connect") {
    const { positionals: [file] } = options({}, 1);
    return connect(file);
  }
  if (command === "capability") {
    let client;
    return runCapabilities(args,(path,payload)=>request(client ??= connection(),path,payload));
  }
  if (command === "commercial") {
    let client;
    return runCommercial(args, (path, payload) => request((client ??= connection()), path, payload));
  }
  if (command === "sources") {
    let connected;
    return runSources(args, { request: (path, payload) => {
      connected ??= connection();
      return request(connected, path, payload);
    } });
  }
  const client = connection();
  if (command === "opportunity") {
    const {positionals:[action,file],values} = options({project:string},1,2);
    const endpoint = "/api/opc/opportunities";
    if (action === "list" && !file) return request(client, endpoint + (values.project ? "?" + new URLSearchParams({project:values.project}) : ""));
    if (action === "add" && file && !values.project) return request(client, endpoint, JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")));
    throw new Error(usage);
  }
  if (command === "business") {
    const { positionals: [action, id, file] } = options({}, 1, 3);
    const base = "/api/opc/business";
    if (action === "list" && !id) return request(client, base + "/lines");
    if (!id) throw new Error(usage);
    const target = encodeURIComponent(id);
    if (action === "review" && !file) return request(client, base + "/trials/" + target + "/review", {});
    if (!file || !["trial", "evidence"].includes(action)) throw new Error(usage);
    const payload = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
    const path = action === "trial" ? "/lines/" + target + "/trials" : "/trials/" + target + "/evidence";
    return request(client, base + path, payload);
  }
  if (command === "stage") {
    const { positionals: [action, id], values } = options({
      product: string, project: string, "company-item": string, stage: string, via: string, status: string, agent: string, session: string, claim: string, reason: string, ...waitOptions,
    }, 1, 2);
    const base = "/api/zoom/stage-work";
    if (action === "list" && !id) {
      const filters = new URLSearchParams();
      for (const name of ["product", "project", "stage", "status"]) if (values[name] !== undefined) filters.set(name, values[name]);
      if (values.via) filters.set("target", values.via);
      if (values.agent) filters.set("requestedAgent", values.agent);
      if (values["company-item"]) filters.set("companyItemId", values["company-item"]);
      if (values.wait && !values.agent) throw new Error("等待认领需要用 --agent 指定接收者");
      if (values.wait && !values.status) filters.set("status","open");
      const until = Date.now() + integer(values.timeout ?? "60","等待秒数") * 1000;
      for (;;) {
        const result = await request(client, base + "?" + filters);
        if (!values.wait || result.items.length || Date.now() >= until) return result;
        await delay(Math.min(2000, Math.max(0, until-Date.now())));
      }
    }
    if (!id) throw new Error(usage);
    const path = base + "/" + encodeURIComponent(id);
    if (action === "show") return request(client, path);
    if (action === "claim" && values.agent && values.session) {
      return request(client,path + "/claim",{agent:values.agent,session:values.session,via:values.via});
    }
    if (action === "renew" && values.claim) return request(client,path + "/renew",{claimId:values.claim});
    if (action === "release" && values.claim && values.reason) return request(client,path + "/release",{claimId:values.claim,reason:values.reason});
    throw new Error(usage);
  }
  if (command === "project") {
    const { positionals: [action, value], values } = options({ product: string }, 1, 2);
    if (action === "list" && !value && values.product === undefined) return request(client, "/api/zoom/projects");
    if (action === "add" && value && values.product === undefined) return request(client, "/api/zoom/projects", { name: value });
    if (action === "sync" && value) {
      const repository = await readGithubRepository(value);
      return request(client, "/api/zoom/projects/sync", { name: values.product ?? repository.fullName.split("/")[1], repository });
    }
    throw new Error(usage);
  }
  if (command === "growth") {
    const { positionals: [operation, value] } = options({}, 2);
    if (operation === "report") return request(client, "/api/zoom/growth?" + new URLSearchParams({ product: value }));
    if (operation !== "record") throw new Error(usage);
    const records = JSON.parse(readFileSync(value === "-" ? 0 : value, "utf8"));
    const endpoint = "/api/zoom/growth/events";
    if (!Array.isArray(records)) {
      if (!records || typeof records !== "object") throw new Error("请提供增长事件对象或事件数组");
      return request(client, endpoint, records);
    }
    if (!records.length) throw new Error("增长事件数组为空");
    const results = [];
    for (const [index, record] of records.entries()) {
      try {
        const { event, created } = await request(client, endpoint, record);
        results.push({ product: event.product, eventId: event.eventId, created });
      } catch (error) {
        process.exitCode = 1;
        return { results, failed: { index, eventId: record?.eventId, message: error.message }, remaining: records.length - index - 1 };
      }
    }
    return { results };
  }
  if (command === "inbox") {
    const { values } = options({ open: { type: "boolean" } }, 0);
    const url = new URL("/#inbox", client.origin).href;
    if (values.open) execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    return { url };
  }
  if (workflowCommands.has(command)) {
    const child = spawnSync(process.execPath, [workflowCli, command, ...args], {
      cwd: process.cwd(), stdio: "inherit",
      env: { ...process.env, KUNLUN_URL: client.origin, WORKFLOW_SUBMIT_TOKEN: client.token },
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  if (command === "start") {
    const { values, positionals: [title] } = options({ source: string, task: string, context: string, folder: string, project: string, stage: string }, 1);
    if (!values.source || !values.task) throw new Error("start 需要 --source 和 --task，重试同一任务时沿用相同值");
    if (values.folder && values.project && values.folder !== values.project) {
      throw new Error("start 的 --folder 和 --project 不能指定不同目录");
    }
    return request(client, "/api/zoom/tasks", {
      title: content(title), source: values.source, externalId: values.task, folder: values.folder ?? values.project ?? projectFolder(),
      context: values.context || values.task, stage: values.stage,
    });
  }
  if (command === "replies") {
    const { values, positionals: [task, after = "0"] } = options({ question: string, ...waitOptions }, 1, 2);
    return replies(client, task, after, values.question, values.wait, values.timeout);
  }
  const kinds = { update: "progress", ask: "question", done: "completed" };
  if (!Object.hasOwn(kinds, command)) throw new Error(usage);
  const ask = command === "ask";
  const extra = ask ? { approval: { type: "boolean" }, choice: { type: "string", multiple: true }, ...waitOptions } : {};
  const { values, positionals: [task, value] } = options({ id: string, claim: string, evidence: { type: "string", multiple: true }, ...extra }, 2);
  if (ask && !values.id) throw new Error("ask 需要 --id；修改问题或计划时使用新版本标识");
  const body = content(value);
  const eventId = values.id || command + "-" + createHash("sha256").update(body).digest("hex");
  const message = await request(client, `/api/zoom/tasks/${encodeURIComponent(task)}/messages`, {
    eventId, kind: kinds[command], body, claimId: values.claim, evidence: values.evidence, ...(values.choice ? { choices: values.choice } : {}),
    requiresApproval: values.approval,
  });
  if (ask && values.wait) return { message, feedback: await replies(client, task, 0, message.id, true, values.timeout) };
  return message;
}

try {
  const result = await run();
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
