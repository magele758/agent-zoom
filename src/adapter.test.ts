import { completeCli } from "./cli-driver.ts";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { LEASE_MS } from "./server/logic.ts";
import {
  HEARTBEAT_EVERY_MS,
  completeOpenAI,
  completePpeng,
  echoAction,
  postWebhook,
  ppengWorktreeBranch,
  readWebhookResponse,
  runAdapterTask,
  webhookPayload,
  type AdapterTask,
  type RoomApi,
} from "./adapter.ts";

test("echo copies the task body and does not touch the network", () => {
  const action = echoAction({
    id: "research-task-1",
    title: "支付失败",
    body: "研究发现：失败集中在超时重试。",
    stepRole: "research",
  });
  assert.equal(action.type, "deliver");
  if (action.type !== "deliver") return;
  assert.equal(action.ref, "echo:research");
  assert.equal(action.body, "研究发现：失败集中在超时重试。");
});

test("echo review passes and echo qa does not claim a screenshot", () => {
  const review = echoAction({ id: "rev-1", title: "复核", body: "研究", stepRole: "review" });
  assert.equal(review.type, "conclude");
  if (review.type === "conclude") assert.equal(review.verdict, "pass");
  const qa = echoAction({ id: "qa-1", title: "QA", body: "去测", stepRole: "qa" });
  assert.equal(qa.type, "deliver");
  if (qa.type === "deliver") {
    assert.equal(qa.verdict, "pass");
    assert.equal(qa.screenshots.length, 0);
  }
});

test("webhook posts the task json and keeps a local screenshot path", async () => {
  const payload = webhookPayload({
    id: "task-qa",
    title: "检查结账",
    body: "引用：branch/pay",
    acceptance: "按钮可点",
    stepRole: "qa",
  });
  assert.equal(payload.role, "qa");
  assert.equal(payload.taskId, "task-qa");
  let seen: { url?: string; secret?: string; body?: unknown } = {};
  const data = await postWebhook(
    "http://grok.local/hook",
    "s3cret",
    payload,
    (async (url: string, init?: RequestInit) => {
      seen = {
        url,
        secret: new Headers(init?.headers).get("x-webhook-secret") ?? undefined,
        body: JSON.parse(String(init?.body)),
      };
      return new Response(
        JSON.stringify({
          verdict: "fail",
          ref: "qa:task-qa",
          summary: "动画卡住了",
          body: "结账按钮点下去没有反馈。",
          screenshots: ["/home/grok/shots/checkout.png"],
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  );
  assert.equal(seen.url, "http://grok.local/hook");
  assert.equal(seen.secret, "s3cret");
  assert.equal((seen.body as { acceptance: string }).acceptance, "按钮可点");
  const action = readWebhookResponse(data, "qa");
  assert.equal(action.type, "deliver");
  if (action.type !== "deliver") return;
  assert.equal(action.verdict, "fail");
  assert.match(action.body, /\/home\/grok\/shots\/checkout\.png/);
});

test("openai adapter sends the key and returns the model text", async () => {
  await assert.rejects(() => completeOpenAI({ id: "t1", title: "x", body: "y" }, {}, fetch), /OPENAI_API_KEY/);
  const action = await completeOpenAI(
    { id: "design-99", title: "PRD", body: "研究发现：失败集中在超时重试。", stepRole: "product" },
    { apiKey: "test-key", baseUrl: "http://openai.local/v1", model: "gpt-test" },
    (async (url: string, init?: RequestInit) => {
      assert.equal(url, "http://openai.local/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      return new Response(JSON.stringify({ choices: [{ message: { content: "PRD：先重试再提示。" } }] }), { status: 200 });
    }) as typeof fetch,
  );
  assert.match(action.body, /先重试再提示/);
  assert.equal(action.ref, "openai:design-9");
});

test("heartbeat interval stays inside the lease", () => {
  assert.equal(HEARTBEAT_EVERY_MS, Math.min(Math.floor(LEASE_MS / 3), 5 * 60 * 1000));
  assert.ok(HEARTBEAT_EVERY_MS >= 2 * 60 * 1000);
  assert.ok(HEARTBEAT_EVERY_MS <= 5 * 60 * 1000);
});

function abortSleep() {
  return (_ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

function room(calls: string[], task: AdapterTask): RoomApi {
  return {
    getTask: async () => task,
    claim: async () => {
      calls.push("claim");
    },
    heartbeat: async () => {
      calls.push("heartbeat");
    },
    deliver: async () => {
      calls.push("deliver");
    },
    conclude: async () => {
      calls.push("conclude");
    },
    decline: async () => {
      calls.push("decline");
    },
    release: async () => {
      calls.push("release");
    },
  };
}

test("the driver claims before work and heartbeats while it runs", async () => {
  const calls: string[] = [];
  const task: AdapterTask = {
    id: "build-1",
    title: "做支付",
    body: "改结账",
    status: "open",
    stepRole: "build",
    assigneeHandle: "cursor",
    handles: ["cursor", "ppeng"],
  };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sleeps = 0;
  const result = await runAdapterTask({
    task,
    handle: "cursor",
    api: {
      ...room(calls, task),
      heartbeat: async () => {
        calls.push("heartbeat");
        release();
      },
    },
    sleep: async (_ms, signal) => {
      sleeps += 1;
      if (sleeps === 1) return;
      await abortSleep()(_ms, signal);
    },
    act: async () => {
      calls.push("act");
      await gate;
      calls.push("act-done");
      return { type: "deliver", ref: "wt/pay", summary: "好了", body: "好了", screenshots: [] };
    },
  });
  assert.equal(result, "delivered");
  assert.deepEqual(calls, ["claim", "act", "heartbeat", "act-done", "deliver"]);
});

test("a driver error declines a fallback step and releases a single handle", async () => {
  const declined: string[] = [];
  const task: AdapterTask = {
    id: "build-2",
    title: "做支付",
    body: "改结账",
    status: "open",
    stepRole: "build",
    assigneeHandle: "ppeng",
    handles: ["cursor", "ppeng"],
  };
  const declinedResult = await runAdapterTask({
    task,
    handle: "ppeng",
    api: room(declined, task),
    sleep: abortSleep(),
    act: async () => {
      throw new Error("ppeng 超时");
    },
  });
  assert.equal(declinedResult, "declined");
  assert.deepEqual(declined, ["claim", "decline"]);

  const released: string[] = [];
  const alone: AdapterTask = { ...task, id: "qa-2", stepRole: "qa", assigneeHandle: "grok", handles: ["grok"] };
  const releasedResult = await runAdapterTask({
    task: alone,
    handle: "grok",
    api: room(released, alone),
    sleep: abortSleep(),
    act: async () => {
      throw new Error("模型没有返回正文");
    },
  });
  assert.equal(releasedResult, "released");
  assert.deepEqual(released, ["claim", "release"]);
});

test("review concludes without claiming, and a review error does not decline", async () => {
  const calls: string[] = [];
  const task: AdapterTask = {
    id: "rev-1",
    title: "复核",
    body: "研究",
    status: "open",
    stepRole: "review",
    handles: ["chatgpt", "grok", "ppeng"],
  };
  const passed = await runAdapterTask({
    task,
    handle: "ppeng",
    api: room(calls, task),
    sleep: abortSleep(),
    act: async () => ({ type: "conclude", verdict: "pass", body: "可以" }),
  });
  assert.equal(passed, "concluded");
  assert.deepEqual(calls, ["conclude"]);

  const failed: string[] = [];
  const result = await runAdapterTask({
    task,
    handle: "ppeng",
    api: room(failed, task),
    sleep: abortSleep(),
    act: async () => {
      throw new Error("ppeng 超时");
    },
  });
  assert.equal(result, "skipped");
  assert.deepEqual(failed, []);
});

test("an ordinary card with no step handle is still claimed", async () => {
  const calls: string[] = [];
  const task: AdapterTask = { id: "plain-1", title: "按钮", body: "补禁用态", status: "open", assigneeHandle: "" };
  const result = await runAdapterTask({
    task,
    handle: "chatgpt",
    api: room(calls, task),
    sleep: abortSleep(),
    act: async () => echoAction(task),
  });
  assert.equal(result, "delivered");
  assert.equal(calls[0], "claim");
  assert.equal(calls.at(-1), "deliver");
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("ppeng build posts the repo and delivers the worktree branch", async () => {
  let seen: { path?: string; auth?: string | string[]; body?: { message?: string } } = {};
  const server = await listen(async (req, res) => {
    seen = { path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(await readBody(req)) };
    const payload = {
      summary: "改好了结账",
      body: "重试超时后提示失败。",
      ref: "",
    };
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ session: { id: "sess-1" }, latestAssistant: JSON.stringify(payload) }));
  });
  try {
    const task = { id: "task-abcdef", title: "支付", body: "修结账", stepRole: "build", acceptance: "按钮可点" };
    const action = await completePpeng(
      task,
      { baseUrl: server.url, token: "daemon-token", repoRoot: "/repos/pay", timeoutMs: "5000" },
      fetch,
    );
    assert.equal(seen.path, "/api/tasks");
    assert.equal(seen.auth, "Bearer daemon-token");
    assert.match(seen.body?.message ?? "", /\/repos\/pay/);
    assert.match(seen.body?.message ?? "", new RegExp(ppengWorktreeBranch("支付", "task-abcdef")));
    assert.equal(action.type, "deliver");
    if (action.type !== "deliver") return;
    assert.equal(action.ref, "wt/task-abcdef");
    assert.equal(action.summary, "改好了结账");
  } finally {
    await server.close();
  }
});

test("ppeng review and qa use chat json, including a fenced reply", async () => {
  const server = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { message?: string };
    const review = body.message?.includes("流水线的review");
    const text = review
      ? "```json\n{\"verdict\":\"changes\",\"summary\":\"补来源\",\"body\":\"缺链接\"}\n```"
      : JSON.stringify({ verdict: "fail", summary: "动画卡住了", body: "按钮没反馈", ref: "qa:1", screenshots: ["/tmp/shot.png"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ session: { id: "sess-2" }, latestAssistant: text }));
  });
  try {
    const review = await completePpeng(
      { id: "rev-9", title: "复核", body: "研究", stepRole: "review" },
      { baseUrl: server.url, timeoutMs: "5000" },
      fetch,
    );
    assert.equal(review.type, "conclude");
    if (review.type === "conclude") assert.equal(review.verdict, "changes");
    const qa = await completePpeng(
      { id: "qa-9", title: "QA", body: "去测", stepRole: "qa" },
      { baseUrl: server.url, timeoutMs: "5000" },
      fetch,
    );
    assert.equal(qa.type, "deliver");
    if (qa.type === "deliver") {
      assert.equal(qa.verdict, "fail");
      assert.match(qa.body, /\/tmp\/shot.png/);
    }
  } finally {
    await server.close();
  }
});

test("ppeng reads an event stream and declines on timeout", async () => {
  const stream = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: result\ndata: ${JSON.stringify({ latestAssistant: JSON.stringify({ summary: "流式结论", body: "看完了", ref: "note:1" }), session: { id: "sess-3" } })}\n\n`);
  });
  try {
    const action = await completePpeng(
      { id: "note-1", title: "研究", body: "看日志", stepRole: "research" },
      { baseUrl: stream.url, timeoutMs: "5000" },
      fetch,
    );
    assert.equal(action.type, "deliver");
    if (action.type === "deliver") assert.equal(action.summary, "流式结论");
  } finally {
    await stream.close();
  }

  const hung = await listen(() => {
    /* 不回包，等客户端超时 */
  });
  try {
    await assert.rejects(
      () =>
        completePpeng(
          { id: "slow-1", title: "研究", body: "卡住", stepRole: "research" },
          { baseUrl: hung.url, timeoutMs: "80" },
          fetch,
        ),
      /ppeng 超时|TimeoutError|aborted/i,
    );
  } finally {
    await hung.close();
  }
});


test("CLI failures, empty reports, and aborts never produce a delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chatroom-driver-test-"));
  const binary = join(dir, "test-cli");
  const task = { id: "fixture-task", title: "fixture", body: "fixture", scope: { directories: [dir] } };
  const options = { binary, outputRoot: join(dir, "runs"), timeoutMs: 5000 };
  writeFileSync(binary, "#!/usr/bin/env node\nprocess.exit(2);\n"); chmodSync(binary, 0o700);
  await assert.rejects(() => completeCli(task, "codex", options), /退出码 2/);
  writeFileSync(binary, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await assert.rejects(() => completeCli(task, "codex", options), /没有可交付/);
  writeFileSync(binary, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n");
  const controller = new AbortController();
  const running = completeCli(task, "codex", { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(() => running, /已终止/);
  await assert.rejects(() => completeCli({ ...task, stepRole: "qa" }, "codex", options), /只执行开发/);
  await assert.rejects(() => completeCli({ id: "no-dir", title: "x", body: "x" }, "codex", options), /需要存在的频道工作目录/);
});
