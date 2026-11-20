import type { LineSpec, TrialInput } from "./business-types.ts";

export const opcLayers = [
  { id: "L6", name: "对外产品矩阵", subtitle: "货架与变现载体（旗舰付费 / Open-Core / 流量钩子）" },
  { id: "L5", name: "商业化与增长平面", subtitle: "收银与离线授权 · 产品门面与合规 · UTM获客 · 客服与遥测" },
  { id: "L4", name: "经营分析与业务本体", subtitle: "DuckDB + Palantir Ontology · 漏斗/RFM/归因 · Reverse ETL" },
  { id: "L3", name: "受控执行与确定性验收", subtitle: "ChromeGate 最小权限令牌 · 人工闸门 · 无模型回放证据包" },
  { id: "L2", name: "公司总控与产研协作面", subtitle: "OPC OS 经营中枢 · 异步编码看板 · 原生终端驾驶舱" },
  { id: "L1", name: "常驻数字员工与认知飞轮", subtitle: "7×24 Goal Ledger · 每日情报复盘 · 主动学习引擎" },
  { id: "L0", name: "单机统一数据底座", subtitle: "Rust 事务存储 · BM25 全文检索 · HNSW 向量与列存" },
] as const;

export type OpcLayerId = (typeof opcLayers)[number]["id"];

export type PortfolioRole =
  | "flagship_paid"
  | "open_core"
  | "lead_magnet"
  | "internal_infra"
  | "archive_candidate";

export type BlueprintAsset = {
  repo: string;
  product: string;
  project: string;
  layer: OpcLayerId;
  domain: string;
  role: PortfolioRole;
  summary: string;
  monetization: string;
  enrolled?: boolean;
};

export type BusinessPlaybook = {
  id: string;
  title: string;
  badge: string;
  summary: string;
  line: LineSpec;
  starterTrial: Omit<TrialInput, "requestId">;
};

export type PilotFocusConfig = {
  product: string;
  project: string;
  slug: string;
  targetPrice: string;
  freezeNewInfraRepos: boolean;
  note: string;
  updatedAt: string;
};

export type PilotChecklistStep = {
  id:
    | "blueprint"
    | "storefront"
    | "acquisition"
    | "activation"
    | "billing_license"
    | "first_order"
    | "analytics_ops";
  label: string;
  done: boolean;
  detail: string;
  href: string;
};

export type CompanionServiceId =
  | "commerce"
  | "gtm"
  | "ops"
  | "data_analysis"
  | "agent_home"
  | "agent_hub";

export type CompanionServiceStatus = {
  id: CompanionServiceId;
  name: string;
  repo: string;
  layer: OpcLayerId;
  origin: string;
  healthy: boolean;
  managedCanStart: boolean;
  latencyMs: number | null;
  summary: string;
  details?: Record<string, unknown>;
};

export type AnalyticsSyncSnapshot = {
  syncedAt: string;
  sessionId: string;
  datasetName: string;
  importedRows: number;
  funnelSteps: Array<{ step_index: number; step_name: string; user_count: number }>;
  overallConversionPct: number | null;
  summary: string;
};

export type CommercialMetrics = {
  currencies: Array<{
    currency: string;
    grossMinor: number;
    refundMinor: number;
    costMinor: number;
    netMinor: number;
    grossMarginPct: number | null;
  }>;
  orders: number;
  activeLicenses: number;
  waitlistSubscribers: number;
  campaigns: number;
  openTickets: number;
  pendingFollowups: number;
  crashFreeRate: number | null;
  funnel: {
    acquired: number;
    activated: number;
    firstOrder: number;
    repeatOrder: number;
  };
};

export type CommercialOverview = {
  pilot: PilotFocusConfig;
  checklist: PilotChecklistStep[];
  completionPct: number;
  layers: Array<{
    id: OpcLayerId;
    name: string;
    subtitle: string;
    assets: BlueprintAsset[];
  }>;
  playbooks: BusinessPlaybook[];
  services: CompanionServiceStatus[];
  metrics: CommercialMetrics;
  analytics: AnalyticsSyncSnapshot | null;
};
