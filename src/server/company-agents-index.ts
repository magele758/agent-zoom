import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readlink } from "node:fs/promises";
import { basename, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AgentIndex, IndexedAgent, IndexSource } from "../activity-index-types.ts";

const HUB = "Agent Hub";
const HERDR = "Herdr";
const OS = "本机进程";
const exec = promisify(execFile);
const providerNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok CLI",
  "grok-build": "Grok CLI",
  agy: "Antigravity CLI",
  "antigravity-cli": "Antigravity CLI",
  antigravity: "Antigravity",
  cursor: "Cursor",
  "cursor-agent": "Cursor Agent",
  "cursor-cloud": "Cursor 云端",
  "cursor-project": "Cursor Project",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  gemini: "Gemini CLI",
  qwen: "Qwen Code",
  omp: "OMP",
  pi: "Pi",
  aider: "Aider",
};
const binaryAgents = new Set([
  "codex",
  "grok",
  "agy",
  "claude",
  "cursor-agent",
  "copilot",
  "gemini",
  "opencode",
  "qwen",
  "omp",
  "pi",
  "aider",
]);
const status = (raw: string | undefined): IndexedAgent["state"] => {
  switch (raw) {
    case "working":
    case "running":
      return "working";
    case "waiting":
    case "blocked":
      return "waiting";
    case "idle":
    case "done":
      return "idle";
    default:
      return "unknown";
  }
};
const timestamp = (v: string | null | undefined) =>
  v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const directory = (v: string | null | undefined) =>
  v && isAbsolute(v) && !/[\x00-\x1f]/.test(v) ? normalize(v) : null;
const key = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);
type Reading = { agents: IndexedAgent[]; source: IndexSource };
type ObservedProcess = { pid: number; provider: string; workspace: string | null; underHerdr: boolean };
type ProcessReading = { rows: ObservedProcess[]; missingDirectories: boolean };
type Inputs = {
  hub: () => Promise<unknown>;
  herdr: () => Promise<unknown>;
  processes: () => Promise<ProcessReading>;
};

const hubRow = z.object({
  id: z.string().min(1),
  src: z.string().min(1),
  agent: z.string().min(1),
  cwd: z.string().nullish(),
  repo: z.string().nullish(),
  status: z.string().nullish(),
  mtime_iso: z.string().nullish(),
  private: z.boolean().optional(),
  local_only: z.boolean().optional(),
});
const hubResponse = z.object({
  running: z.object({
    at: z.string(),
    window_min: z.number().positive(),
    items: z.array(z.unknown()),
    errors: z.array(z.unknown()),
  }),
});

function fromHub(value: unknown): Reading {
  const { running } = hubResponse.parse(value);
  const seen = new Map<string, IndexedAgent>();
  let rejected = 0;
  for (const item of running.items) {
    const parsed = hubRow.safeParse(item);
    if (!parsed.success) {
      rejected++;
      continue;
    }
    const row = parsed.data;
    if (row.private || row.local_only) continue;
    const provider = providerNames[row.src] ?? (row.src === "kanban" ? "Vibe Kanban" : "Coding agent");
    const id = "hub-" + key(row.src + "/" + row.id);
    const state = row.src === "kanban" ? status(row.status ?? undefined) : "recent";
    const workspace = directory(row.cwd);
    const repository = row.repo && /^[a-z0-9][\w.-]*\/[a-z0-9_.-]+$/i.test(row.repo) ? row.repo : null;
    const updatedAt = timestamp(row.mtime_iso);
    const previous = seen.get(id);
    if (previous && (previous.updatedAt ?? "") >= (updatedAt ?? "")) continue;
    seen.set(id, {
      id,
      provider,
      workspace,
      repository,
      updatedAt,
      state,
      sources: [HUB],
      label: provider + " · " + (workspace ? basename(workspace) + " · " : "") + id.slice(-6),
    });
  }
  const incomplete = rejected + running.errors.length;
  return {
    agents: [...seen.values()],
    source: {
      name: HUB,
      status: incomplete ? "partial" : "ok",
      asOf: timestamp(running.at),
      detail: `本机会话最近 ${running.window_min} 分钟的活动，含 IDE 与普通终端。云端缓存使用 Agent Hub 的独立时间窗口。${incomplete ? "部分来源未返回完整记录。" : ""}`,
    },
  };
}

const terminalRow = z.object({
  address: z.string().min(1),
  agent: z.string(),
  state: z.string(),
  cwd: z.string().nullish(),
  status: z.string().nullish(),
});
function fromHerdr(value: unknown, now: string): Reading {
  const { terminals } = z.object({ terminals: z.array(z.unknown()) }).parse(value);
  const seen = new Map<string, IndexedAgent>();
  let invalid = 0;
  for (const item of terminals) {
    const result = terminalRow.safeParse(item);
    if (!result.success) {
      invalid++;
      continue;
    }
    const r = result.data;
    // Remote terminals carry a machine/address pair. Their cwd is unrelated to the local filesystem.
    if (r.state !== "live" || r.address.includes("/")) continue;
    const provider = providerNames[r.agent.toLowerCase()] ?? (r.status ? "Herdr agent" : null);
    if (!provider) continue;
    const id = "herdr-" + key(r.address);
    seen.set(id, {
      id,
      provider,
      state: status(r.status ?? undefined),
      workspace: directory(r.cwd),
      repository: null,
      sources: [HERDR],
      updatedAt: null,
      label: provider + " · " + r.address,
    });
  }
  return {
    agents: [...seen.values()],
    source: {
      name: HERDR,
      status: invalid ? "partial" : "ok",
      asOf: now,
      detail: "本机终端自报的工作或等待状态。普通 shell 与已退出的终端不计入。",
    },
  };
}

async function hubRequest() {
  const origin = new URL(process.env.OPC_HUB_URL || "http://127.0.0.1:28790");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("local hub required");
  const res = await fetch(new URL("/api/breakpoint/preview", origin), {
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) throw Error("hub unavailable");
  return res.json();
}
async function herdrList() {
  const hc = process.env.HC_BIN ?? "hc";
  const { stdout } = await exec(hc, ["ls", "--json"], { timeout: 3500, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

type ProcessEntry = { pid: number; parent: number; name: string; executable: string };
async function processList(): Promise<ProcessReading> {
  if (typeof process.getuid !== "function") throw Error("no local process adapter");
  // comm excludes argument strings, environment variables, pasted instructions and prompt text.
  const { stdout } = await exec("ps", ["-U", String(process.getuid()), "-o", "pid=,ppid=,comm="], {
    timeout: 3000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const processes = new Map<number, ProcessEntry>();
  for (const line of stdout.split("\n")) {
    const parts = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (parts)
      processes.set(+parts[1], {
        pid: +parts[1],
        parent: +parts[2],
        name: basename(parts[3]).toLowerCase(),
        executable: parts[3],
      });
  }
  const candidates: ObservedProcess[] = [];
  for (const entry of processes.values()) {
    if (!binaryAgents.has(entry.name) || entry.executable.includes("/app-server-daemon/")) continue;
    const ancestors = new Set<number>();
    let parent = processes.get(entry.parent),
      duplicate = false,
      underHerdr = false;
    while (parent && !ancestors.has(parent.pid)) {
      ancestors.add(parent.pid);
      if (
        parent.name === entry.name ||
        (entry.name === "codex" && ["chatgpt", "codex desktop"].includes(parent.name))
      )
        duplicate = true;
      if (parent.name === "herdr-core") underHerdr = true;
      parent = processes.get(parent.parent);
    }
    if (!duplicate)
      candidates.push({ pid: entry.pid, provider: providerNames[entry.name], workspace: null, underHerdr });
  }
  if (!candidates.length) return { rows: [], missingDirectories: false };
  if (process.platform === "linux") {
    await Promise.all(
      candidates.map(async (row) => {
        row.workspace = directory(await readlink("/proc/" + row.pid + "/cwd").catch(() => null));
      }),
    );
  } else {
    // Only the cwd descriptor is requested. Never enumerate the files a session is reading.
    try {
      const { stdout: cwds } = await exec(
        "lsof",
        ["-a", "-p", candidates.map((r) => r.pid).join(","), "-d", "cwd", "-Fpn"],
        { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
      );
      const byPid = new Map(candidates.map((c) => [c.pid, c]));
      let row: ObservedProcess | undefined;
      for (const line of cwds.split("\n")) {
        if (line.startsWith("p")) row = byPid.get(Number(line.slice(1)));
        else if (line.startsWith("n") && row) row.workspace = directory(line.slice(1));
      }
    } catch {
      /* A process may exit between ps and lsof. Keep any confirmed process signal unassigned. */
    }
  }
  return { rows: candidates, missingDirectories: candidates.some((c) => !c.workspace) };
}

export async function readAgentIndex(inputs: Partial<Inputs> = {}): Promise<AgentIndex & { localWorkspaces: string[] }> {
  const now = new Date().toISOString();
  const [hub, herdr, processes] = await Promise.allSettled([
    (inputs.hub ?? hubRequest)().then(fromHub),
    (inputs.herdr ?? herdrList)().then((data) => fromHerdr(data, now)),
    (inputs.processes ?? processList)(),
  ]);
  const agents: IndexedAgent[] = [],
    sources: IndexSource[] = [];
  for (const [result, name] of [
    [hub, HUB],
    [herdr, HERDR],
  ] as const) {
    if (result.status === "fulfilled") {
      agents.push(...result.value.agents);
      sources.push(result.value.source);
    } else
      sources.push({ name, asOf: null, status: "unavailable", detail: name + " 的本机只读接口未返回有效状态。" });
  }
  if (processes.status === "fulfilled") {
    // A process is weaker evidence than a session. Add project-level process signals only where neither
    // source covers that provider/workspace. Do not attach a PID to an unrelated session in the same folder.
    const observed = (name: string) =>
      new Set(
        agents.filter((a) => a.workspace && a.sources.includes(name)).map((a) => a.provider + "\0" + a.workspace),
      );
    const hubKeys = observed(HUB),
      herdrKeys = observed(HERDR);
    const groups = new Map<string, ObservedProcess[]>();
    for (const row of processes.value.rows) {
      const group = row.provider + "\0" + (row.workspace ?? row.pid);
      if (hubKeys.has(group) || (row.underHerdr && herdrKeys.has(group))) continue;
      const list = groups.get(group) ?? [];
      list.push(row);
      groups.set(group, list);
    }
    for (const [group, rows] of groups) {
      const r = rows[0];
      agents.push({
        id: "process-" + key(group),
        provider: r.provider,
        workspace: r.workspace,
        repository: null,
        state: "unknown",
        updatedAt: null,
        sources: [OS],
        label: r.provider + " · " + rows.length + " 个可见进程",
      });
    }
    sources.push({
      name: OS,
      asOf: now,
      status: processes.value.missingDirectories ? "partial" : "ok",
      detail: "按当前用户的 CLI 可执行文件名和工作目录补齐。进程存在不能判定任务进度。",
    });
  } else sources.push({ name: OS, asOf: null, status: "unavailable", detail: "无法读取当前用户的 CLI 进程。" });
  const rank: Record<IndexedAgent["state"], number> = { working: 0, waiting: 1, recent: 2, idle: 3, unknown: 4 };
  agents.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
      a.id.localeCompare(b.id),
  );
  // Retain real local cwd observations even when Agent Hub already represents the same process.
  const localWorkspaces = new Set<string>();
  if (herdr.status === "fulfilled") {
    for (const pane of herdr.value.agents) if (pane.workspace) localWorkspaces.add(pane.workspace);
  }
  if (processes.status === "fulfilled") {
    for (const process of processes.value.rows) if (process.workspace) localWorkspaces.add(process.workspace);
  }
  return { agents, sources, localWorkspaces: [...localWorkspaces] };
}
