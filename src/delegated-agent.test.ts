import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "./server/logic.ts";
import { StageWorkStore } from "./server/stage-work.ts";
import { createApp } from "./server/http.ts";

test("同一委派只通知指定的 MCP 执行人一次，可用自己的凭证认领并回交真实证据", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const user = store.localUser();
  const room = store.localRoom();
  const enroll = (handle: string) =>
    store.enroll(store.createJoinCode(user, room).code, handle, "custom", "build", 1);
  const worker = enroll("worker"),
    other = enroll("reader");
  const stage = new StageWorkStore(store.db);
  const assigned = stage.create({
    requestId: "request-a",
    product: "",
    stage: "research",
    templateId: "inbox-delegation",
    title: "查明影响范围",
    inputs: "原任务 123",
    goal: "核对版本",
    deliverable: "版本号和来源",
    acceptance: "可查原始提交",
    target: "coding-agent",
    requestedAgent: "Worker",
  }).work;
  const base = "/api/agent/delegations";
  const {app}=createApp(store);
  async function callTool(token:string,name:string,args:Record<string,unknown>) {
    const response=await app.request("/mcp",{method:"POST",headers:{authorization:"Bearer "+token,accept:"application/json, text/event-stream","content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
    assert.equal(response.status,200);
    return (await response.json()).result;
  }
  const request = (token: string, path: string, value?: unknown) =>
    app.request(base + path, {
      method: value ? "POST" : "GET",
      headers: { authorization: "Bearer "+token, "content-type": "application/json" },
      body: value ? JSON.stringify(value) : undefined,
    });
  const path = "/" + assigned.id;
  assert.equal((await request(other.token, path)).status, 404);
  store.notifyStageOffer(assigned.id, "reader");
  store.notifyStageOffer(assigned.id, "worker");
  store.notifyStageOffer(assigned.id, "Worker");
  assert.equal(store.inboxAfter(worker.agent.id, 0).filter((e) => e.event_type === "stage_offer").length, 1);
  assert.equal(store.inboxAfter(other.agent.id, 0).filter((e) => e.event_type === "stage_offer").length, 0);
  assert.equal((await (await request(worker.token, "")).json()).items[0].id, assigned.id);
  assert.equal((await request(other.token, path + "/claim", { session: "reader-session" })).status, 404);
  assert.equal((await callTool(other.token,"delegated_work",{id:assigned.id})).isError,true);
  const received=await callTool(worker.token,"delegated_work",{id:assigned.id});
  assert.equal(JSON.parse(received.content[0].text).work.id,assigned.id);
  const claimed=await callTool(worker.token,"claim_delegated_work",{id:assigned.id,session:"stable-session"});
  const {claimId}=JSON.parse(claimed.content[0].text);
  assert.ok(claimId);
  assert.equal((await request(worker.token, path + "/renew", { claimId })).status, 200);
  const done = {
    claimId,
    kind: "completed",
    eventId: "answer",
    body: "版本已核对",
    evidence: ["原始提交 abc123"],
  };
  assert.equal((await request(other.token, path + "/report", done)).status, 404);
  assert.equal((await request(worker.token, path + "/report", done)).status, 200);
  assert.equal((await request(worker.token, path + "/report", done)).status, 200);
  const result = await (await request(worker.token, path)).json();
  assert.equal(result.work.status, "completed");
  assert.equal(result.messages.filter((m: { kind: string }) => m.kind === "completed").length, 1);
  assert.equal((await (await request(worker.token, "")).json()).items.length, 0);
});
