import { readFileSync, existsSync } from "node:fs";
import {
  ARTIFACT_LIMIT,
  SUMMARY_LIMIT,
  normalizeShots,
  withShots,
} from "./server/pipeline.ts";

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
  throw new Error("ADAPTER 要是 echo、openai 或 webhook");
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
  let after = 0;
  for (;;) {
    const waited = await call(url, token, `/api/wait?after=${after}&timeoutMs=20000`);
    const events = waited.events ?? [];
    if (events.length > 0) after = events[events.length - 1].id;
    for (const event of events) {
      if (!["task_open", "awarded"].includes(event.event_type)) continue;
      const task = (await call(url, token, `/api/agent/tasks/${event.ref_id}`)) as AdapterTask & {
        stepRole?: string | null;
        assigneeHandle?: string | null;
        handles?: string[];
        acceptance?: string;
      };
      if (task.status === "canceled" || task.status === "blocked" || task.status === "done") continue;
      const mine = task.stepRole === "review" ? (task.handles ?? []).includes(handle) : task.assigneeHandle === handle;
      if (handle && !mine) continue;
      if (task.status === "canceled") continue;
      const action = await act(kind, task);
      const fresh = (await call(url, token, `/api/agent/tasks/${task.id}`)) as { status?: string };
      if (fresh.status === "canceled" || fresh.status === "blocked" || fresh.status === "done") continue;
      if (action.type === "conclude") {
        await call(url, token, `/api/agent/tasks/${task.id}/conclude`, {
          method: "POST",
          body: JSON.stringify({ verdict: action.verdict, body: action.body }),
        });
        continue;
      }
      if (fresh.status === "open") {
        await call(url, token, `/api/agent/tasks/${task.id}/claim`, {
          method: "POST",
          body: JSON.stringify({ role: "implementer" }),
        });
      }
      const held = (await call(url, token, `/api/agent/tasks/${task.id}`)) as { status?: string };
      if (held.status === "canceled") continue;
      await call(url, token, `/api/agent/tasks/${task.id}/deliver`, {
        method: "POST",
        body: JSON.stringify({
          ref: action.ref,
          summary: action.summary,
          body: action.body,
          verdict: action.verdict,
          screenshots: action.screenshots,
        }),
      });
    }
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("adapter.ts") || entry.endsWith("adapter.js")) {
  await main();
}
