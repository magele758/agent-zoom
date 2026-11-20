import type { ProjectRef } from "./project-profile-types.ts";

export type SecurityDecision = "changes" | "recheck" | "passed";
export type SecurityStatus = "pending" | SecurityDecision;

export const securityStatusLabels: Record<SecurityStatus, string> = {
  pending: "待审查",
  changes: "待整改",
  recheck: "待复核",
  passed: "已通过",
};

export type SecurityRecord = {
  outcome: SecurityDecision;
  note: string;
  evidence: string;
  recordedAt: string;
};

export type SecurityReview = ProjectRef & {
  id: string;
  scope: string;
  createdAt: string;
  history: SecurityRecord[];
};

export function securityStatus(review: SecurityReview): SecurityStatus {
  return review.history.at(-1)?.outcome ?? "pending";
}

export type SecurityDepartmentIndex = {
  projects: ProjectRef[];
  reviews: SecurityReview[];
};
