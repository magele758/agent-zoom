export const serviceHealthLabels = {
  healthy: "正常",
  degraded: "性能下降",
  outage: "中断",
} as const;

export const updateOutcomeLabels = {
  applied: "已验证上线",
  failed: "更新失败",
  rolled_back: "已回退",
  cancelled: "已取消",
} as const;

export type HealthObservation = {
  id: string;
  health: keyof typeof serviceHealthLabels;
  source: string;
  note: string;
  at: string;
};

export type ServiceUpdate = {
  id: string;
  from: string;
  target: string;
  note: string;
  at: string;
  result: { outcome: keyof typeof updateOutcomeLabels; note: string; at: string } | null;
};

export type ManagedService = {
  id: string;
  name: string;
  scope: string;
  version: string;
  revision: number;
  observations: HealthObservation[];
  updates: ServiceUpdate[];
};

export type OperationsIndex = { scopes: string[]; services: ManagedService[] };

export type ServiceProbe = { id: string; name: string; healthy: boolean; latencyMs: number | null };
export type LiveHealthCheck = { checkedAt: string; services: ServiceProbe[] };
