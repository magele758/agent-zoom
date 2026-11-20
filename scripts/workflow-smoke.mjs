import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { checkBoardFiling, checkBoardRejection } from "./workflow-board-check.mjs";
import { cleanupHerdrRun } from "./workflow-cleanup.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync("/tmp/kunlun-workflow-");
console.log(`演示目录 ${directory}`);
const interactive = process.argv.includes("--interactive");
const codex = process.argv.includes("--codex");
const keep = process.argv.includes("--keep");
const backend = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? (interactive ? "herdr" : "local-demo");
assert.ok(["herdr", "local-demo"].includes(backend), "使用 herdr 或 local-demo");
assert.ok(!codex || (interactive && backend === "herdr"), "--codex 用于真实 Herdr 的交互演示");
assert.ok(process.argv.slice(2).every(arg => [backend, "--interactive", "--codex", "--keep"].includes(arg)), "未知演示参数");
assert.ok(existsSync(join(root, "web/dist/index.html")), "请先 npm run build");
const repo = join(directory, "fixture");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "greeting.txt"), "Hello\n");
writeFileSync(join(repo, "greeting.test.mjs"), `import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
test("greets OPC OS", () => assert.equal(readFileSync("greeting.txt", "utf8"), "Hello, OPC OS!\\n"));
`);
git("add", ".");
git("-c", "user.name=OPC OS Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "fixture");
const baseCommit = git("rev-parse", "HEAD").trim();
const port = await new Promise((done, fail) => {
  const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => done(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const config = join(directory, "workflow.json");
const hc = process.env.HC_BIN ?? "hc";
const runner = role => codex
  ? [process.execPath, join(root, "scripts/workflow-codex.mjs"), role, process.execPath, "--test", "greeting.test.mjs"]
  : [process.execPath, join(root, `scripts/workflow-demo-${role}.mjs`)];
writeFileSync(config, JSON.stringify({
  backend, workspace: repo, hc,
  attemptRoot: join(directory, "attempts"),
  implement: runner("implement"), review: runner("review"),
  ...(backend === "herdr" && !codex ? { capabilities: { documentation: runner("implement") } } : {}),
}), { mode: 0o600 });
const submitToken = randomBytes(24).toString("hex");
const dataPath = join(directory, "chatroom.db");
const env = {
  ...process.env, PORT: String(port), DATA_PATH: dataPath, DEMO_MODE: "0", KUNLUN_URL: base,
  WORKFLOW_CONFIG: config, WORKFLOW_SUBMIT_TOKEN: submitToken,
};
for (const key of ["HC_SCOPE", "HC_SESSION", "HC_TERMINAL_ID", "HFLOW_WORKER", "KUNLUN_WORKFLOW_WORKER"]) delete env[key];
const hcEnv = { ...env };
for (const key of ["WORKFLOW_CONFIG", "WORKFLOW_SUBMIT_TOKEN"]) delete hcEnv[key];
const hcCall = (...args) => JSON.parse(execFileSync(hc, args, { env: hcEnv, encoding: "utf8", timeout: 20_000 }));
const exec = promisify(execFile);
const cliEnv = { ...hcEnv, WORKFLOW_SUBMIT_TOKEN: submitToken };
const cli = async (...args) => JSON.parse((await exec(process.execPath, ["scripts/workflow.mjs", ...args], { env: cliEnv, cwd: root })).stdout);
const checks = [];
const activeRunIds = new Set();
let server, browser;
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  await once(server, "exit");
}
async function startServer() {
  server = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(process.stdout, { end: false });
  server.stderr.pipe(process.stderr, { end: false });
  await expect.poll(async () => {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`);
    return (await fetch(base + "/api/health").catch(() => undefined))?.ok;
  }, { timeout: 10_000 }).toBe(true);
}

try {
  if (backend === "herdr") {
    const status = hcCall("server", "status", "--json");
    console.log(`Herdr Core ${status.version}`);
  }
  await startServer();
  await demonstrate();
} finally {
  await browser?.close();
  await stopServer();
  if (!keep) {
    if (backend === "herdr") {
      for (const runId of activeRunIds) await cleanupHerdrRun(runId, { hc, env: hcEnv });
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

async function demonstrate() {
  const plan = {
    nodes: [
      { id: "build", kind: "implement", title: "修改问候语", instruction: "把 greeting.txt 改为 Hello, OPC OS! 并运行既有测试。" },
      { id: "guide", kind: "implement", title: "补充使用说明", instruction: "在 GUIDE.md 写入测试命令。",
        ...(backend === "herdr" ? { capability: "documentation" } : {}) },
      { id: "review", kind: "review", title: "独立评审", instruction: "验证两个实现的差异与测试记录。", dependsOn: ["build", "guide"] },
    ],
    acceptance: ["review"],
  };
  const request = {
    version: 1, requestId: "agent-file", source: "coding-agent-fixture", context: "原请求 demo/thread-42",
    ...(codex ? { goal: "修改 greeting.txt 使其内容为 Hello, OPC OS! 加换行，并独立复测。",
      constraints: ["保留原始 greeting.test.mjs 和 Git 基线。"] }
      : { goal: "修正问候语", constraints: ["演示一次失败重试", ...(interactive ? [] : ["等待演示继续信号"])], plan }),
  };
  const file = join(directory, "request.json");
  writeFileSync(file, JSON.stringify(request));
  let run = await cli("submit", file);
  activeRunIds.add(run.id);
  const launchVars = { PORT: port, DATA_PATH: dataPath, DEMO_MODE: 0, WORKFLOW_CONFIG: config,
    KUNLUN_URL: base, WORKFLOW_SUBMIT_TOKEN: submitToken };
  writeFileSync(join(directory, "service.env"), Object.entries(launchVars).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
  writeFileSync(join(directory, "submit.env"), `KUNLUN_URL=${base}\nWORKFLOW_SUBMIT_TOKEN=${submitToken}\n`, { mode: 0o600 });
  if (interactive) {
    const steps = codex ? "批准计划后，两个实际 Codex 会话将依次实现和独立评审，再由你验收。"
      : "批准计划后可查看并行实现和失败证据，填写反馈重试，再验收。";
    const keepNote = keep
      ? `重开同一服务：node --env-file=${directory}/service.env --import tsx src/server/index.ts`
      : "退出后会自动清理临时演示目录与 Herdr 终端；如需保留现场请加 --keep。";
    console.log(`看板 ${run.boardUrl}\n当前停在计划确认。打开即可查看。${steps}\n${keepNote}`);
    const stop = () => server.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const [code, signal] = await once(server, "exit");
    if (code || (signal && !["SIGTERM", "SIGINT"].includes(signal))) throw new Error(`服务停止 ${signal ?? code}`);
    return;
  }
  assert.equal((await cli("submit", file)).id, run.id);
  const ordinary = { version: 1, requestId: "shell-stdin", source: "shell-curl", context: "独立的命令行请求", goal: "检查问候语" };
  const curl = submitWithCurl(ordinary);
  activeRunIds.add(curl.id);
  assert.equal((await cli("goal", ordinary.goal, "--request-id", ordinary.requestId, "--source", ordinary.source,
    "--context", ordinary.context)).id, curl.id);
  assert.notEqual(curl.id, run.id);
  assert.equal(curl.revisions[0].plan.nodes.length, 2);
  assert.equal((await cli("list")).runs.length, 2);
  checks.push("真实 node CLI 文件发起、真实 curl 从 stdin 独立发起、请求幂等、本地目标规划器");

  const chrome = process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const capture = async name => {
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
    writeFileSync(join(directory, `${name}.txt`), await page.locator("main").ariaSnapshot());
  };
  await page.goto(run.boardUrl);
  const planCard = page.locator('[data-kind="plan"]');
  await expect(planCard).toContainText("计划确认 · r1");
  await checkBoardFiling(page, run, () => cli("status", run.id));
  checks.push("新浏览器直达原任务、已读与归档独立、移回看板后原待决卡及运行记录完整");
  assert.equal((await cli("status", run.id)).attempts.length, 0);
  if (backend === "herdr") assert.equal(hcCall("ls", "--json", "--all", "--label", `kunlun.run=${run.id}`).terminals.length, 0);
  await capture("01-plan");
  const oldCard = run.cards[0];
  const decisionUrl = `${base}/api/workflows/${run.id}/decisions`;
  const oldApproval = { cardId: oldCard.id, revision: 1, action: "approve" };
  const cliDecision = await fetch(decisionUrl, { method: "POST",
    headers: { authorization: `Bearer ${submitToken}`, "content-type": "application/json" }, body: JSON.stringify(oldApproval) });
  assert.equal(cliDecision.status, 401);
  const subscription = cli("feedback", run.id, String(run.events.length), "--wait");
  await planCard.getByLabel("发回原请求的反馈").fill("请补充独立复测要求");
  await planCard.getByRole("button", { name: "要求修改" }).click();
  await page.locator(".wf-history-fold > summary").click();
  await expect(page.locator(".workflow-history").getByText("请补充独立复测要求", { exact: true })).toBeVisible();
  assert.equal((await cli("status", run.id)).attempts.length, 0);
  const revision = join(directory, "revision.json");
  const feedback = await subscription;
  assert.ok(feedback.events.some(e => e.kind === "decision_changes" && e.note === "请补充独立复测要求"));
  assert.equal(feedback.context, request.context);
  assert.deepEqual((await cli("feedback", run.id, String(feedback.cursor))).events, []);
  plan.nodes.find(node => node.kind === "review").instruction = "在独立工作区检查两份差异并重新运行测试。";
  writeFileSync(revision, JSON.stringify({ baseRevision: 1, reason: "按原请求反馈补齐独立复测", plan }));
  run = await cli("revise", run.id, revision);
  assert.equal((await page.request.post(decisionUrl, { data: oldApproval })).status(), 409);
  await expect(planCard).toContainText("计划确认 · r2");
  await planCard.getByRole("button", { name: "批准", exact: true }).click();
  await expect.poll(async () => {
    const attempts = (await cli("status", run.id)).attempts;
    return attempts.find(a => a.nodeId === "build")?.state === "running" && attempts.find(a => a.nodeId === "guide")?.state === "succeeded";
  }, { timeout: 25_000 }).toBe(true);
  const parallel = (await cli("status", run.id)).attempts;
  const initial = parallel.find(a => a.nodeId === "build");
  await stopServer();
  await startServer();
  const recovered = (await cli("status", run.id)).attempts;
  assert.deepEqual(recovered.map(item => [item.id, item.terminal]), parallel.map(item => [item.id, item.terminal]));
  assert.equal((await cli("submit", file)).id, run.id);
  if (backend === "herdr") {
    const terminals = hcCall("ls", "--json", "--all", "--label", `kunlun.attempt=${initial.id}`).terminals;
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].address, initial.terminal);
    assert.equal(terminals[0].cwd, initial.worktree);
  }
  writeFileSync(join(directory, "attempts", initial.id, "continue"), "");
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible({ timeout: 15_000 });
  await capture("02-recovery");
  await page.getByLabel("交给重试执行器的反馈").fill("修正问候语后重新运行测试");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  const final = page.locator('[data-kind="final"]');
  await expect(final).toBeVisible({ timeout: 25_000 });
  run = await cli("status", run.id);
  assert.deepEqual(run.attempts.map(item => [item.nodeId, item.state]), [["build", "failed"], ["guide", "succeeded"], ["build", "succeeded"], ["review", "succeeded"]]);
  for (const attempt of run.attempts) {
    assert.ok(attempt.terminal);
    assert.ok(existsSync(join(attempt.worktree, ".git")));
  }
  assert.equal(new Set(run.attempts.map(item => item.worktree)).size, 4);
  assert.match(run.attempts[0].evidence.patch, /\+Hello there/);
  assert.match(run.attempts[2].evidence.patch, /\+Hello, OPC OS!/);
  const review = run.attempts[3];
  assert.equal(readFileSync(join(review.worktree, "greeting.txt"), "utf8"), "Hello, OPC OS!\n");
  assert.match(readFileSync(join(review.worktree, "GUIDE.md"), "utf8"), /node --test/);
  assert.ok(review.evidence.checks.some(check => check.name.includes("node --test") && check.exitCode === 0));
  if (backend === "herdr") {
    const terminals = hcCall("ls", "--json", "--all", "--label", `kunlun.run=${run.id}`).terminals;
    assert.equal(terminals.length, 4);
    const desktop = () => JSON.parse(execFileSync(process.env.HERDR_APP_BIN ?? "herdr-app", ["ls"], { encoding: "utf8", env: hcEnv, timeout: 5000 }));
    const layout = () => desktop().spaces.find(space =>
      space.tabs.some(tab => tab.terminals.some(pane => pane.terminal === initial.terminal)));
    await expect.poll(() => layout()?.tabs.filter(tab => tab.terminals.some(t => terminals.some(row => row.address === t.terminal))).length, { timeout: 10_000 }).toBe(4);
    writeFileSync(join(directory, "herdr-layout.json"), JSON.stringify(layout(), null, 2));
  }
  assert.equal(readFileSync(join(repo, "greeting.txt"), "utf8"), "Hello\n");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("rev-parse", "HEAD").trim(), baseCommit);
  await capture("03-acceptance");
  await final.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.locator(".workflow-state dd")).toHaveText(["完成", "已完成"]);
  await page.reload();
  await expect(page.locator(".workflow-state dd")).toHaveText(["完成", "已完成"]);
  const completed = await cli("status", run.id);
  assert.ok(completed.cleanedAt, "最终验收默认应清理执行现场");
  for (const attempt of completed.attempts) {
    assert.equal(existsSync(attempt.worktree), false, `工作树 ${attempt.worktree} 应已清理`);
    assert.ok(existsSync(join(directory, "attempts", attempt.id, "receipt.json")), "回执文件应保留");
  }
  if (backend === "herdr") {
    assert.equal(hcCall("ls", "--json", "--all", "--label", `kunlun.run=${run.id}`).terminals.length, 0);
  }
  await page.locator(".wf-history-fold > summary").click();
  await expect(page.locator(".workflow-history").getByText("请补充独立复测要求", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "所有运行" }).click();
  await expect(page.getByRole("region", { name: "已完成", exact: true })).toContainText("修正问候语");
  await expect(page.getByRole("region", { name: "待人工决定" })).toContainText("检查问候语");
  await capture("04-board");
  await checkBoardRejection(page, curl, () => cli("status", curl.id));
  checks.push("拒绝必须填写反馈、归档后有新决定重新出现、发起者在同一任务收到拒绝说明");
  const db = new DatabaseSync(dataPath, { readOnly: true });
  const row = db.prepare("SELECT snapshot FROM workflow_runs WHERE id = ?").get(run.id);
  db.close();
  assert.equal(JSON.parse(row.snapshot).cards.find(item => item.kind === "final").status, "approve");
  assert.equal((await cli("status", curl.id)).attempts.length, 0);
  checks.push("在任务内直接审批、确认前零派发、提交凭据不能单独审批、原请求收到反馈、旧卡片拒绝、服务重启后保持同一终端、重试、独立评审、持久化最终验收与自动清理终端及临时工作树");
  if (keep) {
    writeFileSync(join(directory, "evidence.json"), JSON.stringify({ backend, run: completed, checks }, null, 2));
    console.log(`通过 ${backend} · ${run.id} · ${join(directory, "evidence.json")}`);
  } else {
    console.log(`通过 ${backend} · ${run.id}（临时目录与执行现场已自动清理；如需保留请加 --keep）`);
  }
}

function submitWithCurl(request) {
  const response = execFileSync("curl", ["--fail-with-body", "--silent", "--show-error", "-H", "content-type: application/json",
    "-H", `authorization: Bearer ${submitToken}`, "--data-binary", "@-", `${base}/api/workflows`],
  { input: JSON.stringify(request), encoding: "utf8", timeout: 10_000 });
  return JSON.parse(response);
}
