import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configTarget,
  connectInstalled,
  listFromProbe,
  LocalAgentError,
  mcpLaunch,
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
  "OpenCode.app",
  "Windsurf.app",
  "Visual Studio Code.app",
  "Zed.app",
];

test("installed clients stay in catalog order and mark who is already in the room", () => {
  const found = listFromProbe("/h", probe(["claude", "codex", "copilot", "amp"]), apps(desktop), new Set(["cursor"]));
  assert.deepEqual(
    found.map((agent) => agent.id),
    [
      "cursor",
      "claude",
      "claude-desk",
      "chatgpt",
      "codex",
      "gemini",
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
