import type {
  WorkOriginDetail,
  WorkOriginTrack,
  WorkspaceClassification,
} from "./workspace-classification-types.ts";

export type IndexSource = {
  name: string;
  status: "ok" | "partial" | "unavailable" | "refreshing";
  asOf: string | null;
  detail: string;
};

export type HerdrAgentMeta = {
  address: string;
  name: string | null;
  parent: string | null;
  where: string | null;
  spaceName: string | null;
  tabName: string | null;
  labels: Record<string, string>;
  isSubAgent: boolean;
  isBackground: boolean;
  /** 原始 Herdr 状态（working / waiting / blocked / idle / done）。 */
  rawStatus?: string | null;
  /** 远程机器名（本机终端为 null，如 ubuntu1 / ubuntu2）。 */
  machine?: string | null;
  /** 远程机器上的工作目录（仅作展示，绝不进入本机 Git 索引）。 */
  remoteCwd?: string | null;
};

export type HerdrMachineInfo = {
  name: string;
  status: string;
  detail: string;
};

export type IndexedAgent = {
  id: string;
  provider: string;
  state: "working" | "waiting" | "idle" | "recent" | "unknown";
  sources: string[];
  workspace: string | null;
  repository: string | null;
  updatedAt: string | null;
  label: string;
  /** 会话自身标题。Agent Hub 优先用它，没有则为空。 */
  title: string | null;
  /** 标题缺失时的「在做什么」；有标题时只作备用。 */
  what: string | null;
  /** 与标题不同的项目任务卡，次要一行。 */
  taskWhat: string | null;
  /** Herdr 终端结构化上下文（Space / Tab / 父子关系 / 标签 / 后台静默标记）。 */
  herdr?: HerdrAgentMeta;
  /** 双轨来源：OPC OS 派发 vs 创始人自主跟进。 */
  originTrack?: WorkOriginTrack;
  originDetail?: WorkOriginDetail;
  /** 统一归属分类（公司产品 / 研发基建 / 个人事项）。 */
  classification?: WorkspaceClassification;
  /** 关联到的 CLI 台账会话 ID。 */
  linkedSessionId?: string | null;
  /** 已绑定的规划看板任务 ID / 标题 / 状态。 */
  linkedTaskId?: string | null;
  linkedTaskTitle?: string | null;
  linkedTaskStatus?: string | null;
};

export type IndexedRepo = {
  fullName: string;
  url: string;
  description: string;
  visibility: "public" | "private" | "internal" | "unknown";
  relations: string[];
  paths: string[];
  language: string | null;
  pushedAt: string | null;
  defaultBranch: string | null;
  managed: { product: string; project: string }[];
  classification?: WorkspaceClassification;
};

export type AgentIndex = {
  agents: IndexedAgent[];
  sources: IndexSource[];
  remoteAgents?: IndexedAgent[];
  remoteMachines?: HerdrMachineInfo[];
};
export type RepoIndex = { repositories: IndexedRepo[]; sources: IndexSource[] };
export type ActivityIndex = {
  agents: IndexedAgent[];
  repositories: IndexedRepo[];
  sources: IndexSource[];
  remoteAgents?: IndexedAgent[];
  remoteMachines?: HerdrMachineInfo[];
};

export type RepoContent = {
  fullName: string;
  ref: string | null;
  source: string;
  files: { name: string; url: string; directory: boolean }[];
  readme: { url: string; text: string; truncated: boolean } | null;
  issuesUrl: string;
  pullsUrl: string;
  note: string;
};
