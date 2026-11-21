import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { ExecutiveStatus } from "./executive-bots-types.ts";
import {
  EXECUTIVE_DEPARTMENTS,
  mergeSuperBotDescription,
  OPC_CRON_NAME,
  OPC_GROUP_NAME,
  OPC_ROOM_TITLE,
  registerExecutiveBotRoutes,
} from "./server/executive-bots.ts";
import { StageHomeClient } from "./server/stage-home-client.ts";

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function createMockAgentHome() {
  type Bot = { id: string; name: string; title: string; description: string; hidden: boolean; functionalGroupId: string | null };
  type Group = { id: string; name: string; botIds: string[]; roomIds: string[] };
  type Room = { id: string; title: string; status: string; botIds: string[]; hostBotId: string; replyMode: string; messages: Array<{ id: string; text: string; mentions: string[] }> };
  type Task = { id: string; requesterBotId: string; targetBotId: string; input: string; status: string; result?: string; updatedAt: string };
  type CronJob = { id: string; name: string; botId: string; roomId: string; scheduleValue: string; enabled: boolean; nextRunAt: string | null };

  const bots = new Map<string, Bot>([
    [
      "super-bot",
      {
        id: "super-bot",
        name: "Super Bot",
        title: "Team coordinator",
        description: "Original Super Bot coordinator prompt.",
        hidden: false,
        functionalGroupId: null,
      },
    ],
  ]);
  const groups = new Map<string, Group>();
  const rooms = new Map<string, Room>();
  const tasks: Task[] = [];
  const crons = new Map<string, CronJob>();
  const sharedContext = new Map<string, Record<string, string>>();
  let seq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const path = url.pathname;
    const body = method === "GET" ? {} : await readJson(req);

    if (method === "GET" && path === "/api/bot-work/default") {
      return sendJson(res, 200, { bot: bots.get("super-bot"), sessionId: "session-super" });
    }
    if (method === "GET" && path === "/api/bots") {
      return sendJson(res, 200, { bots: [...bots.values()] });
    }
    if (method === "POST" && path === "/api/bots") {
      const name = String(body.name ?? "");
      if ([...bots.values()].some(b => b.name === name)) {
        return sendJson(res, 409, { error: "duplicate bot name" });
      }
      const softShapes = ["pebble", "squish", "capsule", "cloud", "drop", "bean", "nub", "pillow"];
      const softColors = ["butter", "peach", "coral", "blush", "lilac", "sky", "mint", "sage", "sand", "ink"];
      const softExpressions = ["neutral", "happy", "curious", "sleepy", "wink", "content", "wide", "shy"];
      if (body.faceStyle === "soft") {
        if (!softShapes.includes(String(body.faceShape))) return sendJson(res, 400, { error: "invalid faceShape" });
        if (!softColors.includes(String(body.faceColor))) return sendJson(res, 400, { error: "invalid faceColor" });
        if (!softExpressions.includes(String(body.faceExpression))) return sendJson(res, 400, { error: "invalid faceExpression" });
      }
      const id = `bot-${++seq}`;
      const bot: Bot = {
        id,
        name,
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        hidden: false,
        functionalGroupId: null,
      };
      bots.set(id, bot);
      return sendJson(res, 201, { bot });
    }
    const botMatch = /^\/api\/bots\/([^/]+)$/.exec(path);
    if (botMatch) {
      const bot = bots.get(decodeURIComponent(botMatch[1]));
      if (!bot) return sendJson(res, 404, { error: "not found" });
      if (method === "GET") return sendJson(res, 200, { bot });
      if (method === "PATCH") {
        if (typeof body.title === "string") bot.title = body.title;
        if (typeof body.description === "string") bot.description = body.description;
        if (typeof body.hidden === "boolean") bot.hidden = body.hidden;
        return sendJson(res, 200, { bot });
      }
    }
    const botGroupMatch = /^\/api\/bots\/([^/]+)\/functional-group$/.exec(path);
    if (botGroupMatch && method === "PUT") {
      const botId = decodeURIComponent(botGroupMatch[1]);
      const groupId = String(body.groupId ?? "");
      const bot = bots.get(botId);
      const group = groups.get(groupId);
      if (!bot || !group) return sendJson(res, 404, { error: "not found" });
      bot.functionalGroupId = groupId;
      if (!group.botIds.includes(botId)) group.botIds.push(botId);
      return sendJson(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/bot-functional-groups") {
      return sendJson(res, 200, { groups: [...groups.values()] });
    }
    if (method === "POST" && path === "/api/bot-functional-groups") {
      const id = `group-${++seq}`;
      const group: Group = { id, name: String(body.name ?? ""), botIds: [], roomIds: [] };
      groups.set(id, group);
      return sendJson(res, 201, { group });
    }
    if (method === "PUT" && path === "/api/bot-shared-context") {
      const key = `${url.searchParams.get("scope")}:${url.searchParams.get("id")}`;
      sharedContext.set(key, (body.entries as Record<string, string>) ?? {});
      return sendJson(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/bot-rooms") {
      return sendJson(res, 200, { rooms: [...rooms.values()] });
    }
    if (method === "POST" && path === "/api/bot-rooms") {
      const id = `room-${++seq}`;
      const room: Room = {
        id,
        title: String(body.title ?? ""),
        status: "active",
        botIds: Array.isArray(body.botIds) ? body.botIds.map(String) : [],
        hostBotId: String(body.hostBotId ?? "super-bot"),
        replyMode: "coordinator",
        messages: [],
      };
      rooms.set(id, room);
      return sendJson(res, 201, { room });
    }
    const roomPatchMatch = /^\/api\/bot-rooms\/([^/]+)$/.exec(path);
    if (roomPatchMatch && method === "PATCH") {
      const room = rooms.get(decodeURIComponent(roomPatchMatch[1]));
      if (!room) return sendJson(res, 404, { error: "not found" });
      if (typeof body.hostBotId === "string") room.hostBotId = body.hostBotId;
      if (typeof body.replyMode === "string") room.replyMode = body.replyMode;
      return sendJson(res, 200, { room });
    }
    const roomMemberMatch = /^\/api\/bot-rooms\/([^/]+)\/members$/.exec(path);
    if (roomMemberMatch && method === "POST") {
      const room = rooms.get(decodeURIComponent(roomMemberMatch[1]));
      if (!room) return sendJson(res, 404, { error: "not found" });
      const botId = String(body.botId ?? "");
      if (!room.botIds.includes(botId)) room.botIds.push(botId);
      return sendJson(res, 200, { ok: true });
    }
    const roomGroupMatch = /^\/api\/bot-rooms\/([^/]+)\/functional-group$/.exec(path);
    if (roomGroupMatch && method === "PUT") {
      const roomId = decodeURIComponent(roomGroupMatch[1]);
      const group = groups.get(String(body.groupId ?? ""));
      if (!group) return sendJson(res, 404, { error: "not found" });
      if (!group.roomIds.includes(roomId)) group.roomIds.push(roomId);
      return sendJson(res, 200, { ok: true });
    }
    const roomMsgMatch = /^\/api\/bot-rooms\/([^/]+)\/messages$/.exec(path);
    if (roomMsgMatch && method === "POST") {
      const room = rooms.get(decodeURIComponent(roomMsgMatch[1]));
      if (!room) return sendJson(res, 404, { error: "not found" });
      const msg = {
        id: `msg-${++seq}`,
        text: String(body.text ?? ""),
        mentions: Array.isArray(body.mentions) ? body.mentions.map(String) : [],
      };
      room.messages.push(msg);
      return sendJson(res, 201, { message: msg });
    }
    if (method === "GET" && path === "/api/bot-work/status") {
      return sendJson(res, 200, {
        bots: [...bots.values()].map(bot => ({
          bot,
          control: { paused: false, disabled: false },
          status: "idle",
          pending: tasks.filter(t => t.targetBotId === bot.id && t.status === "queued").length,
          taskCounts: {
            completed: tasks.filter(t => t.targetBotId === bot.id && t.status === "completed").length,
            failed: 0,
          },
          activeWorkCount: tasks.filter(t => t.targetBotId === bot.id && t.status === "running").length,
        })),
      });
    }
    if (method === "GET" && path === "/api/bot-work/tasks") {
      return sendJson(res, 200, { tasks: [...tasks].reverse() });
    }
    if (method === "POST" && path === "/api/bot-work/tasks") {
      const task: Task = {
        id: `task-${++seq}`,
        requesterBotId: String(body.requesterBotId ?? "super-bot"),
        targetBotId: String(body.targetBotId ?? ""),
        input: String(body.input ?? ""),
        status: "queued",
        updatedAt: new Date().toISOString(),
      };
      tasks.push(task);
      return sendJson(res, 201, { task });
    }
    if (method === "GET" && path === "/api/cron/jobs") {
      return sendJson(res, 200, { jobs: [...crons.values()] });
    }
    if (method === "POST" && path === "/api/cron/jobs") {
      const id = `cron-${++seq}`;
      const job: CronJob = {
        id,
        name: String(body.name ?? ""),
        botId: String(body.botId ?? ""),
        roomId: String(body.roomId ?? ""),
        scheduleValue: String(body.cron ?? "0 9 * * *"),
        enabled: Boolean(body.enabled),
        nextRunAt: null,
      };
      crons.set(id, job);
      return sendJson(res, 201, { job });
    }
    const cronMatch = /^\/api\/cron\/jobs\/([^/]+)$/.exec(path);
    if (cronMatch && method === "PATCH") {
      const job = crons.get(decodeURIComponent(cronMatch[1]));
      if (!job) return sendJson(res, 404, { error: "not found" });
      if (typeof body.enabled === "boolean") job.enabled = body.enabled;
      return sendJson(res, 200, { job });
    }

    return sendJson(res, 404, { error: `unhandled ${method} ${path}` });
  });

  return { server, bots, groups, rooms, tasks, crons, sharedContext };
}

test("mergeSuperBotDescription preserves original prompt and updates OPC contract idempotently", () => {
  const original = "Existing coordinator instructions.";
  const v1 = mergeSuperBotDescription(original, "【OPC 总裁办分级管理契约】\nv1\n【/OPC 总裁办分级管理契约】");
  assert.match(v1, /Existing coordinator instructions\./);
  assert.match(v1, /v1/);

  const v2 = mergeSuperBotDescription(v1, "【OPC 总裁办分级管理契约】\nv2\n【/OPC 总裁办分级管理契约】");
  assert.match(v2, /Existing coordinator instructions\./);
  assert.match(v2, /v2/);
  assert.doesNotMatch(v2, /\nv1\n/);
});

test("ExecutiveBotService bootstraps 5 dept bots + Super Bot hierarchy idempotently and dispatches work", async () => {
  const mock = createMockAgentHome();
  await new Promise<void>(resolve => mock.server.listen(0, "127.0.0.1", () => resolve()));
  const port = (mock.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE opc_home_chat_links(scope_key TEXT NOT NULL, connection TEXT NOT NULL, remote_room TEXT NOT NULL,
      room_title TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope_key, connection));
    CREATE TABLE opc_delegate_preferences(user_id TEXT PRIMARY KEY, preference TEXT NOT NULL, since TEXT NOT NULL);
  `);

  const app = new Hono();
  const fakeUser = { type: "user" as const, id: "user-1", name: "Founder" };
  registerExecutiveBotRoutes(app, db, () => fakeUser, {
    client: new StageHomeClient({ PPENG_BASE_URL: origin }),
    opcOrigin: "http://127.0.0.1:52328",
    pulseProvider: async () => ({
      companyPulse: {
        pendingApprovals: 1,
        onlineMachines: 3,
        totalMachines: 4,
        healthyServices: 9,
        totalServices: 10,
        pilotCompletionPct: 86,
        pilotProduct: "PageLens",
        openSecurityReviews: 0,
      },
      departmentHighlights: {
        commercial: ["1号试点 86%"],
        rd: ["活跃工作流 1 条"],
        operations: ["机器 3/4 在线"],
        security: ["安全评审全绿灯"],
        resources: ["主力套餐余量充足"],
      },
      snapshotText: "待创始人审批：1 项",
    }),
  });

  try {
    // 1. Status before bootstrap
    const beforeRes = await app.request("/api/opc/executive/status");
    assert.equal(beforeRes.status, 200);
    const before = (await beforeRes.json()) as ExecutiveStatus;
    assert.equal(before.agentHomeReachable, true);
    assert.equal(before.bootstrapped, false);
    assert.equal(before.superBot.exists, true);
    assert.equal(before.departments.length, EXECUTIVE_DEPARTMENTS.length);
    assert.ok(before.departments.every(d => !d.runtime.exists));

    // 2. Bootstrap creates all 5 dept bots, group, shared context, coordinator room, cron, and links OPC OS defaults
    const bootRes = await app.request("/api/opc/executive/bootstrap", { method: "POST" });
    assert.equal(bootRes.status, 200);
    const after = (await bootRes.json()) as ExecutiveStatus;
    assert.equal(after.bootstrapped, true);
    assert.equal(after.group?.name, OPC_GROUP_NAME);
    assert.equal(after.room?.title, OPC_ROOM_TITLE);
    assert.equal(after.room?.replyMode, "coordinator");
    assert.equal(after.room?.linkedDefault, true);
    assert.equal(after.delegationRoutedToSuperBot, true);
    assert.equal(after.briefCron?.name, OPC_CRON_NAME);
    assert.equal(after.briefCron?.enabled, false);
    assert.ok(after.departments.every(d => d.runtime.exists && d.runtime.inGroup && d.runtime.inRoom));
    assert.equal(mock.bots.size, 6);
    assert.match(mock.bots.get("super-bot")!.description, /Original Super Bot coordinator prompt\./);
    assert.match(mock.bots.get("super-bot")!.description, /【OPC 总裁办分级管理契约】/);
    assert.equal(mock.sharedContext.size, 1);

    // 3. Second bootstrap is strictly idempotent
    const boot2Res = await app.request("/api/opc/executive/bootstrap", { method: "POST" });
    assert.equal(boot2Res.status, 200);
    assert.equal(mock.bots.size, 6);
    assert.equal(mock.groups.size, 1);
    assert.equal(mock.rooms.size, 1);
    assert.equal(mock.crons.size, 1);

    // 4. Request executive brief posts @super-bot message into the executive room
    const briefRes = await app.request("/api/opc/executive/brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ focus: "核查今日重点阻塞并给我推荐选项", mode: "room" }),
    });
    assert.equal(briefRes.status, 200);
    const room = [...mock.rooms.values()][0];
    assert.equal(room.messages.length, 1);
    assert.deepEqual(room.messages[0].mentions, ["super-bot"]);
    assert.match(room.messages[0].text, /核查今日重点阻塞并给我推荐选项/);

    // 5. Dispatch a department task via Super Bot
    const dispatchRes = await app.request("/api/opc/executive/departments/operations/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "检查 Tailscale 节点直连状态与部署服务延迟" }),
    });
    assert.equal(dispatchRes.status, 200);
    const dispatched = (await dispatchRes.json()) as { ok: boolean; targetBotId: string; taskId: string };
    assert.equal(dispatched.ok, true);
    assert.equal(mock.tasks.length, 1);
    assert.equal(mock.tasks[0].requesterBotId, "super-bot");
    assert.equal(mock.tasks[0].targetBotId, dispatched.targetBotId);

    // 6. Toggle daily 09:00 brief cron on and off
    const onRes = await app.request("/api/opc/executive/cron/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(onRes.status, 200);
    const onStatus = (await onRes.json()) as ExecutiveStatus;
    assert.equal(onStatus.briefCron?.enabled, true);
    assert.equal(onStatus.recentTasks.length, 1);
    assert.equal(onStatus.recentTasks[0].requesterBotId, "super-bot");
  } finally {
    db.close();
    await new Promise<void>(resolve => mock.server.close(() => resolve()));
  }
});
