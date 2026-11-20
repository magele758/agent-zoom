import test from "node:test";
import assert from "node:assert/strict";
import { readAgentIndex } from "./server/company-agents-index.ts";

test("read-only sources retain distinct sessions, never infer work from recent writes or process presence", async () => {
  const row = {
    id: "x1",
    src: "codex",
    agent: "Codex",
    cwd: "/tmp/project",
    repo: "owner/project",
    status: "running",
    mtime_iso: "2026-11-20T09:00:00Z",
    title: "PRIVATE-TEXT",
  };
  const pane = { address: "p1", agent: "grok", cwd: "/tmp/project", state: "live", status: "blocked" };
  const view = await readAgentIndex({
    hub: async () => ({
      running: {
        at: row.mtime_iso,
        window_min: 5,
        errors: [],
        items: [row, row, { ...row, id: "x2" }, { ...row, id: "x3", private: true }],
      },
    }),
    herdr: async () => ({
      terminals: [
        pane,
        { ...pane, address: "remote/p2" },
        { ...pane, address: "p3", agent: "node", status: null },
      ],
    }),
    processes: async () => ({
      missingDirectories: false,
      rows: [true, false].map((underHerdr, i) => ({
        pid: i + 10,
        workspace: pane.cwd,
        provider: "Grok CLI",
        underHerdr,
      })),
    }),
  });
  assert.deepEqual(
    view.agents.map((x) => x.state),
    ["waiting", "recent", "recent", "unknown"],
  );
  assert.equal(view.agents.filter((x) => x.repository === "owner/project").length, 2);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE-TEXT/);
  assert.ok(view.sources.every((s) => s.status === "ok"));
});

test("a failing or malformed source preserves the available readings", async () => {
  const view = await readAgentIndex({
    hub: async () => {
      throw Error("secret");
    },
    herdr: async () => ({ terminals: [{}, { address: "p1", agent: "codex", state: "live", status: "working" }] }),
    processes: async () => ({ rows: [], missingDirectories: false }),
  });
  assert.deepEqual(
    view.sources.map((s) => s.status),
    ["unavailable", "partial", "ok"],
  );
  assert.equal(view.agents[0].state, "working");
  assert.doesNotMatch(JSON.stringify(view), /secret/);
});

test("only real local pane and process observations contribute repository discovery directories", async () => {
  const hubRow = { id: "1", src: "codex", agent: "Codex", cwd: "/tmp/already-represented", status: "running" };
  const pane = { address: "p1", agent: "grok", cwd: "/tmp/local-pane", state: "live", status: "idle" };
  const view = await readAgentIndex({
    hub: async () => ({
      running: {
        at: "2026-11-20T09:00:00Z",
        window_min: 5,
        errors: [],
        items: [hubRow, { ...hubRow, id: "2", cwd: "/tmp/cloud-history-only" }],
      },
    }),
    herdr: async () => ({ terminals: [pane, { ...pane, address: "remote/p2", cwd: "/tmp/remote-only" }] }),
    processes: async () => ({
      rows: [
        { pid: 31, provider: "Codex", workspace: hubRow.cwd, underHerdr: false },
        { pid: 32, provider: "Grok CLI", workspace: "/tmp/just-started", underHerdr: false },
      ],
      missingDirectories: false,
    }),
  });
  assert.equal(view.agents.filter((a) => a.workspace === hubRow.cwd).length, 1);
  assert.deepEqual(view.localWorkspaces.sort(), [
    "/tmp/already-represented",
    "/tmp/just-started",
    "/tmp/local-pane",
  ]);
});
