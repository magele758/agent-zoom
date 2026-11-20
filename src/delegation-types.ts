export type DelegateMethod = { via: "coding-agent" | "agent-home"; target: string; instructions: string };
export type DelegatePreference = DelegateMethod & { automatic: boolean };
export type Delegation = {
  id: string;
  workId: string;
  workMessageId?: string;
  sourceId: string;
  title: string;
  sourceHref: string;
  method: DelegateMethod;
  status: "queued" | "working" | "approval" | "completed" | "reconcile";
  evidence: string[];
  result: string;
  requiresApproval: boolean;
};
