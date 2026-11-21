export interface DormantMemoryHit {
  id: string;
  kind: "canvas_node" | "company_idea" | "briefing";
  title: string;
  canvasId?: string;
  href: string;
  similarity: number;
}

export interface CanvasSummary {
  id: string;
  name: string;
}

export interface DailyBriefing {
  id: string;
  date: string;
  source: string;
  title: string;
  rawContent: string;
  summary: string;
  corePoints: string[];
  tags: string[];
  score: number;
  scoreReason: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  activatedMemories?: DormantMemoryHit[];
}

export interface BriefingIngestResult {
  briefing: DailyBriefing;
  activatedMemories: DormantMemoryHit[];
  engine: "llm" | "local";
  vectorSource: "remote" | "local";
}

export interface BriefingJournalImportResult {
  day: string;
  imported: number;
  skipped: number;
  availableDays: string[];
  items: DailyBriefing[];
}

export interface DailyDigestGroup {
  tag: string;
  items: Array<{
    id: string;
    title: string;
    source: string;
    score: number;
    summary: string;
    corePoints: string[];
  }>;
}

export interface DailyDigest {
  date: string;
  count: number;
  avgScore: number;
  topTags: Array<{ tag: string; count: number }>;
  groups: DailyDigestGroup[];
  markdown: string;
  generatedAt: string;
}

export interface WorkflowTriggerResult {
  triggered: boolean;
  configured: boolean;
  endpoint: string;
  workflowId: string;
  event: string;
  statusCode: number | null;
  message: string;
  response?: unknown;
  triggeredAt: string;
}

export interface ProjectIslandResult {
  canvasId: string;
  date: string;
  itemCount: number;
  createdNodes: number;
  semanticEdges: number;
  simulated: boolean;
  message: string;
}

export interface PmDecomposedTask {
  title: string;
  description: string;
  priority: number;
  type: "task" | "bug" | "prd";
}

export interface PmEvaluation {
  id: string;
  source: string;
  project: string;
  content: string;
  technicalScore: number;
  commercialScore: number;
  combinedScore: number;
  threshold: number;
  action: "created" | "no_action";
  taskTitle: string;
  reasoning: string;
  decomposedTasks: PmDecomposedTask[];
  epicTaskId: string | null;
  subtaskIds: string[];
  opportunityId: string | null;
  engine: "llm" | "local";
  createdAt: string;
}

export type FeedbackCategory = "bug" | "feature" | "ux" | "billing";
export type FeedbackSeverity = "high" | "medium" | "low";
export type FeedbackStatus = "open" | "triaged" | "converted" | "resolved";

export interface UserFeedback {
  id: string;
  project: string;
  channel: string;
  rawText: string;
  extractedAction: string;
  category: FeedbackCategory;
  priority: number;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  generatedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackConvertResult {
  feedback: UserFeedback;
  taskId: string;
  alreadyConverted: boolean;
}

export type PaymentChannel = "hupijiao" | "stripe" | "lemonsqueezy";
export type PaymentStatus = "pending" | "paid" | "failed" | "refunded";

export interface PaymentOrder {
  id: string;
  project: string;
  channel: PaymentChannel;
  amount: number;
  currency: string;
  subject: string;
  outTradeNo: string;
  transactionId: string | null;
  status: PaymentStatus;
  payUrl: string;
  sandbox: boolean;
  metadata: Record<string, unknown>;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentCallbackResult {
  success: boolean;
  message: string;
  order?: PaymentOrder;
}

export type DistributionChannel =
  | "wechat"
  | "juejin"
  | "x"
  | "reddit"
  | "newsletter"
  | "telegram";

export interface DistributionChannelResult {
  channel: string;
  status: "sent" | "draft_ready" | "error";
  detail: string;
  dispatchedAt?: string;
}

export interface DistributionRecord {
  id: string;
  title: string;
  sourceRef: string;
  channels: string[];
  adaptedPayload: Record<string, string>;
  status: "sent" | "partial" | "draft_ready" | "failed";
  results: Record<string, DistributionChannelResult>;
  createdAt: string;
}

export type DeploymentStatus =
  | "configured"
  | "deploying"
  | "deployed"
  | "rolled_back"
  | "failed";

export interface DeploymentLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  action: "create" | "deploy" | "rollback";
  message: string;
}

export interface DeploymentRecord {
  id: string;
  project: string;
  targetHost: string;
  dockerImage: string;
  deployCommand: string;
  version: string;
  envVars: Record<string, string>;
  status: DeploymentStatus;
  logs: DeploymentLogEntry[];
  deployedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonthlyCostEntry {
  id: string;
  project: string;
  month: string;
  amountUsd: number;
  category: string;
  note: string;
  createdAt: string;
}

export interface HeatmapCell {
  month: string;
  revenueUsd: number;
  costUsd: number;
  netProfitUsd: number;
  status: "profit" | "breakeven" | "loss";
}

export interface KillSwitchRecord {
  project: string;
  status: "active" | "stopped";
  consecutiveLossMonths: number;
  cumulativeLossUsd: number;
  reason: string;
  triggeredAt: string | null;
  resumedAt: string | null;
  updatedAt: string;
}

export interface HeatmapProjectRow {
  project: string;
  cells: HeatmapCell[];
  totalRevenueUsd: number;
  totalCostUsd: number;
  totalNetProfitUsd: number;
  consecutiveLossMonths: number;
  cumulativeLossUsd: number;
  killSwitchAlert: boolean;
  killSwitch: KillSwitchRecord | null;
}

export interface CommercialHeatmap {
  months: string[];
  lossKillSwitchMonths: number;
  projects: HeatmapProjectRow[];
  summary: {
    totalRevenueUsd: number;
    totalCostUsd: number;
    totalNetProfitUsd: number;
    alertCount: number;
    stoppedCount: number;
  };
  generatedAt: string;
}
