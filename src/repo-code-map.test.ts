import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";
import type { RepoContent } from "./activity-index-types.ts";
import { DecisionGateway } from "./kernel/decisions.ts";
import { DomainEventBus } from "./kernel/events.ts";
import { AssetRegistry } from "./kernel/registry.ts";
import { createApp } from "./server/http.ts";
import { ApiError, openStore } from "./server/logic.ts";
import {
  buildCodeMapFromMemory,
  classifyFileLayer,
  isNoiseTreePath,
  parseSourceFileStatic,
  scanLocalRepoReadOnly,
  selectCandidateSourceFiles,
  type CodeMapRemoteFetcher,
  type RemoteTreeEntry,
} from "./server/repo-code-map.ts";
import {
  addRepoEvolutionRoutes,
  createKnowledgeCanvasProjector,
  createRepoEvolutionPool,
  RepoEvolutionService,
  type GitHubEvolutionFetcher,
  type KnowledgeCanvasStoreLike,
  type PgPoolLike,
} from "./server/repo-evolution.ts";
import type {
  AnalyzeLinkResult,
  ArchitectureClusterRecommendation,
  ArchitecturePrimitive,
  ArchitecturePrimitiveExportJson,
  CompareRepoToPrimitiveResult,
  DistillArchitecturePrimitiveResult,
  GenerateCodeMapResponse,
  GetCodeMapResponse,
  ProjectPrimitiveToCanvasResult,
  SubmitConsolidationResult,
} from "./repo-evolution-types.ts";

const FIXED_NOW = Date.parse("2026-11-26T15:00:00.000Z");

describe("Zero-Clone Static Code Map Parser (TS/JS/Vue/Python/Go/Rust)", () => {
  it("filters noise paths, lockfiles, binaries and oversized blobs while prioritizing focusPaths", () => {
    assert.equal(isNoiseTreePath("node_modules/react/index.js", 1024), true);
    assert.equal(isNoiseTreePath("dist/bundle.js", 4096), true);
    assert.equal(isNoiseTreePath("package-lock.json", 4096), true);
    assert.equal(isNoiseTreePath("assets/logo.png", 1024), true);
    assert.equal(isNoiseTreePath("src/generated.min.js", 1024), true);
    assert.equal(isNoiseTreePath("src/huge.ts", 400_000), true);
    assert.equal(isNoiseTreePath("src/core/engine.ts", 4200), false);

    const entries: RemoteTreeEntry[] = [
      { path: "node_modules/pkg/index.js", size: 1200 },
      { path: "dist/out.js", size: 5000 },
      { path: "src/index.ts", size: 1200 },
      { path: "src/core/engine.ts", size: 4800 },
      { path: "src/protocol/types.ts", size: 2200 },
      { path: "src/custom/special.ts", size: 1800 },
      { path: "tests/engine.test.ts", size: 2000 },
      { path: "README.md", size: 1500 },
    ];
    const { candidateEntries, selectedEntries } = selectCandidateSourceFiles(entries, {
      maxFiles: 6,
      focusPaths: ["src/custom/special.ts"],
    });
    assert.equal(candidateEntries.length, 5);
    assert.equal(selectedEntries[0]?.path, "src/custom/special.ts");
  });

  it("extracts TS/JS/Vue imports, exports, hotspots, layers and circular dependencies accurately", () => {
    const treeEntries: RemoteTreeEntry[] = [
      { path: "src/index.ts", size: 900 },
      { path: "src/core/orchestrator.ts", size: 3200 },
      { path: "src/protocol/events.ts", size: 1800 },
      { path: "src/storage/state.ts", size: 2100 },
      { path: "src/ui/Panel.vue", size: 1500 },
      { path: "src/core/cycleA.ts", size: 800 },
      { path: "src/core/cycleB.ts", size: 800 },
    ];
    const blobs = new Map<string, string>([
      [
        "src/index.ts",
        `import { Orchestrator } from "./core/orchestrator.js";
         import type { RunEvent } from "./protocol/events.ts";
         import { Hono } from "hono";
         export function bootstrapApp(): Orchestrator { return new Orchestrator(); }`,
      ],
      [
        "src/core/orchestrator.ts",
        `import { StateStore } from "../storage/state";
         import { emitRunEvent, type RunEvent } from "../protocol/events";
         import { helperA } from "./cycleA";
         export class Orchestrator {
           run(): RunEvent { return emitRunEvent(); }
         }`,
      ],
      [
        "src/protocol/events.ts",
        `export interface RunEvent { seq: number; kind: string; }
         export type EventKind = "start" | "done";
         export function emitRunEvent(): RunEvent { return { seq: 1, kind: "start" }; }`,
      ],
      [
        "src/storage/state.ts",
        `import type { RunEvent } from "../protocol/events";
         import pg from "pg";
         export class StateStore { save(ev: RunEvent) {} }`,
      ],
      [
        "src/ui/Panel.vue",
        `<template><div /></template>
         <script setup lang="ts">
         import { emitRunEvent } from "@/protocol/events";
         export const PanelView = () => emitRunEvent();
         </script>`,
      ],
      [
        "src/core/cycleA.ts",
        `import { helperB } from "./cycleB";
         export function helperA() { return helperB(); }`,
      ],
      [
        "src/core/cycleB.ts",
        `import { helperA } from "./cycleA";
         export function helperB() { return helperA(); }`,
      ],
    ]);

    const cm = buildCodeMapFromMemory({
      nodeId: "ren_demo_ts",
      repoFullName: "demo/ts-agent",
      repoUrl: "https://github.com/demo/ts-agent",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      defaultBranch: "main",
      source: "github_remote_memory",
      treeEntries,
      blobs,
    });

    assert.equal(cm.zeroLocalClone, true);
    assert.equal(cm.diskBytesCloned, 0);
    assert.equal(cm.analyzedFileCount, 7);
    assert.ok(cm.edgeCount >= 7, `expected >=7 edges, got ${cm.edgeCount}`);

    // protocol/events.ts is imported by 4 files -> top hotspot!
    assert.equal(cm.hotspots[0]?.path, "src/protocol/events.ts");
    assert.equal(cm.hotspots[0]?.importedByCount, 4);
    assert.ok(cm.hotspots[0]?.startReadingReason.includes("被 4 个文件引用"));
    assert.ok(cm.hotspots[0]?.exportedSymbols.some((s) => s.name === "RunEvent" && s.kind === "interface"));

    // Cycle detected between cycleA and cycleB
    assert.equal(cm.cycleCount, 1);
    assert.deepEqual(cm.cycles[0]?.paths, ["src/core/cycleA.ts", "src/core/cycleB.ts", "src/core/cycleA.ts"]);

    // Layers & external deps
    assert.ok(cm.layers.some((l) => l.layer === "protocol"));
    assert.ok(cm.layers.some((l) => l.layer === "ui"));
    assert.ok(cm.topExternalDeps.some((d) => d.name === "hono"));
    assert.ok(cm.keyInterfaces.some((ki) => ki.name === "RunEvent"));
  });

  it("parses Python, Go and Rust imports and exported symbols", () => {
    const py = parseSourceFileStatic(
      "browser_use/dom/service.py",
      `from browser_use.dom.views import DOMElementNode, SelectorMap
import playwright.async_api
class DomService(BaseModel):
    pass
async def build_dom_tree(page):
    return None
def _internal_helper():
    pass`,
    );
    assert.equal(py.imports.length, 2);
    assert.deepEqual(
      py.exportedSymbols.map((s) => s.name),
      ["DomService", "build_dom_tree"],
    );

    const go = parseSourceFileStatic(
      "pkg/sandbox/manager.go",
      `package sandbox
import (
  "context"
  "github.com/org/repo/pkg/protocol"
)
type SandboxManager interface { Create() error }
type PoolConfig struct { Size int }
func NewManager() *PoolConfig { return nil }`,
    );
    assert.equal(go.imports.length, 2);
    assert.deepEqual(
      go.exportedSymbols.map((s) => s.name),
      ["SandboxManager", "PoolConfig", "NewManager"],
    );

    const rs = parseSourceFileStatic(
      "src/vmm/engine.rs",
      `mod jailer;
use crate::protocol::ExecRequest;
use tokio::runtime::Runtime;
pub struct MicroVmEngine {}
pub trait SandboxDriver {}
pub async fn boot_snapshot() {}`,
    );
    assert.equal(rs.imports.length, 3);
    assert.deepEqual(
      rs.exportedSymbols.map((s) => s.name),
      ["MicroVmEngine", "SandboxDriver", "boot_snapshot"],
    );

    assert.equal(classifyFileLayer("crates/vmm/src/jailer.rs"), "infra");
    assert.equal(classifyFileLayer("pkg/protocol/rpc.go"), "protocol");
    assert.equal(classifyFileLayer("browser_use/dom/service.py"), "core");
  });

  it("scans a local private repository read-only in memory without writing any files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opc-codemap-local-"));
    try {
      mkdirSync(join(dir, "src", "core"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "ignored"), { recursive: true });
      writeFileSync(
        join(dir, "src", "core", "dispatcher.ts"),
        `export interface InboundEnvelope { channel: string; text: string; }\nexport class ChannelDispatcher { route(e: InboundEnvelope) {} }\n`,
      );
      writeFileSync(
        join(dir, "src", "index.ts"),
        `import { ChannelDispatcher } from "./core/dispatcher";\nexport const app = new ChannelDispatcher();\n`,
      );
      writeFileSync(join(dir, "node_modules", "ignored", "x.js"), `module.exports = 1;`);

      const snap = await scanLocalRepoReadOnly(dir);
      assert.ok(snap.entries.some((e) => e.path === "src/core/dispatcher.ts"));
      assert.ok(!snap.entries.some((e) => e.path.includes("node_modules")));

      const blobs = new Map<string, string>();
      for (const e of snap.entries) {
        const text = snap.readFile(e.path);
        if (text !== null) blobs.set(e.path, text);
      }
      const cm = buildCodeMapFromMemory({
        nodeId: "ren_local_test",
        repoFullName: "local/ai-agent-node",
        repoUrl: "https://github.com/local/ai-agent-node",
        commitSha: snap.commitSha,
        defaultBranch: snap.defaultBranch,
        source: "local_readonly_memory",
        treeEntries: snap.entries,
        blobs,
      });
      assert.equal(cm.source, "local_readonly_memory");
      assert.equal(cm.diskBytesCloned, 0);
      assert.equal(cm.hotspots[0]?.path, "src/core/dispatcher.ts");
      assert.equal(cm.hotspots[0]?.importedByCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- Full PostgreSQL 18 + pgvector Integration Suite ----

const PG_URL = process.env.OPC_PG_URL || process.env.DATABASE_URL || "";

describe("RepoEvolution Round 3: Zero-Clone Code Map + Architecture Primitives (PG 18)", { skip: !PG_URL }, () => {
  const testSchema = `test_codemap_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let adminPool: PgPoolLike;
  let pool: PgPoolLike;
  let sqliteDb: DatabaseSync;
  let decisions: DecisionGateway;
  let localFixtureDir: string;

  // Track remote fetcher & LLM & Vector invocations to enforce caching & privacy red lines
  const fetchStats = { headCalls: 0, treeCalls: 0, blobCalls: 0 };
  let llmCallCount = 0;
  let remoteVectorCalls = 0;

  const REPO_FIXTURES: Record<string, { commitSha: string; files: Record<string, string> }> = {
    "nanobrowser/nanobrowser": {
      commitSha: "1111111111111111111111111111111111111111",
      files: {
        "chrome-extension/src/background/index.ts": `import { BrowserExecutor } from "./agent/executor";
import { DomTreeService } from "./browser/dom/service";
export function startBackground() { return [BrowserExecutor, DomTreeService]; }`,
        "chrome-extension/src/background/agent/executor.ts": `import { DomTreeService } from "../browser/dom/service";
import type { BrowserAction } from "../protocol/actions";
export class BrowserExecutor { execute(a: BrowserAction, dom: DomTreeService) {} }`,
        "chrome-extension/src/background/browser/dom/service.ts": `import type { BrowserAction } from "../../protocol/actions";
export interface DomSnapshot { epoch: number; elements: string[]; }
export class DomTreeService { capture(): DomSnapshot { return { epoch: 1, elements: [] }; } }`,
        "chrome-extension/src/background/protocol/actions.ts": `export interface BrowserAction { kind: "click" | "fill"; refId: string; }
export type ActionResult = { ok: boolean; readback?: string };`,
      },
    },
    "browser-use/browser-use": {
      commitSha: "2222222222222222222222222222222222222222",
      files: {
        "browser_use/agent/service.py": `from browser_use.dom.service import DomService
from browser_use.controller.service import Controller
class Agent:
    def step(self):
        return DomService`,
        "browser_use/dom/service.py": `class DomService:
    def get_clickable_elements(self):
        return []
def build_dom_tree():
    return {}`,
        "browser_use/controller/service.py": `from browser_use.dom.service import DomService
class Controller:
    def act(self, action):
        return DomService`,
      },
    },
    "magele758/chromegate": {
      commitSha: "3333333333333333333333333333333333333333",
      files: {
        "src/background/index.js": `import { GatewayBridge } from "./bridge.js";
import { dispatchTabAction } from "./actions.js";
export function initChromeGate() { return [GatewayBridge, dispatchTabAction]; }`,
        "src/background/bridge.js": `export class GatewayBridge { connect() {} send(msg) {} }`,
        "src/background/actions.js": `import { GatewayBridge } from "./bridge.js";
export function dispatchTabAction(cmd) { return new GatewayBridge(); }`,
      },
    },
    "magele758/pagelens-agent": {
      commitSha: "4444444444444444444444444444444444444444",
      files: {
        "extension/background.js": `import { runPageLoop } from "./loop.js";
import { extractDom } from "./dom.js";
export function startSidePanel() { return [runPageLoop, extractDom]; }`,
        "extension/loop.js": `import { extractDom } from "./dom.js";
export function runPageLoop() { return extractDom(); }`,
        "extension/dom.js": `export function extractDom() { return { nodes: [] }; }`,
      },
    },
    "vercel-labs/agent-browser": {
      commitSha: "5555555555555555555555555555555555555555",
      files: {
        "src/main.rs": `mod cli;
use crate::cli::BrowserCli;
use crate::axtree::AxTreeSnapshot;
pub fn main() {}`,
        "src/cli.rs": `use crate::axtree::AxTreeSnapshot;
pub struct BrowserCli {}
pub fn run_headless_command() {}`,
        "src/axtree.rs": `pub struct AxTreeSnapshot {}
pub trait AccessibilityDriver {}`,
      },
    },
  };

  function makeMockCodeMapFetcher(): CodeMapRemoteFetcher {
    return {
      async resolveHeadCommit(owner, name) {
        fetchStats.headCalls++;
        const fix = REPO_FIXTURES[`${owner}/${name}`];
        if (!fix) throw new Error(`Unknown fixture ${owner}/${name}`);
        return { commitSha: fix.commitSha, defaultBranch: "main" };
      },
      async fetchRecursiveTree(owner, name, ref) {
        fetchStats.treeCalls++;
        const fix = REPO_FIXTURES[`${owner}/${name}`];
        if (!fix) throw new Error(`Unknown fixture ${owner}/${name}`);
        return {
          commitSha: ref,
          defaultBranch: "main",
          truncated: false,
          entries: Object.entries(fix.files).map(([path, content]) => ({
            path,
            size: Buffer.byteLength(content, "utf8"),
          })),
        };
      },
      async fetchBlobsBatch(owner, name, _ref, paths) {
        fetchStats.blobCalls++;
        const fix = REPO_FIXTURES[`${owner}/${name}`];
        const out = new Map<string, string>();
        if (!fix) return out;
        for (const p of paths) {
          if (fix.files[p] !== undefined) out.set(p, fix.files[p]);
        }
        return out;
      },
    };
  }

  function makeStubGithub(): GitHubEvolutionFetcher {
    return {
      fetchOwnedReposPage: async () => ({ login: "magele758", totalCount: 0, hasNextPage: false, endCursor: null, items: [] }),
      fetchStarredReposPage: async () => ({ login: "magele758", totalCount: 0, hasNextPage: false, endCursor: null, items: [] }),
      fetchStarLists: async () => [],
      fetchRepoContent: async (repo): Promise<RepoContent> => ({
        fullName: repo.fullName,
        ref: "main",
        source: "mock",
        readme: { url: `${repo.url}/blob/main/README.md`, text: `# ${repo.fullName}`, truncated: false },
        note: "",
        files: [{ name: "src", directory: true, url: `${repo.url}/tree/main/src` }],
        issuesUrl: `${repo.url}/issues`,
        pullsUrl: `${repo.url}/pulls`,
      }),
      searchRepoContent: async () => ({ source: "mock", note: "", items: [] }),
    };
  }

  let service: RepoEvolutionService;
  let app: Hono;
  let projectedCanvasCalls: Array<{ name: string; nodeCount: number; edgeCount: number }> = [];

  before(async () => {
    adminPool = await createRepoEvolutionPool(PG_URL);
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${testSchema}"`);
    pool = await createRepoEvolutionPool(PG_URL, { schema: testSchema });

    sqliteDb = new DatabaseSync(":memory:");
    const events = new DomainEventBus(sqliteDb);
    const registry = new AssetRegistry(sqliteDb, events);
    decisions = new DecisionGateway(sqliteDb, events, registry);

    // Local fixture for private local/ai-agent-node
    localFixtureDir = mkdtempSync(join(tmpdir(), "opc-ai-agent-node-"));
    mkdirSync(join(localFixtureDir, "src", "node"), { recursive: true });
    writeFileSync(
      join(localFixtureDir, "src", "node", "dispatcher.ts"),
      `import { OpenAIAgentRunner } from "./runner";
export interface ChannelMessage { channel: string; sessionId: string; }
export class UnifiedDispatcher { dispatch(m: ChannelMessage) { return new OpenAIAgentRunner(); } }`,
    );
    writeFileSync(
      join(localFixtureDir, "src", "node", "runner.ts"),
      `export interface ToolContract { name: string; }
export class OpenAIAgentRunner { runLoop(tool: ToolContract) {} }`,
    );

    const mockCanvasStore: KnowledgeCanvasStoreLike = {
      createCanvas(raw) {
        return { id: `cvs_${randomUUID().slice(0, 8)}`, name: raw.name };
      },
      async createNode(_canvasId, _raw) {
        return { id: `cn_${randomUUID().slice(0, 8)}` };
      },
      createEdge(_canvasId, _raw) {
        return { id: `ce_${randomUUID().slice(0, 8)}` };
      },
    };
    const rawProjector = createKnowledgeCanvasProjector(mockCanvasStore);

    service = new RepoEvolutionService({
      pool,
      decisions,
      github: makeStubGithub(),
      codeMapFetcher: makeMockCodeMapFetcher(),
      localRepoPathResolver: (node) => (node.fullName === "local/ai-agent-node" ? localFixtureDir : null),
      projectToCanvas: async (payload) => {
        const res = await rawProjector(payload);
        projectedCanvasCalls.push({ name: res.canvasName, nodeCount: res.nodeCount, edgeCount: res.edgeCount });
        return res;
      },
      llmCaller: async () => {
        llmCallCount++;
        return { ok: false, reason: "测试模式无外部 LLM Key" };
      },
      vectorCaller: async (text) => {
        remoteVectorCalls++;
        // deterministic local fallback vector for test
        const vec = new Array(256).fill(0);
        vec[text.length % 256] = 1;
        return { vector: vec, source: "remote", dimensions: 256 };
      },
      now: () => FIXED_NOW,
    });
    await service.init();

    // Seed owned & star nodes + 1-to-N links for browser & private agent clusters
    const browserDom = "dom_browser_automation";
    const agentDom = "dom_ai_agents";
    const domains = await service.listDomainClusters();
    const browserDomainId = domains.find((d) => d.slug === "browser-automation")?.id ?? browserDom;
    const agentDomainId = domains.find((d) => d.slug === "ai-agents")?.id ?? agentDom;

    const chromegate = await service.registerOwnedOrSpotlightNode({
      fullName: "magele758/chromegate",
      role: "owned",
      visibility: "public",
      priorityTier: "spotlight",
      description: "Chrome MV3 side-panel gateway and browser automation bridge",
      primaryLanguage: "JavaScript",
      topics: ["chrome-extension", "browser-automation", "cdp"],
    });
    const pagelens = await service.registerOwnedOrSpotlightNode({
      fullName: "magele758/pagelens-agent",
      role: "owned",
      visibility: "public",
      priorityTier: "standard",
      description: "PageLens browser agent sidepanel for DOM filling and workflow actions",
      primaryLanguage: "JavaScript",
      topics: ["chrome-extension", "browser-automation", "dom"],
    });
    const localPrivate = await service.registerOwnedOrSpotlightNode({
      fullName: "local/ai-agent-node",
      role: "owned",
      visibility: "private",
      priorityTier: "spotlight",
      description: "Private multi-channel AI agent dispatcher with MCP client and Socket.IO",
      primaryLanguage: "TypeScript",
      topics: ["ai-agent", "mcp", "multi-agent"],
      allowLlmAnalysis: false,
    });
    const nanobrowser = await service.registerOwnedOrSpotlightNode({
      fullName: "nanobrowser/nanobrowser",
      role: "starred",
      visibility: "public",
      priorityTier: "standard",
      description: "Chrome extension multi-agent web automation with DOM service",
      primaryLanguage: "TypeScript",
      topics: ["chrome-extension", "browser-automation", "ai-agent"],
    });
    const browserUse = await service.registerOwnedOrSpotlightNode({
      fullName: "browser-use/browser-use",
      role: "starred",
      visibility: "public",
      priorityTier: "standard",
      description: "Make websites accessible for AI agents via Playwright CDP and DOM tree",
      primaryLanguage: "Python",
      topics: ["browser-use", "playwright", "dom", "ai-agent"],
    });
    const agentBrowser = await service.registerOwnedOrSpotlightNode({
      fullName: "vercel-labs/agent-browser",
      role: "starred",
      visibility: "public",
      priorityTier: "standard",
      description: "Rust headless CLI browser automation with AXTree accessibility snapshots",
      primaryLanguage: "Rust",
      topics: ["browser-automation", "cli", "headless", "accessibility"],
    });

    await service.updateNode(chromegate.id, { primaryDomainId: browserDomainId });
    await service.updateNode(pagelens.id, { primaryDomainId: browserDomainId });
    await service.updateNode(nanobrowser.id, { primaryDomainId: browserDomainId });
    await service.updateNode(browserUse.id, { primaryDomainId: browserDomainId });
    await service.updateNode(agentBrowser.id, { primaryDomainId: browserDomainId });
    await service.updateNode(localPrivate.id, { primaryDomainId: agentDomainId });

    // Create 1-to-N hub links (nanobrowser & browser-use -> both chromegate & pagelens-agent)
    await service.createLink({ sourceNodeId: nanobrowser.id, targetNodeId: chromegate.id, strength: 0.86, relationType: "architecture_pattern" });
    await service.createLink({ sourceNodeId: nanobrowser.id, targetNodeId: pagelens.id, strength: 0.84, relationType: "direct_module" });
    await service.createLink({ sourceNodeId: browserUse.id, targetNodeId: chromegate.id, strength: 0.82, relationType: "architecture_pattern" });
    await service.createLink({ sourceNodeId: browserUse.id, targetNodeId: pagelens.id, strength: 0.8, relationType: "algorithm_idea" });
    await service.createLink({ sourceNodeId: nanobrowser.id, targetNodeId: localPrivate.id, strength: 0.72, relationType: "architecture_pattern" });

    app = new Hono();
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
      return c.json({ error: "internal", message: String(err) }, 500);
    });
    addRepoEvolutionRoutes(app, service, () => ({ id: "u_founder", name: "founder" }));
  });

  after(async () => {
    rmSync(localFixtureDir, { recursive: true, force: true });
    sqliteDb.close();
    if (pool.end) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    if (adminPool.end) await adminPool.end();
  });

  it("generates zero-clone Code Map, caches by (node_id, commit_sha), and supports local read-only repos", async () => {
    const res1 = await app.request("/api/opc/repo-evolution/nodes/nanobrowser%2Fnanobrowser/code-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as GenerateCodeMapResponse;
    assert.equal(body1.cached, false);
    assert.equal(body1.codeMap.zeroLocalClone, true);
    assert.equal(body1.codeMap.diskBytesCloned, 0);
    assert.equal(body1.codeMap.source, "github_remote_memory");
    assert.equal(body1.codeMap.analyzedFileCount, 4);
    assert.ok(body1.codeMap.hotspots.some((h) => h.path.endsWith("dom/service.ts")));

    const treeBefore = fetchStats.treeCalls;
    const blobBefore = fetchStats.blobCalls;

    // Second POST on same commit -> hits PG cache with 0 tree/blob calls
    const res2 = await app.request("/api/opc/repo-evolution/nodes/nanobrowser%2Fnanobrowser/code-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as GenerateCodeMapResponse;
    assert.equal(body2.cached, true);
    assert.equal(fetchStats.treeCalls, treeBefore);
    assert.equal(fetchStats.blobCalls, blobBefore);

    // GET returns cached Code Map with 0 remote calls
    const headBefore = fetchStats.headCalls;
    const getRes = await app.request("/api/opc/repo-evolution/nodes/nanobrowser%2Fnanobrowser/code-map");
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as GetCodeMapResponse;
    assert.equal(getBody.codeMap?.commitSha, body1.codeMap.commitSha);
    assert.equal(fetchStats.headCalls, headBefore);

    // Local private repo read-only scan
    const localRes = await app.request("/api/opc/repo-evolution/nodes/local%2Fai-agent-node/code-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(localRes.status, 200);
    const localBody = (await localRes.json()) as GenerateCodeMapResponse;
    assert.equal(localBody.codeMap.source, "local_readonly_memory");
    assert.equal(localBody.codeMap.diskBytesCloned, 0);
    assert.ok(localBody.codeMap.hotspots.some((h) => h.path === "src/node/runner.ts"));
  });

  it("upgrades analyzeLink with dual Code Maps and enforces strict private zero-egress red line", async () => {
    const links = await service.listLinks({});
    const pubLink = links.find(
      (l) => l.sourceRepoFullName === "nanobrowser/nanobrowser" && l.targetRepoFullName === "magele758/chromegate",
    )!;
    assert.ok(pubLink);

    const pubRes = await app.request(`/api/opc/repo-evolution/links/${pubLink.id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(pubRes.status, 200);
    const pubBody = (await pubRes.json()) as AnalyzeLinkResult;
    assert.ok(pubBody.sourceCodeMap && pubBody.targetCodeMap);
    assert.equal(pubBody.sourceCodeMap.diskBytesCloned, 0);
    assert.ok(pubBody.link.moduleAnalysis.length >= 2);
    assert.equal(pubBody.link.moduleAnalysis[0]?.groundedByCodeMap, true);
    assert.ok(pubBody.link.moduleAnalysis[0]?.sourceModulePath.includes("chrome-extension/src/background/"));
    assert.ok((pubBody.link.moduleAnalysis[0]?.steps?.length ?? 0) >= 3);
    assert.ok((pubBody.link.moduleAnalysis[0]?.acceptanceCriteria?.length ?? 0) >= 2);

    // Private unauthorized target link: MUST NOT call LLM!
    const privLink = links.find((l) => l.targetRepoFullName === "local/ai-agent-node")!;
    assert.ok(privLink);
    const llmBefore = llmCallCount;
    const privRes = await app.request(`/api/opc/repo-evolution/links/${privLink.id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(privRes.status, 200);
    const privBody = (await privRes.json()) as AnalyzeLinkResult;
    assert.equal(privBody.privacyBlocked, true);
    assert.equal(llmCallCount, llmBefore, "unauthorized private repo MUST NEVER invoke remote LLM");
    assert.ok(privBody.link.moduleAnalysis.some((m) => m.targetModulePath.startsWith("src/node/")));
  });

  it("discovers clusters, distills L0-L4 primitive, enforces privacy, compares new repo, exports ADR, projects to canvas & submits to mailbox", async () => {
    // 1. Discover high-density clusters
    const cluRes = await app.request("/api/opc/repo-evolution/architecture/clusters");
    assert.equal(cluRes.status, 200);
    const { clusters } = (await cluRes.json()) as { clusters: ArchitectureClusterRecommendation[] };
    assert.ok(clusters.length >= 1);
    const browserCluster = clusters.find((c) => c.slug === "browser-perception-action-gateway");
    assert.ok(browserCluster, "should discover multi-twin browser gateway cluster");
    assert.equal(browserCluster.ownedNodes.length, 2);
    assert.ok(browserCluster.sharedHubCount >= 2);

    // 2. Distill L0-L4 blueprint from cluster
    const distRes = await app.request("/api/opc/repo-evolution/architecture/distill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterId: browserCluster.id }),
    });
    assert.equal(distRes.status, 200);
    const distilled = (await distRes.json()) as DistillArchitecturePrimitiveResult;
    const prim = distilled.primitive;
    assert.equal(prim.version, 1);
    assert.equal(prim.status, "draft");
    assert.ok(prim.firstPrinciples.length >= 3);
    assert.ok(prim.tradeoffMatrix.approaches.length >= 2);
    assert.ok(prim.primitiveSpec.mermaidDiagram.includes("flowchart"));
    assert.ok(prim.consolidationPlan.length >= 2);
    assert.ok(prim.codeMapRefs.every((r) => r.analyzedFileCount > 0));
    assert.ok(
      prim.consolidationPlan.some(
        (c) => c.targetOwnedRepos.includes("magele758/chromegate") && c.targetOwnedRepos.includes("magele758/pagelens-agent"),
      ),
      "L4 consolidation must identify multi-twin owned repos",
    );

    // 3. Patch status draft -> validated -> canonical
    const patchRes = await app.request(`/api/opc/repo-evolution/architecture/primitives/${prim.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "validated" }),
    });
    assert.equal(patchRes.status, 200);
    const { primitive: patched } = (await patchRes.json()) as { primitive: ArchitecturePrimitive };
    assert.equal(patched.status, "validated");

    // 4. Compare a Rust CLI / AXTree repo against primitive -> paradigm note appended
    const cmpRes = await app.request(`/api/opc/repo-evolution/architecture/primitives/${prim.id}/compare-repo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "vercel-labs/agent-browser" }),
    });
    assert.equal(cmpRes.status, 200);
    const compared = (await cmpRes.json()) as CompareRepoToPrimitiveResult;
    assert.equal(compared.note.repoFullName, "vercel-labs/agent-browser");
    assert.ok(["confirms_paradigm", "engineering_tweak", "paradigm_shift"].includes(compared.note.verdict));
    assert.ok(compared.note.evidence.length >= 1);
    assert.equal(compared.primitive.paradigmNotes.length, 1);

    // 5. Export ADR Markdown (both raw markdown and ?format=json)
    const mdRes = await app.request(`/api/opc/repo-evolution/architecture/primitives/${prim.id}/export.md`);
    assert.equal(mdRes.status, 200);
    assert.ok(mdRes.headers.get("content-type")?.includes("text/markdown"));
    const mdText = await mdRes.text();
    assert.ok(mdText.includes("# ADR ·"));
    assert.ok(mdText.includes("```mermaid"));
    assert.ok(mdText.includes("vercel-labs/agent-browser"));

    const mdJsonRes = await app.request(`/api/opc/repo-evolution/architecture/primitives/${prim.id}/export.md?format=json`);
    const mdJson = (await mdJsonRes.json()) as ArchitecturePrimitiveExportJson;
    assert.equal(mdJson.primitiveId, prim.id);
    assert.ok(mdJson.filename.endsWith(".md"));

    // 6. Project to Knowledge Canvas (#canvas)
    const canvasRes = await app.request(`/api/opc/repo-evolution/architecture/primitives/${prim.id}/project-canvas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(canvasRes.status, 200);
    const projected = (await canvasRes.json()) as ProjectPrimitiveToCanvasResult;
    assert.ok(projected.nodeCount >= 6);
    assert.ok(projected.edgeCount >= 5);
    assert.ok(projected.href.startsWith("#canvas?canvasId="));
    assert.equal(projectedCanvasCalls.length, 1);

    // 7. Submit L4 consolidation item to Founder Mailbox & verify decision handler callback!
    const targetItem = prim.consolidationPlan[0]!;
    const subRes = await app.request(`/api/opc/repo-evolution/architecture/primitives/${prim.id}/submit-consolidation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: targetItem.id, note: "同意先收敛多胞胎浏览器内核" }),
    });
    assert.equal(subRes.status, 200);
    const submitted = (await subRes.json()) as SubmitConsolidationResult;
    assert.equal(submitted.reusedPending, false);
    assert.equal(submitted.packet.domain, "product");
    assert.equal(submitted.packet.kind, "repo_absorption");
    assert.equal(submitted.packet.riskLevel, "medium");
    assert.equal(submitted.packet.status, "pending");

    // Duplicate submission reuses pending packet
    const subRes2 = await app.request(`/api/opc/repo-evolution/architecture/primitives/${prim.id}/submit-consolidation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: targetItem.id }),
    });
    const submitted2 = (await subRes2.json()) as SubmitConsolidationResult;
    assert.equal(submitted2.reusedPending, true);
    assert.equal(submitted2.packet.id, submitted.packet.id);

    // Approve in Founder Mailbox -> updates consolidation item decisionStatus
    await decisions.resolve(submitted.packet.id, { optionId: "approve", actor: "founder", note: "立项执行" });
    const afterApprove = await service.getArchitecturePrimitive(prim.id);
    const approvedItem = afterApprove.primitive.consolidationPlan.find((it) => it.id === targetItem.id);
    assert.equal(approvedItem?.decisionStatus, "approved");

    // 8. Private repo distillation red line: 0 LLM calls AND 0 remote vector calls!
    const llmBefore = llmCallCount;
    const vecBefore = remoteVectorCalls;
    const privDistRes = await app.request("/api/opc/repo-evolution/architecture/distill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "私有控制面原语测试",
        ownedNodeIds: ["local/ai-agent-node"],
        starNodeIds: ["nanobrowser/nanobrowser"],
      }),
    });
    assert.equal(privDistRes.status, 200);
    const privDist = (await privDistRes.json()) as DistillArchitecturePrimitiveResult;
    assert.equal(privDist.privacyBlocked, true);
    assert.equal(privDist.usedLlm, false);
    assert.equal(llmCallCount, llmBefore, "private distillation must NEVER invoke remote LLM");
    assert.equal(remoteVectorCalls, vecBefore, "private distillation must NEVER invoke remote Embedding");

    // 9. Delete primitive
    const delRes = await app.request(`/api/opc/repo-evolution/architecture/primitives/${privDist.primitive.id}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const listAfter = await service.listArchitecturePrimitives();
    assert.equal(listAfter.total, 1);

    // 10. Verify createApp wires real KnowledgeCanvasStore end-to-end & gracefully handles deleted canvas re-projection
    const fullStore = openStore(":memory:");
    const { app: wiredApp, knowledgeCanvas, close: closeWired } = createApp(fullStore, { repoEvolution: service });
    try {
      const sessRes = await wiredApp.request("/api/session", { method: "POST" });
      const cookie = (sessRes.headers.get("set-cookie") ?? "").split(";")[0];
      const headers = { cookie, "content-type": "application/json" };

      const liveProjRes = await wiredApp.request(
        `/api/opc/repo-evolution/architecture/primitives/${prim.id}/project-canvas`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ canvasName: "实机投射验证画布" }),
        },
      );
      assert.equal(liveProjRes.status, 200);
      const liveProjected = (await liveProjRes.json()) as ProjectPrimitiveToCanvasResult;
      assert.ok(liveProjected.canvasId);
      assert.equal(liveProjected.canvasName, "实机投射验证画布");
      assert.ok(liveProjected.nodeCount >= 6);
      assert.ok(liveProjected.edgeCount >= 5);

      const canvasDetailRes = await wiredApp.request(`/api/opc/canvases/${encodeURIComponent(liveProjected.canvasId)}`, {
        headers: { cookie },
      });
      assert.equal(canvasDetailRes.status, 200);
      const canvasDetail = (await canvasDetailRes.json()) as {
        canvas: { id: string; name: string };
        nodes: Array<{ id: string; type: string; title: string; content: Record<string, unknown> }>;
        edges: Array<{ id: string }>;
      };
      assert.equal(canvasDetail.canvas.id, liveProjected.canvasId);
      assert.equal(canvasDetail.nodes.length, liveProjected.nodeCount);
      assert.equal(canvasDetail.edges.length, liveProjected.edgeCount);
      const briefingNodes = canvasDetail.nodes.filter((n) => n.type === "briefing");
      assert.ok(briefingNodes.length >= 2, "projected canvas should contain L0/L2 briefing nodes");
      assert.ok(
        briefingNodes.every((n) => typeof n.content.summary === "string" && n.content.summary.length > 20),
        "briefing nodes must carry summary for KnowledgeCanvas card rendering",
      );

      // Deleting the canvas and re-projecting with the stale canvasId must gracefully recreate a new canvas
      knowledgeCanvas.deleteCanvas(liveProjected.canvasId);
      const reprojRes = await wiredApp.request(
        `/api/opc/repo-evolution/architecture/primitives/${prim.id}/project-canvas`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ canvasId: liveProjected.canvasId, canvasName: "重投恢复画布" }),
        },
      );
      assert.equal(reprojRes.status, 200);
      const reprojected = (await reprojRes.json()) as ProjectPrimitiveToCanvasResult;
      assert.notEqual(reprojected.canvasId, liveProjected.canvasId);
      assert.equal(reprojected.canvasName, "重投恢复画布");
      assert.ok(reprojected.nodeCount >= 6);
    } finally {
      await closeWired();
      fullStore.db.close();
    }
  });
});
