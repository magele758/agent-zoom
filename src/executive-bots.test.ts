import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { ExecutiveMailboxResponse, ExecutiveStatus } from "./executive-bots-types.ts";
import type { ZoomMessage } from "./zoom-types.ts";
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
  type Room = {
    id: string;
    title: string;
    status: string;
    botIds: string[];
    hostBotId: string;
    replyMode: string;
    messages: Array<{ id: string; text: string; mentions: string[]; replyTo?: unknown; createdAt: string; sender: { type: "user" | "bot"; id: string; name: string } }>;
  };
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
  const deliveries = new Map<string, unknown>();
  const detailReads = new Map<string, number>();
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
    if (roomMsgMatch && method === "GET") {
      const room = rooms.get(decodeURIComponent(roomMsgMatch[1]));
      if (!room) return sendJson(res, 404, { error: "not found" });
      const before = Number(url.searchParams.get("beforeSeq") ?? room.messages.length + 1);
      const end = before - 1;
      const start = Math.max(0, end - Number(url.searchParams.get("limit") ?? 50));
      return sendJson(res, 200, { messages: room.messages.slice(start, end), hasMore: start > 0, nextCursor: start > 0 ? start + 1 : null });
    }
    if (roomMsgMatch && method === "POST") {
      const room = rooms.get(decodeURIComponent(roomMsgMatch[1]));
      if (!room) return sendJson(res, 404, { error: "not found" });
      const msg = {
        id: `msg-${++seq}`,
        text: String(body.text ?? ""),
        replyTo: body.replyTo,
        mentions: Array.isArray(body.mentions) ? body.mentions.map(String) : [],
        createdAt: new Date().toISOString(),
        sender: { type: "user" as const, id: "user-1", name: "Founder" },
      };
      room.messages.push(msg);
      return sendJson(res, 201, { message: msg });
    }
    const roomTurnMatch = /^\/api\/bot-rooms\/([^/]+)\/turns$/.exec(path);
    if (roomTurnMatch && method === "GET") {
      return sendJson(res, 200, { turns: [] });
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
    if (method === "GET" && path.startsWith("/api/bot-work/tasks/")) {
      const id = decodeURIComponent(path.slice("/api/bot-work/tasks/".length));
      detailReads.set(id, (detailReads.get(id) ?? 0) + 1);
      if (!deliveries.has(id)) return sendJson(res, 503, {error:"unavailable"});
      return sendJson(res, 200, {task: {...tasks.find(task => task.id === id), delivery: deliveries.get(id)}});
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

  return { server, bots, groups, rooms, tasks, crons, sharedContext, deliveries, detailReads };
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
    CREATE TABLE zoom_tasks(id TEXT,external_id TEXT,source TEXT,folder TEXT);
    CREATE TABLE zoom_messages(id TEXT,task_id TEXT,event_key TEXT,kind TEXT);
    CREATE TABLE opc_patrol_runs(id TEXT,created_at TEXT,alerts_json TEXT,notified_zoom INTEGER);
    CREATE TABLE opc_planning_tasks(id TEXT,title TEXT,project TEXT,status TEXT,latest_run_id TEXT,updated_at TEXT);
    CREATE TABLE opc_decision_packets(id TEXT,status TEXT,options_json TEXT,background_summary TEXT,domain TEXT,kind TEXT,dedupe_key TEXT);
    CREATE TABLE stage_home_bindings(work_id TEXT,bot_id TEXT,connection TEXT,brief TEXT,receipt TEXT);
    CREATE TABLE stage_work(task_id TEXT,brief TEXT);
    CREATE TABLE opc_delegations(id TEXT,user_id TEXT,source_id TEXT,source TEXT,evidence TEXT,created_at TEXT,work_id TEXT);
    INSERT INTO zoom_tasks VALUES('patrol-task','patrol-2026-11-24','OPC OS · 后台巡检卫士','公司/巡检告警');
    INSERT INTO zoom_messages VALUES('patrol-alert','patrol-task','patrol-report-2026-11-24-ptr_test','question');
    INSERT INTO opc_planning_tasks VALUES('plan','原始任务','project','failed',NULL,'2026-11-23T00:00:00.000Z');
  `);

  const app = new Hono();
  const fakeUser = { type: "user" as const, id: "user-1", name: "Founder" };
  const localPatrol: ZoomMessage = { id:"patrol-alert",taskId:"patrol-task",taskTitle:"巡检告警",kind:"question",origin:"external",
    source:"OPC OS · 后台巡检卫士",folder:"公司/巡检告警",at:"2026-11-24T02:00:00.000Z",pending:true,body:"原始通知" };
  db.prepare("INSERT INTO opc_patrol_runs VALUES('ptr_test',?,?,1)").run(localPatrol.at, JSON.stringify([
    {taskId:"plan",title:"原始任务",project:"project",status:"failed",updatedAt:"2026-11-23T00:00:00.000Z"},
  ]));
  db.prepare("INSERT INTO opc_decision_packets VALUES('dec-linked','pending',?,'巡检背景','product','patrol_alert','product:patrol:2026-11-24')").run(JSON.stringify([
    {id:"requeue",label:"重试",handlerKey:"product.patrol_requeue",payload:{taskIds:["plan"],patrolRunId:"ptr_test"}},
  ]));
  const client = new StageHomeClient({ PPENG_BASE_URL: origin });
  const service = registerExecutiveBotRoutes(app, db, () => fakeUser, {
    client,
    opcOrigin: "http://127.0.0.1:52328",
    traceMessages: () => [localPatrol],
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
    assert.match(mock.bots.get("super-bot")!.description, /三不留/);
    assert.equal(mock.sharedContext.size, 1);
    const groupCtx = [...mock.sharedContext.values()][0];
    assert.match(groupCtx["opc-data-sovereignty-policy"] ?? "", /三不留/);
    assert.match(groupCtx["opc-data-sovereignty-policy"] ?? "", /opc:backup/);
    const opsDept = after.departments.find(d => d.id === "operations")!;
    const secDept = after.departments.find(d => d.id === "security")!;
    const rdBootDept = after.departments.find(d => d.id === "rd")!;
    assert.match(mock.bots.get(opsDept.runtime.botId!)!.description, /三不留/);
    assert.match(mock.bots.get(secDept.runtime.botId!)!.description, /三不留/);
    assert.match(mock.bots.get(rdBootDept.runtime.botId!)!.description, /三不留/);

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

    // 7. Mailbox aggregates inbound Super Bot briefs + department reports, tracks unread/read, and sends founder replies
    room.messages.push({
      id: "msg-bot-brief-1",
      text: "## 今日 OPC 总裁简报\n1. 五部状态绿灯\n2. 需创始人拍板：是否批准 PageLens 定价调整？" + "🌱".repeat(120),
      mentions: [],
      createdAt: new Date(Date.now() + 1000).toISOString(),
      sender: { type: "bot", id: "super-bot", name: "Super Bot" },
    });
    room.messages.push({ ...room.messages.at(-1)!, id: "no-approval", text: "需创始人拍板的审批项：无。" });
    const prior = mock.tasks[0];
    mock.tasks.push(
      {...prior, id:"with-delivery", status:"completed", result:"请批准采购方案。"},
      {...prior, id:"interrupted", status:"cancelled", result:"请批准采购方案。"},
      {...prior, id:"only-a-plan", status:"completed", result:"我先核对是否批准追加预算。"},
      {...prior, id:"linked-terminal", status:"completed", result:"任务巡检完成。"},
      {...prior, id:"linked-working", status:"running"},
    );
    for (const id of ["linked-terminal", "linked-working"]) {
      db.prepare("INSERT INTO stage_home_bindings VALUES(?,?,?,?,?)").run(`work-${id}`, prior.targetBotId, client.identity, prior.input, JSON.stringify({remoteId:id}));
      db.prepare("INSERT INTO stage_work VALUES(?,?)").run(`work-${id}`, JSON.stringify({title:"核查工单",goal:"排查失败原因",deliverable:"附证据"}));
      db.prepare("INSERT INTO opc_delegations VALUES(?,?,?,?,?,?,?)").run(`deleg-${id}`,fakeUser.id,localPatrol.id,
        JSON.stringify({id:localPatrol.id,kind:"message",title:localPatrol.taskTitle,taskId:localPatrol.taskId}),"[]",localPatrol.at,`work-${id}`);
    }
    mock.deliveries.set("with-delivery", {taskId:"with-delivery", report:"执行结论：核对完毕。请批准采购方案。",
      artifacts:[{id:"file-1",fileName:"report.pdf"}]});
    mock.deliveries.set("linked-terminal", {taskId:"linked-terminal",report:"任务巡检完成。",artifacts:[{id:"file-2",fileName:"inspection.pdf"}]});
    const mailRes = await app.request("/api/opc/executive/mailbox");
    assert.equal(mailRes.status, 200);
    const mail = (await mailRes.json()) as ExecutiveMailboxResponse;
    assert.equal(mail.agentHomeReachable, true);
    assert.equal(mail.sourceTraces?.[localPatrol.id]?.origin?.messageId, localPatrol.id);
    const inbound = mail.items.find(i => i.id === "room:msg-bot-brief-1");
    assert.ok(inbound);
    assert.equal(inbound.direction, "inbound");
    assert.equal(inbound.read, false);
    assert.equal(inbound.needsDecision, true, "explicit Bot requests still surface for clarification");
    assert.equal(inbound.trace?.decision, undefined, "the Bot's words cannot grant an executable approval");
    assert.equal(inbound.subject, "今日 OPC 总裁简报");
    const receipt = mail.items.find(i => i.id === "task:with-delivery");
    assert.match(receipt?.trace?.result ?? "", /核对完毕/);
    assert.deepEqual(receipt?.trace?.evidence,["report.pdf · file-1"]);
    assert.equal(receipt?.needsDecision,true);
    assert.equal(receipt?.trace?.decision,undefined);
    assert.equal(mail.items.find(i => i.id === "room:no-approval")?.needsDecision,false);
    assert.equal(mail.items.find(i => i.id === "task:interrupted")?.needsDecision,false);
    assert.equal(mail.items.find(i => i.id === "task:only-a-plan")?.needsDecision,false);
    assert.equal(mail.items.find(i => i.id === "task:interrupted")?.trace?.deliveryUnavailable,true);
    const linked = mail.items.find(i => i.id === "task:linked-terminal");
    assert.equal(linked?.trace?.decisionId, "dec-linked");
    assert.equal(linked?.trace?.decision?.actionable, true);
    assert.equal(linked?.historical, undefined);
    assert.deepEqual(linked?.trace?.evidence, ["inspection.pdf · file-2"]);
    assert.deepEqual(db.prepare("SELECT mail_id FROM opc_executive_mail_history").all().map(row => row.mail_id), ["task:linked-terminal"]);

    // Mark read -> persisted
    const readRes = await app.request(`/api/opc/executive/mailbox/${encodeURIComponent(inbound.id)}/read`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    assert.equal(readRes.status, 200);
    assert.equal(service.cachedMailbox(fakeUser)?.items.find(i => i.id === inbound.id)?.read, true);
    const mailAfterRead = (await (await app.request("/api/opc/executive/mailbox")).json()) as ExecutiveMailboxResponse;
    assert.equal(mailAfterRead.items.find(i => i.id === inbound.id)?.read, true);
    assert.equal(mock.detailReads.get("with-delivery"),1, "the mailbox reuses a verified terminal delivery for this version");

    mock.deliveries.delete("linked-terminal");
    const failedDetailRoutes = registerExecutiveBotRoutes(new Hono(), db, () => fakeUser, {
      client,
      traceMessages: () => [localPatrol],
    });
    const failedDetail = await failedDetailRoutes.mailbox(fakeUser);
    const retained = failedDetail.items.find(i => i.id === "task:linked-terminal");
    assert.notEqual(retained?.trace?.deliveryUnavailable, true);
    assert.deepEqual(retained?.trace?.evidence, ["inspection.pdf · file-2"]);
    assert.deepEqual(
      (db.prepare("SELECT mail_id FROM opc_executive_mail_history").all() as Array<{ mail_id: string }>).map(r => r.mail_id),
      ["task:linked-terminal"],
    );
    mock.deliveries.set("linked-terminal", {taskId:"linked-terminal",report:"任务巡检完成。",artifacts:[{id:"file-2",fileName:"inspection.pdf"}]});

    // The live API's recent window no longer includes the old linked receipts.
    // The completed one persists, while an older approval and a still-running task do not reappear.
    service.setMailRead(fakeUser, "task:linked-terminal", {read:true});
    for (const id of ["linked-terminal", "linked-working"]) mock.tasks.splice(mock.tasks.findIndex(t => t.id === id),1);
    db.exec("UPDATE opc_decision_packets SET status='approved'; UPDATE opc_planning_tasks SET status='todo'");
    const rolled = await service.mailbox(fakeUser);
    const historical = rolled.items.find(i => i.id === "task:linked-terminal");
    assert.equal(historical?.historical, true);
    assert.equal(historical?.read, true);
    assert.equal(historical?.needsDecision, false);
    assert.equal(historical?.trace?.decision?.status, "approved");
    assert.equal(historical?.trace?.decision?.actionable, false);
    assert.equal(historical?.trace?.affectedTasks[0].status, "todo");
    assert.deepEqual(historical?.trace?.evidence, ["inspection.pdf · file-2"]);
    assert.equal(rolled.items.some(i => i.id === "task:linked-working"), false);

    // Founder approves directly from mailbox -> posts @super-bot reply
    for (let i = 0; i < 201; i++) room.messages.push({ ...room.messages.at(-1)!, id: "later-" + i, text: "其他来信" });
    const replyRes = await app.request("/api/opc/executive/mailbox/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "同意按方案执行",
        action: "approve",
        replyToMessageId: "msg-bot-brief-1",
      }),
    });
    assert.equal(replyRes.status, 200);
    assert.match(room.messages.at(-1)!.text, /【创始人批示：批准执行】/);
    assert.deepEqual(room.messages.at(-1)!.mentions, ["super-bot"]);
    const originalExcerpt = [...inbound.body.replace(/\s+/g, " ").trim()].slice(0, 120).join("");
    assert.deepEqual(room.messages.at(-1)!.replyTo, { messageId: inbound.messageId, botId: inbound.senderId, excerpt: originalExcerpt });

    // 8. Cross-department Coding-Agent call request routes from requesting department bot -> RD bot
    const commercialDept = after.departments.find(d => d.id === "commercial")!;
    const rdDept = after.departments.find(d => d.id === "rd")!;
    const commercialBot = mock.bots.get(commercialDept.runtime.botId!)!;
    assert.ok(commercialBot.description.includes(rdDept.runtime.botId!), "non-RD department contract embeds RD botId");

    const reqRes = await app.request("/api/opc/executive/coding-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requesterDept: "commercial",
        title: "着陆页补齐 UTM 埋点",
        repo: "opc-gtm-kit",
        objective: "把来源参数透传至候补接口并补单元测试",
        acceptance: "单测全绿并回传 diff",
        priority: "high",
      }),
    });
    assert.equal(reqRes.status, 201);
    const createdReq = (await reqRes.json()) as { id: string; taskId: string; status: string };
    assert.equal(createdReq.status, "queued");
    const dispatchedTask = mock.tasks.find(t => t.id === createdReq.taskId)!;
    assert.equal(dispatchedTask.requesterBotId, commercialDept.runtime.botId);
    assert.equal(dispatchedTask.targetBotId, rdDept.runtime.botId);

    // Simulate RD bot completing the coding request -> status syncs report back
    dispatchedTask.status = "completed";
    dispatchedTask.result = "已调度 Coding-Agent 资源组完成实现与单测，交付验收通过。";
    const statusAfterReq = (await (await app.request("/api/opc/executive/status")).json()) as ExecutiveStatus;
    const synced = statusAfterReq.codingRequests.find(r => r.id === createdReq.id)!;
    assert.equal(synced.status, "completed");
    assert.match(synced.report, /Coding-Agent 资源组/);

    // The sidebar refresh shares an in-flight mailbox read; the local patrol
    // source remains visible even when the remote Bot service is unavailable.
    const activeRead = service.mailbox(fakeUser);
    assert.equal(service.mailbox(fakeUser), activeRead);
    await activeRead;
    mock.bots.delete("super-bot");
    const disconnected = await service.mailbox(fakeUser);
    assert.equal(disconnected.agentHomeReachable, false);
    assert.equal(disconnected.sourceTraces?.[localPatrol.id]?.origin?.messageId, localPatrol.id);
    assert.equal(disconnected.items.length, 1);
    assert.equal(service.cachedMailbox(fakeUser)?.items[0].historical, true);
    const restarted = registerExecutiveBotRoutes(new Hono(), db, () => fakeUser, {client, traceMessages: () => [localPatrol]});
    const afterRestart = await restarted.mailbox(fakeUser);
    assert.equal(afterRestart.items.length, 1);
    assert.equal(afterRestart.items[0].id,"task:linked-terminal");
    assert.deepEqual(afterRestart.items[0].trace?.evidence,["inspection.pdf · file-2"]);
    assert.equal((await restarted.mailbox({...fakeUser,id:"other-user"})).items.length,0);
    const changedConnection = registerExecutiveBotRoutes(new Hono(),db,()=>fakeUser,{client:new StageHomeClient({PPENG_BASE_URL:origin,PPENG_TOKEN:"different-test-identity"})});
    assert.equal((await changedConnection.mailbox(fakeUser)).items.length,0);
  } finally {
    db.close();
    await new Promise<void>(resolve => mock.server.close(() => resolve()));
  }
});
