import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type {
  ArchiveTombstoneResult,
  AutoLinkResult,
  CanvasDetail,
  CanvasEdge,
  CanvasExportResult,
  CanvasNode,
  CanvasSummary,
  ExpandSpaceResult,
  OcrRecognizeResult,
  RestoreTombstoneResult,
  SemanticSearchResult,
} from "./knowledge-canvas-types.ts";
import { ApiError } from "./server/logic.ts";
import { localSemanticVector, ProvidersStore } from "./server/providers.ts";
import {
  KnowledgeCanvasStore,
  registerKnowledgeCanvasRoutes,
} from "./server/knowledge-canvas.ts";

function setupEnv(options: Parameters<typeof KnowledgeCanvasStore.prototype.setHooks>[0] extends never ? never : {
  hooks?: ConstructorParameters<typeof KnowledgeCanvasStore>[2] extends infer O
    ? O extends { hooks?: infer H }
      ? H
      : never
    : never;
  fetchImpl?: typeof fetch;
} = {}) {
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  const store = new KnowledgeCanvasStore(db, providers, {
    hooks: options.hooks,
    fetchImpl: options.fetchImpl,
  });
  return { db, providers, store };
}

test("1. Canvas CRUD, node CRUD, viewport/position persistence, and cascading deletes", async () => {
  const { store } = setupEnv();

  const c1 = store.createCanvas({
    name: "OPC 商业架构思考空间",
    description: "梳理一人公司产品矩阵与语义共振",
  });
  assert.ok(c1.id.startsWith("cv_"));
  assert.equal(c1.nodeCount, 0);
  assert.equal(c1.edgeCount, 0);
  assert.deepEqual(c1.viewport, { x: 0, y: 0, zoom: 1 });

  const updatedCanvas = store.updateCanvas(c1.id, {
    name: "OPC 战略主画布",
    viewport: { x: -240, y: 120, zoom: 1.35 },
  });
  assert.equal(updatedCanvas.name, "OPC 战略主画布");
  assert.deepEqual(updatedCanvas.viewport, { x: -240, y: 120, zoom: 1.35 });

  const n1 = await store.createNode(c1.id, {
    type: "note",
    title: "核心洞察：离线 License 变现",
    content: { text: "通过本地 Ed25519 验签降低基础设施成本", tags: ["monetization", "license"] },
    position: { x: 100, y: 180 },
    size: { width: 300, height: 190 },
  });
  assert.equal(n1.hasEmbedding, true);
  assert.equal(n1.embeddingSource, "local");
  assert.deepEqual(n1.position, { x: 100, y: 180 });

  const n2 = await store.createNode(c1.id, {
    type: "task",
    title: "落地本地验签 SDK",
    content: { description: "封装 TypeScript 验签模块" },
    position: { x: 460, y: 180 },
  });

  const edge = store.createEdge(c1.id, {
    sourceId: n1.id,
    targetId: n2.id,
    type: "derives",
    label: "落地执行",
  });
  assert.equal(edge.type, "derives");

  const moved = await store.updateNode(c1.id, n1.id, {
    position: { x: 145, y: 215 },
    content: { text: "通过本地 Ed25519 验签降低基础设施成本并支持离线激活" },
  });
  assert.deepEqual(moved.position, { x: 145, y: 215 });
  assert.deepEqual(moved.content.tags, ["monetization", "license"]);

  const detail = store.getCanvas(c1.id);
  assert.equal(detail.canvas.nodeCount, 2);
  assert.equal(detail.canvas.edgeCount, 1);
  assert.deepEqual(detail.canvas.viewport, { x: -240, y: 120, zoom: 1.35 });

  const listActive = store.listCanvases(false);
  assert.equal(listActive.length, 1);
  assert.equal(listActive[0].nodeCount, 2);
  assert.equal(listActive[0].edgeCount, 1);

  // Archive filtering
  store.updateCanvas(c1.id, { isArchived: true });
  assert.equal(store.listCanvases(false).length, 0);
  assert.equal(store.listCanvases(true).length, 1);

  // Deleting node cascades connected edges
  const delNode = store.deleteNode(c1.id, n1.id);
  assert.equal(delNode.deleted, true);
  assert.equal(delNode.removedEdges, 1);
  assert.equal(store.getCanvas(c1.id).edges.length, 0);

  // Deleting canvas removes everything cleanly
  const delCanvas = store.deleteCanvas(c1.id);
  assert.equal(delCanvas.deleted, true);
  assert.throws(() => store.getCanvas(c1.id), (err: unknown) => err instanceof ApiError && err.status === 404);
});

test("2. Bidirectional warp portal creation and reciprocal linkage across canvases", async () => {
  const { store } = setupEnv();
  const canvasA = store.createCanvas({ name: "主战略画布 A" });
  const canvasB = store.createCanvas({ name: "增长实验画布 B" });

  // Self-portal is rejected
  await assert.rejects(
    () =>
      store.createNode(canvasA.id, {
        type: "portal",
        title: "错误自循环任意门",
        targetCanvasId: canvasA.id,
        bidirectional: true,
      }),
    (err: unknown) => err instanceof ApiError && err.status === 400,
  );

  const portalA = await store.createNode(canvasA.id, {
    type: "portal",
    title: "穿越至增长实验",
    targetCanvasId: canvasB.id,
    bidirectional: true,
    position: { x: 300, y: 120 },
  });

  assert.equal(portalA.type, "portal");
  assert.equal(portalA.content.targetCanvasId, canvasB.id);
  assert.equal(portalA.content.targetCanvasName, "增长实验画布 B");
  assert.equal(portalA.content.bidirectional, true);
  assert.ok(typeof portalA.content.reciprocalNodeId === "string");
  assert.ok(portalA.reciprocalNode, "should return reciprocal portal node");

  const detailB = store.getCanvas(canvasB.id);
  assert.equal(detailB.nodes.length, 1);
  const portalB = detailB.nodes[0];
  assert.equal(portalB.id, portalA.content.reciprocalNodeId);
  assert.equal(portalB.type, "portal");
  assert.equal(portalB.content.targetCanvasId, canvasA.id);
  assert.equal(portalB.content.targetCanvasName, "主战略画布 A");
  assert.equal(portalB.content.reciprocalNodeId, portalA.id);
});

test("3. Ink node stores {x, y, pressure, t} strokes + local OCR analyzer and mocked remote OCR", async () => {
  let remoteCalled = false;
  let capturedUrl = "";
  const mockFetch: typeof fetch = async (input, init) => {
    remoteCalled = true;
    capturedUrl = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.ok(body.imageBase64 || body.imageUrl);
    return new Response(
      JSON.stringify({
        text: "手写架构草图：知识共振层 -> 语义指南针 -> 自动连线",
        confidence: 0.96,
        blocks: [
          { text: "知识共振层", bbox: { x: 10, y: 10, width: 120, height: 28 } },
          { text: "语义指南针 -> 自动连线", bbox: { x: 10, y: 48, width: 210, height: 28 } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { providers, store } = setupEnv({ fetchImpl: mockFetch });
  const canvas = store.createCanvas({ name: "手写墨迹草图板" });

  const strokes = [
    {
      color: "#232d27",
      width: 2.5,
      points: [
        { x: 12, y: 20, pressure: 0.45, t: 1000 },
        { x: 48, y: 22, pressure: 0.72, t: 1025 },
        { x: 96, y: 21, pressure: 0.61, t: 1052 },
      ],
    },
    {
      color: "#8d3b24",
      width: 3,
      points: [
        { x: 15, y: 88, pressure: 0.55, t: 1400 },
        { x: 75, y: 92, pressure: 0.8, t: 1440 },
      ],
    },
  ];

  const inkNode = await store.createNode(canvas.id, {
    type: "ink",
    title: "白板随手写",
    content: { strokes, hintText: "第一行：语义共振\n第二行：自动连线" },
    position: { x: 80, y: 90 },
  });

  const savedStrokes = inkNode.content.strokes as typeof strokes;
  assert.equal(savedStrokes.length, 2);
  assert.deepEqual(savedStrokes[0].points[1], { x: 48, y: 22, pressure: 0.72, t: 1025 });

  // Local OCR fallback when remote OCR service is disabled
  const localOcr = await store.ocrRecognize({
    strokes,
    hintText: "第一行：语义共振\n第二行：自动连线",
  });
  assert.equal(localOcr.mode, "local_ink_analyzer");
  assert.equal(localOcr.stats.strokeCount, 2);
  assert.equal(localOcr.stats.pointCount, 5);
  assert.equal(localOcr.stats.lineGroupCount, 2);
  assert.ok(localOcr.stats.bbox !== null);
  assert.match(localOcr.text, /语义共振/);
  assert.equal(remoteCalled, false);

  // Local geometry-only OCR without hintText still produces structured output
  const localGeoOnly = await store.ocrRecognize({ strokes });
  assert.equal(localGeoOnly.mode, "local_ink_analyzer");
  assert.equal(localGeoOnly.blocks.length, 2);
  assert.match(localGeoOnly.text, /2 笔/);

  // Remote OCR when enabled in ProvidersStore
  providers.update({
    services: { ocr: { enabled: true, endpoint: "https://ocr.mock.local/recognize" } },
  });
  const remoteOcr = await store.ocrRecognize({
    imageBase64: "data:image/png;base64,iVBORw0KGgo=",
    strokes,
  });
  assert.equal(remoteCalled, true);
  assert.equal(capturedUrl, "https://ocr.mock.local/recognize");
  assert.equal(remoteOcr.mode, "remote_ocr");
  assert.equal(remoteOcr.confidence, 0.96);
  assert.match(remoteOcr.text, /知识共振层/);
  assert.equal(remoteOcr.blocks.length, 2);
});

test("4. Dynamic Space Expansion shifts nodes at >= origin on X/Y axes and prevents negative overlap", async () => {
  const { store } = setupEnv();
  const canvas = store.createCanvas({ name: "空间扩写测试画布" });

  const leftTop = await store.createNode(canvas.id, {
    type: "note",
    title: "左上锚点",
    position: { x: 100, y: 100 },
  });
  const midNode = await store.createNode(canvas.id, {
    type: "note",
    title: "边界节点",
    position: { x: 300, y: 260 },
  });
  const farNode = await store.createNode(canvas.id, {
    type: "note",
    title: "右下节点",
    position: { x: 520, y: 480 },
  });

  // Expand along X from origin=300 by +180
  const expX = store.expandSpace(canvas.id, { axis: "x", origin: 300, delta: 180 });
  assert.equal(expX.movedCount, 2);
  assert.equal(expX.delta, 180);

  let detail = store.getCanvas(canvas.id);
  const byId = () => new Map(detail.nodes.map((n) => [n.id, n.position]));
  assert.deepEqual(byId().get(leftTop.id), { x: 100, y: 100 }); // untouched (< 300)
  assert.deepEqual(byId().get(midNode.id), { x: 480, y: 260 }); // 300 + 180
  assert.deepEqual(byId().get(farNode.id), { x: 700, y: 480 }); // 520 + 180

  // Expand along Y from origin=250 by +140
  const expY = store.expandSpace(canvas.id, { axis: "y", origin: 250, delta: 140 });
  assert.equal(expY.movedCount, 2);
  detail = store.getCanvas(canvas.id);
  assert.deepEqual(byId().get(leftTop.id), { x: 100, y: 100 }); // untouched
  assert.deepEqual(byId().get(midNode.id), { x: 480, y: 400 }); // 260 + 140
  assert.deepEqual(byId().get(farNode.id), { x: 700, y: 620 }); // 480 + 140

  // Negative shrink is clamped so nodes >= origin cannot cross behind origin=300
  const shrinkX = store.expandSpace(canvas.id, { axis: "x", origin: 300, delta: -500 });
  assert.equal(shrinkX.delta, -180); // clamped from -500 to 300 - 480 = -180
  detail = store.getCanvas(canvas.id);
  assert.deepEqual(byId().get(leftTop.id), { x: 100, y: 100 });
  assert.deepEqual(byId().get(midNode.id), { x: 300, y: 400 });
  assert.deepEqual(byId().get(farNode.id), { x: 520, y: 620 });
});

test("5. Semantic Compass (cross-canvas + external memory) and Semantic Auto-Link (Chinese + English, idempotent)", async () => {
  const { store } = setupEnv({
    hooks: {
      searchExternalMemory: (_vec, queryText) => [
        {
          id: "idea_ext_1",
          kind: "company_idea",
          title: "PageLens 浏览器插件离线授权设计",
          snippet: `匹配查询 ${queryText} 的历史公司想法`,
          href: "#ideas?item=idea_ext_1",
          similarity: 0.78,
        },
        {
          id: "brief_ext_2",
          kind: "briefing",
          title: "每日简报：Chrome 扩展本地支付与许可趋势",
          snippet: "独立开发者采用离线加密许可提升转化",
          href: "#ideas?briefing=brief_ext_2",
          similarity: 0.64,
        },
      ],
    },
  });

  const canvasMain = store.createCanvas({ name: "产品变现画布" });
  const canvasOther = store.createCanvas({ name: "技术研发画布" });

  // Two high-similarity Chinese nodes
  const zhA = await store.createNode(canvasMain.id, {
    type: "note",
    title: "视频实时同声传译 Chrome 插件离线授权 License 变现",
    content: { text: "浏览器插件本地视频同传与离线 License 付费授权体系设计" },
    position: { x: 100, y: 100 },
  });
  const zhB = await store.createNode(canvasMain.id, {
    type: "note",
    title: "Chrome 浏览器插件实时视频同传离线 License 付费授权",
    content: { text: "离线授权 License 变现与 Chrome 视频实时同声传译插件方案" },
    position: { x: 450, y: 100 },
  });

  // Two high-similarity English nodes
  const enA = await store.createNode(canvasMain.id, {
    type: "note",
    title: "Autonomous AI agent git worktree parallel workflow orchestration",
    content: { text: "Multi-agent parallel execution in isolated git worktree sandboxes" },
    position: { x: 100, y: 360 },
  });
  const enB = await store.createNode(canvasMain.id, {
    type: "note",
    title: "Parallel git worktree workflow orchestration for autonomous AI agents",
    content: { text: "Isolated git worktree sandboxes running multi-agent parallel execution" },
    position: { x: 450, y: 360 },
  });

  // Unrelated node
  const unrelated = await store.createNode(canvasMain.id, {
    type: "note",
    title: "云南普洱茶古树采摘与炭焙工艺记录",
    content: { text: "春季茶叶发酵湿度温度与竹筐仓储陈化风味笔记" },
    position: { x: 820, y: 220 },
  });

  // Cross-canvas node related to Chrome plugin licensing
  const crossNode = await store.createNode(canvasOther.id, {
    type: "note",
    title: "Chrome 插件离线 License 验签实现",
    content: { text: "WebCrypto Ed25519 验签离线授权" },
    position: { x: 120, y: 120 },
  });

  // Semantic Auto-Link
  const auto1 = await store.autoLinkBySemantics(canvasMain.id, 0.55);
  assert.equal(auto1.created, 2, `expected 2 semantic pairs (zh + en), got ${auto1.created}`);
  const pairSet = new Set(
    auto1.edges.map((e) => [e.sourceId, e.targetId].sort().join("::")),
  );
  assert.ok(pairSet.has([zhA.id, zhB.id].sort().join("::")), "Chinese similar pair should auto-link");
  assert.ok(pairSet.has([enA.id, enB.id].sort().join("::")), "English similar pair should auto-link");
  assert.ok(
    auto1.edges.every(
      (e) =>
        e.type === "semantic_link" &&
        e.label.startsWith("sim=") &&
        e.sourceId !== unrelated.id &&
        e.targetId !== unrelated.id,
    ),
  );

  // Second run must NOT create duplicate links
  const auto2 = await store.autoLinkBySemantics(canvasMain.id, 0.55);
  assert.equal(auto2.created, 0);
  assert.equal(auto2.edges.length, 0);

  // Semantic Compass search across canvases + external memory
  const compass = await store.semanticSearch(canvasMain.id, "Chrome 插件 离线 License 授权", {
    topK: 10,
    threshold: 0.2,
    includeAllCanvases: true,
  });
  assert.ok(compass.results.length >= 4);
  assert.ok(compass.results.some((r) => r.nodeId === crossNode.id && r.canvasId === canvasOther.id));
  assert.ok(compass.results.some((r) => r.sourceKind === "company_idea" && r.nodeId === "idea_ext_1"));
  assert.ok(compass.results.some((r) => r.sourceKind === "briefing" && r.nodeId === "brief_ext_2"));
  // Sorted descending by score
  for (let i = 1; i < compass.results.length; i++) {
    assert.ok(compass.results[i - 1].score >= compass.results[i].score);
  }

  // External cross-canvas vector lookup for dormant memory activation
  const vecMatches = store.searchNodesByVector(
    localSemanticVector("git worktree autonomous AI agent parallel workflow"),
    5,
    0.35,
  );
  assert.ok(vecMatches.length >= 2);
  assert.ok(vecMatches.some((m) => m.nodeId === enA.id));
  assert.ok(vecMatches.some((m) => m.nodeId === enB.id));
});

test("6. Archive dimensionality reduction to Tombstone + Markdown summary + company note hook + restoreTombstone", async () => {
  const archivedNotes: Array<{ title: string; markdown: string; reference: string }> = [];
  const { store } = setupEnv({
    hooks: {
      archiveToCompanyNote: (input) => {
        archivedNotes.push(input);
        return { id: "cn_archived_001" };
      },
    },
  });

  const canvas = store.createCanvas({ name: "增长探索草稿" });
  const a = await store.createNode(canvas.id, {
    type: "note",
    title: "渠道实验 A：掘金技术深度文",
    content: { text: "拆解本地 Agent 编排实践，文末引流官网试用" },
    position: { x: 100, y: 200 },
  });
  const b = await store.createNode(canvas.id, {
    type: "note",
    title: "渠道实验 B：Reddit r/SideProject 帖",
    content: { text: "展示 30 秒动图和离线授权特性" },
    position: { x: 500, y: 400 },
  });
  const keep = await store.createNode(canvas.id, {
    type: "note",
    title: "保留节点：官网落地页",
    content: { text: "持续迭代的落地页转换模块" },
    position: { x: 900, y: 200 },
  });

  const innerEdge = store.createEdge(canvas.id, {
    sourceId: a.id,
    targetId: b.id,
    type: "derives",
    label: "复盘对比",
  });
  const boundaryEdge = store.createEdge(canvas.id, {
    sourceId: b.id,
    targetId: keep.id,
    type: "deploy_to",
    label: "导入流量",
  });

  const archived = await store.archiveNodesToTombstone(canvas.id, {
    nodeIds: [a.id, b.id],
    title: "Q1 渠道冷启动实验结案",
  });

  assert.equal(archived.archivedCount, 2);
  assert.equal(archived.summarySource, "builtin");
  assert.equal(archived.companyNoteId, "cn_archived_001");
  assert.equal(archivedNotes.length, 1);
  assert.equal(archivedNotes[0].reference, `canvas:${canvas.id}`);
  assert.match(archived.markdown, /# Q1 渠道冷启动实验结案/);
  assert.match(archived.markdown, /渠道实验 A/);
  assert.match(archived.markdown, /渠道实验 B/);
  assert.match(archived.markdown, /复盘对比/);

  assert.equal(archived.tombstone.type, "tombstone");
  assert.equal(archived.tombstone.status, "archived");
  // Centroid of (100, 200) and (500, 400) = (300, 300)
  assert.deepEqual(archived.tombstone.position, { x: 300, y: 300 });

  // Original archived nodes removed, kept node + tombstone remain
  const afterArchive = store.getCanvas(canvas.id);
  assert.equal(afterArchive.nodes.length, 2);
  assert.ok(afterArchive.nodes.some((n) => n.id === keep.id));
  assert.ok(afterArchive.nodes.some((n) => n.id === archived.tombstone.id));
  assert.equal(afterArchive.edges.length, 0);

  // Restore tombstone restores both nodes AND internal + boundary edges!
  const restored = await store.restoreTombstone(canvas.id, archived.tombstone.id);
  assert.equal(restored.restoredNodes.length, 2);
  assert.equal(restored.restoredEdges.length, 2);
  assert.ok(restored.restoredEdges.some((e) => e.id === innerEdge.id));
  assert.ok(restored.restoredEdges.some((e) => e.id === boundaryEdge.id));

  const afterRestore = store.getCanvas(canvas.id);
  assert.equal(afterRestore.nodes.length, 3);
  assert.equal(afterRestore.edges.length, 2);
  assert.ok(!afterRestore.nodes.some((n) => n.type === "tombstone"));
});

test("7. projectBriefingIsland lays out briefing cards in open area and auto-links semantically related nodes", async () => {
  const { store } = setupEnv();
  const canvas = store.createCanvas({ name: "AI 行业研究主画布" });

  const existingRelevant = await store.createNode(canvas.id, {
    type: "note",
    title: "SQLite 向量检索引擎与本地知识图谱",
    content: { text: "使用 node:sqlite 存储本地向量 embedding 与余弦相似度检索" },
    position: { x: 100, y: 120 },
  });
  const existingUnrelated = await store.createNode(canvas.id, {
    type: "note",
    title: "咖啡手冲滤杯水温萃取实验",
    content: { text: "92度热水三段式注水与耶加雪菲风味平衡" },
    position: { x: 100, y: 380 },
  });

  const projected = await store.projectBriefingIsland(canvas.id, [
    {
      id: "brief_001",
      source: "HackerNews",
      summary: "基于 node:sqlite 的本地向量 embedding 与余弦相似度知识图谱引擎实战",
      tags: ["sqlite", "embedding", "vector"],
      score: 94,
    },
    {
      id: "brief_002",
      source: "ArXiv",
      summary: "Quantum error correction lattices in superconducting qubits",
      tags: ["quantum", "physics"],
      score: 71,
    },
  ]);

  assert.equal(projected.nodes.length, 2);
  assert.ok(projected.nodes.every((n) => n.type === "briefing"));
  // Placed to the right of existing nodes (x >= 100 + 280 + 120 = 500)
  assert.ok(projected.nodes[0].position.x >= 500);
  assert.ok(projected.nodes[1].position.x > projected.nodes[0].position.x);

  // Relevant briefing automatically created a semantic_link to existingRelevant, not existingUnrelated
  assert.ok(projected.semanticEdges.length >= 1);
  assert.ok(
    projected.semanticEdges.some(
      (e) =>
        e.type === "semantic_link" &&
        e.sourceId === projected.nodes[0].id &&
        e.targetId === existingRelevant.id,
    ),
  );
  assert.ok(
    projected.semanticEdges.every(
      (e) => e.targetId !== existingUnrelated.id && e.sourceId !== existingUnrelated.id,
    ),
  );
});

test("8. End-to-end Hono HTTP routes (all CRUD, promote-task + liveTask hydration, expand-space, resonance, tombstone, export, OCR)", async () => {
  const db = new DatabaseSync(":memory:");
  const providers = new ProvidersStore(db);
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    return c.json({ error: "internal", message: String(err) }, 500);
  });

  const taskRegistry = new Map<
    string,
    { id: string; title: string; status: string; priority: number; assigneeType: string; prUrl?: string | null }
  >();

  registerKnowledgeCanvasRoutes(
    app,
    db,
    providers,
    () => ({ type: "user", id: "u_owner", name: "Founder" }),
    {
      hooks: {
        createTaskFromNode: ({ title }) => {
          const id = "tsk_live_42";
          taskRegistry.set(id, {
            id,
            title,
            status: "in_progress",
            priority: 1,
            assigneeType: "agent",
            prUrl: "https://github.com/opc/demo/pull/42",
          });
          return { id, status: "in_progress", priority: 1 };
        },
        getTaskSummary: (taskId) => taskRegistry.get(taskId) ?? null,
      },
    },
  );

  const req = async <T>(path: string, init?: RequestInit): Promise<{ status: number; data: T }> => {
    const res = await app.request(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  };

  // Create two canvases
  const c1 = await req<CanvasSummary>("/api/opc/canvases", {
    method: "POST",
    body: JSON.stringify({ name: "HTTP 端到端画布", description: "覆盖全接口" }),
  });
  assert.equal(c1.status, 201);
  const c2 = await req<CanvasSummary>("/api/opc/canvases", {
    method: "POST",
    body: JSON.stringify({ name: "目标传送画布" }),
  });
  assert.equal(c2.status, 201);

  const list = await req<{ canvases: CanvasSummary[] }>("/api/opc/canvases");
  assert.equal(list.status, 200);
  assert.equal(list.data.canvases.length, 2);

  // Create nodes
  const n1 = await req<CanvasNode>(`/api/opc/canvases/${c1.data.id}/nodes`, {
    method: "POST",
    body: JSON.stringify({
      type: "note",
      title: "实时语音翻译插件架构设计",
      content: { text: "Chrome 扩展音频捕获与离线授权验证" },
      position: { x: 100, y: 100 },
    }),
  });
  assert.equal(n1.status, 201);

  const n2 = await req<CanvasNode>(`/api/opc/canvases/${c1.data.id}/nodes`, {
    method: "POST",
    body: JSON.stringify({
      type: "note",
      title: "Chrome 扩展实时语音翻译与离线授权验证",
      content: { text: "实时语音翻译插件架构设计与离线授权" },
      position: { x: 420, y: 100 },
    }),
  });
  assert.equal(n2.status, 201);

  // Promote n1 to live task & check liveTask hydration via GET /canvases/:id
  const promoted = await req<CanvasNode>(
    `/api/opc/canvases/${c1.data.id}/nodes/${n1.data.id}/promote-task`,
    { method: "POST", body: JSON.stringify({ project: "PageLens" }) },
  );
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.type, "task");
  assert.equal(promoted.data.content.taskId, "tsk_live_42");
  assert.equal(promoted.data.liveTask?.status, "in_progress");
  assert.equal(promoted.data.liveTask?.prUrl, "https://github.com/opc/demo/pull/42");

  // Bidirectional portal
  const portal = await req<CanvasNode>(`/api/opc/canvases/${c1.data.id}/nodes`, {
    method: "POST",
    body: JSON.stringify({
      type: "portal",
      title: "去往目标画布",
      targetCanvasId: c2.data.id,
      bidirectional: true,
      position: { x: 760, y: 100 },
    }),
  });
  assert.equal(portal.status, 201);
  assert.ok(portal.data.reciprocalNode);

  // Expand space along X
  const expanded = await req<ExpandSpaceResult>(`/api/opc/canvases/${c1.data.id}/expand-space`, {
    method: "POST",
    body: JSON.stringify({ axis: "x", origin: 400, delta: 200 }),
  });
  assert.equal(expanded.status, 200);
  assert.equal(expanded.data.movedCount, 2);

  // Semantic Auto-Link
  const linked = await req<AutoLinkResult>(`/api/opc/canvases/${c1.data.id}/auto-link`, {
    method: "POST",
    body: JSON.stringify({ threshold: 0.45 }),
  });
  assert.equal(linked.status, 200);
  assert.ok(linked.data.created >= 1);

  // Semantic Search
  const searched = await req<SemanticSearchResult>(
    `/api/opc/canvases/${c1.data.id}/semantic-search`,
    {
      method: "POST",
      body: JSON.stringify({ query: "Chrome 离线授权 语音翻译", topK: 5, threshold: 0.1 }),
    },
  );
  assert.equal(searched.status, 200);
  assert.ok(searched.data.results.length >= 2);

  // Manual edge + delete edge
  const manualEdge = await req<CanvasEdge>(`/api/opc/canvases/${c1.data.id}/edges`, {
    method: "POST",
    body: JSON.stringify({
      sourceId: n2.data.id,
      targetId: portal.data.id,
      type: "portal",
      label: "跨空间引用",
    }),
  });
  assert.equal(manualEdge.status, 201);
  const delEdge = await req<{ deleted: boolean }>(
    `/api/opc/canvases/${c1.data.id}/edges/${manualEdge.data.id}`,
    { method: "DELETE" },
  );
  assert.equal(delEdge.status, 200);
  assert.equal(delEdge.data.deleted, true);

  // OCR endpoint
  const ocr = await req<OcrRecognizeResult>("/api/opc/canvases/ocr", {
    method: "POST",
    body: JSON.stringify({
      strokes: [{ points: [{ x: 5, y: 10, pressure: 0.6, t: 100 }, { x: 40, y: 12, pressure: 0.7, t: 130 }] }],
      hintText: "手写待办：发布 v1.0",
    }),
  });
  assert.equal(ocr.status, 200);
  assert.equal(ocr.data.mode, "local_ink_analyzer");
  assert.match(ocr.data.text, /发布 v1\.0/);

  // Archive to tombstone + export Markdown + restore
  const archived = await req<ArchiveTombstoneResult>(
    `/api/opc/canvases/${c1.data.id}/archive-tombstone`,
    { method: "POST", body: JSON.stringify({ nodeIds: [n2.data.id], title: "单节点结案" }) },
  );
  assert.equal(archived.status, 201);
  assert.equal(archived.data.tombstone.type, "tombstone");

  const exported = await req<CanvasExportResult>(`/api/opc/canvases/${c1.data.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.data.markdown, /# HTTP 端到端画布/);
  assert.match(exported.data.markdown, /单节点结案/);

  const rawExportRes = await app.request(`/api/opc/canvases/${c1.data.id}/export?format=raw`);
  assert.equal(rawExportRes.status, 200);
  assert.match(rawExportRes.headers.get("content-type") ?? "", /text\/markdown/);

  const restored = await req<RestoreTombstoneResult>(
    `/api/opc/canvases/${c1.data.id}/tombstones/${archived.data.tombstone.id}/restore`,
    { method: "POST", body: "{}" },
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.data.restoredNodes.length, 1);

  // Verify liveTask hydration via GET canvas
  const finalDetail = await req<CanvasDetail>(`/api/opc/canvases/${c1.data.id}`);
  assert.equal(finalDetail.status, 200);
  const hydratedTask = finalDetail.data.nodes.find((n) => n.id === n1.data.id);
  assert.equal(hydratedTask?.liveTask?.id, "tsk_live_42");
  assert.equal(hydratedTask?.liveTask?.status, "in_progress");

  // Patch viewport + delete canvas
  const patched = await req<CanvasSummary>(`/api/opc/canvases/${c1.data.id}`, {
    method: "PATCH",
    body: JSON.stringify({ viewport: { x: 40, y: -60, zoom: 0.9 } }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.data.viewport, { x: 40, y: -60, zoom: 0.9 });

  const removed = await req<{ deleted: boolean }>(`/api/opc/canvases/${c1.data.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.deleted, true);
});
