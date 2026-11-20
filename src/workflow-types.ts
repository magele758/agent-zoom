import type { ProductStageId } from "./product-stages.ts";

export type WorkflowNode = {
  id: string;
  kind: "implement" | "review" | "gate";
  title: string;
  instruction: string;
  capability?: string;
  dependsOn: string[];
};

export type WorkflowPlan = { nodes: WorkflowNode[]; acceptance: string[] };
export type WorkflowRequest = {
  version: 1;
  requestId: string;
  source: string;
  context: string;
  projectKey?: string;
  capabilityRefs?: string[];
  folder?: string;
  stage?: ProductStageId;
  goal: string;
  constraints: string[];
  plan?: WorkflowPlan;
};
export type WorkflowReuseCheck = {
  command: string; instruction: string; suggestions: {id:string;repo:string;name:string;version:string;interfaceRef:string;evidence:string}[];
};
export type WorkflowRevision = {
  reuseCheck?: WorkflowReuseCheck;
  number: number;
  reason: string;
  plan: WorkflowPlan;
  gatedNodes: string[];
};
export type DecisionAction = "approve" | "changes" | "reject";
export type WorkflowCard = {
  id: string;
  kind: "plan" | "gate" | "final";
  revision: number;
  nodeId?: string;
  status: "open" | "superseded" | DecisionAction;
  note?: string;
  actor?: string;
};
export type WorkflowEvidence = {
  runId: string;
  nodeId: string;
  attemptId: string;
  revision: number;
  outcome: "succeeded" | "failed";
  summary: string;
  checks: Array<{ name: string; exitCode: number; output: string }>;
  artifacts: Array<{ name: string; content: string }>;
  patch: string;
};
export type WorkflowAttempt = {
  id: string;
  nodeId: string;
  revision: number;
  worktree: string;
  leaseUntil?: string;
  claimOwner?: string;
  state: "dispatching" | "running" | "unknown" | "succeeded" | "failed";
  terminal?: string;
  problem?: string;
  evidence?: WorkflowEvidence;
};
export type WorkflowEvent = {
  at: string;
  kind: string;
  revision: number;
  note: string;
  actor?: string;
  cardId?: string;
  nodeId?: string;
  attemptId?: string;
};
export type WorkflowRun = {
  id: string;
  request: WorkflowRequest;
  workspace: string;
  base: string;
  backend: string;
  backendKey: string;
  hostKey?: string;
  boardUrl: string;
  reusePolicy?: "adopted" | "upstream";
  createdAt: string;
  cleanedAt?: string;
  revisions: WorkflowRevision[];
  released: string[];
  attempts: WorkflowAttempt[];
  cards: WorkflowCard[];
  events: WorkflowEvent[];
};
export type WorkflowSummary = {
  eventCount: number;
  waitingForRevision: boolean;
  blockedReason?: string;
  readOnly?: boolean;
  id: string;
  goal: string;
  source: string;
  revision: number;
  phase: "planning" | "execution" | "review" | "acceptance" | "complete";
  turn: "human" | "agent" | "recovery" | "done";
};
export type WorkflowDetail = WorkflowRun & { summary: WorkflowSummary; runners?: {
  implement: string; review: string; capabilities: { id: string; label: string }[];
} };
