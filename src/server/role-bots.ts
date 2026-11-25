import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  RoleBotBlueprint,
  RoleBotCoordinateResult,
  RoleBotEnsureResult,
  RoleBotId,
  RoleBotIndex,
  RoleBotView,
} from "../role-bots-types.ts";
import { OPC_GROUP_NAME, OPC_ROOM_TITLE } from "./executive-bots.ts";
import { ApiError } from "./logic.ts";
import { StageHomeClient } from "./stage-home-client.ts";

export const DUAL_ENGINE_PRINCIPLE =
  "Coding Agent 负责产出（调研报告 / PRD / HTML 视觉设计稿 / 代码实现 / 独立评审）；需要跨阶段串联、协同调度或汇总结论待人拍板时，由 Agent Home 对应职能 Bot 统筹（有则直接复用，无则自动按契约创建）。";

export const ROLE_BOT_BLUEPRINTS: RoleBotBlueprint[] = [
  {
    id: "pm",
    roleName: "产品经理串联（PM Bot）",
    botName: "OPC 产品经理 Bot",
    botTitle: "产研流程串联 PM",
    engineRule: "PRD 与设计稿正文由 Coding Agent 写入仓库；PM Bot 负责跨阶段串联、摘要提炼、推动创始人门禁拍板与返工对齐。",
    coordinationScope: [
      "串联「每日情报 → 方向调研 → PRD 拍板 → 视觉设计稿拍板 → 隔离开发 → 独立评审」全流程",
      "在每个门禁节点提炼 Coding Agent 产出的核心结论、取舍与风险，送创始人极简拍板",
      "跟踪门禁反馈与返工单，确保上下游上下文完整传递并回写项目记录",
    ],
    matchHints: ["opc 产品经理 bot", "pm bot", "pm-bot", "产品经理"],
    faceShape: "capsule",
    faceColor: "coral",
    faceStyle: "soft",
    faceExpression: "curious",
  },
  {
    id: "research",
    roleName: "方向调研协同（Research Bot）",
    botName: "OPC 调研协同 Bot",
    botTitle: "情报与方向调研协调",
    engineRule: "结构化调研文档由 Coding Agent 落盘；跨源外部情报核实与持续追踪优先复用 Agent Home 既有调研 Bot。",
    coordinationScope: [
      "核实每日情报中的外部线索与竞品动态，输出可交叉验证的来源链接",
      "将验证后的方向候选同步给 PM Bot 与创始人进入产品规划",
    ],
    matchHints: ["research bot", "research-bot", "开源研究小助手", "opc 调研协同 bot", "调研bot"],
    faceShape: "cloud",
    faceColor: "sky",
    faceStyle: "soft",
    faceExpression: "curious",
  },
  {
    id: "design",
    roleName: "视觉与原型审阅（Design Bot）",
    botName: "OPC 视觉设计 Bot",
    botTitle: "交互与视觉稿审阅协调",
    engineRule: "可点击 HTML 视觉设计稿由 Coding Agent 直接产出；仅需跨阶段视觉走查与体验评审串联时按需建制/复用。",
    coordinationScope: [
      "对照已批准 PRD 检查视觉设计稿的关键入口、状态流转与异常恢复路径",
      "整理视觉与交互取舍选项交由创始人在设计门禁拍板",
    ],
    matchHints: ["opc 视觉设计 bot", "design bot", "design-bot", "视觉设计", "设计师"],
    faceShape: "drop",
    faceColor: "lilac",
    faceStyle: "soft",
    faceExpression: "happy",
  },
  {
    id: "qa",
    roleName: "质量与验收协同（QA / Review Bot）",
    botName: "OPC 质量评审 Bot",
    botTitle: "独立评审与回归协调",
    engineRule: "独立代码复测由隔离 Worktree 的评审 Coding Agent 执行；跨阶段回归跟踪优先复用既有评审 Bot。",
    coordinationScope: [
      "核对实现、PRD 验收样例与视觉稿一致性，汇总阻塞项与回归风险",
      "协助整理可复现返工说明并跟进复测闭环",
    ],
    matchHints: ["team reviewer", "team-reviewer", "opc 质量评审 bot", "qa bot", "测试bot"],
    faceShape: "pebble",
    faceColor: "mint",
    faceStyle: "soft",
    faceExpression: "content",
  },
];

const roleIdSchema = z.enum(["pm", "research", "design", "qa"]);
const coordinateSchema = z.strictObject({
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(5000),
  workflowId: z.string().trim().max(120).optional(),
  stage: z.string().trim().max(80).optional(),
  postToRoom: z.boolean().optional(),
});

type PersistedRoleBinding = {
  role_id: RoleBotId;
  bot_id: string;
  bot_name: string;
  action: "reused" | "created";
  matched_by: string;
  updated_at: string;
};

type RawBot = {
  id: string;
  name: string;
  title?: string;
  description?: string;
  hidden?: boolean;
};

type WorkRow = {
  bot: RawBot;
  control?: { paused?: boolean; disabled?: boolean };
  status?: string;
  activeWorkCount?: number;
};

type FunctionalGroup = { id: string; name: string; botIds: string[]; roomIds: string[] };
type BotRoom = { id: string; title: string; status: string; botIds: string[]; hostBotId?: string };

const TEST_BOT_PATTERN = /(?:^bot-stability-|^recall-trace-|召回稳定性|召回验收|验收1024)/i;

function norm(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isEphemeralTestBot(bot: RawBot): boolean {
  return Boolean(bot.hidden) || TEST_BOT_PATTERN.test(bot.id) || TEST_BOT_PATTERN.test(bot.name);
}

function matchExistingBot(bp: RoleBotBlueprint, bots: RawBot[]): { bot: RawBot; matchedBy: string } | null {
  const candidates = bots.filter(b => !isEphemeralTestBot(b));
  const exactBotName = norm(bp.botName);
  const byCanonical = candidates.find(b => norm(b.name) === exactBotName);
  if (byCanonical) return { bot: byCanonical, matchedBy: `精确匹配名称「${byCanonical.name}」` };

  for (const hint of bp.matchHints) {
    const h = norm(hint);
    const hit = candidates.find(b => norm(b.id) === h || norm(b.name) === h);
    if (hit) return { bot: hit, matchedBy: `复用已有职能 Bot「${hit.name}」` };
  }
  for (const hint of bp.matchHints) {
    const h = norm(hint);
    if (h.length < 3) continue;
    const hit = candidates.find(b => norm(b.name).includes(h) || norm(b.title ?? "").includes(h));
    if (hit) return { bot: hit, matchedBy: `按职能关键词「${hint}」复用「${hit.name}」` };
  }
  return null;
}

function buildRoleContract(bp: RoleBotBlueprint, opcOrigin: string): string {
  return [
    `你是 OPC OS 的「${bp.roleName}」（${bp.botTitle}），隶属产研与工程协同体系。`,
    `【双引擎分工原则】${bp.engineRule}`,
    `【OPC OS 工作台】产品进程（${opcOrigin}/#product）、工作流看板（${opcOrigin}/#workflows）、信息与想法（${opcOrigin}/#ideas）。`,
    `【串联与协同职责】`,
    ...bp.coordinationScope.map((item, idx) => `${idx + 1}. ${item}`),
    `【红线与汇报规范】不替 Coding Agent 手写大段代码，也不越权替创始人批准方向/PRD/设计稿/发版；只输出结构化摘要、阻塞点与明确推荐选项，供创始人高效拍板。`,
  ].join("\n");
}

function toRuntimeStatus(row: WorkRow | undefined): RoleBotView["status"] {
  if (!row) return "on_demand";
  if (row.control?.disabled) return "disabled";
  if (row.control?.paused) return "paused";
  if (Number(row.activeWorkCount ?? 0) > 0 || row.status === "running") return "running";
  return "idle";
}

export class RoleBotService {
  constructor(
    private db: DatabaseSync,
    private client: StageHomeClient,
    private opcOrigin: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_role_bots(
      role_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      bot_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('reused','created')),
      matched_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  private blueprint(roleId: RoleBotId): RoleBotBlueprint {
    const bp = ROLE_BOT_BLUEPRINTS.find(item => item.id === roleId);
    if (!bp) throw new ApiError(404, "role_bot_missing", `未知职能角色：${roleId}`);
    return bp;
  }

  private readBindings(): Map<RoleBotId, PersistedRoleBinding> {
    const rows = this.db.prepare("SELECT * FROM opc_role_bots").all() as PersistedRoleBinding[];
    return new Map(rows.map(r => [r.role_id, r]));
  }

  private saveBinding(binding: Omit<PersistedRoleBinding, "updated_at">): PersistedRoleBinding {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO opc_role_bots(role_id, bot_id, bot_name, action, matched_by, updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(role_id) DO UPDATE SET
        bot_id=excluded.bot_id, bot_name=excluded.bot_name, action=excluded.action,
        matched_by=excluded.matched_by, updated_at=excluded.updated_at`)
      .run(binding.role_id, binding.bot_id, binding.bot_name, binding.action, binding.matched_by, now);
    return { ...binding, updated_at: now };
  }

  private async ahRequest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = process.env.PPENG_TOKEN;
    if (token) headers.authorization = "Bearer " + token;
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.client.origin + path, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (!res.ok) {
      const msg = (parsed as { error?: string; message?: string } | null)?.error
        || (parsed as { message?: string } | null)?.message
        || `HTTP ${res.status}`;
      throw new ApiError(502, "agent_home_error", `Agent Home 请求失败（${path}）：${msg}`);
    }
    return parsed as T;
  }

  async status(): Promise<RoleBotIndex> {
    const bindings = this.readBindings();
    try {
      const [botsRes, workRes, groupsRes, roomsRes] = await Promise.all([
        this.ahRequest<{ bots: RawBot[] }>("/api/bots?includeHidden=1"),
        this.ahRequest<{ bots: WorkRow[] }>("/api/bot-work/status"),
        this.ahRequest<{ groups: FunctionalGroup[] }>("/api/bot-functional-groups"),
        this.ahRequest<{ rooms: BotRoom[] }>("/api/bot-rooms"),
      ]);
      const botById = new Map(botsRes.bots.map(b => [b.id, b]));
      const workById = new Map(workRes.bots.map(w => [w.bot.id, w]));
      const group = groupsRes.groups.find(g => g.name === OPC_GROUP_NAME) ?? null;
      const room = roomsRes.rooms.find(r => r.title === OPC_ROOM_TITLE && r.status === "active") ?? null;

      const roles: RoleBotView[] = ROLE_BOT_BLUEPRINTS.map(bp => {
        const saved = bindings.get(bp.id);
        const savedBot = saved ? botById.get(saved.bot_id) : undefined;
        if (saved && savedBot) {
          return {
            ...bp,
            resolution: saved.action,
            botId: savedBot.id,
            resolvedName: savedBot.name,
            matchedBy: saved.matched_by,
            status: toRuntimeStatus(workById.get(savedBot.id)),
            inGroup: Boolean(group?.botIds.includes(savedBot.id)),
            inRoom: Boolean(room?.botIds.includes(savedBot.id)),
            updatedAt: saved.updated_at,
          };
        }
        const matched = matchExistingBot(bp, botsRes.bots);
        if (matched) {
          return {
            ...bp,
            resolution: "reused",
            botId: matched.bot.id,
            resolvedName: matched.bot.name,
            matchedBy: matched.matchedBy,
            status: toRuntimeStatus(workById.get(matched.bot.id)),
            inGroup: Boolean(group?.botIds.includes(matched.bot.id)),
            inRoom: Boolean(room?.botIds.includes(matched.bot.id)),
            updatedAt: null,
          };
        }
        return {
          ...bp,
          resolution: "on_demand",
          botId: null,
          resolvedName: null,
          matchedBy: "尚未建制，流程需要串联时将自动创建",
          status: "on_demand",
          inGroup: false,
          inRoom: false,
          updatedAt: null,
        };
      });

      const web = await this.client.resolveWebOrigin();
      return {
        agentHomeReachable: true,
        agentHomeOrigin: web.webOrigin,
        principle: DUAL_ENGINE_PRINCIPLE,
        roles,
      };
    } catch (err) {
      const web = await this.client.resolveWebOrigin();
      return {
        agentHomeReachable: false,
        agentHomeOrigin: web.webOrigin,
        principle: DUAL_ENGINE_PRINCIPLE,
        roles: ROLE_BOT_BLUEPRINTS.map(bp => {
          const saved = bindings.get(bp.id);
          return {
            ...bp,
            resolution: saved ? saved.action : "on_demand",
            botId: saved?.bot_id ?? null,
            resolvedName: saved?.bot_name ?? null,
            matchedBy: saved?.matched_by ?? null,
            status: "on_demand",
            inGroup: false,
            inRoom: false,
            updatedAt: saved?.updated_at ?? null,
          };
        }),
        error: err instanceof Error ? err.message : "暂时无法连接 Agent Home",
      };
    }
  }

  async ensure(roleId: RoleBotId): Promise<RoleBotEnsureResult> {
    const bp = this.blueprint(roleId);
    const bindings = this.readBindings();
    const [botsRes, groupsRes, roomsRes] = await Promise.all([
      this.ahRequest<{ bots: RawBot[] }>("/api/bots?includeHidden=1"),
      this.ahRequest<{ groups: FunctionalGroup[] }>("/api/bot-functional-groups"),
      this.ahRequest<{ rooms: BotRoom[] }>("/api/bot-rooms"),
    ]);
    const botById = new Map(botsRes.bots.map(b => [b.id, b]));
    const group = groupsRes.groups.find(g => g.name === OPC_GROUP_NAME) ?? null;
    const room = roomsRes.rooms.find(r => r.title === OPC_ROOM_TITLE && r.status === "active") ?? null;

    const saved = bindings.get(roleId);
    const savedBot = saved ? botById.get(saved.bot_id) : undefined;

    let bot: RawBot;
    let action: "reused" | "created";
    let persistedAction: "reused" | "created";
    let matchedBy: string;

    if (saved && savedBot) {
      bot = savedBot;
      action = "reused";
      persistedAction = saved.action;
      matchedBy = `复用已绑定职能 Bot「${savedBot.name}」`;
    } else {
      const matched = matchExistingBot(bp, botsRes.bots);
      if (matched) {
        bot = matched.bot;
        action = "reused";
        persistedAction = "reused";
        matchedBy = matched.matchedBy;
      } else {
        const created = await this.ahRequest<{ bot: RawBot }>("/api/bots", {
          method: "POST",
          body: {
            name: bp.botName,
            title: bp.botTitle,
            description: buildRoleContract(bp, this.opcOrigin),
            faceShape: bp.faceShape,
            faceColor: bp.faceColor,
            faceStyle: bp.faceStyle,
            faceExpression: bp.faceExpression,
          },
        });
        bot = created.bot;
        action = "created";
        persistedAction = "created";
        matchedBy = `未发现现成 ${bp.roleName}，已按契约自动建制`;
      }
    }

    let inGroup = Boolean(group?.botIds.includes(bot.id));
    if (group && !inGroup) {
      await this.ahRequest(`/api/bot-functional-groups/${encodeURIComponent(group.id)}`, {
        method: "PATCH",
        body: { botIds: [...new Set([...group.botIds, bot.id])] },
      }).catch(() => {});
      inGroup = true;
    }

    let inRoom = Boolean(room?.botIds.includes(bot.id));
    if (room && !inRoom) {
      await this.ahRequest(`/api/bot-rooms/${encodeURIComponent(room.id)}/bots`, {
        method: "POST",
        body: { botId: bot.id },
      }).catch(() => {});
      inRoom = true;
    }

    this.saveBinding({ role_id: roleId, bot_id: bot.id, bot_name: bot.name, action: persistedAction, matched_by: matchedBy });
    return { roleId, action, botId: bot.id, botName: bot.name, matchedBy, inGroup, inRoom };
  }

  async coordinate(roleId: RoleBotId, rawInput: unknown): Promise<RoleBotCoordinateResult> {
    const parsed = coordinateSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ApiError(400, "role_bot_input", "请提供串联任务的标题与摘要说明。");
    }
    const ensured = await this.ensure(roleId);
    const { title, summary, workflowId, stage, postToRoom } = parsed.data;
    const promptLines = [
      `【OPC OS 流程串联调度 · ${this.blueprint(roleId).roleName}】`,
      `事项：${title}`,
      ...(stage ? [`当前阶段：${stage}`] : []),
      ...(workflowId ? [`工作流直达：${this.opcOrigin}/#workflows/${workflowId}`] : []),
      `上下文与待协同内容：\n${summary}`,
      "请核对上游 Coding Agent 产出摘要，提炼核心取舍与风险，并给出 1 条清晰推荐决定（批准 / 要求修改 / 拒绝）供创始人高效拍板。",
    ];
    const inputText = promptLines.join("\n\n");

    const taskRes = await this.ahRequest<{ task?: { id: string }; id?: string }>("/api/bot-work/tasks", {
      method: "POST",
      body: { targetBotId: ensured.botId, input: inputText },
    });
    const taskId = taskRes.task?.id ?? taskRes.id ?? "";

    let roomPosted = false;
    let roomId: string | null = null;
    if (postToRoom !== false) {
      const roomsRes = await this.ahRequest<{ rooms: BotRoom[] }>("/api/bot-rooms").catch(() => ({ rooms: [] }));
      const room = roomsRes.rooms.find(r => r.title === OPC_ROOM_TITLE && r.status === "active");
      if (room) {
        roomId = room.id;
        await this.ahRequest(`/api/bot-rooms/${encodeURIComponent(room.id)}/messages`, {
          method: "POST",
          body: {
            content: `@${ensured.botName} 请串联跟进「${title}」${stage ? `（阶段：${stage}）` : ""}，并向创始人汇总拍板要点。${workflowId ? `\n直达工作流：${this.opcOrigin}/#workflows/${workflowId}` : ""}`,
          },
        }).then(() => { roomPosted = true; }).catch(() => {});
      }
    }

    return { ...ensured, taskId, roomPosted, roomId };
  }
}

export function registerRoleBotRoutes(
  app: Hono,
  db: DatabaseSync,
  user: (c: Context) => unknown,
  options: { client?: StageHomeClient; opcOrigin?: string } = {},
) {
  const client = options.client ?? new StageHomeClient();
  const opcOrigin = (options.opcOrigin ?? process.env.KUNLUN_URL ?? `http://127.0.0.1:${process.env.PORT ?? "52328"}`).replace(/\/+$/, "");
  const service = new RoleBotService(db, client, opcOrigin);
  const base = "/api/opc/role-bots";

  app.use(base, async (c, next) => { user(c); c.header("Cache-Control", "no-store"); await next(); });
  app.use(base + "/*", async (c, next) => { user(c); c.header("Cache-Control", "no-store"); await next(); });

  app.get(base, async c => c.json(await service.status()));
  app.post(`${base}/:role/ensure`, async c => {
    const role = roleIdSchema.safeParse(c.req.param("role"));
    if (!role.success) throw new ApiError(400, "role_bot_invalid", "不支持的职能角色（仅支持 pm / research / design / qa）。");
    return c.json(await service.ensure(role.data));
  });
  app.post(`${base}/:role/coordinate`, async c => {
    const role = roleIdSchema.safeParse(c.req.param("role"));
    if (!role.success) throw new ApiError(400, "role_bot_invalid", "不支持的职能角色（仅支持 pm / research / design / qa）。");
    return c.json(await service.coordinate(role.data, await c.req.json().catch(() => ({}))));
  });
  return service;
}
