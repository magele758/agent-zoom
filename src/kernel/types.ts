import type { Context, Hono } from "hono";

export const COMPANY_DEPARTMENT_IDS = [
  "strategy",
  "product",
  "factory",
  "resources",
  "ops",
  "commercial",
] as const;

export type CompanyDepartmentId = (typeof COMPANY_DEPARTMENT_IDS)[number];

export interface CompanyDepartmentDescriptor {
  id: CompanyDepartmentId;
  code: string;
  name: string;
  shortName: string;
  primaryRoute: string;
  mission: string;
  owns: string[];
  extensionSlot: string;
}

export const COMPANY_DEPARTMENTS: readonly CompanyDepartmentDescriptor[] = [
  {
    id: "strategy",
    code: "01",
    name: "总裁办与战略部",
    shortName: "战略与审批",
    primaryRoute: "mailbox",
    mission: "管理长期主线、阶段里程碑、冻结纪律、创始人审批偏好记忆与唯一拍板网关。",
    owns: ["长期主线 (Mainlines)", "冻结准入治理", "创始人习惯记忆库", "总裁审批网关 (DecisionGateway)"],
    extensionSlot: "新增战略规则、决策策略、远程批示通道（如飞书/移动端审批推送）直接挂载本部门。",
  },
  {
    id: "product",
    code: "02",
    name: "情报与产品部",
    shortName: "情报与产品",
    primaryRoute: "planning",
    mission: "后台自动汇聚信号源，按主线与个人习惯打分筛选，统一拆解管理 Initiative -> Feature -> Task 及先后依赖。",
    owns: ["自动信号采集器", "主线与习惯对齐评估", "Feature 拆解与 DAG 依赖", "知识画布与跨仓能力复用"],
    extensionSlot: "新增信息源爬虫（X/HN/Reddit/竞品/论文）、AI 原型设计、PRD 规格生成器直接注册为 Collector/Evaluator。",
  },
  {
    id: "factory",
    code: "03",
    name: "研发交付部 · 暗工厂",
    shortName: "研发暗工厂",
    primaryRoute: "dark-factory",
    mission: "公司唯一编码与上线执行底座：隔离工作树运行各 Coding-Agent，执行外部确定性测试门禁，并完成合入、构建、部署、探针验收与失败回滚。",
    owns: ["Worktree 隔离编码", "外部确定性校验 (verify_command)", "分支/PR 合入", "真发布流水线与失败自动回滚"],
    extensionSlot: "新增发布目标（Chrome 商店打包、macOS 公证、Docker/SSH/Cloudflare 部署、E2E 浏览器验收）注册为 ReleaseTarget。",
  },
  {
    id: "resources",
    code: "04",
    name: "算力与资源调度部",
    shortName: "算力与配额",
    primaryRoute: "resource-department",
    mission: "实时联动 AI 套餐配额、重置窗口、机器算力与人类精力，按主线权重路由 Agent 并在重置前自动榨取闲置额度。",
    owns: ["AI 套餐实时余量与重置监控", "配额感知智能选模路由", "跨项目预算权重", "临期闲置额度自动派活"],
    extensionSlot: "新增 AI CLI 账号池、API 渠道、算力节点或成本优化策略注册为 QuotaProvider。",
  },
  {
    id: "ops",
    code: "05",
    name: "稳定性与自愈运维部",
    shortName: "自愈运维",
    primaryRoute: "operations-department",
    mission: "常驻后台巡检本机与集群服务、磁盘、Tailscale 直连与登录态，异常自动重启自愈，高频线上崩溃自动转交暗工厂修复。",
    owns: ["常驻健康守护 (OpsWatchdog)", "进程异常自动拉起", "孤儿运行槽位回收", "崩溃指纹转 Bug 单与安全门禁"],
    extensionSlot: "新增健康探针、证书巡检、数据库备份或仓库安全扫描器直接注册为 OpsProbe / Healer。",
  },
  {
    id: "commercial",
    code: "06",
    name: "商业与财务客户桥接部",
    shortName: "商业与总账",
    primaryRoute: "commercial",
    mission: "通过标准端口对接外部商业三件套（Commerce / GTM / Ops + Data Analysis），自动同步内部算力成本，隔离沙盒测试，预置统一总账与客户 CRM 视图。",
    owns: ["Commerce 总账与内部成本同步", "GTM 内容与渠道归因端口", "Ops 客户生命周期 CRM 端口", "沙盒与生产严格隔离"],
    extensionSlot: "后续成单与增长期新增多平台内容发布、订阅续费、税务导出与 VIP 客户运营，通过本部门三大标准 Port 即插即用。",
  },
] as const;

export interface MilestoneItem {
  id: string;
  title: string;
  done: boolean;
  targetDate?: string | null;
}

export type MainlineStatus = "active" | "paused" | "archived";

export interface MainlineRecord {
  id: string;
  slug: string;
  name: string;
  thesis: string;
  goal: string;
  priorityWeight: number;
  quotaSharePct: number;
  freezeNonMainline: boolean;
  status: MainlineStatus;
  milestones: MilestoneItem[];
  createdAt: string;
  updatedAt: string;
}

export type ProductRole =
  | "flagship_paid"
  | "open_core"
  | "lead_magnet"
  | "internal_infra"
  | "experiment";

export interface ProductRecord {
  id: string;
  mainlineId: string;
  slug: string;
  name: string;
  role: ProductRole;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type AssetKind = "repo" | "service" | "extension" | "desktop" | "site";

export interface AssetRecord {
  id: string;
  productId: string;
  mainlineId: string;
  slug: string;
  name: string;
  kind: AssetKind;
  repoFullName: string;
  localRepoPath: string;
  verifyCommand: string;
  buildCommand: string;
  deployCommand: string;
  rollbackCommand: string;
  healthUrl: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioTree {
  mainlines: Array<
    MainlineRecord & {
      products: Array<
        ProductRecord & {
          assets: AssetRecord[];
        }
      >;
    }
  >;
}

export interface CanonicalResolution {
  mainline: MainlineRecord | null;
  product: ProductRecord | null;
  asset: AssetRecord | null;
}

export interface AdmissionCheckResult {
  allowed: boolean;
  reason?: string;
  code?: "asset_paused" | "kill_switch_stopped" | "mainline_paused" | "mainline_frozen";
  resolution: CanonicalResolution;
}

export type DomainEventTopic =
  | "strategy.mainline_updated"
  | "strategy.preference_learned"
  | "strategy.policy_updated"
  | "decision.proposed"
  | "decision.resolved"
  | "product.signal_ingested"
  | "product.feature_ready"
  | "product.epic_completed"
  | "factory.run_verified"
  | "factory.release_requested"
  | "factory.release_completed"
  | "factory.release_rolled_back"
  | "resources.quota_harvest_triggered"
  | "ops.service_restarted"
  | "ops.incident_escalated"
  | "ops.crash_bug_filed"
  | "commercial.cost_synced"
  | "arbitrator.item_resolved"
  | "arbitrator.item_escalated"
  | "arbitrator.policy_updated";

export interface DomainEventRecord<TPayload = Record<string, unknown>> {
  seq: number;
  id: string;
  topic: DomainEventTopic | (string & {});
  sourceDomain: CompanyDepartmentId;
  mainlineId: string | null;
  productId: string | null;
  assetId: string | null;
  payload: TPayload;
  createdAt: string;
}

export type DecisionRiskLevel = "low" | "medium" | "high" | "critical";
export type DecisionOutcome = "approved" | "rejected" | "changes_requested" | "snoozed";
export type DecisionStatus = "pending" | DecisionOutcome | "superseded";

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  outcome: DecisionOutcome;
  handlerKey: string;
  payload?: Record<string, unknown>;
}

export interface DecisionTargetSummary {
  mainlineName: string | null;
  productName: string | null;
  assetName: string | null;
  repoFullName: string | null;
  verifyCommand: string | null;
  isRedline: boolean;
}

export interface DecisionPacket {
  id: string;
  dedupeKey: string;
  domain: CompanyDepartmentId;
  kind: string;
  riskLevel: DecisionRiskLevel;
  mainlineId: string | null;
  productId: string | null;
  assetId: string | null;
  title: string;
  backgroundSummary: string;
  whyRecommended: string;
  costEstimateUsd: number | null;
  diffOrEvidence: string;
  rollbackPlan: string;
  options: DecisionOption[];
  recommendedOptionId: string | null;
  tags: string[];
  status: DecisionStatus;
  viewedAt: string | null;
  chosenOptionId: string | null;
  decisionNote: string;
  decidedBy: string | null;
  autoApproved: boolean;
  handlerResult: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  targetSummary?: DecisionTargetSummary;
  admissionWarning?: string | null;
  actionBlockReason?: string;
}

export type DecisionBatchAction = "recommended" | "approve" | "reject" | "snooze";

export interface BatchResolveDecisionInput {
  ids: string[];
  expectedUpdatedAtById?: Record<string, string>;
  action: DecisionBatchAction;
  note?: string;
  actor?: string;
  allowRedline?: boolean;
}

export interface BatchResolveItemOutcome {
  id: string;
  title: string;
  status: "resolved" | "skipped" | "failed";
  outcome?: DecisionStatus;
  chosenOptionId?: string;
  chosenOptionLabel?: string;
  reason?: string;
}

export interface BatchResolveDecisionResult {
  action: DecisionBatchAction;
  requested: number;
  resolvedCount: number;
  skippedCount: number;
  failedCount: number;
  results: BatchResolveItemOutcome[];
  counts: { pending: number; autoApproved: number; total: number };
}

export interface DecisionProposeInput {
  dedupeKey: string;
  domain: CompanyDepartmentId;
  kind: string;
  riskLevel: DecisionRiskLevel;
  mainlineId?: string | null;
  productId?: string | null;
  assetId?: string | null;
  projectOrAssetRef?: string;
  title: string;
  backgroundSummary: string;
  whyRecommended?: string;
  costEstimateUsd?: number | null;
  diffOrEvidence?: string;
  rollbackPlan?: string;
  options: DecisionOption[];
  recommendedOptionId?: string | null;
  tags?: string[];
  bypassAutoApprove?: boolean;
}

export type AutonomyMode = "assisted" | "semi_auto" | "full_auto";

export type BotArbitrationMode = "off" | "advisory" | "delegated_safe" | "full_delegated";
export type BotReleaseMergeMode = "merge_only" | "merge_and_deploy";
export type BotArbitrationVerdictKind =
  | "approve"
  | "reject"
  | "changes"
  | "snooze"
  | "supersede"
  | "escalate";

export interface BotArbitratorPolicy {
  arbitrationMode: BotArbitrationMode;
  autoApproveVerifiedReleases: boolean;
  releaseMergeMode: BotReleaseMergeMode;
  allowedReleaseProjects: string[];
  blockedReleaseProjects: string[];
  autoCloseStaleWorkflowHours: number;
  maxAutoApproveCostUsd: number;
  preferredBotRole: "auto" | "super" | "rd";
  updatedAt: string;
}

export interface DecisionBotContext {
  arbitrationMode?: BotArbitrationMode;
  releaseVerificationPassed?: boolean;
  protectedViolationsCount?: number;
  runStatus?: string;
}

export interface DecisionResolveInput {
  optionId: string;
  note?: string;
  actor?: string;
  expectedUpdatedAt?: string;
  autoApproved?: boolean;
  botDelegated?: boolean;
  botContext?: DecisionBotContext;
}

export interface GovernancePolicy {
  autonomyMode: AutonomyMode;
  autoApproveLowRisk: boolean;
  autoApproveMaxCostUsd: number;
  autoPromoteSignals: boolean;
  autoHarvestQuota: boolean;
  autoHealOps: boolean;
  redlineKinds: string[];
  botArbitrationMode: BotArbitrationMode;
  autoApproveVerifiedReleases: boolean;
  updatedAt: string;
}

export type DecisionActionHandler = (context: {
  packet: DecisionPacket;
  option: DecisionOption;
  note: string;
  actor: string;
}) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface DepartmentHealth {
  healthy: boolean;
  summary: string;
  metrics?: Record<string, number | string | boolean | null>;
}

export interface DepartmentModule {
  id: CompanyDepartmentId;
  registerRoutes?: (app: Hono, requireUser: (c: Context) => { id: string; name: string }) => void;
  start?: () => void;
  stop?: () => void;
  health?: () => Promise<DepartmentHealth> | DepartmentHealth;
}

export interface CompanyArchitectureSnapshot {
  kernelVersion: string;
  departments: Array<
    CompanyDepartmentDescriptor & {
      registered: boolean;
      health: DepartmentHealth;
    }
  >;
  counts: {
    mainlines: number;
    activeMainlines: number;
    products: number;
    assets: number;
    pendingDecisions: number;
    autoApprovedDecisions: number;
    domainEvents: number;
  };
  policy: GovernancePolicy;
}
