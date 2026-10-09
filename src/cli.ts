import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ChatApi } from "./mcp.ts";
import { createMcpServer } from "./mcp.ts";

const credPath = process.env.AGENT_CHATROOM_CREDENTIALS ?? "data/credentials.json";

type Creds = { url: string; agents: Record<string, { token: string; roomId: string; runtime: string }> };

function readCreds(): Creds {
  if (!existsSync(credPath)) return { url: "http://127.0.0.1:8791", agents: {} };
  return JSON.parse(readFileSync(credPath, "utf8")) as Creds;
}

function writeCreds(creds: Creds) {
  mkdirSync(dirname(credPath), { recursive: true });
  writeFileSync(credPath, JSON.stringify(creds, null, 2));
}

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function enroll() {
  const url = (arg("--url") ?? process.env.AGENT_CHATROOM_URL ?? "http://127.0.0.1:8791").replace(/\/$/, "");
  const code = arg("--code");
  const handle = arg("--handle");
  const runtime = arg("--runtime") ?? "custom";
  const tags = arg("--tags") ?? "";
  const level = Number(arg("--level") ?? 1);
  const machine = arg("--machine") ?? hostname();
  const cwd = arg("--cwd") ?? process.cwd();
  if (!code || !handle) {
    console.error(
      "用法: npm run enroll -- --code join_xxx --handle codex --runtime codex --tags build --level 1 --machine 这台电脑 --cwd /path/to/repo",
    );
    process.exit(1);
  }
  const response = await fetch(`${url}/api/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, handle, runtime, tags, level, machine, cwd }),
  });
  const body = (await response.json()) as { token?: string; roomId?: string; message?: string; agent?: { level?: number } };
  if (!response.ok || !body.token || !body.roomId) {
    console.error(body.message ?? "接入失败");
    process.exit(1);
  }
  const creds = readCreds();
  creds.url = url;
  creds.agents[handle.toLowerCase()] = { token: body.token, roomId: body.roomId, runtime };
  writeCreds(creds);
  console.log(
    `已接入 ${handle}，等级 ${body.agent?.level ?? 1}${cwd ? `，目录 ${cwd}` : ""}${machine ? `，机器 ${machine}` : ""}。凭证写在 ${credPath}`,
  );
  console.log(`下一步: npm run mcp -- --handle ${handle.toLowerCase()}`);
}

function httpApi(url: string, token: string): ChatApi {
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? response.statusText);
    return body;
  };
  return {
    whoami: () => call("/api/agent/me"),
    listRooms: async () => (await call("/api/agent/me")).rooms,
    read: (roomId, afterSeq) => call(`/api/agent/rooms/${roomId}/messages?afterSeq=${afterSeq}`),
    say: (input) =>
      call(`/api/agent/rooms/${input.roomId}/messages`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    wait: async (after, timeoutMs) => (await call(`/api/wait?after=${after}&timeoutMs=${timeoutMs}`)).events,
    listTasks: (roomId) => call(`/api/agent/rooms/${roomId}/tasks`),
    getTask: (taskId) => call(`/api/agent/tasks/${taskId}`),
    claim: (taskId, role) => call(`/api/agent/tasks/${taskId}/claim`, { method: "POST", body: JSON.stringify({ role }) }),
    bid: (taskId, approach) =>
      call(`/api/agent/tasks/${taskId}/bid`, { method: "POST", body: JSON.stringify({ approach }) }),
    deliver: (taskId, ref, summary) =>
      call(`/api/agent/tasks/${taskId}/deliver`, { method: "POST", body: JSON.stringify({ ref, summary }) }),
    heartbeat: (taskId) => call(`/api/agent/tasks/${taskId}/heartbeat`, { method: "POST", body: "{}" }),
    ready: (taskId) => call(`/api/agent/tasks/${taskId}/ready`, { method: "POST", body: "{}" }),
    review: (taskId, verdict, body) =>
      call(`/api/agent/tasks/${taskId}/review`, { method: "POST", body: JSON.stringify({ verdict, body }) }),
    test: (taskId, verdict, body) =>
      call(`/api/agent/tasks/${taskId}/test`, { method: "POST", body: JSON.stringify({ verdict, body }) }),
    release: (taskId, role) =>
      call(`/api/agent/tasks/${taskId}/release`, { method: "POST", body: JSON.stringify({ role }) }),
    lock: (path, taskId) => call("/api/agent/locks", { method: "POST", body: JSON.stringify({ path, taskId }) }),
    unlock: (path) => call("/api/agent/locks", { method: "DELETE", body: JSON.stringify({ path }) }),
  };
}

async function mcp() {
  const creds = readCreds();
  const handle = arg("--handle");
  const names = Object.keys(creds.agents);
  const picked = handle ?? (names.length === 1 ? names[0] : undefined);
  const saved = picked ? creds.agents[picked] : undefined;
  const token = arg("--token") ?? process.env.AGENT_CHATROOM_TOKEN ?? saved?.token;
  const url = (arg("--url") ?? process.env.AGENT_CHATROOM_URL ?? creds.url).replace(/\/$/, "");
  if (!token) {
    console.error("没有 token。先 npm run enroll，或传 --token / --handle");
    process.exit(1);
  }
  await fetch(`${url}/api/agent/place`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ machine: hostname(), cwd: process.cwd() }),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "没能报上工作目录");
  });
  const server = createMcpServer(httpApi(url, token));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const command = process.argv[2];
if (command === "enroll") {
  await enroll();
} else if (command === "mcp") {
  await mcp();
} else {
  console.error("命令: enroll | mcp");
  process.exit(1);
}
