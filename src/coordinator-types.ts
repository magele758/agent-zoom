export type CoordinationStatus = "running" | "ready" | "blocked" | "failed" | "canceled" | "stale" | "applied";
export type CoordinationPlan = {
  summary: string;
  mode: "task" | "pipeline" | "blocked";
  body: string;
  acceptance: string;
  handle?: string;
  steps?: Array<{ role: "research" | "product" | "ui" | "tech" | "build" | "review" | "qa"; handle: string }>;
  warnings: string[];
};
export type CoordinationRun = {
  id: string; roomId: string; prompt: string; status: CoordinationStatus; model: string; source: string;
  plan: CoordinationPlan | null; error: string; taskId: string | null;
  trace: Array<{kind: string;tool?:string;error?:string}>; createdAt: string;
};
