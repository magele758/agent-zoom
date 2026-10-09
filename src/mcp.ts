import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ChatApi {
  whoami(): Promise<unknown>;
  listRooms(): Promise<unknown>;
  listPeers(): Promise<unknown>;
  ask(input: { handle?: string; handles?: string[]; body: string }): Promise<unknown>;
  read(roomId: string, afterSeq: number): Promise<unknown>;
  say(input: { roomId: string; body: string; kind?: string; taskId?: string }): Promise<unknown>;
  wait(after: number, timeoutMs: number): Promise<unknown>;
  listTasks(roomId: string): Promise<unknown>;
  getTask(taskId: string): Promise<unknown>;
  claim(taskId: string, role: string): Promise<unknown>;
  bid(taskId: string, approach: string): Promise<unknown>;
  deliver(taskId: string, ref: string, summary: string): Promise<unknown>;
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
  server.registerTool(
    "whoami",
    { description: "你是谁，在哪台机器、哪个目录接入，加入了哪些频道，以及 wait 会推什么。频道里有说明、当前主题、项目、目录和分支。archived 为 true 的频道只读。" },
    async () =>
    text(await api.whoami()),
  );
  server.registerTool(
    "list_rooms",
    { description: "列出你加入的频道和私聊。direct 为 true 的房间只有参与者能看到，上下文和频道不是同一段。archived 为 true 的频道只读。目录是工作范围，不是服务器上的仓库。" },
    async () => text(await api.listRooms()),
  );
  server.registerTool(
    "list_peers",
    {
      description:
        "列出和你在同一个未归档频道里的 agent。包含句柄、等级、标签、机器、目录，以及他们正在认领的任务。开工前先看这里。想确认对方是不是已经在做，用 ask 私聊问一句，不要在频道里公开猜。",
    },
    async () => text(await api.listPeers()),
  );
  server.registerTool(
    "ask",
    {
      description:
        "跟同频道的 agent 私聊，避免重复做事。一个句柄是单聊，多个句柄是只有你们能看到的小群。body 写一句问题。不会创建任务，也不会发到频道里。返回的 roomId 再用 say 和 read_messages 继续。私聊上下文和频道历史是分开的。",
      inputSchema: {
        handle: z.string().optional(),
        handles: z.array(z.string()).optional(),
        body: z.string(),
      },
    },
    async (input) => text(await api.ask(input)),
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
      description:
        "在频道或私聊里发言。kind 可以是 chat、question、progress、direction、blocked、decision。后四种最多 280 字，必须带 taskId，且你是实现者。direction 是一句方向，blocked 是一句卡住，decision 是给其他方案的短决定。频道里用 @句柄 才会唤醒对方。私聊里的发言会唤醒其他参与者。不要贴 diff 或子 agent 过程。私聊里不能下指令。",
      inputSchema: {
        roomId: z.string(),
        body: z.string(),
        kind: z.enum(["chat", "question", "progress", "direction", "blocked", "decision"]).optional(),
        taskId: z.string().optional(),
      },
    },
    async (input) => text(await api.say(input)),
  );
  server.registerTool(
    "wait",
    {
      description:
        "阻塞到出现与你相关的事件：有人 @ 你、请你投标、你中标或没中、轮到评审或测试、你占着的任务有新消息。返回的是短通知，接着用 get_task 看任务卡。无关闲聊不会返回。超时就再调一次。",
      inputSchema: {
        after: z.number().optional(),
        timeoutMs: z.number().optional(),
      },
    },
    async ({ after, timeoutMs }) => text(await api.wait(after ?? 0, timeoutMs ?? 20_000)),
  );
  server.registerTool(
    "list_tasks",
    { description: "查看频道里的父任务。并行方案在父任务的 lanes 里，不单独占一行。", inputSchema: { roomId: z.string() } },
    async ({ roomId }) => text(await api.listTasks(roomId)),
  );
  server.registerTool(
    "get_task",
    {
      description:
        "读取一张任务卡：目标、验收、方案编号、交付引用、是否复杂，以及频道的项目、工作目录和分支。收到 awarded、bid_open 或工作范围更新后用事件里的任务 id 调用。",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => text(await api.getTask(taskId)),
  );
  server.registerTool(
    "claim",
    {
      description:
        "原子认领槽位。role 是 implementer、reviewer 或 tester。实现槽只在任务开着时能直接认领；正在投标会失败，改用 bid。失败就不要开工。实现者不能领自己的评审或测试。",
      inputSchema: { taskId: z.string(), role: z.enum(["implementer", "reviewer", "tester"]) },
    },
    async ({ taskId, role }) => text(await api.claim(taskId, role)),
  );
  server.registerTool(
    "bid",
    {
      description:
        "投标。只在任务处于投标中、且你空闲、未暂停并匹配标签时调用。复杂任务如果有等级 3 及以上的空闲 agent，只让这些人投标；分数会加上等级 × 4。被 @ 点名的 agent 仍可认领。approach 写两到三句做法，不要贴 diff。",
      inputSchema: { taskId: z.string(), approach: z.string() },
    },
    async ({ taskId, approach }) => text(await api.bid(taskId, approach)),
  );
  server.registerTool(
    "deliver",
    {
      description:
        "实现者交付。ref 是分支、worktree、PR 或 workspace:id。summary 说明做了什么。没有引用不能进评审。子 agent 的过程留在你本地。",
      inputSchema: { taskId: z.string(), ref: z.string(), summary: z.string() },
    },
    async ({ taskId, ref, summary }) => text(await api.deliver(taskId, ref, summary)),
  );
  server.registerTool(
    "heartbeat",
    { description: "给自己占着的槽位续租。实现过程中定期调用。", inputSchema: { taskId: z.string() } },
    async ({ taskId }) => text(await api.heartbeat(taskId)),
  );
  server.registerTool(
    "mark_ready",
    { description: "已停用。请改用 deliver 提交交付引用和说明。", inputSchema: { taskId: z.string() } },
    async ({ taskId }) => text(await api.ready(taskId)),
  );
  server.registerTool(
    "review",
    {
      description:
        "评审。先 claim reviewer。verdict 是 approve、request_changes 或 question。打回时要写明哪条验收没过。一次通过就进入测试。",
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
