import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  CodingResourceNode,
  CodingResourceRequest,
  ExecutiveBotRuntime,
  ExecutiveDepartmentBlueprint,
  ExecutiveDepartmentId,
  ExecutiveDepartmentView,
  ExecutiveMailboxResponse,
  ExecutiveMailItem,
  ExecutiveStatus,
  ExecutiveTaskItem,
} from "../executive-bots-types.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import { ApiError, type Principal } from "./logic.ts";
import { StageHomeClient } from "./stage-home-client.ts";
import { ExecutiveReceiptTracer, type TraceTask } from "./executive-receipt-trace.ts";

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
    botTitle: "研发部统管 VP · Coding-Agent 资源池主控",
    departmentName: "产研与工程部",
    summary: "研发部唯一统管 Bot：对上直接向总裁秘书（Super Bot）汇报；对下统一纳管 Coding-Agent 执行资源组（多机开发节点 / Coding Agent CLI / 隔离 Worktree 流水线），并受理其他四大部门提交的研发与自动化调用申请。",
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
      { label: "Agent 暗工厂", href: "#dark-factory" },
    ],
    autonomousScope: [
      "统一管理 Coding-Agent 执行资源组（并发配额、开发/测试/独立评审调度、隔离 Worktree 与证据验收）",
      "受理商业/运维/安全/资源财务四部提交的《Coding-Agent 资源调用申请单》，按优先级排期分配执行节点并交付结果",
      "收集每日情报/想法线索并按影响力×信心×成本排序进入研发选题候选池，定期向总裁秘书（Super Bot）汇报研发水位与资源组负载",
    ],
    approvalRedlines: [
      "重大新产品立项或主线研发方向切换",
      "工作流多步执行计划批准与最终验收发布",
      "跨仓库破坏性重构或对外公开发版",
    ],
    defaultPatrolPrompt:
      "请执行产研与工程部例行巡检：梳理当前 Coding-Agent 执行资源组负载、各部门提交的待处理调用申请单、研发选题池与运行中/阻塞的工作流；区分「研发部已自治调度」和「需经总裁秘书上报创始人拍板」两类，简明回报给 Super Bot。",
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
      "核对数据主权布局：确保所有核心主库（SQLite/DuckDB）与签名私钥仅驻留创始人自有主权节点、外部借用执行机保持无状态，并提醒定期执行 npm run opc:backup 热备校验",
      "持续同步服务探针状态到服务台账并向 Super Bot 汇报集群 SLA",
    ],
    approvalRedlines: [
      "生产常驻服务版本升级切换或重启核心进程",
      "修改 Tailscale Serve 暴露端口、公网/内网转发或防火墙规则",
      "禁止未经批准将主数据库、客户账本或核心私钥部署/同步至外部借用算力机器（严守三不留铁律）",
      "清理或删除远端工作区与持久化数据",
    ],
    defaultPatrolPrompt:
      "请执行运维与基础设施部例行巡检：核查 Tailscale 集群各节点在线与直连/中继状态、GPU/内存负载、全部部署服务可用性及数据主权热备状态；列出异常端点、根因判断与最小修复建议，简明回报给 Super Bot。",
  },
  {
    id: "security",
    botName: "OPC 安全与合规部 Bot",
    botTitle: "安全与合规 VP",
    departmentName: "安全与合规部",
    summary: "统筹项目发版前安全评审、整改复核、Chrome 商店 MV3 权限合规、开源许可证审计、公开仓库脱敏与数据主权三不留红线。",
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
      "巡检数据主权与外部执行机三不留红线（不留主库、不留核心私钥、不留未推代码），抽检备份归档加密与校验状态",
      "核对插件 MV3 最小权限声明、隐私政策与退款条款完备性",
    ],
    approvalRedlines: [
      "发现高危凭据泄露、越权访问、或核心私钥/主库滞留非自有执行机必须立即经 Super Bot 红色上报并触发清场",
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

function buildDepartmentDescription(
  bp: ExecutiveDepartmentBlueprint,
  superBotId: string,
  opcOrigin: string,
  rdBotId?: string,
): string {
  const codingPoolClause =
    bp.id === "rd"
      ? [
          "【Coding-Agent 执行资源组统管职责】",
          "1. 全公司所有 Coding-Agent（本机/远端开发执行节点、Herdr/CLI 编码器、隔离 Worktree 流水线）均归你研发部统一纳管与调度。",
          "2. 商业与增长部、运维与基础设施部、安全与合规部、资源与财务部如需改代码、写自动化脚本、修 Bug 或构建页面，会向你提交《Coding-Agent 调用申请单》；你负责审核必要性、排期分配资源组执行、把关测试/独立评审证据，并将交付结果回执申请部门、同步抄送总裁秘书（Super Bot）。",
          "3. 你直接向总裁秘书（Super Bot）汇报，不直接打扰创始人处理具体编码细节。",
          "4. 【无状态执行器与三不留铁律】外部/借用开发节点只作无状态算力执行器：严禁将主数据库、签名私钥或真实客户账本落盘到外部节点；全部代码变更必须通过 Git 推送远端仓库，确保任意外部节点可随时清场回收且零业务数据丢失。",
        ]
      : [
          "【调用 Coding-Agent 执行资源规范】",
          `凡需改代码、写自动化脚本、修 Bug、搭建页面或执行仓库级工程变更，严禁跳过研发部私自调用 Coding-Agent；必须向研发部统管 Bot（OPC 产研与工程部 Bot${rdBotId ? `，botId: ${rdBotId}` : ""}）提交结构化申请（申请部门、目标仓库、任务目标、验收标准、优先级），由研发部统一调度 Coding-Agent 资源组执行并验收交付。`,
        ];

  return [
    `你是「${bp.departmentName}」统管负责人（${bp.botTitle}），向总裁秘书 Super Bot（${superBotId}）汇报。`,
    `【核心使命】${bp.summary}`,
    `【OPC OS 管理界面】${bp.ownedPages.map(p => `${p.label}（${opcOrigin}/${p.href}）`).join("、")}`,
    ...codingPoolClause,
    `【日常自治范围（无需打扰创始人，直接查证并推进）】`,
    ...bp.autonomousScope.map((s, i) => `${i + 1}. ${s}`),
    `【必须上报总裁秘书（Super Bot）请求创始人审批的红线（严禁擅自越权执行）】`,
    ...bp.approvalRedlines.map((r, i) => `${i + 1}. ${r}`),
    `【汇报格式要求】向总裁秘书（Super Bot）汇报时必须极其精炼，固定按三段输出：① 本部门状态灯（🟢正常 / 🟡需关注 / 🔴阻塞）与 3 条以内关键事实；② 已自治推进事项（含已向研发部提交或完结的 Coding-Agent 工单）；③ 需创始人拍板的审批项（给出 1 个明确推荐选项 + 风险一句话，无则写「无」）。`,
  ].join("\n");
}

function buildSuperBotContract(deptRows: Array<{ bp: ExecutiveDepartmentBlueprint; botId: string }>, roomTitle: string): string {
  const rdRow = deptRows.find(r => r.bp.id === "rd");
  const roster = deptRows.map(
    ({ bp, botId }) => `- ${bp.departmentName}：${bp.botName}（botId: ${botId}）— ${bp.summary}`,
  );
  return [
    CONTRACT_START,
    "你是创始人的一人公司（OPC）总裁秘书 / 总控 COO，直接对创始人负责，是创始人唯一需要日常对接的管理总口。",
    "【三层组织汇报链】创始人（你） ↔ 总裁秘书（Super Bot，本账号） ↔ 五大部门统管 Bot ↔ Coding-Agent 执行资源组（由研发部统管 Bot 统一纳管）。",
    "你的核心价值是「替创始人挡住 90% 的执行细节」：日常拆解任务并委派给下辖 5 位部门统管 Bot，收集核对他们的结果，只在需要创始人做战略/资金/发版/高危权限拍板时整理成极简审批单呈报。",
    "【下辖五大部门统管 Bot 通讯录】",
    ...roster,
    `【Coding-Agent 资源组治理原则】所有代码实现、脚本开发、Bug 修复与工作流执行均归研发部统管 Bot（${rdRow ? `${rdRow.bp.botName} / ${rdRow.botId}` : "OPC 产研与工程部 Bot"}）统一管理 Coding-Agent 执行资源组；其他部门如需研发或自动化支援，应向研发部统管 Bot 申请调用，你负责跨部门优先级协调与向创始人汇总结论。`,
    "【数据主权与无状态算力铁律】所有核心主库（SQLite/DuckDB）、离线授权签名私钥与经营账本仅驻留于创始人自有主权设备；外部借用算力节点只作无状态执行器（三不留：不留主库、不留核心私钥、不留未推代码），保证任意时刻 10 分钟内可完成热备迁移与外部节点清场。",
    `【总控协同群】${roomTitle}（群内由你主控协调，按问题归属点名对应部门统管 Bot 查证执行，再由你统一向创始人总结）。`,
    "【创始人汇报与审批协议】",
    "1. 使用 bot_team_status、bot_delegate、bot_task_results 调度上述 5 位部门统管 Bot，禁止自己替代部门猜数据，必须基于部门回执与本机实证汇报。",
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

const mailboxReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(8000),
  replyToMessageId: z.string().trim().min(1).max(160).optional(),
  action: z.enum(["approve", "changes", "reject"]).optional(),
  departmentId: z.enum(["commercial", "rd", "operations", "security", "resources"]).optional(),
});

const mailReadSchema = z.strictObject({
  read: z.boolean(),
});

const codingRequestSchema = z.strictObject({
  requesterDept: z.enum(["commercial", "rd", "operations", "security", "resources", "executive"]),
  title: z.string().trim().min(1).max(160),
  repo: z.string().trim().max(180).default(""),
  objective: z.string().trim().min(1).max(4000),
  acceptance: z.string().trim().max(2000).default(""),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
});

export type CodingAgentsProvider = () => CodingResourceNode[];

const NON_WORKER_BOT_PATTERN = /(?:^super-bot$|小秘书|recall-trace|bot-stability|召回)/i;

function extractMailSubject(text: string, fallback: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(l =>
      l
        .replace(/^#+\s*/, "")
        .replace(/^【[^】]{1,24}】\s*/, "")
        .replace(/^[【\[]+|[】\]]+$/g, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter(Boolean);
  const first = lines[0] || fallback;
  return first.length > 56 ? first.slice(0, 55) + "…" : first;
}

function extractMailExcerpt(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " [代码块] ")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 140 ? flat.slice(0, 139) + "…" : flat;
}

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

type RawRoomMessage = {
  id: string;
  roomId?: string;
  seq?: number;
  turnId?: string;
  text: string;
  createdAt: string;
  sender: { type: "user" | "bot"; id: string; name: string };
};

type AgentHomeTask = TraceTask & {
  requesterBotId?: string;
};

// This flag only routes an unlinked explicit request into the founder's reading queue.
// Only a verified receipt trace can identify an executable action.
function asksFounderToDecide(report: string): boolean {
  return report.split(/[\n。！!]/u).some(line => {
    if (/^\s*(?:>|\x60{3})|(?:无需|无须|不需|不用|不必|没有|暂无|均无|已获|已经批准)/u.test(line)) return false;
    const ask = /(?:^|[，,：:；;]\s*)(?:[\s#>*\-\d.、①②③④⑤]*)(?:待你(?:批准|审批|拍板|签字)|需(?:要)?(?:你|创始人)(?:批准|审批|拍板|签字)|请(?:你|创始人)?(?:批准|拍板|签字)|请求(?:创始人)?审批|是否批准)/u.exec(line);
    if (!ask) return false;
    return !/(?:[：:]\s*(?:无|暂无|无须|无新增|无待办)(?:[\s。！!？?）)]|$)|无则写)/u.test(line.slice(ask.index));
  });
}

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
  private readonly mailDeliveries = new Map<string, AgentHomeTask["delivery"]>();
  private readonly mailboxSnapshots = new Map<string, {
    checkedAt: number;
    response?: ExecutiveMailboxResponse;
    inFlight?: Promise<ExecutiveMailboxResponse>;
  }>();

  constructor(
    private db: DatabaseSync,
    private client: StageHomeClient,
    private opcOrigin: string,
    private pulseProvider?: ExecutivePulseProvider,
    private codingAgentsProvider?: CodingAgentsProvider,
    private traceMessages?: (user: User) => ZoomMessage[],
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_executive_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_executive_mail_reads(
      user_id TEXT NOT NULL,
      mail_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY(user_id, mail_id)
    );
    CREATE TABLE IF NOT EXISTS opc_executive_mail_history(
      user_id TEXT NOT NULL,
      connection TEXT NOT NULL,
      mail_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      PRIMARY KEY(user_id, connection, mail_id)
    );
    CREATE TABLE IF NOT EXISTS opc_coding_resource_requests(
      id TEXT PRIMARY KEY,
      requester_dept TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      title TEXT NOT NULL,
      repo TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL,
      acceptance TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      task_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      report TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
  }

  listCodingRequests(tasksById?: Map<string, AgentHomeTask>): CodingResourceRequest[] {
    const rows = this.db
      .prepare("SELECT * FROM opc_coding_resource_requests ORDER BY created_at DESC LIMIT 20")
      .all() as Array<Record<string, unknown>>;
    return rows.map(row => {
      const id = String(row.id);
      const taskId = row.task_id ? String(row.task_id) : null;
      let status = String(row.status) as CodingResourceRequest["status"];
      let report = String(row.report ?? "");
      let updatedAt = String(row.updated_at);
      if (taskId && tasksById?.has(taskId)) {
        const live = tasksById.get(taskId)!;
        const mapped: CodingResourceRequest["status"] =
          live.status === "completed"
            ? "completed"
            : live.status === "failed" || live.status === "error"
              ? "failed"
              : live.status === "running" || live.status === "in_progress"
                ? "running"
                : "queued";
        const liveReport = (live.delivery?.report || live.result || live.failureReason || "").trim();
        if (mapped !== status || (liveReport && liveReport !== report)) {
          status = mapped;
          if (liveReport) report = liveReport;
          updatedAt = live.updatedAt || new Date().toISOString();
          this.db
            .prepare("UPDATE opc_coding_resource_requests SET status=?, report=?, updated_at=? WHERE id=?")
            .run(status, report, updatedAt, id);
        }
      }
      return {
        id,
        requesterDept: String(row.requester_dept) as CodingResourceRequest["requesterDept"],
        requesterName: String(row.requester_name),
        title: String(row.title),
        repo: String(row.repo ?? ""),
        objective: String(row.objective),
        acceptance: String(row.acceptance ?? ""),
        priority: (String(row.priority) as CodingResourceRequest["priority"]) || "normal",
        taskId,
        status,
        report,
        createdAt: String(row.created_at),
        updatedAt,
      };
    });
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

  private async ahRequest<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = process.env.PPENG_TOKEN;
    if (token) headers.authorization = "Bearer " + token;
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.client.origin + path, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
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

      const rdDept = departments.find(d => d.id === "rd");
      const devGroup = groupsRes.groups.find(g => g.name === "开发" || /^dev(?:elopment)?$/i.test(g.name)) ?? null;
      const workerNodes: CodingResourceNode[] = [];
      if (devGroup) {
        for (const botId of devGroup.botIds) {
          const row = workById.get(botId);
          if (!row || row.bot.hidden || deptBotIdSet.has(botId) || NON_WORKER_BOT_PATTERN.test(row.bot.name) || NON_WORKER_BOT_PATTERN.test(botId)) {
            continue;
          }
          const rt = toRuntime(row, row.bot.name, row.bot.title || "开发执行节点");
          workerNodes.push({
            id: botId,
            name: row.bot.name,
            kind: "bot_worker",
            runtime: row.bot.title || "Agent Home 开发执行节点",
            status: rt.status === "missing" || rt.status === "disabled" ? "offline" : rt.status,
            activeWorkCount: rt.activeWorkCount,
            completedCount: rt.completedCount,
            groupName: devGroup.name,
          });
        }
      }
      const cliNodes = this.codingAgentsProvider ? this.codingAgentsProvider() : [];
      const codingNodes: CodingResourceNode[] = [...workerNodes, ...cliNodes];
      const tasksById = new Map((tasksRes.tasks ?? []).map(t => [t.id, t]));
      const codingRequests = this.listCodingRequests(tasksById);

      const web = await this.client.resolveWebOrigin();
      return {
        agentHomeReachable: true,
        agentHomeOrigin: web.webOrigin,
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
        codingResourcePool: {
          managedByDeptId: "rd",
          managedByBotId: rdDept?.runtime.botId ?? null,
          managedByBotName: rdDept?.runtime.name ?? "OPC 产研与工程部 Bot",
          groupName: devGroup?.name ?? null,
          nodes: codingNodes,
        },
        codingRequests,
        recentTasks,
        companyPulse,
      };
    } catch (err) {
      const web = await this.client.resolveWebOrigin();
      return {
        agentHomeReachable: false,
        agentHomeOrigin: web.webOrigin,
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
        codingResourcePool: {
          managedByDeptId: "rd",
          managedByBotId: null,
          managedByBotName: "OPC 产研与工程部 Bot",
          groupName: null,
          nodes: this.codingAgentsProvider ? this.codingAgentsProvider() : [],
        },
        codingRequests: this.listCodingRequests(),
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

    // Ensure rd bot is created/updated first so other 4 department contracts embed its exact rdBotId
    const orderedDepts = [
      ...EXECUTIVE_DEPARTMENTS.filter(bp => bp.id === "rd"),
      ...EXECUTIVE_DEPARTMENTS.filter(bp => bp.id !== "rd"),
    ];
    let rdBotId: string | undefined;

    for (const bp of orderedDepts) {
      const savedId = persisted?.departmentBotIds?.[bp.id];
      let existing = (savedId ? botById.get(savedId) : undefined) ?? botByName.get(bp.botName);
      const description = buildDepartmentDescription(bp, superBotId, this.opcOrigin, rdBotId);
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
      if (bp.id === "rd") rdBotId = existing.id;
      deptBotIds[bp.id] = existing.id;
      deptRows.push({ bp, botId: existing.id });
    }
    deptRows.sort(
      (a, b) =>
        EXECUTIVE_DEPARTMENTS.findIndex(x => x.id === a.bp.id) -
        EXECUTIVE_DEPARTMENTS.findIndex(x => x.id === b.bp.id),
    );

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
        `创始人（唯一最终拍板人） ↔ 总裁秘书 Super Bot（总控 COO）: ${superBotId}`,
        ...deptRows.map(({ bp, botId }) => `${bp.departmentName}: ${bp.botName} (${botId})${bp.id === "rd" ? " [统一纳管 Coding-Agent 执行资源组]" : ""}`),
      ].join("\n"),
      "opc-coding-pool-protocol":
        `全公司 Coding-Agent 执行资源组归研发部统管 Bot（OPC 产研与工程部 Bot / ${rdBotId ?? "rd"}）统一管理与排期调度。商业与增长部、运维与基础设施部、安全与合规部、资源与财务部如需改代码、写脚本、修 Bug 或自动化开发，必须向研发部统管 Bot 提交《Coding-Agent 调用申请单》，验收后交付并抄送总裁秘书（Super Bot）。`,
      "opc-approval-policy":
        "部门统管 Bot 负责日常自治巡检、草案拟定与进度跟踪；凡涉及资金/退款/定价、对外公开发布、生产升级重启、高危权限或预算超线，一律上报总裁秘书（Super Bot）汇总呈报创始人拍板，严禁擅自代批。",
      "opc-data-sovereignty-policy":
        "架构铁律：自有主权区（创始人个人设备或未来个人 VPS，集中存放 100% 主数据库、License 签名私钥与经营账本）+ 借用无状态算力区（外部/公司节点仅作 Coding-Agent、编译与推理执行器）。三不留原则：① 不留主数据库（SQLite/DuckDB）；② 不留核心私钥与长期高权 Token；③ 不留未 push 代码。统一使用 npm run opc:backup（支持 --encrypt 加密热备与 verify 校验）和 npm run opc:restore 完成一键迁移。",
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

  private readMailIds(userId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT mail_id FROM opc_executive_mail_reads WHERE user_id=?")
      .all(userId) as Array<{ mail_id: string }>;
    return new Set(rows.map(r => r.mail_id));
  }

  private mergeLinkedMailHistory(user: User, live: ExecutiveMailItem[], sources: ExecutiveMailboxResponse["sourceTraces"]): ExecutiveMailItem[] {
    const connection = this.client.identity;
    const retained = new Map<string, ExecutiveMailItem>();
    for (const row of this.db.prepare("SELECT mail_id,snapshot FROM opc_executive_mail_history WHERE user_id=? AND connection=?").all(user.id, connection)) {
      try {
        const item = JSON.parse(String(row.snapshot)) as ExecutiveMailItem;
        if (item.id === row.mail_id && item.status !== "working" && (item.trace?.origin?.messageId || item.trace?.decisionId)) {
          retained.set(item.id, item);
        }
      } catch { /* A malformed retained record must not prevent viewing the rest of the mailbox. */ }
    }
    const save = this.db.prepare(`INSERT INTO opc_executive_mail_history(user_id,connection,mail_id,snapshot) VALUES(?,?,?,?)
      ON CONFLICT(user_id,connection,mail_id) DO UPDATE SET snapshot=excluded.snapshot
      WHERE opc_executive_mail_history.snapshot<>excluded.snapshot`);
    const result = new Map<string, ExecutiveMailItem>();
    for (const item of live) {
      const trace = item.trace;
      if (item.status === "working" || !(trace?.origin?.messageId || trace?.decisionId)) {
        result.set(item.id, item);
        continue;
      }
      const previous = retained.get(item.id);
      // A temporary detail failure must not replace evidence already verified for this exact version.
      if (trace.deliveryUnavailable && previous?.createdAt === item.createdAt && !previous.trace?.deliveryUnavailable) {
        result.set(item.id, previous);
        continue;
      }
      result.set(item.id, item);
      const snapshot = { ...item, read: false, needsDecision: false, trace: { ...trace,
        ...(trace.decision && { decision: { ...trace.decision, actionable: false } }) } };
      save.run(user.id, connection, item.id, JSON.stringify(snapshot));
    }
    for (const item of retained.values()) {
      if (result.has(item.id)) continue;
      const trace = item.trace!;
      const current = trace.origin?.messageId ? sources?.[trace.origin.messageId] : undefined;
      result.set(item.id, { ...item, historical: true, needsDecision: false, trace: current ? {
        ...trace,
        origin: { ...trace.origin!, ...current.origin!, patrolRunId: current.origin?.patrolRunId },
        affectedTasks: current.affectedTasks,
        decisionId: current.decisionId,
        decision: current.decision,
      } : { ...trace, ...(trace.decision && { decision: { ...trace.decision, actionable: false } }) } });
    }
    return [...result.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  setMailRead(user: User, mailId: string, rawInput: unknown) {
    const parsed = mailReadSchema.safeParse(rawInput);
    if (!parsed.success || !mailId || mailId.length > 200) {
      throw new ApiError(400, "executive_mail_read_input", "请提供有效的信件编号与已读状态。");
    }
    if (parsed.data.read) {
      this.db
        .prepare(
          `INSERT INTO opc_executive_mail_reads(user_id, mail_id, read_at) VALUES(?, ?, ?)
           ON CONFLICT(user_id, mail_id) DO UPDATE SET read_at=excluded.read_at`,
        )
        .run(user.id, mailId, new Date().toISOString());
    } else {
      this.db.prepare("DELETE FROM opc_executive_mail_reads WHERE user_id=? AND mail_id=?").run(user.id, mailId);
    }
    const cached = this.mailboxSnapshots.get(user.id);
    if (cached?.response) {
      cached.response = { ...cached.response, items: cached.response.items.map(item => item.id === mailId
        ? { ...item, read: item.direction === "outbound" || parsed.data.read }
        : item) };
    }
    return { id: mailId, read: parsed.data.read };
  }

  private async mailTaskDetails(tasks: AgentHomeTask[]): Promise<AgentHomeTask[]> {
    const deadline = AbortSignal.timeout(1500);
    const result = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let next = 0;
    const read = async () => {
      while (next < result.length) {
        const i = next++;
        const task = result[i];
        if (task.delivery || !["completed", "failed", "cancelled", "unknown", "error", "canceled"].includes(task.status)) continue;
        const key = JSON.stringify([task.id, task.targetBotId, task.attempt, task.updatedAt]);
        if (this.mailDeliveries.has(key)) {
          result[i] = { ...task, delivery: this.mailDeliveries.get(key) };
          continue;
        }
        result[i] = { ...task, deliveryUnavailable: true };
        if (deadline.aborted) continue;
        try {
          const { task: detail } = await this.ahRequest<{ task: AgentHomeTask }>(
            "/api/bot-work/tasks/" + encodeURIComponent(task.id), { signal: deadline });
          if (detail.id !== task.id || detail.targetBotId !== task.targetBotId || detail.input !== task.input ||
            detail.attempt !== task.attempt || detail.updatedAt !== task.updatedAt) continue;
          const delivery = detail.delivery;
          if (delivery && (delivery.taskId !== task.id || delivery.attempt !== task.attempt)) continue;
          if (this.mailDeliveries.size >= 80) this.mailDeliveries.delete(this.mailDeliveries.keys().next().value!);
          this.mailDeliveries.set(key, delivery);
          result[i] = { ...task, delivery };
        } catch { /* Keep the list snapshot when the delivery service is unavailable. */ }
      }
    };
    await Promise.all(Array.from({length: Math.min(4, tasks.length)}, read));
    return result;
  }

  /** Used by the sidebar's frequent local poll without adding Agent Home I/O to its response path. */
  cachedMailbox(user: User): ExecutiveMailboxResponse | undefined {
    const entry = this.mailboxSnapshots.get(user.id);
    if (!entry?.inFlight && (!entry || Date.now() - entry.checkedAt >= 60_000) &&
        process.env.KUNLUN_PREVIEW !== "1" && process.env.DEMO_MODE !== "1" && this.readConfig()) {
      void this.mailbox(user).catch(() => { /* Next poll can retry after the refresh interval. */ });
    }
    return entry?.response;
  }

  mailbox(user: User): Promise<ExecutiveMailboxResponse> {
    const entry = this.mailboxSnapshots.get(user.id) ?? { checkedAt: 0 };
    if (entry.inFlight) return entry.inFlight;
    entry.checkedAt = Date.now();
    const pending = this.fetchMailbox(user).then(value => {
      // A user may have acknowledged a letter while Agent Home was still loading.
      const reads = this.readMailIds(user.id);
      const items = this.mergeLinkedMailHistory(user, value.items, value.sourceTraces);
      const response = { ...value, items: items.map(item => ({ ...item, read: item.direction === "outbound" || reads.has(item.id) })) };
      entry.response = response;
      return response;
    }).finally(() => { entry.inFlight = undefined; });
    entry.inFlight = pending;
    this.mailboxSnapshots.set(user.id, entry);
    return pending;
  }

  private async fetchMailbox(user: User): Promise<ExecutiveMailboxResponse> {
    const persisted = this.readConfig();
    const readSet = this.readMailIds(user.id);
    const traceProvider = this.traceMessages;
    const tracer = new ExecutiveReceiptTracer(this.db, this.client.identity, user.id,
      traceProvider && (() => traceProvider(user)));
    let sourceTraces: ExecutiveMailboxResponse["sourceTraces"];
    try {
      sourceTraces = tracer.sourceTraces();
    } catch { /* Local source trace lookup is optional; the mailbox still shows the original messages. */ }
    try {
      const [superDefault, roomsRes, tasksRes, botsRes] = await Promise.all([
        this.ahRequest<{ bot: AgentHomeRawBot }>("/api/bot-work/default"),
        this.ahRequest<{ rooms: AgentHomeRoom[] }>("/api/bot-rooms"),
        this.ahRequest<{ tasks: AgentHomeTask[] }>("/api/bot-work/tasks?limit=40"),
        this.ahRequest<{ bots: AgentHomeRawBot[] }>("/api/bots?includeHidden=1"),
      ]);
      const superBotId = superDefault.bot.id;
      const room =
        (persisted?.roomId ? roomsRes.rooms.find(r => r.id === persisted.roomId && r.status === "active") : undefined) ??
        roomsRes.rooms.find(r => r.title === OPC_ROOM_TITLE && r.status === "active") ??
        null;

      const botMeta = new Map<string, { name: string; role: string; deptId?: ExecutiveDepartmentId }>();
      botMeta.set(superBotId, { name: superDefault.bot.name || "Super Bot", role: "总控 COO" });
      for (const b of botsRes.bots) {
        if (!botMeta.has(b.id)) botMeta.set(b.id, { name: b.name, role: b.title || "Bot" });
      }
      const deptBotIdSet = new Set<string>();
      for (const bp of EXECUTIVE_DEPARTMENTS) {
        const savedId = persisted?.departmentBotIds?.[bp.id];
        const matched = (savedId ? botsRes.bots.find(b => b.id === savedId) : undefined) ?? botsRes.bots.find(b => b.name === bp.botName);
        if (matched) {
          deptBotIdSet.add(matched.id);
          botMeta.set(matched.id, { name: matched.name, role: bp.departmentName, deptId: bp.id });
        }
      }

      const items: ExecutiveMailItem[] = [];
      let superBotWorking = false;

      if (room) {
        type RawRoomTurn = { id: string; status?: string; roomId?: string; messageId?: string };
        const [msgRes, turnRes] = await Promise.all([
          this.ahRequest<{ messages: RawRoomMessage[] }>(`/api/bot-rooms/${encodeURIComponent(room.id)}/messages?limit=40`).catch(() => ({ messages: [] })),
          this.ahRequest<{ turns: RawRoomTurn[] }>(`/api/bot-rooms/${encodeURIComponent(room.id)}/turns`).catch(() => ({ turns: [] })),
        ]);
        superBotWorking = (turnRes.turns ?? []).some(t => t.status === "running" || t.status === "pending" || t.status === "queued");
        for (const msg of msgRes.messages ?? []) {
          const isBot = msg.sender.type === "bot";
          const meta = isBot ? botMeta.get(msg.sender.id) : undefined;
          const id = `room:${msg.id}`;
          const trace = tracer.room(room.id, msg, msgRes.messages, turnRes.turns);
          items.push({
            id,
            source: "executive_room",
            direction: isBot ? "inbound" : "outbound",
            senderId: msg.sender.id,
            senderName: isBot ? meta?.name || msg.sender.name : "你 → Super Bot",
            senderRole: isBot ? meta?.role || "总控群" : "创始人指令",
            subject: extractMailSubject(msg.text, isBot ? `${meta?.name || msg.sender.name} 汇报` : "给 Super Bot 的指令"),
            excerpt: extractMailExcerpt(msg.text),
            body: msg.text,
            status: isBot ? "completed" : "sent",
            read: !isBot || readSet.has(id),
            needsDecision: trace ? trace.decision?.actionable === true : isBot && asksFounderToDecide(msg.text),
            ...(trace && { trace }),
            createdAt: msg.createdAt,
            roomId: room.id,
            messageId: msg.id,
            ...(meta?.deptId ? { departmentId: meta.deptId } : {}),
          });
        }
      }

      const departmentTasks = (tasksRes.tasks ?? []).filter(t =>
          deptBotIdSet.has(t.targetBotId) ||
          Boolean(t.requesterBotId && deptBotIdSet.has(t.requesterBotId)) ||
          (t.targetBotId === superBotId && /(?:OPC|总裁|五大部门|部门\s*Bot)/i.test(t.input)));
      for (const t of await this.mailTaskDetails(departmentTasks)) {
        const meta = botMeta.get(t.targetBotId);
        const trace = tracer.task(t);
        const report = trace.result;
        const isWorking = t.status === "running" || t.status === "in_progress" || t.status === "queued" || t.status === "pending";
        if (isWorking) superBotWorking = true;
        const isFailed = t.status === "failed" || t.status === "error";
        const cancelled = t.status === "cancelled" || t.status === "canceled";
        const waiting = !cancelled && !isFailed && t.status !== "completed";
        const inbound = Boolean(report) || isFailed || cancelled || t.status === "completed";
        const id = `task:${t.id}`;
        const body = report
          ? `### 派单内容\n${t.input}\n\n---\n\n### 部门回执\n${report}`
          : `### 派单内容\n${t.input}\n\n${t.failureReason || (cancelled ? "任务已取消。" : isFailed ? "任务执行失败。" : waiting ? "等待部门回执。" : "任务已结束，暂无回执正文。")}`;
        items.push({
          id,
          source: "department_task",
          direction: inbound ? "inbound" : "outbound",
          senderId: t.targetBotId,
          senderName: meta?.name || t.targetBotId,
          senderRole: meta?.role ? `${meta.role} · 部门回执` : "部门回执",
          subject: extractMailSubject(report || t.input, `${meta?.name || "部门 Bot"} 巡检回执`),
          excerpt: extractMailExcerpt(report || t.failureReason || t.input),
          body,
          status: cancelled ? "cancelled" : isFailed ? "failed" : waiting ? "working" : "completed",
          read: !inbound || readSet.has(id),
          needsDecision: trace.origin ? trace.decision?.actionable === true : t.status === "completed" && asksFounderToDecide(report),
          trace,
          createdAt: t.updatedAt,
          taskId: t.id,
          ...(meta?.deptId ? { departmentId: meta.deptId } : {}),
        });
      }

      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const web = await this.client.resolveWebOrigin();
      return {
        agentHomeReachable: true,
        agentHomeOrigin: web.webOrigin,
        bootstrapped: Boolean(room && deptBotIdSet.size === EXECUTIVE_DEPARTMENTS.length),
        roomId: room?.id ?? null,
        roomTitle: room?.title ?? null,
        superBotId,
        superBotWorking,
        items,
        sourceTraces,
      };
    } catch (err) {
      const web = await this.client.resolveWebOrigin();
      return {
        agentHomeReachable: false,
        agentHomeOrigin: web.webOrigin,
        bootstrapped: false,
        roomId: persisted?.roomId ?? null,
        roomTitle: OPC_ROOM_TITLE,
        superBotId: persisted?.superBotId ?? null,
        superBotWorking: false,
        items: [],
        sourceTraces,
        error: err instanceof Error ? err.message : "暂时无法连接 Agent Home",
      };
    }
  }

  private async roomReplyQuote(roomId: string, messageId: string) {
    let before: number | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: "200" });
      if (before !== undefined) query.set("beforeSeq", String(before));
      const page = await this.ahRequest<{ messages: RawRoomMessage[]; hasMore: boolean; nextCursor: number | null }>(
        `/api/bot-rooms/${encodeURIComponent(roomId)}/messages?${query}`,
      );
      const message = page.messages.find(m => m.id === messageId && (!m.roomId || m.roomId === roomId));
      if (message) {
        if (message.sender.type !== "bot") throw new ApiError(400, "executive_quote_sender", "只能引用总控群中的 Bot 来信。");
        const excerpt = [...message.text.replace(/\s+/g, " ").trim()].slice(0, 120).join("");
        if (!excerpt) throw new ApiError(400, "executive_quote_empty", "这封来信没有可引用的正文。");
        return { messageId, botId: message.sender.id, excerpt };
      }
      if (!page.hasMore) throw new ApiError(404, "executive_quote_missing", "总控群中找不到这封来信，请刷新信箱。");
      const next = page.nextCursor;
      if (next === null || !Number.isSafeInteger(next) || next < 1 || (before !== undefined && next >= before)) {
        throw new ApiError(502, "executive_quote_history", "暂时无法读取总控群历史，请稍后重试。");
      }
      before = next;
    }
  }

  async replyMailbox(user: User, rawInput: unknown) {
    const parsed = mailboxReplySchema.safeParse(rawInput);
    if (!parsed.success) throw new ApiError(400, "executive_mail_reply_input", "请填写要发送给 Super Bot 的内容。");
    const { text, replyToMessageId, action, departmentId } = parsed.data;
    if (departmentId && !replyToMessageId && !action) {
      return this.dispatchDepartment(user, departmentId, { instruction: text });
    }
    let current = await this.status(user);
    if (!current.bootstrapped && !replyToMessageId) current = await this.bootstrap(user);
    const superBotId = current.superBot.botId;
    const roomId = current.room?.id;
    if (!superBotId || !roomId) throw new ApiError(409, "executive_not_ready", "请先完成总裁办建制。");
    const replyTo = replyToMessageId ? await this.roomReplyQuote(roomId, replyToMessageId) : undefined;

    const actionPrefix =
      action === "approve"
        ? "【创始人批示：批准执行】\n"
        : action === "changes"
          ? "【创始人批示：要求修改】\n"
          : action === "reject"
            ? "【创始人批示：暂缓/拒绝】\n"
            : "";

    const sent = await this.ahRequest<{ message?: { id: string; createdAt?: string } }>(
      `/api/bot-rooms/${encodeURIComponent(roomId)}/messages`,
      {
        method: "POST",
        body: {
          text: actionPrefix + text,
          mentions: [superBotId],
          idempotencyKey: `opc-mail-reply-${randomUUID()}`,
          ...(replyTo && { replyTo }),
        },
      },
    );
    return {
      ok: true,
      roomId,
      messageId: sent.message?.id ?? null,
      superBotId,
    };
  }

  async createCodingRequest(user: User, rawInput: unknown): Promise<CodingResourceRequest> {
    const parsed = codingRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ApiError(400, "coding_request_input", "请完整填写申请部门、任务标题与期望产出目标。");
    }
    let current = await this.status(user);
    if (!current.bootstrapped) current = await this.bootstrap(user);
    const rdDept = current.departments.find(d => d.id === "rd");
    const superBotId = current.superBot.botId;
    if (!rdDept?.runtime.botId || !superBotId) {
      throw new ApiError(409, "executive_not_ready", "研发部统管 Bot 尚未初始化，请先完成一键建制。");
    }

    const { requesterDept, title, repo, objective, acceptance, priority } = parsed.data;
    const reqDeptObj = requesterDept === "executive" ? null : current.departments.find(d => d.id === requesterDept);
    const requesterName = reqDeptObj ? reqDeptObj.departmentName : "总裁秘书（Super Bot）";
    const requesterBotId = reqDeptObj?.runtime.botId ?? superBotId;
    const priorityLabel = priority === "high" ? "高优（P0）" : priority === "low" ? "低优（P2）" : "常规（P1）";
    const id = `creq_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();

    const poolNames = current.codingResourcePool.nodes.map(n => `${n.name}（${n.runtime}）`).join("、") || "当前可用 Coding-Agent 资源组";
    const input = [
      `【跨部门 Coding-Agent 资源调用申请单 · ${id}】`,
      `申请部门：${requesterName}`,
      `优先级：${priorityLabel}`,
      `任务标题：${title}`,
      repo ? `目标仓库/项目：${repo}` : "",
      `任务目标：\n${objective}`,
      acceptance ? `验收标准：\n${acceptance}` : "",
      `可用 Coding-Agent 资源组参考：${poolNames}`,
      "",
      "请研发部统管 Bot 审核排期并从 Coding-Agent 执行资源组分配执行节点（严禁跳过独立测试/评审证据），完成后将交付结果回执申请部门，并向总裁秘书（Super Bot）汇报；如触发立项/发版/高危红线，整理审批单上报总裁秘书转呈创始人。",
    ]
      .filter(Boolean)
      .join("\n");

    const dispatched = await this.ahRequest<{ task: { id: string; status: string } }>("/api/bot-work/tasks", {
      method: "POST",
      body: {
        requesterBotId,
        targetBotId: rdDept.runtime.botId,
        input,
        idempotencyKey: `opc-coding-req-${id}`,
      },
    });

    const initialStatus: CodingResourceRequest["status"] =
      dispatched.task.status === "running" ? "running" : "queued";
    this.db
      .prepare(
        `INSERT INTO opc_coding_resource_requests
         (id, requester_dept, requester_name, title, repo, objective, acceptance, priority, task_id, status, report, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(id, requesterDept, requesterName, title, repo, objective, acceptance, priority, dispatched.task.id, initialStatus, now, now);

    return {
      id,
      requesterDept,
      requesterName,
      title,
      repo,
      objective,
      acceptance,
      priority,
      taskId: dispatched.task.id,
      status: initialStatus,
      report: "",
      createdAt: now,
      updatedAt: now,
    };
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
    codingAgentsProvider?: CodingAgentsProvider;
    traceMessages?: (user: User) => ZoomMessage[];
  } = {},
) {
  const client = options.client ?? new StageHomeClient();
  const opcOrigin = options.opcOrigin ?? process.env.KUNLUN_URL ?? `http://127.0.0.1:${process.env.PORT ?? 52328}`;
  const service = new ExecutiveBotService(db, client, opcOrigin, options.pulseProvider, options.codingAgentsProvider, options.traceMessages);
  const base = "/api/opc/executive";

  app.use(base + "/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(`${base}/status`, async c => c.json(await service.status(user(c))));
  app.get(`${base}/mailbox`, async c => c.json(await service.mailbox(user(c))));
  app.post(`${base}/mailbox/reply`, async c => c.json(await service.replyMailbox(user(c), await c.req.json())));
  app.put(`${base}/mailbox/:id/read`, async c =>
    c.json(service.setMailRead(user(c), c.req.param("id"), await c.req.json())),
  );
  app.get(`${base}/coding-requests`, c => {
    user(c);
    return c.json({ requests: service.listCodingRequests() });
  });
  app.post(`${base}/coding-requests`, async c => c.json(await service.createCodingRequest(user(c), await c.req.json()), 201));
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
