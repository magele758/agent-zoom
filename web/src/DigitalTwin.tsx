import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { chatRoomLink, decisionTarget } from "./zoom-routes";
import type { useActivityIndex } from "./ActivityIndex";
import "./digital-twin.css";

type Circuit = "all" | "decision" | "rd" | "commercial" | "runtime";
type Lens = "spatial" | "loops" | "atlas";
type Phosphor = "green" | "amber";
type AtlasFilter = "all" | Exclude<Circuit, "all"> | "stages";
type NodeStatus = "ok" | "active" | "alert" | "idle";

type TwinNode = {
  id: string;
  code: string;
  zone: string;
  circuit: Exclude<Circuit, "all">;
  title: string;
  svgSub: string;
  subtitle: string;
  metric: string;
  quiet?: boolean;
  href: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: NodeStatus;
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

const CIRCUIT_META: Record<Exclude<Circuit, "all">, { color: string; name: string; short: string }> = {
  decision: { color: "#ffb547", name: "创始人决策与委派回路", short: "决策脑枢" },
  rd: { color: "#4af59d", name: "多 Agent 产研与交付回路", short: "产研工坊" },
  commercial: { color: "#f47ad6", name: "商业变现与公司治理回路", short: "商业四部" },
  runtime: { color: "#52d6f4", name: "现场会话与底座遥测回路", short: "底座遥测" },
};

const ALERT_COLOR = "#ff5c52";
const LIVE_COLOR = "#4af59d";

const STATUS_META: Record<NodeStatus, { tag: string; label: string }> = {
  alert: { tag: "ALERT", label: "待裁决 / 告警" },
  active: { tag: "ACTIVE", label: "实时活跃" },
  ok: { tag: "STEADY", label: "稳态在线" },
  idle: { tag: "IDLE", label: "静默待命" },
};

const SIGNAL_TAG: Record<ZoomMessage["kind"], string> = {
  task: "TASK",
  progress: "PROG",
  question: "ASK?",
  decision: "DCSN",
  completed: "DONE",
  reply: "RPLY",
  recovery: "RCVR",
};

const LENSES: Array<{ id: Lens; label: string; code: string; caption: string }> = [
  { id: "spatial", label: "全息空间沙盘", code: "TOPOLOGY", caption: "悬停节点追踪上下游链路 · 单击直达现场" },
  { id: "loops", label: "双闭环价值流", code: "PIPELINES", caption: "产研交付链 × 商业变现链双轨透视" },
  { id: "atlas", label: "全功能星图", code: "ATLAS", caption: "全应用舱室与十三阶工作台快速检索" },
];

const PHOSPHORS: Array<{ id: Phosphor; code: string; label: string }> = [
  { id: "green", code: "P1", label: "绿磷" },
  { id: "amber", code: "P3", label: "琥珀" },
];

const SCREEN: Record<
  Phosphor,
  {
    bg: string;
    dot: string;
    cross: string;
    zoneFill: string;
    zoneStroke: string;
    bracket: string;
    zoneCode: string;
    zoneLabel: string;
    spine: string;
    nodeBg: string;
    nodeBgSelected: string;
    title: string;
    sub: string;
    code: string;
    ink: string;
    quiet: string;
    steady: string;
    idle: string;
  }
> = {
  green: {
    bg: "#030705",
    dot: "rgba(74, 245, 157, 0.12)",
    cross: "rgba(74, 245, 157, 0.3)",
    zoneFill: "rgba(74, 245, 157, 0.018)",
    zoneStroke: "rgba(74, 245, 157, 0.2)",
    bracket: "rgba(74, 245, 157, 0.75)",
    zoneCode: "#4af59d",
    zoneLabel: "#8fbfa1",
    spine: "rgba(74, 245, 157, 0.16)",
    nodeBg: "#05100a",
    nodeBgSelected: "#0a1c12",
    title: "#e4fcee",
    sub: "#7aa98c",
    code: "#4c7a5e",
    ink: "#02110a",
    quiet: "#56836a",
    steady: "#92c2a4",
    idle: "#2f4a39",
  },
  amber: {
    bg: "#070502",
    dot: "rgba(255, 181, 71, 0.11)",
    cross: "rgba(255, 181, 71, 0.28)",
    zoneFill: "rgba(255, 181, 71, 0.018)",
    zoneStroke: "rgba(255, 181, 71, 0.2)",
    bracket: "rgba(255, 181, 71, 0.75)",
    zoneCode: "#ffb547",
    zoneLabel: "#c9a676",
    spine: "rgba(255, 181, 71, 0.16)",
    nodeBg: "#0e0904",
    nodeBgSelected: "#1c1308",
    title: "#fff0d6",
    sub: "#b08f62",
    code: "#7d6440",
    ink: "#140c00",
    quiet: "#8a6f48",
    steady: "#c9a676",
    idle: "#54422a",
  },
};

const ZONES = [
  { x: 24, y: 14, w: 1152, h: 124, code: "01", label: "创始人决策脑枢 · FOUNDER_CORTEX" },
  { x: 24, y: 164, w: 558, h: 366, code: "02", label: "产研资产与多 Agent 工坊 · RND_FOUNDRY" },
  { x: 618, y: 164, w: 558, h: 366, code: "03", label: "商业变现与四部治理 · COMMERCIAL_HUB" },
  { x: 24, y: 554, w: 1152, h: 104, code: "04", label: "现场会话与微服务底座 · SUBSTRATE" },
];

const STAGE_SHORT_LABEL: Partial<Record<ProductStageId, string>> = {
  acquisition: "营销获客",
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

function DtIcon({
  name,
  className = "dt-ico",
}: {
  name: "sync" | "folder" | "layers" | "chat" | "pulse";
  className?: string;
}) {
  const paths: Record<typeof name, string> = {
    sync: "M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15 M4.5 19v-4h4 M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9 M19.5 5v4h-4",
    folder: "M3.5 6.5A1.5 1.5 0 0 1 5 5h4.4l2 2H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z",
    layers: "M12 3.5 20.5 8 12 12.5 3.5 8Z M3.5 12l8.5 4.5L20.5 12 M3.5 16l8.5 4.5L20.5 16",
    chat: "M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3v-3H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5Z",
    pulse: "M2.5 12h4.2l2.4-5.5 3.6 11 2.6-5.5h6.2",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" strokeLinejoin="miter">
      <path d={paths[name]} />
    </svg>
  );
}

const pad2 = (value: number) => String(value).padStart(2, "0");

function clockStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time.slice(0, 5)}`;
}

function readableRoute(href: string): string {
  try {
    return decodeURIComponent(href.replace(/\+/g, " "));
  } catch {
    return href;
  }
}

// SVG text has no layout box, so zone title plates are sized from mono advance widths (CJK = 1em, Latin = 0.6em).
function monoTextWidth(text: string, size: number): number {
  let width = 0;
  for (const ch of text) width += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.6;
  return width;
}

function DtClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="dt-sb-cell dt-sb-clock">
      <em>LOCAL</em>
      <b>
        <time dateTime={now.toISOString()}>
          {pad2(now.getHours())}:{pad2(now.getMinutes())}:{pad2(now.getSeconds())}
        </time>
      </b>
    </span>
  );
}

function roundedPolyline(points: Array<[number, number]>, radius = 4): string {
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

function conduitRoute(a: TwinNode, b: TwinNode): {
  d: string;
  start: [number, number];
  end: [number, number];
} {
  const acx = Math.round(a.x + a.w / 2);
  const bcx = Math.round(b.x + b.w / 2);
  const acy = Math.round(a.y + a.h / 2);
  const bcy = Math.round(b.y + b.h / 2);

  if (Math.abs(a.y - b.y) < 12) {
    const gap = Math.abs(b.x - (a.x + a.w));
    if (b.x >= a.x + a.w && gap < 80) {
      const start: [number, number] = [a.x + a.w, acy];
      const end: [number, number] = [b.x, bcy];
      return { d: `M ${start[0]} ${start[1]} L ${end[0]} ${end[1]}`, start, end };
    }
    if (a.x >= b.x + b.w && Math.abs(a.x - (b.x + b.w)) < 80) {
      const start: [number, number] = [a.x, acy];
      const end: [number, number] = [b.x + b.w, bcy];
      return { d: `M ${start[0]} ${start[1]} L ${end[0]} ${end[1]}`, start, end };
    }
    const corridorY = 148;
    const start: [number, number] = [acx, a.y + a.h];
    const end: [number, number] = [bcx, b.y + b.h];
    return {
      d: roundedPolyline([start, [acx, corridorY], [bcx, corridorY], end]),
      start,
      end,
    };
  }

  const down = b.y > a.y;
  const startY = down ? a.y + a.h : a.y;
  const endY = down ? b.y : b.y + b.h;
  const start: [number, number] = [acx, startY];
  const end: [number, number] = [bcx, endY];
  const rowJump = Math.abs(b.y - a.y);

  const busCorridorBetween = (y1: number, y2: number) => {
    const lo = Math.min(y1, y2);
    if (lo < 160) return 151;
    if (lo < 300) return 296;
    if (lo < 430) return 416;
    return 542;
  };

  if (rowJump < 165) {
    const midY = busCorridorBetween(startY, endY);
    return {
      d: roundedPolyline([start, [acx, midY], [bcx, midY], end]),
      start,
      end,
    };
  }

  const spineX = acx < 600 ? 595 : 605;
  const exitY = down
    ? startY < 160 ? 151 : startY + 20
    : startY > 530 ? 542 : startY - 20;
  const entryY = down
    ? endY > 530 ? 542 : endY - 22
    : endY < 160 ? 151 : endY + 22;

  return {
    d: roundedPolyline([start, [acx, exitY], [spineX, exitY], [spineX, entryY], [bcx, entryY], end]),
    start,
    end,
  };
}

function Brackets({
  x,
  y,
  w,
  h,
  stroke,
  size = 9,
  opacity = 1,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  size?: number;
  opacity?: number;
}) {
  const s = size;
  const d = [
    `M ${x} ${y + s} V ${y} H ${x + s}`,
    `M ${x + w - s} ${y} H ${x + w} V ${y + s}`,
    `M ${x} ${y + h - s} V ${y + h} H ${x + s}`,
    `M ${x + w - s} ${y + h} H ${x + w} V ${y + h - s}`,
  ].join(" ");
  return <path d={d} fill="none" stroke={stroke} strokeOpacity={opacity} strokeWidth="1.5" />;
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
  const [phosphor, setPhosphor] = useState<Phosphor>("green");
  const [circuit, setCircuit] = useState<Circuit>("all");
  const [focusedId, setFocusedId] = useState<string>("pending");
  const [query, setQuery] = useState("");
  const [atlasFilter, setAtlasFilter] = useState<AtlasFilter>("all");
  const [remote, setRemote] = useState<RemoteSnapshot>(EMPTY_REMOTE);
  const [refreshing, setRefreshing] = useState(false);
  const [reducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const searchRef = useRef<HTMLInputElement>(null);

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
      syncedAt: new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
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

  const refresh = useCallback(() => {
    void loadRemote();
    void activityIndex.load(true);
  }, [loadRemote, activityIndex]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "1" || event.key === "2" || event.key === "3") {
        setLens(LENSES[Number(event.key) - 1].id);
      } else if (event.key === "r" || event.key === "R") {
        if (!refreshing) refresh();
      } else if (event.key === "/") {
        event.preventDefault();
        setLens("atlas");
        window.requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh, refreshing]);

  const signalLog = useMemo(
    () => [...messages].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6),
    [messages]
  );

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

  const activeDelegations = remote.delegations.filter(
    d => d.status === "working" || d.status === "queued" || d.status === "approval"
  );
  const servicesList = remote.commercial?.services ?? [];
  const healthyServices = servicesList.filter(s => s.healthy).length;
  const totalServices = servicesList.length || 6;
  const servicesReady = remote.commercial !== null;
  const onlineAgents = remote.agents.filter(a => a.online && !a.demo).length;
  const liveSessions = activityIndex.data?.agents.length ?? 0;
  const liveRepos = activityIndex.data?.repositories.length ?? 0;
  const lines = remote.business?.lines ?? [];
  const trials = remote.business?.trials ?? [];
  const pilotPct = remote.commercial?.completionPct ?? 0;
  const acquiredCount = remote.commercial?.metrics.funnel.acquired ?? 0;
  const firstOrderCount = remote.commercial?.metrics.funnel.firstOrder ?? 0;

  const nodes: TwinNode[] = useMemo(
    () => [
      // Row 1: Founder Cortex (5 nodes across x=40..1160)
      {
        id: "overview",
        code: "C-01",
        zone: "脑枢 · 总控",
        circuit: "decision",
        title: "全局看板",
        svgSub: "业务线、四部与阶段总表",
        subtitle: "一屏总览工作现场、业务线、公司四部、待办与十三阶矩阵",
        metric: `${products.length || 1} 产品域`,
        href: "#overview",
        x: 40,
        y: 48,
        w: 208,
        h: 76,
        status: "ok",
        chips: [
          { label: "打开全局看板 ↗", href: "#overview" },
          { label: "总裁办 · Bot 架构 ↗", href: "#executive" },
          { label: "总裁信箱 ↗", href: "#mailbox" },
        ],
      },
      {
        id: "pending",
        code: "C-02",
        zone: "脑枢 · 裁决闸门",
        circuit: "decision",
        title: "待我处理",
        svgSub: "创始人拍板与审批放行",
        subtitle: "需创始人拍板、答复或放行的高优事项闸门，直连总裁信箱与群聊",
        metric: pending.length > 0 ? `${pending.length} 待裁决` : "0 待裁决 · 畅通",
        quiet: pending.length === 0,
        href: pending[0] ? decisionTarget(pending[0]) : "#mailbox",
        x: 268,
        y: 48,
        w: 208,
        h: 76,
        status: pending.length > 0 ? "alert" : "ok",
        chips:
          pending.length > 0
            ? pending.slice(0, 2).map(m => ({ label: m.taskTitle.slice(0, 14), href: decisionTarget(m) }))
            : [
                { label: "总裁信箱 ↗", href: "#mailbox" },
                { label: "总裁办审批 ↗", href: "#executive" },
              ],
      },
      {
        id: "inbox",
        code: "C-03",
        zone: "脑枢 · 协作总线",
        circuit: "decision",
        title: "Agent Home 群聊",
        svgSub: "多 Bot 群聊与待决提醒总线",
        subtitle: "Agent Home 群聊工作台，集中讨论需求、跟进待决提醒与续聊",
        metric: `${messages.length} 条信号`,
        quiet: messages.length === 0,
        href: "#home-room",
        x: 496,
        y: 48,
        w: 208,
        h: 76,
        status: messages.length > 0 ? "active" : "idle",
        chips: [
          { label: "打开群聊 ↗", href: "#home-room" },
          { label: "总裁办 · Bot 架构 ↗", href: "#executive" },
          { label: "工作流看板 ↗", href: "#workflows" },
        ],
      },
      {
        id: "handled",
        code: "C-04",
        zone: "脑枢 · 决策归档",
        circuit: "decision",
        title: "已处理",
        svgSub: "已审批与闭环历史归档",
        subtitle: "已完成审批、回复与交付验收的历史记录归档",
        metric: `${handled.length} 已归档`,
        quiet: handled.length === 0,
        href: "#mailbox",
        x: 724,
        y: 48,
        w: 208,
        h: 76,
        status: "ok",
        chips: [
          { label: "信箱归档 ↗", href: "#mailbox" },
          { label: "工作流记录 ↗", href: "#workflows" },
        ],
      },
      {
        id: "delegations",
        code: "C-05",
        zone: "脑枢 · 调度中枢",
        circuit: "decision",
        title: "委派台",
        svgSub: "派单、在办追踪与对账",
        subtitle: "向数字员工派单、设置默认办理方式、追踪在办与对账",
        metric: `${activeDelegations.length} 在办 / ${remote.delegations.length} 总计`,
        quiet: activeDelegations.length === 0 && remote.delegations.length === 0,
        href: "#delegations",
        x: 952,
        y: 48,
        w: 208,
        h: 76,
        status: activeDelegations.length > 0 ? "active" : "ok",
        chips: [{ label: "总裁办派工 ↗", href: "#executive" }],
      },

      // Row 2: Left Wing (R&D Upstream) | Right Wing (Business & Commercial Core)
      {
        id: "ideas",
        code: "R-01",
        zone: "产研左翼 · 认知源头",
        circuit: "rd",
        title: "信息与想法",
        svgSub: "复盘日记、无界画布与信息代谢",
        subtitle: "技术复盘日记、无界知识画布语义共振、每日简报清洗与新产品想法孵化",
        metric: `${remote.ideaCount} 条笔记/想法`,
        quiet: remote.ideaCount === 0,
        href: "#ideas",
        x: 40,
        y: 198,
        w: 253,
        h: 76,
        status: remote.ideaCount > 0 ? "active" : "ok",
        chips: [
          { label: "无界知识画布 ↗", href: "#canvas" },
          { label: "每日简报代谢 ↗", href: "#metabolism" },
        ],
      },
      {
        id: "opportunities",
        code: "R-02",
        zone: "产研左翼 · 候选池",
        circuit: "rd",
        title: "研发选题",
        svgSub: "PM 自动立项与人机混合看板",
        subtitle: "按影响力 × 信心 × 成本评估候选特性，联动 PM Agent 双维评分自动拆解任务树",
        metric: `${remote.opportunityCount} 个候选特性`,
        quiet: remote.opportunityCount === 0,
        href: "#opportunities",
        x: 313,
        y: 198,
        w: 253,
        h: 76,
        status: remote.opportunityCount > 0 ? "active" : "ok",
        chips: [
          { label: "PM Agent 自动立项 ↗", href: "#metabolism?tab=pm" },
          { label: "人机 Kanban 看板 ↗", href: "#planning" },
        ],
      },
      {
        id: "business",
        code: "M-01",
        zone: "经营右翼 · 战略主线",
        circuit: "commercial",
        title: "公司业务线",
        svgSub: "4 条价值线与经营实验账本",
        subtitle: "统一管理技术研发、店铺运营、旗舰插件与 Open-Core 业务线实验",
        metric: `${lines.length} 业务线 · ${trials.length} 实验`,
        quiet: lines.length === 0,
        href: "#business-lines",
        x: 634,
        y: 198,
        w: 253,
        h: 76,
        status: "active",
        chips: lines.slice(0, 3).map(l => ({ label: l.name, href: `#business-lines?line=${encodeURIComponent(l.id)}` })),
      },
      {
        id: "commercial",
        code: "M-02",
        zone: "经营右翼 · 变现总控",
        circuit: "commercial",
        title: "商业与治理部",
        svgSub: "7 层地图、1号试点与离线授权",
        subtitle: "统筹 7 层资产地图、1 号变现试点、收银离线授权、门面合规与 DuckDB 漏斗",
        metric: `试点 ${pilotPct}% · ${remote.commercial?.metrics.activeLicenses ?? 0} 授权`,
        href: "#commercial",
        x: 907,
        y: 198,
        w: 253,
        h: 76,
        status: "active",
        chips: [
          { label: "1号商业试点 ↗", href: "#commercial" },
          { label: "盈亏热力图 · 熔断 ↗", href: "#metabolism?tab=commercial" },
          { label: "产品门面 ↗", href: "https://magele758.github.io/products/" },
        ],
      },

      // Row 3: Left Wing (Assets & Lifecycle) | Right Wing (Growth & Security)
      {
        id: "projects",
        code: "R-03",
        zone: "产研左翼 · 资产架",
        circuit: "rd",
        title: "项目目录",
        svgSub: "产品与仓库档案",
        subtitle: "管理各产品名下子项目与绑定的 GitHub 仓库档案",
        metric: `${folders.length} 目录节点`,
        quiet: folders.length === 0,
        href: "#projects",
        x: 40,
        y: 318,
        w: 166,
        h: 76,
        status: "ok",
      },
      {
        id: "product",
        code: "R-04",
        zone: "产研左翼 · 阶段章节",
        circuit: "rd",
        title: "产品进程",
        svgSub: "十三阶章节导航",
        subtitle: "按公司方向、产品定义、交付运行、市场财务查阅 13 阶进度",
        metric: "13 阶全链路",
        href: "#product",
        x: 220,
        y: 318,
        w: 166,
        h: 76,
        status: "active",
      },
      {
        id: "capabilities",
        code: "R-05",
        zone: "产研左翼 · 复用库",
        circuit: "rd",
        title: "开源能力",
        svgSub: "跨仓版本与复用",
        subtitle: "登记可跨业务线复用的开源仓库版本与维护审批",
        metric: `${remote.capabilityCount} 项能力`,
        quiet: remote.capabilityCount === 0,
        href: "#capabilities",
        x: 400,
        y: 318,
        w: 166,
        h: 76,
        status: "ok",
      },
      {
        id: "growth",
        code: "M-03",
        zone: "经营右翼 · GTM 漏斗",
        circuit: "commercial",
        title: "渠道转化",
        svgSub: "获客 → 激活 → 首单 → 复购",
        subtitle: "追踪各推广渠道从获客、激活到首单与复购的真实转化率",
        metric: `获客 ${acquiredCount} · 首单 ${firstOrderCount}`,
        quiet: acquiredCount === 0 && firstOrderCount === 0,
        href: "#growth",
        x: 634,
        y: 318,
        w: 253,
        h: 76,
        status: "ok",
      },
      {
        id: "security",
        code: "M-04",
        zone: "经营右翼 · 风险护栏",
        circuit: "commercial",
        title: "安全部门",
        svgSub: "权限核查、安全评审与复核",
        subtitle: "发版前安全评审、最小权限边界核查与问题整改复审",
        metric: remote.securityOpen > 0 ? `${remote.securityOpen} 待整改 / ${remote.securityTotal}` : `${remote.securityTotal} 项评审`,
        quiet: remote.securityOpen === 0 && remote.securityTotal === 0,
        href: "#security-department",
        x: 907,
        y: 318,
        w: 253,
        h: 76,
        status: remote.securityOpen > 0 ? "alert" : "ok",
      },

      // Row 4: Left Wing (Multi-Agent Execution) | Right Wing (Ops & Resource Cost)
      {
        id: "channels",
        code: "R-06",
        zone: "执行场 · 异构群聊",
        circuit: "rd",
        title: "昆仑频道",
        svgSub: "异构模型群聊评审",
        subtitle: "跨模型客户端群聊、方案招投标与串行角色评审频道",
        metric: `${remote.rooms.length} 频道 · ${onlineAgents} 在线`,
        quiet: remote.rooms.length === 0 && onlineAgents === 0,
        href: "#channels",
        x: 40,
        y: 438,
        w: 166,
        h: 76,
        status: onlineAgents > 0 || remote.rooms.length > 0 ? "active" : "idle",
        chips: remote.rooms.slice(0, 3).map(r => ({ label: `#${r.name}`, href: `#channels?room=${encodeURIComponent(r.id)}` })),
      },
      {
        id: "workflows",
        code: "R-07",
        zone: "执行场 · 自治流水线",
        circuit: "rd",
        title: "工作流看板",
        svgSub: "计划审批与暗工厂引擎",
        subtitle: "自治编码 DAG 计划审批、暗工厂并发队列、实时终端与四重熔断保护",
        metric: workflowEnabled ? `${remote.activeWorkflowCount} 运行 / ${remote.workflowCount}` : "按需启用",
        quiet: !workflowEnabled || (remote.activeWorkflowCount === 0 && remote.workflowCount === 0),
        href: workflowEnabled ? "#workflows" : "#dark-factory",
        x: 220,
        y: 438,
        w: 166,
        h: 76,
        status: remote.activeWorkflowCount > 0 ? "active" : "ok",
        chips: [
          { label: "Agent 暗工厂 ↗", href: "#dark-factory" },
          { label: "巡检卫士 ↗", href: "#planning?tab=patrol" },
        ],
      },
      {
        id: "homeroom",
        code: "R-08",
        zone: "执行场 · 房间桥接",
        circuit: "rd",
        title: "项目讨论室",
        svgSub: "Agent Home 桥接",
        subtitle: "联动常驻数字员工 Agent Home 的专题房间与回执同步",
        metric: "双向回执同步",
        href: "#home-room",
        x: 400,
        y: 438,
        w: 166,
        h: 76,
        status: "ok",
      },
      {
        id: "operations",
        code: "M-05",
        zone: "经营右翼 · 可用性保障",
        circuit: "commercial",
        title: "运维部门",
        svgSub: "端点健康探针与升级台账",
        subtitle: "检查全公司服务端点在线延迟、记录巡检结论与版本升级验证",
        metric: servicesReady ? `${healthyServices}/${totalServices} 在线 · ${remote.opsManaged} 台账` : "探针同步中…",
        href: "#operations-department",
        x: 634,
        y: 438,
        w: 253,
        h: 76,
        status: !servicesReady || healthyServices === totalServices ? "ok" : "alert",
      },
      {
        id: "resources",
        code: "M-06",
        zone: "经营右翼 · 算力财务",
        circuit: "commercial",
        title: "资源成本部门",
        svgSub: "模型套餐余量与续费账单",
        subtitle: "核对各 AI 订阅与 API 套餐的可用额度、重置窗口及月度费用",
        metric: `${remote.resourcePlans} 份套餐监控`,
        quiet: remote.resourcePlans === 0,
        href: "#resource-department",
        x: 907,
        y: 438,
        w: 253,
        h: 76,
        status: "ok",
      },

      // Row 5: Bottom Runtime & Microservice Substrate
      {
        id: "activity",
        code: "S-01",
        zone: "底座 · 实时工作现场",
        circuit: "runtime",
        title: "会话与仓库索引",
        svgSub: "扫描本机活跃编码 Agent 会话与 GitHub 仓库动态",
        subtitle: "实时聚合本机 CLI/IDE 编码会话状态与名下全部 GitHub 仓库索引",
        metric: `${liveSessions} 会话 · ${liveRepos} 仓库`,
        quiet: liveSessions === 0 && liveRepos === 0,
        href: "#activity-index",
        x: 40,
        y: 580,
        w: 360,
        h: 72,
        status: liveSessions > 0 ? "active" : "ok",
        chips: [
          { label: "会话视图 ↗", href: "#activity-index?view=agents" },
          { label: "仓库视图 ↗", href: "#activity-index?view=repos" },
        ],
      },
      {
        id: "worklog",
        code: "S-02",
        zone: "底座 · 时间能量账本",
        circuit: "runtime",
        title: "工作投入",
        svgSub: "按日期、番茄精力与 ROI 归集投入产出",
        subtitle: "按天与业务线绑定复盘创始人及数字员工在各项目的真实投入与 16 周热力图",
        metric: `${remote.worklogEntries} 条投入绑定`,
        quiet: remote.worklogEntries === 0,
        href: "#worklog",
        x: 420,
        y: 580,
        w: 360,
        h: 72,
        status: "ok",
        chips: [
          { label: "ROI · 16周热力图 ↗", href: "#planning?tab=roi" },
          { label: "Provider 健康中心 ↗", href: "#metabolism?tab=providers" },
        ],
      },
      {
        id: "substrate",
        code: "S-03",
        zone: "底座 · 六大伴生引擎总线",
        circuit: "runtime",
        title: "OPC 伴生微服务神经簇",
        svgSub: "Commerce · GTM · Ops · DuckDB · Home · Hub",
        subtitle: "收银授权(:52331)、获客(:52332)、客服遥测(:52333)、DuckDB(:8000)等实时联动",
        metric: servicesReady ? `${healthyServices} / ${totalServices} 引擎健康在线` : "探针握手中…",
        href: "#commercial",
        x: 800,
        y: 580,
        w: 360,
        h: 72,
        status: !servicesReady || healthyServices === totalServices ? "ok" : "alert",
        chips: [
          { label: "商业总控 ↗", href: "#commercial" },
          { label: "端点健康检查 ↗", href: "#operations-department" },
        ],
      },
    ],
    [
      products.length,
      pending,
      messages.length,
      handled.length,
      activeDelegations.length,
      remote,
      lines,
      trials.length,
      pilotPct,
      folders.length,
      acquiredCount,
      firstOrderCount,
      onlineAgents,
      workflowEnabled,
      servicesReady,
      healthyServices,
      totalServices,
      liveSessions,
      liveRepos,
    ]
  );

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const focused = nodeMap.get(focusedId) ?? nodes[0];

  const lineage = useMemo(() => {
    const upstream: TwinNode[] = [];
    const downstream: TwinNode[] = [];
    const connected = new Set<string>([focused.id]);
    for (const edge of EDGES) {
      if (edge.to === focused.id) {
        connected.add(edge.from);
        const up = nodeMap.get(edge.from);
        if (up && !upstream.some(item => item.id === up.id)) upstream.push(up);
      }
      if (edge.from === focused.id) {
        connected.add(edge.to);
        const down = nodeMap.get(edge.to);
        if (down && !downstream.some(item => item.id === down.id)) downstream.push(down);
      }
    }
    return { upstream, downstream, connected };
  }, [focused.id, nodeMap]);

  const atlasItems = useMemo(() => {
    const stageItems = productStages.map((s, idx) => {
      const stat = stageStats.get(s.id);
      const count = stat?.tasks.size ?? 0;
      return {
        key: `stage-${s.id}`,
        category: "stages" as const,
        code: `ST-${String(idx + 1).padStart(2, "0")}`,
        group: "十三阶工作单",
        title: `${String(idx + 1).padStart(2, "0")} · ${s.label}阶段台`,
        desc: `查看并协同推进全产品线在「${s.label}」阶段的工作单与讨论`,
        metric: `${count} 任务`,
        quiet: count === 0,
        href: `#stage?step=${s.id}`,
      };
    });
    return [
      ...nodes.map(n => ({
        key: n.id,
        category: n.circuit,
        code: n.code,
        group: n.zone,
        title: n.title,
        desc: n.subtitle,
        metric: n.metric,
        quiet: Boolean(n.quiet),
        href: n.href,
      })),
      ...stageItems,
    ].filter(item => {
      if (atlasFilter !== "all" && item.category !== atlasFilter) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q) ||
        item.href.toLowerCase().includes(q) ||
        item.code.toLowerCase().includes(q)
      );
    });
  }, [nodes, stageStats, query, atlasFilter]);

  const screen = SCREEN[phosphor];

  const statusColor = (status: NodeStatus) => {
    switch (status) {
      case "alert":
        return ALERT_COLOR;
      case "active":
        return LIVE_COLOR;
      case "ok":
        return screen.steady;
      case "idle":
        return screen.idle;
      default: {
        const unreachable: never = status;
        return unreachable;
      }
    }
  };

  const stageGroups = [
    { roman: "PHASE_I", title: "产品定义", range: "01–04", slice: productStages.slice(0, 4) },
    { roman: "PHASE_II", title: "交付与运行", range: "05–09", slice: productStages.slice(4, 9) },
    { roman: "PHASE_III", title: "市场与财务", range: "10–13", slice: productStages.slice(9, 13) },
  ];

  const uniqueRooms = useMemo(
    () =>
      remote.rooms
        .filter((room, idx, arr) => arr.findIndex(r => r.name === room.name && r.project === room.project && r.direct === room.direct) === idx)
        .slice(0, 3),
    [remote.rooms]
  );

  const rootFolders = useMemo(() => folders.filter(f => f.depth === 0).slice(0, 4), [folders]);

  const serviceItems = useMemo(
    () =>
      servicesList.slice(0, 4).map(svc => {
        const match = svc.name.match(/^([^(（]+)[(（]([^)）]+)[)）]$/);
        return {
          ...svc,
          shortName: match ? match[1].trim() : svc.name,
          capabilityNote: match ? match[2].trim() : svc.layer,
        };
      }),
    [servicesList]
  );

  const systemAlert = pending.length > 0 || (servicesReady && healthyServices < totalServices) || remote.securityOpen > 0;
  const systemState = !remote.syncedAt ? "BOOT" : systemAlert ? "ALERT" : "LIVE";
  const focusedAccent = CIRCUIT_META[focused.circuit].color;
  const activeLens = LENSES.find(item => item.id === lens) ?? LENSES[0];

  return (
    <section className="zo-product dt-page" data-phosphor={phosphor} aria-label="组织数字孪生">
      <header className="dt-head">
        <div className="dt-statusbar">
          <span className="dt-sb-brand">
            <i aria-hidden="true" />
            KUNLUN//OPC
          </span>
          <span className="dt-sb-cell dt-sb-host">twin@opc:~/organism</span>
          <span className="dt-sb-cell dt-sb-count">
            <em>NODES</em>
            <b>{nodes.length}</b>
          </span>
          <span className="dt-sb-cell dt-sb-count">
            <em>STAGES</em>
            <b>{productStages.length}</b>
          </span>
          <span className="dt-sb-cell dt-sb-count">
            <em>LINKS</em>
            <b>{EDGES.length}</b>
          </span>
          <span className="dt-sb-fill" aria-hidden="true" />
          <span className="dt-sb-cell dt-sb-state" data-state={systemState}>
            <i aria-hidden="true" />
            <b>{systemState}</b>
          </span>
          <DtClock />
          <button type="button" className="dt-refresh" disabled={refreshing} onClick={refresh}>
            <DtIcon name="sync" className={refreshing ? "dt-ico is-spinning" : "dt-ico"} />
            <span>{refreshing ? "SYNCING…" : remote.syncedAt ? `SYNC ${remote.syncedAt}` : "SYNC"}</span>
            <kbd>R</kbd>
          </button>
        </div>

        <div className="dt-head-main">
          <div className="dt-title-wrap">
            <p className="dt-prompt" aria-hidden="true">
              <span className="dt-p-user">kunlun@opc</span>
              <span className="dt-p-dim">:</span>
              <span className="dt-p-path">~/organism</span>
              <span className="dt-p-dim">$ </span>
              <span className="dt-p-cmd">twin --lens={lens} --circuit={circuit} --watch=10s</span>
              <i className="dt-caret" />
            </p>
            <div className="dt-title-row">
              {nav}
              <h1 data-text="组织数字孪生">组织数字孪生</h1>
              <span className="dt-live-seal" data-alert={systemAlert}>
                <i aria-hidden="true" />
                {pending.length > 0
                  ? `${pending.length} 项待拍板`
                  : servicesReady
                    ? `ONLINE · ${nodes.length + productStages.length} 锚点直连`
                    : "正在接入遥测…"}
              </span>
            </div>
            <p className="dt-sub">
              <span aria-hidden="true">// </span>
              一人公司（OPC）的决策脑枢、昆仑多 Agent 工坊、商业四部与十三阶价值流的实时拓扑。悬停节点追踪上下游，单击直达现场。
            </p>
          </div>

          <aside className="dt-tail" aria-label="最新信号日志">
            <header>
              <span className="dt-tail-title">
                <i aria-hidden="true" />
                tail -f signals.log
              </span>
              <span>
                {messages.length} 条 · <b data-hot={pending.length > 0}>{pending.length} 待办</b>
              </span>
            </header>
            <ol>
              {signalLog.length > 0 ? (
                signalLog.map(item => (
                  <li key={item.id}>
                    <a href={decisionTarget(item)} data-pending={item.pending} data-kind={item.kind} title={item.taskTitle}>
                      <time dateTime={item.at}>{clockStamp(item.at)}</time>
                      <b>{item.pending ? "PEND" : SIGNAL_TAG[item.kind]}</b>
                      <span className="dt-tail-src">{item.source}</span>
                      <span className="dt-tail-msg">{item.taskTitle}</span>
                    </a>
                  </li>
                ))
              ) : (
                <li className="dt-tail-note">-- 暂无信号，等待 Agent 上报 --</li>
              )}
              <li className="dt-tail-note" aria-hidden="true">
                <span className="dt-caret" />
              </li>
            </ol>
          </aside>
        </div>
      </header>

      <nav className="dt-vitals" aria-label="组织实时生命体征">
        <a
          className="dt-vital"
          href={pending[0] ? decisionTarget(pending[0]) : "#mailbox"}
          data-tone={pending.length > 0 ? "alert" : "calm"}
        >
          <span className="dt-vital-top">
            <span className="dt-vital-idx">01</span>
            <span className="dt-vital-name">待裁决闸门</span>
            <em aria-hidden="true">↗</em>
          </span>
          <strong className="dt-vital-num">{pending.length}</strong>
          <small>{messages.length} 总信号 · {handled.length} 已归档</small>
          <span className="dt-vital-bar" aria-hidden="true">
            <i style={{ width: pending.length > 0 ? "100%" : "18%" }} />
          </span>
        </a>

        <a
          className="dt-vital"
          href="#delegations"
          data-tone={activeDelegations.length + remote.activeWorkflowCount > 0 ? "active" : "calm"}
        >
          <span className="dt-vital-top">
            <span className="dt-vital-idx">02</span>
            <span className="dt-vital-name">自治委派与流水线</span>
            <em aria-hidden="true">↗</em>
          </span>
          <strong className="dt-vital-num">{activeDelegations.length + remote.activeWorkflowCount}</strong>
          <small>{activeDelegations.length} 在办委派 · {remote.workflowCount} 工作流</small>
          <span className="dt-vital-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(18, (activeDelegations.length + remote.workflowCount) * 28))}%` }} />
          </span>
        </a>

        <a className="dt-vital" href="#channels" data-tone={onlineAgents > 0 ? "active" : "calm"}>
          <span className="dt-vital-top">
            <span className="dt-vital-idx">03</span>
            <span className="dt-vital-name">昆仑多 Agent 协同</span>
            <em aria-hidden="true">↗</em>
          </span>
          <strong className="dt-vital-num">
            {remote.rooms.length} <span>频道</span> · {onlineAgents} <span>在线</span>
          </strong>
          <small>共登记 {remote.agents.length} 名异构 Agent</small>
          <span className="dt-vital-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(22, remote.rooms.length * 22 + onlineAgents * 15))}%` }} />
          </span>
        </a>

        <a className="dt-vital" href="#business-lines" data-tone="brass">
          <span className="dt-vital-top">
            <span className="dt-vital-idx">04</span>
            <span className="dt-vital-name">业务线与实验</span>
            <em aria-hidden="true">↗</em>
          </span>
          <strong className="dt-vital-num">
            {lines.length} <span>线</span> · {trials.length} <span>轮</span>
          </strong>
          <small>{remote.opportunityCount} 个研发候选选题</small>
          <span className="dt-vital-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(24, lines.length * 18 + trials.length * 12))}%` }} />
          </span>
        </a>

        <a className="dt-vital" href="#commercial" data-tone="brass">
          <span className="dt-vital-top">
            <span className="dt-vital-idx">05</span>
            <span className="dt-vital-name">1号变现闭环</span>
            <em aria-hidden="true">↗</em>
          </span>
          <strong className="dt-vital-num">{pilotPct}%</strong>
          <small>{remote.commercial?.pilot.product ?? "PageLens"} · {remote.commercial?.metrics.activeLicenses ?? 0} 有效授权</small>
          <span className="dt-vital-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(12, pilotPct)}%` }} />
          </span>
        </a>

        <a
          className="dt-vital"
          href="#operations-department"
          data-tone={servicesReady && healthyServices < totalServices ? "alert" : "good"}
        >
          <span className="dt-vital-top">
            <span className="dt-vital-idx">06</span>
            <span className="dt-vital-name">微服务神经底座</span>
            <em aria-hidden="true">↗</em>
          </span>
          <strong className="dt-vital-num">
            {servicesReady ? `${healthyServices}/${totalServices}` : "…"}
          </strong>
          <small>{liveSessions} 会话 · {liveRepos} 仓库索引</small>
          <span className="dt-vital-pips" aria-hidden="true">
            {Array.from({ length: totalServices }).map((_, idx) => (
              <i key={idx} data-up={!servicesReady || idx < healthyServices} />
            ))}
          </span>
        </a>
      </nav>

      <div className="dt-lensbar">
        <div className="dt-tabs" role="group" aria-label="孪生透镜视角">
          {LENSES.map((item, idx) => (
            <button key={item.id} type="button" aria-pressed={lens === item.id} onClick={() => setLens(item.id)}>
              <kbd>{idx + 1}</kbd>
              <span>{item.label}</span>
              <small>{item.code}</small>
              {item.id === "atlas" && <b>{nodes.length + productStages.length}</b>}
            </button>
          ))}
        </div>
        <span className="dt-lens-caption">
          <span aria-hidden="true">» </span>
          {activeLens.caption}
        </span>
        <div className="dt-phosphor" role="group" aria-label="终端磷光配色">
          <span>PHOSPHOR</span>
          {PHOSPHORS.map(item => (
            <button key={item.id} type="button" aria-pressed={phosphor === item.id} onClick={() => setPhosphor(item.id)}>
              <i data-phosphor={item.id} aria-hidden="true" />
              {item.code} {item.label}
            </button>
          ))}
        </div>
      </div>

      {lens === "spatial" && (
        <div className="dt-screen">
          <div className="dt-screen-bar">
            <span className="dt-screen-title">[ TOPOLOGY ]</span>
            <div className="dt-circuits" role="group" aria-label="信息流回路高亮">
              <span className="dt-flag" aria-hidden="true">
                --circuit=
              </span>
              <button type="button" aria-pressed={circuit === "all"} onClick={() => setCircuit("all")}>
                全部
              </button>
              {(Object.keys(CIRCUIT_META) as Array<Exclude<Circuit, "all">>).map(key => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={circuit === key}
                  title={CIRCUIT_META[key].name}
                  onClick={() => setCircuit(key)}
                >
                  <i className="dt-circuit-dot" style={{ background: CIRCUIT_META[key].color }} aria-hidden="true" />
                  {CIRCUIT_META[key].short}
                </button>
              ))}
            </div>
            <span className="dt-screen-hint">HOVER 追踪链路 · CLICK 直达</span>
          </div>

          <div className="dt-canvas">
            <div className="dt-canvas-scroll">
              <svg className="dt-svg" viewBox="0 0 1200 668" role="img" aria-label="OPC 一人公司组织数字孪生拓扑沙盘">
                <defs>
                  <pattern id="dt-dots" width="24" height="24" patternUnits="userSpaceOnUse">
                    <rect x="11.4" y="11.4" width="1.2" height="1.2" fill={screen.dot} />
                  </pattern>
                  <pattern id="dt-cross" width="120" height="120" patternUnits="userSpaceOnUse">
                    <path d="M 55 60 H 65 M 60 55 V 65" fill="none" stroke={screen.cross} strokeWidth="1" />
                  </pattern>
                  <filter id="dt-glow" x="-200%" y="-200%" width="500%" height="500%">
                    <feGaussianBlur stdDeviation="2.4" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                <rect x="0" y="0" width="1200" height="668" fill={screen.bg} />
                <rect x="0" y="0" width="1200" height="668" fill="url(#dt-dots)" />
                <rect x="0" y="0" width="1200" height="668" fill="url(#dt-cross)" />

                <line x1="600" y1="142" x2="600" y2="548" stroke={screen.spine} strokeDasharray="1 5" aria-hidden="true" />

                <g aria-hidden="true">
                  {ZONES.map(zone => (
                    <g key={zone.code}>
                      <rect
                        x={zone.x}
                        y={zone.y}
                        width={zone.w}
                        height={zone.h}
                        fill={screen.zoneFill}
                        stroke={screen.zoneStroke}
                        strokeDasharray="2 4"
                      />
                      <Brackets x={zone.x} y={zone.y} w={zone.w} h={zone.h} size={12} stroke={screen.bracket} />
                    </g>
                  ))}
                </g>

                <g aria-hidden="true">
                  {EDGES.map((edge, idx) => {
                    const a = nodeMap.get(edge.from);
                    const b = nodeMap.get(edge.to);
                    if (!a || !b) return null;
                    const route = conduitRoute(a, b);
                    const color = CIRCUIT_META[edge.circuit].color;
                    const circuitMatch = circuit === "all" || circuit === edge.circuit;
                    const hot = circuitMatch && (edge.from === focused.id || edge.to === focused.id);
                    const dim = !circuitMatch;
                    return (
                      <g key={idx}>
                        {hot && <path className="dt-conduit-halo" d={route.d} stroke={color} />}
                        <path className="dt-conduit" d={route.d} stroke={color} data-hot={hot} data-dim={dim} />
                        <path className="dt-conduit-flow" d={route.d} stroke={color} data-hot={hot} data-dim={dim} />
                        {hot && (
                          <>
                            <rect x={route.start[0] - 2.5} y={route.start[1] - 2.5} width="5" height="5" fill={color} />
                            <rect x={route.end[0] - 2.5} y={route.end[1] - 2.5} width="5" height="5" fill={color} />
                            {!reducedMotion &&
                              [0, 1].map(i => (
                                <rect key={i} x="-2.5" y="-2.5" width="5" height="5" fill={color} filter="url(#dt-glow)">
                                  <animateMotion dur="2.4s" begin={`-${i * 1.2}s`} repeatCount="indefinite" path={route.d} />
                                </rect>
                              ))}
                          </>
                        )}
                      </g>
                    );
                  })}
                </g>

                {/* Title plates sit on the zone's top border and above the conduits, so traces pass under the label. */}
                <g aria-hidden="true">
                  {ZONES.map(zone => {
                    const codeText = `[ZONE.${zone.code}]`;
                    const codeWidth = monoTextWidth(codeText, 9.6);
                    const plateX = zone.x + 16;
                    const plateWidth = 8 + codeWidth + 8 + monoTextWidth(zone.label, 10) + 8;
                    return (
                      <g key={zone.code}>
                        <rect x={plateX} y={zone.y - 8} width={plateWidth} height="16" fill={screen.bg} />
                        <text
                          x={plateX + 8}
                          y={zone.y + 3.5}
                          fill={screen.zoneCode}
                          fontSize="9.6"
                          fontWeight="700"
                          fontFamily="var(--dt-mono)"
                        >
                          {codeText}
                        </text>
                        <text
                          x={plateX + 16 + codeWidth}
                          y={zone.y + 3.5}
                          fill={screen.zoneLabel}
                          fontSize="10"
                          fontWeight="500"
                          fontFamily="var(--dt-mono)"
                        >
                          {zone.label}
                        </text>
                      </g>
                    );
                  })}
                </g>

                {nodes.map(node => {
                  const selected = focused.id === node.id;
                  const neighbor = lineage.connected.has(node.id) && !selected;
                  const circuitMatch = circuit === "all" || circuit === node.circuit;
                  const dim = !circuitMatch && !lineage.connected.has(node.id);
                  const accent = CIRCUIT_META[node.circuit].color;
                  const alert = node.status === "alert";
                  const compact = node.w < 190;
                  const metricY = node.y + node.h - 22;
                  const metricColor = alert ? ALERT_COLOR : node.quiet ? screen.quiet : accent;
                  const headInk = selected ? screen.ink : undefined;

                  return (
                    <a
                      key={node.id}
                      href={node.href}
                      className="dt-node"
                      data-selected={selected}
                      data-neighbor={neighbor}
                      data-dim={dim}
                      aria-label={`${node.title}（${node.metric}）— 点击直达`}
                      onMouseEnter={() => setFocusedId(node.id)}
                      onFocus={() => setFocusedId(node.id)}
                    >
                      {alert && (
                        <rect
                          className="dt-pulse-ring"
                          x={node.x - 4}
                          y={node.y - 4}
                          width={node.w + 8}
                          height={node.h + 8}
                        />
                      )}
                      {(selected || neighbor) && (
                        <Brackets
                          x={node.x - 4}
                          y={node.y - 4}
                          w={node.w + 8}
                          h={node.h + 8}
                          size={7}
                          stroke={accent}
                          opacity={selected ? 1 : 0.6}
                        />
                      )}
                      <rect
                        className="dt-node-box"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={node.h}
                        rx="2"
                        fill={selected ? screen.nodeBgSelected : screen.nodeBg}
                        stroke={accent}
                        strokeOpacity={selected ? 1 : neighbor ? 0.8 : 0.34}
                        filter={selected ? "url(#dt-glow)" : undefined}
                      />
                      {selected ? (
                        <rect x={node.x} y={node.y} width={node.w} height="24" rx="2" fill={accent} />
                      ) : (
                        <line
                          x1={node.x + 1}
                          y1={node.y + 24.5}
                          x2={node.x + node.w - 1}
                          y2={node.y + 24.5}
                          stroke={accent}
                          strokeOpacity="0.16"
                        />
                      )}
                      <rect
                        className={alert ? "dt-led-blink" : undefined}
                        x={node.x + 9}
                        y={node.y + 9}
                        width="6"
                        height="6"
                        fill={statusColor(node.status)}
                        stroke={selected ? screen.ink : "none"}
                        strokeWidth="1.5"
                      />
                      <text
                        x={node.x + 22}
                        y={node.y + 16.5}
                        fill={headInk ?? screen.title}
                        fontSize={compact ? "12.5" : "13.5"}
                        fontWeight="700"
                        fontFamily="var(--dt-mono)"
                      >
                        {node.title}
                      </text>
                      {!compact && (
                        <text
                          x={node.x + node.w - 22}
                          y={node.y + 16}
                          textAnchor="end"
                          fill={headInk ?? screen.code}
                          fontSize="9.5"
                          fontFamily="var(--dt-mono)"
                        >
                          {node.code}
                        </text>
                      )}
                      <text
                        x={node.x + node.w - 9}
                        y={node.y + 16.5}
                        textAnchor="end"
                        fill={headInk ?? accent}
                        fontSize="11"
                        fontFamily="var(--dt-mono)"
                      >
                        ↗
                      </text>
                      <text x={node.x + 10} y={node.y + 39} fill={screen.sub} fontSize="10.5" fontFamily="var(--dt-mono)">
                        {node.svgSub}
                      </text>
                      <rect
                        x={node.x + 8}
                        y={metricY}
                        width={node.w - 16}
                        height="16"
                        fill={metricColor}
                        fillOpacity={alert ? 0.16 : node.quiet ? 0.05 : 0.1}
                      />
                      <rect x={node.x + 8} y={metricY} width="2" height="16" fill={metricColor} />
                      <text
                        x={node.x + 15}
                        y={metricY + 11.5}
                        fill={metricColor}
                        fontSize="10.5"
                        fontFamily="var(--dt-mono)"
                        fontWeight={node.quiet ? "500" : "700"}
                      >
                        {`> ${node.metric}`}
                        {selected && <tspan className="dt-caret-svg">▌</tspan>}
                      </text>
                    </a>
                  );
                })}
              </svg>
            </div>
          </div>

          <div
            className="dt-inspector"
            role="region"
            aria-label="当前聚焦舱室透视"
            style={{ "--acc": focusedAccent } as CSSProperties}
          >
            <div className="dt-insp-main">
              <p className="dt-insp-cmd" aria-hidden="true">
                <span>$</span> inspect <b>{focused.code}</b> --zone="{focused.zone}"
              </p>
              <div className="dt-insp-title">
                <strong>{focused.title}</strong>
                <span className="dt-insp-state" data-status={focused.status}>
                  {STATUS_META[focused.status].tag}
                </span>
              </div>
              <dl className="dt-insp-kv">
                <div>
                  <dt>metric</dt>
                  <dd className="dt-insp-metric">{focused.metric}</dd>
                </div>
                <div>
                  <dt>route</dt>
                  <dd>
                    <code>{readableRoute(focused.href)}</code>
                  </dd>
                </div>
                <div>
                  <dt>desc</dt>
                  <dd>{focused.subtitle}</dd>
                </div>
              </dl>
            </div>

            <div className="dt-insp-side">
              {(lineage.upstream.length > 0 || lineage.downstream.length > 0) && (
                <div className="dt-lineage" role="group" aria-label="上下游传导关系">
                  {lineage.upstream.length > 0 && (
                    <span className="dt-lineage-group">
                      <em>UPSTREAM</em>
                      {lineage.upstream.map(up => (
                        <button key={up.id} type="button" onClick={() => setFocusedId(up.id)}>
                          ← {up.title}
                        </button>
                      ))}
                    </span>
                  )}
                  {lineage.downstream.length > 0 && (
                    <span className="dt-lineage-group">
                      <em>DOWNSTREAM</em>
                      {lineage.downstream.map(down => (
                        <button key={down.id} type="button" onClick={() => setFocusedId(down.id)}>
                          {down.title} →
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              )}
              {focused.chips && focused.chips.length > 0 && (
                <div className="dt-insp-links">
                  {focused.chips.map(chip => (
                    <a
                      key={chip.label + chip.href}
                      className="dt-insp-chip"
                      href={chip.href}
                      target={chip.href.startsWith("http") ? "_blank" : undefined}
                      rel={chip.href.startsWith("http") ? "noreferrer" : undefined}
                    >
                      {chip.label}
                    </a>
                  ))}
                </div>
              )}
              <a className="dt-insp-go" href={focused.href}>
                <span aria-hidden="true">⏎</span> 直达 {focused.title}
              </a>
            </div>
          </div>
        </div>
      )}

      {lens === "loops" && (
        <div className="dt-loops" role="region" aria-label="双闭环价值流视图">
          <section className="dt-pipe" style={{ "--acc": CIRCUIT_META.rd.color } as CSSProperties}>
            <header className="dt-pipe-head">
              <div>
                <span className="dt-pipe-kicker">PIPELINE_A · R&amp;D_SWARM_DELIVERY</span>
                <h3>情报立项 → 多 Agent 产研 → 安全发布交付链</h3>
              </div>
              <span className="dt-pipe-return">↺ 开源能力反哺下一轮立项</span>
            </header>
            <ol className="dt-pipe-steps">
              {[
                { step: "A1", tag: "认知输入", title: "信息与想法", sub: `${remote.ideaCount} 条日记与想法沉淀`, href: "#ideas" },
                { step: "A2", tag: "价值筛选", title: "研发选题", sub: `${remote.opportunityCount} 个候选特性待转化`, href: "#opportunities" },
                { step: "A3", tag: "专家博弈", title: "昆仑多 Agent 频道", sub: `${remote.rooms.length} 个异构评审频道`, href: "#channels" },
                { step: "A4", tag: "自治编码", title: "工作流与委派台", sub: `${activeDelegations.length} 在办委派 · ${remote.workflowCount} 流水线`, href: workflowEnabled ? "#workflows" : "#delegations" },
                { step: "A5", tag: "安全门禁", title: "安全部门审查", sub: `${remote.securityTotal} 项评审 · ${remote.securityOpen} 待整改`, href: "#security-department" },
                { step: "A6", tag: "资产沉淀", title: "开源能力与项目架", sub: `${remote.capabilityCount} 项能力跨线复用`, href: "#capabilities" },
              ].map(item => (
                <li key={item.step}>
                  <a className="dt-pipe-step" href={item.href}>
                    <span className="dt-pipe-step-top">
                      <b>
                        {item.step} · {item.tag}
                      </b>
                      <em aria-hidden="true">↗</em>
                    </span>
                    <strong>{item.title}</strong>
                    <small>{item.sub}</small>
                  </a>
                </li>
              ))}
            </ol>
          </section>

          <section className="dt-pipe" style={{ "--acc": CIRCUIT_META.commercial.color } as CSSProperties}>
            <header className="dt-pipe-head">
              <div>
                <span className="dt-pipe-kicker">PIPELINE_B · MONETIZATION &amp; UNIT_ECONOMICS</span>
                <h3>产品门面 → UTM 获客 → 离线授权收银 → DuckDB 经营复盘链</h3>
              </div>
              <span className="dt-pipe-return">
                1号试点：{remote.commercial?.pilot.product ?? "PageLens"}（{pilotPct}% 就绪）
              </span>
            </header>
            <ol className="dt-pipe-steps">
              {[
                { step: "B1", tag: "商业假设", title: "公司业务线", sub: `${lines.length} 业务线 · ${trials.length} 轮实验`, href: "#business-lines" },
                { step: "B2", tag: "门面合规", title: "GTM 阶段工作单", sub: "着陆页、定价锚点与合规", href: "#stage?step=gtm" },
                { step: "B3", tag: "流量归因", title: "渠道转化报表", sub: `获客 ${acquiredCount} · 激活 ${remote.commercial?.metrics.funnel.activated ?? 0}`, href: "#growth" },
                { step: "B4", tag: "收银授权", title: "商业与治理部", sub: `${remote.commercial?.metrics.orders ?? 0} 订单 · ${remote.commercial?.metrics.activeLicenses ?? 0} 离线授权`, href: "#commercial" },
                { step: "B5", tag: "留存运维", title: "运维与客服探针", sub: `${healthyServices}/${totalServices} 在线 · ${remote.commercial?.metrics.openTickets ?? 0} 工单`, href: "#operations-department" },
                { step: "B6", tag: "毛利对账", title: "资源成本与记账", sub: `${remote.resourcePlans} 份算力套餐成本核算`, href: "#resource-department" },
              ].map(item => (
                <li key={item.step}>
                  <a className="dt-pipe-step" href={item.href}>
                    <span className="dt-pipe-step-top">
                      <b>
                        {item.step} · {item.tag}
                      </b>
                      <em aria-hidden="true">↗</em>
                    </span>
                    <strong>{item.title}</strong>
                    <small>{item.sub}</small>
                  </a>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      {lens === "atlas" && (
        <section className="dt-atlas" aria-label="全功能星图目录">
          <div className="dt-atlas-toolbar">
            <div className="dt-search">
              <span className="dt-search-prompt" aria-hidden="true">
                grep -i
              </span>
              <input
                ref={searchRef}
                type="search"
                aria-label="搜索应用全部功能模块或阶段"
                placeholder={`在 ${nodes.length + productStages.length} 个舱室与阶段台中检索（委派、商业、安全、PRD…）`}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Escape") setQuery("");
                }}
              />
              {query && (
                <button type="button" className="dt-search-clear" onClick={() => setQuery("")}>
                  ESC 清空
                </button>
              )}
            </div>

            <div className="dt-atlas-filters" role="group" aria-label="按象限筛选星图">
              {([
                ["all", `全部 ${nodes.length + productStages.length}`],
                ["decision", "决策脑枢"],
                ["rd", "产研工坊"],
                ["commercial", "商业四部"],
                ["runtime", "底座遥测"],
                ["stages", `十三阶 ${productStages.length}`],
              ] as Array<[AtlasFilter, string]>).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={atlasFilter === key} onClick={() => setAtlasFilter(key)}>
                  {label}
                </button>
              ))}
            </div>

            <span className="dt-atlas-count">
              <b>{atlasItems.length}</b> hits
            </span>
          </div>

          <div className="dt-atlas-head" aria-hidden="true">
            <span>CODE</span>
            <span>ZONE</span>
            <span>MODULE</span>
            <span>METRIC</span>
          </div>
          {atlasItems.length > 0 ? (
            <ul className="dt-atlas-list">
              {atlasItems.map(item => (
                <li key={item.key}>
                  <a
                    className="dt-atlas-row"
                    href={item.href}
                    style={{ "--cat": item.category === "stages" ? "var(--fg-2)" : CIRCUIT_META[item.category].color } as CSSProperties}
                  >
                    <span className="dt-atlas-code">{item.code}</span>
                    <span className="dt-atlas-zone">{item.group}</span>
                    <span className="dt-atlas-main">
                      <strong>{item.title}</strong>
                      <small>{item.desc}</small>
                    </span>
                    <span className="dt-atlas-metric" data-quiet={item.quiet}>
                      {item.metric} ↗
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dt-atlas-empty">
              <p>
                <span aria-hidden="true">grep: </span>没有匹配「{query}」的舱室或阶段台
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setAtlasFilter("all");
                }}
              >
                重置检索
              </button>
            </div>
          )}
        </section>
      )}

      <section className="dt-section" aria-label="十三阶全生命周期价值传送带">
        <div className="dt-section-head">
          <div className="dt-section-title">
            <span className="dt-section-kicker">&gt;&gt; LIFECYCLE_PIPELINE · STAGES 01–13</span>
            <h2>十三阶全生命周期价值传送带</h2>
          </div>
          <a className="dt-section-link" href="#product">
            打开产品进程总表 ↗
          </a>
        </div>

        <div className="dt-conveyor-groups">
          {stageGroups.map(group => (
            <div key={group.roman} className="dt-conveyor-group" data-cols={group.slice.length}>
              <header>
                <span className="dt-phase-tag">
                  <i>{group.roman}</i>
                  <b>{group.title}</b>
                  <small>{group.range}</small>
                </span>
                <span className="dt-phase-hint">▸ 直达工作单</span>
              </header>
              <div className="dt-stage-track">
                {group.slice.map(stage => {
                  const idx = productStages.findIndex(s => s.id === stage.id) + 1;
                  const stat = stageStats.get(stage.id);
                  const count = stat?.tasks.size ?? 0;
                  const pend = stat?.pending ?? 0;
                  const pct = count === 0 ? 0 : Math.max(22, Math.round((count / maxStageTasks) * 100));
                  const displayLabel = STAGE_SHORT_LABEL[stage.id] ?? stage.label;
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
                        <b>{pend > 0 ? `${pend} 待办` : count > 0 ? `${count}` : "·"}</b>
                      </span>
                      <strong>{displayLabel}</strong>
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

      <section className="dt-section" aria-label="组织实体分舱直达">
        <div className="dt-section-head">
          <div className="dt-section-title">
            <span className="dt-section-kicker">&gt;&gt; ENTITY_PORTALS · DIRECT_CHAMBERS</span>
            <h2>组织活跃实体分舱直达</h2>
          </div>
          <span className="dt-section-meta">业务线 · 协作频道 · 目录收件夹 · 伴生服务探针</span>
        </div>

        <div className="dt-portal-grid">
          <div className="dt-pane">
            <header>
              <h3>
                <DtIcon name="layers" />
                <span>公司业务线分舱</span>
              </h3>
              <a href="#business-lines">全部 ↗</a>
            </header>
            <ul className="dt-portal-list">
              {lines.length ? (
                lines.slice(0, 4).map(line => (
                  <li key={line.id}>
                    <a href={`#business-lines?line=${encodeURIComponent(line.id)}`}>
                      <span className="dt-portal-primary">{line.name}</span>
                      <small className="dt-portal-tag">
                        {line.mode === "experiment" ? "经营实验" : "技术研发"} ↗
                      </small>
                    </a>
                  </li>
                ))
              ) : (
                <li>
                  <a href="#business-lines">
                    <span className="dt-portal-primary">进入公司业务线</span>
                    <small className="dt-portal-tag">↗</small>
                  </a>
                </li>
              )}
            </ul>
          </div>

          <div className="dt-pane">
            <header>
              <h3>
                <DtIcon name="chat" />
                <span>昆仑频道与总控台</span>
              </h3>
              <a href="#channels">进入 ↗</a>
            </header>
            <ul className="dt-portal-list">
              {uniqueRooms.map(room => (
                <li key={room.id}>
                  <a href={`#channels?room=${encodeURIComponent(room.id)}`}>
                    <span className="dt-portal-primary">
                      {room.direct ? `私聊 · ${room.name}` : `#${room.name}`}
                      {room.project ? ` · ${room.project}` : room.topic ? ` · ${room.topic.slice(0, 10)}` : ""}
                    </span>
                    <small className="dt-portal-tag">{room.unread ? `${room.unread} 未读` : "直达"} ↗</small>
                  </a>
                </li>
              ))}
              <li>
                <a href="#mailbox">
                  <span className="dt-portal-primary">总裁信箱 · 拍板收件匣</span>
                  <small className="dt-portal-tag">{pending.length > 0 ? `${pending.length} 待办` : "已清空"} ↗</small>
                </a>
              </li>
              <li>
                <a href="#home-room">
                  <span className="dt-portal-primary">Agent Home 项目讨论室</span>
                  <small className="dt-portal-tag">桥接 ↗</small>
                </a>
              </li>
              {workflowEnabled && (
                <li>
                  <a href="#workflows">
                    <span className="dt-portal-primary">自治工作流看板</span>
                    <small className="dt-portal-tag">{remote.workflowCount} 流水线 ↗</small>
                  </a>
                </li>
              )}
            </ul>
          </div>

          <div className="dt-pane">
            <header>
              <h3>
                <DtIcon name="folder" />
                <span>项目目录收件夹</span>
              </h3>
              <a href="#projects">目录 ↗</a>
            </header>
            <ul className="dt-portal-list">
              {rootFolders.length > 0 ? (
                rootFolders.map(folder => (
                  <li key={folder.path}>
                    <a href={chatRoomLink({ project: folder.path })}>
                      <span className="dt-portal-primary">{folder.label}</span>
                      <small className="dt-portal-tag">{folder.count} 动态 · 群聊 ↗</small>
                    </a>
                  </li>
                ))
              ) : (
                <li>
                  <a href="#projects">
                    <span className="dt-portal-primary">登记或同步公开仓库</span>
                    <small className="dt-portal-tag">去配置 ↗</small>
                  </a>
                </li>
              )}
            </ul>
          </div>

          <div className="dt-pane">
            <header>
              <h3>
                <DtIcon name="pulse" />
                <span>伴生微服务探针</span>
              </h3>
              <a href="#operations-department">巡检 ↗</a>
            </header>
            <ul className="dt-portal-list dt-service-list">
              {serviceItems.length > 0 ? (
                serviceItems.map(svc => (
                  <li key={svc.id}>
                    <a href="#commercial">
                      <span className="dt-svc-info">
                        <span className="dt-svc-head">
                          <i className="dt-led" data-up={svc.healthy} aria-hidden="true" />
                          <b>{svc.shortName}</b>
                        </span>
                        <span className="dt-svc-sub">{svc.capabilityNote}</span>
                      </span>
                      <small className="dt-portal-tag" data-up={svc.healthy}>
                        {svc.healthy ? "UP" : "DOWN"} · {svc.latencyMs != null ? `${svc.latencyMs}ms` : svc.layer}
                      </small>
                    </a>
                  </li>
                ))
              ) : (
                <li>
                  <a href="#commercial">
                    <span className="dt-portal-primary">查看 6 大伴生引擎状态</span>
                    <small className="dt-portal-tag">商业部 ↗</small>
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>
      </section>

      <footer className="dt-keybar" aria-label="快捷键、图例与系统状态">
        <div className="dt-keys">
          <span>
            <kbd>1</kbd>沙盘
          </span>
          <span>
            <kbd>2</kbd>闭环
          </span>
          <span>
            <kbd>3</kbd>星图
          </span>
          <span>
            <kbd>R</kbd>同步
          </span>
          <span>
            <kbd>/</kbd>检索
          </span>
        </div>
        <div className="dt-legend">
          {(Object.keys(STATUS_META) as NodeStatus[]).map(status => (
            <span key={status}>
              <i data-tone={status} aria-hidden="true" />
              {STATUS_META[status].label}
            </span>
          ))}
        </div>
        <div className="dt-colophon-links">
          <span>AUTO-SYNC 10s</span>
          <a href="#executive">总裁办 ↗</a>
          <a href="#dark-factory">暗工厂 ↗</a>
          <a href="#overview">全局看板 ↗</a>
        </div>
      </footer>
    </section>
  );
}
