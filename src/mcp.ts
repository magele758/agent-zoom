import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ChatApi {
  whoami(): Promise<unknown>;
  listRooms(): Promise<unknown>;
  read(roomId: string, afterSeq: number): Promise<unknown>;
  say(input: { roomId: string; body: string; kind?: string; taskId?: string }): Promise<unknown>;
  wait(after: number, timeoutMs: number): Promise<unknown>;
  listTasks(roomId: string): Promise<unknown>;
  claim(taskId: string, role: string): Promise<unknown>;
  heartbeat(taskId: string): Promise<unknown>;
  ready(taskId: string): Promise<unknown>;
  review(taskId: string, verdict: string, body: string): Promise<unknown>;
  test(taskId: string, verdict: string, body: string): Promise<unknown>;
  release(taskId: string, role: string): Promise<unknown>;
  lock(path: string, taskId?: string): Promise<unknown>;
  unlock(path: string): Promise<unknown>;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createMcpServer(api: ChatApi) {
  const server = new McpServer({ name: "agent-chatroom", version: "0.1.0" });
  server.registerTool("whoami", { description: "你是谁，在哪些房间里，以及 wait 会推什么。" }, async () =>
    text(await api.whoami()),
  );
  server.registerTool(
    "list_rooms",
    { description: "列出你加入的频道。" },
    async () => text(await api.listRooms()),
  );
  server.registerTool(
    "read_messages",
    {
      description: "读取频道历史。成员能读到房间里的全部消息。这不是唤醒：无关闲聊不要当成你的新任务。",
      inputSchema: {
        roomId: z.string(),
        afterSeq: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ roomId, afterSeq }) => text(await api.read(roomId, afterSeq ?? 0)),
  );
  server.registerTool(
    "say",
    {
      description: "在频道发言。kind 可以是 chat、question、progress。progress 必须带 taskId，且你是实现者。用 @句柄 点名才会唤醒对方。",
      inputSchema: {
        roomId: z.string(),
        body: z.string(),
        kind: z.enum(["chat", "question", "progress"]).optional(),
        taskId: z.string().optional(),
      },
    },
    async (input) => text(await api.say(input)),
  );
  server.registerTool(
    "wait",
    {
      description:
        "阻塞到出现与你相关的事件：有人 @ 你、新指令、轮到评审或测试、你占着的任务有新消息。无关闲聊不会返回。超时就再调一次，不要空转轮询。",
      inputSchema: {
        after: z.number().optional(),
        timeoutMs: z.number().optional(),
      },
    },
    async ({ after, timeoutMs }) => text(await api.wait(after ?? 0, timeoutMs ?? 20_000)),
  );
  server.registerTool(
    "list_tasks",
    { description: "查看频道里的任务和槽位。", inputSchema: { roomId: z.string() } },
    async ({ roomId }) => text(await api.listTasks(roomId)),
  );
  server.registerTool(
    "claim",
    {
      description: "原子认领槽位。role 是 implementer、reviewer 或 tester。失败就说明别人已经拿了，不要开工。",
      inputSchema: { taskId: z.string(), role: z.enum(["implementer", "reviewer", "tester"]) },
    },
    async ({ taskId, role }) => text(await api.claim(taskId, role)),
  );
  server.registerTool(
    "heartbeat",
    { description: "给自己占着的槽位续租。实现过程中定期调用。", inputSchema: { taskId: z.string() } },
    async ({ taskId }) => text(await api.heartbeat(taskId)),
  );
  server.registerTool(
    "mark_ready",
    { description: "实现者提交评审。", inputSchema: { taskId: z.string() } },
    async ({ taskId }) => text(await api.ready(taskId)),
  );
  server.registerTool(
    "review",
    {
      description: "评审。先 claim reviewer。verdict 是 approve、request_changes 或 question。",
      inputSchema: {
        taskId: z.string(),
        verdict: z.enum(["approve", "request_changes", "question"]),
        body: z.string(),
      },
    },
    async (input) => text(await api.review(input.taskId, input.verdict, input.body)),
  );
  server.registerTool(
    "report_test",
    {
      description: "测试。先 claim tester。verdict 是 pass 或 fail。通过且评审已通过，任务才完成。",
      inputSchema: { taskId: z.string(), verdict: z.enum(["pass", "fail"]), body: z.string() },
    },
    async (input) => text(await api.test(input.taskId, input.verdict, input.body)),
  );
  server.registerTool(
    "release",
    {
      description: "放开自己的槽位。",
      inputSchema: { taskId: z.string(), role: z.enum(["implementer", "reviewer", "tester"]) },
    },
    async ({ taskId, role }) => text(await api.release(taskId, role)),
  );
  server.registerTool(
    "lock_file",
    {
      description: "给仓库相对路径加租约锁，避免两个 agent 同时改同一个文件。",
      inputSchema: { path: z.string(), taskId: z.string().optional() },
    },
    async ({ path, taskId }) => text(await api.lock(path, taskId)),
  );
  server.registerTool(
    "unlock_file",
    { description: "放开自己持有的文件锁。", inputSchema: { path: z.string() } },
    async ({ path }) => text(await api.unlock(path)),
  );
  return server;
}
