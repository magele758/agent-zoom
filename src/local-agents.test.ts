import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configTarget,
  connectInstalled,
  isConfigured,
  listFromProbe,
  LocalAgentError,
  mcpLaunch,
  mergeCredentials,
  upsertJsonServer,
  upsertTomlServer,
  type Probe,
} from "./server/local-agents.ts";

function probe(bins: string[]): Probe {
  return { exists: () => false, bins: new Set(bins) };
}

function apps(names: string[]) {
  const installed = new Set(names);
  return (name: string) => installed.has(name);
}

const desktop = [
  "Cursor.app",
  "Claude.app",
  "ChatGPT.app",
  "Gemini.app",
  "Antigravity.app",
  "OpenCode.app",
  "Windsurf.app",
  "Visual Studio Code.app",
  "Zed.app",
];

test("installed clients stay in catalog order and mark who is already in the room", () => {
  const found = listFromProbe("/h", probe(["claude", "codex", "copilot", "amp"]), apps(desktop), new Set(["cursor"]), (id) => id === "cursor");
  assert.deepEqual(
    found.map((agent) => agent.id),
    [
      "cursor",
      "claude",
      "claude-desk",
      "chatgpt",
      "codex",
      "gemini",
      "antigravity",
      "opencode",
      "windsurf",
      "vscode",
      "zed",
      "copilot",
      "amp",
    ],
  );
  assert.equal(found.find((agent) => agent.id === "cursor")?.connected, true);
  assert.equal(found.find((agent) => agent.id === "claude")?.connected, false);
  assert.equal(found.find((agent) => agent.id === "zed")?.writable, false);
  assert.equal(found.find((agent) => agent.id === "copilot")?.writable, false);
  assert.deepEqual(listFromProbe("/h", probe([]), apps([])), []);
});

test("a same-named identity in the room is not a local config", () => {
  const found = listFromProbe("/h", probe(["claude"]), apps(["Cursor.app"]), new Set(["claude", "cursor"]), (id) => id === "cursor");
  const claude = found.find((agent) => agent.id === "claude");
  assert.deepEqual(
    { inRoom: claude?.inRoom, configured: claude?.configured, connected: claude?.connected },
    { inRoom: true, configured: false, connected: false },
  );
  const cursor = found.find((agent) => agent.id === "cursor");
  assert.equal(cursor?.connected, true);
  const local = listFromProbe("/h", probe(["claude"]), apps([]), new Set(), () => true).find((agent) => agent.id === "claude");
  assert.deepEqual({ inRoom: local?.inRoom, configured: local?.configured, connected: local?.connected }, { inRoom: false, configured: true, connected: false });
});

test("configured is read from the real config files and never writes", () => {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: {} }, projects: {} }));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { "agent-chatroom": { command: "node" } } }));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers."agent-chatroom"]\ncommand = "node"\n');
  const before = readFileSync(join(home, ".claude.json"), "utf8");
  assert.equal(isConfigured(home, "claude"), false);
  assert.equal(isConfigured(home, "cursor"), true);
  assert.equal(isConfigured(home, "chatgpt"), true);
  assert.equal(isConfigured(home, "codex"), false);
  assert.equal(isConfigured(home, "gemini"), false);
  assert.equal(isConfigured(home, "zed"), false);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), before);
  writeFileSync(join(home, ".claude.json"), "// comment\n{ \"mcpServers\": { \"agent-chatroom\": {} } }");
  assert.equal(isConfigured(home, "claude"), true);
});

test("antigravity is listed and targets its own mcp_config.json", () => {
  const found = listFromProbe("/h", probe([]), apps(["Antigravity.app"]), new Set(), () => false);
  const row = found.find((agent) => agent.id === "antigravity");
  assert.ok(row);
  assert.equal(row.handle, "antigravity");
  assert.equal(row.writable, true);
  assert.match(row.detail, /\.gemini\/antigravity\/mcp_config\.json/);
  const target = configTarget("/h", "antigravity", mcpLaunch("/repo", "/node", "antigravity"));
  assert.ok(target && target.kind === "json");
  assert.equal(target.path, "/h/.gemini/antigravity/mcp_config.json");
  assert.equal(target.group, "mcpServers");
  const byDir = listFromProbe("/h", { exists: (path) => path === "/h/.gemini/antigravity", bins: new Set() }, apps([]), new Set(), () => false);
  assert.deepEqual(byDir.map((agent) => agent.id), ["antigravity"]);
});

test("json upsert keeps sibling servers", () => {
  const next = upsertJsonServer(
    JSON.stringify({ mcpServers: { agtx: { command: "agtx" } }, other: true }),
    "mcpServers",
    "agent-chatroom",
    { command: "node", args: ["mcp"] },
  );
  const data = JSON.parse(next) as {
    other: boolean;
    mcpServers: { agtx: { command: string }; "agent-chatroom": { command: string } };
  };
  assert.equal(data.other, true);
  assert.equal(data.mcpServers.agtx.command, "agtx");
  assert.equal(data.mcpServers["agent-chatroom"].command, "node");
});

test("toml upsert replaces one server and drops its child table", () => {
  const source = `[mcp_servers.computer-use]
command = "computer"

[mcp_servers."agent-chatroom"]
command = "old"

[mcp_servers."agent-chatroom".env]
TOKEN = "secret"

[mcp_servers.node_repl]
command = "node"
`;
  const out = upsertTomlServer(source, "agent-chatroom", 'command = "fresh"\nenabled = true');
  assert.match(out, /\[mcp_servers\.computer-use\]/);
  assert.match(out, /\[mcp_servers\.node_repl\]/);
  assert.match(out, /command = "fresh"/);
  assert.equal(out.includes("TOKEN"), false);
  assert.equal(out.split('[mcp_servers."agent-chatroom"]').length, 2);
  const both = upsertTomlServer(out, "agent-chatroom-codex", 'command = "codex-node"');
  assert.match(both, /\[mcp_servers\."agent-chatroom-codex"\]/);
  assert.match(both, /\[mcp_servers\."agent-chatroom"\]/);
  assert.match(both, /computer-use/);
});

test("config targets keep each client's own shape", () => {
  const launch = mcpLaunch("/repo", "/node", "vscode");
  const vscode = configTarget("/h", "vscode", launch);
  assert.ok(vscode && vscode.kind === "json" && "type" in vscode.entry);
  assert.equal(vscode.group, "servers");
  assert.equal(vscode.entry.type, "stdio");
  const opencode = configTarget("/h", "opencode", mcpLaunch("/repo", "/node", "opencode"));
  assert.ok(opencode && opencode.kind === "json");
  assert.equal(opencode.group, "mcp");
  assert.deepEqual(opencode.entry.command, ["/node", launch.args[0], launch.args[1], "mcp", "--handle", "opencode"]);
  const chat = configTarget("/h", "chatgpt", mcpLaunch("/repo", "/node", "chatgpt"));
  const codex = configTarget("/h", "codex", mcpLaunch("/repo", "/node", "codex"));
  assert.ok(chat && chat.kind === "toml" && chat.serverName === "agent-chatroom");
  assert.ok(codex && codex.kind === "toml" && codex.serverName === "agent-chatroom-codex");
  assert.equal(configTarget("/h", "zed", launch), null);
});

test("connect writes one new client and keeps the other credential", () => {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  const cred = join(home, "credentials.json");
  writeFileSync(
    cred,
    `${JSON.stringify({
      url: "http://127.0.0.1:8791",
      agents: { chatgpt: { token: "keep-me", roomId: "room-chatgpt", runtime: "chatgpt" } },
    })}\n`,
  );
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ userState: { theme: "dark" }, mcpServers: {} }));
  const result = connectInstalled({
    id: "claude",
    home,
    repo: "/repo",
    node: "/node",
    url: "http://127.0.0.1:8791",
    credPath: cred,
    connected: new Set(),
    probe: probe(["claude"]),
    apps: apps([]),
    enroll: () => ({ token: "agt_new", roomId: "room-claude" }),
    placeExisting: () => {
      throw new Error("should not place");
    },
  });
  assert.equal(result.handle, "claude");
  assert.equal(result.already, false);
  assert.equal("token" in result, false);
  assert.equal(JSON.stringify(result).includes("agt_new"), false);
  const saved = JSON.parse(readFileSync(cred, "utf8")) as {
    url: string;
    agents: Record<string, { token: string; roomId: string }>;
  };
  assert.equal(saved.url, "http://127.0.0.1:8791");
  assert.equal(saved.agents.chatgpt.token, "keep-me");
  assert.equal(saved.agents.claude.token, "agt_new");
  assert.equal(saved.agents.claude.roomId, "room-claude");
  const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
    userState: { theme: string };
    mcpServers: { "agent-chatroom": { command: string; args: string[] } };
  };
  assert.equal(config.userState.theme, "dark");
  assert.equal(config.mcpServers["agent-chatroom"].command, "/node");
  assert.equal(config.mcpServers["agent-chatroom"].args.at(-1), "claude");
});

test("connect forwards the level chosen when the agent is added", () => {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  const cred = join(home, "credentials.json");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  let seen: unknown;
  connectInstalled({
    id: "claude",
    home,
    repo: "/repo",
    node: "/node",
    url: "http://127.0.0.1:8791",
    credPath: cred,
    connected: new Set(),
    level: 4,
    probe: probe(["claude"]),
    apps: apps([]),
    enroll: (spec) => {
      seen = spec.level;
      return { token: "agt_level", roomId: "room-claude" };
    },
    placeExisting: () => {
      throw new Error("should not place");
    },
  });
  assert.equal(seen, 4);
});

test("connect forwards the group chosen when the agent is added", () => {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  const cred = join(home, "credentials.json");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  let seen = "";
  connectInstalled({
    id: "claude",
    home,
    repo: "/repo",
    node: "/node",
    url: "http://127.0.0.1:8791",
    credPath: cred,
    connected: new Set(),
    group: "architect",
    probe: probe(["claude"]),
    apps: apps([]),
    enroll: (spec) => {
      seen = spec.group;
      return { token: "agt_group", roomId: "room-claude" };
    },
    placeExisting: () => {
      throw new Error("should not place");
    },
  });
  assert.equal(seen, "architect");
});

test("a taken handle without a local credential does not write config", () => {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  const cred = join(home, "credentials.json");
  writeFileSync(cred, `${JSON.stringify({ url: "http://127.0.0.1:8791", agents: {} })}\n`);
  assert.throws(
    () =>
      connectInstalled({
        id: "codex",
        home,
        repo: "/repo",
        node: "/node",
        url: "http://127.0.0.1:8792",
        credPath: cred,
        connected: new Set(),
        probe: probe(["codex"]),
        apps: apps([]),
        enroll: () => {
          const error = new Error("taken") as Error & { code: string };
          error.code = "handle_taken";
          throw error;
        },
        placeExisting: () => {
          throw new Error("should not place");
        },
      }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "no_credential",
  );
  assert.equal(existsSync(join(home, ".codex/config.toml")), false);
  const saved = JSON.parse(readFileSync(cred, "utf8")) as { url: string };
  assert.equal(saved.url, "http://127.0.0.1:8791");
});

test("a taken handle with a credential joins the room and does not retarget the url", () => {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  const cred = join(home, "credentials.json");
  writeFileSync(
    cred,
    `${JSON.stringify({
      url: "http://127.0.0.1:8791",
      agents: { codex: { token: "keep-codex", roomId: "room-codex", runtime: "codex" } },
    })}\n`,
  );
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.computer-use]\ncommand = "computer"\n');
  let placed = 0;
  const result = connectInstalled({
    id: "codex",
    home,
    repo: "/repo",
    node: "/node",
    url: "http://127.0.0.1:8792",
    credPath: cred,
    connected: new Set(),
    probe: probe(["codex"]),
    apps: apps([]),
    enroll: () => {
      const error = new Error("taken") as Error & { code: string };
      error.code = "handle_taken";
      throw error;
    },
    placeExisting: () => {
      placed += 1;
    },
  });
  assert.equal(placed, 1);
  assert.equal(result.already, true);
  assert.equal(JSON.stringify(result).includes("keep-codex"), false);
  const saved = JSON.parse(readFileSync(cred, "utf8")) as { url: string; agents: { codex: { token: string } } };
  assert.equal(saved.url, "http://127.0.0.1:8791");
  assert.equal(saved.agents.codex.token, "keep-codex");
  const toml = readFileSync(join(home, ".codex/config.toml"), "utf8");
  assert.match(toml, /computer-use/);
  assert.match(toml, /agent-chatroom-codex/);
});

test("clients that cannot be written are refused before any enroll", () => {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  assert.throws(
    () =>
      connectInstalled({
        id: "zed",
        home,
        repo: "/repo",
        node: "/node",
        url: "http://127.0.0.1:8791",
        credPath: join(home, "credentials.json"),
        connected: new Set(),
        probe: probe([]),
        apps: apps(["Zed.app"]),
        enroll: () => {
          throw new Error("should not enroll");
        },
        placeExisting: () => {
          throw new Error("should not place");
        },
      }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "not_writable",
  );
});

function credHome(agents: Record<string, { token: string; roomId: string; runtime: string }>) {
  const home = mkdtempSync(join(tmpdir(), "local-agents-"));
  const cred = join(home, "credentials.json");
  writeFileSync(cred, `${JSON.stringify({ url: "http://127.0.0.1:8791", agents })}\n`);
  return { home, cred };
}

const owners: Record<string, { ownerId: string; ownerName: string }> = {
  tok_penglei: { ownerId: "u-penglei", ownerName: "彭磊" },
  tok_magele: { ownerId: "u-magele", ownerName: "magele758" },
};

function connectCursor(
  home: string,
  cred: string,
  ownerId: string,
  extra: { replace?: boolean; connected?: string[]; enroll?: () => { token: string; roomId: string } } = {},
) {
  return connectInstalled({
    id: "cursor",
    home,
    repo: "/repo",
    node: "/node",
    url: "http://127.0.0.1:8791",
    credPath: cred,
    connected: new Set(extra.connected ?? []),
    probe: probe([]),
    apps: apps(["Cursor.app"]),
    ownerId,
    replace: extra.replace,
    inspectToken: (token) => owners[token] ?? null,
    enroll: extra.enroll ?? (() => ({ token: "tok_new", roomId: "room-new" })),
    placeExisting: () => undefined,
  });
}

test("connecting under another identity refuses to overwrite a live credential and does not enroll", () => {
  const { home, cred } = credHome({ cursor: { token: "tok_penglei", roomId: "room-penglei", runtime: "cursor" } });
  let enrolled = 0;
  assert.throws(
    () =>
      connectCursor(home, cred, "u-magele", {
        enroll: () => {
          enrolled += 1;
          return { token: "tok_new", roomId: "room-new" };
        },
      }),
    (error: unknown) =>
      error instanceof LocalAgentError && error.code === "credential_other_owner" && error.message.includes("彭磊"),
  );
  assert.equal(enrolled, 0);
  const saved = JSON.parse(readFileSync(cred, "utf8")) as { agents: { cursor: { token: string } } };
  assert.equal(saved.agents.cursor.token, "tok_penglei");
  assert.equal(existsSync(join(home, ".cursor/mcp.json")), false);
});

test("an explicit replace swaps the credential and keeps the old token under previous", () => {
  const { home, cred } = credHome({ cursor: { token: "tok_penglei", roomId: "room-penglei", runtime: "cursor" } });
  const result = connectCursor(home, cred, "u-magele", { replace: true });
  assert.equal(result.already, false);
  const saved = JSON.parse(readFileSync(cred, "utf8")) as {
    agents: { cursor: { token: string } };
    previous: Array<{ handle: string; token: string }>;
  };
  assert.equal(saved.agents.cursor.token, "tok_new");
  assert.equal(saved.previous.length, 1);
  assert.equal(saved.previous[0].handle, "cursor");
  assert.equal(saved.previous[0].token, "tok_penglei");
});

test("a dead credential is replaced without a prompt, a matching owner is reused", () => {
  const stale = credHome({ cursor: { token: "tok_gone", roomId: "r", runtime: "cursor" } });
  assert.equal(connectCursor(stale.home, stale.cred, "u-magele").already, false);
  const same = credHome({ cursor: { token: "tok_magele", roomId: "r", runtime: "cursor" } });
  const reused = connectCursor(same.home, same.cred, "u-magele", { connected: ["cursor"] });
  assert.equal(reused.already, true);
  const saved = JSON.parse(readFileSync(same.cred, "utf8")) as { agents: { cursor: { token: string } } };
  assert.equal(saved.agents.cursor.token, "tok_magele");
});

test("an already-connected handle never retargets onto someone else's credential", () => {
  const { home, cred } = credHome({ cursor: { token: "tok_penglei", roomId: "room-penglei", runtime: "cursor" } });
  assert.throws(
    () => connectCursor(home, cred, "u-magele", { connected: ["cursor"], replace: true }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "no_credential",
  );
  assert.equal(existsSync(join(home, ".cursor/mcp.json")), false);
});

test("a taken handle is not joined with a credential that belongs to another owner", () => {
  const { home, cred } = credHome({ cursor: { token: "tok_penglei", roomId: "room-penglei", runtime: "cursor" } });
  assert.throws(
    () =>
      connectCursor(home, cred, "u-magele", {
        replace: true,
        enroll: () => {
          const error = new Error("taken") as Error & { code: string };
          error.code = "handle_taken";
          throw error;
        },
      }),
    (error: unknown) => error instanceof LocalAgentError && error.code === "no_credential",
  );
});

test("mergeCredentials archives a replaced token and leaves unrelated entries alone", () => {
  const first = mergeCredentials(null, { url: "u", handle: "cursor", token: "a", roomId: "r1", runtime: "cursor" });
  assert.equal("previous" in JSON.parse(first), false);
  const second = mergeCredentials(first, { url: "u", handle: "chatgpt", token: "c", roomId: "r1", runtime: "chatgpt" });
  assert.equal("previous" in JSON.parse(second), false);
  const third = mergeCredentials(second, { url: "u", handle: "cursor", token: "b", roomId: "r2", runtime: "cursor" }, "T");
  const data = JSON.parse(third) as {
    agents: Record<string, { token: string }>;
    previous: Array<{ token: string; replacedAt: string }>;
  };
  assert.equal(data.agents.cursor.token, "b");
  assert.equal(data.agents.chatgpt.token, "c");
  assert.deepEqual(data.previous.map((item) => [item.token, item.replacedAt]), [["a", "T"]]);
});
