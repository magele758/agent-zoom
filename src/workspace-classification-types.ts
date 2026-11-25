export const WORKSPACE_CATEGORIES = ["company_product", "rd_infra", "personal"] as const;
export type WorkspaceCategory = (typeof WORKSPACE_CATEGORIES)[number];

export const WORKSPACE_CATEGORY_LABELS: Record<WorkspaceCategory, string> = {
  company_product: "公司产品",
  rd_infra: "研发基建",
  personal: "个人事项",
};

export const WORK_ORIGIN_TRACKS = ["opc_dispatched", "founder_managed"] as const;
export type WorkOriginTrack = (typeof WORK_ORIGIN_TRACKS)[number];

export const WORK_ORIGIN_LABELS: Record<WorkOriginTrack, string> = {
  opc_dispatched: "OPC 派发",
  founder_managed: "自主跟进",
};

export type WorkOriginKind =
  | "workflow"
  | "dark_factory"
  | "planning"
  | "herdr_manual"
  | "local_cli";

export interface WorkOriginDetail {
  kind: WorkOriginKind;
  runId?: string | null;
  taskId?: string | null;
  nodeId?: string | null;
  attemptId?: string | null;
}

export interface WorkspaceClassification {
  /** Stable key used to store/update user override rules (e.g. repo:owner/name or proj:slug). */
  key: string;
  /** Canonical collapsed project name (never wt-s3 / run_xxx / username). */
  canonicalProject: string;
  /** Top-level category bucket. */
  category: WorkspaceCategory;
  categoryLabel: string;
  /** Product / domain group name (e.g. "PageLens", "OPC OS", "OPC 分析与内核", "个人事项"). */
  group: string;
  /** Resolved main repository path if a worktree was collapsed. */
  canonicalWorkspace: string | null;
  /** Resolved GitHub repo fullName (owner/repo) if known. */
  repository: string | null;
  /** Whether this classification came from explicit user override, company registry, or fallback. */
  source: "override" | "company_registry" | "inferred" | "fallback";
}

export interface WorkspaceClassificationOverride {
  key: string;
  canonicalProject: string | null;
  category: WorkspaceCategory;
  groupName: string;
  updatedAt: string;
}

export interface ExternalSessionBinding {
  sessionId?: string | null;
  herdrAddress?: string | null;
  herdrSpace?: string | null;
  provider?: string | null;
  workspace?: string | null;
  canonicalProject?: string | null;
  liveStatus?: "running" | "waiting_user" | "completed" | "blocked" | "idle" | "unknown" | null;
  latestProgress?: string | null;
  filesModifiedCount?: number;
  boundAt: string;
  lastSyncedAt?: string | null;
}
