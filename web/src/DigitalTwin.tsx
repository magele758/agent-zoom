import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { productStages, type ProductStageId } from "../../src/product-stages";
import type { ZoomMessage } from "../../src/zoom-types";
import type { BusinessPortfolio } from "../../src/business-types";
import type { CommercialOverview } from "../../src/commercial-types";
import type { Delegation } from "../../src/delegation-types";
import type { SecurityDepartmentIndex } from "../../src/security-department-types";
import type { OperationsIndex } from "../../src/operations-department-types";
import type { ResourceDepartmentIndex } from "../../src/resource-department-types";
import { api, request, type Agent, type Room } from "./api";
import { taskKey } from "./zoom-view";
import { inboxLink } from "./zoom-routes";
import type { useActivityIndex } from "./ActivityIndex";
import "./digital-twin.css";

type Circuit = "all" | "decision" | "rd" | "commercial" | "runtime";
type Lens = "spatial" | "loops" | "atlas";
type CanvasTheme = "night" | "paper";

type TwinNode = {
  id: string;
  zone: string;
  circuit: Exclude<Circuit, "all">;
  title: string;
  svgSub: string;
  subtitle: string;
  metric: string;
  href: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: "ok" | "active" | "alert" | "idle";
  chips?: Array<{ label: string; href: string }>;
};

type TwinEdge = {
  from: string;
  to: string;
  circuit: Exclude<Circuit, "all">;
  label?: string;
};

const EDGES: TwinEdge[] = [
  { from: "overview", to: "pending", circuit: "decision" },
  { from: "pending", to: "inbox", circuit: "decision" },
  { from: "inbox", to: "handled", circuit: "decision" },
  { from: "pending", to: "delegations", circuit: "decision" },
  { from: "overview", to: "ideas", circuit: "rd" },
  { from: "overview", to: "business", circuit: "commercial" },
  { from: "delegations", to: "workflows", circuit: "rd" },
  { from: "delegations", to: "channels", circuit: "rd" },
  { from: "delegations", to: "commercial", circuit: "commercial" },
  { from: "ideas", to: "opportunities", circuit: "rd" },
  { from: "opportunities", to: "projects", circuit: "rd" },
  { from: "opportunities", to: "product", circuit: "rd" },
  { from: "projects", to: "capabilities", circuit: "rd" },
  { from: "projects", to: "channels", circuit: "rd" },
  { from: "product", to: "workflows", circuit: "rd" },
  { from: "capabilities", to: "homeroom", circuit: "rd" },
  { from: "channels", to: "workflows", circuit: "rd" },
  { from: "workflows", to: "homeroom", circuit: "rd" },
  { from: "business", to: "commercial", circuit: "commercial" },
  { from: "business", to: "growth", circuit: "commercial" },
  { from: "commercial", to: "growth", circuit: "commercial" },
  { from: "commercial", to: "security", circuit: "commercial" },
  { from: "growth", to: "operations", circuit: "commercial" },
  { from: "security", to: "resources", circuit: "commercial" },
  { from: "channels", to: "activity", circuit: "runtime" },
  { from: "workflows", to: "worklog", circuit: "runtime" },
  { from: "operations", to: "substrate", circuit: "runtime" },
  { from: "resources", to: "substrate", circuit: "runtime" },
  { from: "activity", to: "worklog", circuit: "runtime" },
  { from: "worklog", to: "substrate", circuit: "runtime" },
];

const CIRCUIT_COLOR: Record<Exclude<Circuit, "all">, { night: string; paper: string; name: string }> = {
  decision: { night: "#f08c5b", paper: "#a13b22", name: "创始人决策与委派回路" },
  rd: { night: "#5bd69f", paper: "#265c47", name: "多 Agent 产研与交付回路" },
  commercial: { night: "#ebd9B4", paper: "#85581f", name: "商业变现与公司治理回路" },
  runtime: { night: "#78b6eb", paper: "#2c5475", name: "现场会话与底座遥测回路" },
};

type RemoteSnapshot = {
  commercial: CommercialOverview | null;
  business: BusinessPortfolio | null;
  delegations: Delegation[];
  rooms: Room[];
  agents: Agent[];
  workflowCount: number;
  activeWorkflowCount: number;
  opportunityCount: number;
  capabilityCount: number;
  ideaCount: number;
  securityTotal: number;
  securityOpen: number;
  opsManaged: number;
  resourcePlans: number;
  worklogEntries: number;
  syncedAt: string;
};

const EMPTY_REMOTE: RemoteSnapshot = {
  commercial: null,
  business: null,
  delegations: [],
  rooms: [],
  agents: [],
  workflowCount: 0,
  activeWorkflowCount: 0,
  opportunityCount: 0,
  capabilityCount: 0,
  ideaCount: 0,
  securityTotal: 0,
  securityOpen: 0,
  opsManaged: 0,
  resourcePlans: 0,
  worklogEntries: 0,
  syncedAt: "",
};

function roundedPolyline(points: Array<[number, number]>, radius = 9): string {
  if (points.length < 2) return "";
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0);
    const d2 = Math.hypot(x2 - x1, y2 - y1);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 1) {
      d += ` L ${x1} ${y1}`;
      continue;
    }
    const sx = x1 - ((x1 - x0) / d1) * r;
    const sy = y1 - ((y1 - y0) / d1) * r;
    const ex = x1 + ((x2 - x1) / d2) * r;
    const ey = y1 + ((y2 - y1) / d2) * r;
    d += ` L ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${x1} ${y1} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function conduitPath(a: TwinNode, b: TwinNode): string {
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  const acy = a.y + a.h / 2;
  const bcy = b.y + b.h / 2;

  // Same horizontal row -> direct side-to-side connection (or top arc if non-adjacent)
  if (Math.abs(a.y - b.y) < 12) {
    const gap = Math.abs(b.x - (a.x + a.w));
    if (b.x >= a.x + a.w && gap < 80) {
      return `M ${a.x + a.w} ${acy} L ${b.x} ${bcy}`;
    }
    if (a.x >= b.x + b.w && Math.abs(a.x - (b.x + b.w)) < 80) {
      return `M ${a.x} ${acy} L ${b.x + b.w} ${bcy}`;
    }
    // Non-adjacent on Row 1 -> route cleanly along corridor below Row 1 (y = 138)
    const corridorY = a.y + a.h + 18;
    return roundedPolyline([
      [acx, a.y + a.h],
      [acx, corridorY],
      [bcx, corridorY],
      [bcx, b.y + b.h],
    ]);
  }

  const down = b.y > a.y;
  const startY = down ? a.y + a.h : a.y;
  const endY = down ? b.y : b.y + b.h;
  const rowJump = Math.abs(b.y - a.y);

  // Adjacent rows -> clean orthogonal step in the corridor between the two rows
  if (rowJump < 165) {
    const midY = Math.round((startY + endY) / 2);
    return roundedPolyline([
      [acx, startY],
      [acx, midY],
      [bcx, midY],
      [bcx, endY],
    ]);
  }

  // Multi-row jump -> route along the central vertical spine (x = 594..600) so zero cards are crossed!
  const spineX = acx < 600 ? 592 : 604;
  const exitY = startY + (down ? 20 : -20);
  const entryY = endY + (down ? -20 : 20);
  return roundedPolyline([
    [acx, startY],
    [acx, exitY],
    [spineX, exitY],
    [spineX, entryY],
    [bcx, entryY],
    [bcx, endY],
  ]);
}

export function DigitalTwin({
  nav,
  messages,
  pending,
  handled,
  folders,
  products,
  workflowEnabled,
  activityIndex,
}: {
  nav: ReactNode;
  messages: ZoomMessage[];
  pending: ZoomMessage[];
  handled: ZoomMessage[];
  folders: Array<{ label: string; path: string; depth: number; count: number }>;
  products: string[];
  workflowEnabled: boolean;
  activityIndex: ReturnType<typeof useActivityIndex>;
}) {
  const [lens, setLens] = useState<Lens>("spatial");
  const [theme, setTheme] = useState<CanvasTheme>("night");
  const [circuit, setCircuit] = useState<Circuit>("all");
  const [focusedId, setFocusedId] = useState<string>("pending");
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<RemoteSnapshot>(EMPTY_REMOTE);
  const [refreshing, setRefreshing] = useState(false);

  const loadRemote = useCallback(async () => {
    setRefreshing(true);
    const settled = await Promise.allSettled([
      request<CommercialOverview>("/api/opc/commercial/overview"),
      request<BusinessPortfolio>("/api/opc/business/lines"),
      request<{ items: Delegation[] }>("/api/opc/delegations"),
      api.me(),
      workflowEnabled ? api.workflows() : Promise.resolve({ runs: [] }),
      api.opportunities(),
      request<{ capabilities: Array<{ id: string }> }>("/api/opc/capabilities/versions"),
      api.companyIndex(),
      request<SecurityDepartmentIndex>("/api/opc/departments/security"),
      request<OperationsIndex>("/api/opc/departments/operations"),
      request<ResourceDepartmentIndex>("/api/opc/departments/resources"),
      api.worklog(),
    ]);

    const commercial = settled[0].status === "fulfilled" ? settled[0].value : null;
    const business = settled[1].status === "fulfilled" ? settled[1].value : null;
    const delegations = settled[2].status === "fulfilled" ? settled[2].value.items : [];
    const me = settled[3].status === "fulfilled" ? settled[3].value : null;
    const workflows = settled[4].status === "fulfilled" ? settled[4].value.runs : [];
    const opps = settled[5].status === "fulfilled" ? settled[5].value.opportunities : [];
    const caps = settled[6].status === "fulfilled" ? settled[6].value.capabilities : [];
    const company = settled[7].status === "fulfilled" ? settled[7].value : null;
    const security = settled[8].status === "fulfilled" ? settled[8].value.reviews : [];
    const ops = settled[9].status === "fulfilled" ? settled[9].value.services : [];
    const resources = settled[10].status === "fulfilled" ? settled[10].value.plans : [];
    const worklog = settled[11].status === "fulfilled" ? settled[11].value : null;

    const ideaCount = company ? (company.ideas?.length ?? 0) + (company.information?.length ?? 0) : 0;
    const securityOpen = security.filter(r => r.history.at(-1)?.outcome !== "passed").length;
    const worklogEntries = worklog ? (worklog.bindings?.length ?? 0) : 0;

    setRemote({
      commercial,
      business,
      delegations,
      rooms: me?.rooms.filter(r => !r.archived) ?? [],
      agents: me?.agents ?? [],
      workflowCount: workflows.length,
      activeWorkflowCount: workflows.filter(w => w.phase !== "complete").length,
      opportunityCount: opps.length,
      capabilityCount: caps.length,
      ideaCount,
      securityTotal: security.length,
      securityOpen,
      opsManaged: ops.length,
      resourcePlans: resources.length,
      worklogEntries,
      syncedAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    });
    setRefreshing(false);
  }, [workflowEnabled]);

  useEffect(() => {
    void loadRemote();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadRemote();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadRemote]);

  const stageStats = useMemo(() => {
    const map = new Map<ProductStageId, { tasks: Set<string>; pending: number }>();
    for (const stage of productStages) {
      map.set(stage.id, { tasks: new Set(), pending: 0 });
    }
    for (const item of messages) {
      if (!item.stage) continue;
      const bucket = map.get(item.stage);
      if (!bucket) continue;
      bucket.tasks.add(taskKey(item));
      if (item.pending) bucket.pending += 1;
    }
    return map;
  }, [messages]);

  const maxStageTasks = useMemo(() => {
    let max = 1;
    stageStats.forEach(v => {
      if (v.tasks.size > max) max = v.tasks.size;
    });
    return max;
  }, [stageStats]);

  const activeDelegations = remote.delegations.filter(d => d.status === "working" || d.status === "queued" || d.status === "approval");
  const healthyServices = remote.commercial?.services.filter(s => s.healthy).length ?? 0;
  const totalServices = remote.commercial?.services.length ?? 6;
  const onlineAgents = remote.agents.filter(a => a.online && !a.demo).length;
  const liveSessions = activityIndex.data?.agents.length ?? 0;
  const liveRepos = activityIndex.data?.repositories.length ?? 0;
  const lines = remote.business?.lines ?? [];
  const trials = remote.business?.trials ?? [];

  const nodes: TwinNode[] = useMemo(() => [
    // Row 1: Founder Cortex (5 nodes across x=40..1160)
    {
      id: "overview",
      zone: "脑枢 · 总控",
      circuit: "decision",
      title: "全局看板",
      svgSub: "业务线、四部与阶段总表",
      subtitle: "一屏总览工作现场、业务线、公司四部、待办与十三阶矩阵",
      metric: `${products.length || 1} 产品域`,
      href: "#overview",
      x: 40, y: 46, w: 208, h: 74,
      status: "ok",
      chips: [{ label: "打开全局看板 ↗", href: "#overview" }],
    },
    {
      id: "pending",
      zone: "脑枢 · 裁决闸门",
      circuit: "decision",
      title: "待我处理",
      svgSub: "创始人拍板与审批放行",
      subtitle: "需创始人拍板、答复或放行的高优事项闸门",
      metric: `${pending.length} 待裁决`,
      href: inboxLink({ filter: "pending" }),
      x: 268, y: 46, w: 208, h: 74,
      status: pending.length > 0 ? "alert" : "ok",
      chips: pending.slice(0, 2).map(m => ({ label: m.taskTitle.slice(0, 14), href: inboxLink({ message: m.id }) })),
    },
    {
      id: "inbox",
      zone: "脑枢 · 信息总线",
      circuit: "decision",
      title: "全部消息",
      svgSub: "全公司 Agent 汇报总流",
      subtitle: "全公司 Agent 汇报、提问、进展与回执统一收件箱",
      metric: `${messages.length} 条信号`,
      href: "#inbox",
      x: 496, y: 46, w: 208, h: 74,
      status: messages.length > 0 ? "active" : "idle",
      chips: [
        { label: "全部消息 ↗", href: "#inbox" },
        { label: "未标注阶段 ↗", href: inboxLink({ stage: "unfiled" }) },
      ],
    },
    {
      id: "handled",
      zone: "脑枢 · 决策归档",
      circuit: "decision",
      title: "已处理",
      svgSub: "已审批与闭环历史归档",
      subtitle: "已完成审批、回复与交付验收的历史记录归档",
      metric: `${handled.length} 已归档`,
      href: inboxLink({ filter: "handled" }),
      x: 724, y: 46, w: 208, h: 74,
      status: "ok",
    },
    {
      id: "delegations",
      zone: "脑枢 · 调度中枢",
      circuit: "decision",
      title: "委派台",
      svgSub: "派单、在办追踪与对账",
      subtitle: "向数字员工派单、设置默认办理方式、追踪在办与对账",
      metric: `${activeDelegations.length} 在办 / ${remote.delegations.length} 总计`,
      href: "#delegations",
      x: 952, y: 46, w: 208, h: 74,
      status: activeDelegations.length > 0 ? "active" : "ok",
    },

    // Row 2: Left Wing (R&D Upstream) | Right Wing (Business & Commercial Core)
    {
      id: "ideas",
      zone: "产研左翼 · 认知源头",
      circuit: "rd",
      title: "信息与想法",
      svgSub: "技术复盘日记与立项孵化",
      subtitle: "技术复盘日记、外部情报摘录与新产品想法孵化",
      metric: `${remote.ideaCount} 条笔记/想法`,
      href: "#ideas",
      x: 40, y: 190, w: 254, h: 76,
      status: remote.ideaCount > 0 ? "active" : "ok",
    },
    {
      id: "opportunities",
      zone: "产研左翼 · 候选池",
      circuit: "rd",
      title: "研发选题",
      svgSub: "价值评估排序与自动派发",
      subtitle: "按影响力 × 信心 × 成本评估候选特性并衔接自动化流水线",
      metric: `${remote.opportunityCount} 个候选特性`,
      href: "#opportunities",
      x: 316, y: 190, w: 254, h: 76,
      status: remote.opportunityCount > 0 ? "active" : "ok",
    },
    {
      id: "business",
      zone: "经营右翼 · 战略主线",
      circuit: "commercial",
      title: "公司业务线",
      svgSub: "4 条价值线与经营实验账本",
      subtitle: "统一管理技术研发、店铺运营、旗舰插件与 Open-Core 业务线实验",
      metric: `${lines.length} 业务线 · ${trials.length} 实验`,
      href: "#business-lines",
      x: 630, y: 190, w: 254, h: 76,
      status: "active",
      chips: lines.slice(0, 3).map(l => ({ label: l.name, href: `#business-lines?line=${encodeURIComponent(l.id)}` })),
    },
    {
      id: "commercial",
      zone: "经营右翼 · 变现总控",
      circuit: "commercial",
      title: "商业与治理部",
      svgSub: "7 层地图、1号试点与离线授权",
      subtitle: "统筹 7 层资产地图、1 号变现试点、收银离线授权、门面合规与 DuckDB 漏斗",
      metric: `试点 ${remote.commercial?.completionPct ?? 0}% · ${remote.commercial?.metrics.activeLicenses ?? 0} 授权`,
      href: "#commercial",
      x: 906, y: 190, w: 254, h: 76,
      status: "active",
      chips: [
        { label: "1号商业试点 ↗", href: "#commercial" },
        { label: "产品门面 ↗", href: "https://magele758.github.io/products/" },
      ],
    },

    // Row 3: Left Wing (Assets & Lifecycle) | Right Wing (Growth & Security)
    {
      id: "projects",
      zone: "产研左翼 · 资产架",
      circuit: "rd",
      title: "项目目录",
      svgSub: "产品与仓库档案",
      subtitle: "管理各产品名下子项目与绑定的 GitHub 仓库档案",
      metric: `${folders.length} 目录节点`,
      href: "#projects",
      x: 40, y: 314, w: 168, h: 76,
      status: "ok",
    },
    {
      id: "product",
      zone: "产研左翼 · 阶段章节",
      circuit: "rd",
      title: "产品进程",
      svgSub: "十三阶章节导航",
      subtitle: "按公司方向、产品定义、交付运行、市场财务查阅 13 阶进度",
      metric: `13 阶全链路`,
      href: "#product",
      x: 221, y: 314, w: 168, h: 76,
      status: "active",
    },
    {
      id: "capabilities",
      zone: "产研左翼 · 复用库",
      circuit: "rd",
      title: "开源能力",
      svgSub: "跨仓版本与复用",
      subtitle: "登记可跨业务线复用的开源仓库版本与维护审批",
      metric: `${remote.capabilityCount} 项能力`,
      href: "#capabilities",
      x: 402, y: 314, w: 168, h: 76,
      status: "ok",
    },
    {
      id: "growth",
      zone: "经营右翼 · GTM 漏斗",
      circuit: "commercial",
      title: "渠道转化",
      svgSub: "获客 → 激活 → 首单 → 复购",
      subtitle: "追踪各推广渠道从获客、激活到首单与复购的真实转化率",
      metric: `获客 ${remote.commercial?.metrics.funnel.acquired ?? 0} · 首单 ${remote.commercial?.metrics.funnel.firstOrder ?? 0}`,
      href: "#growth",
      x: 630, y: 314, w: 254, h: 76,
      status: "ok",
    },
    {
      id: "security",
      zone: "经营右翼 · 风险护栏",
      circuit: "commercial",
      title: "安全部门",
      svgSub: "权限核查、安全评审与复核",
      subtitle: "发版前安全评审、最小权限边界核查与问题整改复审",
      metric: remote.securityOpen > 0 ? `${remote.securityOpen} 待整改 / ${remote.securityTotal}` : `${remote.securityTotal} 项评审`,
      href: "#security-department",
      x: 906, y: 314, w: 254, h: 76,
      status: remote.securityOpen > 0 ? "alert" : "ok",
    },

    // Row 4: Left Wing (Multi-Agent Execution) | Right Wing (Ops & Resource Cost)
    {
      id: "channels",
      zone: "执行场 · 异构群聊",
      circuit: "rd",
      title: "昆仑频道",
      svgSub: "异构模型群聊评审",
      subtitle: "跨模型客户端群聊、方案招投标与串行角色评审频道",
      metric: `${remote.rooms.length} 频道 · ${onlineAgents} 在线`,
      href: "#channels",
      x: 40, y: 438, w: 168, h: 76,
      status: onlineAgents > 0 || remote.rooms.length > 0 ? "active" : "idle",
      chips: remote.rooms.slice(0, 3).map(r => ({ label: `#${r.name}`, href: `#channels?room=${encodeURIComponent(r.id)}` })),
    },
    {
      id: "workflows",
      zone: "执行场 · 自治流水线",
      circuit: "rd",
      title: "工作流看板",
      svgSub: "计划审批与证据包",
      subtitle: "自治编码 DAG 计划审批、Runner 路由与执行证据验收",
      metric: workflowEnabled ? `${remote.activeWorkflowCount} 运行 / ${remote.workflowCount}` : "按需启用",
      href: workflowEnabled ? "#workflows" : "#delegations",
      x: 221, y: 438, w: 168, h: 76,
      status: remote.activeWorkflowCount > 0 ? "active" : "ok",
    },
    {
      id: "homeroom",
      zone: "执行场 · 房间桥接",
      circuit: "rd",
      title: "项目讨论室",
      svgSub: "Agent Home 桥接",
      subtitle: "联动常驻数字员工 Agent Home 的专题房间与回执同步",
      metric: "双向回执同步",
      href: "#home-room",
      x: 402, y: 438, w: 168, h: 76,
      status: "ok",
    },
    {
      id: "operations",
      zone: "经营右翼 · 可用性保障",
      circuit: "commercial",
      title: "运维部门",
      svgSub: "端点健康探针与升级台账",
      subtitle: "检查全公司服务端点在线延迟、记录巡检结论与版本升级验证",
      metric: `${healthyServices}/${totalServices} 在线 · ${remote.opsManaged} 台账`,
      href: "#operations-department",
      x: 630, y: 438, w: 254, h: 76,
      status: healthyServices === totalServices ? "ok" : "alert",
    },
    {
      id: "resources",
      zone: "经营右翼 · 算力财务",
      circuit: "commercial",
      title: "资源成本部门",
      svgSub: "模型套餐余量与续费账单",
      subtitle: "核对各 AI 订阅与 API 套餐的可用额度、重置窗口及月度费用",
      metric: `${remote.resourcePlans} 份套餐监控`,
      href: "#resource-department",
      x: 906, y: 438, w: 254, h: 76,
      status: "ok",
    },

    // Row 5: Bottom Runtime & Microservice Substrate
    {
      id: "activity",
      zone: "底座 · 实时工作现场",
      circuit: "runtime",
      title: "会话与仓库索引",
      svgSub: "扫描本机活跃编码 Agent 会话与 GitHub 仓库动态",
      subtitle: "实时聚合本机 CLI/IDE 编码会话状态与名下全部 GitHub 仓库索引",
      metric: `${liveSessions} 会话 · ${liveRepos} 仓库`,
      href: "#activity-index",
      x: 40, y: 582, w: 356, h: 80,
      status: liveSessions > 0 ? "active" : "ok",
      chips: [
        { label: "会话视图 ↗", href: "#activity-index?view=agents" },
        { label: "仓库视图 ↗", href: "#activity-index?view=repos" },
      ],
    },
    {
      id: "worklog",
      zone: "底座 · 时间能量账本",
      circuit: "runtime",
      title: "工作投入",
      svgSub: "按日期与业务线归集创始人及数字员工投入",
      subtitle: "按天与业务线绑定复盘创始人及数字员工在各项目的真实投入",
      metric: `${remote.worklogEntries} 条投入绑定`,
      href: "#worklog",
      x: 422, y: 582, w: 356, h: 80,
      status: "ok",
    },
    {
      id: "substrate",
      zone: "底座 · 六大伴生引擎总线",
      circuit: "runtime",
      title: "OPC 伴生微服务神经簇",
      svgSub: "Commerce · GTM · Ops · DuckDB · Home · Hub",
      subtitle: "收银授权(:52331)、获客(:52332)、客服遥测(:52333)、DuckDB(:8000)等实时联动",
      metric: `${healthyServices} / ${totalServices} 引擎健康在线`,
      href: "#commercial",
      x: 804, y: 582, w: 356, h: 80,
      status: healthyServices === totalServices ? "ok" : "alert",
      chips: [
        { label: "商业总控 ↗", href: "#commercial" },
        { label: "端点健康检查 ↗", href: "#operations-department" },
      ],
    },
  ], [
    products.length,
    pending,
    messages.length,
    handled.length,
    activeDelegations.length,
    remote,
    lines,
    trials.length,
    folders.length,
    onlineAgents,
    workflowEnabled,
    healthyServices,
    totalServices,
    liveSessions,
    liveRepos,
  ]);

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const focused = nodeMap.get(focusedId) ?? nodes[0];

  const connectedIds = useMemo(() => {
    const set = new Set<string>([focused.id]);
    for (const edge of EDGES) {
      if (edge.from === focused.id) set.add(edge.to);
      if (edge.to === focused.id) set.add(edge.from);
    }
    return set;
  }, [focused.id]);

  const atlasItems = useMemo(() => {
    const stageItems = productStages.map((s, idx) => {
      const stat = stageStats.get(s.id);
      const count = stat?.tasks.size ?? 0;
      return {
        key: `stage-${s.id}`,
        group: "十三阶工作单",
        title: `${String(idx + 1).padStart(2, "0")} · ${s.label}阶段台`,
        desc: `查看并协同推进全产品线在「${s.label}」阶段的工作单与讨论`,
        metric: `${count} 任务`,
        href: `#stage?step=${s.id}`,
      };
    });
    return [
      ...nodes.map(n => ({
        key: n.id,
        group: n.zone,
        title: n.title,
        desc: n.subtitle,
        metric: n.metric,
        href: n.href,
      })),
      ...stageItems,
    ].filter(item => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q) ||
        item.href.toLowerCase().includes(q)
      );
    });
  }, [nodes, stageStats, query]);

  const isNight = theme === "night";
  const palette = {
    grid: isNight ? "rgba(210, 224, 216, 0.05)" : "rgba(42, 46, 40, 0.06)",
    zoneBg: isNight ? "rgba(255, 255, 255, 0.025)" : "rgba(255, 253, 247, 0.65)",
    zoneStroke: isNight ? "rgba(232, 183, 123, 0.18)" : "rgba(130, 124, 108, 0.34)",
    zoneLabel: isNight ? "rgba(232, 219, 195, 0.66)" : "#5c594f",
    cardFill: isNight ? "#1c2927" : "#fffdf8",
    cardSelected: isNight ? "#243633" : "#f8efe2",
    cardStroke: isNight ? "#3c524e" : "#bfb9a8",
    title: isNight ? "#f7f4eb" : "#222623",
    sub: isNight ? "#9eb0a9" : "#66645b",
    metricBg: isNight ? "rgba(13, 20, 19, 0.68)" : "#f1ede2",
  };

  const statusColor = (status: TwinNode["status"]) => {
    if (status === "alert") return isNight ? "#ff7a59" : "#a13b22";
    if (status === "active") return isNight ? "#5ce0a0" : "#286e4c";
    if (status === "ok") return isNight ? "#d8b47c" : "#6d6654";
    return isNight ? "#6f7f7a" : "#9c988c";
  };

  const stageGroups = [
    { title: "I · 产品定义（01–04）", slice: productStages.slice(0, 4) },
    { title: "II · 交付与运行（05–09）", slice: productStages.slice(4, 9) },
    { title: "III · 市场与财务（10–13）", slice: productStages.slice(9, 13) },
  ];

  return (
    <section className="zo-product dt-page" aria-label="组织数字孪生">
      <header className="dt-head">
        <div className="dt-title-wrap">
          <div className="dt-title-row">
            {nav}
            <h1>组织数字孪生</h1>
            <span className="dt-draft-pill">
              <i aria-hidden="true" />
              设计稿 v1 · 实时全息沙盘
            </span>
          </div>
          <p className="dt-sub">
            将一人公司（OPC）的决策脑枢、多 Agent 产研工坊、商业四部、十三阶价值流与底层引擎映射为可交互数字孪生体——点击任意舱室或节点直达对应模块。
          </p>
        </div>
        <div className="dt-controls">
          <div className="dt-seg" role="group" aria-label="孪生透镜视角">
            <button type="button" aria-pressed={lens === "spatial"} onClick={() => setLens("spatial")}>
              全息空间沙盘
            </button>
            <button type="button" aria-pressed={lens === "loops"} onClick={() => setLens("loops")}>
              双闭环价值流
            </button>
            <button type="button" aria-pressed={lens === "atlas"} onClick={() => setLens("atlas")}>
              全功能星图 ({22 + productStages.length})
            </button>
          </div>
          {lens === "spatial" && (
            <div className="dt-seg" role="group" aria-label="沙盘画布风格">
              <button type="button" aria-pressed={theme === "night"} onClick={() => setTheme("night")}>
                昆仑夜航
              </button>
              <button type="button" aria-pressed={theme === "paper"} onClick={() => setTheme("paper")}>
                宣纸堪舆
              </button>
            </div>
          )}
          <button
            type="button"
            className="dt-refresh"
            disabled={refreshing}
            onClick={() => {
              void loadRemote();
              void activityIndex.load(true);
            }}
          >
            {refreshing ? "同步中…" : `同步脉搏${remote.syncedAt ? " · " + remote.syncedAt : ""}`}
          </button>
        </div>
      </header>

      {/* Organization Vital Signs Strip */}
      <nav className="dt-vitals" aria-label="组织实时生命体征">
        <a className="dt-vital" href={inboxLink({ filter: "pending" })} data-alert={pending.length > 0}>
          <span className="dt-vital-label">待裁决闸门 <em>↗</em></span>
          <strong>{pending.length}</strong>
          <small>{ messages.length } 条总消息 · { handled.length } 已归档</small>
        </a>
        <a className="dt-vital" href="#delegations">
          <span className="dt-vital-label">自治委派与流水线 <em>↗</em></span>
          <strong>{activeDelegations.length + remote.activeWorkflowCount}</strong>
          <small>{activeDelegations.length} 在办委派 · {remote.workflowCount} 工作流</small>
        </a>
        <a className="dt-vital" href="#channels">
          <span className="dt-vital-label">昆仑多 Agent 协同 <em>↗</em></span>
          <strong>{remote.rooms.length} / {remote.agents.length}</strong>
          <small>{remote.rooms.length} 活跃频道 · {onlineAgents} 实时在线</small>
        </a>
        <a className="dt-vital" href="#business-lines">
          <span className="dt-vital-label">业务线与实验 <em>↗</em></span>
          <strong>{lines.length} 线 · {trials.length} 轮</strong>
          <small>{remote.opportunityCount} 个研发候选选题</small>
        </a>
        <a className="dt-vital" href="#commercial">
          <span className="dt-vital-label">1号变现闭环 <em>↗</em></span>
          <strong>{remote.commercial?.completionPct ?? 0}%</strong>
          <small>{remote.commercial?.pilot.product ?? "PageLens"} · {remote.commercial?.metrics.activeLicenses ?? 0} 有效授权</small>
        </a>
        <a className="dt-vital" href="#operations-department" data-alert={healthyServices < totalServices}>
          <span className="dt-vital-label">微服务神经底座 <em>↗</em></span>
          <strong>{healthyServices}/{totalServices}</strong>
          <small>{liveSessions} 本机会话 · {liveRepos} 索引仓库</small>
        </a>
      </nav>

      {/* LENS 1: Spatial Holographic Twin Blueprint */}
      {lens === "spatial" && (
        <div className="dt-stage-shell" data-theme={theme}>
          <div className="dt-stage-bar">
            <div className="dt-circuits" role="group" aria-label="信息流回路高亮">
              <span>信号回路筛选：</span>
              <button type="button" aria-pressed={circuit === "all"} onClick={() => setCircuit("all")}>
                全部神经回路
              </button>
              {(Object.keys(CIRCUIT_COLOR) as Array<Exclude<Circuit, "all">>).map(key => (
                <button key={key} type="button" aria-pressed={circuit === key} onClick={() => setCircuit(key)}>
                  {CIRCUIT_COLOR[key].name}
                </button>
              ))}
            </div>
            <span className="dt-stage-hint">悬停舱室透视上下游链路 · 单击任意舱室立即直达</span>
          </div>

          <div className="dt-canvas-scroll">
            <svg
              className="dt-svg"
              viewBox="0 0 1200 690"
              role="img"
              aria-label="OPC 一人公司全息组织数字孪生拓扑沙盘"
            >
              <defs>
                <pattern id="dt-grid" width="30" height="30" patternUnits="userSpaceOnUse">
                  <path d="M 30 0 L 0 0 0 30" fill="none" stroke={palette.grid} strokeWidth="1" />
                </pattern>
              </defs>

              {/* Architectural Blueprint Grid */}
              <rect x="0" y="0" width="1200" height="690" fill="url(#dt-grid)" />

              {/* 5 Architectural Zone Enclosures */}
              <g aria-hidden="true">
                {/* Zone I: Founder Cortex */}
                <rect x="24" y="16" width="1152" height="118" rx="3" fill={palette.zoneBg} stroke={palette.zoneStroke} strokeDasharray="4 4" />
                <text x="38" y="34" fill={palette.zoneLabel} fontSize="11" fontWeight="600" letterSpacing="0.08em">
                  ZONE I · 创始人决策脑枢与调度总控（FOUNDER CORTEX &amp; DISPATCH BUS）
                </text>

                {/* Zone II: Left R&D & Multi-Agent Foundry */}
                <rect x="24" y="156" width="562" height="374" rx="3" fill={palette.zoneBg} stroke={palette.zoneStroke} strokeDasharray="4 4" />
                <text x="38" y="176" fill={palette.zoneLabel} fontSize="11" fontWeight="600" letterSpacing="0.08em">
                  ZONE II · 产研资产库与昆仑多 AGENT 协同工坊（R&amp;D &amp; SWARM FOUNDRY）
                </text>

                {/* Zone III: Right Commercial & Governance */}
                <rect x="614" y="156" width="562" height="374" rx="3" fill={palette.zoneBg} stroke={palette.zoneStroke} strokeDasharray="4 4" />
                <text x="628" y="176" fill={palette.zoneLabel} fontSize="11" fontWeight="600" letterSpacing="0.08em">
                  ZONE III · 商业变现与公司四部治理平面（COMMERCIAL &amp; GOVERNANCE）
                </text>

                {/* Zone V: Live Runtime & Microservice Substrate */}
                <rect x="24" y="550" width="1152" height="124" rx="3" fill={palette.zoneBg} stroke={palette.zoneStroke} strokeDasharray="4 4" />
                <text x="38" y="570" fill={palette.zoneLabel} fontSize="11" fontWeight="600" letterSpacing="0.08em">
                  ZONE IV · 现场编码会话、工时能量账本与六大微服务神经底座（RUNTIME &amp; SUBSTRATE）
                </text>
              </g>

              {/* Animated Information-Flow Conduits */}
              <g aria-hidden="true">
                {EDGES.map((edge, idx) => {
                  const a = nodeMap.get(edge.from);
                  const b = nodeMap.get(edge.to);
                  if (!a || !b) return null;
                  const d = conduitPath(a, b);
                  const color = isNight ? CIRCUIT_COLOR[edge.circuit].night : CIRCUIT_COLOR[edge.circuit].paper;
                  const circuitMatch = circuit === "all" || circuit === edge.circuit;
                  const hot = circuitMatch && (edge.from === focused.id || edge.to === focused.id);
                  const dim = !circuitMatch;
                  return (
                    <g key={idx}>
                      <path className="dt-conduit" d={d} stroke={color} data-hot={hot} data-dim={dim} />
                      <path className="dt-conduit-flow" d={d} stroke={color} data-hot={hot} data-dim={dim} />
                    </g>
                  );
                })}
              </g>

              {/* 22 Interactive Clickable Twin Chambers */}
              {nodes.map(node => {
                const selected = focused.id === node.id;
                const circuitMatch = circuit === "all" || circuit === node.circuit;
                const dim = !circuitMatch && !connectedIds.has(node.id);
                const accent = isNight ? CIRCUIT_COLOR[node.circuit].night : CIRCUIT_COLOR[node.circuit].paper;
                const dot = statusColor(node.status);
                const compact = node.w < 190;

                return (
                  <a
                    key={node.id}
                    href={node.href}
                    className="dt-node"
                    data-selected={selected}
                    data-dim={dim}
                    aria-label={`${node.title}（${node.metric}）— 点击直达`}
                    onMouseEnter={() => setFocusedId(node.id)}
                    onFocus={() => setFocusedId(node.id)}
                  >
                    {node.status === "alert" && (
                      <rect
                        className="dt-pulse-ring"
                        x={node.x - 2}
                        y={node.y - 2}
                        width={node.w + 4}
                        height={node.h + 4}
                        rx="4"
                      />
                    )}
                    <rect
                      className="dt-node-box"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={node.h}
                      rx="3"
                      fill={selected ? palette.cardSelected : palette.cardFill}
                      stroke={selected ? accent : palette.cardStroke}
                    />
                    {/* Left Circuit Accent Bar */}
                    <rect x={node.x} y={node.y} width="3.5" height={node.h} rx="1.5" fill={accent} />

                    {/* Status Dot + Title */}
                    <circle cx={node.x + 15} cy={node.y + 22} r="4" fill={dot} />
                    <text
                      x={node.x + 25}
                      y={node.y + 26}
                      fill={palette.title}
                      fontSize={compact ? "14" : "15.5"}
                      fontWeight="700"
                      fontFamily="var(--serif)"
                    >
                      {node.title}
                    </text>

                    {/* Top-right Direct Arrow */}
                    <text
                      x={node.x + node.w - 11}
                      y={node.y + 24}
                      textAnchor="end"
                      fill={accent}
                      fontSize="12"
                    >
                      ↗
                    </text>

                    {/* Subtitle */}
                    <text
                      x={node.x + 14}
                      y={node.y + 45}
                      fill={palette.sub}
                      fontSize="11.2"
                    >
                      {node.svgSub}
                    </text>

                    {/* Live Metric Pill */}
                    <rect
                      x={node.x + 12}
                      y={node.y + node.h - 22}
                      width={node.w - 24}
                      height="16"
                      rx="2"
                      fill={palette.metricBg}
                    />
                    <text
                      x={node.x + 18}
                      y={node.y + node.h - 10.5}
                      fill={node.status === "alert" ? dot : accent}
                      fontSize="10.8"
                      fontFamily="var(--digits)"
                      fontWeight="600"
                    >
                      {node.metric}
                    </text>
                  </a>
                );
              })}
            </svg>
          </div>

          {/* Live Chamber Telemetry HUD */}
          <div className="dt-hud" role="region" aria-label="当前聚焦舱室透视">
            <div className="dt-hud-main">
              <div className="dt-hud-title">
                <strong>{focused.title}</strong>
                <span>[{focused.zone}] · {focused.metric} · 路由 {focused.href}</span>
              </div>
              <p>{focused.subtitle}</p>
            </div>
            <div className="dt-hud-links">
              {focused.chips?.map(chip => (
                <a
                  key={chip.label + chip.href}
                  className="dt-hud-chip"
                  href={chip.href}
                  target={chip.href.startsWith("http") ? "_blank" : undefined}
                  rel={chip.href.startsWith("http") ? "noreferrer" : undefined}
                >
                  {chip.label}
                </a>
              ))}
              <a className="dt-hud-chip primary" href={focused.href}>
                直达 {focused.title} ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* LENS 2: Dual Closed-Loop Value Stream */}
      {lens === "loops" && (
        <div className="dt-loops" aria-label="双闭环价值流视图">
          <section className="dt-loop-card">
            <header>
              <h3>闭环 A · 情报立项 → 多 Agent 产研 → 安全发布交付链</h3>
              <span>点击任一环节直达对应工作台</span>
            </header>
            <div className="dt-loop-steps">
              <a className="dt-loop-step" href="#ideas">
                <span>STEP A1 · 认知输入</span>
                <strong>信息与想法 ↗</strong>
                <small>{remote.ideaCount} 条日记与想法沉淀</small>
              </a>
              <a className="dt-loop-step" href="#opportunities">
                <span>STEP A2 · 价值筛选</span>
                <strong>研发选题 ↗</strong>
                <small>{remote.opportunityCount} 个候选特性待转化</small>
              </a>
              <a className="dt-loop-step" href="#channels">
                <span>STEP A3 · 专家博弈</span>
                <strong>昆仑多 Agent 频道 ↗</strong>
                <small>{remote.rooms.length} 频道异构评审与招投标</small>
              </a>
              <a className="dt-loop-step" href={workflowEnabled ? "#workflows" : "#delegations"}>
                <span>STEP A4 · 自治编码</span>
                <strong>工作流与委派台 ↗</strong>
                <small>{activeDelegations.length} 在办委派 · {remote.workflowCount} 流水线</small>
              </a>
              <a className="dt-loop-step" href="#security-department">
                <span>STEP A5 · 安全门禁</span>
                <strong>安全部门审查 ↗</strong>
                <small>{remote.securityTotal} 项评审 · {remote.securityOpen} 待整改</small>
              </a>
              <a className="dt-loop-step" href="#capabilities">
                <span>STEP A6 · 资产沉淀</span>
                <strong>开源能力与项目架 ↗</strong>
                <small>{remote.capabilityCount} 项登记能力可跨线复用</small>
              </a>
            </div>
          </section>

          <section className="dt-loop-card">
            <header>
              <h3>闭环 B · 产品门面 → UTM 获客 → 离线授权收银 → DuckDB 经营复盘链</h3>
              <span>聚焦 1 号商业试点：{remote.commercial?.pilot.product ?? "PageLens"}（{remote.commercial?.completionPct ?? 0}% 就绪）</span>
            </header>
            <div className="dt-loop-steps">
              <a className="dt-loop-step" href="#business-lines">
                <span>STEP B1 · 商业假设</span>
                <strong>公司业务线 ↗</strong>
                <small>{lines.length} 条业务线 · {trials.length} 轮经营实验</small>
              </a>
              <a className="dt-loop-step" href="#stage?step=gtm">
                <span>STEP B2 · 门面合规</span>
                <strong>GTM 阶段工作单 ↗</strong>
                <small>独立着陆页、定价锚点与退款合规页</small>
              </a>
              <a className="dt-loop-step" href="#growth">
                <span>STEP B3 · 流量归因</span>
                <strong>渠道转化报表 ↗</strong>
                <small>获客 {remote.commercial?.metrics.funnel.acquired ?? 0} · 激活 {remote.commercial?.metrics.funnel.activated ?? 0}</small>
              </a>
              <a className="dt-loop-step" href="#commercial">
                <span>STEP B4 · 收银授权</span>
                <strong>商业与治理部 ↗</strong>
                <small>{remote.commercial?.metrics.orders ?? 0} 笔订单 · {remote.commercial?.metrics.activeLicenses ?? 0} 张离线授权</small>
              </a>
              <a className="dt-loop-step" href="#operations-department">
                <span>STEP B5 · 留存运维</span>
                <strong>运维与客服探针 ↗</strong>
                <small>{healthyServices}/{totalServices} 引擎在线 · {remote.commercial?.metrics.openTickets ?? 0} 待办工单</small>
              </a>
              <a className="dt-loop-step" href="#resource-department">
                <span>STEP B6 · 毛利对账</span>
                <strong>资源成本与记账 ↗</strong>
                <small>{remote.resourcePlans} 份算力套餐成本核算</small>
              </a>
            </div>
          </section>
        </div>
      )}

      {/* LENS 3: Searchable Full-Feature Star Map */}
      {lens === "atlas" && (
        <section className="dt-section" aria-label="全功能星图目录">
          <div className="dt-search-bar">
            <input
              type="search"
              aria-label="搜索应用全部功能模块或阶段"
              placeholder="输入关键词筛选全部 35 个功能舱室与阶段工作台（如：委派、商业、安全、频道、PRD、记账…）"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <span>共匹配 {atlasItems.length} 个直达入口</span>
          </div>
          <div className="dt-atlas-grid">
            {atlasItems.map(item => (
              <a key={item.key} className="dt-atlas-card" href={item.href}>
                <div className="dt-atlas-top">
                  <span>{item.group}</span>
                  <b>{item.metric} ↗</b>
                </div>
                <strong>{item.title}</strong>
                <p>{item.desc}</p>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Always-On 13-Stage Lifecycle Value Conveyor */}
      <section className="dt-section" aria-label="十三阶全生命周期价值传送带">
        <div className="dt-section-head">
          <h2>十三阶全生命周期价值传送带</h2>
          <a href="#product">打开产品进程总表 ↗</a>
        </div>
        <div className="dt-conveyor-groups">
          {stageGroups.map(group => (
            <div key={group.title} className="dt-conveyor-group" data-cols={group.slice.length}>
              <header>
                <span>{group.title}</span>
                <span>点击直达阶段工作台</span>
              </header>
              <div className="dt-stage-track">
                {group.slice.map(stage => {
                  const idx = productStages.findIndex(s => s.id === stage.id) + 1;
                  const stat = stageStats.get(stage.id);
                  const count = stat?.tasks.size ?? 0;
                  const pend = stat?.pending ?? 0;
                  const pct = count === 0 ? 8 : Math.max(18, Math.round((count / maxStageTasks) * 100));
                  return (
                    <a
                      key={stage.id}
                      className="dt-stage-cell"
                      href={`#stage?step=${stage.id}`}
                      data-active={count > 0}
                      data-pending={pend > 0}
                      title={`${stage.label}：${count} 项任务${pend ? `（${pend} 待处理）` : ""} — 点击打开阶段工作单`}
                    >
                      <span className="dt-stage-top">
                        <span>{String(idx).padStart(2, "0")}</span>
                        <b>{pend > 0 ? `${pend} 待办` : count > 0 ? `${count}` : "—"}</b>
                      </span>
                      <strong>{stage.label}</strong>
                      <span className="dt-meter" aria-hidden="true">
                        <i style={{ width: `${pct}%` }} />
                      </span>
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Sub-Entity Direct Portals: Business Lines, Channels/Agents, Folders & Services */}
      <section className="dt-section" aria-label="组织实体分舱直达">
        <div className="dt-section-head">
          <h2>组织活跃实体分舱直达</h2>
          <span>业务线子项 · 昆仑协作频道 · 目录收件夹 · 伴生微服务</span>
        </div>
        <div className="dt-portal-grid">
          <div className="dt-portal-box">
            <header>
              <h3>公司业务线分舱</h3>
              <a href="#business-lines">管理全部 ↗</a>
            </header>
            <ul className="dt-portal-list">
              {lines.length ? lines.map(line => (
                <li key={line.id}>
                  <a href={`#business-lines?line=${encodeURIComponent(line.id)}`}>
                    <span>{line.name}</span>
                    <small>{line.mode === "experiment" ? "经营实验" : "技术研发"} ↗</small>
                  </a>
                </li>
              )) : (
                <li><a href="#business-lines"><span>进入公司业务线</span><small>↗</small></a></li>
              )}
            </ul>
          </div>

          <div className="dt-portal-box">
            <header>
              <h3>昆仑频道与讨论室</h3>
              <a href="#channels">进入频道 ↗</a>
            </header>
            <ul className="dt-portal-list">
              {remote.rooms
                .filter((room, idx, arr) => arr.findIndex(r => r.name === room.name && r.project === room.project && r.direct === room.direct) === idx)
                .slice(0, 4)
                .map(room => (
                <li key={room.id}>
                  <a href={`#channels?room=${encodeURIComponent(room.id)}`}>
                    <span>{room.direct ? `私聊 · ${room.name}` : `#${room.name}`}{room.project ? ` · ${room.project}` : room.topic ? ` · ${room.topic.slice(0, 12)}` : ""}</span>
                    <small>{room.unread ? `${room.unread} 未读` : "直达"} ↗</small>
                  </a>
                </li>
              ))}
              <li>
                <a href="#home-room">
                  <span>Agent Home 项目讨论室</span>
                  <small>桥接 ↗</small>
                </a>
              </li>
              {workflowEnabled && (
                <li>
                  <a href="#workflows">
                    <span>自治工作流看板</span>
                    <small>{remote.workflowCount} 流水线 ↗</small>
                  </a>
                </li>
              )}
            </ul>
          </div>

          <div className="dt-portal-box">
            <header>
              <h3>目录收件夹与伴生服务</h3>
              <a href="#projects">项目目录 ↗</a>
            </header>
            <ul className="dt-portal-list">
              {folders.filter(f => f.depth === 0).slice(0, 3).map(folder => (
                <li key={folder.path}>
                  <a href={inboxLink({ folder: folder.path })}>
                    <span>📁 {folder.label}</span>
                    <small>{folder.count} 条消息 ↗</small>
                  </a>
                </li>
              ))}
              {(remote.commercial?.services ?? []).slice(0, 3).map(svc => (
                <li key={svc.id}>
                  <a href="#commercial">
                    <span>{svc.healthy ? "🟢" : "⚪"} {svc.name}</span>
                    <small>{svc.latencyMs != null ? `${svc.latencyMs}ms` : svc.layer} ↗</small>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Design Draft v1 Notes & V2 Iteration Choices */}
      <aside className="dt-design-note" aria-label="数字孪生设计稿说明">
        <header>
          <h3>设计稿说明 · 下一版深化方向（供你挑选）</h3>
          <span>当前为可交互 v1 原型：已接入实时 API 并打通全应用 35 个直达锚点</span>
        </header>
        <div className="dt-design-options">
          <div>
            <strong>方向 A · 画布内联微操作（In-Twin Actuation）</strong>
            在沙盘舱室上直接展开浮窗完成「一键批复待办 / 派发委派单 / 触发商业闭环冒烟」，无需跳页即可遥控全公司。
          </div>
          <div>
            <strong>方向 B · 2.5D 等轴测数字工位（Isometric Agent Office）</strong>
            为在线编码 Agent（Codex / Claude / AGY / Grok）渲染实时工位小人与任务气泡，直观看到谁在哪个仓库施工。
          </div>
          <div>
            <strong>方向 C · 时间轴回放（Organization Time-Travel）</strong>
            顶部增加 24h / 7d 时间滑杆，回放消息流、实验进展、订单授权与算力消耗随时间的演化轨迹。
          </div>
        </div>
      </aside>
    </section>
  );
}
