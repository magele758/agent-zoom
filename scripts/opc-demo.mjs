// Run one project-scoped selection in a temporary Git repository through the normal HTTP service.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCapabilities } from "./opc-capabilities.mjs";
import { cleanupHerdrRun } from "./workflow-cleanup.mjs";

const args = process.argv.slice(2);
const providers = ["codex", "grok", "agy", "cursor-agent"];
const choices = args.filter((arg) => providers.includes(arg.slice(2)) && arg.startsWith("--"));
if (
  choices.length > 1 ||
  args.some((arg) => !["--herdr", "--interactive", "--keep", ...providers.map((p) => "--" + p)].includes(arg))
) {
  throw Error("选择一个实现者 --codex、--grok、--agy 或 --cursor-agent，可配合 --herdr、--interactive 和 --keep");
}
const interactive = args.includes("--interactive");
const keep = args.includes("--keep");
const implementer = choices[0]?.slice(2);
const reviewer = implementer === "grok" || implementer === "agy" ? "cursor-agent" : "codex";
const host = args.includes("--herdr") ? "herdr" : "local-demo";
if (implementer && host !== "herdr") throw Error("真实 coding agent 演示需要 --herdr");
const available = providers.filter((provider) =>
  (process.env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => {
      const path = join(directory, provider);
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    }),
);
if (implementer) {
  for (const selected of [implementer, reviewer]) {
    if (!available.includes(selected)) throw Error("本次演示需要已安装且在 PATH 可执行的 CLI：" + selected);
  }
}
const runnerLabel = !implementer
  ? "固定脚本"
  : implementer === "codex"
    ? "Codex CLI"
    : implementer + " 实现 / " + reviewer + " 评审";
const root = resolve(import.meta.dirname, ".."),
  dir = realpathSync(mkdtempSync(join(tmpdir(), "opc-os-demo-"))),
  repo = join(dir, "greeting");
console.log("临时演示目录", dir);
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "greeting.txt"), "Hello\n");
writeFileSync(
  join(repo, "greeting.test.mjs"),
  `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import test from 'node:test'; test('greets OPC OS',()=>assert.equal(readFileSync('greeting.txt','utf8'),'Hello, OPC OS!\\n'));\n`,
);
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
git("add", ".");
git("-c", "user.name=OPC OS", "-c", "user.email=demo@example.invalid", "commit", "-qm", "greeting fixture");
const listener = createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const url = "http://127.0.0.1:" + port;
const runner = (role, provider = role === "review" ? reviewer : implementer) => {
  if (!implementer) return [process.execPath, join(root, "scripts/workflow-demo-" + role + ".mjs")];
  const application =
    provider === "codex"
      ? [join(root, "scripts/workflow-codex.mjs")]
      : [join(root, "scripts/workflow-cli-agent.mjs"), provider];
  return [process.execPath, ...application, role, process.execPath, "--test", "greeting.test.mjs"];
};
const config = join(dir, "workflow.json"),
  token = randomBytes(24).toString("hex");
writeFileSync(
  config,
  JSON.stringify({
    backend: host,
    workspace: repo,
    projectWorkspaces: { "Demo/Greeting": repo },
    attemptRoot: join(dir, "attempts"),
    implement: runner("implement"),
    review: runner("review"),
    ...(interactive &&
      implementer && {
        capabilities: Object.fromEntries(
          available
            .filter((provider) => provider !== implementer)
            .map((provider) => [provider, runner("implement", provider)]),
        ),
      }),
  }),
);
const env = {
  ...process.env,
  DATA_PATH: join(dir, "opc-os.db"),
  OPC_HUB_QUOTA_DB: join(dir, "preview-quota.db"),
  PORT: String(port),
  WORKFLOW_CONFIG: config,
  WORKFLOW_SUBMIT_TOKEN: token,
  DEMO_MODE: "0",
};
for (const key of ["HC_SCOPE", "HC_SESSION", "HC_TERMINAL_ID", "HFLOW_WORKER", "KUNLUN_WORKFLOW_WORKER"])
  delete env[key];
let child,
  activeRunId,
  cookie = "";
async function until(fn, ms = 15000, timeoutMessage = () => "等待超时") {
  const deadline = Date.now() + ms;
  do {
    const v = await fn();
    if (v) return v;
    await delay(200);
  } while (Date.now() < deadline);
  throw Error(timeoutMessage());
}
async function start() {
  child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  await until(async () => {
    if (child.exitCode !== null) throw Error("服务已退出");
    return fetch(url + "/api/health").then(
      (r) => r.ok,
      () => false,
    );
  });
  const me = await fetch(url + "/api/me");
  cookie = me.headers.get("set-cookie").split(";")[0];
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const finished = once(child, "exit");
  child.kill("SIGTERM");
  await finished;
}
async function api(path, body, method = body === undefined ? "GET" : "POST", auth = { cookie }) {
  const r = await fetch(url + path, {
    method,
    headers: { ...auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(r.status + " " + JSON.stringify(result));
  return result;
}
try {
  await start();
  const project = "Demo/Greeting",
    sourceId = "fixture-issue-1",
    goal = "仅改 greeting.txt，将其改成 Hello, OPC OS! 加一个换行。运行现有 greeting.test.mjs，保留测试文件原样。";
  const proposal = {
    project,
    kind: "issue",
    sourceId,
    title: goal,
    rationale: "可用仓库已有的测试复现问候语失败",
    evidence: ["greeting.test.mjs"],
    impact: 5,
    confidence: 5,
    effort: 1,
  };
  const item = await api("/api/opc/opportunities", proposal);
  await api("/api/opc/policy", { project, enabled: true });
  const selected = await until(async () =>
    (await api("/api/opc/opportunities?project=" + encodeURIComponent(project))).opportunities.find(
      (i) => i.id === item.id && i.runId,
    ),
  );
  activeRunId = selected.runId;
  const path = "/api/workflows/" + selected.runId;
  let run = await api(path);
  assert.equal(run.workspace, repo);
  assert.equal(run.attempts.length, 0);
  assert.equal((await api("/api/opc/opportunities", proposal)).id, item.id);
  await stop();
  await start();
  run = await api(path);
  assert.equal(run.attempts.length, 0);
  assert.equal((await api("/api/workflows")).runs.length, 1);
  if (interactive) {
    await api("/api/zoom/projects", { name: "Demo" });
    await api("/api/zoom/company/projects", { product: "Demo", name: "Greeting" });
    const repository = JSON.parse(readFileSync(join(root, "examples/gateway-repository-snapshot.json"), "utf8"));
    await api("/api/zoom/projects/sync", { name: "ChromeGate", repository }, "POST", {
      authorization: "Bearer " + token,
    });
    const catalog = await runCapabilities(["import", "--verified", "--repo", repository.fullName], api);
    const [gateway] = catalog.registered;
    assert.ok(gateway, "演示需从已登记的原仓维护项目导入固定版本");
    const consumer = { product: "店铺实验", project: "草稿检查" };
    await api("/api/zoom/projects", { name: consumer.product });
    await api("/api/zoom/company/projects", { product: consumer.product, name: consumer.project });
    const requestPath = "/api/opc/capabilities/requests";
    await api(requestPath, {
      ...consumer,
      capabilityId: gateway.id,
      requestId: "demo-gateway-adoption",
      mode: "reuse",
      title: "用 ChromeGate 预检实验场景",
      detail: "先用原仓 verify --dry-run 检查场景结构。实验只引用该接口与版本。",
    });
    const maintenance = await api(requestPath, {
      ...consumer,
      capabilityId: gateway.id,
      requestId: "demo-gateway-gap",
      mode: "gap",
      title: "为场景检查回执附上店铺实验编号（演示需求）",
      detail:
        "影响范围：两项草稿实验共用同一场景时，需要按回执对回各自实验。\n验收办法：给两次检查传不同实验编号，验证回执能分别定位。本条用于演练原仓提需求，实际支持情况仍待维护方核对。",
    });
    const originalLine = (await api("/api/opc/business/lines")).lines.find((line) => line.id === "shop");
    const { id, ...line } = originalLine;
    await api(
      "/api/opc/business/lines/" + id,
      {
        ...line,
        assets: [
          {
            kind: "project",
            name: "ChromeGate Gateway 场景检查 · " + gateway.version.slice(0, 8),
            reference: "#capabilities?capability=" + gateway.id,
          },
        ],
      },
      "PUT",
    );
    const trial = await api("/api/opc/business/lines/shop/trials", {
      requestId: "demo-drafts",
      title: "抽查商品草稿字段（演示）",
      hypothesis: "上架前的字段检查能否减少人工返工？",
      metric: "小样本里发现几处漏填，误报几次",
      scope: "仅合成草稿，记录检查结果",
    });
    await api("/api/opc/business/trials/" + trial.id + "/evidence", {
      eventId: "sample",
      kind: "observation",
      note: "合成草稿中发现一处缺少规格的样例，供讨论是否增加检查项。",
      reference: "演示数据／草稿样例 A",
    });
    await api("/api/opc/business/trials/" + trial.id + "/review", {});
    const connection = join(dir, "submit.env");
    writeFileSync(connection, "KUNLUN_URL=" + url + "\nWORKFLOW_SUBMIT_TOKEN=" + token + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      "公司总览",
      url + "/#overview",
      "\n业务线",
      url + "/#business-lines?line=shop",
      "\n开源能力",
      url + "/#capabilities?capability=" + gateway.id,
      "\n原仓维护需求",
      url + "/#capabilities?request=" + maintenance.id,
      "\n待你确认",
      url + "/#workflows/" + run.id,
      "\n临时 CLI 连接文件",
      connection,
    );
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void stop());
    await once(child, "exit");
  } else {
    const decide = async (card, extra = {}) =>
      api(path + "/decisions", {
        revision: card.revision,
        cardId: card.id,
        action: "approve",
        note: "临时仓库演示的测试操作者",
        ...extra,
      });
    await decide(run.cards.find((c) => c.kind === "plan"));
    console.log("已核对重复来源和重启；测试操作者批准计划，等待", host, runnerLabel);
    let pendingReceipt;
    run = await until(
      async () => {
        const state = await api(path);
        pendingReceipt = state.attempts.find((a) => a.state === "unknown");
        const problem = state.attempts.find((a) => a.state === "failed");
        if (problem)
          throw Error("现场需核对：" + (problem.evidence?.summary || problem.problem) + " " + problem.worktree);
        return state.cards.some((c) => c.kind === "final" && c.status === "open") && state;
      },
      implementer ? 600000 : 120000,
      () => pendingReceipt ? "待对账：" + pendingReceipt.problem + " " + pendingReceipt.worktree : "等待工作流回执超时",
    );
    await decide(run.cards.find((c) => c.kind === "final"), !keep ? { cleanup: true } : {});
    run = await api(path);
    assert.equal(run.summary.phase, "complete");
    if (!keep) assert.ok(run.cleanedAt, "最终验收应清理执行现场");
    assert.equal(new Set(run.attempts.map((a) => a.worktree)).size, 2);
    assert.ok(run.attempts.every((a) => a.evidence?.checks.some((test) => test.exitCode === 0)));
    assert.equal(readFileSync(join(repo, "greeting.txt"), "utf8"), "Hello\n");
    assert.equal(git("status", "--porcelain"), "");
    if (keep) {
      const output = join(dir, "evidence.json");
      writeFileSync(output, JSON.stringify({ host, runner: runnerLabel, selection: selected, run }, null, 2));
      console.log("完成。自动选题、审前零派发、重启去重、实现与独立评审、最终验收。证据", output);
    } else {
      console.log("完成。自动选题、审前零派发、重启去重、实现与独立评审、最终验收（临时目录与执行现场已自动清理；如需保留请加 --keep）。");
    }
  }
} finally {
  await stop();
  if (!keep) {
    if (host === "herdr" && activeRunId) await cleanupHerdrRun(activeRunId, { env });
    rmSync(dir, { recursive: true, force: true });
  }
}
