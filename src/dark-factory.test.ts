import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { AgentRecord, AgentRunRecord, DarkFactoryOverview, RunLogsResponse } from "./dark-factory-types.ts";
import {
  AGENT_PRESETS,
  buildSandboxEnv,
  DarkFactoryStore,
  matchProtectedPaths,
  parseUsageFromLine,
  registerDarkFactoryRoutes,
  renderPromptTemplate,
  splitCommandArgs,
} from "./server/dark-factory.ts";
import { ApiError } from "./server/logic.ts";
import { ProvidersStore } from "./server/providers.ts";
import { TaskPlanningStore } from "./server/task-planning.ts";

function createTestEnv(prefix = "opc-df-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const logDir = join(root, "logs");
  const worktreeBase = join(root, "worktrees");
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  providers.update({
    system: {
      maxConcurrentAgents: 3,
      agentLogDir: logDir,
      protectedPaths: [
        "src/server/workflow/",
        "src/server/dark-factory.ts",
        "src/server/providers.ts",
      ],
    },
  });
  const store = new DarkFactoryStore(db, providers, {
    worktreeBase,
    defaultRepoRoot: root,
  });

  const cleanup = async () => {
    await store.dispose();
    try {
      db.close();
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  };

  return { root, logDir, worktreeBase, db, providers, store, cleanup };
}

function createTempGitRepo(parentDir: string, name = "repo"): string {
  const repoDir = join(parentDir, name);
  mkdirSync(join(repoDir, "src", "server"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
  writeFileSync(join(repoDir, "src", "server", "providers.ts"), "export const v = 1;\n", "utf8");

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Bot"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@opc.local"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir, stdio: "ignore" });
  return repoDir;
}

test("1. Agent Registry CRUD, presets, disabled guard, and pure sandbox/template helpers", async () => {
  const env = createTestEnv("opc-df-crud-");
  try {
    assert.ok(AGENT_PRESETS.length >= 6);
    assert.ok(AGENT_PRESETS.some((p) => p.key === "claude-code"));
    assert.ok(AGENT_PRESETS.some((p) => p.key === "codex-cli"));
    assert.ok(AGENT_PRESETS.some((p) => p.key === "local-node-script"));

    // Pure helper checks
    assert.deepEqual(splitCommandArgs(`node -e "console.log('a b')" --flag`), [
      "node",
      "-e",
      "console.log('a b')",
      "--flag",
    ]);
    const rendered = renderPromptTemplate("{{task.id}}|{{task.title}}|{{task.description}}|{{worktree_path}}|{{branch_name}}", {
      taskId: "T-1",
      taskTitle: "Fix bug",
      taskDescription: "Details",
      worktreePath: "/tmp/wt",
      branchName: "agent/a/1234",
    });
    assert.equal(rendered, "T-1|Fix bug|Details|/tmp/wt|agent/a/1234");

    const sanitized = buildSandboxEnv({
      taskId: "T-1",
      runId: "run_1",
      worktreePath: "/tmp/wt",
      baseEnv: {
        PATH: "/usr/bin",
        AWS_ACCESS_KEY_ID: "AKIA_SECRET",
        AWS_SECRET_ACCESS_KEY: "SECRET",
        WORKFLOW_SUBMIT_TOKEN: "tok_secret_12345678901234567890",
        OPENAI_API_KEY: "sk-should-be-stripped",
      },
    });
    assert.equal(sanitized.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(sanitized.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(sanitized.WORKFLOW_SUBMIT_TOKEN, undefined);
    assert.equal(sanitized.OPENAI_API_KEY, undefined);
    assert.equal(sanitized.OPC_SANDBOX, "1");
    assert.equal(sanitized.HFLOW_WORKER, "1");
    assert.equal(sanitized.OPC_TASK_ID, "T-1");

    const withExplicitKey = buildSandboxEnv({
      taskId: "T-1",
      runId: "run_1",
      worktreePath: "/tmp/wt",
      baseEnv: { OPENAI_API_KEY: "sk-stripped" },
      explicitEnv: { OPENAI_API_KEY: "sk-explicit-allowed" },
    });
    assert.equal(withExplicitKey.OPENAI_API_KEY, "sk-explicit-allowed");

    assert.deepEqual(
      matchProtectedPaths(
        ["src/app.ts", "src/server/providers.ts", "src/server/workflow/http.ts", ".sandboxrc"],
        ["src/server/workflow/", "src/server/providers.ts"],
      ),
      ["src/server/providers.ts", "src/server/workflow/http.ts"],
    );

    assert.deepEqual(parseUsageFromLine("total_tokens: 4200 cost_usd: $0.125"), {
      totalTokens: 4200,
      costUsd: 0.125,
    });

    // CRUD lifecycle
    const created = env.store.createAgent({
      name: "runner-alpha",
      description: "Smoke test runner",
      cliCommand: `node -e "console.log('ok')"`,
      capabilities: ["test", "smoke"],
      maxCostPerTask: 2.5,
      maxDurationSecs: 60,
      maxRetries: 2,
    });
    assert.equal(created.name, "runner-alpha");
    assert.equal(created.status, "idle");
    assert.equal(env.store.listAgents().length, 1);

    // Duplicate name rejected
    assert.throws(
      () => env.store.createAgent({ name: "runner-alpha", cliCommand: "node -e 1" }),
      (err: unknown) => err instanceof ApiError && err.status === 409,
    );

    // Update to disabled -> dispatch rejected
    const disabled = env.store.updateAgent(created.id, { status: "disabled", maxRetries: 4 });
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.maxRetries, 4);

    assert.throws(
      () =>
        env.store.dispatch({
          taskId: "T-DISABLED",
          taskTitle: "Should fail",
          agentId: created.id,
        }),
      (err: unknown) => err instanceof ApiError && err.code === "agent_disabled",
    );

    // Delete
    const del = env.store.deleteAgent(created.id);
    assert.equal(del.deleted, true);
    assert.equal(env.store.listAgents().length, 0);
  } finally {
    await env.cleanup();
  }
});

test("2. Concurrency queue enforces maxConcurrentAgents=1 with FIFO serial execution", async () => {
  const env = createTestEnv("opc-df-queue-");
  try {
    env.providers.update({ system: { maxConcurrentAgents: 1, agentLogDir: env.logDir } });
    const traceFile = join(env.root, "trace.jsonl");

    const script = [
      `const fs = require('fs');`,
      `const id = process.env.OPC_TASK_ID;`,
      `fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ id, ev: 'start', t: Date.now() }) + '\\n');`,
      `setTimeout(() => {`,
      `  fs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ id, ev: 'end', t: Date.now() }) + '\\n');`,
      `  console.log('done ' + id);`,
      `}, 220);`,
    ].join(" ");

    const agent = env.store.createAgent({
      name: "serial-worker",
      cliCommand: `node -e ${JSON.stringify(script)}`,
    });

    const run1 = env.store.dispatch({
      taskId: "Q-1",
      taskTitle: "Queued Task 1",
      project: "alpha",
      agentId: agent.id,
    });
    const secondTask = {
      taskId: "Q-2",
      taskTitle: "Queued Task 2",
      project: "alpha",
      agentId: agent.id,
    };
    const approvalKey = "07459fe1-9347-4101-968d-a2bcf7cb7f57";
    const run2 = env.store.dispatch(secondTask, approvalKey);
    assert.equal(env.store.dispatch(secondTask, approvalKey).id, run2.id);
    assert.throws(() => env.store.dispatch({ ...secondTask, taskId: "other-task" }, approvalKey), { code: "dispatch_conflict" });

    assert.equal(run1.status, "running");
    assert.equal(run2.status, "queued");

    const [done1, done2] = await Promise.all([
      env.store.waitForRun(run1.id, 10_000),
      env.store.waitForRun(run2.id, 10_000),
    ]);

    assert.equal(done1.status, "completed");
    assert.equal(done2.status, "completed");

    const events = readFileSync(traceFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { id: string; ev: string; t: number });
    assert.deepEqual(
      events.map((e) => `${e.id}:${e.ev}`),
      ["Q-1:start", "Q-1:end", "Q-2:start", "Q-2:end"],
    );
  } finally {
    await env.cleanup();
  }
});

test("3. Real Git Worktree isolation: commit completion vs accurate no_output detection", async () => {
  const env = createTestEnv("opc-df-git-");
  try {
    const repoDir = createTempGitRepo(env.root);

    // Agent A: writes a real file and commits it inside the isolated worktree
    const commitScript = [
      `const fs = require('fs');`,
      `const { execFileSync } = require('child_process');`,
      `fs.writeFileSync('feature.txt', 'hello from ' + process.env.OPC_TASK_ID + '\\n');`,
      `execFileSync('git', ['add', 'feature.txt']);`,
      `execFileSync('git', ['commit', '-m', 'feat: add feature.txt']);`,
      `console.log('total_tokens: 2400 cost_usd: 0.015');`,
    ].join(" ");

    const commitAgent = env.store.createAgent({
      name: "Git Committer",
      cliCommand: `node -e ${JSON.stringify(commitScript)}`,
    });

    const commitRun = env.store.dispatch({
      taskId: "GIT-1",
      taskTitle: "Add feature file",
      project: "pagelens",
      repoPath: repoDir,
      agentId: commitAgent.id,
    });

    const finishedCommit = await env.store.waitForRun(commitRun.id, 10_000);
    assert.equal(finishedCommit.status, "completed");
    assert.ok(finishedCommit.worktreePath && existsSync(finishedCommit.worktreePath));
    assert.ok(existsSync(join(finishedCommit.worktreePath, ".sandboxrc")));
    assert.ok(finishedCommit.branchName?.startsWith("agent/git-committer/"));
    assert.deepEqual(finishedCommit.changedFiles, ["feature.txt"]);
    assert.equal(finishedCommit.tokenUsed, 2400);
    assert.equal(finishedCommit.costUsd, 0.015);
    // Original repo must remain untouched
    assert.equal(existsSync(join(repoDir, "feature.txt")), false);

    // Agent B: exits 0 with zero changes & zero commits -> must be marked no_output
    const noopAgent = env.store.createAgent({
      name: "Noop Worker",
      cliCommand: `node -e "console.log('finished thinking, changed nothing')"`,
    });

    const noopRun = env.store.dispatch({
      taskId: "GIT-2",
      taskTitle: "Do nothing task",
      project: "pagelens",
      repoPath: repoDir,
      agentId: noopAgent.id,
    });

    const finishedNoop = await env.store.waitForRun(noopRun.id, 10_000);
    assert.equal(finishedNoop.status, "no_output");
    assert.deepEqual(finishedNoop.changedFiles, []);
  } finally {
    await env.cleanup();
  }
});

test("4. Duration watchdog (duration_limit_exceeded) and stderr dead-loop breaker (dead_loop_detected)", async () => {
  const env = createTestEnv("opc-df-breakers-");
  try {
    // 4A. Duration watchdog
    const slowAgent = env.store.createAgent({
      name: "slow-sleeper",
      cliCommand: `node -e "console.log('starting long work'); setTimeout(() => console.log('late'), 15000);"`,
      maxDurationSecs: 0.3,
    });

    const slowRun = env.store.dispatch({
      taskId: "TIMEOUT-1",
      taskTitle: "Should timeout quickly",
      agentId: slowAgent.id,
    });

    const timedOut = await env.store.waitForRun(slowRun.id, 5_000);
    assert.equal(timedOut.status, "failed");
    assert.equal(timedOut.circuitBreakerReason, "duration_limit_exceeded");

    // 4B. Dead-loop stderr detection
    const loopScript = [
      `let n = 0;`,
      `const t = setInterval(() => {`,
      `  n++;`,
      `  console.error('TypeError: failing attempt #' + n);`,
      `  if (n >= 10) clearInterval(t);`,
      `}, 40);`,
    ].join(" ");

    const loopAgent = env.store.createAgent({
      name: "dead-loop-bot",
      cliCommand: `node -e ${JSON.stringify(loopScript)}`,
      maxRetries: 3,
      maxDurationSecs: 30,
    });

    const loopRun = env.store.dispatch({
      taskId: "LOOP-1",
      taskTitle: "Should hit dead-loop breaker",
      agentId: loopAgent.id,
    });

    const deadLooped = await env.store.waitForRun(loopRun.id, 5_000);
    assert.equal(deadLooped.status, "failed");
    assert.equal(deadLooped.circuitBreakerReason, "dead_loop_detected");
    assert.ok(deadLooped.retryCount >= 3);
  } finally {
    await env.cleanup();
  }
});

test("5. Token & cost circuit breaker kills runaway spending (cost_limit_exceeded)", async () => {
  const env = createTestEnv("opc-df-cost-");
  try {
    // 5A. Explicit cost_usd over limit
    const priceyScript = `console.log('total_tokens: 80000 cost_usd: $0.45'); setTimeout(() => {}, 10000);`;
    const priceyAgent = env.store.createAgent({
      name: "pricey-bot",
      cliCommand: `node -e ${JSON.stringify(priceyScript)}`,
      maxCostPerTask: 0.1,
      maxDurationSecs: 30,
    });

    const runA = env.store.dispatch({
      taskId: "COST-1",
      taskTitle: "Explicit cost overrun",
      agentId: priceyAgent.id,
    });
    const resA = await env.store.waitForRun(runA.id, 5_000);
    assert.equal(resA.status, "failed");
    assert.equal(resA.circuitBreakerReason, "cost_limit_exceeded");
    assert.equal(resA.tokenUsed, 80000);
    assert.equal(resA.costUsd, 0.45);

    // 5B. Estimated cost from tokens alone without cost_usd
    const tokenOnlyScript = `console.log('tokens: 50000'); setTimeout(() => {}, 10000);`;
    const tokenAgent = env.store.createAgent({
      name: "token-estimator-bot",
      cliCommand: `node -e ${JSON.stringify(tokenOnlyScript)}`,
      maxCostPerTask: 0.05, // 50k tokens @ $5/1M = $0.25 > $0.05
      maxDurationSecs: 30,
    });

    const runB = env.store.dispatch({
      taskId: "COST-2",
      taskTitle: "Estimated cost overrun",
      agentId: tokenAgent.id,
    });
    const resB = await env.store.waitForRun(runB.id, 5_000);
    assert.equal(resB.status, "failed");
    assert.equal(resB.circuitBreakerReason, "cost_limit_exceeded");
    assert.equal(resB.tokenUsed, 50000);
    assert.ok(resB.costUsd > 0.05);
  } finally {
    await env.cleanup();
  }
});

test("6. Self-bootstrap protected paths block auto/manual PR and record audit results", async () => {
  const env = createTestEnv("opc-df-bootstrap-");
  try {
    const repoDir = createTempGitRepo(env.root);

    const tamperScript = [
      `const fs = require('fs');`,
      `const { execFileSync } = require('child_process');`,
      `fs.appendFileSync('src/server/providers.ts', '// unauthorized edit\\n');`,
      `execFileSync('git', ['add', 'src/server/providers.ts']);`,
      `execFileSync('git', ['commit', '-m', 'chore: tamper providers']);`,
    ].join(" ");

    const tamperAgent = env.store.createAgent({
      name: "tamper-bot",
      cliCommand: `node -e ${JSON.stringify(tamperScript)}`,
    });

    const run = env.store.dispatch({
      taskId: "SEC-1",
      taskTitle: "Attempt protected path edit",
      project: "opc-os",
      repoPath: repoDir,
      agentId: tamperAgent.id,
      autoCreatePr: true,
    });

    const blocked = await env.store.waitForRun(run.id, 10_000);
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.circuitBreakerReason, "protected_path_violation");
    assert.deepEqual(blocked.protectedViolations, ["src/server/providers.ts"]);
    assert.equal(blocked.prUrl, null);

    // Manual PR creation must also be rejected with 403
    await assert.rejects(
      () => env.store.createPrForRun(blocked.id),
      (err: unknown) => err instanceof ApiError && err.status === 403 && err.code === "protected_path_violation",
    );

    // Self-bootstrap audit on clean repo -> passed
    const cleanAudit = await env.store.runSelfBootstrapAudit(repoDir);
    assert.equal(cleanAudit.status, "passed");
    assert.equal(cleanAudit.details.violations.length, 0);

    // Modify protected file in repo working tree -> audit returns blocked
    writeFileSync(join(repoDir, "src", "server", "providers.ts"), "export const v = 999;\n", "utf8");
    const dirtyAudit = await env.store.runSelfBootstrapAudit(repoDir);
    assert.equal(dirtyAudit.status, "blocked");
    assert.deepEqual(dirtyAudit.details.violations, ["src/server/providers.ts"]);
    assert.equal(env.store.listAudits().length, 2);
  } finally {
    await env.cleanup();
  }
});

test("7. In-flight killRun, persistent logs replay, retryRun, worktree cleanup, and metrics", async () => {
  const env = createTestEnv("opc-df-ops-");
  try {
    const repoDir = createTempGitRepo(env.root);

    const longScript = `console.log('BOOT_READY'); setTimeout(() => console.log('NEVER'), 15000);`;
    const killAgent = env.store.createAgent({
      name: "killable-bot",
      cliCommand: `node -e ${JSON.stringify(longScript)}`,
      maxDurationSecs: 30,
    });

    const run = env.store.dispatch({
      taskId: "KILL-1",
      taskTitle: "In-flight killable run",
      project: "core-infra",
      repoPath: repoDir,
      agentId: killAgent.id,
    });

    // Wait until BOOT_READY is emitted on stdout to live stream
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        unsub();
        rejectReady(new Error("Timed out waiting for BOOT_READY log"));
      }, 5_000);
      const unsub = env.store.subscribeLogs(run.id, (ev) => {
        if (ev.type === "log" && ev.entry.stream === "stdout" && ev.entry.line.includes("BOOT_READY")) {
          clearTimeout(timer);
          unsub();
          resolveReady();
        }
      });
      if (env.store.getRunLogs(run.id).logs.some((l) => l.stream === "stdout" && l.line.includes("BOOT_READY"))) {
        clearTimeout(timer);
        unsub();
        resolveReady();
      }
    });

    const killed = env.store.killRun(run.id);
    assert.equal(killed.status, "cancelled");
    assert.ok(killed.logFilePath && existsSync(killed.logFilePath));

    const replay = env.store.getRunLogs(run.id);
    assert.ok(replay.logs.some((l) => l.stream === "stdout" && l.line.includes("BOOT_READY")));
    assert.ok(replay.logs.some((l) => l.stream === "system" && l.line.includes("SIGKILL")));

    // Worktree exists before cleanup and disappears after cleanupWorktrees
    const beforeCleanup = env.store.listWorktrees();
    assert.ok(beforeCleanup.some((w) => w.runId === run.id && w.cleanable));

    const cleaned = await env.store.cleanupWorktrees();
    assert.ok(cleaned.cleaned.some((c) => c.runId === run.id));
    assert.equal(existsSync(killed.worktreePath!), false);
    assert.equal(env.store.listWorktrees().length, 0);

    // Retry + metrics check
    const fastAgent = env.store.createAgent({
      name: "fast-metrics-bot",
      cliCommand: `node -e "console.log('total_tokens: 1500 cost_usd: 0.02')"`,
    });
    const mRun1 = env.store.dispatch({
      taskId: "MET-1",
      taskTitle: "Metric run 1",
      project: "growth-lab",
      agentId: fastAgent.id,
    });
    const mDone1 = await env.store.waitForRun(mRun1.id, 5_000);
    assert.equal(mDone1.status, "completed");

    const retried = env.store.retryRun(mRun1.id);
    assert.notEqual(retried.id, mRun1.id);
    assert.equal(retried.taskId, "MET-1");
    const mDone2 = await env.store.waitForRun(retried.id, 5_000);
    assert.equal(mDone2.status, "completed");

    const metrics = env.store.getMetrics(30);
    assert.equal(metrics.totalRuns, 3);
    assert.equal(metrics.totalTokens, 3000);
    assert.equal(metrics.totalCostUsd, 0.04);
    assert.ok(metrics.byDay.length >= 1);
    const growthMonth = metrics.byProjectMonth.find((m) => m.project === "growth-lab");
    assert.ok(growthMonth);
    assert.equal(growthMonth.runs, 2);
    assert.equal(growthMonth.costUsd, 0.04);
  } finally {
    await env.cleanup();
  }
});

test("8. Hono HTTP routes end-to-end including SSE log stream and bootstrap audit", async () => {
  const env = createTestEnv("opc-df-http-");
  try {
    const repoDir = createTempGitRepo(env.root);
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof ApiError) return c.json({ error: error.code, message: error.message }, error.status as 400);
      return c.json({ error: "internal", message: String(error) }, 500);
    });

    registerDarkFactoryRoutes(app, env.db, env.providers, () => ({ id: "u1", name: "本机" }), {
      store: env.store,
    });

    // Create agent via HTTP
    const createRes = await app.request("/api/opc/factory/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "http-smoke-agent",
        description: "E2E HTTP test",
        cliCommand: `node -e "console.log('HELLO_SSE_LINE'); console.log('total_tokens: 1000 cost_usd: 0.005');"`,
        capabilities: ["http", "sse"],
      }),
    });
    assert.equal(createRes.status, 201);
    const agent = (await createRes.json()) as AgentRecord;

    // Patch agent
    const patchRes = await app.request(`/api/opc/factory/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxCostPerTask: 3.5 }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal(((await patchRes.json()) as AgentRecord).maxCostPerTask, 3.5);

    // Dispatch via HTTP
    const dispatchRes = await app.request("/api/opc/factory/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "HTTP-1",
        taskTitle: "HTTP SSE E2E Test",
        project: "web-console",
        agentId: agent.id,
      }),
    });
    assert.equal(dispatchRes.status, 201);
    const run = (await dispatchRes.json()) as AgentRunRecord;

    // Wait for completion then test SSE replay stream + logs endpoint
    const completed = await env.store.waitForRun(run.id, 5_000);
    assert.equal(completed.status, "completed");

    const logsRes = await app.request(`/api/opc/factory/runs/${run.id}/logs`);
    assert.equal(logsRes.status, 200);
    const logsBody = (await logsRes.json()) as RunLogsResponse;
    assert.ok(logsBody.logs.some((l) => l.line.includes("HELLO_SSE_LINE")));

    const sseRes = await app.request(`/api/opc/factory/runs/${run.id}/stream`);
    assert.equal(sseRes.status, 200);
    assert.ok(sseRes.headers.get("content-type")?.includes("text/event-stream"));
    const sseText = await sseRes.text();
    assert.ok(sseText.includes("event: log"));
    assert.ok(sseText.includes("HELLO_SSE_LINE"));
    assert.ok(sseText.includes("event: done"));

    // Overview, worktrees, cleanup, audit
    const auditRes = await app.request("/api/opc/factory/bootstrap-audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: repoDir }),
    });
    assert.equal(auditRes.status, 201);

    const overviewRes = await app.request("/api/opc/factory/overview");
    assert.equal(overviewRes.status, 200);
    const overview = (await overviewRes.json()) as DarkFactoryOverview;
    assert.equal(overview.agents.length, 1);
    assert.equal(overview.runs.length, 1);
    assert.equal(overview.audits.length, 1);
    assert.equal(overview.metrics.totalTokens, 1000);

    const wtRes = await app.request("/api/opc/factory/worktrees");
    assert.equal(wtRes.status, 200);

    const cleanupRes = await app.request("/api/opc/factory/worktrees/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(cleanupRes.status, 200);

    // Delete agent via HTTP
    const delRes = await app.request(`/api/opc/factory/agents/${agent.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
  } finally {
    await env.cleanup();
  }
});

test("9. Safety guards: in-flight taskId deduplication and parent Epic-with-subtasks direct dispatch block", async () => {
  const env = createTestEnv("opc-df-dedupe-");
  try {
    const planning = new TaskPlanningStore(env.db, env.providers);
    const slowScript = `setTimeout(() => console.log('finished'), 5000);`;
    const agentA = env.store.createAgent({
      name: "worker-a",
      cliCommand: `node -e ${JSON.stringify(slowScript)}`,
    });
    const agentB = env.store.createAgent({
      name: "worker-b",
      cliCommand: `node -e ${JSON.stringify(slowScript)}`,
    });

    // 1. In-flight deduplication: dispatching same taskId repeatedly on same agent reuses active run
    const run1 = env.store.dispatch({
      taskId: "DEDUP-1",
      taskTitle: "Single in-flight task",
      agentId: agentA.id,
    });
    const runDup = env.store.dispatch({
      taskId: "DEDUP-1",
      taskTitle: "Single in-flight task",
      agentId: agentA.id,
    });
    assert.equal(runDup.id, run1.id);
    const activeForTask = env.store
      .listRuns({ limit: 50 })
      .filter((r) => r.taskId === "DEDUP-1" && (r.status === "queued" || r.status === "running"));
    assert.equal(activeForTask.length, 1);

    // 2. Conflicting agent on same active taskId throws 409 task_already_active
    assert.throws(
      () =>
        env.store.dispatch({
          taskId: "DEDUP-1",
          taskTitle: "Single in-flight task",
          agentId: agentB.id,
        }),
      (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === "task_already_active",
    );

    // 3. Explicit forceNew bypasses in-flight deduplication
    const forced = env.store.dispatch({
      taskId: "DEDUP-1",
      taskTitle: "Forced new run",
      agentId: agentB.id,
      forceNew: true,
    });
    assert.notEqual(forced.id, run1.id);

    // 4. Parent Epic with subtasks MUST be blocked in dispatch()
    const { epic, subtasks } = planning.createEpicWithSubtasks({
      project: "opc-os",
      title: "Parent Epic",
      subtasks: [{ title: "Leaf Subtask 1" }, { title: "Leaf Subtask 2" }],
    });

    assert.throws(
      () =>
        env.store.dispatch({
          taskId: epic.id,
          taskTitle: epic.title,
          agentId: agentA.id,
        }),
      (err: unknown) => err instanceof ApiError && err.status === 400 && err.code === "epic_has_subtasks",
    );

    // Leaf subtask dispatches cleanly
    const fastAgent = env.store.createAgent({
      name: "fast-leaf",
      cliCommand: `node -e "console.log('leaf ok')"`,
    });
    const leafRun = env.store.dispatch({
      taskId: subtasks[0].id,
      taskTitle: subtasks[0].title,
      agentId: fastAgent.id,
    });
    const doneLeaf = await env.store.waitForRun(leafRun.id, 5_000);
    assert.equal(doneLeaf.status, "completed");
  } finally {
    await env.cleanup();
  }
});

test("10. Per-agent consecutive failure circuit breaker (cooldown, SQLite persistence, emergency bypass, and manual reset)", async () => {
  const env = createTestEnv("opc-df-cooldown-");
  try {
    const flakyAgent = env.store.createAgent({
      name: "grok-flaky",
      cliCommand: `node -e "console.error('timeout simulated'); process.exit(1);"`,
      maxDurationSecs: 5,
    });

    // Failure #1 -> not cooled down yet
    const fail1 = env.store.dispatch({
      taskId: "FAIL-1",
      taskTitle: "Failure 1",
      agentId: flakyAgent.id,
    });
    const res1 = await env.store.waitForRun(fail1.id, 5_000);
    assert.equal(res1.status, "failed");
    assert.equal(env.store.isAgentCooledDown(flakyAgent.id), false);
    assert.equal(env.store.getAgentCooldown(flakyAgent.id).consecutiveFailures, 1);

    // Failure #2 -> trips circuit breaker cooldown
    const fail2 = env.store.dispatch({
      taskId: "FAIL-2",
      taskTitle: "Failure 2",
      agentId: flakyAgent.id,
    });
    const res2 = await env.store.waitForRun(fail2.id, 5_000);
    assert.equal(res2.status, "failed");
    assert.equal(env.store.isAgentCooledDown(flakyAgent.id), true);

    const overview = env.store.getOverview();
    assert.equal(overview.agentCooldowns[flakyAgent.id]?.cooledDown, true);
    assert.equal(overview.agentCooldowns[flakyAgent.id]?.consecutiveFailures, 2);

    // Fresh store instance on same SQLite DB immediately honors cooldown
    const restartedStore = new DarkFactoryStore(env.db, env.providers, {
      worktreeBase: env.worktreeBase,
      defaultRepoRoot: env.root,
    });
    assert.equal(restartedStore.isAgentCooledDown(flakyAgent.id), true);

    // Dispatch #3 blocked with 409 agent_cooled_down
    assert.throws(
      () =>
        env.store.dispatch({
          taskId: "FAIL-3",
          taskTitle: "Blocked by cooldown",
          agentId: flakyAgent.id,
        }),
      (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === "agent_cooled_down",
    );

    // Emergency dispatch bypasses cooldown
    const emergencyRun = env.store.dispatch({
      taskId: "EMERG-1",
      taskTitle: "Emergency bypass",
      agentId: flakyAgent.id,
      isEmergency: true,
    });
    await env.store.waitForRun(emergencyRun.id, 5_000);

    // Manual reset via HTTP clears cooldown and recovers agent status to idle
    const app = new Hono();
    registerDarkFactoryRoutes(app, env.db, env.providers, () => ({ id: "u1", name: "Founder" }), {
      store: env.store,
    });
    const resetRes = await app.request(`/api/opc/factory/agents/${flakyAgent.id}/reset-cooldown`, {
      method: "POST",
    });
    assert.equal(resetRes.status, 200);
    assert.equal(env.store.isAgentCooledDown(flakyAgent.id), false);
    assert.equal(env.store.getAgent(flakyAgent.id).status, "idle");
  } finally {
    await env.cleanup();
  }
});
