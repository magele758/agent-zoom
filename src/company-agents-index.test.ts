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
    title: "核对会话目的",
    what: "项目里在做什么",
    task_what: "任务卡上的描述",
  };
  const pane = { address: "p1", agent: "grok", cwd: "/tmp/project", state: "live", status: "blocked" };
  const view = await readAgentIndex({
    hub: async () => ({
      running: {
        at: row.mtime_iso,
        window_min: 5,
        errors: [],
        items: [
          row,
          row,
          { ...row, id: "x2" },
          { ...row, id: "x3", private: true, title: "PRIVATE-TEXT", what: "PRIVATE-TEXT" },
        ],
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
  const recent = view.agents.filter((x) => x.state === "recent");
  assert.ok(
    recent.every((x) => x.title === "核对会话目的" && x.what === "项目里在做什么" && x.taskWhat === "任务卡上的描述"),
  );
  assert.equal(view.agents.find((x) => x.state === "waiting")?.title, null);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE-TEXT/);
  assert.ok(view.sources.every((s) => s.status === "ok"));
});

test("session purpose uses Agent Hub title rules and drops terminal prompts", async () => {
  const long = "实现测量这一件事。".repeat(10);
  const view = await readAgentIndex({
    hub: async () => ({
      running: {
        at: "2026-11-20T09:00:00Z",
        window_min: 5,
        errors: [],
        items: [
          {
            id: "long",
            src: "grok",
            agent: "Grok CLI",
            cwd: "/tmp/a",
            title: long,
            what: "短的项目描述",
            task_what: "短的项目描述",
          },
          { id: "notitle", src: "claude", agent: "Claude Code", cwd: "/tmp/b", title: "", what: "按证据写的在做什么" },
          {
            id: "secret",
            src: "cursor",
            agent: "Cursor",
            cwd: "/tmp/c",
            title: "查看 sk-abcdefghijklmnopqrstuvwxyz123456 是否泄漏",
          },
        ],
      },
    }),
    herdr: async () => ({
      terminals: [
        {
          address: "t1d",
          agent: "grok",
          cwd: "/tmp/learn",
          state: "live",
          status: "idle",
          title: "只修改 src/session。先读 docs/PRD.md - grok",
        },
        {
          address: "t6c",
          agent: "antigravity",
          cwd: "/tmp/agy",
          state: "live",
          status: "done",
          title: "agy %100>...>agy%<<",
        },
      ],
    }),
    processes: async () => ({ rows: [], missingDirectories: false }),
  });
  const grok = view.agents.find((a) => a.workspace === "/tmp/a");
  assert.equal(grok?.title, long.slice(0, 59) + "…");
  assert.equal(grok?.what, "短的项目描述");
  assert.equal(grok?.taskWhat, "短的项目描述");
  const claude = view.agents.find((a) => a.workspace === "/tmp/b");
  assert.equal(claude?.title, null);
  assert.equal(claude?.what, "按证据写的在做什么");
  const cursor = view.agents.find((a) => a.workspace === "/tmp/c");
  assert.match(cursor?.title ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(cursor?.title ?? "", /sk-abc/);
  assert.equal(view.agents.find((a) => a.label.endsWith("t1d"))?.title, "只修改 src/session。先读 docs/PRD.md");
  assert.equal(view.agents.find((a) => a.label.endsWith("t6c"))?.title, null);
  assert.doesNotMatch(JSON.stringify(view), /agy %100/);
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
