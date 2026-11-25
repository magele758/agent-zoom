import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  clearWorkspaceGitCache,
  detectWorkOrigin,
  parseHerdrWhere,
  resolveCanonicalWorkspace,
  WorkspaceClassifierStore,
} from "./server/workspace-classifier.ts";
import { resolveProjectHerdrSpace } from "./server/herdr-space-router.ts";
import { buildAttentionItems, buildHerdrTrees } from "./server/workstreams.ts";
import { HerdrController, redactScreenLine, registerHerdrControlRoutes } from "./server/herdr-control.ts";
import {
  getHubCircuitBreakerState,
  parseHerdrMachinesOutput,
  readAgentIndex,
  resetHubCircuitBreaker,
} from "./server/company-agents-index.ts";
import { CliLedgerService } from "./server/cli-ledger.ts";
import { createApp } from "./server/http.ts";
import { openStore } from "./server/logic.ts";
import type { IndexedAgent } from "./activity-index-types.ts";
import type { WorkstreamsOverview } from "./workstreams-types.ts";
import type { CliLedgerOverview, CliSessionSummary } from "./cli-ledger-types.ts";
import { Hono } from "hono";

test("resolveCanonicalWorkspace collapses real git worktrees, herdr split-tasks, factory worktrees, and filters home/probe dirs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opc-classifier-wt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  clearWorkspaceGitCache();

  // Real git repo + real git worktree
  const mainRepo = join(dir, "chrome-plugin-gemini");
  const wtDir = join(dir, "split-wt-s3");
  mkdirSync(mainRepo, { recursive: true });
  execFileSync("git", ["init", "-q", mainRepo]);
  execFileSync("git", ["-C", mainRepo, "remote", "add", "origin", "https://github.com/magele758/open-chrome-ai.git"]);
  writeFileSync(join(mainRepo, "README.md"), "# test\n");
  execFileSync("git", ["-C", mainRepo, "add", "."]);
  execFileSync("git", [
    "-C",
    mainRepo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "init",
  ]);
  execFileSync("git", ["-C", mainRepo, "worktree", "add", "-q", "--detach", wtDir, "HEAD"]);

  const resolvedRealWt = resolveCanonicalWorkspace(wtDir, { homeDir: "/Users/tester" });
  assert.equal(resolvedRealWt.isWorktree, true);
  assert.ok(resolvedRealWt.canonicalWorkspace?.endsWith("chrome-plugin-gemini"));
  assert.equal(resolvedRealWt.repository, "magele758/open-chrome-ai");

  // Historical/cleaned Herdr split-task worktree path
  const herdrWt = resolveCanonicalWorkspace(
    "/Users/tester/.herdr/split-tasks/chrome-plugin-gemini/t99/wt-s4",
    { homeDir: "/Users/tester", skipFs: true },
  );
  assert.equal(herdrWt.isWorktree, true);
  assert.equal(herdrWt.worktreeProjectHint, "chrome-plugin-gemini");

  // Dark Factory worktree path
  const factoryWt = resolveCanonicalWorkspace(
    "/Users/tester/developer/ai-github/agent-chatroom/data/factory-worktrees/run_f59b746a1ffc4166",
    { homeDir: "/Users/tester", skipFs: true },
  );
  assert.equal(factoryWt.isWorktree, true);
  assert.equal(factoryWt.canonicalWorkspace, "/Users/tester/developer/ai-github/agent-chatroom");

  // Home dir & temp probe dir
  const homeRes = resolveCanonicalWorkspace("/Users/tester", { homeDir: "/Users/tester", skipFs: true });
  assert.equal(homeRes.isHomeDir, true);
  assert.equal(homeRes.canonicalWorkspace, null);

  const probeRes = resolveCanonicalWorkspace("/Users/tester/Downloads/.grok-hflow-probe/cwd", {
    homeDir: "/Users/tester",
    skipFs: true,
  });
  assert.equal(probeRes.isTempDir, true);
  assert.equal(probeRes.canonicalWorkspace, null);
});

test("WorkspaceClassifierStore maps company registry vs personal fallback and persists user overrides", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE company_projects (product TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE company_project_repos (product TEXT NOT NULL, name TEXT NOT NULL, repo TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO company_projects VALUES (?, ?)").run("PageLens", "pagelens-agent");
  db.prepare("INSERT INTO company_project_repos VALUES (?, ?, ?)").run(
    "PageLens",
    "pagelens-agent",
    "magele758/pagelens-agent",
  );
  db.prepare("INSERT INTO company_projects VALUES (?, ?)").run("OPC 分析与内核", "ppeng-agent-bot");

  const store = new WorkspaceClassifierStore(db, { homeDir: "/Users/tester" });

  // Company product
  const pl = store.classify({
    workspace: "/Users/tester/developer/pagelens-agent",
    repository: "magele758/pagelens-agent",
    skipFs: true,
  });
  assert.equal(pl.category, "company_product");
  assert.equal(pl.group, "PageLens");

  // RD infra
  const core = store.classify({
    workspace: "/Users/tester/developer/self-test-grounding/ppeng-agent-core",
    skipFs: true,
  });
  assert.equal(core.category, "rd_infra");
  assert.equal(core.group, "OPC 分析与内核");

  // Unclassified worktree collapses and defaults to personal
  const personal = store.classify({
    workspace: "/Users/tester/.herdr/split-tasks/chrome-plugin-gemini/t99/wt-s3",
    skipFs: true,
  });
  assert.equal(personal.canonicalProject, "chrome-plugin-gemini");
  assert.equal(personal.category, "personal");
  assert.equal(personal.categoryLabel, "个人事项");

  // User override persists and wins
  store.upsertOverride({
    key: personal.key,
    category: "company_product",
    groupName: "PageLens",
    canonicalProject: "chrome-plugin-gemini",
  });
  const overridden = store.classify({
    workspace: "/Users/tester/.herdr/split-tasks/chrome-plugin-gemini/t99/wt-s3",
    skipFs: true,
  });
  assert.equal(overridden.category, "company_product");
  assert.equal(overridden.group, "PageLens");
  assert.equal(overridden.source, "override");

  // Delete override reverts to fallback
  assert.equal(store.deleteOverride(personal.key).deleted, true);
  assert.equal(
    store.classify({
      workspace: "/Users/tester/.herdr/split-tasks/chrome-plugin-gemini/t99/wt-s3",
      skipFs: true,
    }).category,
    "personal",
  );
  db.close();
});

test("detectWorkOrigin and buildHerdrTrees distinguish OPC dispatched vs founder managed and fold sub-agents", () => {
  assert.equal(
    detectWorkOrigin({ labels: { "kunlun.run": "r1", "kunlun.attempt": "a1" }, hasHerdrAddress: true }).originTrack,
    "opc_dispatched",
  );
  assert.equal(
    detectWorkOrigin({ labels: { "opc.source": "dark-factory", "opc.run": "run_1" }, hasHerdrAddress: true }).originTrack,
    "opc_dispatched",
  );
  assert.equal(
    detectWorkOrigin({
      rawWorkspace: "/Users/penglei/developer/ai-github/agent-chatroom/data/factory-worktrees/run_abc123",
    }).originTrack,
    "opc_dispatched",
  );
  assert.equal(
    detectWorkOrigin({
      firstInstruction: "Task [tsk_1234abcd]: Fix payment webhook",
    }).originTrack,
    "opc_dispatched",
  );
  assert.equal(
    detectWorkOrigin({
      labels: { "herdr.space": "sp1" },
      rawWorkspace: "/Users/penglei/developer/self-test-grounding/chrome-plugin-gemini",
      hasHerdrAddress: true,
    }).originTrack,
    "founder_managed",
  );

  assert.deepEqual(parseHerdrWhere("chrome-plugin-gemini / 1"), {
    spaceName: "chrome-plugin-gemini",
    tabName: "1",
  });

  const makeHerdrAgent = (over: Partial<IndexedAgent> & { address: string }): IndexedAgent => ({
    id: `herdr-${over.address}`,
    provider: "Grok CLI",
    state: over.state ?? "working",
    sources: ["Herdr"],
    workspace: over.workspace ?? "/Users/penglei/developer/chrome-plugin-gemini",
    repository: null,
    updatedAt: null,
    label: `Grok CLI · ${over.address}`,
    title: over.title ?? "Main task",
    what: null,
    taskWhat: null,
    originTrack: over.originTrack ?? "founder_managed",
    herdr: {
      address: over.address,
      name: over.herdr?.name ?? null,
      parent: over.herdr?.parent ?? null,
      where: over.herdr?.where ?? "chrome-plugin-gemini / 1",
      spaceName: over.herdr?.spaceName ?? "chrome-plugin-gemini",
      tabName: over.herdr?.tabName ?? "1",
      labels: over.herdr?.labels ?? {},
      isSubAgent: Boolean(over.herdr?.parent),
      isBackground: Boolean(over.herdr?.isBackground),
    },
  });

  const { trees, background } = buildHerdrTrees([
    makeHerdrAgent({ address: "t99", state: "working", title: "Review stopped workflow" }),
    makeHerdrAgent({
      address: "t10m",
      state: "idle",
      herdr: { address: "t10m", name: "s3", parent: "t99", where: "chrome-plugin-gemini / 1", spaceName: "chrome-plugin-gemini", tabName: "1", labels: {}, isSubAgent: true, isBackground: false },
    }),
    makeHerdrAgent({
      address: "t1c",
      state: "idle",
      herdr: { address: "t1c", name: "learn-graph", parent: null, where: null, spaceName: null, tabName: null, labels: {}, isSubAgent: false, isBackground: true },
    }),
  ]);

  assert.equal(trees.length, 1);
  assert.equal(trees[0].address, "t99");
  assert.equal(trees[0].subAgents.length, 1);
  assert.equal(trees[0].subAgents[0].herdr?.address, "t10m");
  assert.equal(background.length, 1);
  assert.equal(background[0].herdr?.address, "t1c");
});

test("CliLedger 1-to-1 live Herdr matching marks active Grok sessions running without polluting historical sessions", (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "opc-cli-live-herdr-"));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const nowMs = Date.parse("2026-11-25T04:00:00.000Z");

  const writeGrokSession = (id: string, cwd: string, title: string, minsAgo: number) => {
    const dir = join(homeDir, ".grok", "sessions", "cwd-bucket", id);
    mkdirSync(dir, { recursive: true });
    const ts = new Date(nowMs - minsAgo * 60_000).toISOString();
    const summaryPath = join(dir, "summary.json");
    writeFileSync(
      summaryPath,
      JSON.stringify({
        info: { id, cwd },
        generated_title: title,
        created_at: ts,
        updated_at: ts,
      }),
    );
    const updatesPath = join(dir, "updates.jsonl");
    writeFileSync(
      updatesPath,
      [
        JSON.stringify({ timestamp: ts, update: { sessionUpdate: "user_message_chunk", content: title } }),
        JSON.stringify({ timestamp: ts, update: { sessionUpdate: "agent_message_chunk", content: "已完成首轮处理，继续验证中。" } }),
        JSON.stringify({ timestamp: ts, update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } }),
      ].join("\n"),
    );
    const m = new Date(nowMs - minsAgo * 60_000);
    utimesSync(summaryPath, m, m);
    utimesSync(updatesPath, m, m);
  };

  // Two sessions in the SAME repo: one is live in Herdr t99 (updated 8 mins ago), one is older completed
  writeGrokSession("s-live-1", "/Users/tester/developer/chrome-plugin-gemini", "Review stopped background workflow reminder", 8);
  writeGrokSession("s-hist-2", "/Users/tester/developer/chrome-plugin-gemini", "Old completed CSS tweak", 240);
  // One session in homeDir, live in Herdr t90 (Space: ai-agent-node)
  writeGrokSession("s-home-3", homeDir, "ai-agent-node 面试自学包与演示服务", 6);
  // One session in a Herdr split-task worktree
  writeGrokSession("s-wt-4", join(homeDir, ".herdr/split-tasks/chrome-plugin-gemini/t99/wt-s3"), "只整理旁注菜单的展示", 10);

  const ledger = new CliLedgerService({
    homeDir,
    now: () => nowMs,
    hooks: {
      getLiveSessions: () => [
        {
          provider: "Grok CLI",
          workspace: "/Users/tester/developer/chrome-plugin-gemini",
          state: "working",
          updatedAt: null,
          address: "t99",
          title: "⠸ - Thinking - Review stopped background workflow remi…",
          spaceName: "chrome-plugin-gemini",
          originTrack: "founder_managed",
        },
        {
          provider: "Grok CLI",
          workspace: homeDir,
          state: "working",
          updatedAt: null,
          address: "t90",
          title: "⠹ - Thinking - ai-agent-node 面试自学包与演示服务",
          spaceName: "ai-agent-node",
          originTrack: "founder_managed",
        },
      ],
    },
  });

  const ov: CliLedgerOverview = ledger.getOverview({ days: 3, refresh: true });
  const live1 = ov.sessions.find((s) => s.rawSessionId === "s-live-1");
  const hist2 = ov.sessions.find((s) => s.rawSessionId === "s-hist-2");
  const home3 = ov.sessions.find((s) => s.rawSessionId === "s-home-3");
  const wt4 = ov.sessions.find((s) => s.rawSessionId === "s-wt-4");

  assert.equal(live1?.status, "running");
  assert.equal(live1?.herdrAddress, "t99");
  assert.equal(hist2?.status, "completed");
  assert.equal(hist2?.herdrAddress, null);
  assert.equal(home3?.status, "running");
  assert.equal(home3?.herdrAddress, "t90");
  assert.equal(home3?.project, "ai-agent-node");
  assert.equal(wt4?.project, "chrome-plugin-gemini");
  // No fake "wt-s3" project in breakdown!
  assert.ok(!ov.byProject.some((p) => p.project === "wt-s3"));
});

test("HTTP integration: classifications, promote-herdr, bind-task, continuous sync, and /api/opc/workstreams", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opc-dual-track-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = openStore(join(dir, "test.db"));
  t.after(() => store.db.close());
  const { app } = createApp(store, { activityIndexEnabled: false });

  const cookie = (await app.request("/api/me")).headers.get("set-cookie")!.split(";")[0];
  const headers = { cookie, "Content-Type": "application/json" };

  // 1. Classification API upsert & list
  const saveCat = await app.request("/api/opc/classifications", {
    method: "POST",
    headers,
    body: JSON.stringify({
      key: "proj:stock-research",
      category: "personal",
      groupName: "个人投研",
      canonicalProject: "stock-research",
    }),
  });
  assert.equal(saveCat.status, 200);

  const listCat = await app.request("/api/opc/classifications", { headers: { cookie } });
  assert.equal(listCat.status, 200);
  const catData = (await listCat.json()) as { overrides: Array<{ key: string; groupName: string }> };
  assert.ok(catData.overrides.some((o) => o.key === "proj:stock-research" && o.groupName === "个人投研"));

  // 2. Promote Herdr session to planning task (idempotent on second call)
  const p1 = await app.request("/api/opc/planning/promote-herdr", {
    method: "POST",
    headers,
    body: JSON.stringify({
      herdrAddress: "t99",
      project: "chrome-plugin-gemini",
      provider: "Grok CLI",
      title: "修复侧边栏菜单展示",
      herdrSpace: "chrome-plugin-gemini",
      workspace: "/Users/tester/developer/chrome-plugin-gemini",
      liveStatus: "running",
      originTrack: "founder_managed",
    }),
  });
  assert.equal(p1.status, 201);
  const promoted1 = (await p1.json()) as { taskId: string; alreadyLinked: boolean };
  assert.equal(promoted1.alreadyLinked, false);

  const p2 = await app.request("/api/opc/planning/promote-herdr", {
    method: "POST",
    headers,
    body: JSON.stringify({
      herdrAddress: "t99",
      project: "chrome-plugin-gemini",
      provider: "Grok CLI",
      title: "修复侧边栏菜单展示",
      liveStatus: "waiting_user",
      latestProgress: "等待确认按钮文案",
    }),
  });
  assert.equal(p2.status, 200);
  const promoted2 = (await p2.json()) as { taskId: string; alreadyLinked: boolean };
  assert.equal(promoted2.taskId, promoted1.taskId);
  assert.equal(promoted2.alreadyLinked, true);

  // Verify synced task carries originTrack + externalSession + classification
  const taskRes = await app.request(`/api/opc/planning/tasks/${encodeURIComponent(promoted1.taskId)}`, {
    headers: { cookie },
  });
  assert.equal(taskRes.status, 200);
  const task = (await taskRes.json()) as {
    originTrack: string;
    externalSession: { herdrAddress: string; liveStatus: string; latestProgress: string };
    classification: { category: string };
  };
  assert.equal(task.originTrack, "founder_managed");
  assert.equal(task.externalSession.herdrAddress, "t99");
  assert.equal(task.externalSession.liveStatus, "waiting_user");
  assert.equal(task.externalSession.latestProgress, "等待确认按钮文案");
  assert.equal(task.classification.category, "personal");

  // 3. Workstreams endpoint responds cleanly
  const wsRes = await app.request("/api/opc/workstreams", { headers: { cookie } });
  assert.equal(wsRes.status, 200);
  const ws = (await wsRes.json()) as WorkstreamsOverview;
  assert.ok(Array.isArray(ws.herdrTrees));
  assert.ok(Array.isArray(ws.summary.byCategory));
  assert.equal(ws.summary.byCategory.length, 3);
});

test("resolveProjectHerdrSpace reuses matching existing project Space instead of creating throwaway hex Space", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "opc-space-router-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const mockHerdrApp = join(dir, "mock-herdr-app");
  writeFileSync(
    mockHerdrApp,
    `#!${process.execPath}
process.stdout.write(JSON.stringify({
  spaces: [
    { id: "sp-existing-chatroom", name: "agent-chatroom", folder: "/Users/tester/developer/ai-github/agent-chatroom" },
    { id: "sp-existing-chrome", name: "chrome-plugin-gemini", folder: "/Users/tester" }
  ]
}));`,
    { mode: 0o755 },
  );

  // Match by folder
  const byFolder = await resolveProjectHerdrSpace({
    workspace: "/Users/tester/developer/ai-github/agent-chatroom/data/factory-worktrees/run_1234",
    project: "opc-os",
    fallbackSpaceId: "spfallback",
    fallbackSpaceName: "OPC OS · fallback",
    herdrApp: mockHerdrApp,
  });
  assert.equal(byFolder.reused, true);
  assert.equal(byFolder.spaceId, "sp-existing-chatroom");

  // Match by Space name when folder is ~
  const byName = await resolveProjectHerdrSpace({
    workspace: "/Users/tester/.herdr/split-tasks/chrome-plugin-gemini/t99/wt-s3",
    project: "chrome-plugin-gemini",
    fallbackSpaceId: "spfallback",
    fallbackSpaceName: "OPC OS · fallback",
    herdrApp: mockHerdrApp,
  });
  assert.equal(byName.reused, true);
  assert.equal(byName.spaceId, "sp-existing-chrome");

  // Unmatched project gets clean project-named Space (not random hex)
  const fresh = await resolveProjectHerdrSpace({
    workspace: "/Users/tester/developer/password-one",
    project: "Password One/password-one",
    fallbackSpaceId: "spfallback",
    fallbackSpaceName: "OPC OS · fallback",
    herdrApp: mockHerdrApp,
  });
  assert.equal(fresh.reused, false);
  assert.equal(fresh.spaceName, "OPC OS · password-one");
});

test("P2 HerdrController focus, send blocked-guard, screen redaction, and HTTP auth", async (t) => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const statuses: Record<string, { state: string; status: string }> = {
    t90: { state: "live", status: "waiting" },
    t94: { state: "live", status: "blocked" },
    t99: { state: "exited", status: "done" },
    "ubuntu1/t3": { state: "live", status: "idle" },
  };

  const ctrl = new HerdrController({
    hcBin: "mock-hc",
    herdrAppBin: "mock-herdr-app",
    execFn: async (file, args) => {
      calls.push({ file, args });
      if (file === "mock-herdr-app" && args[1] === "agent.focus") {
        if (args[3] === "ubuntu1/t3") throw new Error("not an agent");
        return { stdout: "{}", stderr: "" };
      }
      if (file === "mock-herdr-app" && args[1] === "pane.focus") {
        return { stdout: "{}", stderr: "" };
      }
      if (file === "mock-hc" && args[0] === "get") {
        const addr = args[2];
        const info = statuses[addr];
        if (!info) throw new Error("not found");
        return { stdout: JSON.stringify(info), stderr: "" };
      }
      if (file === "mock-hc" && args[0] === "send") {
        assert.ok(!args.includes("--force"), "must NEVER pass --force to hc send");
        return { stdout: "ok", stderr: "" };
      }
      if (file === "mock-hc" && args[0] === "screen") {
        return {
          stdout: "line 1\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nWaiting for reply?\n\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected call ${file} ${args.join(" ")}`);
    },
  });

  // Focus succeeds with agent.focus, and falls back to pane.focus for non-agent terminals
  const f1 = await ctrl.focusTerminal("t90");
  assert.equal(f1.command, "agent.focus");
  const f2 = await ctrl.focusTerminal("ubuntu1/t3");
  assert.equal(f2.command, "pane.focus");

  // Send succeeds on live waiting terminal and never passes --force
  const s1 = await ctrl.sendInstruction("t90", "继续执行测试");
  assert.equal(s1.ok, true);
  assert.equal(s1.previousStatus, "waiting");

  // Blocked terminal is strictly rejected with 409 terminal_blocked
  await assert.rejects(
    ctrl.sendInstruction("t94", "yes"),
    (err: { status?: number; code?: string }) => err.status === 409 && err.code === "terminal_blocked",
  );

  // Exited terminal is rejected with 409 terminal_not_live
  await assert.rejects(
    ctrl.sendInstruction("t99", "ping"),
    (err: { status?: number; code?: string }) => err.status === 409 && err.code === "terminal_not_live",
  );

  // Invalid address is rejected with 400
  await assert.rejects(
    ctrl.focusTerminal("; rm -rf /"),
    (err: { status?: number; code?: string }) => err.status === 400 && err.code === "invalid_herdr_address",
  );

  // Screen tail redacts secrets
  const scr = await ctrl.readScreenTail("t90", 10);
  assert.equal(scr.lines.length, 3);
  assert.doesNotMatch(scr.lines.join("\n"), /sk-abc/);
  assert.match(scr.lines[1], /\[REDACTED\]/);
  assert.match(redactScreenLine("bearer: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaaa.bbbbbb"), /\[REDACTED\]/);

  // HTTP routes enforce human session authentication (401 without session)
  const dir = mkdtempSync(join(tmpdir(), "opc-herdr-ctrl-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, "test.db"));
  t.after(() => store.db.close());
  const { app } = createApp(store, { activityIndexEnabled: false });
  assert.equal(
    (await app.request("/api/opc/herdr/focus", { method: "POST", body: JSON.stringify({ address: "t90" }) })).status,
    401,
  );
  const cookie = (await app.request("/api/me")).headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (
      await app.request("/api/opc/herdr/focus", {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ address: "../bad" }),
      })
    ).status,
    400,
  );

  // Isolated route test with mocked runner
  const isolated = new Hono();
  registerHerdrControlRoutes(isolated, () => ({ id: "human" }), {
    hcBin: "mock-hc",
    herdrAppBin: "mock-herdr-app",
    execFn: async (file, args) => {
      if (file === "mock-herdr-app") return { stdout: "{}", stderr: "" };
      if (args[0] === "get") return { stdout: JSON.stringify({ state: "live", status: "waiting" }), stderr: "" };
      return { stdout: "ok", stderr: "" };
    },
  });
  const okFocus = await isolated.request("/api/opc/herdr/focus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: "ubuntu1/t3" }),
  });
  assert.equal(okFocus.status, 200);
});

test("P2 buildAttentionItems unifies blocked/waiting Herdr + recent CLI items, deduplicates, and ignores stale CLI", () => {
  const nowMs = Date.parse("2026-11-25T06:00:00.000Z");
  const blockedHerdr: IndexedAgent = {
    id: "herdr-t94",
    provider: "Antigravity",
    state: "waiting",
    sources: ["Herdr"],
    workspace: "/Users/tester/ppeng-agent-core",
    repository: null,
    updatedAt: null,
    label: "Antigravity · t94",
    title: "构建代码库速通 skill",
    what: null,
    taskWhat: null,
    originTrack: "founder_managed",
    linkedSessionId: "agy:s1",
    herdr: {
      address: "t94",
      name: null,
      parent: null,
      where: "ppeng-agent-core / 1",
      spaceName: "ppeng-agent-core",
      tabName: "1",
      labels: {},
      isSubAgent: false,
      isBackground: false,
      rawStatus: "blocked",
      machine: null,
      remoteCwd: null,
    },
  };
  const remoteWaiting: IndexedAgent = {
    ...blockedHerdr,
    id: "herdr-ubuntu1-t3",
    workspace: null,
    label: "Codex · ubuntu1/t3",
    title: "远端 GPU 训练脚本待确认",
    linkedSessionId: null,
    herdr: {
      ...blockedHerdr.herdr!,
      address: "ubuntu1/t3",
      rawStatus: "waiting",
      machine: "ubuntu1",
      remoteCwd: "/home/ubuntu/trainer",
    },
  };
  const makeCli = (over: Partial<CliSessionSummary>): CliSessionSummary => ({
    id: over.id ?? "cli-1",
    rawSessionId: over.rawSessionId ?? "r1",
    providerId: "codex",
    provider: "Codex",
    project: over.project ?? "agent-chatroom",
    workspace: "/Users/tester/agent-chatroom",
    repository: null,
    branch: "main",
    model: null,
    title: over.title ?? "CLI session",
    firstInstruction: "first",
    latestInstruction: "latest",
    latestProgress: over.latestProgress ?? "等待确认部署方案",
    status: over.status ?? "waiting_user",
    statusReason: "wait",
    progressStage: "implementing",
    progressPct: 60,
    startedAt: new Date(nowMs - 30 * 60_000).toISOString(),
    updatedAt: over.updatedAt ?? new Date(nowMs - 20 * 60_000).toISOString(),
    durationMins: 10,
    stats: {
      totalTurns: 2,
      instructionCount: 1,
      totalToolCalls: 4,
      filesModifiedCount: 1,
      filesTouched: [],
      commandsRun: 0,
      tokensTotal: 100,
    },
    recentTurnsPreview: [],
    sourcePath: "/tmp/session.jsonl",
    herdrAddress: over.herdrAddress ?? null,
    originTrack: over.originTrack ?? "founder_managed",
  });

  const items = buildAttentionItems({
    localAgents: [blockedHerdr],
    remoteAgents: [remoteWaiting],
    cliSessions: [
      makeCli({ id: "agy:s1", herdrAddress: "t94", status: "blocked", title: "duplicate of t94" }),
      makeCli({ id: "cli-fresh", status: "waiting_user", title: "等待确认 PR 合入", updatedAt: new Date(nowMs - 30 * 60_000).toISOString() }),
      makeCli({ id: "cli-stale", status: "blocked", title: "两天前的历史阻塞", updatedAt: new Date(nowMs - 36 * 3600_000).toISOString() }),
    ],
    nowMs,
  });

  assert.equal(items.length, 3);
  assert.equal(items[0].id, "herdr:t94");
  assert.equal(items[0].severity, "blocked");
  assert.equal(items[0].isBlockedPermission, true);
  assert.equal(items[1].id, "herdr:ubuntu1/t3");
  assert.equal(items[1].machine, "ubuntu1");
  assert.equal(items[2].id, "cli:cli-fresh");
});

test("P2 remote Herdr terminals and machines stay isolated from localWorkspaces, and Hub circuit breaker degrades fast", async (t) => {
  const machines = parseHerdrMachinesOutput(
    "ubuntu1          connected  ubuntu1 · hc 0.1.17\nubuntu2          connected  ubuntu2 · hc 0.1.17\n{\"terminals\":[]}\n",
  );
  assert.deepEqual(machines, [
    { name: "ubuntu1", status: "connected", detail: "ubuntu1 · hc 0.1.17" },
    { name: "ubuntu2", status: "connected", detail: "ubuntu2 · hc 0.1.17" },
  ]);

  const view = await readAgentIndex({
    hub: async () => ({ running: { at: "2026-11-25T05:00:00Z", window_min: 5, items: [], errors: [] } }),
    herdr: async () => ({
      machines,
      terminals: [
        { address: "t1", agent: "grok", cwd: "/tmp/local-proj", state: "live", status: "working" },
        { address: "ubuntu1/t3", agent: "codex", cwd: "/home/ubuntu/gpu-repo", state: "live", status: "blocked", where: "gpu / 1" },
      ],
    }),
    processes: async () => ({ rows: [], missingDirectories: false }),
  });

  // Local agents & localWorkspaces strictly exclude remote terminals
  assert.equal(view.agents.length, 1);
  assert.equal(view.agents[0].herdr?.address, "t1");
  assert.deepEqual(view.localWorkspaces, ["/tmp/local-proj"]);

  // Remote terminals & connected machines are surfaced cleanly
  assert.equal(view.remoteMachines?.length, 2);
  assert.equal(view.remoteAgents?.length, 1);
  assert.equal(view.remoteAgents?.[0].herdr?.address, "ubuntu1/t3");
  assert.equal(view.remoteAgents?.[0].herdr?.machine, "ubuntu1");
  assert.equal(view.remoteAgents?.[0].herdr?.rawStatus, "blocked");
  assert.equal(view.remoteAgents?.[0].herdr?.remoteCwd, "/home/ubuntu/gpu-repo");
  assert.equal(view.remoteAgents?.[0].workspace, null);

  // Hub circuit breaker opens after failure and short-circuits subsequent call immediately
  const prevHubUrl = process.env.OPC_HUB_URL;
  process.env.OPC_HUB_URL = "http://127.0.0.1:1";
  resetHubCircuitBreaker();
  t.after(() => {
    resetHubCircuitBreaker();
    if (prevHubUrl === undefined) delete process.env.OPC_HUB_URL;
    else process.env.OPC_HUB_URL = prevHubUrl;
  });

  const first = await readAgentIndex({
    herdr: async () => ({ terminals: [] }),
    processes: async () => ({ rows: [], missingDirectories: false }),
  });
  assert.equal(first.sources.find((s) => s.name === "Agent Hub")?.status, "unavailable");
  assert.equal(getHubCircuitBreakerState().open, true);

  const t0 = Date.now();
  const second = await readAgentIndex({
    herdr: async () => ({ terminals: [] }),
    processes: async () => ({ rows: [], missingDirectories: false }),
  });
  assert.ok(Date.now() - t0 < 200, "second call should short-circuit immediately while circuit is open");
  assert.match(second.sources.find((s) => s.name === "Agent Hub")?.detail ?? "", /冷却 60s/);
});
