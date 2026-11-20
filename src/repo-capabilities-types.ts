import type { ProjectRef } from "./project-profile-types.ts";

export type RepoCapability = ProjectRef & {
  id: string;
  repo: string;
  name: string;
  version: string;
  interfaceRef: string;
  evidence: string;
};
export type CapabilityStatus = "reused" | "pending" | "approved" | "changes" | "rejected";
export type CapabilityRevision = {
  revision: number;
  title: string;
  detail: string;
  status: CapabilityStatus;
  questionId: string | null;
  feedback: string;
  actor: string | null;
  openedAt: string | null;
  decidedAt: string | null;
};
export type CapabilityRequest = ProjectRef &
  Omit<CapabilityRevision, "feedback" | "actor" | "openedAt" | "decidedAt"> & {
    id: string;
    capabilityId: string;
    capability: RepoCapability;
    sourceOpportunityId: string | null;
    satisfiesRequestId: string | null;
    satisfactionEvidence: string | null;
    satisfactionReference: string | null;
    satisfactionActor: string | null;
    satisfactionAt: string | null;
    mode: "reuse" | "gap";
    taskId: string | null;
    opportunityId: string | null;
    sourceOpportunityState: "queued" | "selected" | "skipped" | null;
    opportunityState: "queued" | "selected" | "skipped" | null;
    runId: string | null;
    planProblem: string | null;
    revisions: CapabilityRevision[];
  };
export type CapabilityIndex = {
  projects: (ProjectRef & { repos: string[] })[];
  capabilities: RepoCapability[];
  requests: CapabilityRequest[];
};
