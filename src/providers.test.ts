import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  computeSemanticVector,
  cosineSimilarity,
  localSemanticVector,
  ProvidersStore,
  SECRET_MASK,
} from "./server/providers.ts";

test("ProvidersStore persists updates, masks secrets, and preserves secrets on masked update", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ProvidersStore(db);

  const initial = store.getRedacted();
  assert.equal(initial.system.maxConcurrentAgents, 3);
  assert.ok(initial.system.protectedPaths.length >= 2);

  const updated = store.update({
    system: { maxConcurrentAgents: 5, patrolStaleDays: 10, lossKillSwitchMonths: 3 },
    models: {
      llm: { baseUrl: "https://api.example.com/v1", apiKey: "sk-real-secret-123", modelName: "deepseek-chat" },
    },
    services: {
      payment: {
        domestic: { enabled: true, appId: "app_001", appSecret: "sec_hupi_999" },
      },
    },
  });

  assert.equal(updated.system.maxConcurrentAgents, 5);
  assert.equal(updated.models.llm.apiKey, SECRET_MASK);
  assert.equal(updated.services.payment.domestic.appSecret, SECRET_MASK);

  // Raw config still holds real secrets
  const raw = store.get();
  assert.equal(raw.models.llm.apiKey, "sk-real-secret-123");
  assert.equal(raw.services.payment.domestic.appSecret, "sec_hupi_999");

  // Saving masked values preserves original secrets
  store.update({
    models: { llm: { apiKey: SECRET_MASK, modelName: "gpt-4o" } },
    services: { payment: { domestic: { appSecret: SECRET_MASK } } },
  });
  const after = store.get();
  assert.equal(after.models.llm.modelName, "gpt-4o");
  assert.equal(after.models.llm.apiKey, "sk-real-secret-123");
  assert.equal(after.services.payment.domestic.appSecret, "sec_hupi_999");
});

test("Local semantic vector engine ranks semantically similar Chinese & English texts far above unrelated texts", async () => {
  const v1 = localSemanticVector("视频实时同声传译 Chrome 插件 离线授权 License 变现");
  const v2 = localSemanticVector("Chrome 浏览器插件 实时视频同传 离线 License 付费授权");
  const v3 = localSemanticVector("Rust 分布式数据库 Raft 共识算法 存储引擎基准测试");

  const simRelated = cosineSimilarity(v1, v2);
  const simUnrelated = cosineSimilarity(v1, v3);

  assert.ok(simRelated > 0.5, `expected high similarity, got ${simRelated}`);
  assert.ok(simRelated > simUnrelated + 0.35, `related ${simRelated} should beat unrelated ${simUnrelated}`);

  const computed = await computeSemanticVector("AI agent git worktree parallel workflow");
  assert.equal(computed.source, "local");
  assert.equal(computed.dimensions, 256);
});

test("ProvidersStore health report returns structured entries offline", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new ProvidersStore(db);
  const health = await store.checkHealth();
  assert.equal(health.overall, "ok");
  assert.ok(health.entries.some((e) => e.id === "sqlite" && e.status === "ok"));
  assert.ok(health.entries.some((e) => e.id === "embedding"));
});
