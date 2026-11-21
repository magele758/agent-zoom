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
  host?: string;
  endpoint?: string;
  revision: number;
  observations: HealthObservation[];
  updates: ServiceUpdate[];
};

export type OperationsIndex = { scopes: string[]; services: ManagedService[] };

export type ServiceProbe = { id: string; name: string; healthy: boolean; latencyMs: number | null };
export type LiveHealthCheck = { checkedAt: string; services: ServiceProbe[] };

export type RichServiceProbe = ServiceProbe & {
  origin?: string;
  repo?: string;
  layer?: string;
  summary?: string;
};

export type FleetGpu = {
  name: string;
  utilPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
};

export type FleetServeRoute = {
  httpsPort: number;
  target: string;
  publicUrl: string;
  healthy: boolean | null;
  latencyMs: number | null;
};

export type FleetMachine = {
  id: string;
  name: string;
  hostName: string;
  dnsName: string;
  os: string;
  ip: string;
  self: boolean;
  online: boolean;
  connection: "local" | "direct" | "relay" | "offline";
  relay: string | null;
  lastSeen: string | null;
  load1: number | null;
  ncpu: number | null;
  memFreeMb: number | null;
  memTotalMb: number | null;
  gpus: FleetGpu[];
  tmuxSessions: string[];
  activeAgents: number;
  serveRoutes: FleetServeRoute[];
  telemetryAt: string | null;
};

export type DeployedServiceEntry = {
  id: string;
  name: string;
  scope: string;
  version: string;
  machineId: string;
  machineName: string;
  machineIp: string;
  machineOnline: boolean;
  endpoint: string;
  publicUrl: string | null;
  source: "probe" | "registry" | "tmux" | "tailscale_serve";
  healthy: boolean | null;
  latencyMs: number | null;
  summary: string;
  managedServiceId: string | null;
};

export type OperationsTopology = {
  checkedAt: string;
  tailscaleAvailable: boolean;
  machines: FleetMachine[];
  deployments: DeployedServiceEntry[];
};
