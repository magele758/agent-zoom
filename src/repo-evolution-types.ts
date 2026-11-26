import type { DecisionPacket } from "./kernel/types.ts";
import type { RepoContent } from "./activity-index-types.ts";

export type RepoNodeRole = "owned" | "starred" | "both";
export type RepoVisibility = "public" | "private" | "internal";
export type RepoVitality = "active" | "dormant" | "stale" | "archived";
export type RepoPriorityTier = "spotlight" | "standard" | "archived";
export type RepoDomainSource = "builtin" | "custom" | "github_list";
export type RepoDomainAssignedBy = "manual" | "ai" | "github_list" | "unassigned";
export type RepoPoolBucket =
  | "owned"
  | "linked"
  | "classified_unlinked"
  | "unclassified"
  | "stale_pool";

export type RepoRelationType =
  | "architecture_pattern"
  | "direct_module"
  | "algorithm_idea"
  | "ux_workflow"
  | "tooling_infra"
  | "benchmark_ref"
  | "inspiration";

export type RepoAbsorptionStatus =
  | "suggested"
  | "watching"
  | "in_review"
  | "approved"
  | "absorbing"
  | "absorbed"
  | "rejected";

export type RepoEvolutionAutomationMode =
  | "mailbox_review"
  | "auto_opportunity"
  | "full_auto";

export type RepoEvolutionEventType =
  | "link_discovered"
  | "link_created"
  | "module_analyzed"
  | "submitted_to_mailbox"
  | "decision_approved"
  | "decision_watching"
  | "decision_rejected"
  | "status_changed"
  | "promoted_to_opportunity"
  | "sync_completed"
  | "domain_clustered";

export type RepoEvolutionSyncMode = "incremental" | "full" | "owned_only" | "stars_only";
export type RepoEvolutionSyncStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RepoEvolutionSyncPhase =
  | "init"
  | "owned_repos"
  | "star_lists"
  | "starred_repos"
  | "embedding"
  | "done"
  | "error";

export type RepoModuleEffort = "S" | "M" | "L";
export type RepoModuleRisk = "low" | "medium" | "high";

export interface RepoEvidenceLink {
  label: string;
  url: string;
  path?: string;
}

export interface RepoModuleAnalysisItem {
  id: string;
  sourceModulePath: string;
  targetModulePath: string;
  absorbableMechanism: string;
  currentGap: string;
  adaptationPlan: string;
  effort: RepoModuleEffort;
  risk: RepoModuleRisk;
  evidenceLinks: RepoEvidenceLink[];
}

export interface RepoReadmeDigest {
  summary: string;
  keyModules: string[];
  techStack: string[];
  fileCount: number;
  ref: string | null;
  fetchedAt: string;
}

export interface RepoDomain {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  seedKeywords: string[];
  source: RepoDomainSource;
  githubListId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepoNodeBrief {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  url: string;
  role: RepoNodeRole;
  visibility: RepoVisibility;
  vitality: RepoVitality;
  priorityTier: RepoPriorityTier;
  primaryLanguage: string | null;
  starsCount: number;
  primaryDomainId: string | null;
  primaryDomainName: string | null;
  primaryDomainColor: string | null;
  allowLlmAnalysis: boolean;
}

export interface RepoEvolutionNode {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  url: string;
  role: RepoNodeRole;
  visibility: RepoVisibility;
  vitality: RepoVitality;
  priorityTier: RepoPriorityTier;
  description: string;
  primaryLanguage: string | null;
  topics: string[];
  starsCount: number;
  forksCount: number;
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  starredAt: string | null;
  repoUpdatedAt: string | null;
  primaryDomainId: string | null;
  primaryDomainName: string | null;
  primaryDomainColor: string | null;
  secondaryDomainIds: string[];
  domainConfidence: number | null;
  domainAssignedBy: RepoDomainAssignedBy;
  poolBucket: RepoPoolBucket;
  allowLlmAnalysis: boolean;
  readmeSha: string | null;
  readmeDigest: RepoReadmeDigest | null;
  hasEmbedding: boolean;
  embeddingSource: "remote" | "local" | null;
  linkCount: number;
  activeLinkCount: number;
  notes: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoAbsorptionLink {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRepoFullName: string;
  targetRepoFullName: string;
  sourceNode?: RepoNodeBrief;
  targetNode?: RepoNodeBrief;
  relationType: RepoRelationType;
  status: RepoAbsorptionStatus;
  strength: number;
  rationale: string;
  moduleAnalysis: RepoModuleAnalysisItem[];
  analysisSource: "llm" | "deterministic" | "manual" | null;
  analyzedAt: string | null;
  decisionPacketId: string | null;
  decisionStatus?: string | null;
  opportunityId: string | null;
  createdBy: "ai" | "manual";
  createdAt: string;
  updatedAt: string;
}

export interface RepoAbsorptionEvent {
  id: string;
  linkId: string | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  domainId: string | null;
  eventType: RepoEvolutionEventType;
  title: string;
  summary: string;
  actor: string;
  decisionPacketId: string | null;
  sourceRepoFullName: string | null;
  targetRepoFullName: string | null;
  domainName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RepoEvolutionSyncJob {
  id: string;
  mode: RepoEvolutionSyncMode;
  status: RepoEvolutionSyncStatus;
  phase: RepoEvolutionSyncPhase;
  githubLogin: string | null;
  ownedFetched: number;
  ownedTotal: number | null;
  starredFetched: number;
  starredTotal: number | null;
  listsFetched: number;
  embeddingsComputed: number;
  pagesProcessed: number;
  cursor: string | null;
  earlyStopped: boolean;
  errorMessage: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RepoEvolutionConfig {
  spotlightRepos: string[];
  automationMode: RepoEvolutionAutomationMode;
  staleMonths: number;
  dormantMonths: number;
  minClusterSimilarity: number;
  minLinkSimilarity: number;
  spotlightBonus: number;
  allowPrivateLlmByDefault: boolean;
  updatedAt: string;
}

export interface RepoEvolutionStats {
  ownedCount: number;
  ownedPublicCount: number;
  ownedPrivateCount: number;
  spotlightCount: number;
  starredCount: number;
  activeStarredCount: number;
  dormantStarredCount: number;
  staleStarredCount: number;
  archivedStarredCount: number;
  domainCount: number;
  linkCount: number;
  suggestedLinkCount: number;
  watchingLinkCount: number;
  inReviewLinkCount: number;
  approvedLinkCount: number;
  absorbingLinkCount: number;
  absorbedLinkCount: number;
  rejectedLinkCount: number;
  floatingPoolCount: number;
  unclassifiedCount: number;
  classifiedUnlinkedCount: number;
  stalePoolCount: number;
  aiSuggestedCount: number;
}

export interface RepoDomainCluster extends RepoDomain {
  totalNodes: number;
  activeNodes: number;
  dormantNodes: number;
  staleNodes: number;
  archivedNodes: number;
  linkedNodes: number;
  suggestedLinks: number;
  inReviewLinks: number;
  approvedLinks: number;
  absorbedLinks: number;
  topLanguages: string[];
  sampleRepos: RepoNodeBrief[];
}

export interface RepoFloatingPoolSummary {
  totalCount: number;
  unclassifiedCount: number;
  classifiedUnlinkedCount: number;
  staleCount: number;
  archivedCount: number;
  sampleRepos: RepoNodeBrief[];
}

export interface RepoOwnedSummaryNode extends RepoNodeBrief {
  description: string;
  pushedAt: string | null;
  incomingLinkCount: number;
  suggestedCount: number;
  watchingCount: number;
  inReviewCount: number;
  approvedCount: number;
  absorbingCount: number;
  absorbedCount: number;
  modulePointCount: number;
}

export interface RepoMacroEdge {
  id: string;
  sourceDomainId: string;
  sourceDomainName: string;
  sourceDomainColor: string;
  targetNodeId: string;
  targetRepoFullName: string;
  linkCount: number;
  suggestedCount: number;
  watchingCount: number;
  inReviewCount: number;
  approvedCount: number;
  absorbedCount: number;
  avgStrength: number;
  modulePointCount: number;
}

export interface RepoEvolutionMacroGraph {
  stats: RepoEvolutionStats;
  domains: RepoDomainCluster[];
  floatingPool: RepoFloatingPoolSummary;
  ownedRepos: RepoOwnedSummaryNode[];
  macroEdges: RepoMacroEdge[];
  config: RepoEvolutionConfig;
  activeSyncJob: RepoEvolutionSyncJob | null;
  latestSyncJob: RepoEvolutionSyncJob | null;
}

export type RepoFocusType = "domain" | "star" | "owned" | "floating" | "all";

export interface RepoEvolutionFocusGraph {
  focusType: RepoFocusType;
  focusId: string | null;
  focusLabel: string;
  starNodes: RepoEvolutionNode[];
  ownedNodes: RepoEvolutionNode[];
  links: RepoAbsorptionLink[];
  totalMatchingStars: number;
  truncated: boolean;
}

export type RepoNodeBucketFilter =
  | "all"
  | "owned"
  | "spotlight"
  | "linked"
  | "floating"
  | "unclassified"
  | "classified_unlinked"
  | "stale_pool"
  | "ai_suggested";

export type RepoNodeSortBy =
  | "starred_at"
  | "pushed_at"
  | "stars"
  | "updated_at"
  | "name"
  | "priority";

export interface RepoEvolutionNodesQuery {
  q?: string;
  role?: RepoNodeRole | "all";
  bucket?: RepoNodeBucketFilter;
  domainId?: string;
  vitality?: RepoVitality | "all";
  visibility?: RepoVisibility | "all";
  priorityTier?: RepoPriorityTier | "all";
  language?: string;
  sortBy?: RepoNodeSortBy;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface RepoEvolutionNodesPage {
  items: RepoEvolutionNode[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: {
    languages: Array<{ name: string; count: number }>;
    vitalityCounts: Record<RepoVitality, number>;
  };
}

export interface RepoEvolutionTimelineQuery {
  targetNodeId?: string;
  sourceNodeId?: string;
  repoFullName?: string;
  domainId?: string;
  eventType?: RepoEvolutionEventType | "all";
  limit?: number;
  offset?: number;
}

export interface RepoEvolutionTimelinePage {
  items: RepoAbsorptionEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateRepoDomainInput {
  name: string;
  slug?: string;
  description?: string;
  color?: string;
  icon?: string;
  seedKeywords?: string[];
}

export interface UpdateRepoDomainInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  seedKeywords?: string[];
  sortOrder?: number;
}

export interface MergeRepoDomainsInput {
  sourceDomainId: string;
  targetDomainId: string;
}

export interface UpdateRepoNodeInput {
  primaryDomainId?: string | null;
  secondaryDomainIds?: string[];
  priorityTier?: RepoPriorityTier;
  allowLlmAnalysis?: boolean;
  notes?: string;
}

export interface BatchUpdateRepoNodesInput {
  nodeIds: string[];
  action:
    | "assign_domain"
    | "clear_domain"
    | "archive_stale"
    | "restore_standard"
    | "set_spotlight"
    | "set_allow_llm";
  domainId?: string | null;
  allowLlmAnalysis?: boolean;
}

export interface BatchUpdateRepoNodesResult {
  updatedCount: number;
  nodeIds: string[];
}

export interface CreateRepoLinkInput {
  sourceNodeId: string;
  targetNodeId: string;
  relationType?: RepoRelationType;
  status?: RepoAbsorptionStatus;
  strength?: number;
  rationale?: string;
  moduleAnalysis?: RepoModuleAnalysisItem[];
}

export interface BulkLinkTargetsInput {
  targetNodeIds: string[];
  relationType?: RepoRelationType;
  rationale?: string;
}

export interface UpdateRepoLinkInput {
  relationType?: RepoRelationType;
  status?: RepoAbsorptionStatus;
  strength?: number;
  rationale?: string;
  moduleAnalysis?: RepoModuleAnalysisItem[];
}

export interface TriggerSyncInput {
  mode?: RepoEvolutionSyncMode;
  resumeJobId?: string;
  maxPages?: number;
}

export interface ClusterAndRecallInput {
  recomputeEmbeddings?: boolean;
  reclassifyAi?: boolean;
  maxNewLinksPerOwned?: number;
  focusOwnedNodeId?: string;
}

export interface ClusterAndRecallResult {
  embeddingsUpdated: number;
  domainsAssigned: number;
  linksSuggested: number;
  skippedStaleOrLowMatch: number;
  spotlightMatches: number;
  durationMs: number;
}

export interface AnalyzeLinkInput {
  force?: boolean;
  allowPrivateOverride?: boolean;
}

export interface AnalyzeLinkResult {
  link: RepoAbsorptionLink;
  usedLlm: boolean;
  privacyBlocked: boolean;
  notice?: string;
}

export interface SubmitLinkToMailboxInput {
  note?: string;
  recommendedOption?: "approve" | "watch" | "reject";
}

export interface SubmitLinkToMailboxResult {
  link: RepoAbsorptionLink;
  packet: DecisionPacket;
  reusedPending: boolean;
}

export interface PromoteLinkToOpportunityInput {
  pipeline?: "quick" | "full-product";
  title?: string;
  rationale?: string;
}

export interface PromoteLinkToOpportunityResult {
  link: RepoAbsorptionLink;
  opportunityId: string;
  project: string;
}

export interface UpdateRepoEvolutionConfigInput {
  spotlightRepos?: string[];
  automationMode?: RepoEvolutionAutomationMode;
  staleMonths?: number;
  dormantMonths?: number;
  minClusterSimilarity?: number;
  minLinkSimilarity?: number;
  spotlightBonus?: number;
  allowPrivateLlmByDefault?: boolean;
}

export interface ImportGithubListsResult {
  importedDomains: number;
  assignedNodes: number;
  domains: RepoDomain[];
}

export interface RepoEvolutionContentSearchResult {
  source: string;
  note: string;
  items: Array<{ path: string; url: string; line?: number }>;
}

export type RepoEvolutionRepoContent = RepoContent;

export const REPO_RELATION_LABELS: Record<RepoRelationType, string> = {
  architecture_pattern: "架构范式借鉴",
  direct_module: "具体模块吸收",
  algorithm_idea: "核心算法/策略",
  ux_workflow: "交互与工作流",
  tooling_infra: "工程基建/工具",
  benchmark_ref: "对标与评测基准",
  inspiration: "灵感与方向参考",
};

export const REPO_ABSORPTION_STATUS_LABELS: Record<RepoAbsorptionStatus, string> = {
  suggested: "AI 建议",
  watching: "暂存观察",
  in_review: "信箱待批",
  approved: "已批准吸收",
  absorbing: "吸收实施中",
  absorbed: "已吸收落地",
  rejected: "已驳回",
};

export const REPO_VITALITY_LABELS: Record<RepoVitality, string> = {
  active: "活跃",
  dormant: "静默",
  stale: "陈旧 (>24月)",
  archived: "已归档",
};

export const REPO_AUTOMATION_MODE_LABELS: Record<RepoEvolutionAutomationMode, string> = {
  mailbox_review: "V1 总裁信箱审批留痕（默认，不自动改代码）",
  auto_opportunity: "预留：批准后自动转研发选题",
  full_auto: "预留：批准后自动进入暗工厂",
};

export const REPO_EVOLUTION_EVENT_LABELS: Record<RepoEvolutionEventType, string> = {
  link_discovered: "发现潜在关联",
  link_created: "建立吸收关联",
  module_analyzed: "模块级深度分析",
  submitted_to_mailbox: "提交总裁信箱",
  decision_approved: "总裁批准吸收",
  decision_watching: "总裁暂存观察",
  decision_rejected: "总裁驳回吸收",
  status_changed: "吸收状态更新",
  promoted_to_opportunity: "转为研发选题",
  sync_completed: "GitHub 同步完成",
  domain_clustered: "领域智能聚类",
};
