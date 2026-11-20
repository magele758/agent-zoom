import type { ProductStageId } from "./product-stages.ts";

export type StageWorkTarget = "coding-agent" | "agent-home";
export type StageWorkStatus = "open" | "active" | "waiting" | "reconcile" | "completed";
export type StageWorkInput = {
  requestId: string;
  product: string;
  project?: string;
  companyItemId?: string;
  stage: ProductStageId;
  templateId: string;
  title: string;
  goal: string;
  inputs: string;
  deliverable: string;
  acceptance: string;
  target: StageWorkTarget;
  requestedAgent?: string;
};
export type StageWork = Omit<StageWorkInput, "stage"> & {
  stage: ProductStageId | null;
  id: string;
  createdAt: string;
  status: StageWorkStatus;
  owner?: string;
  leaseUntil?: string;
  evidence: string[];
  messageId: string;
};
