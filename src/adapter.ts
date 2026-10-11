import { readFileSync, existsSync } from "node:fs";
import { LEASE_MS } from "./server/logic.ts";
import {
  ARTIFACT_LIMIT,
  SUMMARY_LIMIT,
  normalizeShots,
  withShots,
} from "./server/pipeline.ts";

export const HEARTBEAT_EVERY_MS = Math.min(Math.floor(LEASE_MS / 3), 5 * 60 * 1000);
export const PPENG_DEFAULT_PORT = 37070;
export const PPENG_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export type AdapterTask = {
  id: string;
  title: string;
  body: string;
  acceptance?: string;
  stepRole?: string | null;
  status?: string;
  handles?: string[];
  assigneeHandle?: string | null;
};

export type DeliverAction = {
  type: "deliver";
  ref: string;
  summary: string;
  body: string;
  verdict?: "pass" | "fail";
  screenshots: string[];
};

export type ConcludeAction = {
  type: "conclude";
  verdict: "pass" | "changes";
  body: string;
};

export type AdapterAction = DeliverAction | ConcludeAction;

type Creds = { url: string; agents: Record<string, { token: string }> };

const credPath = process.env.AGENT_CHATROOM_CREDENTIALS ?? "data/credentials.json";

export function echoAction(task: AdapterTask): AdapterAction {
  if (task.stepRole === "review") {
    return { type: "conclude", verdict: "pass", body: "echo 复核通过" };
  }
  const body = (task.body || task.title).slice(0, ARTIFACT_LIMIT);
  if (task.stepRole === "qa") {
    return {
      type: "deliver",
      ref: `echo:${task.id.slice(0, 8)}`,
      summary: "echo 通过。未打开浏览器。",
      body: "echo：这是冒充的 QA，没有真实截图。",
      verdict: "pass",
      screenshots: [],
    };
  }
  return {
    type: "deliver",
    ref: `echo:${task.id.slice(0, 8)}`,
    summary: body.slice(0, SUMMARY_LIMIT) || "echo",
    body,
    screenshots: [],
  };
}

export function webhookPayload(task: AdapterTask) {
  return {
    taskId: task.id,
    role: task.stepRole ?? "",
    title: task.title,
    acceptance: task.acceptance ?? "",
    body: task.body,
  };
}

export function readWebhookResponse(value: unknown, role: string): AdapterAction {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const summary = String(record.summary ?? "").trim();
  const body = String(record.body ?? summary).trim();
  const shots = normalizeShots(record.screenshots);
  const verdict = String(record.verdict ?? "").trim();
  if (role === "review") {
    if (verdict !== "pass" && verdict !== "changes") {
      throw new Error("复核响应的 verdict 要是 pass 或 changes");
    }
    if (!body) throw new Error("复核响应要有说明");
    return { type: "conclude", verdict, body: withShots(body, shots) };
  }
  const ref = String(record.ref ?? "").trim() || `webhook:${role || "task"}`;
  if (!summary) throw new Error("webhook 响应要有 summary");
  if (role === "qa" && verdict !== "pass" && verdict !== "fail") {
    throw new Error("QA 响应的 verdict 要是 pass 或 fail");
  }
  return {
    type: "deliver",
    ref: ref.slice(0, 200),
    summary: summary.slice(0, SUMMARY_LIMIT),
    body: withShots(body, shots),
    verdict: role === "qa" ? (verdict as "pass" | "fail") : undefined,
    screenshots: shots,
  };
}

export async function postWebhook(
  url: string,
  secret: string | undefined,
  payload: unknown,
  fetchImpl: typeof fetch,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-webhook-secret"] = secret;
  const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) throw new Error(`webhook ${response.status}`);
  return data;
}

export async function completeOpenAI(
  task: AdapterTask,
  env: { apiKey?: string; baseUrl?: string; model?: string },
  fetchImpl: typeof fetch,
) {
  if (!env.apiKey) throw new Error("缺少 OPENAI_API_KEY");
  const base = (env.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.apiKey}` },
    body: JSON.stringify({
      model: env.model || "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `角色 ${task.stepRole ?? "agent"}。标题：${task.title}\n验收：${task.acceptance ?? ""}\n\n${task.body}`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`openai ${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim() || "";
  if (!text) throw new Error("模型没有返回正文");
  return {
    type: "deliver" as const,
    ref: `openai:${task.id.slice(0, 8)}`,
    summary: text.slice(0, SUMMARY_LIMIT),
    body: text.slice(0, ARTIFACT_LIMIT),
    screenshots: [] as string[],
  };
}

export function ppengWorktreeBranch(title: string, taskId: string) {
  const name = title.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
  return `wt/${name}-${taskId.slice(-6)}`;
}

export function ppengTimeoutMs(raw: string | undefined) {
  if (raw === undefined || raw.trim() === "") return PPENG_DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("PPENG_TIMEOUT_MS 要是正数");
  return Math.floor(ms);
}

export function parseAssistantJson(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? trimmed).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("ppeng 没有返回 JSON");
  return JSON.parse(raw.slice(start, end + 1)) as unknown;
}

function ppengPrompt(task: AdapterTask, repoRoot: string) {
  const role = task.stepRole ?? "agent";
  const lines = [
    `你在做流水线的${role}。`,
    `标题：${task.title}`,
    task.acceptance ? `验收：${task.acceptance}` : "",
    "",
    task.body,
    "",
    "只回复一个 JSON 对象，不要加别的说明。",
    "字段：summary（不超过 1000 字）、body（不超过 32000 字）、verdict、ref。screenshots 可省略。",
  ];
  if (role === "review") lines.push("verdict 只能是 pass 或 changes。");
  else if (role === "qa") lines.push("verdict 只能是 pass 或 fail。");
  else if (role === "build") {
    const branch = ppengWorktreeBranch(task.title, task.id);
    lines.push(`仓库：${repoRoot}`);
    lines.push(`请在这个 git 仓库的 worktree 里改代码。分支名是 ${branch}。ref 填这个分支名。`);
  }
  return lines.filter((line) => line !== undefined).join("\n");
}

export async function completePpeng(
  task: AdapterTask,
  env: { baseUrl?: string; token?: string; repoRoot?: string; timeoutMs?: string },
  fetchImpl: typeof fetch,
) {
  const base = (env.baseUrl || `http://127.0.0.1:${PPENG_DEFAULT_PORT}`).replace(/\/$/, "");
  const role = task.stepRole ?? "";
  if (role === "build" && !env.repoRoot?.trim()) throw new Error("缺少 PPENG_REPO_ROOT");
  const timeoutMs = ppengTimeoutMs(env.timeoutMs);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.token) headers.authorization = `Bearer ${env.token}`;
  const build = role === "build";
  const path = build ? "/api/tasks" : "/api/chat";
  const message = ppengPrompt(task, env.repoRoot?.trim() ?? "");
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: task.title, message, autoRun: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reply = await readPpengReply(response, fetchImpl, base, headers, timeoutMs);
  if (!reply.latestAssistant?.trim()) throw new Error("ppeng 没有返回正文");
  const parsed = parseAssistantJson(reply.latestAssistant);
  const record = parsed && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {};
  if (build && !String(record.ref ?? "").trim()) record.ref = ppengWorktreeBranch(task.title, task.id);
  return readWebhookResponse(record, role);
}

async function readPpengReply(
  response: Response,
  fetchImpl: typeof fetch,
  base: string,
  headers: Record<string, string>,
  timeoutMs: number,
) {
  if (!response.ok) throw new Error(`ppeng ${response.status}`);
  const first = await readPpengPayload(response);
  if (first.latestAssistant?.trim()) return first;
  if (!first.sessionId) return first;
  const again = await fetchImpl(`${base}/api/sessions/${first.sessionId}/run`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!again.ok) throw new Error(`ppeng ${again.status}`);
  return readPpengPayload(again);
}

async function readPpengPayload(response: Response) {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) return parsePpengSse(await response.text());
  const data = (await response.json()) as {
    latestAssistant?: unknown;
    session?: { id?: string };
    task?: { sessionId?: string };
  };
  return {
    latestAssistant: typeof data.latestAssistant === "string" ? data.latestAssistant : "",
    sessionId: data.session?.id || data.task?.sessionId || "",
  };
}

function parsePpengSse(text: string) {
  let latestAssistant = "";
  let sessionId = "";
  for (const chunk of text.split("\n\n")) {
    const event = chunk.match(/^event: ?(.*)$/m)?.[1]?.trim() ?? "";
    const dataLine = [...chunk.matchAll(/^data: ?(.*)$/gm)].map((match) => match[1]).join("\n");
    if (!dataLine) continue;
    const data = JSON.parse(dataLine) as { message?: string; latestAssistant?: string; session?: { id?: string } };
    if (event === "error") throw new Error(data.message || "ppeng 流失败");
    if (event === "result") {
      if (typeof data.latestAssistant === "string") latestAssistant = data.latestAssistant;
      if (data.session?.id) sessionId = data.session.id;
    }
  }
  return { latestAssistant, sessionId };
}

const terminalStatus = new Set(["canceled", "blocked", "done", "failed"]);

export type RoomApi = {
  getTask: (id: string) => Promise<AdapterTask>;
  claim: (id: string) => Promise<unknown>;
  heartbeat: (id: string) => Promise<unknown>;
  deliver: (id: string, action: DeliverAction) => Promise<unknown>;
  conclude: (id: string, action: ConcludeAction) => Promise<unknown>;
  decline: (id: string, note: string) => Promise<unknown>;
  release: (id: string) => Promise<unknown>;
};

export function taskIsMine(task: AdapterTask, handle: string) {
  if (!handle) return true;
  if (task.stepRole === "review") return (task.handles ?? []).includes(handle);
  if (task.stepRole) return task.assigneeHandle === handle;
  return true;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function keepAwake(everyMs: number, beat: () => Promise<void>, sleep: (ms: number, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      await sleep(everyMs, controller.signal);
      if (controller.signal.aborted) return;
      try {
        await beat();
      } catch {
        /* 续租失败留给这一步的收尾 */
      }
    }
  })();
  return {
    stop() {
      controller.abort();
      return done;
    },
  };
}

export async function runAdapterTask(input: {
  task: AdapterTask;
  handle: string;
  act: (task: AdapterTask) => Promise<AdapterAction>;
  api: RoomApi;
  heartbeatEveryMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const task = input.task;
  if (task.status && terminalStatus.has(task.status)) return "skipped" as const;
  if (!taskIsMine(task, input.handle)) return "skipped" as const;
  const every = input.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS;
  const sleep = input.sleep ?? delay;
  if (task.stepRole === "review") {
    const stay = keepAwake(every, () => input.api.getTask(task.id).then(() => undefined), sleep);
    try {
      const action = await input.act(task);
      await stay.stop();
      if (action.type !== "conclude") throw new Error("复核要 conclude，verdict 是 pass 或 changes");
      const fresh = await input.api.getTask(task.id);
      if (fresh.status && terminalStatus.has(fresh.status)) return "skipped" as const;
      await input.api.conclude(task.id, action);
      return "concluded" as const;
    } catch (error) {
      await stay.stop();
      console.error(errorText(error));
      return "skipped" as const;
    }
  }
  let holding = task.status === "claimed" || task.status === "working" || task.status === "changes";
  if (!holding && task.status !== "open" && task.status) return "skipped" as const;
  if (!holding) {
    try {
      await input.api.claim(task.id);
      holding = true;
    } catch (error) {
      console.error(errorText(error));
      return "skipped" as const;
    }
  }
  const stay = keepAwake(every, () => input.api.heartbeat(task.id).then(() => undefined), sleep);
  try {
    const action = await input.act(task);
    await stay.stop();
    const fresh = await input.api.getTask(task.id);
    if (fresh.status && terminalStatus.has(fresh.status)) return "skipped" as const;
    if (action.type === "conclude") {
      await input.api.conclude(task.id, action);
      return "concluded" as const;
    }
    await input.api.deliver(task.id, action);
    return "delivered" as const;
  } catch (error) {
    await stay.stop();
    const note = errorText(error).slice(0, 280);
    const fallback = (task.handles?.length ?? 0) > 1;
    try {
      if (fallback) {
        await input.api.decline(task.id, note);
        return "declined" as const;
      }
      await input.api.release(task.id);
      return "released" as const;
    } catch {
      try {
        if (fallback) {
          await input.api.release(task.id);
          return "released" as const;
        }
        await input.api.decline(task.id, note);
        return "declined" as const;
      } catch (second) {
        console.error(errorText(second));
        return "skipped" as const;
      }
    }
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readCreds(): Creds {
  if (!existsSync(credPath)) return { url: "http://127.0.0.1:8791", agents: {} };
  return JSON.parse(readFileSync(credPath, "utf8")) as Creds;
}

async function call(url: string, token: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as { message?: string; status?: string; events?: Array<{ id: number; event_type: string; ref_id: string }> };
  if (!response.ok) throw new Error(body.message ?? response.statusText);
  return body;
}

async function act(kind: string, task: AdapterTask): Promise<AdapterAction> {
  if (kind === "echo") return echoAction(task);
  if (kind === "openai") {
    return completeOpenAI(
      task,
      {
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        model: process.env.OPENAI_MODEL,
      },
      fetch,
    );
  }
  if (kind === "webhook") {
    const url = process.env.WEBHOOK_URL;
    if (!url) throw new Error("缺少 WEBHOOK_URL");
    const data = await postWebhook(url, process.env.WEBHOOK_SECRET, webhookPayload(task), fetch);
    return readWebhookResponse(data, task.stepRole ?? "");
  }
  if (kind === "ppeng") {
    try {
      return await completePpeng(
        task,
        {
          baseUrl: process.env.PPENG_BASE_URL,
          token: process.env.PPENG_TOKEN,
          repoRoot: process.env.PPENG_REPO_ROOT,
          timeoutMs: process.env.PPENG_TIMEOUT_MS,
        },
        fetch,
      );
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error("ppeng 超时");
      }
      throw error;
    }
  }
  throw new Error("ADAPTER 要是 echo、openai、webhook 或 ppeng");
}

async function main() {
  const kind = process.env.ADAPTER ?? "echo";
  const handle = (arg("--handle") ?? "").toLowerCase();
  const creds = readCreds();
  const saved = handle ? creds.agents[handle] : undefined;
  const token = arg("--token") ?? process.env.AGENT_CHATROOM_TOKEN ?? saved?.token;
  const url = (arg("--url") ?? process.env.AGENT_CHATROOM_URL ?? creds.url).replace(/\/$/, "");
  if (!token) {
    console.error("没有 token。先 enroll，或传 --token / --handle");
    process.exit(1);
  }
  if (kind === "openai" && !process.env.OPENAI_API_KEY) {
    console.error("缺少 OPENAI_API_KEY");
    process.exit(1);
  }
  if (kind === "webhook" && !process.env.WEBHOOK_URL) {
    console.error("缺少 WEBHOOK_URL");
    process.exit(1);
  }
  if (!["echo", "openai", "webhook", "ppeng"].includes(kind)) {
    console.error("ADAPTER 要是 echo、openai、webhook 或 ppeng");
    process.exit(1);
  }
  const api = roomApi(url, token);
  let after = 0;
  for (;;) {
    const waited = await call(url, token, `/api/wait?after=${after}&timeoutMs=20000`);
    const events = waited.events ?? [];
    if (events.length > 0) after = events[events.length - 1].id;
    for (const event of events) {
      if (!["task_open", "awarded"].includes(event.event_type)) continue;
      try {
        const task = await api.getTask(event.ref_id);
        await runAdapterTask({ task, handle, act: (item) => act(kind, item), api });
      } catch (error) {
        console.error(errorText(error));
      }
    }
  }
}

function roomApi(url: string, token: string): RoomApi {
  return {
    getTask: (id) => call(url, token, `/api/agent/tasks/${id}`) as Promise<AdapterTask>,
    claim: (id) => call(url, token, `/api/agent/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ role: "implementer" }) }),
    heartbeat: (id) => call(url, token, `/api/agent/tasks/${id}/heartbeat`, { method: "POST", body: "{}" }),
    deliver: (id, action) =>
      call(url, token, `/api/agent/tasks/${id}/deliver`, {
        method: "POST",
        body: JSON.stringify({
          ref: action.ref,
          summary: action.summary,
          body: action.body,
          verdict: action.verdict,
          screenshots: action.screenshots,
        }),
      }),
    conclude: (id, action) =>
      call(url, token, `/api/agent/tasks/${id}/conclude`, {
        method: "POST",
        body: JSON.stringify({ verdict: action.verdict, body: action.body }),
      }),
    decline: (id, note) =>
      call(url, token, `/api/agent/tasks/${id}/decline`, { method: "POST", body: JSON.stringify({ note }) }),
    release: (id) =>
      call(url, token, `/api/agent/tasks/${id}/release`, { method: "POST", body: JSON.stringify({ role: "implementer" }) }),
  };
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("adapter.ts") || entry.endsWith("adapter.js")) {
  await main();
}
