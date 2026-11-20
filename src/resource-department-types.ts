export type QuotaReading = {
  reportedRemaining: number | null;
  observedAt: string | null;
  resetsAt: string | null;
};

export type ManualPlanInput = QuotaReading & {
  name: string;
  window: string;
  unit: string;
  capacity: number | null;
  renewsOn: string | null;
  fee: number | null;
  currency: string | null;
  billingCycle: "monthly" | "yearly" | null;
};

export type ManualPlan = ManualPlanInput & { id: string; revision: number };

export type HubQuotaTool = {
  tool: string;
  name: string;
  plan: string | null;
  applicable: boolean;
  windows: (QuotaReading & { name: string; live: boolean })[];
  balances: (QuotaReading & { name: string; unit: "credits" | "次" })[];
};

export type SubscriptionFee = {
  tool: string;
  plan: string;
  monthlyUsd: number | null;
  paid: boolean;
  checked: string | null;
  since: string | null;
  until: string | null;
};

export type CollectionReceipt = {
  hub: ResourceDepartmentIndex["hub"];
  snapshotUpdated: boolean;
  recentReadings: number;
};

export type ResourceDepartmentIndex = {
  canCollect: boolean;
  plans: ManualPlan[];
  hub: {
    generatedAt: string | null;
    tools: HubQuotaTool[];
    fees: SubscriptionFee[];
    feesAvailable: boolean;
  };
};

export function currentReading(reading: QuotaReading, now = Date.now(), fromHub = false) {
  if (reading.resetsAt && Date.parse(reading.resetsAt) <= now) return { remaining: null, state: "reset" } as const;
  if (reading.reportedRemaining === null || !reading.observedAt) return { remaining: null, state: "unknown" } as const;
  const stale = fromHub && now - Date.parse(reading.observedAt) > 3600000;
  return { remaining: reading.reportedRemaining, state: stale ? "stale" : "observed" } as const;
}
