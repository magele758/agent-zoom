import assert from "node:assert/strict";
import { test } from "node:test";
import { completeOpenAI, echoAction, postWebhook, readWebhookResponse, webhookPayload } from "./adapter.ts";

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
