import type { HerdrMachineInfo, IndexedAgent } from "./activity-index-types.ts";
import type { CliSessionSummary } from "./cli-ledger-types.ts";
import type {
  WorkOriginDetail,
  WorkOriginTrack,
  WorkspaceCategory,
  WorkspaceClassification,
} from "./workspace-classification-types.ts";

export interface WorkstreamAttentionItem {
  id: string;
  source: "herdr" | "cli_ledger";
  severity: "blocked" | "waiting";
  provider: string;
  title: string;
  snippet: string | null;
  project: string;
  originTrack: WorkOriginTrack;
  classification?: WorkspaceClassification;
  herdrAddress: string | null;
  herdrSpace: string | null;
  machine: string | null;
  isBlockedPermission: boolean;
  sessionId: string | null;
  linkedTaskId: string | null;
  updatedAt: string | null;
}

export interface WorkstreamHerdrTree {
  id: string;
  address: string;
  provider: string;
  label: string;
  title: string | null;
  what: string | null;
  state: IndexedAgent["state"];
  effectiveState: IndexedAgent["state"];
  workspace: string | null;
  repository: string | null;
  spaceName: string | null;
  tabName: string | null;
  originTrack: WorkOriginTrack;
  originDetail?: WorkOriginDetail;
  classification?: WorkspaceClassification;
  linkedSessionId: string | null;
  linkedTaskId: string | null;
  linkedTaskTitle: string | null;
  linkedTaskStatus: string | null;
  subAgents: IndexedAgent[];
}

export interface WorkstreamFactoryRun {
  id: string;
  taskId: string;
  taskTitle: string;
  project: string;
  agentName: string;
  status: string;
  executionHost: "subprocess" | "herdr";
  herdrTerminal: string | null;
  herdrSpace: string | null;
  classification?: WorkspaceClassification;
  updatedAt: string;
}

export interface WorkstreamWorkflowItem {
  id: string;
  goal: string;
  folder: string;
  source: string;
  backend: string;
  workspace: string;
  classification?: WorkspaceClassification;
  updatedAt: string;
}

export interface WorkstreamCategoryCount {
  category: WorkspaceCategory;
  categoryLabel: string;
  active: number;
  opcDispatched: number;
  founderManaged: number;
}

export interface WorkstreamsOverview {
  generatedAt: string;
  summary: {
    totalActive: number;
    opcDispatched: number;
    founderManaged: number;
    workingCount: number;
    waitingCount: number;
    backgroundCount: number;
    attentionCount: number;
    remoteCount: number;
    byCategory: WorkstreamCategoryCount[];
  };
  herdrTrees: WorkstreamHerdrTree[];
  backgroundTerminals: IndexedAgent[];
  remoteTerminals: IndexedAgent[];
  remoteMachines: HerdrMachineInfo[];
  attentionItems: WorkstreamAttentionItem[];
  recentCliSessions: CliSessionSummary[];
  activeFactoryRuns: WorkstreamFactoryRun[];
  activeWorkflows: WorkstreamWorkflowItem[];
}
