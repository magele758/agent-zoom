import { createHash } from "node:crypto";
import { z } from "zod";
import type { StageHomeBot } from "../stage-home-types.ts";
import { ApiError } from "./logic.ts";

const letter = z.string().min(1);
const botList = z.object({
  bots: z.array(z.object({
    bot: z.object({ id: letter, name: letter, hidden: z.boolean().optional() }),
    control: z.object({ paused: z.boolean().optional(), disabled: z.boolean().optional() }).optional(),
  })),
});
const task = z.object({
  id: letter, targetBotId: letter, input: z.string(), status: letter, attempt: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }), result: z.string().optional(), failureReason: z.string().optional(),
  delivery: z.object({
    taskId: letter, attempt: z.number().int(), sessionId: letter, report: z.string(), executionStatus: letter,
    artifacts: z.array(z.object({ id: letter, fileName: letter })),
    receipts: z.array(z.object({ id: letter, toolName: letter, state: letter })),
  }).optional(),
});
export type HomeTask = z.infer<typeof task>;
const taskPage = z.object({ tasks: z.array(task.pick({ id: true, input: true, targetBotId: true })),
  hasMore: z.boolean(), nextCursor: z.string().nullable() });

export class StageHomeClient {
  readonly origin: string;
  readonly identity: string;
  private token: string | undefined;

  constructor(env: { PPENG_BASE_URL?: string; PPENG_TOKEN?: string } = process.env as NodeJS.ProcessEnv) {
    const url = new URL(env.PPENG_BASE_URL || "http://127.0.0.1:37070");
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new ApiError(400, "stage_home_url", "Agent Home 需要本机服务地址。");
    }
    this.origin = url.origin;
    this.token = env.PPENG_TOKEN;
    this.identity = createHash("sha256").update(this.origin + "\n" + (this.token ?? "")).digest("hex");
  }

  async call<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const headers: Record<string,string> = { accept: "application/json" };
    if (this.token) headers.authorization = "Bearer " + this.token;
    if (body) headers["content-type"] = "application/json";
    try {
      const response = await fetch(this.origin + path, { method: body ? "POST" : "GET", headers,
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? "请核对服务端的 PPENG_TOKEN。" : "请在 Agent Home 核对服务状态。";
        throw new ApiError(502, "stage_home_remote", `Agent Home 返回 HTTP ${response.status}。${hint}`);
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw new ApiError(502, "stage_home_remote", "Agent Home 返回的回执不完整。");
      return parsed.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "stage_home_remote", "无法读取 Agent Home 的响应，请核对本机连接。");
    }
  }

  async bots(): Promise<StageHomeBot[]> {
    const data = await this.call("/api/bot-work/status", botList);
    return data.bots.filter(row => !row.bot.hidden && !row.control?.paused && !row.control?.disabled)
      .map(row => ({ id: row.bot.id, name: row.bot.name })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  async send(botId: string, input: string, key: string) {
    return (await this.call("/api/bot-work/tasks", z.object({ task }), { targetBotId: botId, input, idempotencyKey: key })).task;
  }

  async read(id: string) {
    return (await this.call("/api/bot-work/tasks/" + encodeURIComponent(id), z.object({ task }))).task;
  }

  // Bot Work provides a paged, principal-scoped ledger. Match our complete, immutable
  // brief and target. Other tasks never leave this method.
  async locate(botId: string, input: string): Promise<HomeTask | null> {
    let cursor = "";
    const cursors = new Set<string>();
    for (let n = 0; n < 20; n++) {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const page = await this.call("/api/bot-work/tasks?" + query, taskPage);
      const matches = page.tasks.filter(row => row.targetBotId === botId && row.input === input);
      if (matches.length > 1) throw new ApiError(409, "stage_home_ambiguous", "找到多个同源回执，需要在 Agent Home 核对。");
      if (matches.length) return await this.read(matches[0].id);
      if (!page.hasMore) return null;
      if (!page.nextCursor || cursors.has(page.nextCursor)) break;
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
    throw new ApiError(409, "stage_home_partial", "还未核对完整的 Agent Home 任务记录，请在原服务核对。");
  }
}
