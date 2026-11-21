import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type {
  DeployedServiceEntry,
  FleetGpu,
  FleetMachine,
  FleetServeRoute,
  ManagedService,
  OperationsTopology,
  RichServiceProbe,
} from "../operations-department-types.ts";

const execFileAsync = promisify(execFile);

type TailscalePeerRaw = {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Active?: boolean;
  Relay?: string;
  CurAddr?: string;
  LastSeen?: string;
};

type TailscaleStatusRaw = {
  Self?: TailscalePeerRaw;
  Peer?: Record<string, TailscalePeerRaw>;
};

type TailscaleServeRaw = {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
};

type HubMachineTelemetry = {
  id: string;
  label: string;
  online: boolean;
  load1: number | null;
  ncpu: number | null;
  memFreeMb: number | null;
  memTotalMb: number | null;
  gpus: FleetGpu[];
  tmuxSessions: string[];
  activeAgents: number;
  telemetryAt: string | null;
};

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseSshHostAliases(configText: string): Map<string, string> {
  const ipToAlias = new Map<string, string>();
  let currentAliases: string[] = [];
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const hostMatch = /^Host\s+(.+)$/i.exec(line);
    if (hostMatch) {
      currentAliases = hostMatch[1]
        .split(/\s+/)
        .map(s => s.trim())
        .filter(s => s && !s.includes("*") && !s.includes("?"));
      continue;
    }
    const hostNameMatch = /^HostName\s+(\S+)$/i.exec(line);
    if (hostNameMatch && currentAliases.length) {
      const ip = hostNameMatch[1].trim();
      const alias = currentAliases[0];
      // Only keep the first friendly alias for each IP (e.g. skip secondary tmux jump aliases)
      if (!ipToAlias.has(ip)) ipToAlias.set(ip, alias);
    }
  }
  return ipToAlias;
}

function readSshConfigAliases(sshConfigPath: string): Map<string, string> {
  try {
    return parseSshHostAliases(readFileSync(sshConfigPath, "utf8"));
  } catch {
    return new Map();
  }
}

function resolveTailscaleBinary(): string | null {
  const candidates = [
    process.env.OPC_TAILSCALE_BIN,
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "tailscale",
  ].filter((c): c is string => Boolean(c));
  for (const bin of candidates) {
    if (bin === "tailscale") return bin;
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

async function execJson<T>(bin: string, args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 3500, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export function readHubMachines(hubDbPath: string): HubMachineTelemetry[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(hubDbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const row = db.prepare("SELECT v FROM meta WHERE k='machines_latest'").get() as { v?: unknown } | undefined;
    if (typeof row?.v !== "string") return [];
    const parsed = JSON.parse(row.v) as { ts?: number; machines?: Array<Record<string, unknown>> };
    const tsIso = typeof parsed.ts === "number" && parsed.ts > 0 ? new Date(parsed.ts * 1000).toISOString() : null;
    if (!Array.isArray(parsed.machines)) return [];
    return parsed.machines
      .map((m): HubMachineTelemetry | null => {
        const id = typeof m.id === "string" ? m.id.trim() : "";
        if (!id) return null;
        const loadArr = Array.isArray(m.load) ? m.load : [];
        const load1 = typeof loadArr[0] === "number" && Number.isFinite(loadArr[0]) ? Math.round(loadArr[0] * 100) / 100 : null;
        const gpus: FleetGpu[] = Array.isArray(m.gpu)
          ? m.gpu
              .filter((g): g is Record<string, unknown> => Boolean(g && typeof g === "object"))
              .map(g => ({
                name: typeof g.name === "string" ? g.name : "GPU",
                utilPct: typeof g.util === "number" ? g.util : null,
                memUsedMb: typeof g.mem_used_mb === "number" ? g.mem_used_mb : null,
                memTotalMb: typeof g.mem_total_mb === "number" ? g.mem_total_mb : null,
              }))
          : [];
        const tmuxSessions = Array.isArray(m.tmux)
          ? m.tmux.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20)
          : [];
        const activeAgents = Array.isArray(m.claude) ? m.claude.length : 0;
        return {
          id,
          label: typeof m.label === "string" && m.label.trim() ? m.label.trim() : id,
          online: Boolean(m.online),
          load1,
          ncpu: typeof m.ncpu === "number" ? m.ncpu : null,
          memFreeMb: typeof m.mem_free_mb === "number" ? Math.round(m.mem_free_mb) : null,
          memTotalMb: typeof m.mem_total_mb === "number" ? Math.round(m.mem_total_mb) : null,
          gpus,
          tmuxSessions,
          activeAgents,
          telemetryAt: tsIso,
        };
      })
      .filter((item): item is HubMachineTelemetry => item !== null);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function isAllowedProbeUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
    // Allow Tailscale CGNAT 100.64.0.0/10 addresses only
    const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (m) {
      const second = Number(m[1]);
      return second >= 64 && second <= 127 && Number(m[2]) <= 255 && Number(m[3]) <= 255;
    }
    return false;
  } catch {
    return false;
  }
}

export async function probeEndpoint(origin: string): Promise<{ healthy: boolean; latencyMs: number | null }> {
  if (!isAllowedProbeUrl(origin)) return { healthy: false, latencyMs: null };
  const started = Date.now();
  const base = origin.replace(/\/+$/, "");
  for (const suffix of ["/health", "/api/health", ""]) {
    try {
      const res = await fetch(base + suffix, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(1500),
      });
      if (res.status < 500 && res.status !== 404) {
        return { healthy: true, latencyMs: Math.max(1, Date.now() - started) };
      }
      if (suffix === "" && res.status < 500) {
        return { healthy: true, latencyMs: Math.max(1, Date.now() - started) };
      }
    } catch {
      // try next suffix
    }
  }
  return { healthy: false, latencyMs: null };
}

function matchTelemetry(node: { self: boolean; alias?: string; hostName: string; dnsLabel: string }, list: HubMachineTelemetry[]) {
  if (node.self) {
    const localMatch = list.find(m => ["mac", "local", "self"].includes(norm(m.id)));
    if (localMatch) return localMatch;
  }
  const candidates = [node.alias, node.hostName, node.dnsLabel].filter((v): v is string => Boolean(v)).map(norm);
  for (const m of list) {
    const idNorm = norm(m.id);
    const labelNorm = norm(m.label);
    if (!idNorm) continue;
    if (candidates.some(c => c === idNorm || c === labelNorm)) return m;
    if (idNorm.length >= 4 && candidates.some(c => c.endsWith(idNorm) || c.includes(idNorm))) return m;
  }
  return undefined;
}

function matchManagedService(probe: RichServiceProbe, services: ManagedService[]): ManagedService | undefined {
  const probeShort = norm(probe.name.split(/[（(]/)[0]);
  const probeRepo = probe.repo ? norm(probe.repo) : "";
  const probeOrigin = probe.origin ? probe.origin.replace(/\/+$/, "") : "";
  return services.find(s => {
    if (probeOrigin && s.endpoint && s.endpoint.replace(/\/+$/, "") === probeOrigin) return true;
    const svcNorm = norm(s.name);
    if (svcNorm && probeShort && (svcNorm === probeShort || probeShort.includes(svcNorm) || svcNorm.includes(probeShort))) {
      return true;
    }
    if (probeRepo && s.scope && norm(s.scope.split("/").at(-1) ?? "") === probeRepo) return true;
    return false;
  });
}

function parseServeRoutes(serveRaw: TailscaleServeRaw | null): Array<{ httpsPort: number; target: string; publicUrl: string }> {
  if (!serveRaw?.Web) return [];
  const routes: Array<{ httpsPort: number; target: string; publicUrl: string }> = [];
  for (const [hostPort, cfg] of Object.entries(serveRaw.Web)) {
    const idx = hostPort.lastIndexOf(":");
    const host = idx > 0 ? hostPort.slice(0, idx) : hostPort;
    const port = idx > 0 ? Number(hostPort.slice(idx + 1)) : 443;
    const target = cfg.Handlers?.["/"]?.Proxy ?? Object.values(cfg.Handlers ?? {})[0]?.Proxy;
    if (!target || !Number.isFinite(port)) continue;
    const publicUrl = port === 443 ? `https://${host}/` : `https://${host}:${port}/`;
    routes.push({ httpsPort: port, target: target.replace(/\/+$/, ""), publicUrl });
  }
  return routes.sort((a, b) => a.httpsPort - b.httpsPort);
}

export type FleetReaderOptions = {
  hubDbPath?: string;
  sshConfigPath?: string;
  selfPort?: number;
  disableHostProbes?: boolean;
  tailscaleStatus?: TailscaleStatusRaw | null;
  tailscaleServe?: TailscaleServeRaw | null;
  probeFn?: (origin: string) => Promise<{ healthy: boolean; latencyMs: number | null }>;
};

export async function buildOperationsTopology(
  managedServices: ManagedService[],
  probes: RichServiceProbe[],
  options: FleetReaderOptions = {},
): Promise<OperationsTopology> {
  const checkedAt = new Date().toISOString();
  const home = homedir();
  const sshAliases = options.disableHostProbes
    ? new Map<string, string>()
    : readSshConfigAliases(options.sshConfigPath ?? join(home, ".ssh", "config"));
  const hubMachines = options.disableHostProbes
    ? []
    : readHubMachines(options.hubDbPath ?? join(home, ".agent-hub", "hub.db"));

  let tsStatus = options.tailscaleStatus;
  let tsServe = options.tailscaleServe;
  if (tsStatus === undefined && !options.disableHostProbes) {
    const bin = resolveTailscaleBinary();
    if (bin) {
      [tsStatus, tsServe] = await Promise.all([
        execJson<TailscaleStatusRaw>(bin, ["status", "--json"]),
        execJson<TailscaleServeRaw>(bin, ["serve", "status", "--json"]),
      ]);
    } else {
      tsStatus = null;
      tsServe = null;
    }
  }

  const probe = options.probeFn ?? probeEndpoint;
  const rawServe = parseServeRoutes(tsServe ?? null);
  const probeByTarget = new Map<string, RichServiceProbe>();
  for (const p of probes) {
    if (p.origin) probeByTarget.set(p.origin.replace(/\/+$/, ""), p);
  }

  const serveRoutes: FleetServeRoute[] = await Promise.all(
    rawServe.map(async r => {
      const existing = probeByTarget.get(r.target);
      if (existing) {
        return { ...r, healthy: existing.healthy, latencyMs: existing.latencyMs };
      }
      const checked = options.disableHostProbes ? { healthy: null, latencyMs: null } : await probe(r.target);
      return { ...r, healthy: checked.healthy, latencyMs: checked.latencyMs };
    }),
  );

  const machines: FleetMachine[] = [];
  const usedTelemetryIds = new Set<string>();
  const tailscaleAvailable = Boolean(tsStatus?.Self);

  const toMachine = (raw: TailscalePeerRaw, isSelf: boolean): FleetMachine => {
    const ip = (raw.TailscaleIPs ?? []).find(addr => addr.includes(".")) ?? raw.TailscaleIPs?.[0] ?? "";
    const dnsName = (raw.DNSName ?? "").replace(/\.$/, "");
    const dnsLabel = dnsName.split(".")[0] ?? "";
    const hostName = raw.HostName || dnsLabel || (isSelf ? osHostname() : ip || "unknown");
    const alias = ip ? sshAliases.get(ip) : undefined;
    const telemetry = matchTelemetry({ self: isSelf, alias, hostName, dnsLabel }, hubMachines);
    if (telemetry) usedTelemetryIds.add(telemetry.id);

    const online = isSelf ? true : Boolean(raw.Online);
    const hasDirect = Boolean(raw.CurAddr && raw.CurAddr.trim());
    const connection: FleetMachine["connection"] = isSelf
      ? "local"
      : !online
        ? "offline"
        : hasDirect
          ? "direct"
          : "relay";
    const lastSeen =
      raw.LastSeen && !raw.LastSeen.startsWith("0001-01-01") ? raw.LastSeen : null;
    const name = isSelf
      ? telemetry?.label || (alias ? `${alias}（本机）` : `${hostName}（本机）`)
      : alias || telemetry?.label || dnsLabel || hostName;

    return {
      id: isSelf ? "local" : (alias || dnsLabel || ip || hostName).toLowerCase(),
      name,
      hostName,
      dnsName,
      os: raw.OS || (isSelf ? process.platform : "unknown"),
      ip,
      self: isSelf,
      online,
      connection,
      relay: raw.Relay || null,
      lastSeen,
      load1: telemetry?.load1 ?? null,
      ncpu: telemetry?.ncpu ?? null,
      memFreeMb: telemetry?.memFreeMb ?? null,
      memTotalMb: telemetry?.memTotalMb ?? null,
      gpus: telemetry?.gpus ?? [],
      tmuxSessions: telemetry?.tmuxSessions ?? [],
      activeAgents: telemetry?.activeAgents ?? 0,
      serveRoutes: isSelf ? serveRoutes : [],
      telemetryAt: telemetry?.telemetryAt ?? null,
    };
  };

  if (tsStatus?.Self) {
    machines.push(toMachine(tsStatus.Self, true));
    for (const peer of Object.values(tsStatus.Peer ?? {})) {
      machines.push(toMachine(peer, false));
    }
  } else {
    // Fallback local machine entry when Tailscale CLI is unavailable
    const localTel = hubMachines.find(m => ["mac", "local", "self"].includes(norm(m.id)));
    if (localTel) usedTelemetryIds.add(localTel.id);
    machines.push({
      id: "local",
      name: localTel?.label ?? `${osHostname()}（本机）`,
      hostName: osHostname(),
      dnsName: "",
      os: process.platform === "darwin" ? "macOS" : process.platform,
      ip: "127.0.0.1",
      self: true,
      online: true,
      connection: "local",
      relay: null,
      lastSeen: null,
      load1: localTel?.load1 ?? null,
      ncpu: localTel?.ncpu ?? null,
      memFreeMb: localTel?.memFreeMb ?? null,
      memTotalMb: localTel?.memTotalMb ?? null,
      gpus: localTel?.gpus ?? [],
      tmuxSessions: localTel?.tmuxSessions ?? [],
      activeAgents: localTel?.activeAgents ?? 0,
      serveRoutes,
      telemetryAt: localTel?.telemetryAt ?? null,
    });
  }

  // Append any remaining hub.db fleet machines not yet matched to Tailscale peers
  for (const extra of hubMachines) {
    if (usedTelemetryIds.has(extra.id)) continue;
    machines.push({
      id: extra.id.toLowerCase(),
      name: extra.label,
      hostName: extra.id,
      dnsName: "",
      os: "linux",
      ip: "",
      self: false,
      online: extra.online,
      connection: extra.online ? "direct" : "offline",
      relay: null,
      lastSeen: extra.telemetryAt,
      load1: extra.load1,
      ncpu: extra.ncpu,
      memFreeMb: extra.memFreeMb,
      memTotalMb: extra.memTotalMb,
      gpus: extra.gpus,
      tmuxSessions: extra.tmuxSessions,
      activeAgents: extra.activeAgents,
      serveRoutes: [],
      telemetryAt: extra.telemetryAt,
    });
  }

  // Sort: Self first, then Online (direct before relay, higher telemetry richness first), then Offline by lastSeen desc
  machines.sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    const score = (m: FleetMachine) =>
      (m.connection === "direct" ? 4 : 0) + (m.gpus.length ? 3 : 0) + (m.ncpu ? 2 : 0) + m.tmuxSessions.length;
    const diff = score(b) - score(a);
    if (diff) return diff;
    return (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "");
  });

  const localMachine = machines.find(m => m.self) ?? machines[0];
  const findMachine = (hostHint?: string, endpoint?: string): FleetMachine => {
    if (endpoint) {
      try {
        const host = new URL(endpoint).hostname;
        const byIp = machines.find(m => m.ip === host || (m.dnsName && m.dnsName === host));
        if (byIp) return byIp;
      } catch { /* ignore */ }
    }
    if (hostHint) {
      const h = norm(hostHint);
      const hit = machines.find(
        m => norm(m.id) === h || norm(m.name) === h || norm(m.hostName) === h || m.ip === hostHint.trim(),
      );
      if (hit) return hit;
    }
    return localMachine;
  };

  const deployments: DeployedServiceEntry[] = [];
  const matchedManagedIds = new Set<string>();
  const seenTargets = new Set<string>();

  // 1. OPC OS main console on local machine
  if (options.selfPort) {
    const selfOrigin = `http://127.0.0.1:${options.selfPort}`;
    seenTargets.add(selfOrigin);
    const selfRoute = serveRoutes.find(r => r.target === selfOrigin);
    deployments.push({
      id: "opc-os-self",
      name: "OPC OS Zoom（总控台）",
      scope: "公司共用",
      version: "0.1.0",
      machineId: localMachine.id,
      machineName: localMachine.name,
      machineIp: localMachine.ip,
      machineOnline: true,
      endpoint: selfOrigin,
      publicUrl: selfRoute?.publicUrl ?? null,
      source: "probe",
      healthy: true,
      latencyMs: 1,
      summary: "当前运行中的 OPC OS 主控服务",
      managedServiceId: null,
    });
  }

  // 2. Live companion service probes (Commerce, GTM, Ops, Data Analysis, Agent Home, Agent Hub)
  for (const p of probes) {
    const managed = matchManagedService(p, managedServices);
    if (managed) matchedManagedIds.add(managed.id);
    const origin = (managed?.endpoint || p.origin || "").replace(/\/+$/, "");
    if (origin) seenTargets.add(origin);
    const hostMachine = findMachine(managed?.host, origin);
    const serve = serveRoutes.find(r => r.target === origin);
    deployments.push({
      id: `probe:${p.id}`,
      name: managed?.name ?? p.name.split(/[（(]/)[0],
      scope: managed?.scope || (p.repo ? p.repo : "公司共用"),
      version: managed?.version || "",
      machineId: hostMachine.id,
      machineName: hostMachine.name,
      machineIp: hostMachine.ip,
      machineOnline: hostMachine.online,
      endpoint: origin,
      publicUrl: serve?.publicUrl ?? null,
      source: "probe",
      healthy: p.healthy,
      latencyMs: p.latencyMs,
      summary: p.summary || (p.healthy ? "端点健康" : "当前不可达"),
      managedServiceId: managed?.id ?? null,
    });
  }

  // 3. Remaining manually registered services in 服务台账 (with optional live HTTP probe if endpoint is set)
  for (const svc of managedServices) {
    if (matchedManagedIds.has(svc.id)) continue;
    const hostMachine = findMachine(svc.host, svc.endpoint);
    let healthy: boolean | null = null;
    let latencyMs: number | null = null;
    if (svc.endpoint && !options.disableHostProbes && isAllowedProbeUrl(svc.endpoint)) {
      const checked = await probe(svc.endpoint);
      healthy = checked.healthy;
      latencyMs = checked.latencyMs;
    } else if (svc.observations[0]) {
      healthy = svc.observations[0].health === "healthy";
    }
    deployments.push({
      id: `registry:${svc.id}`,
      name: svc.name,
      scope: svc.scope || "公司共用",
      version: svc.version,
      machineId: hostMachine.id,
      machineName: hostMachine.name,
      machineIp: hostMachine.ip,
      machineOnline: hostMachine.online,
      endpoint: svc.endpoint ?? "",
      publicUrl: null,
      source: "registry",
      healthy,
      latencyMs,
      summary: svc.observations[0]?.note || (svc.endpoint ? (healthy ? "自定义端点健康" : "自定义端点不可达") : "台账登记服务"),
      managedServiceId: svc.id,
    });
  }

  // 4. Extra Tailscale Serve proxies not already covered by known companion services
  for (const route of serveRoutes) {
    if (seenTargets.has(route.target)) continue;
    seenTargets.add(route.target);
    const portMatch = /:(\d+)$/.exec(route.target);
    deployments.push({
      id: `serve:${route.httpsPort}`,
      name: `Tailscale Serve :${route.httpsPort}${portMatch ? ` (→ :${portMatch[1]})` : ""}`,
      scope: "Tailnet 暴露服务",
      version: "",
      machineId: localMachine.id,
      machineName: localMachine.name,
      machineIp: localMachine.ip,
      machineOnline: true,
      endpoint: route.target,
      publicUrl: route.publicUrl,
      source: "tailscale_serve",
      healthy: route.healthy,
      latencyMs: route.latencyMs,
      summary: route.healthy ? "Tailscale HTTPS 代理在线" : "后端端口当前未响应",
      managedServiceId: null,
    });
  }

  // 5. Remote / local long-running tmux services reported by Agent Hub machine telemetry
  for (const m of machines) {
    for (const sess of m.tmuxSessions) {
      deployments.push({
        id: `tmux:${m.id}:${sess}`,
        name: sess,
        scope: "远端常驻 tmux 服务",
        version: "",
        machineId: m.id,
        machineName: m.name,
        machineIp: m.ip,
        machineOnline: m.online,
        endpoint: m.ip ? `ssh ${m.name} · tmux:${sess}` : `tmux:${sess}`,
        publicUrl: null,
        source: "tmux",
        healthy: m.online ? true : false,
        latencyMs: null,
        summary: m.gpus.length
          ? `${m.gpus[0].name} 常驻会话`
          : "常驻后台 tmux 会话运行中",
        managedServiceId: null,
      });
    }
  }

  return { checkedAt, tailscaleAvailable, machines, deployments };
}
