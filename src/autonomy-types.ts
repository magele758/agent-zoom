import type { RepoCapability } from "./repo-capabilities-types.ts";
export type OpportunityKind = "feature" | "issue" | "upgrade" | "growth";
export type OpportunityState = "queued" | "selected" | "skipped";

export type OpportunityInput = {
  project: string;
  kind: OpportunityKind;
  sourceId: string;
  title: string;
  rationale: string;
  evidence: string[];
  impact?: number;
  confidence?: number;
  effort?: number;
  capabilityRefs?: string[];
};

export type OpportunityReuseRecord = {
  requestId: string;
  replacement?: { requestId: string; evidence: string; actor: string; deliveryRef: string };
  revision: number;
  consumer: string;
  title: string;
  detail: string;
};
export type OpportunityReuse = {
  status: "needs_decision" | "adopted" | "upstream";
  capabilities: RepoCapability[];
  requestIds: string[];
  approval?: OpportunityReuseRecord;
  adoptions?: OpportunityReuseRecord[];
};
export type Opportunity = Required<Omit<OpportunityInput, "capabilityRefs">> & {
  id: string;
  score: number;
  capabilityRefs?: string[];
  reuse?: OpportunityReuse;
  reason: string;
  state: OpportunityState;
  runId: string | null;
  dispatchedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type OpportunityProject = {
  project: string;
  workspace: string | null;
  enabled: boolean;
  problem: string | null;
};

export type OpportunityIndex = {
  opportunities: Opportunity[];
  projects: OpportunityProject[];
};
