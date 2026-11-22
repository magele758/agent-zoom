import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createApp } from "./server/http.ts";
import { openStore } from "./server/logic.ts";

function startHealthServer(statusCodeFn: () => number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv: Server = createServer((_req, res) => {
      const code = statusCodeFn();
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: code >= 200 && code < 300 }));
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/health`,
        close: () => new Promise((done) => srv.close(() => done())),
      });
    });
  });
}

test("Full OPC Company E2E: Micro-Kernel + 6 Functional Departments closed loop", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "opc-company-e2e-"));
  const repoDir = join(tmpRoot, "flagship-repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "app.txt"), "v1\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "OPC Bot"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "bot@opc.local"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init v1"], { cwd: repoDir, stdio: "ignore" });
  const initialMainSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  let healthStatus = 200;
  const healthSrv = await startHealthServer(() => healthStatus);
  const prevSubmitToken = process.env.WORKFLOW_SUBMIT_TOKEN;
  process.env.WORKFLOW_SUBMIT_TOKEN = "test-submit-token-only-read-request";
  const store = openStore(":memory:", { demo: false });
  const { app, darkFactory, taskPlanning, metabolism, company } = createApp(store, {});

  try {
    // Authenticate local founder session
    const sessionRes = await app.request("/api/session", { method: "POST" });
    assert.equal(sessionRes.status, 200);
    const cookie = sessionRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie.includes("ac_session="));

    const authed = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          cookie,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    // 1. Verify Kernel + 6 Orthogonal Departments are registered and healthy
    const archRes = await authed("/api/opc/kernel/architecture");
    assert.equal(archRes.status, 200);
    const arch = (await archRes.json()) as {
      departments: Array<{ id: string; registered: boolean; health: { healthy: boolean } }>;
    };
    assert.equal(arch.departments.length, 6);
    assert.ok(arch.departments.every((d) => d.registered));

    // Register real repo contract on canonical Asset in Mainline 01
    const deployedMarker = join(tmpRoot, "deployed.marker");
    company.kernel.registry.upsertAsset({
      id: "asset_pagelens_interpret",
      productId: "prod_pagelens",
      name: "pagelens-interpret",
      localRepoPath: repoDir,
      verifyCommand: `node -e "const fs=require('fs'); if(!fs.existsSync('feature.txt')) process.exit(1);"`,
      buildCommand: `node -e "require('fs').writeFileSync('dist.txt', 'built')"`,
      deployCommand: `node -e "require('fs').writeFileSync('${deployedMarker}', 'live')"`,
      healthUrl: healthSrv.url,
    });

    // 2. Dept 01 Strategy: Test Mainline Freeze enforcement + Habit learning
    await authed("/api/opc/kernel/mainlines/ml_dark_factory", {
      method: "PUT",
      body: JSON.stringify({ name: "Agent 暗工厂与一人公司中枢", freezeNonMainline: true }),
    });
    const frozenEval = company.strategy.evaluateCandidate({
      title: "新建无关聊天玩具基建",
      projectOrAssetRef: "unregistered-toy-project",
    });
    assert.equal(frozenEval.allowed, false);
    assert.equal(frozenEval.recommendation, "blocked");

    // Unfreeze so flagship mainline can proceed
    await authed("/api/opc/kernel/mainlines/ml_dark_factory", {
      method: "PUT",
      body: JSON.stringify({ name: "Agent 暗工厂与一人公司中枢", freezeNonMainline: false }),
    });

    // 3. Dept 02 Product: Subtask DAG dependency enforcement + Parent Epic auto-completion
    const { epic, subtasks } = taskPlanning.createEpicWithSubtasks({
      project: "PageLens",
      title: "PageLens 离线同传闭环",
      subtasks: [
        { title: "实现音频分片接口", priority: 9 },
        { title: "接入前端字幕浮层", priority: 8, dependsOnIndices: [0] },
      ],
    });
    const depCheckBefore = taskPlanning.areDependenciesMet(subtasks[1].id);
    assert.equal(depCheckBefore.met, false);
    assert.deepEqual(depCheckBefore.blockingIds, [subtasks[0].id]);

    taskPlanning.updateStatus(subtasks[0].id, "done");
    assert.equal(taskPlanning.areDependenciesMet(subtasks[1].id).met, true);
    taskPlanning.updateStatus(subtasks[1].id, "done");
    assert.equal(taskPlanning.getTask(epic.id).status, "done", "Epic should auto-complete when all subtasks finish");

    // 4. Dept 02 -> Dept 04 Quota Router -> Dept 03 Dark Factory -> DecisionGateway -> Real Release & Rollback!
    const coderAgent = darkFactory.createAgent({
      name: "local-codex-worker",
      cliCommand: `node -e "const fs=require('fs'); fs.writeFileSync('feature.txt', 'shipped-v2\\n'); console.log('total_tokens: 1000 cost_usd: $0.01');"`,
      capabilities: ["typescript", "extension"],
    });
    assert.ok(coderAgent.id);

    const shipTask = taskPlanning.createTask({
      project: "pagelens-interpret",
      title: "新增离线字幕导出能力",
      description: "写入 feature.txt 并通过外部 verifyCommand 验收",
      priority: 10,
    });

    // Smart dispatch via Dept 04 Resources Quota-Aware Router
    const smartRes = await authed("/api/opc/domains/resources/dispatch-smart", {
      method: "POST",
      body: JSON.stringify({ taskId: shipTask.id, autoCreatePr: false }),
    });
    assert.equal(smartRes.status, 200, "smart quota dispatch should succeed");
    const smartBody = (await smartRes.json()) as { run: { id: string } };

    // Wait for child process + external deterministic verifyCommand to finish
    let finishedRun = darkFactory.getRun(smartBody.run.id);
    for (let i = 0; i < 40 && (finishedRun.status === "queued" || finishedRun.status === "running"); i++) {
      await delay(100);
      finishedRun = darkFactory.getRun(smartBody.run.id);
    }
    assert.equal(finishedRun.status, "completed");
    assert.equal(finishedRun.verification?.passed, true, "external verifyCommand must run and pass");

    // Request production release -> creates high-risk DecisionPacket in Founder Mailbox
    const reqRelRes = await authed(`/api/opc/domains/factory/runs/${finishedRun.id}/request-release`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(reqRelRes.status, 201);
    const reqRelBody = (await reqRelRes.json()) as { release: { id: string }; decision: { id: string; status: string } };
    assert.equal(reqRelBody.decision.status, "pending");

    // Viewing packet in FounderMailbox MUST NOT drop it out of pending!
    await authed(`/api/opc/kernel/decisions/${reqRelBody.decision.id}/view`, { method: "POST" });
    assert.equal(company.kernel.decisions.get(reqRelBody.decision.id)?.status, "pending");

    // Approve & Deploy in DecisionGateway -> triggers real git merge + build + deploy + HTTP health probe!
    const resolveRes = await authed(`/api/opc/kernel/decisions/${reqRelBody.decision.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ optionId: "approve_deploy", note: "测试与构建完备，批准上线" }),
    });
    assert.equal(resolveRes.status, 200);

    const completedRelease = company.factory.releases.getRelease(reqRelBody.release.id);
    assert.equal(completedRelease?.status, "succeeded", JSON.stringify(completedRelease?.steps, null, 2));
    assert.notEqual(completedRelease?.releaseSha, initialMainSha);
    assert.equal(existsSync(deployedMarker), true, "real deployCommand must have executed");
    assert.equal(readFileSync(join(repoDir, "feature.txt"), "utf8"), "shipped-v2\n", "main branch must contain merged file");
    assert.equal(taskPlanning.getTask(shipTask.id).status, "published", "task must transition to published after real release");

    // Verify Strategy learned founder's approval preference from resolving the decision!
    const stratOverview = await (await authed("/api/opc/domains/strategy/overview")).json() as {
      recentEvents: Array<{ decisionId: string }>;
    };
    assert.ok(stratOverview.recentEvents.some((e) => e.decisionId === reqRelBody.decision.id));

    // Test Automatic Real Rollback when post-deploy health probe fails (HTTP 500)!
    const preBadSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-b", "agent/bad-release"], { cwd: repoDir, stdio: "ignore" });
    writeFileSync(join(repoDir, "broken.txt"), "bad\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "bad release"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "ignore" });

    healthStatus = 500; // Health endpoint now unhealthy!
    const badRel = company.factory.releases.createRelease({
      project: "pagelens-interpret",
      repoPath: repoDir,
      sourceBranch: "agent/bad-release",
      targetBranch: "main",
      healthUrl: healthSrv.url,
      mode: "merge_and_deploy",
    });
    const rolledBack = await company.factory.releases.executeRelease(badRel.id);
    assert.equal(rolledBack.status, "rolled_back");
    const headAfterRollback = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    assert.equal(headAfterRollback, preBadSha, "git main branch must automatically reset to previousHeadSha on health failure");
    assert.equal(existsSync(join(repoDir, "broken.txt")), false);

    // 5. Dept 05 Ops Watchdog & Dept 06 Commercial Security/Bridge Verification
    // Also verify AutonomyMode='assisted' pauses signal auto-promotion & background quota harvesting
    const assistedRes = await authed("/api/opc/kernel/decisions/policy", {
      method: "PUT",
      body: JSON.stringify({ autonomyMode: "assisted" }),
    });
    assert.equal(assistedRes.status, 200);
    const assistedSigRes = await authed("/api/opc/domains/product/signals", {
      method: "POST",
      body: JSON.stringify({
        source: "manual",
        projectRef: "pagelens-interpret",
        title: "PageLens 离线字幕导出 SRT 与单测验收",
        body: "附带验证命令 npm test 且对齐 1 号商业试点主线",
        tags: ["offline", "monetization"],
      }),
    });
    assert.equal(assistedSigRes.status, 201);
    const assistedSigBody = (await assistedSigRes.json()) as {
      signal: { id: string; status: string };
      promotedTask: unknown;
    };
    assert.equal(assistedSigBody.promotedTask, null, "assisted mode must NOT auto-promote signals");
    assert.equal(assistedSigBody.signal.status, "new");

    // Manual promote still succeeds on demand
    const manualPromoteRes = await authed(`/api/opc/domains/product/signals/${assistedSigBody.signal.id}/promote`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(manualPromoteRes.status, 200);

    // Non-forced quota harvest must pause in assisted mode
    const pausedHarvestRes = await authed("/api/opc/domains/resources/harvest", {
      method: "POST",
      body: JSON.stringify({ dryRun: false, force: false }),
    });
    assert.equal(pausedHarvestRes.status, 200);
    const pausedHarvest = (await pausedHarvestRes.json()) as { triggered: boolean; reason: string };
    assert.equal(pausedHarvest.triggered, false);
    assert.ok(pausedHarvest.reason.includes("自治档位"));

    // Restore full_auto for remaining checks
    await authed("/api/opc/kernel/decisions/policy", {
      method: "PUT",
      body: JSON.stringify({ autonomyMode: "full_auto" }),
    });

    const wdRes = await authed("/api/opc/domains/ops/watchdog/run", { method: "POST", body: "{}" });
    assert.equal(wdRes.status, 200);
    const wdBody = (await wdRes.json()) as {
      cycle: { disk: { freeGb: number }; sqlite: { healthy: boolean } };
    };
    assert.ok(wdBody.cycle.disk.freeGb > 0);
    assert.equal(wdBody.cycle.sqlite.healthy, true);

    const bridgeRes = await authed("/api/opc/domains/commercial/bridge");
    assert.equal(bridgeRes.status, 200);
    const bridgeBody = (await bridgeRes.json()) as { ledger: { factoryTokenCostUsd: number } };
    assert.ok(bridgeBody.ledger.factoryTokenCostUsd >= 0.01);

    // Unsigned Stripe webhook MUST be rejected
    const unsignedWebhook = metabolism.handlePaymentCallback("stripe", {
      type: "checkout.session.completed",
      out_trade_no: "OPC-FAKE",
    });
    assert.equal(unsignedWebhook.success, false);

    // 6. Security Regression Gates:
    // (a) submitToken-only caller MUST NOT execute releases directly (401)
    const tokenBypassRes = await app.request("/api/opc/domains/factory/releases", {
      method: "POST",
      headers: {
        authorization: "Bearer test-submit-token-only-read-request",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project: "pagelens-interpret",
        repoPath: repoDir,
        sourceBranch: "main",
        targetBranch: "main",
        executeNow: true,
      }),
    });
    assert.equal(tokenBypassRes.status, 401, "submitToken-only must be rejected on direct release execution");

    // (b) Git argument injection in branch names MUST be rejected (400)
    const badBranchRes = await authed("/api/opc/domains/factory/releases", {
      method: "POST",
      body: JSON.stringify({
        project: "pagelens-interpret",
        repoPath: repoDir,
        sourceBranch: "--output=/tmp/opc-git-arg-injection",
        targetBranch: "main",
      }),
    });
    assert.equal(badBranchRes.status, 400, "git option-like branch names must be rejected");

    // (c) Resources dispatch MUST block tasks whose dependsOn prerequisite is incomplete (409)
    const prereqTask = taskPlanning.createTask({
      title: "前置数据库迁移",
      project: "pagelens-interpret",
      priority: 1,
    });
    const blockedTask = taskPlanning.createTask({
      title: "依赖前置迁移的 API 变更",
      project: "pagelens-interpret",
      priority: 1,
      dependsOn: [prereqTask.id],
    });
    const blockedDispatchRes = await authed("/api/opc/domains/resources/dispatch-smart", {
      method: "POST",
      body: JSON.stringify({ taskId: blockedTask.id }),
    });
    assert.equal(blockedDispatchRes.status, 409, "dependency-blocked task must be rejected on resources dispatch");
  } finally {
    if (prevSubmitToken === undefined) delete process.env.WORKFLOW_SUBMIT_TOKEN;
    else process.env.WORKFLOW_SUBMIT_TOKEN = prevSubmitToken;
    await darkFactory.dispose();
    company.kernel.stopAll();
    await healthSrv.close();
    store.db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
