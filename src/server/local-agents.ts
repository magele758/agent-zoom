import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeGroup } from "../groups.ts";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export type Probe = {
  exists: (path: string) => boolean;
  bins: ReadonlySet<string>;
};

export type LocalAgent = {
  id: string;
  label: string;
  handle: string;
  runtime: string;
  detail: string;
  writable: boolean;
  connected: boolean;
};

type Spec = {
  id: string;
  label: string;
  handle: string;
  runtime: string;
  detail: string;
  writable: boolean;
};

const SPECS: Spec[] = [
  { id: "cursor", label: "Cursor", handle: "cursor", runtime: "cursor", detail: "写入 ~/.cursor/mcp.json", writable: true },
  { id: "claude", label: "Claude Code", handle: "claude", runtime: "claude", detail: "写入 ~/.claude.json", writable: true },
  {
    id: "claude-desk",
    label: "Claude 桌面版",
    handle: "claude-desk",
    runtime: "claude-desk",
    detail: "写入 Claude 桌面版的配置",
    writable: true,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    handle: "chatgpt",
    runtime: "chatgpt",
    detail: "写入 ~/.codex/config.toml，和 Codex 共用这个文件",
    writable: true,
  },
  {
    id: "codex",
    label: "Codex",
    handle: "codex",
    runtime: "codex",
    detail: "写入 ~/.codex/config.toml，和 ChatGPT 共用这个文件",
    writable: true,
  },
  { id: "gemini", label: "Gemini", handle: "gemini", runtime: "gemini", detail: "写入 ~/.gemini/settings.json", writable: true },
  {
    id: "opencode",
    label: "OpenCode",
    handle: "opencode",
    runtime: "opencode",
    detail: "写入 ~/.config/opencode/opencode.json",
    writable: true,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    handle: "windsurf",
    runtime: "windsurf",
    detail: "写入 ~/.codeium/windsurf/mcp_config.json",
    writable: true,
  },
  { id: "vscode", label: "VS Code", handle: "vscode", runtime: "vscode", detail: "写入 VS Code 的 User/mcp.json", writable: true },
  { id: "zed", label: "Zed", handle: "zed", runtime: "zed", detail: "已安装。这个客户端的一键接入还没做", writable: false },
  { id: "copilot", label: "Copilot", handle: "copilot", runtime: "copilot", detail: "已安装。这个客户端的一键接入还没做", writable: false },
  { id: "amp", label: "Amp", handle: "amp", runtime: "amp", detail: "已安装。这个客户端的一键接入还没做", writable: false },
];

export function specFor(id: string) {
  return SPECS.find((spec) => spec.id === id);
}

export function isInstalled(id: string, home: string, probe: Probe, apps: (name: string) => boolean) {
  if (id === "cursor") return apps("Cursor.app") || probe.exists(join(home, ".cursor")) || probe.bins.has("cursor");
  if (id === "claude") return probe.bins.has("claude") || probe.exists(join(home, ".claude.json"));
  if (id === "claude-desk") return apps("Claude.app");
  if (id === "chatgpt") return apps("ChatGPT.app");
  if (id === "codex") return probe.bins.has("codex");
  if (id === "gemini") return probe.bins.has("gemini") || apps("Gemini.app") || probe.exists(join(home, ".gemini/settings.json"));
  if (id === "opencode") {
    return probe.bins.has("opencode") || apps("OpenCode.app") || probe.exists(join(home, ".config/opencode/opencode.json"));
  }
  if (id === "windsurf") return apps("Windsurf.app") || probe.exists(join(home, ".codeium/windsurf/mcp_config.json"));
  if (id === "vscode") {
    return apps("Visual Studio Code.app") || probe.exists(join(home, "Library/Application Support/Code/User/mcp.json"));
  }
  if (id === "zed") return apps("Zed.app");
  if (id === "copilot") return probe.bins.has("copilot") || probe.exists(join(home, ".copilot"));
  if (id === "amp") return probe.bins.has("amp") || probe.exists(join(home, ".amp"));
  return false;
}

export function listFromProbe(
  home: string,
  probe: Probe,
  apps: (name: string) => boolean,
  connected = new Set<string>(),
): LocalAgent[] {
  return SPECS.filter((spec) => isInstalled(spec.id, home, probe, apps)).map((spec) => ({
    ...spec,
    connected: connected.has(spec.handle),
  }));
}

export function mcpLaunch(repo: string, node: string, handle: string) {
  return {
    command: node,
    args: [join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "src/cli.ts"), "mcp", "--handle", handle],
    cwd: repo,
  };
}

export function upsertJsonServer(text: string, group: string, name: string, entry: Record<string, unknown>) {
  const data = text.trim() ? (JSON.parse(text) as unknown) : {};
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("配置不是对象");
  const record = data as Record<string, unknown>;
  const current = record[group];
  const servers =
    current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  servers[name] = entry;
  record[group] = servers;
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function upsertTomlServer(text: string, name: string, body: string) {
  const quoted = name.replaceAll('"', '\\"');
  const header = `[mcp_servers."${quoted}"]`;
  const plain = `[mcp_servers.${name}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === header || trimmed === plain;
  });
  const block = [header, ...body.replace(/\n$/, "").split("\n")];
  if (start === -1) {
    const base = text.replace(/\s*$/, "");
    return `${base}${base ? "\n\n" : ""}${block.join("\n")}\n`;
  }
  const childPrefixes = [`[mcp_servers."${quoted}".`, `[mcp_servers.${name}.`];
  let end = start + 1;
  while (end < lines.length) {
    const trimmed = lines[end].trim();
    if (trimmed.startsWith("[") && !childPrefixes.some((prefix) => trimmed.startsWith(prefix))) break;
    end += 1;
  }
  return [...lines.slice(0, start), ...block, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

function tomlString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function configTarget(home: string, id: string, launch: ReturnType<typeof mcpLaunch>) {
  const jsonEntry = { command: launch.command, args: launch.args, cwd: launch.cwd };
  if (id === "cursor") return { kind: "json" as const, path: join(home, ".cursor/mcp.json"), group: "mcpServers", name: "agent-chatroom", entry: jsonEntry };
  if (id === "claude") return { kind: "json" as const, path: join(home, ".claude.json"), group: "mcpServers", name: "agent-chatroom", entry: jsonEntry };
  if (id === "claude-desk") {
    return {
      kind: "json" as const,
      path: join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
      group: "mcpServers",
      name: "agent-chatroom",
      entry: jsonEntry,
    };
  }
  if (id === "gemini") return { kind: "json" as const, path: join(home, ".gemini/settings.json"), group: "mcpServers", name: "agent-chatroom", entry: jsonEntry };
  if (id === "windsurf") {
    return {
      kind: "json" as const,
      path: join(home, ".codeium/windsurf/mcp_config.json"),
      group: "mcpServers",
      name: "agent-chatroom",
      entry: jsonEntry,
    };
  }
  if (id === "vscode") {
    return {
      kind: "json" as const,
      path: join(home, "Library/Application Support/Code/User/mcp.json"),
      group: "servers",
      name: "agent-chatroom",
      entry: { type: "stdio", ...jsonEntry },
    };
  }
  if (id === "opencode") {
    return {
      kind: "json" as const,
      path: join(home, ".config/opencode/opencode.json"),
      group: "mcp",
      name: "agent-chatroom",
      entry: { type: "local", command: [launch.command, ...launch.args], cwd: launch.cwd, enabled: true },
    };
  }
  if (id === "chatgpt" || id === "codex") {
    const serverName = id === "codex" ? "agent-chatroom-codex" : "agent-chatroom";
    const body = [
      `command = ${tomlString(launch.command)}`,
      "args = [",
      ...launch.args.map((arg) => `  ${tomlString(arg)},`),
      "]",
      `cwd = ${tomlString(launch.cwd)}`,
      "enabled = true",
      "startup_timeout_sec = 30",
    ].join("\n");
    return { kind: "toml" as const, path: join(home, ".codex/config.toml"), serverName, body };
  }
  return null;
}

type CredEntry = { token: string; roomId: string; runtime: string };
type CredFile = {
  url?: string;
  agents?: Record<string, CredEntry>;
  previous?: Array<CredEntry & { handle: string; replacedAt: string }>;
};

function parseCreds(text: string | null): CredFile {
  return text?.trim() ? (JSON.parse(text) as CredFile) : {};
}

export function savedCredential(text: string | null, handle: string): CredEntry | null {
  const entry = parseCreds(text).agents?.[handle];
  return entry?.token ? entry : null;
}

export function mergeCredentials(
  text: string | null,
  input: { url: string; handle: string; token: string; roomId: string; runtime: string },
  replacedAt = new Date().toISOString(),
) {
  const data = parseCreds(text);
  const agents = data.agents && typeof data.agents === "object" ? data.agents : {};
  const old = agents[input.handle];
  const previous = Array.isArray(data.previous) ? data.previous : [];
  if (old?.token && old.token !== input.token) previous.push({ handle: input.handle, ...old, replacedAt });
  agents[input.handle] = { token: input.token, roomId: input.roomId, runtime: input.runtime };
  const next: CredFile = { url: input.url, agents };
  if (previous.length > 0) next.previous = previous;
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function credentialHas(text: string | null, handle: string) {
  return savedCredential(text, handle) !== null;
}

export function listLocalAgents(connected: Set<string>, home = homedir()) {
  const bins = new Set<string>();
  const dirs = [...(process.env.PATH ?? "").split(":"), join(home, ".local/bin"), join(home, ".opencode/bin")].filter(Boolean);
  for (const name of ["claude", "codex", "gemini", "opencode", "copilot", "amp", "cursor"]) {
    if (dirs.some((dir) => existsSync(join(dir, name)))) bins.add(name);
  }
  const probe: Probe = { exists: existsSync, bins };
  const apps = (name: string) => existsSync(`/Applications/${name}`) || existsSync(join(home, "Applications", name));
  return listFromProbe(home, probe, apps, connected);
}

export class LocalAgentError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalAgentError";
  }
}

const NO_OWN_CREDENTIAL =
  "这个句柄已经在工作室里，但这台电脑上没有属于当前身份的有效凭证。不会改动现有凭证；要修正归属见 README 的「凭证归属修复」。";

function taken(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "handle_taken";
}

function writeLaunch(home: string, id: string, launch: ReturnType<typeof mcpLaunch>) {
  try {
    return applyConfig(home, id, launch);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new LocalAgentError(400, "bad_config", "这个客户端的配置不是合法 JSON，没有改它");
    }
    throw error;
  }
}

export function connectInstalled(input: {
  id: string;
  home: string;
  repo: string;
  node: string;
  url: string;
  credPath: string;
  connected: ReadonlySet<string>;
  probe?: Probe;
  apps?: (name: string) => boolean;
  level?: unknown;
  group?: unknown;
  ownerId?: string;
  replace?: boolean;
  inspectToken?: (token: string) => { ownerId: string; ownerName: string } | null;
  enroll: (spec: { handle: string; runtime: string; level: unknown; group: string }) => { token: string; roomId: string };
  placeExisting: (handle: string) => void;
}) {
  const spec = specFor(input.id);
  if (!spec) throw new LocalAgentError(404, "unknown_agent", "没有这个客户端");
  if (!spec.writable) throw new LocalAgentError(400, "not_writable", "这个客户端的一键接入还没做");
  const installed =
    input.probe && input.apps
      ? isInstalled(spec.id, input.home, input.probe, input.apps)
      : listLocalAgents(new Set(), input.home).some((agent) => agent.id === spec.id);
  if (!installed) throw new LocalAgentError(404, "not_installed", "这台电脑上没有这个客户端");
  const group = normalizeGroup(input.group);
  if (!group) throw new LocalAgentError(400, "bad_group", "没有这个身份");
  const launch = mcpLaunch(input.repo, input.node, spec.handle);
  const credText = existsSync(input.credPath) ? readFileSync(input.credPath, "utf8") : null;
  const saved = savedCredential(credText, spec.handle);
  const savedOwner = saved && input.inspectToken ? input.inspectToken(saved.token) : null;
  const foreign = Boolean(savedOwner && input.ownerId && savedOwner.ownerId !== input.ownerId);
  const ours = Boolean(savedOwner) && !foreign;
  if (input.connected.has(spec.handle)) {
    if (input.inspectToken && !ours) {
      throw new LocalAgentError(409, "no_credential", NO_OWN_CREDENTIAL);
    }
    const path = writeLaunch(input.home, spec.id, launch);
    return {
      handle: spec.handle,
      already: true,
      path,
      note: `${spec.label} 已经在这个频道里。配置已写好，完全退出再打开它。`,
    };
  }
  if (foreign && !input.replace) {
    throw new LocalAgentError(
      409,
      "credential_other_owner",
      `这台电脑上 ${spec.handle} 的凭证属于「${savedOwner?.ownerName}」，不是当前身份。继续会换成当前身份的新凭证，旧的会留在凭证文件的 previous 里。`,
    );
  }
  try {
    const enrolled = input.enroll({ handle: spec.handle, runtime: spec.runtime, level: input.level ?? 1, group });
    const next = mergeCredentials(credText, {
      url: input.url,
      handle: spec.handle,
      token: enrolled.token,
      roomId: enrolled.roomId,
      runtime: spec.runtime,
    });
    mkdirSync(dirname(input.credPath), { recursive: true });
    writeFileSync(input.credPath, next, { mode: 0o600 });
  } catch (error) {
    if (!taken(error)) throw error;
    if (!saved || (input.inspectToken && !ours)) {
      throw new LocalAgentError(409, "no_credential", NO_OWN_CREDENTIAL);
    }
    input.placeExisting(spec.handle);
    const path = writeLaunch(input.home, spec.id, launch);
    return {
      handle: spec.handle,
      already: true,
      path,
      note: `${spec.label} 本来就在工作室里，已经加入这个频道。完全退出再打开它。`,
    };
  }
  const path = writeLaunch(input.home, spec.id, launch);
  return {
    handle: spec.handle,
    already: false,
    path,
    note: `${spec.label} 已接入。完全退出再打开它，才会连上这个频道。`,
  };
}

export function applyConfig(home: string, id: string, launch: ReturnType<typeof mcpLaunch>) {
  const target = configTarget(home, id, launch);
  if (!target) throw new Error("这个客户端还不能自动写入");
  const current = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  const next =
    target.kind === "json"
      ? upsertJsonServer(current, target.group, target.name, target.entry)
      : upsertTomlServer(current, target.serverName, target.body);
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, next);
  return target.path;
}

export function serverUrl() {
  return `http://127.0.0.1:${process.env.PORT ?? 8791}`;
}

export function machineName() {
  return hostname();
}
