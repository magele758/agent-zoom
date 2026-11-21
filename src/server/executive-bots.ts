import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  ExecutiveBotRuntime,
  ExecutiveDepartmentBlueprint,
  ExecutiveDepartmentId,
  ExecutiveDepartmentView,
  ExecutiveStatus,
  ExecutiveTaskItem,
} from "../executive-bots-types.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import { ApiError, type Principal } from "./logic.ts";
import { StageHomeClient } from "./stage-home-client.ts";

type User = Extract<Principal, { type: "user" }>;

export const OPC_GROUP_NAME = "OPC 一人公司部门管理";
export const OPC_ROOM_TITLE = "OPC 总裁办 · Super Bot 总控群";
export const OPC_CRON_NAME = "OPC 每日总裁晨报（Super Bot 汇总五部）";

const CONTRACT_START = "【OPC 总裁办分级管理契约】";
const CONTRACT_END = "【/OPC 总裁办分级管理契约】";

export const EXECUTIVE_DEPARTMENTS: ExecutiveDepartmentBlueprint[] = [
  {
    id: "commercial",
    botName: "OPC 商业与增长部 Bot",
    botTitle: "商业与增长 VP",
    departmentName: "商业与增长部",
    summary: "统筹公司业务线、1 号商业试点、收银与离线授权、产品门面合规、GTM 获客与 DuckDB 漏斗复盘。",
    faceShape: "pebble",
    faceColor: "coral",
    faceStyle: "soft",
    faceExpression: "happy",
    ownedPages: [
      { label: "商业与治理部", href: "#commercial" },
      { label: "公司业务线", href: "#business-lines" },
      { label: "渠道转化", href: "#growth" },
    ],
    autonomousScope: [
      "日常巡检 1 号商业试点 7 步清单进度、候补名单、激活率与订单/离线 License 签发状态",
      "整理各渠道推广素材草稿、跟进客服工单 L1 分诊与 DuckDB 转化漏斗同步",
      "将已核实的经营进展与阻塞汇总上报给 Super Bot，不直接拿琐碎进度打扰创始人",
    ],
    approvalRedlines: [
      "产品定价、促销折扣或收费模式调整",
      "涉及资金退回的人工退款放行",
      "对外公开渠道正式发布（公众号 / 小红书 / 商店上架提交）",
      "新增或关停公司级业务线",
    ],
    defaultPatrolPrompt:
      "请执行商业与增长部例行巡检：核查 1 号商业试点当前完成度、订单/离线授权、获客激活漏斗、待办工单与各业务线实验状态；提炼 3 条以内核心结论、当前最大卡点及是否需要创始人拍板的事项，简明回报给 Super Bot。",
  },
  {
    id: "rd",
    botName: "OPC 产研与工程部 Bot",
    botTitle: "产研与工程 VP",
    departmentName: "产研与工程部",
    summary: "统筹信息与想法孵化、研发选题排序、项目目录、13 阶产品进程、开源能力复用与多 Agent 交付流水线。",
    faceShape: "capsule",
    faceColor: "mint",
    faceStyle: "soft",
    faceExpression: "curious",
    ownedPages: [
      { label: "研发选题", href: "#opportunities" },
      { label: "产品进程", href: "#product" },
      { label: "项目目录", href: "#projects" },
      { label: "开源能力", href: "#capabilities" },
      { label: "工作流看板", href: "#workflows" },
    ],
    autonomousScope: [
      "收集每日情报/想法线索并按影响力×信心×成本排序进入研发选题候选池",
      "推进已批准工作流的编码、测试、独立评审与开源能力跨仓复用核查",
      "跟踪各核心产品仓库未关闭 PR/Issue 与 13 阶段任务水位，向 Super Bot 汇报交付健康度",
    ],
    approvalRedlines: [
      "重大新产品立项或主线研发方向切换",
      "工作流多步执行计划批准与最终验收发布",
      "跨仓库破坏性重构或对外公开发版",
    ],
    defaultPatrolPrompt:
      "请执行产研与工程部例行巡检：梳理当前待推进的研发选题、运行中/阻塞的工作流、各产品 13 阶水位与近期未关闭 PR/Issue；区分「已可自治推进」和「需创始人拍板」两类，简明回报给 Super Bot。",
  },
  {
    id: "operations",
    botName: "OPC 运维与基础设施部 Bot",
    botTitle: "运维与基础设施 VP",
    departmentName: "运维与基础设施部",
    summary: "统筹 Tailscale 机器集群、本机与远端部署服务探针、Tailscale Serve 暴露路由、服务台账与版本升级验证。",
    faceShape: "cloud",
    faceColor: "sky",
    faceStyle: "soft",
    faceExpression: "content",
    ownedPages: [
      { label: "运维部门", href: "#operations-department" },
      { label: "会话与仓库索引", href: "#activity-index" },
    ],
    autonomousScope: [
      "只读巡检 Tailscale 机器在线/直连 vs 中继状态、CPU/内存/GPU 显存与各部署服务毫秒延迟",
      "发现服务不可达或退化为 DERP 中继时，先只读定位根因并拟好恢复方案",
      "持续同步服务探针状态到服务台账并向 Super Bot 汇报集群 SLA",
    ],
    approvalRedlines: [
      "生产常驻服务版本升级切换或重启核心进程",
      "修改 Tailscale Serve 暴露端口、公网/内网转发或防火墙规则",
      "清理或删除远端工作区与持久化数据",
    ],
    defaultPatrolPrompt:
      "请执行运维与基础设施部例行巡检：核查 Tailscale 集群各节点在线与直连/中继状态、GPU/内存负载及全部部署服务可用性；列出异常端点、根因判断与最小修复建议，简明回报给 Super Bot。",
  },
  {
    id: "security",
    botName: "OPC 安全与合规部 Bot",
    botTitle: "安全与合规 VP",
    departmentName: "安全与合规部",
    summary: "统筹项目发版前安全评审、整改复核、Chrome 商店 MV3 权限合规、开源许可证审计与公开仓库脱敏门禁。",
    faceShape: "drop",
    faceColor: "lilac",
    faceStyle: "soft",
    faceExpression: "neutral",
    ownedPages: [
      { label: "安全部门", href: "#security-department" },
      { label: "商业与治理部", href: "#commercial" },
    ],
    autonomousScope: [
      "核查待审查与待复核的安全评审单，跟踪整改证据是否达标",
      "例行扫描公开仓库是否误入本机路径、凭据、Webhook 或 AGPL 传染依赖",
      "核对插件 MV3 最小权限声明、隐私政策与退款条款完备性",
    ],
    approvalRedlines: [
      "发现高危凭据泄露、越权访问或安全阻断必须立即经 Super Bot 红色上报",
      "扩大产品权限范围或带已知风险例外放行发版必须由创始人签字批准",
    ],
    defaultPatrolPrompt:
      "请执行安全与合规部例行巡检：盘点当前待审查/待整改的安全项、公开仓库隐私门禁及插件商店合规风险；无风险则报绿灯，有高危或阻断项给出处置建议并立即回报 Super Bot。",
  },
  {
    id: "resources",
    botName: "OPC 资源与财务部 Bot",
    botTitle: "资源与财务 VP",
    departmentName: "资源与财务部",
    summary: "统筹各 AI 订阅套餐余量与重置窗口、月度订阅账单、工作投入账本以及产品营收净毛利核算。",
    faceShape: "bean",
    faceColor: "butter",
    faceStyle: "soft",
    faceExpression: "wink",
    ownedPages: [
      { label: "资源成本部门", href: "#resource-department" },
      { label: "工作投入", href: "#worklog" },
    ],
    autonomousScope: [
      "监控 Codex / Cursor / Antigravity / Grok 等套餐余量、重置窗口与近 7 天真实调用消耗",
      "识别低于 15% 的额度预警或登录态过期（如 HTTP 401）并提醒及时处理",
      "汇总月度订阅固定成本与产品营收净毛利对比，形成财务简报给 Super Bot",
    ],
    approvalRedlines: [
      "新增、升级或取消付费订阅套餐",
      "开启按需超额计费（On-Demand）或调高月度预算上限",
      "单月算力或云成本超过既定预算阈值",
    ],
    defaultPatrolPrompt:
      "请执行资源与财务部例行巡检：核对各 AI 模型套餐剩余额度、重置时间、登录态失效提醒及月度固定订阅成本与营收毛利对比；只提炼预警项和需创始人批准的预算建议，回报给 Super Bot。",
  },
];

function buildDepartmentDescription(bp: ExecutiveDepartmentBlueprint, superBotId: string, opcOrigin: string): string {
  return [
    `你是「${bp.departmentName}」负责人（${bp.botTitle}），向 OPC 总控协调者 Super Bot（${superBotId}）汇报。`,
    `【核心使命】${bp.summary}`,
    `【OPC OS 管理界面】${bp.ownedPages.map(p => `${p.label}（${opcOrigin}/${p.href}）`).join("、")}`,
    `【日常自治范围（无需打扰创始人，直接查证并推进）】`,
    ...bp.autonomousScope.map((s, i) => `${i + 1}. ${s}`),
    `【必须上报 Super Bot 请求创始人审批的红线（严禁擅自越权执行）】`,
    ...bp.approvalRedlines.map((r, i) => `${i + 1}. ${r}`),
    `【汇报格式要求】向 Super Bot 汇报时必须极其精炼，固定按三段输出：① 本部门状态灯（🟢正常 / 🟡需关注 / 🔴阻塞）与 3 条以内关键事实；② 已自治推进事项；③ 需创始人拍板的审批项（给出 1 个明确推荐选项 + 风险一句话，无则写「无」）。`,
  ].join("\n");
}

function buildSuperBotContract(deptRows: Array<{ bp: ExecutiveDepartmentBlueprint; botId: string }>, roomTitle: string): string {
  const roster = deptRows.map(
    ({ bp, botId }) => `- ${bp.departmentName}：${bp.botName}（botId: ${botId}）— ${bp.summary}`,
  );
  return [
    CONTRACT_START,
    "你是创始人的一人公司（OPC）总裁办总控 COO，是创始人唯一需要日常对接的管理总口。",
    "你的核心价值是「替创始人挡住 90% 的执行细节」：日常拆解任务并分别委派给以下 5 位大部门 Bot，收集核对他们的结果，只在需要创始人做战略/资金/发版/高危权限拍板时整理成极简审批单呈报。",
    "【下辖五大部门 Bot 通讯录】",
    ...roster,
    `【总控协同群】${roomTitle}（群内由你主控协调，按问题归属点名对应部门 Bot 查证执行，再由你统一向创始人总结）。`,
    "【创始人汇报与审批协议】",
    "1. 使用 bot_team_status、bot_delegate、bot_task_results 调度上述 5 位部门 Bot，禁止自己替代部门猜数据，必须基于部门回执与本机实证汇报。",
    "2. 向创始人呈报「总裁简报」时严格控制在 1 屏以内：只呈现 ① 公司整体绿/黄/红灯；② 关键变化 Top 3；③ 需创始人拍板的审批清单（每项标明：事项、推荐选项、影响与风险、回复「批准/拒绝」即可）。",
    "3. 严禁替创始人越权批准资金、定价、公开发布、生产高危变更或绕过任何部门安全门禁。",
    CONTRACT_END,
  ].join("\n");
}

export function mergeSuperBotDescription(existing: string, contract: string): string {
  const trimmed = existing.trim();
  const startIdx = trimmed.indexOf(CONTRACT_START);
  const endIdx = trimmed.indexOf(CONTRACT_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = trimmed.slice(0, startIdx).trimEnd();
    const after = trimmed.slice(endIdx + CONTRACT_END.length).trimStart();
    return [before, contract, after].filter(Boolean).join("\n\n");
  }
  return trimmed ? `${trimmed}\n\n${contract}` : contract;
}

const dispatchSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(6000),
  postToRoom: z.boolean().optional(),
});

const briefSchema = z.strictObject({
  focus: z.string().trim().max(4000).optional(),
  mode: z.enum(["room", "task"]).optional(),
});

const cronToggleSchema = z.strictObject({
  enabled: z.boolean(),
});

type PersistedExecutiveConfig = {
  superBotId: string;
  groupId: string | null;
  roomId: string | null;
  cronJobId: string | null;
  departmentBotIds: Partial<Record<ExecutiveDepartmentId, string>>;
  updatedAt: string;
};

type AgentHomeRawBot = {
  id: string;
  name: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  functionalGroupId?: string | null;
};

type AgentHomeWorkRow = {
  bot: AgentHomeRawBot;
  control?: { paused?: boolean; disabled?: boolean };
  status?: string;
  pending?: number;
  taskCounts?: Record<string, number>;
  activeWorkCount?: number;
};

type AgentHomeRoom = {
  id: string;
  title: string;
  status: string;
  botIds: string[];
  hostBotId?: string;
  replyMode?: string;
};

type AgentHomeTask = {
  id: string;
  requesterBotId?: string;
  targetBotId: string;
  input: string;
  status: string;
  result?: string;
  failureReason?: string;
  updatedAt: string;
  delivery?: { report?: string };
};

type AgentHomeCronJob = {
  id: string;
  name: string;
  botId?: string;
  agentId?: string;
  scheduleValue?: string;
  enabled: boolean;
  nextRunAt?: string | null;
};

export type ExecutivePulseProvider = () => Promise<{
  companyPulse: ExecutiveStatus["companyPulse"];
  departmentHighlights: Record<ExecutiveDepartmentId, string[]>;
  snapshotText: string;
}>;

export class ExecutiveBotService {
  constructor(
    private db: DatabaseSync,
    private client: StageHomeClient,
    private opcOrigin: string,
    private pulseProvider?: ExecutivePulseProvider,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_executive_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  private readConfig(): PersistedExecutiveConfig | null {
    const row = this.db.prepare("SELECT config FROM opc_executive_state WHERE singleton=1").get() as { config?: string } | undefined;
    if (!row?.config) return null;
    try {
      return JSON.parse(row.config) as PersistedExecutiveConfig;
    } catch {
      return null;
    }
  }

  private saveConfig(config: PersistedExecutiveConfig) {
    const now = new Date().toISOString();
    config.updatedAt = now;
    this.db.prepare(`INSERT INTO opc_executive_state(singleton, config, updated_at) VALUES(1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at`).run(JSON.stringify(config), now);
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
      const msg = (parsed as { error?: string; message?: string } | null)?.error || (parsed as { message?: string } | null)?.message || `HTTP ${res.status}`;
      throw new ApiError(502, "agent_home_error", `Agent Home 请求失败（${path}）：${msg}`);
    }
    return parsed as T;
  }

  private isDelegationRoutedTo(user: User, superBotId: string): boolean {
    try {
      const row = this.db.prepare("SELECT preference FROM opc_delegate_preferences WHERE user_id=?").get(user.id) as { preference?: string } | undefined;
      if (!row?.preference) return false;
      const pref = JSON.parse(row.preference) as { via?: string; target?: string };
      return pref.via === "agent-home" && pref.target === superBotId;
    } catch {
      return false;
    }
  }

  private isRoomLinkedDefault(roomId: string): boolean {
    try {
      const row = this.db.prepare("SELECT remote_room FROM opc_home_chat_links WHERE scope_key='default' AND connection=?").get(this.client.identity) as { remote_room?: string } | undefined;
      return row?.remote_room === roomId;
    } catch {
      return false;
    }
  }

  async status(user: User): Promise<ExecutiveStatus> {
    const pulse = this.pulseProvider
      ? await this.pulseProvider().catch(() => null)
      : null;
    const companyPulse = pulse?.companyPulse ?? {
      pendingApprovals: 0,
      onlineMachines: 0,
      totalMachines: 0,
      healthyServices: 0,
      totalServices: 0,
      pilotCompletionPct: 0,
      pilotProduct: "",
      openSecurityReviews: 0,
    };
    const highlights = pulse?.departmentHighlights ?? {
      commercial: [],
      rd: [],
      operations: [],
      security: [],
      resources: [],
    };

    const persisted = this.readConfig();
    try {
      const [superDefault, workStatus, groupsRes, roomsRes, tasksRes, cronsRes] = await Promise.all([
        this.ahRequest<{ bot: AgentHomeRawBot }>("/api/bot-work/default"),
        this.ahRequest<{ bots: AgentHomeWorkRow[] }>("/api/bot-work/status"),
        this.ahRequest<{ groups: Array<{ id: string; name: string; botIds: string[]; roomIds: string[] }> }>("/api/bot-functional-groups"),
        this.ahRequest<{ rooms: AgentHomeRoom[] }>("/api/bot-rooms"),
        this.ahRequest<{ tasks: AgentHomeTask[] }>("/api/bot-work/tasks?limit=40"),
        this.ahRequest<{ jobs: AgentHomeCronJob[] }>("/api/cron/jobs"),
      ]);

      const superBotId = superDefault.bot.id;
      const workById = new Map(workStatus.bots.map(row => [row.bot.id, row]));
      const workByName = new Map(workStatus.bots.map(row => [row.bot.name, row]));

      const group =
        (persisted?.groupId ? groupsRes.groups.find(g => g.id === persisted.groupId) : undefined) ??
        groupsRes.groups.find(g => g.name === OPC_GROUP_NAME) ??
        null;
      const room =
        (persisted?.roomId ? roomsRes.rooms.find(r => r.id === persisted.roomId && r.status === "active") : undefined) ??
        roomsRes.rooms.find(r => r.title === OPC_ROOM_TITLE && r.status === "active") ??
        null;
      const cronJob =
        (persisted?.cronJobId ? cronsRes.jobs.find(j => j.id === persisted.cronJobId) : undefined) ??
        cronsRes.jobs.find(j => j.name === OPC_CRON_NAME) ??
        null;

      const toRuntime = (row: AgentHomeWorkRow | undefined, fallbackName: string, fallbackTitle: string): ExecutiveBotRuntime => {
        if (!row) {
          return {
            botId: null,
            name: fallbackName,
            title: fallbackTitle,
            exists: false,
            status: "missing",
            activeWorkCount: 0,
            pendingCount: 0,
            completedCount: 0,
            failedCount: 0,
            inGroup: false,
            inRoom: false,
          };
        }
        const disabled = Boolean(row.control?.disabled);
        const paused = Boolean(row.control?.paused);
        const active = Number(row.activeWorkCount ?? 0);
        const status: ExecutiveBotRuntime["status"] = disabled
          ? "disabled"
          : paused
            ? "paused"
            : active > 0 || row.status === "running"
              ? "running"
              : "idle";
        return {
          botId: row.bot.id,
          name: row.bot.name,
          title: row.bot.title || fallbackTitle,
          exists: true,
          status,
          activeWorkCount: active,
          pendingCount: Number(row.pending ?? 0),
          completedCount: Number(row.taskCounts?.completed ?? 0),
          failedCount: Number(row.taskCounts?.failed ?? 0),
          inGroup: Boolean(group?.botIds.includes(row.bot.id)),
          inRoom: Boolean(room?.botIds.includes(row.bot.id)),
        };
      };

      const superRow = workById.get(superBotId);
      const superBot = toRuntime(superRow, superDefault.bot.name, superDefault.bot.title || "Team coordinator");

      const departments: ExecutiveDepartmentView[] = EXECUTIVE_DEPARTMENTS.map(bp => {
        const savedId = persisted?.departmentBotIds?.[bp.id];
        const row = (savedId ? workById.get(savedId) : undefined) ?? workByName.get(bp.botName);
        return {
          ...bp,
          runtime: toRuntime(row, bp.botName, bp.botTitle),
          liveHighlights: highlights[bp.id] ?? [],
        };
      });

      const deptBotIdSet = new Set<string>();
      const nameById = new Map<string, string>([[superBotId, superBot.name]]);
      for (const d of departments) {
        if (d.runtime.botId) {
          deptBotIdSet.add(d.runtime.botId);
          nameById.set(d.runtime.botId, d.runtime.name);
        }
      }

      const recentTasks: ExecutiveTaskItem[] = (tasksRes.tasks ?? [])
        .filter(
          t =>
            deptBotIdSet.has(t.targetBotId) ||
            Boolean(t.requesterBotId && deptBotIdSet.has(t.requesterBotId)) ||
            (t.targetBotId === superBotId && /(?:OPC|总裁|五大部门|部门\s*Bot)/i.test(t.input)),
        )
        .slice(0, 14)
        .map(t => ({
          id: t.id,
          requesterBotId: t.requesterBotId ?? superBotId,
          requesterName: nameById.get(t.requesterBotId ?? "") ?? (t.requesterBotId || "创始人"),
          targetBotId: t.targetBotId,
          targetName: nameById.get(t.targetBotId) ?? workById.get(t.targetBotId)?.bot.name ?? t.targetBotId,
          status: t.status,
          input: t.input.slice(0, 260),
          result: (t.delivery?.report || t.result || "").slice(0, 320),
          failureReason: t.failureReason || "",
          updatedAt: t.updatedAt,
        }));

      const bootstrapped = Boolean(
        superBot.exists &&
        departments.every(d => d.runtime.exists && d.runtime.inRoom) &&
        room,
      );

      return {
        agentHomeReachable: true,
        agentHomeOrigin: this.client.origin,
        bootstrapped,
        group: group ? { id: group.id, name: group.name } : null,
        room: room
          ? {
              id: room.id,
              title: room.title,
              replyMode: room.replyMode || "coordinator",
              linkedDefault: this.isRoomLinkedDefault(room.id),
            }
          : null,
        delegationRoutedToSuperBot: this.isDelegationRoutedTo(user, superBotId),
        briefCron: cronJob
          ? {
              id: cronJob.id,
              name: cronJob.name,
              schedule: cronJob.scheduleValue || "0 9 * * *",
              enabled: cronJob.enabled,
              nextRunAt: cronJob.nextRunAt ?? null,
            }
          : null,
        superBot,
        departments,
        recentTasks,
        companyPulse,
      };
    } catch (err) {
      return {
        agentHomeReachable: false,
        agentHomeOrigin: this.client.origin,
        bootstrapped: false,
        group: null,
        room: null,
        delegationRoutedToSuperBot: false,
        briefCron: null,
        superBot: {
          botId: null, name: "Super Bot", title: "Team coordinator", exists: false,
          status: "missing", activeWorkCount: 0, pendingCount: 0, completedCount: 0, failedCount: 0, inGroup: false, inRoom: false,
        },
        departments: EXECUTIVE_DEPARTMENTS.map(bp => ({
          ...bp,
          runtime: {
            botId: null, name: bp.botName, title: bp.botTitle, exists: false,
            status: "missing", activeWorkCount: 0, pendingCount: 0, completedCount: 0, failedCount: 0, inGroup: false, inRoom: false,
          },
          liveHighlights: highlights[bp.id] ?? [],
        })),
        recentTasks: [],
        companyPulse,
        error: err instanceof Error ? err.message : "暂时无法连接 Agent Home",
      };
    }
  }

  async bootstrap(user: User): Promise<ExecutiveStatus> {
    const persisted = this.readConfig();
    const superDefault = await this.ahRequest<{ bot: AgentHomeRawBot }>("/api/bot-work/default");
    const superBotId = superDefault.bot.id;

    // 1. Ensure functional group exists
    const groupsRes = await this.ahRequest<{ groups: Array<{ id: string; name: string; botIds: string[]; roomIds: string[] }> }>("/api/bot-functional-groups");
    let group =
      (persisted?.groupId ? groupsRes.groups.find(g => g.id === persisted.groupId) : undefined) ??
      groupsRes.groups.find(g => g.name === OPC_GROUP_NAME);
    if (!group) {
      const created = await this.ahRequest<{ group: { id: string; name: string; botIds: string[]; roomIds: string[] } }>(
        "/api/bot-functional-groups",
        { method: "POST", body: { name: OPC_GROUP_NAME } },
      );
      group = created.group;
    }

    // 2. Ensure all 5 Department VP Bots exist & have up-to-date department contracts
    const botsRes = await this.ahRequest<{ bots: AgentHomeRawBot[] }>("/api/bots?includeHidden=1");
    const botById = new Map(botsRes.bots.map(b => [b.id, b]));
    const botByName = new Map(botsRes.bots.map(b => [b.name, b]));
    const deptBotIds: Partial<Record<ExecutiveDepartmentId, string>> = {};
    const deptRows: Array<{ bp: ExecutiveDepartmentBlueprint; botId: string }> = [];

    for (const bp of EXECUTIVE_DEPARTMENTS) {
      const savedId = persisted?.departmentBotIds?.[bp.id];
      let existing = (savedId ? botById.get(savedId) : undefined) ?? botByName.get(bp.botName);
      const description = buildDepartmentDescription(bp, superBotId, this.opcOrigin);
      if (!existing) {
        const created = await this.ahRequest<{ bot: AgentHomeRawBot }>("/api/bots", {
          method: "POST",
          body: {
            name: bp.botName,
            title: bp.botTitle,
            description,
            faceShape: bp.faceShape,
            faceColor: bp.faceColor,
            faceStyle: bp.faceStyle,
            faceExpression: bp.faceExpression,
          },
        });
        existing = created.bot;
      } else {
        await this.ahRequest(`/api/bots/${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          body: { title: bp.botTitle, description, hidden: false },
        });
      }
      await this.ahRequest(`/api/bots/${encodeURIComponent(existing.id)}/functional-group`, {
        method: "PUT",
        body: { groupId: group.id },
      });
      deptBotIds[bp.id] = existing.id;
      deptRows.push({ bp, botId: existing.id });
    }

    // 3. Update Super Bot contract (preserving existing coordinator instructions)
    const superDetail = await this.ahRequest<{ bot: AgentHomeRawBot }>(`/api/bots/${encodeURIComponent(superBotId)}`);
    const mergedSuperDesc = mergeSuperBotDescription(
      superDetail.bot.description || "",
      buildSuperBotContract(deptRows, OPC_ROOM_TITLE),
    );
    await this.ahRequest(`/api/bots/${encodeURIComponent(superBotId)}`, {
      method: "PATCH",
      body: { description: mergedSuperDesc },
    });

    // 4. Write shared organizational context into the OPC functional group
    const sharedEntries: Record<string, string> = {
      "opc-hierarchy": [
        `Super Bot（总控 COO）: ${superBotId}`,
        ...deptRows.map(({ bp, botId }) => `${bp.departmentName}: ${bp.botName} (${botId})`),
      ].join("\n"),
      "opc-approval-policy":
        "部门 Bot 负责日常只读巡检、草案拟定与进度跟踪；凡涉及资金/退款/定价、对外公开发布、生产升级重启、高危权限或预算超线，一律上报 Super Bot 汇总呈报创始人拍板，严禁擅自代批。",
      "opc-console": `OPC OS 总控台地址：${this.opcOrigin}/`,
    };
    await this.ahRequest(`/api/bot-shared-context?scope=group&id=${encodeURIComponent(group.id)}`, {
      method: "PUT",
      body: { entries: sharedEntries },
    });

    // 5. Ensure 「OPC 总裁办 · Super Bot 总控群」 exists in coordinator mode with all 6 bots
    const allMemberIds = [superBotId, ...deptRows.map(r => r.botId)];
    const roomsRes = await this.ahRequest<{ rooms: AgentHomeRoom[] }>("/api/bot-rooms");
    let room =
      (persisted?.roomId ? roomsRes.rooms.find(r => r.id === persisted.roomId && r.status === "active") : undefined) ??
      roomsRes.rooms.find(r => r.title === OPC_ROOM_TITLE && r.status === "active");
    if (!room) {
      const created = await this.ahRequest<{ room: AgentHomeRoom }>("/api/bot-rooms", {
        method: "POST",
        body: {
          title: OPC_ROOM_TITLE,
          botIds: allMemberIds,
          hostBotId: superBotId,
        },
      });
      room = created.room;
    } else {
      for (const botId of allMemberIds) {
        if (!room.botIds.includes(botId)) {
          await this.ahRequest(`/api/bot-rooms/${encodeURIComponent(room.id)}/members`, {
            method: "POST",
            body: { botId },
          });
        }
      }
    }
    await this.ahRequest(`/api/bot-rooms/${encodeURIComponent(room.id)}`, {
      method: "PATCH",
      body: { hostBotId: superBotId, replyMode: "coordinator" },
    });
    await this.ahRequest(`/api/bot-rooms/${encodeURIComponent(room.id)}/functional-group`, {
      method: "PUT",
      body: { groupId: group.id },
    });

    // 6. Link the Executive Room as OPC OS default chat room (only if not yet linked to something else, or if updating our room)
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO opc_home_chat_links(scope_key, connection, remote_room, room_title, updated_at)
        VALUES('default', ?, ?, ?, ?)
        ON CONFLICT(scope_key, connection) DO UPDATE SET remote_room=excluded.remote_room, room_title=excluded.room_title, updated_at=excluded.updated_at`)
        .run(this.client.identity, room.id, OPC_ROOM_TITLE, now);
    } catch { /* ignore if table absent in minimal test */ }

    // 7. Set OPC OS default delegation preference -> Super Bot (non-automatic by default so founder stays in control)
    try {
      const existingPref = this.db.prepare("SELECT preference FROM opc_delegate_preferences WHERE user_id=?").get(user.id);
      if (!existingPref) {
        this.db.prepare("INSERT INTO opc_delegate_preferences(user_id, preference, since) VALUES(?, ?, ?)").run(
          user.id,
          JSON.stringify({
            via: "agent-home",
            target: superBotId,
            instructions: "由 Super Bot 先分拣归属部门并委派对应部门 Bot 核查执行，汇总结论与明确审批建议后再向创始人汇报。",
            automatic: false,
          }),
          now,
        );
      }
    } catch { /* ignore if table absent in minimal test */ }

    // 8. Ensure optional daily 09:00 Executive Brief cron job exists (disabled by default until user flips toggle)
    let cronJobId = persisted?.cronJobId ?? null;
    try {
      const cronsRes = await this.ahRequest<{ jobs: AgentHomeCronJob[] }>("/api/cron/jobs");
      let cron =
        (cronJobId ? cronsRes.jobs.find(j => j.id === cronJobId) : undefined) ??
        cronsRes.jobs.find(j => j.name === OPC_CRON_NAME);
      if (!cron) {
        const created = await this.ahRequest<{ job: AgentHomeCronJob }>("/api/cron/jobs", {
          method: "POST",
          body: {
            name: OPC_CRON_NAME,
            botId: superBotId,
            roomId: room.id,
            cron: "0 9 * * *",
            timezone: "Asia/Shanghai",
            enabled: false,
            prompt:
              "执行每日 OPC 总裁晨报：使用 bot_delegate 依次向 5 位 OPC 部门 Bot（商业与增长、产研与工程、运维与基础设施、安全与合规、资源与财务）收集例行巡检结果，过滤常规细节，汇总成 1 页「今日总裁简报 + 需创始人拍板的审批清单」呈报创始人。",
          },
        });
        cron = created.job;
      }
      cronJobId = cron.id;
    } catch {
      // Cron creation is optional if daemon disables cron
    }

    this.saveConfig({
      superBotId,
      groupId: group.id,
      roomId: room.id,
      cronJobId,
      departmentBotIds: deptBotIds,
      updatedAt: now,
    });

    return this.status(user);
  }

  async requestExecutiveBrief(user: User, rawInput: unknown) {
    const parsed = briefSchema.safeParse(rawInput ?? {});
    if (!parsed.success) throw new ApiError(400, "executive_brief_input", "总裁指令格式不正确。");
    let current = await this.status(user);
    if (!current.bootstrapped) current = await this.bootstrap(user);
    const superBotId = current.superBot.botId;
    const roomId = current.room?.id;
    if (!superBotId || !roomId) throw new ApiError(409, "executive_not_ready", "请先完成总裁办与部门 Bot 一键建制。");

    const pulse = this.pulseProvider ? await this.pulseProvider().catch(() => null) : null;
    const rosterLines = current.departments
      .filter(d => d.runtime.botId)
      .map(d => `- ${d.departmentName}（${d.runtime.botId}）：${d.liveHighlights.join("；") || "待部门巡检"}`);
    const text = [
      parsed.data.focus
        ? `【创始人总裁指令】${parsed.data.focus}`
        : "【创始人要求：生成今日 OPC 总裁简报与待审批清单】",
      "",
      "请 Super Bot 统筹调度下辖 5 位 OPC 部门 Bot（先用 bot_team_status / bot_delegate 按需核查），过滤执行细节，最终只给我 1 页结构化汇报：",
      "1. 各部门状态灯（🟢/🟡/🔴）与 Top 3 关键变化",
      "2. 已在部门内自治闭环的事项（一句话带过）",
      "3. 必须我拍板审批的事项（每项给 1 个推荐方案 + 风险说明，我只需回复批准/拒绝）",
      "",
      "【当前 OPC OS 实时快照供调度参考】",
      pulse?.snapshotText || "",
      ...rosterLines,
    ]
      .filter(Boolean)
      .join("\n");

    const mode = parsed.data.mode ?? "room";
    if (mode === "room") {
      const sent = await this.ahRequest<{ message?: { id: string } }>(
        `/api/bot-rooms/${encodeURIComponent(roomId)}/messages`,
        {
          method: "POST",
          body: {
            text,
            mentions: [superBotId],
            idempotencyKey: `opc-brief-${randomUUID()}`,
          },
        },
      );
      return { ok: true, mode: "room", roomId, messageId: sent.message?.id ?? null, superBotId };
    }

    const dispatched = await this.ahRequest<{ task: { id: string; status: string } }>("/api/bot-work/tasks", {
      method: "POST",
      body: {
        requesterBotId: superBotId,
        targetBotId: superBotId,
        input: text,
        idempotencyKey: `opc-brief-task-${randomUUID()}`,
      },
    });
    return { ok: true, mode: "task", roomId, taskId: dispatched.task.id, status: dispatched.task.status, superBotId };
  }

  async dispatchDepartment(user: User, deptId: string, rawInput: unknown) {
    const bp = EXECUTIVE_DEPARTMENTS.find(d => d.id === deptId);
    if (!bp) throw new ApiError(404, "executive_department_missing", "找不到对应的大部门。");
    const parsed = dispatchSchema.safeParse(rawInput);
    if (!parsed.success) throw new ApiError(400, "executive_dispatch_input", "请输入要派发给该部门的任务说明。");
    let current = await this.status(user);
    if (!current.bootstrapped) current = await this.bootstrap(user);
    const superBotId = current.superBot.botId;
    const dept = current.departments.find(d => d.id === bp.id);
    if (!superBotId || !dept?.runtime.botId) {
      throw new ApiError(409, "executive_not_ready", "部门 Bot 尚未初始化，请先点击一键建制。");
    }

    const input = [
      `【来自 Super Bot 的部门派单 · ${bp.departmentName}】`,
      parsed.data.instruction,
      "",
      "要求：先基于真实工具/接口只读核查，可自治处理的直接给出进展；涉及审批红线的不要擅自执行，整理成「推荐方案 + 风险一句话」回报给 Super Bot 转呈创始人。",
    ].join("\n");

    const dispatched = await this.ahRequest<{ task: { id: string; status: string } }>("/api/bot-work/tasks", {
      method: "POST",
      body: {
        requesterBotId: superBotId,
        targetBotId: dept.runtime.botId,
        input,
        idempotencyKey: `opc-dept-${bp.id}-${randomUUID()}`,
      },
    });
    return {
      ok: true,
      departmentId: bp.id,
      targetBotId: dept.runtime.botId,
      targetName: dept.runtime.name,
      taskId: dispatched.task.id,
      status: dispatched.task.status,
    };
  }

  async toggleBriefCron(user: User, rawInput: unknown) {
    const parsed = cronToggleSchema.safeParse(rawInput);
    if (!parsed.success) throw new ApiError(400, "executive_cron_input", "请提供 enabled 布尔开关。");
    let current = await this.status(user);
    if (!current.briefCron) current = await this.bootstrap(user);
    if (!current.briefCron) throw new ApiError(409, "executive_cron_missing", "当前 Agent Home 未开启定时任务能力。");
    await this.ahRequest(`/api/cron/jobs/${encodeURIComponent(current.briefCron.id)}`, {
      method: "PATCH",
      body: { enabled: parsed.data.enabled },
    });
    return this.status(user);
  }
}

export function registerExecutiveBotRoutes(
  app: Hono,
  db: DatabaseSync,
  user: (c: Context) => User,
  options: {
    client?: StageHomeClient;
    opcOrigin?: string;
    pulseProvider?: ExecutivePulseProvider;
  } = {},
) {
  const client = options.client ?? new StageHomeClient();
  const opcOrigin = options.opcOrigin ?? process.env.KUNLUN_URL ?? `http://127.0.0.1:${process.env.PORT ?? 52328}`;
  const service = new ExecutiveBotService(db, client, opcOrigin, options.pulseProvider);
  const base = "/api/opc/executive";

  app.use(base + "/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(`${base}/status`, async c => c.json(await service.status(user(c))));
  app.post(`${base}/bootstrap`, async c => c.json(await service.bootstrap(user(c))));
  app.post(`${base}/brief`, async c => c.json(await service.requestExecutiveBrief(user(c), await c.req.json().catch(() => ({})))));
  app.post(`${base}/departments/:id/dispatch`, async c =>
    c.json(await service.dispatchDepartment(user(c), c.req.param("id"), await c.req.json())),
  );
  app.post(`${base}/cron/toggle`, async c =>
    c.json(await service.toggleBriefCron(user(c), await c.req.json())),
  );
  return service;
}
