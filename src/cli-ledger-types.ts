import type {
  WorkOriginDetail,
  WorkOriginTrack,
  WorkspaceCategory,
  WorkspaceClassification,
} from "./workspace-classification-types.ts";

export type CliProviderId =
  | "antigravity"
  | "codex"
  | "claude"
  | "grok"
  | "cursor"
  | "opencode"
  | "other";

export type CliSessionStatus =
  | "running"
  | "waiting_user"
  | "completed"
  | "blocked"
  | "idle";

export type CliProgressStage =
  | "received"
  | "exploring"
  | "implementing"
  | "verifying"
  | "delivered"
  | "waiting"
  | "blocked";

export interface CliToolCount {
  name: string;
  count: number;
}

export interface CliTurnItem {
  index: number;
  at: string | null;
  userInstruction: string;
  thinkingSummary: string | null;
  toolsUsed: CliToolCount[];
  filesTouched: string[];
  commandsRun: number;
  agentOutcome: string | null;
  outcomeStatus: "done" | "in_progress" | "waiting" | "aborted";
}

export interface CliSessionStats {
  totalTurns: number;
  instructionCount: number;
  totalToolCalls: number;
  filesModifiedCount: number;
  filesTouched: string[];
  commandsRun: number;
  tokensTotal: number;
}

export interface CliSessionSummary {
  id: string;
  rawSessionId: string;
  providerId: CliProviderId;
  provider: string;
  title: string;
  workspace: string | null;
  rawWorkspace?: string | null;
  project: string;
  repository: string | null;
  branch: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  durationMins: number;
  status: CliSessionStatus;
  progressStage: CliProgressStage;
  progressPct: number;
  statusReason: string;
  firstInstruction: string;
  latestInstruction: string;
  latestProgress: string;
  stats: CliSessionStats;
  /** Preview of up to 3 recent turn headlines so cards remain scannable. */
  recentTurnsPreview: Array<{
    index: number;
    at: string | null;
    instruction: string;
    outcome: string | null;
    outcomeStatus: CliTurnItem["outcomeStatus"];
  }>;
  sourcePath: string;
  /** 双轨来源：OPC OS 派发 vs 自主跟进。 */
  originTrack?: WorkOriginTrack;
  originDetail?: WorkOriginDetail;
  /** 统一归属分类（公司产品 / 研发基建 / 个人事项）。 */
  classification?: WorkspaceClassification;
  /** 实时匹配到的 Herdr 终端信息。 */
  herdrAddress?: string | null;
  herdrSpace?: string | null;
  herdrParent?: string | null;
  herdrName?: string | null;
  herdrState?: string | null;
  /** 绑定的规划看板任务。 */
  linkedTaskId?: string | null;
  linkedTaskTitle?: string | null;
  linkedTaskStatus?: string | null;
}

export interface CliSessionDetail extends CliSessionSummary {
  turns: CliTurnItem[];
  handoffMarkdown: string;
}

export interface CliProviderBreakdown {
  providerId: CliProviderId;
  provider: string;
  sessions: number;
  instructions: number;
  running: number;
  waitingUser: number;
  completed: number;
  blocked: number;
  toolCalls: number;
  filesModified: number;
}

export interface CliProjectBreakdown {
  project: string;
  workspace: string | null;
  sessions: number;
  instructions: number;
  providers: string[];
  running: number;
  waitingUser: number;
  completed: number;
  latestUpdatedAt: string | null;
  category?: WorkspaceCategory;
  categoryLabel?: string;
  group?: string;
  classificationKey?: string;
  opcDispatched?: number;
  founderManaged?: number;
}

export interface CliCategoryBreakdown {
  category: WorkspaceCategory;
  categoryLabel: string;
  sessions: number;
  running: number;
  waitingUser: number;
  opcDispatched: number;
  founderManaged: number;
}

export interface CliLedgerOverview {
  generatedAt: string;
  windowDays: number;
  totals: {
    sessions: number;
    instructions: number;
    running: number;
    waitingUser: number;
    completed: number;
    blocked: number;
    idle: number;
    toolCalls: number;
    filesModified: number;
  };
  byProvider: CliProviderBreakdown[];
  byProject: CliProjectBreakdown[];
  byCategory?: CliCategoryBreakdown[];
  byOrigin?: {
    opcDispatched: number;
    founderManaged: number;
  };
  sessions: CliSessionSummary[];
  sources: Array<{
    providerId: CliProviderId;
    provider: string;
    status: "ok" | "empty" | "unavailable";
    scanned: number;
    detail: string;
  }>;
}

export interface CliLedgerPromoteResult {
  sessionId: string;
  taskId: string;
  title: string;
  project: string;
  href: string;
  alreadyLinked?: boolean;
}
