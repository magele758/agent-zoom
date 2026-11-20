export type BusinessMode = "development" | "experiment";
export type BusinessAsset = {
  kind: "product" | "project" | "plugin" | "method";
  name: string;
  reference: string;
};
export type LineSpec = {
  name: string;
  goal: string;
  mode: BusinessMode;
  steps: string[];
  assets: BusinessAsset[];
};
export type BusinessLine = LineSpec & { id: string; revision: number };
export type BusinessLineSummary = BusinessLine & { trials: number; pendingReviews: number; transactions: number };
export type TrialInput = {
  requestId: string;
  title: string;
  hypothesis: string;
  metric: string;
  scope: string;
};
export type ObservationKind = "observation" | "receipt" | "refund" | "expense";
export type TrialEvidence = {
  id: string;
  kind: ObservationKind;
  note: string;
  reference: string;
  currency?: string;
  minor?: number;
  at: string;
};
export type BusinessTrial = TrialInput & {
  id: string;
  lineId: string;
  recipe: LineSpec;
  taskId: string;
  createdAt: string;
  evidence: TrialEvidence[];
  referrals: { opportunityId: string; project: string; title: string; runId: string | null }[];
  questionId?: string;
  decision?: string;
};
export type BusinessPortfolio = { lines: BusinessLine[]; trials: BusinessTrial[] };
