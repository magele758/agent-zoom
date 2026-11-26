import { createHash, randomUUID } from "node:crypto";
import type { ProvidersConfig } from "../providers-types.ts";
import {
  ARCHITECTURE_CONSOLIDATION_KIND_LABELS,
  ARCHITECTURE_CONSTRAINT_CATEGORY_LABELS,
  ARCHITECTURE_PRIMITIVE_STATUS_LABELS,
  PARADIGM_VERDICT_LABELS,
  REPO_CODE_LAYER_LABELS,
  type ArchitectureCanvasProjectionEdgeDraft,
  type ArchitectureCanvasProjectionNodeDraft,
  type ArchitectureCanvasProjectionPayload,
  type ArchitectureClusterRecommendation,
  type ArchitectureCodeMapRef,
  type ArchitectureConsolidationItem,
  type ArchitectureConstraintCategory,
  type ArchitectureEvidenceRef,
  type ArchitectureFirstPrinciple,
  type ArchitectureParadigmNote,
  type ArchitecturePrimitive,
  type ArchitecturePrimitiveSpec,
  type ArchitectureTradeoffApproach,
  type ArchitectureTradeoffDimension,
  type ArchitectureTradeoffMatrix,
  type ParadigmComparisonVerdict,
  type RepoCodeMap,
  type RepoCodeMapHotspot,
  type RepoDomain,
  type RepoEvolutionNode,
  type RepoModuleEffort,
  type RepoModuleRisk,
  type RepoNodeBrief,
} from "../repo-evolution-types.ts";
import type { callConfiguredLLM } from "./providers.ts";

export interface KnowledgeCanvasStoreLike {
  createCanvas(raw: { name: string; description?: string; viewport?: { x?: number; y?: number; zoom?: number } }): {
    id: string;
    name: string;
  };
  getCanvas?(canvasId: string): { canvas: { id: string; name: string } };
  createNode(
    canvasId: string,
    raw: {
      type: "note" | "briefing" | "task";
      status?: "draft" | "active" | "published";
      title: string;
      content?: Record<string, unknown>;
      position?: { x: number; y: number };
      size?: { width: number; height: number };
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }>;
  createEdge(
    canvasId: string,
    raw: {
      sourceId: string;
      targetId: string;
      type?: "derives" | "semantic_link" | "blocks";
      label?: string;
      metadata?: Record<string, unknown>;
    },
  ): { id: string };
}

export type ArchitectureCanvasProjector = (
  payload: ArchitectureCanvasProjectionPayload,
) => Promise<{
  canvasId: string;
  canvasName: string;
  nodeCount: number;
  edgeCount: number;
  href?: string;
}>;

export function createKnowledgeCanvasProjector(
  canvasStore: KnowledgeCanvasStoreLike,
): ArchitectureCanvasProjector {
  return async (payload) => {
    let canvasId = payload.canvasId;
    let canvasName = payload.canvasName;
    if (canvasId && canvasStore.getCanvas) {
      const existing = canvasStore.getCanvas(canvasId);
      canvasId = existing.canvas.id;
      canvasName = existing.canvas.name;
    } else {
      const created = canvasStore.createCanvas({
        name: payload.canvasName,
        description: payload.canvasDescription,
        viewport: { x: 40, y: 40, zoom: 0.85 },
      });
      canvasId = created.id;
      canvasName = created.name;
    }

    const keyToId = new Map<string, string>();
    for (const node of payload.nodes) {
      const createdNode = await canvasStore.createNode(canvasId, {
        type: node.type,
        status: "active",
        title: node.title,
        content: {
          markdown: node.markdown,
          text: node.markdown,
        },
        position: node.position,
        size: node.size,
        metadata: {
          ...node.metadata,
          source: "repo_architecture_primitive",
          primitiveId: payload.primitive.id,
          primitiveSlug: payload.primitive.slug,
        },
      });
      keyToId.set(node.key, createdNode.id);
    }

    let edgeCount = 0;
    for (const edge of payload.edges) {
      const sourceId = keyToId.get(edge.sourceKey);
      const targetId = keyToId.get(edge.targetKey);
      if (!sourceId || !targetId) continue;
      canvasStore.createEdge(canvasId, {
        sourceId,
        targetId,
        type: edge.type,
        label: edge.label,
        metadata: { primitiveId: payload.primitive.id },
      });
      edgeCount++;
    }

    return {
      canvasId,
      canvasName,
      nodeCount: keyToId.size,
      edgeCount,
      href: `#canvas?canvasId=${encodeURIComponent(canvasId)}`,
    };
  };
}

// ---- Slugify & Evidence Helpers ----

export function slugifyPrimitive(raw: string): string {
  const ascii = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii && /^[a-z0-9][a-z0-9-]{1,64}$/.test(ascii)) return ascii;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const latin = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return latin ? `${latin}-${hash}` : `primitive-${hash}`;
}

export function buildCodeMapRef(node: RepoEvolutionNode, codeMap: RepoCodeMap): ArchitectureCodeMapRef {
  return {
    nodeId: node.id,
    repoFullName: node.fullName,
    role: node.role,
    visibility: node.visibility,
    primaryLanguage: node.primaryLanguage,
    starsCount: node.starsCount,
    commitSha: codeMap.commitSha,
    analyzedFileCount: codeMap.analyzedFileCount,
    topHotspots: codeMap.hotspots.slice(0, 4).map((h) => ({
      path: h.path,
      importedByCount: h.importedByCount,
      exportedSymbols: h.exportedSymbols.slice(0, 6).map((s) => s.name),
      url: h.url,
    })),
  };
}

function evidenceFromCodeMap(
  node: RepoEvolutionNode,
  codeMap: RepoCodeMap | undefined,
  opts: {
    preferLayers?: string[];
    pathRegex?: RegExp;
    limit?: number;
    notePrefix?: string;
  } = {},
): ArchitectureEvidenceRef[] {
  if (!codeMap) return [];
  const limit = opts.limit ?? 2;
  const pool = [...codeMap.hotspots];
  const ranked = pool
    .map((h) => {
      let score = h.score;
      if (opts.preferLayers?.includes(h.layer)) score += 18;
      if (opts.pathRegex?.test(`${h.path} ${h.exportedSymbols.map((s) => s.name).join(" ")}`)) score += 26;
      return { h, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, limit).map(({ h }) => ({
    repoFullName: node.fullName,
    nodeId: node.id,
    path: h.path,
    symbols: h.exportedSymbols.slice(0, 5).map((s) => s.name),
    url: h.url || undefined,
    note: opts.notePrefix
      ? `${opts.notePrefix}（${REPO_CODE_LAYER_LABELS[h.layer]}，入度 ${h.importedByCount}）`
      : `${REPO_CODE_LAYER_LABELS[h.layer]}热点（入度 ${h.importedByCount}，${h.lineCount || "?"} 行）`,
  }));
}

function collectClusterEvidence(
  nodes: RepoEvolutionNode[],
  codeMaps: Map<string, RepoCodeMap>,
  opts: { preferLayers?: string[]; pathRegex?: RegExp; maxRefs?: number } = {},
): ArchitectureEvidenceRef[] {
  const maxRefs = opts.maxRefs ?? 4;
  const out: ArchitectureEvidenceRef[] = [];
  for (const node of nodes) {
    if (out.length >= maxRefs) break;
    const cm = codeMaps.get(node.id);
    if (!cm) continue;
    const refs = evidenceFromCodeMap(node, cm, {
      preferLayers: opts.preferLayers,
      pathRegex: opts.pathRegex,
      limit: 1,
    });
    if (refs[0]) out.push(refs[0]);
  }
  return out;
}

function describeHotspotInline(node: RepoEvolutionNode, cm: RepoCodeMap | undefined): string {
  if (!cm || cm.hotspots.length === 0) return node.fullName;
  const h = cm.hotspots[0];
  const syms = h.exportedSymbols.slice(0, 3).map((s) => s.name);
  return `${node.name}（\`${h.path}\`${syms.length ? ` · ${syms.join("/")}` : ""}）`;
}

function shortHotspotList(nodes: RepoEvolutionNode[], codeMaps: Map<string, RepoCodeMap>, max = 3): string {
  return nodes
    .slice(0, max)
    .map((n) => describeHotspotInline(n, codeMaps.get(n.id)))
    .join("、");
}

function dominantContractLanguage(ownedNodes: RepoEvolutionNode[], codeMaps: Map<string, RepoCodeMap>): "typescript" | "rust" | "python" | "go" {
  const counts = new Map<string, number>();
  for (const n of ownedNodes) {
    const cm = codeMaps.get(n.id);
    const lang = cm?.primaryLanguages[0]?.language || n.primaryLanguage || "";
    const k = lang.toLowerCase();
    if (k.includes("rust")) counts.set("rust", (counts.get("rust") ?? 0) + 2);
    else if (k.includes("go")) counts.set("go", (counts.get("go") ?? 0) + 2);
    else if (k.includes("python")) counts.set("python", (counts.get("python") ?? 0) + 2);
    else if (k.includes("type") || k.includes("java")) counts.set("typescript", (counts.get("typescript") ?? 0) + 2);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top === "rust" || top === "python" || top === "go") return top;
  return "typescript";
}

// ---- Cluster Discovery (Multi-Twin Owned Repos + 1-to-N Star Hubs) ----

export interface ClusterDiscoveryLink {
  sourceNodeId: string;
  targetNodeId: string;
  strength: number;
  status: string;
}

interface BuiltinThemeHint {
  slug: string;
  title: string;
  matchRegex: RegExp;
  domainSlug?: string;
}

const THEME_HINTS: BuiltinThemeHint[] = [
  {
    slug: "browser-perception-action-gateway",
    title: "受控浏览器感知与动作执行网关",
    matchRegex: /chromegate|pagelens-agent|open-chrome-ai|browser-use|nanobrowser|page-agent|automa|agent-browser/i,
    domainSlug: "browser-automation",
  },
  {
    slug: "multi-agent-control-plane-protocol",
    title: "多 Agent 控制面、工具循环与人机审批协议",
    matchRegex: /agent-zoom|ppeng-agent-bot|ai-agent-node|paperclip|ag-ui|openclaw|agent-orchestrator|adk-/i,
    domainSlug: "ai-agents",
  },
  {
    slug: "microvm-untrusted-code-sandbox",
    title: "不可信代码 MicroVM 隔离执行沙箱",
    matchRegex: /agent-sandbox-microvm|e2b-infra-opc|firecracker|cubesandbox|smolvm|agent-sandbox|kuasar|shuru/i,
    domainSlug: "dev-infra",
  },
  {
    slug: "active-learning-tutor-harness",
    title: "主动学习辅导引擎与间隔重复 Harness",
    matchRegex: /learningharness|learn-agent|deeptutor|ranedeer|notebooklm/i,
    domainSlug: "ai-agents",
  },
  {
    slug: "video-dubbing-media-pipeline",
    title: "视频同声传译、配音队列与多模态媒体管线",
    matchRegex: /pagelens-interpret|translate-any-video|pyvideotrans|autoclip|buzz/i,
    domainSlug: "media-creative",
  },
  {
    slug: "audiobook-tts-voice-pipeline",
    title: "有声书切片、TTS 语音克隆与跨端播放管线",
    matchRegex: /audiobook|audio-book-generator|index-tts|kokoro|cosyvoice/i,
    domainSlug: "media-creative",
  },
  {
    slug: "terminal-multiplexer-runtime",
    title: "原生终端运行时与多窗格主题宿主",
    matchRegex: /agent-term|waveterm|wezterm|ghostty|warp|rio/i,
    domainSlug: "dev-infra",
  },
  {
    slug: "knowledge-context-graph-memory",
    title: "上下文图谱、KV-Cache 装配与持久化记忆底座",
    matchRegex: /context-graph|obsidian-palace|my_obsidian_notes|claude-obsidian|tolaria|lmcache|graphrag|mem0/i,
    domainSlug: "rag-knowledge",
  },
];

export function discoverArchitectureClusters(input: {
  ownedNodes: RepoNodeBrief[];
  starNodes: RepoNodeBrief[];
  links: ClusterDiscoveryLink[];
  domains: RepoDomain[];
  existingPrimitives: Array<{ id: string; slug: string; sourceNodeIds: string[] }>;
}): ArchitectureClusterRecommendation[] {
  const ownedById = new Map(input.ownedNodes.map((n) => [n.id, n]));
  const starById = new Map(input.starNodes.map((n) => [n.id, n]));
  const domainById = new Map(input.domains.map((d) => [d.id, d]));

  // Active (non-rejected) links targeting non-fork or spotlight owned repos
  const eligibleOwnedIds = new Set(
    input.ownedNodes
      .filter((n) => !n.isFork || n.priorityTier === "spotlight")
      .map((n) => n.id),
  );

  const activeLinks = input.links.filter(
    (l) => l.status !== "rejected" && eligibleOwnedIds.has(l.targetNodeId) && starById.has(l.sourceNodeId),
  );

  // Map star -> owned targets and owned -> star links
  const starToOwned = new Map<string, Set<string>>();
  const ownedToLinks = new Map<string, ClusterDiscoveryLink[]>();

  for (const l of activeLinks) {
    const sSet = starToOwned.get(l.sourceNodeId) ?? new Set<string>();
    sSet.add(l.targetNodeId);
    starToOwned.set(l.sourceNodeId, sSet);

    const oList = ownedToLinks.get(l.targetNodeId) ?? [];
    oList.push(l);
    ownedToLinks.set(l.targetNodeId, oList);
  }

  // Build weighted adjacency between owned repos sharing >=1 common Star hub (preferring same domain)
  const pairSharedStars = new Map<string, Set<string>>();
  for (const [starId, ownedSet] of starToOwned.entries()) {
    if (ownedSet.size < 2) continue;
    const arr = [...ownedSet];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        const na = ownedById.get(a);
        const nb = ownedById.get(b);
        if (!na || !nb) continue;
        // Require same primary domain to avoid accidental cross-domain chaining via generic stars
        if (na.primaryDomainId && nb.primaryDomainId && na.primaryDomainId !== nb.primaryDomainId) {
          continue;
        }
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const set = pairSharedStars.get(key) ?? new Set<string>();
        set.add(starId);
        pairSharedStars.set(key, set);
      }
    }
  }

  // Group owned repos into connected components over shared hubs
  const adj = new Map<string, Set<string>>();
  for (const [key, shared] of pairSharedStars.entries()) {
    if (shared.size < 1) continue;
    const [a, b] = key.split("|");
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  const visited = new Set<string>();
  const rawGroups: string[][] = [];

  for (const ownedId of adj.keys()) {
    if (visited.has(ownedId)) continue;
    const comp: string[] = [];
    const queue = [ownedId];
    visited.add(ownedId);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const nxt of adj.get(cur) ?? []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    if (comp.length >= 2) {
      rawGroups.push(comp);
    }
  }

  // Also include spotlight or heavily linked standalone owned repos (e.g. local/ai-agent-node if it has >=5 links and isn't already grouped)
  // Or merge local/ai-agent-node into the agent-zoom/ppeng-agent-bot control-plane cluster when both are in ai-agents domain!
  const agentControlGroup = rawGroups.find((g) =>
    g.some((id) => /agent-zoom|ppeng-agent-bot/i.test(ownedById.get(id)?.fullName ?? "")),
  );
  for (const n of input.ownedNodes) {
    if (!eligibleOwnedIds.has(n.id)) continue;
    if (visited.has(n.id)) continue;
    if (agentControlGroup && /ai-agent-node/i.test(n.fullName)) {
      agentControlGroup.push(n.id);
      visited.add(n.id);
      continue;
    }
    const linksForNode = ownedToLinks.get(n.id) ?? [];
    if (linksForNode.length >= 5 || (n.priorityTier === "spotlight" && linksForNode.length >= 2)) {
      rawGroups.push([n.id]);
      visited.add(n.id);
    }
  }

  const recommendations: ArchitectureClusterRecommendation[] = [];

  for (const groupOwnedIds of rawGroups) {
    const groupOwnedSet = new Set(groupOwnedIds);
    const groupOwned = groupOwnedIds
      .map((id) => ownedById.get(id))
      .filter((x): x is RepoNodeBrief => Boolean(x))
      .sort((a, b) => (b.priorityTier === "spotlight" ? 1 : 0) - (a.priorityTier === "spotlight" ? 1 : 0) || b.starsCount - a.starsCount);

    // Gather all links touching this owned group
    const groupLinks = activeLinks.filter((l) => groupOwnedSet.has(l.targetNodeId));
    if (groupLinks.length < 2) continue;

    // Score each star node by how many owned repos in this group it bridges + strength + popularity
    const starScores = new Map<string, { bridged: number; maxStrength: number; totalStrength: number }>();
    for (const l of groupLinks) {
      const cur = starScores.get(l.sourceNodeId) ?? { bridged: 0, maxStrength: 0, totalStrength: 0 };
      cur.bridged++;
      cur.maxStrength = Math.max(cur.maxStrength, l.strength);
      cur.totalStrength += l.strength;
      starScores.set(l.sourceNodeId, cur);
    }

    const sharedHubCount = [...starScores.values()].filter((s) => s.bridged >= 2).length;
    const rankedStars = [...starScores.entries()]
      .map(([starId, stat]) => ({ node: starById.get(starId), stat }))
      .filter((x): x is { node: RepoNodeBrief; stat: { bridged: number; maxStrength: number; totalStrength: number } } => Boolean(x.node))
      .sort(
        (a, b) =>
          b.stat.bridged - a.stat.bridged ||
          b.stat.maxStrength - a.stat.maxStrength ||
          b.node.starsCount - a.node.starsCount,
      );

    const topStars = rankedStars.slice(0, 6).map((x) => x.node);
    const allNames = [...groupOwned.map((n) => n.fullName), ...topStars.map((n) => n.fullName)].join(" ");

    // Dominant domain
    const domCounts = new Map<string, number>();
    for (const o of groupOwned) {
      if (o.primaryDomainId) domCounts.set(o.primaryDomainId, (domCounts.get(o.primaryDomainId) ?? 0) + 1);
    }
    const primaryDomainId = [...domCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const domain = primaryDomainId ? domainById.get(primaryDomainId) ?? null : null;

    // Pick crisp title/slug
    const hint = THEME_HINTS.find((h) => h.matchRegex.test(allNames));
    let slug =
      hint?.slug ??
      slugifyPrimitive(`${domain?.slug ?? "arch"}-${groupOwned.slice(0, 2).map((n) => n.name).join("-")}`);
    if (recommendations.some((r) => r.slug === slug)) {
      slug = `${slug}-${slugifyPrimitive(groupOwned[0]?.name ?? String(recommendations.length + 1))}`;
    }
    const title =
      hint?.title ??
      (domain
        ? `${domain.name}：${groupOwned.slice(0, 2).map((n) => n.name).join(" / ")} 核心原语`
        : `${groupOwned.slice(0, 2).map((n) => n.name).join(" / ")} 跨库架构原语`);

    const avgStrength = groupLinks.reduce((s, l) => s + l.strength, 0) / Math.max(1, groupLinks.length);
    const hasSpotlight = groupOwned.some((o) => o.priorityTier === "spotlight");
    const densityScore =
      Math.round(
        (sharedHubCount * 3.8 +
          groupOwned.length * 2.4 +
          Math.min(groupLinks.length, 24) * 0.65 +
          avgStrength * 5 +
          (hasSpotlight ? 2.5 : 0)) *
          100,
      ) / 100;

    const ownedNames = groupOwned.map((o) => o.name).join(" / ");
    const hubNames = rankedStars
      .filter((x) => x.stat.bridged >= 2)
      .slice(0, 3)
      .map((x) => x.node.fullName)
      .join("、");

    const rationale =
      groupOwned.length >= 2
        ? `识别到 ${groupOwned.length} 个多胞胎自有仓（${ownedNames}）共享 ${sharedHubCount} 个 1 对 N 高扇出 Star 枢纽` +
          (hubNames ? `（${hubNames}）` : "") +
          `，共汇聚 ${groupLinks.length} 条有效吸收连线，具备高密度底座收敛与第一性原理抽象价值。`
        : `重点自有仓 ${ownedNames} 汇聚 ${groupLinks.length} 条高质量 Star 吸收连线（参考 ${topStars
            .slice(0, 3)
            .map((s) => s.fullName)
            .join("、")}），适合抽象可复用的第一性原理原语。`;

    // Match existing primitive by slug or >=50% owned overlap
    const existing = input.existingPrimitives.find((p) => {
      if (p.slug === slug) return true;
      const pSet = new Set(p.sourceNodeIds);
      const hitOwned = groupOwned.filter((o) => pSet.has(o.id)).length;
      return hitOwned >= Math.max(1, Math.ceil(groupOwned.length * 0.6));
    });

    const clusterId = `clu_${createHash("sha256").update(slug).digest("hex").slice(0, 12)}`;
    recommendations.push({
      id: clusterId,
      slug,
      title,
      rationale,
      domainId: domain?.id ?? null,
      domainName: domain?.name ?? null,
      domainColor: domain?.color ?? null,
      densityScore,
      ownedNodes: groupOwned,
      starNodes: topStars,
      sharedHubCount,
      linkCount: groupLinks.length,
      existingPrimitiveId: existing?.id ?? null,
      existingPrimitiveSlug: existing?.slug ?? null,
    });
  }

  return recommendations
    .sort((a, b) => b.densityScore - a.densityScore || b.sharedHubCount - a.sharedHubCount)
    .slice(0, 12);
}

// ---- First-Principles Blueprint Distillation (LLM + Deep Code-Map-Grounded Synthesizer) ----

type ArchetypeKind =
  | "browser_execution_gateway"
  | "agent_control_plane"
  | "microvm_sandbox"
  | "generic_evidence_driven";

function detectArchetype(
  title: string,
  domainSlug: string | null,
  nodes: RepoEvolutionNode[],
  codeMaps: Map<string, RepoCodeMap>,
): ArchetypeKind {
  // 1. Explicit title / domainSlug authority first (prevents stray topic mentions like "browser-use" in ai-agent-node from hijacking control-plane clusters!)
  const headText = `${title} ${domainSlug ?? ""}`.toLowerCase();
  if (/(?:microvm|沙箱|sandbox|firecracker|e2b)/.test(headText)) {
    return "microvm_sandbox";
  }
  if (/(?:浏览器|browser-automation|browser-perception|chromegate|pagelens|dom.*网关|动作执行网关)/.test(headText)) {
    return "browser_execution_gateway";
  }
  if (/(?:控制面|工具循环|审批协议|control-plane|ai-agents|multi-agent|多\s*agent)/.test(headText)) {
    return "agent_control_plane";
  }

  // 2. Multi-repo weighted vote when title & domain are custom/unmatched
  let sandboxScore = 0;
  let browserScore = 0;
  let agentScore = 0;

  for (const n of nodes) {
    const cm = codeMaps.get(n.id);
    const sig = [
      n.fullName,
      n.description,
      n.topics.join(" "),
      ...(cm?.hotspots.slice(0, 3).map((h) => h.path) ?? []),
    ]
      .join(" ")
      .toLowerCase();
    if (/(?:microvm|firecracker|e2b|cubesandbox|agent-sandbox|jailer|hypervisor|virtio|vmm|vsock|kvm)/.test(sig)) {
      sandboxScore += 3;
    }
    if (/(?:chromegate|pagelens|browser-use|nanobrowser|page-agent|chrome-extension|sidepanel|playwright|agent-browser|automa)/.test(sig)) {
      browserScore += 2;
    }
    if (/(?:agent-zoom|ai-agent-node|ppeng-agent-bot|paperclip|ag-ui|agent-loop|modelcontextprotocol|adk-|multi-agent|orchestrat|approval)/.test(sig)) {
      agentScore += 2;
    }
  }

  const best = Math.max(sandboxScore, browserScore, agentScore);
  if (best < 3) return "generic_evidence_driven";
  if (sandboxScore === best) return "microvm_sandbox";
  if (browserScore >= agentScore) return "browser_execution_gateway";
  return "agent_control_plane";
}

export interface DistilledBlueprintPayload {
  title: string;
  problemStatement: string;
  firstPrinciples: ArchitectureFirstPrinciple[];
  tradeoffMatrix: ArchitectureTradeoffMatrix;
  primitiveSpec: ArchitecturePrimitiveSpec;
  consolidationPlan: ArchitectureConsolidationItem[];
}

function buildBrowserGatewayBlueprint(input: {
  title: string;
  problemStatement?: string;
  ownedNodes: RepoEvolutionNode[];
  starNodes: RepoEvolutionNode[];
  codeMaps: Map<string, RepoCodeMap>;
}): DistilledBlueprintPayload {
  const { ownedNodes, starNodes, codeMaps } = input;
  const allNodes = [...ownedNodes, ...starNodes];

  // Partition real repos into disjoint architectural routes (no repo duplicated across contradictory routes)
  const route1Repos = starNodes.filter((n) => {
    const cm = codeMaps.get(n.id);
    const sig = `${n.fullName} ${n.primaryLanguage ?? ""} ${cm?.topExternalDeps.map((d) => d.name).join(" ") ?? ""}`.toLowerCase();
    return /browser-use|playwright|cdp|agent-browser|page-agent/.test(sig);
  });
  const usedInR1 = new Set(route1Repos.map((r) => r.id));
  const route2Repos = allNodes.filter((n) => {
    if (usedInR1.has(n.id)) return false;
    const cm = codeMaps.get(n.id);
    const sig = `${n.fullName} ${cm?.files.map((f) => f.path).join(" ") ?? ""}`.toLowerCase();
    return n.role === "owned" || n.role === "both" || /chromegate|pagelens|open-chrome|nanobrowser|extension|sidepanel/.test(sig);
  });
  const usedInR12 = new Set([...usedInR1, ...route2Repos.map((r) => r.id)]);
  const route3Repos = starNodes.filter((n) => !usedInR12.has(n.id));

  const finalRoute1 = route1Repos.length ? route1Repos : starNodes.slice(0, 2);
  const finalRoute2 = route2Repos.length ? route2Repos : ownedNodes;
  const finalRoute3 = route3Repos;

  const problemStatement =
    input.problemStatement?.trim() ||
    `围绕 ${ownedNodes.map((n) => n.name).join(" / ")} 与标杆开源项目 ${starNodes
      .slice(0, 4)
      .map((n) => n.fullName)
      .join("、")} 的真实源码解剖，解决 AI Agent 操纵真实浏览器时的三大核心矛盾：动态 DOM 爆炸导致的感知失真、高权限登录态下的越权执行风险、以及 MV3 扩展 / 本地网关 / 无头 CDP 多端重复造轮子。`;

  const firstPrinciples: ArchitectureFirstPrinciple[] = [
    {
      id: "fp_browser_dom_entropy",
      title: "感知带宽与 DOM 熵增定律（索引化交互树优先于原始 HTML）",
      category: "physics",
      constraint:
        "现代 SPA 页面原始 HTML 常超过 50K–200K tokens 且混杂不可见遮罩与虚拟滚动；Agent 只能消费经过可见性/可交互性裁剪并绑定稳定 Ref ID 的「交互快照（Interactive Snapshot）」，而非整页 HTML 或纯像素坐标。",
      whyIrreducible:
        "LLM 上下文窗口、推理延迟与 Token 成本受限于输入长度线性/平方增长；同时纯坐标点击在响应式缩放、iframe 与异步渲染下天然脆弱。",
      failureWhenViolated:
        "单步推理耗尽上下文或延迟飙升至 >10s，模型在隐藏节点/遮挡层上反复空点，导致长流程表单（如跨境电商上架）成功率断崖式下跌。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /dom|tree|snapshot|extract|content|page|selector|locator|a11y|accessibility/i,
        preferLayers: ["core", "protocol"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_browser_mv3_lifecycle",
      title: "MV3 Service Worker 无常驻与双进程消息边界约束",
      category: "engineering",
      constraint:
        "Chrome MV3 后台 Service Worker 随时会被浏览器回收休眠，且 Content Script 与主页面 World 严格隔离；会话状态、任务队列与长连接必须与执行脚本解耦，采用幂等事件驱动 + 持久化 Checkpoint。",
      whyIrreducible:
        "Chromium 安全沙箱强制隔离扩展世界与页面 JS 堆内存，并强制终止空闲超过 30 秒的 Service Worker，这是浏览器内核硬规则而非框架选型问题。",
      failureWhenViolated:
        "长任务中途 Service Worker 被杀导致上下文丢失、Tab 重载后动作回调悬空，或多窗口并发执行时出现串 Tab 误操作。",
      evidence: collectClusterEvidence(finalRoute2, codeMaps, {
        pathRegex: /background|worker|bridge|gateway|message|runtime|session|tab|sidepanel/i,
        preferLayers: ["entry", "protocol", "core"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_browser_trust_boundary",
      title: "用户登录态主权与不可逆动作审批门禁",
      category: "security",
      constraint:
        "复用用户真实 Chrome 登录态意味着 Agent 拥有与用户等同的资金/发布/删除权限；所有外部网页内容均为不可信输入（Prompt Injection 面），写操作（提交、改价、发布、支付）必须在动作网关层强制执行白名单与人工确认闸门。",
      whyIrreducible:
        "网页 DOM 中可嵌入隐藏提示注入指令，单靠 LLM System Prompt 无法在安全语义上隔离「数据」与「控制指令」，必须依赖确定性协议网关拦截。",
      failureWhenViolated:
        "恶意页面通过隐藏文本劫持 Agent 读取 Cookie/提交错误价格/触发不可逆上架或转账操作。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /action|guard|policy|approval|permission|auth|security|gateway|controller|executor/i,
        preferLayers: ["protocol", "infra", "core"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_browser_action_verify",
      title: "闭环后验校验约束（Action → Readback → Diff）",
      category: "reliability",
      constraint:
        "DOM 事件派发成功（click/input 返回）绝不等于业务状态提交成功；每次变异操作必须伴随目标节点读回（Readback）、网络/DOM 稳定等待与可观测状态 Diff，失败时只做幂等局部修复。",
      whyIrreducible:
        "受控前端框架（React/Vue/TikTok 商家后台）内部维护异步状态机与表单校验，合成事件若未触发框架状态同步或遇网络抖动，表面无报错但数据未落库。",
      failureWhenViolated:
        "Agent 误判填表/改价成功而继续下一步，最终产生静默残缺草稿或反复重头整页重填浪费大量 Token。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /verify|readback|action|executor|agent|step|state|form|retry/i,
        preferLayers: ["core", "storage"],
        maxRefs: 3,
      }),
    },
  ];

  const dimensions: ArchitectureTradeoffDimension[] = [
    { key: "login_reuse", label: "真实登录态复用", description: "能否直接复用用户已登录浏览器会话与风控指纹" },
    { key: "dom_precision", label: "DOM 感知与定位精度", description: "对复杂 SPA/ShadowDOM/iframe 的元素定位稳定性" },
    { key: "concurrency", label: "多窗口并发与隔离", description: "同时驱动多任务且不串 Tab/状态的能力" },
    { key: "deploy_cost", label: "部署门槛与维护成本", description: "本地/服务端依赖复杂度与抗前端改版成本" },
  ];

  const approaches: ArchitectureTradeoffApproach[] = [
    {
      id: "app_cdp_dom_engine",
      name: "CDP / Playwright 协议直控 + 结构化 DOM 索引树",
      representativeRepos: finalRoute1.slice(0, 3).map((r) => r.fullName),
      gains: "直接穿透 ShadowDOM/iframe、完整截获网络响应与 AXTree、易于无头集群并发和确定性回放。",
      sacrifices: "难以无缝复用用户日常登录态，易触发电商/社媒反爬风控，本地需维护浏览器二进制或调试端口。",
      bestFor: "批量抓取、自动化测试、独立账号隔离池与高并发云端浏览器执行。",
      scores: {
        login_reuse: "中低（需 Cookie 注入/独立 Profile）",
        dom_precision: "极高（CDP AXTree + DOM 联合索引）",
        concurrency: "极高（多 Context 原生隔离）",
        deploy_cost: "中（需 Playwright/Chromium 运行时）",
      },
      evidence: collectClusterEvidence(finalRoute1, codeMaps, { maxRefs: 3 }),
    },
    {
      id: "app_mv3_sidepanel_gateway",
      name: "Chrome MV3 扩展侧栏 + 本地 Bridge 网关混合架构",
      representativeRepos: finalRoute2.slice(0, 5).map((r) => r.fullName),
      gains: "零风控复用用户真实登录态与 Cookie，天然支持侧栏人机协同审批（Human-in-the-Loop）与实时接管。",
      sacrifices: "受 MV3 Service Worker 休眠与 CSP 沙箱限制，跨 Tab 并发编排与文件系统交互需额外本地 Gateway 桥接。",
      bestFor: "高价值登录态后台（TikTok Shop、SaaS 运营、财务/ERP 填表）的人机协同执行。",
      scores: {
        login_reuse: "极高（原生复用真实 Chrome 会话）",
        dom_precision: "高（Content Script + Debugger/AX 补齐）",
        concurrency: "中（依赖 Tab/Window Lease 调度）",
        deploy_cost: "低（扩展 + 轻量本地桥）",
      },
      evidence: collectClusterEvidence(finalRoute2, codeMaps, { maxRefs: 3 }),
    },
    ...(finalRoute3.length > 0
      ? [
          {
            id: "app_vision_gui_workflow",
            name: "视觉/桌面 GUI 或声明式工作流编排路线",
            representativeRepos: finalRoute3.slice(0, 3).map((r) => r.fullName),
            gains: "可突破浏览器边界操作 Canvas/弹窗/系统文件选择器，或通过可视化工作流固化确定性步骤零 Token 复用。",
            sacrifices: "纯视觉定位延迟高且易受分辨率漂移影响；纯静态工作流面对页面改版缺乏语义自愈能力。",
            bestFor: "跨桌面文件上传、Canvas 交互或高频固定流程的确定性批处理。",
            scores: {
              login_reuse: "高（直接操纵宿主桌面/浏览器）",
              dom_precision: "中（依赖多模态视觉或预录选择器）",
              concurrency: "低（独占焦点窗口）",
              deploy_cost: "中高（视觉模型或录制器维护）",
            },
            evidence: collectClusterEvidence(finalRoute3, codeMaps, { maxRefs: 3 }),
          },
        ]
      : []),
  ];

  const tradeoffMatrix: ArchitectureTradeoffMatrix = {
    summary: `解剖 ${allNodes.length} 个仓库的真实 Code Map（自有仓 ${shortHotspotList(ownedNodes, codeMaps, 3)}；Star 标杆 ${shortHotspotList(starNodes, codeMaps, 3)}）表明：核心分岔点在于「通过 CDP 换取底层控制与并发」还是「通过 MV3 扩展换取真实登录态与人机协同」——最优解是以统一 BrowserExecutionProtocol 下沉解耦感知/动作原语，上层可切换 MV3 或 CDP 传输驱动。`,
    dimensions,
    approaches,
  };

  const primitiveSpec: ArchitecturePrimitiveSpec = {
    coreThesis:
      "将浏览器自动化收敛为「可移植的 4 原语闭环」：Lease（会话/窗口租约）→ Snapshot（低熵可交互 DOM/AX 索引快照）→ GuardedAction（带策略闸门与人工确认的原子动作）→ ReadbackDiff（状态读回与稳定校验），屏蔽 MV3 与 CDP 传输差异。",
    entities: [
      {
        name: "SessionLeaseManager",
        responsibility: "管理浏览器窗口/Tab/Context 的独占租约、心跳续约与崩溃回收，杜绝多任务并发串 Tab。",
        boundaries: "只维护租约与路由拓扑，不感知具体业务页面语义或 Prompt。",
        keyOperations: ["acquireLease(profile, windowSpec)", "heartbeat(leaseId)", "releaseLease(leaseId)"],
      },
      {
        name: "PerceptionSnapshotter",
        responsibility: "将当前页面裁剪为带稳定 elementRef 的最小可交互元素树（DOM + AXTree + 可选视口截图），控制 Token 预算。",
        boundaries: "纯只读观测，绝不触发任何页面状态变更或副作用。",
        keyOperations: ["captureSnapshot(leaseId, budget)", "resolveRef(leaseId, refId)", "diffSnapshots(prev, next)"],
      },
      {
        name: "PolicyActionGateway",
        responsibility: "对每个原子动作（click/type/select/upload/navigate）执行域名白名单、敏感写操作分类与人工审批拦截。",
        boundaries: "确定性策略引擎，不受网页不可信文本或模型自由输出绕过。",
        keyOperations: ["evaluatePolicy(action, pageOrigin)", "requestHumanApproval(action)", "executeGuarded(leaseId, action)"],
      },
      {
        name: "ActionVerifier",
        responsibility: "动作派发后等待 DOM/网络静默，执行字段 Readback 与预期断言，返回结构化回执供上层做局部自愈。",
        boundaries: "只做后验读回与结构化诊断，不自行编排业务重试策略。",
        keyOperations: ["waitForSettled(leaseId, timeoutMs)", "readbackValue(leaseId, refId)", "verifyPostCondition(leaseId, expect)"],
      },
    ],
    contractLanguage: "typescript",
    protocolContractCode: `export type ActionRiskTier = "read_only" | "state_draft" | "irreversible_commit";

export interface InteractiveElementRef {
  refId: string;           // 稳定短 ID（如 "e14"），绑定当前 snapshotEpoch
  role: string;            // ARIA role / tag
  label: string;           // 裁剪后的可访问名称
  bbox?: [number, number, number, number];
  state?: { disabled?: boolean; checked?: boolean; valuePreview?: string };
}

export interface PageSnapshot {
  leaseId: string;
  snapshotEpoch: number;
  url: string;
  title: string;
  elements: InteractiveElementRef[];
  domHash: string;
  capturedAt: string;
}

export interface BrowserActionCommand {
  idempotencyKey: string;
  snapshotEpoch: number;   // 强制乐观锁：页面跳变即拒绝陈旧动作
  kind: "click" | "fill" | "select" | "scroll" | "navigate" | "upload" | "wait";
  refId?: string;
  value?: string;
  riskTier: ActionRiskTier;
  expectReadback?: { refId?: string; containsText?: string; urlPattern?: string };
}

export interface ActionReceipt {
  ok: boolean;
  status: "executed" | "awaiting_approval" | "stale_snapshot" | "policy_blocked" | "readback_mismatch";
  readbackValue?: string;
  domChanged: boolean;
  newSnapshotEpoch?: number;
  error?: string;
}

export interface BrowserExecutionDriver {
  readonly transport: "mv3_extension" | "cdp_playwright";
  captureSnapshot(leaseId: string, opts?: { maxElements?: number }): Promise<PageSnapshot>;
  dispatchAction(leaseId: string, cmd: BrowserActionCommand): Promise<ActionReceipt>;
}`,
    invariants: [
      "所有变异动作必须携带 snapshotEpoch 乐观锁；若页面已发生导航或 DOM 剧烈变化，网关必须拒绝执行并返回 stale_snapshot 强制重采样。",
      "riskTier === 'irreversible_commit'（发布/支付/删除/改正式价）在未获得确定性审批票据前，驱动层物理拒绝派发底层事件。",
      "并发任务之间严格按 Window/Tab Lease 隔离，同一 Tab 同一时刻最多存在 1 个在途变异动作。",
      "网页内容提取区与指令通道严格分离，Snapshot 序列化只输出结构化属性字段，杜绝页面文本注入工具调用。",
    ],
    failureModesAndGuardrails: [
      {
        failureMode: "MV3 Service Worker 休眠导致长任务中断",
        impact: "执行流丢失进度、Promise 永不返回",
        guardrail: "任务状态与 Checkpoint 持久化到 IndexedDB/本地 Gateway，心跳唤醒后按 idempotencyKey 续跑",
        detectionSignal: "lease heartbeat 超时 > 15s 或 chrome.runtime.lastError",
      },
      {
        failureMode: "React/Vue 受控输入框合成事件未触发框架状态",
        impact: "界面看似填入但提交为空值或旧价",
        guardrail: "使用 native value setter + input/change 事件链，并在 ActionVerifier 中强制读回表单值校验",
        detectionSignal: "readback_mismatch 回执或保存后表单回显与预期不符",
      },
      {
        failureMode: "恶意网页隐藏 Prompt Injection 诱导误操作",
        impact: "泄露敏感会话或触发非授权发布/删除",
        guardrail: "PolicyActionGateway 基于 URL Origin + riskTier 做确定性拦截，高风险动作强制人工确认",
        detectionSignal: "policy_blocked 审计日志或跨 Origin 敏感动作告警",
      },
      {
        failureMode: "陈旧 Ref 误点（异步弹窗/骨架屏移位）",
        impact: "点击错位按钮引发级联异常",
        guardrail: "强制校验 snapshotEpoch + 元素可见性/命中测试（elementFromPoint），失配立即返回 stale_snapshot",
        detectionSignal: "stale_snapshot 连续触发 >= 2 次",
      },
    ],
    mermaidDiagram: `flowchart LR
  Agent["Agent Planner / Workflow"] -->|"BrowserActionCommand (epoch + riskTier)"| Gateway["PolicyActionGateway (Origin & Approval Gate)"]
  Gateway -->|"approved"| Lease["SessionLeaseManager (Window/Tab Lease)"]
  Gateway -.->|"irreversible_commit"| Human["Human Approval / Mailbox"]
  Lease -->|"MV3 Bridge or CDP"| Driver["BrowserExecutionDriver"]
  Driver -->|"DOM/AXTree Trim"| Snap["PerceptionSnapshotter (Ref IDs)"]
  Driver -->|"Event Dispatch"| Page["Target Web Page"]
  Page -->|"Readback & Settled Check"| Verifier["ActionVerifier (Diff Receipt)"]
  Snap -->|"PageSnapshot"| Agent
  Verifier -->|"ActionReceipt"| Agent`,
    diagramCaption: "受控浏览器感知与动作执行网关：以统一驱动协议打通 MV3 与 CDP，内置租约隔离、风险门禁与后验读回闭环。",
  };

  const consolidationPlan = buildConsolidationItemsForCluster({
    archetype: "browser_execution_gateway",
    ownedNodes,
    starNodes,
    codeMaps,
  });

  return {
    title: input.title,
    problemStatement,
    firstPrinciples,
    tradeoffMatrix,
    primitiveSpec,
    consolidationPlan,
  };
}

function buildAgentControlPlaneBlueprint(input: {
  title: string;
  problemStatement?: string;
  ownedNodes: RepoEvolutionNode[];
  starNodes: RepoEvolutionNode[];
  codeMaps: Map<string, RepoCodeMap>;
}): DistilledBlueprintPayload {
  const { ownedNodes, starNodes, codeMaps } = input;
  const allNodes = [...ownedNodes, ...starNodes];

  const protocolStars = starNodes.filter((n) =>
    /ag-ui|mcp|adk|pi|openfuse|router/i.test(`${n.fullName} ${n.description}`),
  );
  const controlPlaneStars = starNodes.filter((n) =>
    /paperclip|openclaw|pilotdeck|multica|orchestrator|cowagent/i.test(`${n.fullName} ${n.description}`),
  );

  const route1Repos = controlPlaneStars.length ? controlPlaneStars : starNodes.slice(0, 2);
  const route2Repos = protocolStars.length ? protocolStars : starNodes.slice(1, 3);
  const route3Repos = ownedNodes;

  const problemStatement =
    input.problemStatement?.trim() ||
    `围绕自有核心资产 ${ownedNodes.map((n) => n.name).join(" / ")} 与标杆开源生态 ${starNodes
      .slice(0, 4)
      .map((n) => n.fullName)
      .join("、")} 的真实源码 Code Map，提炼多渠道、多 Agent 协同场景下的统一控制面原语：解决事件流协议分裂、长程工具循环失控、人机审批阻塞与多仓重复封装运行时底座的问题。`;

  const firstPrinciples: ArchitectureFirstPrinciple[] = [
    {
      id: "fp_agent_event_stream",
      title: "控制面与模型推理的强解耦（Append-Only 事件流为唯一事实源）",
      category: "protocol",
      constraint:
        "LLM Token 流、工具调用（MCP/Local Tool）、子 Agent 委托、审批暂停与人工纠偏必须在同一条有序、可回放的强类型事件流（Event Stream）上表达，UI/IM 渠道只消费事件投影，绝不直接耦合底层 SDK 循环。",
      whyIrreducible:
        "多渠道接入（飞书/钉钉/Web/Socket.IO/CLI）与断线重连要求状态可从任意游标重放；若渠道逻辑散落在 Agent Runner 回调里，新增渠道或切换底层模型必然引发指数级胶水爆炸。",
      failureWhenViolated:
        "Web 端与 IM 端消息状态不一致、刷新页面丢失工具执行中间态、更换 LLM/Agent Loop 需重写全套渠道适配代码。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /event|stream|protocol|ag-ui|socket|dispatch|message|channel|adapter|router|ws/i,
        preferLayers: ["protocol", "core"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_agent_session_isolation",
      title: "会话状态机隔离与显式预算上限（Bounded Tool Loop）",
      category: "reliability",
      constraint:
        "每个 Agent 会话必须拥有独立的 Context/工作区边界、确定性的状态迁移（running → awaiting_approval → resumed → completed/failed）与硬性资源护栏（最大步数、Token 预算、单工具超时、循环检测）。",
      whyIrreducible:
        "LLM 具备概率性幻觉与工具重试震荡特性，无边界 ReAct 循环在遇到持续错误工具时必然演变为无限死循环与账单失控。",
      failureWhenViolated:
        "并发会话上下文互相污染、单个异常工具拖垮整进程、或无人值守夜间任务烧干模型额度却无有效产出。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /loop|runner|agent|session|state|store|scheduler|orchestr|context|budget/i,
        preferLayers: ["core", "storage"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_agent_hitl_checkpoint",
      title: "人机审批作为一等中断原语（可持久化挂起与幂等恢复）",
      category: "security",
      constraint:
        "高风险动作（外部写操作、删库、发钱、发版、私有仓外发）不得以阻塞内存线程的方式等待人工确认，必须将当前 Loop Checkpoint 持久化并释放计算槽位，待总裁信箱/审批流回执到达后按幂等键恢复执行。",
      whyIrreducible:
        "人类决策延迟在分钟至天级别，远超 HTTP/WebSocket 连接与进程生命周期；只有可序列化的挂起原语才能兼顾零阻塞吞吐与 100% 审计留痕。",
      failureWhenViolated:
        "进程重启导致待批任务全部丢失或重复执行高风险副作用，或者为了避免阻塞被迫绕过审批酿成生产事故。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /decision|approval|mailbox|gate|policy|permission|checkpoint|guard|human|review/i,
        preferLayers: ["core", "protocol", "storage"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_agent_capability_contract",
      title: "工具与子 Agent 能力的统一声明契约（MCP + Schema + 隐私分级）",
      category: "engineering",
      constraint:
        "工具调用与跨 Agent 委托统一以 JSON Schema 契约 + 风险分级 + 数据隐私边界（如私有仓 `allowLlmAnalysis=false` 零外发）声明，运行时按最小权限动态装配可见工具集。",
      whyIrreducible:
        "把上百个工具无差别塞进 System Prompt 会直接劣化模型工具选择准确率并放大越权爆炸半径。",
      failureWhenViolated:
        "工具调用参数幻觉频发、私有敏感代码被意外送入公网模型端点、或子 Agent 无限递归派生耗尽宿主机资源。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /mcp|tool|skill|plugin|registry|schema|privacy|security|client|server/i,
        preferLayers: ["protocol", "infra"],
        maxRefs: 4,
      }),
    },
  ];

  const dimensions: ArchitectureTradeoffDimension[] = [
    { key: "protocol_std", label: "事件流与前后端协议标准化", description: "流式 UI、工具进度、审批卡片的协议规范度" },
    { key: "multi_channel", label: "多渠道接入与路由能力", description: "IM/Web/Cron/Webhook/A2A 统一调度能力" },
    { key: "governance", label: "组织治理、预算与审批闭环", description: "成本护栏、角色分工、审计留痕与人工闸门" },
    { key: "extensibility", label: "运行时轻量化与可插拔度", description: "替换模型/Loop/存储引擎的改造代价" },
  ];

  const approaches: ArchitectureTradeoffApproach[] = [
    {
      id: "app_org_control_plane",
      name: "组织级多 Agent 控制面与任务编排中枢",
      representativeRepos: route1Repos.slice(0, 3).map((r) => r.fullName),
      gains: "内置组织架构、任务认领、预算审计、多 Agent 协同看板与持久化状态，开箱即支撑公司级自治运行。",
      sacrifices: "领域模型较重，与特定数据库/UI 强耦合，难以作为轻量嵌入式 SDK 直接复用到子工具仓。",
      bestFor: "OPC OS / 数字员工集群中控、多角色研发交付与经营审批编排。",
      scores: {
        protocol_std: "中高（自有 RPC/SSE 事件模型）",
        multi_channel: "高（Web + Webhook + Agent Adapter）",
        governance: "极高（预算/权限/审批/审计完备）",
        extensibility: "中（模块化但底座偏重）",
      },
      evidence: collectClusterEvidence(route1Repos, codeMaps, { maxRefs: 3 }),
    },
    {
      id: "app_protocol_first_sdk",
      name: "协议优先流式交互层（AG-UI / MCP / ADK）",
      representativeRepos: route2Repos.slice(0, 3).map((r) => r.fullName),
      gains: "前后端流式状态同步（Text/ToolCall/StateDelta/Interrupt）标准化，跨语言跨框架极易互操作。",
      sacrifices: "只定义传输与运行原语，不包含多渠道 IM 网关、业务审批流与长期组织记忆，需上层组装。",
      bestFor: "作为全系产品的共享协议层与可嵌入 Agent Loop Sdk 内核。",
      scores: {
        protocol_std: "极高（强类型事件流与状态增量协议）",
        multi_channel: "中（偏 Web/SDK，IM 需适配层）",
        governance: "中（提供 Interrupt 钩子，无完整审批系统）",
        extensibility: "极高（零侵入插拔模型与工具）",
      },
      evidence: collectClusterEvidence(route2Repos, codeMaps, { maxRefs: 3 }),
    },
    {
      id: "app_owned_multi_channel_runtime",
      name: "自有端云多渠道编排栈（本仓实盘演化线）",
      representativeRepos: route3Repos.slice(0, 4).map((r) => r.fullName),
      gains: "深度贴合真实业务场景（飞书/企微/钉钉/OPC 经营中控/本地私有代码零外发），迭代极快。",
      sacrifices: `当前分散在 ${route3Repos.map((r) => r.name).join(" / ")} 等多仓中，Dispatcher、Event Stream、MCP Client 与审批协议存在重复实现与漂移风险。`,
      bestFor: "收敛下沉为统一的 Shared Control-Plane Kernel + Protocol Package 后继续高速支撑全线业务。",
      scores: {
        protocol_std: "中（各仓事件格式尚待统一至 AG-UI 风格）",
        multi_channel: "极高（覆盖 IM/Socket.IO/Cron/ERP/OPC）",
        governance: "高（已具备总裁信箱与私有仓零外发门禁）",
        extensibility: "待收敛（多胞胎仓共享内核抽取中）",
      },
      evidence: collectClusterEvidence(route3Repos, codeMaps, { maxRefs: 4 }),
    },
  ];

  const tradeoffMatrix: ArchitectureTradeoffMatrix = {
    summary: `结合 ${ownedNodes.length} 个自有 Agent 仓（${shortHotspotList(ownedNodes, codeMaps, 3)}）与 ${starNodes.length} 个标杆 Star 仓（${shortHotspotList(starNodes, codeMaps, 3)}）的真实导入拓扑：核心权衡在于「协议轻量化互操作」vs「组织级多渠道治理厚度」。最优架构是下沉单一标准事件流 + 有界 Tool Loop 内核，把 IM 渠道、Web UI 与总裁审批流全部变为可插拔投影适配器。`,
    dimensions,
    approaches,
  };

  const primitiveSpec: ArchitecturePrimitiveSpec = {
    coreThesis:
      "以「单调递增的 RunEvent 事件流 + 可持久化挂起的 ApprovalInterrupt + 隐私分级的 ToolRegistry」构成最小多 Agent 控制面原语，彻底解耦底层模型循环、多渠道接入与人工审批。",
    entities: [
      {
        name: "ChannelIngressDispatcher",
        responsibility: "将 IM（飞书/钉钉/企微）、WebSocket、Cron、A2A 请求标准化为统一 InboundEnvelope 并路由至隔离会话。",
        boundaries: "只做鉴权、去重、会话路由与出站回写，不内嵌 LLM Prompt 或工具逻辑。",
        keyOperations: ["normalizeInbound(raw)", "routeToSession(envelope)", "emitOutbound(sessionId, event)"],
      },
      {
        name: "BoundedAgentLoop",
        responsibility: "执行有界「推理 → 工具调用 → 观测」循环，强制执行 maxSteps/tokenBudget/loopGuard，并在命中高风险动作时产出 Interrupt Checkpoint。",
        boundaries: "纯状态机内核，通过接口调用 LLM/Tools，不直接依赖具体数据库或 HTTP 框架。",
        keyOperations: ["startRun(sessionId, input, budget)", "resumeFromInterrupt(runId, approvalTicket)", "cancelRun(runId)"],
      },
      {
        name: "ToolAndPrivacyBroker",
        responsibility: "统一注册 MCP/本地工具契约，按风险等级与数据隐私标记（allowExternalEgress）过滤可见工具并执行超时隔离。",
        boundaries: "强制执行安全与零外发红线，模型输出不可覆盖其策略决策。",
        keyOperations: ["listAllowedTools(ctx)", "authorizeCall(call, ctx)", "invokeWithTimeout(call, ms)"],
      },
      {
        name: "ApprovalCheckpointStore",
        responsibility: "持久化 RunEvent 日志与挂起态 Checkpoint，对接总裁信箱/人工审批，保证断电重启后幂等续跑。",
        boundaries: "只负责状态持久化与游标回放，不主动发起业务决策。",
        keyOperations: ["appendEvent(runId, event)", "saveInterrupt(runId, snapshot)", "replaySince(runId, seq)"],
      },
    ],
    contractLanguage: "typescript",
    protocolContractCode: `export type AgentRunState = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export type RunEvent =
  | { seq: number; kind: "run_started"; runId: string; sessionId: string; budget: RunBudget }
  | { seq: number; kind: "text_delta"; runId: string; delta: string }
  | { seq: number; kind: "tool_requested"; runId: string; callId: string; tool: string; argsHash: string; risk: "low" | "medium" | "high" }
  | { seq: number; kind: "approval_required"; runId: string; interruptId: string; packetId: string; reason: string }
  | { seq: number; kind: "tool_completed"; runId: string; callId: string; ok: boolean; durationMs: number; summary: string }
  | { seq: number; kind: "run_finished"; runId: string; state: AgentRunState; tokensUsed: number };

export interface RunBudget {
  maxSteps: number;
  maxTokens: number;
  toolTimeoutMs: number;
  allowExternalEgress: boolean; // 私有仓强制 false：禁止外发远程 LLM/Embedding
}

export interface AgentControlPlane {
  dispatch(sessionId: string, prompt: string, budget: RunBudget): Promise<{ runId: string }>;
  subscribe(runId: string, sinceSeq?: number): AsyncIterable<RunEvent>;
  resumeInterrupt(runId: string, interruptId: string, decision: { approved: boolean; actor: string; note?: string }): Promise<void>;
}`,
    invariants: [
      "任意 Run 的状态变化必须先追加持久化 RunEvent 再向外广播，保证前端/IM 断线按 seq 补拉零丢消息。",
      "budget.allowExternalEgress === false 时，LLM/Embedding 网关在传输层硬阻断任何外部网络请求，强制回退本地确定性引擎。",
      "命中 risk === 'high' 或 bypassAutoApprove 的动作必须先落盘 Checkpoint 并进入 awaiting_approval，审批票据按 interruptId 严格幂等消费一次。",
      "单次 Run 超过 maxSteps 或检测到连续 3 次相同 argsHash 失败调用时，自动熔断并向人类汇报根因。",
    ],
    failureModesAndGuardrails: [
      {
        failureMode: "工具调用死循环或 Token 预算失控",
        impact: "API 费用暴涨且阻塞会话队列",
        guardrail: "BoundedAgentLoop 内置 maxSteps、maxTokens 与 (tool, argsHash) 重复调用熔断器",
        detectionSignal: "连续相同 argsHash >= 3 或 tokensUsed > 0.85 * maxTokens",
      },
      {
        failureMode: "私有仓库代码被意外发送至外部模型",
        impact: "核心知识产权与商业机密泄露",
        guardrail: "ToolAndPrivacyBroker 在构建模型请求前校验 allowExternalEgress，未授权私有节点硬拒绝外发",
        detectionSignal: "privacyBlocked=true 审计事件",
      },
      {
        failureMode: "审批期间服务重启导致任务失联或重复执行",
        impact: "高风险动作双发或长流程永久挂死",
        guardrail: "ApprovalCheckpointStore 持久化挂起快照，恢复接口基于 interruptId 做唯一幂等锁",
        detectionSignal: "awaiting_approval 超时未处理告警或重复 resume 拒绝计数",
      },
      {
        failureMode: "多渠道协议漂移（Web / IM / CLI 事件不兼容）",
        impact: "每新增一个渠道都要改核心 Runner",
        guardrail: "强制所有渠道仅消费统一 RunEvent 联合类型，通过单测锁定协议版本契约",
        detectionSignal: "Schema 校验失败或未知 event.kind 计数 > 0",
      },
    ],
    mermaidDiagram: `flowchart TD
  Ingress["Multi-Channel Ingress (IM / Web / Cron / A2A)"] -->|"InboundEnvelope"| Dispatch["ChannelIngressDispatcher"]
  Dispatch -->|"Session Lock + Budget"| Loop["BoundedAgentLoop (Step & Token Guard)"]
  Loop -->|"Authorize + Privacy Gate"| Broker["ToolAndPrivacyBroker (MCP & Local Tools)"]
  Broker -.->|"High Risk / Bypass Gate"| Approval["Founder Mailbox / Approval Interrupt"]
  Approval -->|"Idempotent Ticket"| Checkpoint["ApprovalCheckpointStore (Append-Only RunEvents)"]
  Loop -->|"Append RunEvent"| Checkpoint
  Checkpoint -->|"Replayable Stream (seq)"| Proj["UI & IM Channel Projections"]`,
    diagramCaption: "多 Agent 控制面最小原语：以可回放 RunEvent 事件流串联多渠道接入、有界工具循环、隐私分级与可持久化人工审批。",
  };

  const consolidationPlan = buildConsolidationItemsForCluster({
    archetype: "agent_control_plane",
    ownedNodes,
    starNodes,
    codeMaps,
  });

  return {
    title: input.title,
    problemStatement,
    firstPrinciples,
    tradeoffMatrix,
    primitiveSpec,
    consolidationPlan,
  };
}

function buildMicrovmSandboxBlueprint(input: {
  title: string;
  problemStatement?: string;
  ownedNodes: RepoEvolutionNode[];
  starNodes: RepoEvolutionNode[];
  codeMaps: Map<string, RepoCodeMap>;
}): DistilledBlueprintPayload {
  const { ownedNodes, starNodes, codeMaps } = input;
  const allNodes = [...ownedNodes, ...starNodes];

  // Disjoint routes: Rust Native MicroVM vs K8s/Go Orchestrated vs In-Proc Interpreter/WASM
  const rustVmmRepos = allNodes.filter((n) => {
    const primary = (n.primaryLanguage || "").toLowerCase();
    return (primary === "rust" || /firecracker|smolvm|shuru|kuasar|agent-sandbox-microvm/i.test(n.fullName)) && !/monty/i.test(n.fullName);
  });
  const usedVmR1 = new Set(rustVmmRepos.map((r) => r.id));
  const k8sGoRepos = allNodes.filter((n) => {
    if (usedVmR1.has(n.id)) return false;
    const primary = (n.primaryLanguage || "").toLowerCase();
    return primary === "go" || /kubernetes|cubesandbox|e2b-infra/i.test(n.fullName);
  });
  const usedVmR12 = new Set([...usedVmR1, ...k8sGoRepos.map((r) => r.id)]);
  const langRuntimeRepos = allNodes.filter((n) => !usedVmR12.has(n.id));

  const route1Repos = rustVmmRepos.length ? rustVmmRepos : ownedNodes;
  const route2Repos = k8sGoRepos.length ? k8sGoRepos : starNodes.slice(0, 2);
  const route3Repos = langRuntimeRepos;

  const problemStatement =
    input.problemStatement?.trim() ||
    `围绕自有沙箱仓 ${ownedNodes.map((n) => n.name).join(" / ")} 与标杆项目 ${starNodes
      .slice(0, 4)
      .map((n) => n.fullName)
      .join("、")} 的零克隆源码解剖，解决 AI Agent 执行不可信代码时的第一性原理难题：如何在保持「硬件虚拟化级强隔离（独立内核）」的前提下，把冷启动延迟压低至百毫秒级，并提供与 E2B 兼容的统一控制面 API。`;

  const firstPrinciples: ArchitectureFirstPrinciple[] = [
    {
      id: "fp_sandbox_kernel_boundary",
      title: "强隔离物理边界（不可信代码禁止共享宿主机内核）",
      category: "security",
      constraint:
        "AI 生成的代码与第三方依赖属于绝对不可信载荷；容器（Namespaces/Cgroups）仅做软隔离，共享同一 Linux 内核攻击面。安全边界必须下沉至独立 Guest Kernel（KVM/MicroVM）+ 最小化设备模型（virtio-net/block/vsock）+ 宿主侧 Jailer/Seccomp 降权。",
      whyIrreducible:
        "单一内核提权漏洞（DirtyPipe/io_uring/netfilter 等）即可击穿所有同宿主机容器并窃取凭据；硬件辅助虚拟化（VT-x/ARM EL2）是目前唯一的硬物理隔离边界。",
      failureWhenViolated:
        "Agent 执行恶意包 postinstall 脚本逃逸至宿主机，读取环境变量/SSH 密钥/内网数据库或横向感染其他租户沙箱。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /vmm|vm|jailer|firecracker|seccomp|sandbox|kvm|hypervisor|virtio|kernel|isolat/i,
        preferLayers: ["infra", "core"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_sandbox_snapshot_latency",
      title: "百毫秒弹性定律（Memory Snapshot + CoW Rootfs 替代冷启动）",
      category: "physics",
      constraint:
        "从零引导 Linux 内核 + 用户态运行时需要 1–5 秒，无法满足 Agent 高频交互式代码执行；必须将预热后的 Guest 内存快照与 Copy-on-Write 根文件系统（overlayfs/devicemapper/qcow2）解耦，按需 mmap 恢复并维护 Warm Pool。",
      whyIrreducible:
        "内核初始化与动态库加载存在不可压缩的串行 IO/CPU 物理下限；只有用空间换时间（快照克隆 + 按页缺页加载）才能将 P95 就绪时间压入 <200ms。",
      failureWhenViolated:
        "每次代码工具调用额外等待数秒启动，彻底破坏 Agent 多轮试错体验，或为追求速度被迫退回不安全的常驻共享容器。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /snapshot|pool|boot|rootfs|image|disk|overlay|template|warm|clone|restore/i,
        preferLayers: ["infra", "storage", "core"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_sandbox_egress_control",
      title: "默认断网与零信任出站代理（Default-Deny Egress & Secret Isolation）",
      category: "security",
      constraint:
        "沙箱内进程默认禁止访问宿主机回环、内网 CIDR（10/8, 169.254.169.254 元数据）与任意公网；一切外部网络与凭据注入必须经宿主机侧透明代理/vsock 通道按域名白名单审计放行，真实 Secret 永不落入 Guest 环境变量。",
      whyIrreducible:
        "一旦不可信代码拿到无限制出网或宿主机元数据接口权限，即便无法逃逸内核也可通过 SSRF/外传通道窃取内网数据或发动矿机/DDoS 攻击。",
      failureWhenViolated:
        "沙箱成为内网渗透跳板、云元数据密钥被窃，或失控脚本把宿主机带宽与 IP 信誉打废。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /net|network|proxy|vsock|tap|firewall|egress|bridge|dns|route/i,
        preferLayers: ["infra", "protocol"],
        maxRefs: 4,
      }),
    },
    {
      id: "fp_sandbox_reconcile_ttl",
      title: "确定性资源配额与租约回收（防僵尸 VM 与磁盘膨胀）",
      category: "cost",
      constraint:
        "每个 MicroVM 必须绑定硬性 CPU/Memory/Disk Quota、严格 TTL 租约与宿主侧独立 Reaper/Controller 调谐循环；通信通道优先走 vsock 避免宿主机端口耗尽，销毁必须保证进程、tap 网卡与 CoW 卷原子清理。",
      whyIrreducible:
        "Agent 异常崩溃或客户端断连是常态而非例外；缺少独立于调用方的租约回收器必然导致孤儿 VM 泄漏直至宿主机 OOM 或磁盘写满。",
      failureWhenViolated:
        "运行数天后宿主机内存/loop 设备/overlay 分区耗尽，新沙箱创建全面雪崩。",
      evidence: collectClusterEvidence(allNodes, codeMaps, {
        pathRegex: /lifecycle|manager|controller|reconcil|lease|ttl|cleanup|quota|scheduler|pool|api/i,
        preferLayers: ["core", "protocol", "infra"],
        maxRefs: 4,
      }),
    },
  ];

  const dimensions: ArchitectureTradeoffDimension[] = [
    { key: "isolation", label: "安全隔离强度", description: "防内核逃逸与多租户侧信道隔离能力" },
    { key: "cold_start", label: "启动/恢复延迟", description: "从请求到可执行首条命令的 P95 耗时" },
    { key: "compat", label: "生态与 E2B API 兼容性", description: "任意 Linux 二进制/包与 E2B/标准接口支持度" },
    { key: "ops_overhead", label: "单机/集群运维复杂度", description: "对 KVM/K8s/网络基建的依赖门槛" },
  ];

  const approaches: ArchitectureTradeoffApproach[] = [
    {
      id: "app_rust_microvm_native",
      name: "Rust 原生 MicroVM VMM + 快照池路线",
      representativeRepos: route1Repos.slice(0, 4).map((r) => r.fullName),
      gains: "硬件级独立内核强隔离、极低内存开销（单 VM 几十 MB）、支持内存快照百毫秒级恢复，单机即可交付高性能控制面。",
      sacrifices: "依赖 Linux KVM（macOS 需 Virtualization.framework / libkrun 适配），自定义网络/卷管理与 guest agent 需精细系统工程。",
      bestFor: "自建单机/裸金属高性能 Agent 沙箱底座（如 agent-sandbox-microvm），追求极致性价比与完全自主可控。",
      scores: {
        isolation: "极高（独立 Guest 内核 + Seccomp Jailer）",
        cold_start: "极快（快照恢复 ~50–200ms）",
        compat: "极高（完整 Linux 用户态 + E2B API 兼容）",
        ops_overhead: "中（需 KVM/tap/overlayfs，无 K8s 重依赖）",
      },
      evidence: collectClusterEvidence(route1Repos, codeMaps, { maxRefs: 4 }),
    },
    {
      id: "app_k8s_orchestrated_sandbox",
      name: "K8s CRD / Go 多节点云原生沙箱编排路线",
      representativeRepos: route2Repos.slice(0, 4).map((r) => r.fullName),
      gains: "原生声明式调度、多节点弹性扩缩容、与云厂商网络/存储/监控/WarmPool CRD 生态深度集成。",
      sacrifices: "控制面链路长（API Server → Controller → CRI → Runtime），单机开发测试门槛高，小规模部署基建税重。",
      bestFor: "多节点生产集群大规模租户托管（如 e2b-infra-opc 云端扩容形态）。",
      scores: {
        isolation: "高（Kata/gVisor/Firecracker RuntimeClass）",
        cold_start: "中快（依赖 WarmPool 预热 Pod）",
        compat: "高（标准 OCI 镜像 + 集群网络策略）",
        ops_overhead: "高（需完整 K8s/Nomad 控制面与 CNI）",
      },
      evidence: collectClusterEvidence(route2Repos, codeMaps, { maxRefs: 3 }),
    },
    ...(route3Repos.length > 0
      ? [
          {
            id: "app_inproc_interpreter_sandbox",
            name: "语言级受限解释器 / WASM 轻沙箱路线",
            representativeRepos: route3Repos.slice(0, 3).map((r) => r.fullName),
            gains: "微秒至毫秒级启动、零虚拟化硬件要求、可在任意操作系统甚至边缘节点运行。",
            sacrifices: "无法运行任意原生 C 扩展、Shell 工具链或完整 Git/构建环境，生态兼容性受限。",
            bestFor: "纯计算逻辑、轻量 Python/JS 表达式求值或高频低权限数据变换。",
            scores: {
              isolation: "中高（语言能力安全，非独立 OS）",
              cold_start: "极致（<10ms）",
              compat: "低（仅限受限语言子集/WASM）",
              ops_overhead: "极低（纯库嵌入）",
            },
            evidence: collectClusterEvidence(route3Repos, codeMaps, { maxRefs: 2 }),
          },
        ]
      : []),
  ];

  const tradeoffMatrix: ArchitectureTradeoffMatrix = {
    summary: `对比 ${allNodes.length} 个沙箱仓的真实 Code Map（自有仓 ${shortHotspotList(ownedNodes, codeMaps, 2)}；标杆仓 ${shortHotspotList(starNodes, codeMaps, 3)}）：关键权衡在于「单机 Rust VMM 的极简低延迟」vs「云原生多节点编排」。最佳收敛策略是定义一份与 E2B 对齐的 SandboxControlPlane 协议，下层可同时挂接单机 MicroVM 驱动与集群 WarmPool 编排。`,
    dimensions,
    approaches,
  };

  const hasRustOwned = ownedNodes.some(
    (n) => (n.primaryLanguage || "").toLowerCase() === "rust" || /microvm/i.test(n.fullName),
  );
  const contractLang = hasRustOwned ? "rust" : dominantContractLanguage(ownedNodes, codeMaps);
  const protocolContractCode =
    contractLang === "rust"
      ? `pub enum SandboxState { Creating, Running, Paused, Stopping, Destroyed }

pub struct SandboxSpec {
    pub template_id: String,
    pub vcpu_count: u8,
    pub memory_mib: u32,
    pub disk_mib: u32,
    pub ttl_seconds: u64,
    pub egress_allowlist: Vec<String>, // 空列表 = 默认全阻断（Default-Deny）
}

pub struct ExecRequest {
    pub command: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_ms: u64,
    pub env_refs: Vec<String>, // 仅传递逻辑引用，真实密钥在宿主代理层注入
}

pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
}

pub trait SandboxDriver: Send + Sync {
    fn spawn_from_snapshot(&self, spec: &SandboxSpec) -> Result<String, SandboxError>;
    fn exec_via_vsock(&self, sandbox_id: &str, req: ExecRequest) -> Result<ExecResult, SandboxError>;
    fn pause_snapshot(&self, sandbox_id: &str) -> Result<String, SandboxError>;
    fn destroy_reap(&self, sandbox_id: &str) -> Result<(), SandboxError>;
}`
      : `export type SandboxState = "creating" | "running" | "paused" | "stopping" | "destroyed";

export interface SandboxSpec {
  templateId: string;
  vcpuCount: number;
  memoryMib: number;
  diskMib: number;
  ttlSeconds: number;
  egressAllowlist: string[]; // 空数组 = 默认全阻断（Default-Deny）
}

export interface SandboxDriver {
  spawnFromSnapshot(spec: SandboxSpec): Promise<{ sandboxId: string; readyMs: number }>;
  execViaVsock(sandboxId: string, cmd: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  pauseSnapshot(sandboxId: string): Promise<{ snapshotId: string }>;
  destroyReap(sandboxId: string): Promise<void>;
}`;

  const primitiveSpec: ArchitecturePrimitiveSpec = {
    coreThesis:
      "以「Snapshot WarmPool + 独立 Guest 内核（MicroVM）+ vsock 指令通道 + Default-Deny 宿主出站代理 + 独立 TTL Reaper」构成不可信代码执行的最小安全闭环。",
    entities: [
      {
        name: "TemplateSnapshotPool",
        responsibility: "维护预构建 Rootfs 模板与预热内存快照池，支持 CoW 瞬时派生与挂起回写。",
        boundaries: "只管理不可变镜像与 CoW 卷，绝不直接暴露宿主机目录挂载。",
        keyOperations: ["buildTemplate(spec)", "acquireWarmVm(templateId)", "saveSnapshot(sandboxId)"],
      },
      {
        name: "MicroVmRuntimeDriver",
        responsibility: "驱动 Firecracker/KVM（或 macOS Virtualization）拉起降权 Jailer 进程并绑定 CPU/Mem/IO 配额。",
        boundaries: "严格隔离宿主机内核，所有设备仅开放最小 virtio 集。",
        keyOperations: ["bootOrRestore(vmConfig)", "applyCgroupQuota(vmId)", "forceKillAndCleanup(vmId)"],
      },
      {
        name: "VsockGuestChannel",
        responsibility: "通过 virtio-vsock 与 Guest 内轻量 Agent（envd）双向通信，承载命令执行、流式日志与文件读写。",
        boundaries: "不依赖 Guest TCP 网络栈，即便完全断网也可稳定控制沙箱。",
        keyOperations: ["execStream(vmId, req)", "uploadBytes(vmId, path, data)", "downloadBytes(vmId, path)"],
      },
      {
        name: "EgressProxyAndReaper",
        responsibility: "宿主机侧拦截 Guest 出站流量（拦截内网 CIDR/元数据、白名单放行并代签凭据），同时按 TTL 回收过期与孤儿 VM。",
        boundaries: "独立守护循环，调用方崩溃后仍保证 100% 资源回收与网络零泄漏。",
        keyOperations: ["filterEgress(vmId, dstHost)", "renewLease(vmId, ttl)", "reapExpiredSandboxes()"],
      },
    ],
    contractLanguage: contractLang,
    protocolContractCode,
    invariants: [
      "每个沙箱进程在独立 Guest Kernel + 宿主机 Seccomp/Jailer 下运行，严禁与宿主机或其他租户共享内核命名空间。",
      "Guest 默认拒绝访问 127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 与 169.254.169.254。",
      "命令与文件控制面走 vsock 独立信道，Guest 内部修改 iptables 或断网不能导致控制面失联。",
      "任何沙箱销毁路径必须幂等清理：VMM 进程、CoW 磁盘叠加层、tap 设备与租约记录，零孤儿泄漏。",
    ],
    failureModesAndGuardrails: [
      {
        failureMode: "Fork Bomb 或内存膨胀耗尽宿主机",
        impact: "宿主机抖动甚至 OOM Killer 误杀控制面",
        guardrail: "VMM 硬配额（memory_mib/vcpu）+ 宿主机 cgroup v2 限制 + 单命令 timeout_ms 强制 SIGKILL",
        detectionSignal: "cgroup memory.events oom_kill > 0 或命令超时率突增",
      },
      {
        failureMode: "沙箱内 SSRF 探测内网服务或云元数据",
        impact: "泄露内网 API 密钥或攻击宿主机关联数据库",
        guardrail: "Default-Deny EgressProxy 仅放行显式白名单域名，屏蔽所有私网 CIDR 与元数据地址",
        detectionSignal: "egress_denied 审计告警（目标为私网/元数据 IP）",
      },
      {
        failureMode: "调用方崩溃遗留僵尸 MicroVM 与 CoW 磁盘",
        impact: "内存与磁盘缓慢耗尽导致雪崩",
        guardrail: "EgressProxyAndReaper 按硬 TTL 定时扫描并强杀过期 VMM，启动时做孤儿状态对账",
        detectionSignal: "running_vm_count > active_lease_count 差值 > 0",
      },
      {
        failureMode: "快照恢复后随机数熵或时钟漂移",
        impact: "克隆出的多个沙箱生成相同 UUID/TLS nonce",
        guardrail: "恢复后通过 vsock/virtio-rng 注入新熵源并同步 Guest 时钟偏移",
        detectionSignal: "snapshot_restore_reseed 校验失败",
      },
    ],
    mermaidDiagram: `flowchart LR
  Client["Agent / E2B-Compatible API Client"] -->|"SandboxSpec (TTL + Allowlist)"| CP["Sandbox Control Plane"]
  CP -->|"CoW Clone (<200ms)"| Pool["TemplateSnapshotPool"]
  Pool -->|"Restore"| VMM["MicroVmRuntimeDriver (Firecracker / Jailer)"]
  CP -->|"Exec / FS Stream"| Vsock["VsockGuestChannel (Out-of-Band)"]
  Vsock <-->|"Guest Agent (envd)"| Guest["Isolated Guest Kernel & Rootfs"]
  Guest -->|"Filtered Egress"| Proxy["EgressProxy (Default-Deny + CIDR Block)"]
  Reaper["TTL Reaper & Quota Guard"] -.->|"Reap Orphan VMs"| VMM`,
    diagramCaption: "不可信代码 MicroVM 隔离执行沙箱：快照预热池 + 独立 Guest 内核 + vsock 带外控制 + 零信任出站代理与租约回收。",
  };

  const consolidationPlan = buildConsolidationItemsForCluster({
    archetype: "microvm_sandbox",
    ownedNodes,
    starNodes,
    codeMaps,
  });

  return {
    title: input.title,
    problemStatement,
    firstPrinciples,
    tradeoffMatrix,
    primitiveSpec,
    consolidationPlan,
  };
}

function buildGenericEvidenceBlueprint(input: {
  title: string;
  problemStatement?: string;
  ownedNodes: RepoEvolutionNode[];
  starNodes: RepoEvolutionNode[];
  codeMaps: Map<string, RepoCodeMap>;
}): DistilledBlueprintPayload {
  const { ownedNodes, starNodes, codeMaps } = input;
  const allNodes = [...ownedNodes, ...starNodes];

  const allHotspots: Array<{ node: RepoEvolutionNode; hotspot: RepoCodeMapHotspot }> = [];
  for (const n of allNodes) {
    const cm = codeMaps.get(n.id);
    if (!cm) continue;
    for (const h of cm.hotspots.slice(0, 3)) {
      allHotspots.push({ node: n, hotspot: h });
    }
  }

  const langs = [...new Set(allNodes.map((n) => codeMaps.get(n.id)?.primaryLanguages[0]?.language || n.primaryLanguage).filter(Boolean))] as string[];
  const topDeps = new Map<string, number>();
  for (const cm of codeMaps.values()) {
    for (const d of cm.topExternalDeps.slice(0, 6)) {
      topDeps.set(d.name, (topDeps.get(d.name) ?? 0) + d.count);
    }
  }
  const sharedDeps = [...topDeps.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k);

  const problemStatement =
    input.problemStatement?.trim() ||
    `围绕 ${ownedNodes.map((n) => n.name).join(" / ") || "自有仓"} 与标杆 Star 仓 ${starNodes
      .slice(0, 4)
      .map((n) => n.fullName)
      .join("、")} 的零克隆源码 Code Map（覆盖 ${langs.join(" / ") || "多语言"} 栈，共解析 ${[...codeMaps.values()].reduce((s, c) => s + c.analyzedFileCount, 0)} 个核心源码文件），抽离跨仓库共享的第一性原理约束、技术路线取舍与最小可复用内核。`;

  const coreRefs = collectClusterEvidence(allNodes, codeMaps, { preferLayers: ["core", "entry"], maxRefs: 4 });
  const protoRefs = collectClusterEvidence(allNodes, codeMaps, { preferLayers: ["protocol", "storage"], maxRefs: 4 });
  const infraRefs = collectClusterEvidence(allNodes, codeMaps, { preferLayers: ["infra", "ui", "core"], maxRefs: 4 });

  const firstPrinciples: ArchitectureFirstPrinciple[] = [
    {
      id: "fp_gen_contract_boundary",
      title: "核心领域状态机与外围传输/宿主解耦",
      category: "engineering",
      constraint: `高星标杆与自有仓的入度热点均集中在核心编排模块（如 ${allHotspots
        .slice(0, 3)
        .map((x) => `\`${x.node.name}:${x.hotspot.path}\``)
        .join("、")}）；核心执行逻辑必须只依赖最小契约接口，禁止反向依赖具体 UI、通道或第三方 SDK。`,
      whyIrreducible:
        "一旦核心状态机与宿主框架耦合，跨项目复用与协议演进必然产生循环依赖与级联重写。",
      failureWhenViolated:
        "多胞胎自有仓各自拷贝一套近乎相同的控制逻辑，后续任何能力升级都需在 N 个仓库手工同步。",
      evidence: coreRefs,
    },
    {
      id: "fp_gen_protocol_determinism",
      title: "强类型协议边界与可观测回执（确定性优先）",
      category: "protocol",
      constraint:
        "跨模块与跨进程交互必须收敛为显式版本化的输入/输出 Schema 与结构化错误码，以确定性回执替代隐式副作用。",
      whyIrreducible:
        "多语言/多仓协作场景下（本簇涵盖 " +
        (langs.join("/") || "多栈") +
        "），只有强类型边界和幂等回执才能支撑自动化测试、灰度切换与故障定位。",
      failureWhenViolated:
        "上游字段变更静默破坏下游解析，难以区分重试、超时与业务失败。",
      evidence: protoRefs,
    },
    {
      id: "fp_gen_bounded_runtime",
      title: "显式资源配额、隐私边界与优雅降级",
      category: "reliability",
      constraint: `外部依赖栈（${sharedDeps.slice(0, 4).join(" / ") || "运行时依赖"}）与远程 API 均存在不可用或隐私限制，所有关键路径必须设定超时、预算上限与本地确定性降级策略。`,
      whyIrreducible:
        "网络延迟、模型限流与私有仓零外发约束均为不可消除的工程边界。",
      failureWhenViolated:
        "单点外部服务抖动拖死整个链路，或在受限隐私环境下丧失基础可用性。",
      evidence: infraRefs,
    },
  ];

  // Dynamically group repos into approaches by primary language / role
  const starGroupA = starNodes.slice(0, Math.max(1, Math.ceil(starNodes.length / 2)));
  const starGroupB = starNodes.slice(Math.max(1, Math.ceil(starNodes.length / 2)));
  const dimensions: ArchitectureTradeoffDimension[] = [
    { key: "abstraction", label: "抽象纯度与可复用性" },
    { key: "coupling", label: "模块耦合与分层清晰度" },
    { key: "velocity", label: "落地改造成本" },
  ];

  const approaches: ArchitectureTradeoffApproach[] = [
    {
      id: "app_star_primary",
      name: `标杆核心路线（${starGroupA.map((s) => s.name).join(" / ")}）`,
      representativeRepos: starGroupA.map((s) => s.fullName),
      gains: `在 ${shortHotspotList(starGroupA, codeMaps, 2)} 中沉淀了高入度核心抽象与成熟边界封装。`,
      sacrifices: "引入其全套生态依赖或语言栈会抬高自有仓接入与长期维护成本。",
      bestFor: "提炼协议契约、数据结构与核心算法思想并做轻量转译。",
      scores: {
        abstraction: "高（高星生态验证）",
        coupling: `解析边数 ${starGroupA.reduce((s, n) => s + (codeMaps.get(n.id)?.edgeCount ?? 0), 0)}`,
        velocity: "中（需适配自有契约）",
      },
      evidence: collectClusterEvidence(starGroupA, codeMaps, { maxRefs: 3 }),
    },
    ...(starGroupB.length > 0
      ? [
          {
            id: "app_star_secondary",
            name: `对照工程路线（${starGroupB.map((s) => s.name).join(" / ")}）`,
            representativeRepos: starGroupB.map((s) => s.fullName),
            gains: `通过 ${shortHotspotList(starGroupB, codeMaps, 2)} 提供不同的分层切分与轻量化实现思路。`,
            sacrifices: "部分高级扩展能力需自行补齐外围基础设施。",
            bestFor: "对比验证核心假设是否成立，取其精简结构规避过度设计。",
            scores: {
              abstraction: "中高",
              coupling: `解析边数 ${starGroupB.reduce((s, n) => s + (codeMaps.get(n.id)?.edgeCount ?? 0), 0)}`,
              velocity: "高",
            },
            evidence: collectClusterEvidence(starGroupB, codeMaps, { maxRefs: 3 }),
          },
        ]
      : []),
    ...(ownedNodes.length > 0
      ? [
          {
            id: "app_owned_current",
            name: `自有仓现有演进线（${ownedNodes.map((o) => o.name).join(" / ")}）`,
            representativeRepos: ownedNodes.map((o) => o.fullName),
            gains: `贴合自身业务闭环，已在 ${shortHotspotList(ownedNodes, codeMaps, 2)} 落地真实运行能力。`,
            sacrifices: ownedNodes.length >= 2 ? "多仓之间存在重复胶水与协议漂移，亟需下沉共享内核。" : "核心抽象与标杆仓相比仍存在可扩展性与测试护栏缺口。",
            bestFor: "作为收敛承载目标，按最小增量吸收标杆原语。",
            scores: {
              abstraction: "演化中",
              coupling: `解析边数 ${ownedNodes.reduce((s, n) => s + (codeMaps.get(n.id)?.edgeCount ?? 0), 0)}`,
              velocity: "极高（自主可控）",
            },
            evidence: collectClusterEvidence(ownedNodes, codeMaps, { maxRefs: 3 }),
          },
        ]
      : []),
  ];

  // Collect real key interface snippets for the contract code
  const realKeyIfaces = [...codeMaps.values()]
    .flatMap((cm) => cm.keyInterfaces.slice(0, 3).map((ki) => `// ref: ${cm.repoFullName}:${ki.path}\n// ${ki.signature}`))
    .slice(0, 5)
    .join("\n");

  const hasRustOwned = ownedNodes.some(
    (n) => (n.primaryLanguage || "").toLowerCase() === "rust" || /microvm/i.test(n.fullName),
  );
  const contractLang = hasRustOwned ? "rust" : dominantContractLanguage(ownedNodes, codeMaps);
  const protocolContractCode = `${realKeyIfaces ? `${realKeyIfaces}\n\n` : ""}export interface PrimitiveContext {
  requestId: string;
  allowExternalEgress: boolean;
  timeoutMs: number;
}

export interface PrimitiveReceipt<T = unknown> {
  ok: boolean;
  data?: T;
  degraded: boolean;
  errorCode?: string;
  evidencePaths?: string[];
}

export interface CorePrimitiveEngine<TInput, TOutput> {
  validate(input: TInput): { valid: boolean; reason?: string };
  execute(input: TInput, ctx: PrimitiveContext): Promise<PrimitiveReceipt<TOutput>>;
}`;

  const primitiveSpec: ArchitecturePrimitiveSpec = {
    coreThesis: `将「${input.title}」收敛为纯契约驱动的 3 段最小原语：ContractValidator（确定性校验）→ CoreOrchestrator（无宿主耦合状态机）→ AdapterProjection（可替换外围驱动与可观测回执）。`,
    entities: [
      {
        name: "ContractValidator",
        responsibility: "在入口处强制校验输入 Schema、权限与隐私边界（含私有仓零外发门禁）。",
        boundaries: "纯确定性校验，零外部副作用。",
        keyOperations: ["validate(input)", "checkPrivacyPolicy(ctx)"],
      },
      {
        name: "CoreOrchestrator",
        responsibility: "承载领域不可再分的核心状态迁移与计算逻辑，供多胞胎自有仓统一复用。",
        boundaries: "不直接绑定特定 UI/通道/存储驱动，全部通过注入接口协作。",
        keyOperations: ["execute(input, ctx)", "checkpoint(state)"],
      },
      {
        name: "AdapterProjection",
        responsibility: "将核心执行回执映射至具体宿主（API/UI/CLI/外部存储）并输出可审计证据链。",
        boundaries: "只做协议适配与观测输出，不修改核心业务规则。",
        keyOperations: ["projectResult(receipt)", "emitAuditEvent(receipt)"],
      },
    ],
    contractLanguage: contractLang === "typescript" ? "typescript" : "typescript",
    protocolContractCode,
    invariants: [
      "核心层禁止反向依赖 UI/外围适配器，保持零循环依赖。",
      "所有外部调用携带硬超时与幂等键，失败必须返回结构化 PrimitiveReceipt。",
      "未授权私有资产（allowLlmAnalysis=false）严格阻断远程外发，自动走本地确定性路径。",
    ],
    failureModesAndGuardrails: [
      {
        failureMode: "多仓协议字段漂移导致集成断裂",
        impact: "重复修 Bug、上下游不兼容",
        guardrail: "抽出共享 Types/Contract 包并以契约单测作为合并门禁",
        detectionSignal: "CI typecheck 或契约校验失败",
      },
      {
        failureMode: "外部依赖不可用或超时阻塞主流程",
        impact: "任务雪崩或界面长时间假死",
        guardrail: "显式 timeoutMs + 确定性降级回执（degraded=true）",
        detectionSignal: "timeout 计数上升或 degraded 比例超阈值",
      },
    ],
    mermaidDiagram: `flowchart LR
  Input["Caller / Channel Request"] --> Validate["ContractValidator (Schema & Privacy Gate)"]
  Validate --> Core["CoreOrchestrator (Shared Kernel)"]
  Core --> Driver["Pluggable Runtime / Storage Drivers"]
  Core --> Receipt["AdapterProjection (Structured Receipt & Audit)"]`,
    diagramCaption: `${input.title} 最小抽象原语：校验门禁 → 共享核心状态机 → 可插拔外围驱动与结构化回执。`,
  };

  const consolidationPlan = buildConsolidationItemsForCluster({
    archetype: "generic_evidence_driven",
    ownedNodes,
    starNodes,
    codeMaps,
  });

  return {
    title: input.title,
    problemStatement,
    firstPrinciples,
    tradeoffMatrix: {
      summary: `基于 ${allNodes.length} 个参与仓库的零克隆 Code Map，横向对比标杆实现与自有仓现状，识别出可下沉的共享原语与改造切入点。`,
      dimensions,
      approaches,
    },
    primitiveSpec,
    consolidationPlan,
  };
}

function buildConsolidationItemsForCluster(input: {
  archetype: ArchetypeKind;
  ownedNodes: RepoEvolutionNode[];
  starNodes: RepoEvolutionNode[];
  codeMaps: Map<string, RepoCodeMap>;
}): ArchitectureConsolidationItem[] {
  const { archetype, ownedNodes, starNodes, codeMaps } = input;
  const items: ArchitectureConsolidationItem[] = [];

  const ownedWithMaps = ownedNodes.map((n) => ({ node: n, cm: codeMaps.get(n.id) }));
  const starsWithMaps = starNodes.map((n) => ({ node: n, cm: codeMaps.get(n.id) }));

  // Helper to collect exact evidence from a subset of nodes
  const evFor = (nodes: RepoEvolutionNode[], pathRegex?: RegExp, max = 3): ArchitectureEvidenceRef[] =>
    collectClusterEvidence(nodes, codeMaps, { pathRegex, maxRefs: max });

  if (archetype === "browser_execution_gateway") {
    const extOwned = ownedNodes.filter((n) => /chromegate|pagelens|open-chrome/i.test(n.fullName));
    const twinTargets = extOwned.length >= 2 ? extOwned : ownedNodes;
    const domStar = starNodes.find((n) => /browser-use|nanobrowser|page-agent/i.test(n.fullName)) ?? starNodes[0];
    const flowStar = starNodes.find((n) => /automa|agent-browser|agent-s/i.test(n.fullName)) ?? starNodes[1] ?? starNodes[0];

    if (twinTargets.length >= 2) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `收敛 ${twinTargets.map((n) => n.name).join(" + ")} 共享浏览器感知与动作协议底座`,
        kind: "consolidate_shared_core",
        targetOwnedRepos: twinTargets.map((n) => n.fullName),
        targetNodeIds: twinTargets.map((n) => n.id),
        referenceStarRepos: [domStar?.fullName, flowStar?.fullName].filter((x): x is string => Boolean(x)),
        sharedCapabilityName: "@opc/browser-execution-core",
        currentDuplicationOrGap: `${twinTargets.length} 个自有浏览器相关仓（${shortHotspotList(twinTargets, codeMaps, 4)}）各自维护 Content Script DOM 抓取、消息桥接与动作派发逻辑，面对复杂 SPA（如 TikTok 后台）重复踩坑且难以统一升级。`,
        proposedAction: `抽取无宿主依赖的 \`@opc/browser-execution-core\`（包含 \`PerceptionSnapshotter\` 索引化交互树 + \`BrowserActionCommand\` 乐观锁协议 + \`ActionVerifier\` 读回校验），由 ${twinTargets[0].name} 率先接入验证后向其余多胞胎仓推广。`,
        expectedImpact: "消除多胞胎扩展间 60%+ 重复 DOM/消息桥接代码，所有扩展共享同一套抗改版定位与表单读回能力。",
        effort: "M",
        risk: "medium",
        evidence: evFor([...twinTargets.slice(0, 2), ...(domStar ? [domStar] : [])], /dom|content|background|bridge|gateway|action/i, 4),
      });
    }

    const gatewayOwned = ownedNodes.find((n) => /chromegate-gateway|chromegate/i.test(n.fullName)) ?? ownedNodes[0];
    if (gatewayOwned) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `为 ${gatewayOwned.name} 补齐 Window/Tab 租约隔离与高风险动作审批门禁`,
        kind: "upgrade_capability",
        targetOwnedRepos: [gatewayOwned.fullName],
        targetNodeIds: [gatewayOwned.id],
        referenceStarRepos: starNodes.slice(0, 3).map((s) => s.fullName),
        sharedCapabilityName: "PolicyActionGateway & SessionLeaseManager",
        currentDuplicationOrGap: `${describeHotspotInline(gatewayOwned, codeMaps.get(gatewayOwned.id))} 当前偏重命令转发，缺少多窗口并发时的显式 Tab Lease 租约与按 \`riskTier\` 拦截不可逆写操作的确定性闸门。`,
        proposedAction: `参考 ${shortHotspotList(starNodes.slice(0, 2), codeMaps, 2)} 的会话/控制器分层，在 ${gatewayOwned.name} 网关层引入 \`SessionLeaseManager\`（防 3 窗口并发串 Tab）与 \`PolicyActionGateway\`（发布/改正式价强制挂起人工审批）。`,
        expectedImpact: "并发多窗口自动化任务零串 Tab，登录态敏感写操作 100% 过闸审计。",
        effort: "M",
        risk: "low",
        evidence: evFor([gatewayOwned, ...starNodes.slice(0, 2)], /gateway|session|tab|action|controller|service/i, 3),
      });
    }

    if (domStar && ownedNodes.length > 0) {
      const targetForDom = ownedNodes.find((n) => /pagelens-agent|chromegate/i.test(n.fullName)) ?? ownedNodes[0];
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `吸收 ${domStar.name} 的低熵 DOM/AX 交互索引树升级 ${targetForDom.name} 感知层`,
        kind: "protocol_unification",
        targetOwnedRepos: [targetForDom.fullName],
        targetNodeIds: [targetForDom.id],
        referenceStarRepos: [domStar.fullName],
        sharedCapabilityName: "PerceptionSnapshotter (Ref-Indexed DOM/AXTree)",
        currentDuplicationOrGap: `对照 ${describeHotspotInline(domStar, codeMaps.get(domStar.id))} 的结构化可交互元素过滤与编号机制，${targetForDom.name} 在深层嵌套 DOM 与动态弹窗场景下上下文噪音高、定位稳定性仍有提升空间。`,
        proposedAction: `对照 ${domStar.fullName} 热点源码实现纯 TS 版可见性裁剪 + 稳定 \`refId\` + \`snapshotEpoch\` 乐观锁，在 ${targetForDom.name} 侧栏执行链路中以特性开关开启并对比表单成功率与 Token 消耗。`,
        expectedImpact: "页面感知 Token 消耗下降 50%+，复杂后台表单一次命中率显著提高。",
        effort: "S",
        risk: "low",
        evidence: evFor([domStar, targetForDom], /dom|tree|snapshot|page|content/i, 3),
      });
    }
  } else if (archetype === "agent_control_plane") {
    const coreOwned = ownedNodes.filter((n) => /agent-zoom|ppeng-agent-bot|ai-agent-node|learningharness|learn-agent/i.test(n.fullName));
    const twins = coreOwned.length >= 2 ? coreOwned : ownedNodes;
    const protoStar = starNodes.find((n) => /ag-ui|adk|pi|openfuse/i.test(n.fullName)) ?? starNodes[0];
    const cpStar = starNodes.find((n) => /paperclip|openclaw|pilotdeck|multica/i.test(n.fullName)) ?? starNodes[1] ?? starNodes[0];

    if (twins.length >= 2) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `统一 ${twins.map((n) => n.name).join(" + ")} 的 RunEvent 事件流与有界工具循环契约`,
        kind: "protocol_unification",
        targetOwnedRepos: twins.map((n) => n.fullName),
        targetNodeIds: twins.map((n) => n.id),
        referenceStarRepos: [protoStar?.fullName, cpStar?.fullName].filter((x): x is string => Boolean(x)),
        sharedCapabilityName: "@opc/agent-run-protocol",
        currentDuplicationOrGap: `多胞胎自有仓（${shortHotspotList(twins, codeMaps, 4)}）分别定义了各自的消息流、工具回执与会话状态格式，导致 Web UI、IM 渠道与本地 Loop 间适配代码重复维护。`,
        proposedAction: `借鉴 ${protoStar ? describeHotspotInline(protoStar, codeMaps.get(protoStar.id)) : "标杆事件协议"} 的标准化事件模型，沉淀最小共享包 \`@opc/agent-run-protocol\`（强类型 \`RunEvent\` + \`RunBudget\` + \`ApprovalInterrupt\`），保持各仓现有入口兼容逐步迁移。`,
        expectedImpact: "一次实现流式工具卡片、断线 seq 回放与人工审批挂起，跨全部自有 Agent 产品线零重复开发。",
        effort: "M",
        risk: "medium",
        evidence: evFor([...twins.slice(0, 2), ...(protoStar ? [protoStar] : [])], /event|protocol|loop|runner|dispatch|socket|server/i, 4),
      });
    }

    const cpOwned = ownedNodes.find((n) => /agent-zoom|ai-agent-node/i.test(n.fullName)) ?? ownedNodes[0];
    if (cpOwned && cpStar) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `参考 ${cpStar.name} 强化 ${cpOwned.name} 的可持久化审批中断与预算熔断护栏`,
        kind: "upgrade_capability",
        targetOwnedRepos: [cpOwned.fullName],
        targetNodeIds: [cpOwned.id],
        referenceStarRepos: [cpStar.fullName],
        sharedCapabilityName: "ApprovalCheckpointStore & BoundedLoopGuard",
        currentDuplicationOrGap: `${describeHotspotInline(cpOwned, codeMaps.get(cpOwned.id))} 需在多 Agent 长程并发任务中进一步强化跨重启幂等恢复与重复工具调用自动熔断能力（对照 ${describeHotspotInline(cpStar, codeMaps.get(cpStar.id))}）。`,
        proposedAction: `在 ${cpOwned.name} 运行时增加 \`RunBudget\`（maxSteps / maxTokens / argsHash 循环检测）与可持久化 \`interruptId\` 检查点表，所有高风险工具调用统一路由至总裁信箱异步恢复。`,
        expectedImpact: "杜绝无人值守 Agent 死循环烧 Token 与重启丢审批态风险，私有仓继续严格执行零外发门禁。",
        effort: "M",
        risk: "low",
        evidence: evFor([cpOwned, cpStar], /decision|approval|agent|loop|orchestr|runner|store/i, 3),
      });
    }

    const tutorTwins = ownedNodes.filter((n) => /learningharness|learn-agent/i.test(n.fullName));
    if (tutorTwins.length >= 2) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `收敛 ${tutorTwins.map((n) => n.name).join(" + ")} 共享主动学习循环底座`,
        kind: "consolidate_shared_core",
        targetOwnedRepos: tutorTwins.map((n) => n.fullName),
        targetNodeIds: tutorTwins.map((n) => n.id),
        referenceStarRepos: starNodes.slice(0, 2).map((s) => s.fullName),
        sharedCapabilityName: "@opc/active-tutor-loop",
        currentDuplicationOrGap: `${shortHotspotList(tutorTwins, codeMaps, 2)} 在本地学习循环、知识命题状态管理与 Agent Loop 封装上高度重叠。`,
        proposedAction: `将两仓共用的 Agent Loop 调度与记忆调度抽象下沉至共享核心，保留各自前端与课程交互壳层差异化。`,
        expectedImpact: "减少双仓维护摩擦，统一受益于底层协议与审批护栏升级。",
        effort: "S",
        risk: "low",
        evidence: evFor(tutorTwins, undefined, 3),
      });
    }
  } else if (archetype === "microvm_sandbox") {
    const primaryVm = ownedNodes.find((n) => /agent-sandbox-microvm/i.test(n.fullName)) ?? ownedNodes[0];
    const infraVm = ownedNodes.find((n) => /e2b-infra-opc/i.test(n.fullName)) ?? ownedNodes[1];
    const vmmStar = starNodes.find((n) => /firecracker|smolvm|shuru|kuasar/i.test(n.fullName)) ?? starNodes[0];
    const k8sStar = starNodes.find((n) => /cubesandbox|kubernetes-sigs\/agent-sandbox/i.test(n.fullName)) ?? starNodes[1] ?? starNodes[0];

    if (primaryVm && infraVm) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `统一 ${primaryVm.name}（单机 Rust VMM）与 ${infraVm.name}（集群编排）的 E2B 兼容控制面契约`,
        kind: "consolidate_shared_core",
        targetOwnedRepos: [primaryVm.fullName, infraVm.fullName],
        targetNodeIds: [primaryVm.id, infraVm.id],
        referenceStarRepos: [vmmStar?.fullName, k8sStar?.fullName].filter((x): x is string => Boolean(x)),
        sharedCapabilityName: "opc-sandbox-protocol (E2B-Compatible Driver Spec)",
        currentDuplicationOrGap: `${describeHotspotInline(primaryVm, codeMaps.get(primaryVm.id))} 与 ${describeHotspotInline(infraVm, codeMaps.get(infraVm.id))} 分别面向单机自研 MicroVM 与集群沙箱基础设施，若上层 Agent 调用协议、租约模型与错误语义不统一，暗工厂/AI 节点无法无缝切换单机与云端执行后端。`,
        proposedAction: `沉淀统一的 \`SandboxDriver\` API 契约（含 \`spawn_from_snapshot\` / \`exec_via_vsock\` / \`pause_snapshot\` / \`destroy_reap\` 与 \`egress_allowlist\`），令上层 Agent 仅依赖单一客户端即可在本地 MicroVM 与云端集群间按策略路由。`,
        expectedImpact: "彻底消除本地开发沙箱与云端生产沙箱的 API 割裂，一套测试基线同时验证两套执行后端。",
        effort: "M",
        risk: "medium",
        evidence: evFor([primaryVm, infraVm, ...(k8sStar ? [k8sStar] : [])], /sandbox|vm|api|protocol|server|client|manager/i, 4),
      });
    }

    if (primaryVm && vmmStar) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `对照 ${vmmStar.name} 补齐 ${primaryVm.name} 的快照 WarmPool 与 vsock 带外控制信道`,
        kind: "upgrade_capability",
        targetOwnedRepos: [primaryVm.fullName],
        targetNodeIds: [primaryVm.id],
        referenceStarRepos: [vmmStar.fullName],
        sharedCapabilityName: "TemplateSnapshotPool & VsockGuestChannel",
        currentDuplicationOrGap: `对照 ${describeHotspotInline(vmmStar, codeMaps.get(vmmStar.id))} 的底层 VMM 快照恢复与设备精简路径，${primaryVm.name} 需进一步固化快照预热池、恢复后熵重注（virtio-rng）与独立 TTL Reaper。`,
        proposedAction: `在 ${primaryVm.name} 中强化 \`TemplateSnapshotPool\`（按模板维护 N 个预热快照）与 \`EgressProxyAndReaper\`（强制屏蔽私网 CIDR/元数据并在进程启动时清理孤儿 VM），补充压测基线验证 P95 启动 <200ms 且零僵尸泄漏。`,
        expectedImpact: "Agent 代码工具执行延迟降至百毫秒级，且彻底封堵 SSRF 与孤儿 VM 内存泄漏风险。",
        effort: "L",
        risk: "medium",
        evidence: evFor([primaryVm, vmmStar], /vm|vmm|snapshot|vsock|jailer|net|pool|runtime/i, 4),
      });
    }

    if (k8sStar && (infraVm || primaryVm)) {
      const target = infraVm ?? primaryVm!;
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `吸收 ${k8sStar.name} 的声明式租约调谐与 WarmPool 策略加固 ${target.name}`,
        kind: "upgrade_capability",
        targetOwnedRepos: [target.fullName],
        targetNodeIds: [target.id],
        referenceStarRepos: [k8sStar.fullName],
        sharedCapabilityName: "DeclarativeSandboxReconciler",
        currentDuplicationOrGap: `${describeHotspotInline(k8sStar, codeMaps.get(k8sStar.id))} 通过声明式状态调谐保证沙箱副本数、配额与异常自愈，${target.name} 在批量并发创建与异常退出回收场景下可借鉴其调谐状态机。`,
        proposedAction: `提取 ${k8sStar.name} 热点中的声明式租约/状态机转换表，在 ${target.name} 控制面增加独立周期对账与硬性 Quota 限制。`,
        expectedImpact: "提升高并发沙箱调度稳定性，确保极端故障下宿主机资源可预测回收。",
        effort: "M",
        risk: "low",
        evidence: evFor([k8sStar, target], /controller|reconcil|sandbox|pool|manager|lifecycle/i, 3),
      });
    }
  }

  // Generic fallback or supplemental consolidation items
  if (items.length === 0) {
    if (ownedNodes.length >= 2) {
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `收敛多胞胎自有仓（${ownedNodes.map((n) => n.name).join(" + ")}）共享核心原语包`,
        kind: "consolidate_shared_core",
        targetOwnedRepos: ownedNodes.map((n) => n.fullName),
        targetNodeIds: ownedNodes.map((n) => n.id),
        referenceStarRepos: starNodes.slice(0, 3).map((n) => n.fullName),
        sharedCapabilityName: `@opc/${slugifyPrimitive(ownedNodes[0].name)}-core`,
        currentDuplicationOrGap: `多胞胎自有仓（${shortHotspotList(ownedNodes, codeMaps, 3)}）在核心领域逻辑与外围协议上存在并行维护，对照高星标杆 ${shortHotspotList(starNodes, codeMaps, 2)} 具备显著下沉收敛空间。`,
        proposedAction: `抽取共享核心接口与确定性校验层为独立包，先在主仓完成单测与灰度替换，再向其余关联自有仓推广。`,
        expectedImpact: "降低跨仓维护成本，集中吸收开源标杆演进成果。",
        effort: "M",
        risk: "medium",
        evidence: evFor([...ownedNodes.slice(0, 2), ...starNodes.slice(0, 2)], undefined, 4),
      });
    }
    if (ownedWithMaps[0] && starsWithMaps[0]) {
      const o = ownedWithMaps[0].node;
      const s = starsWithMaps[0].node;
      items.push({
        id: `con_${randomUUID().slice(0, 8)}`,
        title: `基于 ${s.name} 核心热点升级 ${o.name} 关键能力模块`,
        kind: "upgrade_capability",
        targetOwnedRepos: [o.fullName],
        targetNodeIds: [o.id],
        referenceStarRepos: [s.fullName],
        sharedCapabilityName: `${s.name}-inspired-adapter`,
        currentDuplicationOrGap: `${describeHotspotInline(o, codeMaps.get(o.id))} 与标杆 ${describeHotspotInline(s, codeMaps.get(s.id))} 在分层隔离与核心导出契约方面存在结构性差距。`,
        proposedAction: `对照 ${s.fullName} 热点源码在 ${o.name} 中以最小适配层引入对应机制并补齐自动化回归测试。`,
        expectedImpact: "提升主仓核心模块可扩展性与边界健壮性。",
        effort: "S",
        risk: "low",
        evidence: evFor([o, s], undefined, 3),
      });
    }
  }

  return items;
}

function buildDistillLlmPrompt(input: {
  title: string;
  problemStatement?: string;
  ownedNodes: RepoEvolutionNode[];
  starNodes: RepoEvolutionNode[];
  codeMaps: Map<string, RepoCodeMap>;
}): string {
  const formatNode = (n: RepoEvolutionNode) => {
    const cm = input.codeMaps.get(n.id);
    const lines = [
      `- ${n.fullName} [role=${n.role}, lang=${n.primaryLanguage ?? "?"}, ★${n.starsCount}]: ${n.description || "(无简介)"}`,
    ];
    if (cm) {
      lines.push(
        `  CodeMap(commit=${cm.commitSha.slice(0, 8)}, files=${cm.analyzedFileCount}/${cm.candidateSourceFiles}, edges=${cm.edgeCount}, cycles=${cm.cycleCount}, layers=${cm.layers.map((l) => `${l.layer}:${l.fileCount}`).join(",")})`,
      );
      for (const h of cm.hotspots.slice(0, 5)) {
        lines.push(
          `    * ${h.path} [${h.layer}, in=${h.importedByCount}] symbols=[${h.exportedSymbols.slice(0, 5).map((s) => s.name).join(", ")}]`,
        );
      }
      if (cm.topExternalDeps.length > 0) {
        lines.push(`    deps: ${cm.topExternalDeps.slice(0, 8).map((d) => d.name).join(", ")}`);
      }
    }
    return lines.join("\n");
  };

  return [
    `你是首席系统架构师，请基于以下仓库的真实零克隆 Code Map（精确热点路径、入度与导出符号），用第一性原理蒸馏一份架构原语蓝图。`,
    `主题：${input.title}`,
    input.problemStatement ? `问题定义提示：${input.problemStatement}` : "",
    "",
    "【自有仓（需重点识别多胞胎重复建设与底座收敛机会）】",
    ...input.ownedNodes.map(formatNode),
    "",
    "【标杆 Star 仓（横向技术路线与取舍证据）】",
    ...input.starNodes.map(formatNode),
    "",
    `要求：`,
    `1. 所有 evidence 中的 repoFullName、path、symbols 必须严格来自上面提供的真实 Code Map，禁止编造文件路径。`,
    `2. 输出严格 JSON，包含：title, problemStatement, firstPrinciples(3~5条), tradeoffMatrix({summary, dimensions, approaches}), primitiveSpec({coreThesis, entities, contractLanguage, protocolContractCode, invariants, failureModesAndGuardrails, mermaidDiagram, diagramCaption}), consolidationPlan(2~4条，精准命中上述自有仓).`,
    `3. mermaidDiagram 使用 flowchart LR 或 flowchart TD，节点标签用双引号包裹（如 A["标签 (说明)"]），不要包含 HTML 标签。`,
  ]
    .filter(Boolean)
    .join("\n");
}

function hydrateEvidenceUrls(
  refs: ArchitectureEvidenceRef[],
  nodesByName: Map<string, RepoEvolutionNode>,
  codeMaps: Map<string, RepoCodeMap>,
  fallbackRefs: ArchitectureEvidenceRef[],
): ArchitectureEvidenceRef[] {
  const valid: ArchitectureEvidenceRef[] = [];
  for (const r of refs) {
    const node = nodesByName.get(r.repoFullName.toLowerCase());
    if (!node) continue;
    const cm = codeMaps.get(node.id);
    if (!cm) continue;
    const matchedFile =
      cm.hotspots.find((h) => h.path === r.path) ??
      cm.files.find((f) => f.path === r.path);
    if (!matchedFile) continue; // Reject hallucinated paths!
    valid.push({
      repoFullName: node.fullName,
      nodeId: node.id,
      path: matchedFile.path,
      symbols: (r.symbols?.length ? r.symbols : matchedFile.exportedSymbols.slice(0, 4).map((s) => s.name)).slice(0, 5),
      url: matchedFile.url || undefined,
      note: r.note,
    });
  }
  return valid.length > 0 ? valid : fallbackRefs;
}

function parseLlmBlueprint(
  rawText: string,
  fallback: DistilledBlueprintPayload,
  ownedNodes: RepoEvolutionNode[],
  starNodes: RepoEvolutionNode[],
  codeMaps: Map<string, RepoCodeMap>,
): DistilledBlueprintPayload | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText);
  const candidate = (fence ? fence[1] : rawText).trim();
  const s = candidate.indexOf("{");
  const e = candidate.lastIndexOf("}");
  if (s === -1 || e <= s) return null;

  try {
    const parsed = JSON.parse(candidate.slice(s, e + 1)) as Partial<DistilledBlueprintPayload>;
    if (!Array.isArray(parsed.firstPrinciples) || parsed.firstPrinciples.length < 2) return null;
    if (!parsed.tradeoffMatrix || !Array.isArray(parsed.tradeoffMatrix.approaches) || parsed.tradeoffMatrix.approaches.length < 2) {
      return null;
    }
    if (!parsed.primitiveSpec || !parsed.primitiveSpec.coreThesis || !parsed.primitiveSpec.protocolContractCode) {
      return null;
    }

    const allNodes = [...ownedNodes, ...starNodes];
    const nodesByName = new Map(allNodes.map((n) => [n.fullName.toLowerCase(), n]));
    const fallbackEv = collectClusterEvidence(allNodes, codeMaps, { maxRefs: 3 });

    const validCategories = new Set<ArchitectureConstraintCategory>([
      "physics",
      "engineering",
      "security",
      "cost",
      "protocol",
      "reliability",
    ]);

    const firstPrinciples: ArchitectureFirstPrinciple[] = parsed.firstPrinciples.slice(0, 6).map((fp, i) => ({
      id: fp.id || `fp_llm_${i + 1}`,
      title: String(fp.title || "").trim() || fallback.firstPrinciples[0]?.title || "核心约束",
      category: validCategories.has(fp.category) ? fp.category : "engineering",
      constraint: String(fp.constraint || "").trim(),
      whyIrreducible: String(fp.whyIrreducible || "").trim(),
      failureWhenViolated: String(fp.failureWhenViolated || "").trim(),
      evidence: hydrateEvidenceUrls(Array.isArray(fp.evidence) ? fp.evidence : [], nodesByName, codeMaps, fallbackEv),
    })).filter((fp) => fp.constraint.length > 8);

    if (firstPrinciples.length < 2) return null;

    const approaches: ArchitectureTradeoffApproach[] = parsed.tradeoffMatrix.approaches.slice(0, 5).map((a, i) => ({
      id: a.id || `app_llm_${i + 1}`,
      name: String(a.name || `方案 ${i + 1}`).trim(),
      representativeRepos: Array.isArray(a.representativeRepos) ? a.representativeRepos.map(String) : [],
      gains: String(a.gains || "").trim(),
      sacrifices: String(a.sacrifices || "").trim(),
      bestFor: String(a.bestFor || "").trim(),
      scores: a.scores && typeof a.scores === "object" ? Object.fromEntries(Object.entries(a.scores).map(([k, v]) => [k, String(v)])) : {},
      evidence: hydrateEvidenceUrls(Array.isArray(a.evidence) ? a.evidence : [], nodesByName, codeMaps, fallbackEv),
    }));

    const consolidationPlan: ArchitectureConsolidationItem[] =
      Array.isArray(parsed.consolidationPlan) && parsed.consolidationPlan.length > 0
        ? parsed.consolidationPlan.slice(0, 5).map((c) => {
            const targetRepos = Array.isArray(c.targetOwnedRepos)
              ? c.targetOwnedRepos.map(String).filter((rn) => nodesByName.has(rn.toLowerCase()))
              : [];
            const effectiveRepos = targetRepos.length > 0 ? targetRepos : ownedNodes.slice(0, 2).map((n) => n.fullName);
            const targetNodeIds = effectiveRepos
              .map((rn) => nodesByName.get(rn.toLowerCase())?.id)
              .filter((x): x is string => Boolean(x));
            const effortRaw = String(c.effort || "M").toUpperCase();
            const effort: RepoModuleEffort = effortRaw === "S" || effortRaw === "L" ? effortRaw : "M";
            const riskRaw = String(c.risk || "medium").toLowerCase();
            const risk: RepoModuleRisk = riskRaw === "low" || riskRaw === "high" ? riskRaw : "medium";
            return {
              id: `con_${randomUUID().slice(0, 8)}`,
              title: String(c.title || "底座收敛项").trim(),
              kind:
                c.kind === "consolidate_shared_core" ||
                c.kind === "upgrade_capability" ||
                c.kind === "deprecate_duplicate" ||
                c.kind === "protocol_unification"
                  ? c.kind
                  : "upgrade_capability",
              targetOwnedRepos: effectiveRepos,
              targetNodeIds,
              referenceStarRepos: Array.isArray(c.referenceStarRepos) ? c.referenceStarRepos.map(String) : starNodes.slice(0, 2).map((n) => n.fullName),
              sharedCapabilityName: String(c.sharedCapabilityName || "shared-core").trim(),
              currentDuplicationOrGap: String(c.currentDuplicationOrGap || "").trim(),
              proposedAction: String(c.proposedAction || "").trim(),
              expectedImpact: String(c.expectedImpact || "").trim(),
              effort,
              risk,
              evidence: hydrateEvidenceUrls(Array.isArray(c.evidence) ? c.evidence : [], nodesByName, codeMaps, fallbackEv),
            };
          })
        : fallback.consolidationPlan;

    return {
      title: String(parsed.title || fallback.title).trim(),
      problemStatement: String(parsed.problemStatement || fallback.problemStatement).trim(),
      firstPrinciples,
      tradeoffMatrix: {
        summary: String(parsed.tradeoffMatrix.summary || fallback.tradeoffMatrix.summary).trim(),
        dimensions:
          Array.isArray(parsed.tradeoffMatrix.dimensions) && parsed.tradeoffMatrix.dimensions.length > 0
            ? parsed.tradeoffMatrix.dimensions.map((d) => ({
                key: String(d.key),
                label: String(d.label),
                description: d.description ? String(d.description) : undefined,
              }))
            : fallback.tradeoffMatrix.dimensions,
        approaches,
      },
      primitiveSpec: {
        coreThesis: String(parsed.primitiveSpec.coreThesis).trim(),
        entities:
          Array.isArray(parsed.primitiveSpec.entities) && parsed.primitiveSpec.entities.length > 0
            ? parsed.primitiveSpec.entities.slice(0, 6).map((ent) => ({
                name: String(ent.name),
                responsibility: String(ent.responsibility),
                boundaries: String(ent.boundaries || ""),
                keyOperations: Array.isArray(ent.keyOperations) ? ent.keyOperations.map(String) : [],
              }))
            : fallback.primitiveSpec.entities,
        contractLanguage:
          parsed.primitiveSpec.contractLanguage === "rust" ||
          parsed.primitiveSpec.contractLanguage === "python" ||
          parsed.primitiveSpec.contractLanguage === "go" ||
          parsed.primitiveSpec.contractLanguage === "idl"
            ? parsed.primitiveSpec.contractLanguage
            : "typescript",
        protocolContractCode: String(parsed.primitiveSpec.protocolContractCode).trim(),
        invariants:
          Array.isArray(parsed.primitiveSpec.invariants) && parsed.primitiveSpec.invariants.length > 0
            ? parsed.primitiveSpec.invariants.map(String)
            : fallback.primitiveSpec.invariants,
        failureModesAndGuardrails:
          Array.isArray(parsed.primitiveSpec.failureModesAndGuardrails) &&
          parsed.primitiveSpec.failureModesAndGuardrails.length > 0
            ? parsed.primitiveSpec.failureModesAndGuardrails.map((fg) => ({
                failureMode: String(fg.failureMode),
                impact: String(fg.impact),
                guardrail: String(fg.guardrail),
                detectionSignal: String(fg.detectionSignal || ""),
              }))
            : fallback.primitiveSpec.failureModesAndGuardrails,
        mermaidDiagram:
          typeof parsed.primitiveSpec.mermaidDiagram === "string" &&
          /^(?:flowchart|graph|sequenceDiagram|stateDiagram)/m.test(parsed.primitiveSpec.mermaidDiagram.trim())
            ? parsed.primitiveSpec.mermaidDiagram.trim()
            : fallback.primitiveSpec.mermaidDiagram,
        diagramCaption: String(parsed.primitiveSpec.diagramCaption || fallback.primitiveSpec.diagramCaption).trim(),
      },
      consolidationPlan,
    };
  } catch {
    return null;
  }
}

export async function distillArchitectureBlueprint(input: {
  title: string;
  problemStatement?: string;
  domainSlug: string | null;
  ownedNodes: RepoEvolutionNode[];
  starNodes: RepoEvolutionNode[];
  codeMaps: Map<string, RepoCodeMap>;
  privacyBlocked: boolean;
  llmCaller?: typeof callConfiguredLLM;
  providersCfg?: ProvidersConfig;
}): Promise<{
  blueprint: DistilledBlueprintPayload;
  usedLlm: boolean;
  notice?: string;
}> {
  const archetype = detectArchetype(input.title, input.domainSlug, [...input.ownedNodes, ...input.starNodes], input.codeMaps);

  const deterministicBlueprint =
    archetype === "browser_execution_gateway"
      ? buildBrowserGatewayBlueprint(input)
      : archetype === "agent_control_plane"
        ? buildAgentControlPlaneBlueprint(input)
        : archetype === "microvm_sandbox"
          ? buildMicrovmSandboxBlueprint(input)
          : buildGenericEvidenceBlueprint(input);

  if (input.privacyBlocked || !input.llmCaller) {
    return {
      blueprint: deterministicBlueprint,
      usedLlm: false,
      ...(input.privacyBlocked
        ? { notice: "参与蒸馏的仓库包含未授权外发的私有仓（allowLlmAnalysis=false），已严格走本地零外发 Code Map 结构化蒸馏引擎。" }
        : {}),
    };
  }

  const prompt = buildDistillLlmPrompt(input);
  const llmRes = await input.llmCaller(prompt, {
    system: "你是资深首席系统架构师，擅长从真实源码 Code Map 提炼第一性原理架构原语。只输出合法 JSON。",
    maxTokens: 3200,
    config: input.providersCfg,
  });

  if (llmRes.ok) {
    const parsed = parseLlmBlueprint(
      llmRes.text,
      deterministicBlueprint,
      input.ownedNodes,
      input.starNodes,
      input.codeMaps,
    );
    if (parsed) {
      return { blueprint: parsed, usedLlm: true };
    }
    return {
      blueprint: deterministicBlueprint,
      usedLlm: false,
      notice: "远端 LLM 蒸馏输出未通过证据校验，已自动回退本地 Code Map 结构化蒸馏结果。",
    };
  }

  return {
    blueprint: deterministicBlueprint,
    usedLlm: false,
    notice: llmRes.reason,
  };
}

// ---- Paradigm Drift Comparison (Compare Any Star Repo Against Existing Primitive) ----

export async function compareRepoAgainstPrimitive(input: {
  primitive: ArchitecturePrimitive;
  repoNode: RepoEvolutionNode;
  codeMap: RepoCodeMap;
  privacyBlocked: boolean;
  llmCaller?: typeof callConfiguredLLM;
  providersCfg?: ProvidersConfig;
  nowIso: string;
}): Promise<{
  note: ArchitectureParadigmNote;
  usedLlm: boolean;
  notice?: string;
}> {
  const { primitive, repoNode, codeMap, nowIso } = input;

  // Baseline signals from primitive's existing CodeMap refs & text
  const baselineLanguages = new Set(
    primitive.codeMapRefs.map((r) => (r.primaryLanguage || "").toLowerCase()).filter(Boolean),
  );
  const baselineText = [
    primitive.title,
    primitive.problemStatement,
    primitive.primitiveSpec.coreThesis,
    ...primitive.firstPrinciples.map((fp) => `${fp.title} ${fp.constraint}`),
    ...primitive.tradeoffMatrix.approaches.map((a) => `${a.name} ${a.gains} ${a.sacrifices}`),
    ...primitive.codeMapRefs.flatMap((r) => r.topHotspots.flatMap((h) => [h.path, ...h.exportedSymbols])),
  ]
    .join(" ")
    .toLowerCase();

  const repoHotspots = codeMap.hotspots.slice(0, 5);
  const repoSymbols = repoHotspots.flatMap((h) => h.exportedSymbols.map((s) => s.name));
  const repoText = [
    repoNode.fullName,
    repoNode.description,
    repoNode.topics.join(" "),
    ...repoHotspots.map((h) => `${h.path} ${h.layer} ${h.exportedSymbols.map((s) => s.name).join(" ")}`),
    ...codeMap.topExternalDeps.map((d) => d.name),
  ]
    .join(" ")
    .toLowerCase();

  const repoPrimaryLang = (codeMap.primaryLanguages[0]?.language || repoNode.primaryLanguage || "").toLowerCase();
  const isNovelRuntimeLang = Boolean(repoPrimaryLang && baselineLanguages.size > 0 && !baselineLanguages.has(repoPrimaryLang));

  // Detect paradigm-challenging keywords (e.g. WASM/eBPF/unikernel/interpreter-only vs MicroVM; pure vision/accessibility/CLI vs DOM; P2P/local-first/actor-mesh vs central hub)
  const shiftSignals: Array<{ re: RegExp; assumption: string; delta: string }> = [
    {
      re: /\b(?:wasm|webassembly|wasi|monty|pyodide|quickjs|v8-isolate)\b/,
      assumption: "强隔离必须依赖独立 Guest Linux 内核或重型容器",
      delta: "以语言级安全解释器 / WASM Isolate 实现微秒级启动与零内核虚拟化开销",
    },
    {
      re: /\b(?:ebpf|unikernel|libkrun|hyperlight|gvisor)\b/,
      assumption: "传统 KVM/Firecracker 进程模型是唯一虚拟化边界",
      delta: "引入更轻量的微虚拟化/内核态过滤边界（libkrun/unikernel/eBPF）",
    },
    {
      re: /\b(?:vision|vlm|screenshot|computer-use|grounding|ocr|accessibility|axtree)\b/,
      assumption: "浏览器操作必须强依赖 DOM Selector 或扩展注入脚本",
      delta: "以纯视觉/无障碍树（AXTree/GUI Grounding）直接跨 Canvas 与原生桌面执行动作",
    },
    {
      re: /\b(?:a2a|agent2agent|swarm|mesh|crdt|gossip|decentralized|actor)\b/,
      assumption: "多 Agent 协同必须经单一中心化 Dispatcher 串行路由",
      delta: "转向对等 Agent Mesh / Swarm 共享黑板或去中心化 Actor 协议",
    },
    {
      re: /\b(?:cli|headless|lightpanda|zig|servo|rust.*browser)\b/,
      assumption: "浏览器自动化必须承载完整 Chromium 渲染管线",
      delta: "采用专用轻量无头引擎或 CLI 协议直连大幅压缩内存与冷启成本",
    },
  ];

  const triggeredShifts = shiftSignals.filter((sig) => sig.re.test(repoText) && !sig.re.test(baselineText));

  // Check principle confirmation overlap
  const confirmedPrinciples: string[] = [];
  for (const fp of primitive.firstPrinciples) {
    const fpTokens = `${fp.title} ${fp.constraint}`
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
    const hits = fpTokens.filter((t) => repoText.includes(t));
    if (hits.length >= 2) {
      confirmedPrinciples.push(`${fp.title}（命中信号：${[...new Set(hits)].slice(0, 3).join(", ")}）`);
    }
  }
  if (confirmedPrinciples.length === 0 && primitive.firstPrinciples[0]) {
    confirmedPrinciples.push(
      `${primitive.firstPrinciples[0].title}（与 ${repoNode.name} 的 ${repoHotspots[0]?.layer ?? "core"} 分层主线一致）`,
    );
  }

  // Detect engineering tweaks (distinct external deps, extra layers, or novel key interfaces)
  const novelDeps = codeMap.topExternalDeps
    .map((d) => d.name)
    .filter((d) => !baselineText.includes(d.toLowerCase()))
    .slice(0, 4);

  const deltaCapabilities: string[] = [];
  if (repoHotspots[0]) {
    deltaCapabilities.push(
      `核心热点 \`${repoHotspots[0].path}\`（入度 ${repoHotspots[0].importedByCount}）暴露关键抽象 ${repoHotspots[0].exportedSymbols
        .slice(0, 4)
        .map((s) => `\`${s.name}\``)
        .join(" / ") || "内部编排模块"}`,
    );
  }
  if (novelDeps.length > 0) {
    deltaCapabilities.push(`引入原语基线未覆盖的工程依赖栈：${novelDeps.join("、")}`);
  }
  if (isNovelRuntimeLang) {
    deltaCapabilities.push(`采用异构实现语言 ${codeMap.primaryLanguages[0]?.language || repoNode.primaryLanguage}（基线以 ${[...baselineLanguages].join("/") || "原栈"} 为主）`);
  }
  for (const sh of triggeredShifts) {
    deltaCapabilities.push(sh.delta);
  }

  let verdict: ParadigmComparisonVerdict;
  let confidence: number;
  if (triggeredShifts.length >= 1 && (isNovelRuntimeLang || triggeredShifts.length >= 2)) {
    verdict = "paradigm_shift";
    confidence = Math.min(0.92, 0.72 + triggeredShifts.length * 0.08);
  } else if (novelDeps.length >= 2 || isNovelRuntimeLang || repoHotspots.length >= 4) {
    verdict = "engineering_tweak";
    confidence = 0.76;
  } else {
    verdict = "confirms_paradigm";
    confidence = 0.8;
  }

  const challengedAssumptions = triggeredShifts.map((s) => s.assumption);
  const evidence = evidenceFromCodeMap(repoNode, codeMap, { limit: 3 });

  const hotspotDesc = repoHotspots
    .slice(0, 2)
    .map((h) => `\`${h.path}\`（${h.exportedSymbols.slice(0, 3).map((s) => s.name).join("/") || h.layer}）`)
    .join(" 与 ");

  let summary =
    verdict === "paradigm_shift"
      ? `【范式跃迁】${repoNode.fullName}（剖析 ${codeMap.analyzedFileCount} 个文件，热点 ${hotspotDesc}）挑战了原语「${primitive.title}」的既有假设（${challengedAssumptions[0]}），建议复核 L1 根本约束并在 L2 矩阵补充新路线。`
      : verdict === "engineering_tweak"
        ? `【工程微调】${repoNode.fullName}（热点 ${hotspotDesc}）整体沿用原语「${primitive.title}」的 L1 约束框架，但在工程栈与实现细节上带来可吸收增量（${novelDeps.slice(0, 3).join("/") || repoSymbols.slice(0, 3).join("/")}），适合作为 L4 局部能力增强参考。`
        : `【范式印证】${repoNode.fullName}（热点 ${hotspotDesc}）的模块分层与核心接口印证了原语「${primitive.title}」的既定边界与 L3 抽象，无需修改原语主干。`;

  let usedLlm = false;
  let notice: string | undefined = input.privacyBlocked
    ? "该仓库涉及私有仓零外发限制，已使用本地 Code Map 确定性范式对照器。"
    : undefined;

  if (!input.privacyBlocked && input.llmCaller) {
    const prompt = [
      `请对照以下已沉淀架构原语与新仓库的真实零克隆 Code Map，判断该仓库属于：confirms_paradigm（范式印证）、engineering_tweak（工程微调）还是 paradigm_shift（打破核心假设的范式跃迁）。`,
      `【原语】${primitive.title}：${primitive.primitiveSpec.coreThesis}`,
      `L1 约束：${primitive.firstPrinciples.map((f) => `${f.title}: ${f.constraint}`).join(" | ")}`,
      `【新仓库】${repoNode.fullName} (${repoNode.primaryLanguage ?? "?"}, ★${repoNode.starsCount}): ${repoNode.description}`,
      `真实热点：${repoHotspots.map((h) => `${h.path}[${h.layer},in=${h.importedByCount}](${h.exportedSymbols.slice(0, 4).map((s) => s.name).join(",")})`).join("; ")}`,
      `外部依赖：${codeMap.topExternalDeps.slice(0, 8).map((d) => d.name).join(", ")}`,
      `输出 JSON：{"verdict":"confirms_paradigm|engineering_tweak|paradigm_shift","confidence":0.8,"summary":"...","challengedAssumptions":["..."],"confirmedPrinciples":["..."],"deltaCapabilities":["..."]}`,
    ].join("\n");

    const llmRes = await input.llmCaller(prompt, {
      system: "你是首席架构师，负责检测新开源项目相对既定架构原语是否产生范式漂移。只返回合法 JSON。",
      maxTokens: 1000,
      config: input.providersCfg,
    });

    if (llmRes.ok) {
      const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(llmRes.text);
      const cand = (fence ? fence[1] : llmRes.text).trim();
      const s = cand.indexOf("{");
      const e = cand.lastIndexOf("}");
      if (s !== -1 && e > s) {
        try {
          const parsed = JSON.parse(cand.slice(s, e + 1)) as Partial<ArchitectureParadigmNote>;
          if (
            parsed.verdict === "confirms_paradigm" ||
            parsed.verdict === "engineering_tweak" ||
            parsed.verdict === "paradigm_shift"
          ) {
            verdict = parsed.verdict;
            if (typeof parsed.confidence === "number" && parsed.confidence > 0 && parsed.confidence <= 1) {
              confidence = Math.round(parsed.confidence * 100) / 100;
            }
            if (typeof parsed.summary === "string" && parsed.summary.trim().length > 10) {
              summary = parsed.summary.trim();
            }
            if (Array.isArray(parsed.challengedAssumptions)) {
              challengedAssumptions.splice(0, challengedAssumptions.length, ...parsed.challengedAssumptions.map(String));
            }
            if (Array.isArray(parsed.confirmedPrinciples) && parsed.confirmedPrinciples.length > 0) {
              confirmedPrinciples.splice(0, confirmedPrinciples.length, ...parsed.confirmedPrinciples.map(String));
            }
            if (Array.isArray(parsed.deltaCapabilities) && parsed.deltaCapabilities.length > 0) {
              deltaCapabilities.splice(0, deltaCapabilities.length, ...parsed.deltaCapabilities.map(String));
            }
            usedLlm = true;
          }
        } catch {
          // keep deterministic result
        }
      }
    } else {
      notice = llmRes.reason;
    }
  }

  const note: ArchitectureParadigmNote = {
    id: `pnote_${randomUUID().slice(0, 8)}`,
    repoNodeId: repoNode.id,
    repoFullName: repoNode.fullName,
    commitSha: codeMap.commitSha,
    verdict,
    verdictLabel: PARADIGM_VERDICT_LABELS[verdict],
    confidence,
    summary,
    challengedAssumptions,
    confirmedPrinciples,
    deltaCapabilities,
    evidence,
    usedLlm,
    comparedAt: nowIso,
  };

  return { note, usedLlm, ...(notice ? { notice } : {}) };
}

// ---- ADR Markdown Exporter ----

export function renderArchitecturePrimitiveMarkdown(primitive: ArchitecturePrimitive): string {
  const lines: string[] = [];
  lines.push(`# ADR · ${primitive.title}`);
  lines.push("");
  lines.push(`- **Slug**: \`${primitive.slug}\``);
  lines.push(`- **状态**: ${ARCHITECTURE_PRIMITIVE_STATUS_LABELS[primitive.status]} (\`${primitive.status}\`) · **版本**: v${primitive.version}`);
  lines.push(`- **所属领域**: ${primitive.domainName ?? "跨领域"}`);
  lines.push(`- **蒸馏引擎**: ${primitive.distillationSource === "llm" ? "Zero-Clone Code Map + LLM 深化" : "Zero-Clone Code Map 本地确定性蒸馏"}${primitive.privacyRestricted ? "（含私有仓零外发保护）" : ""}`);
  lines.push(`- **更新时间**: ${primitive.updatedAt}`);
  lines.push("");

  // L0
  lines.push("## L0 · 问题陈述与零克隆源码证据（0 MB 本地克隆）");
  lines.push("");
  lines.push(primitive.problemStatement);
  lines.push("");
  if (primitive.codeMapRefs.length > 0) {
    lines.push("| 仓库 | 角色 | 语言 | Commit | 解析文件 | 核心热点与符号证据 |");
    lines.push("| --- | --- | --- | --- | ---: | --- |");
    for (const ref of primitive.codeMapRefs) {
      const hs = ref.topHotspots
        .slice(0, 2)
        .map((h) => {
          const link = h.url ? `[\`${h.path}\`](${h.url})` : `\`${h.path}\``;
          const syms = h.exportedSymbols.slice(0, 3).join(", ");
          return `${link} (in=${h.importedByCount}${syms ? `, ${syms}` : ""})`;
        })
        .join("<br/>");
      lines.push(
        `| \`${ref.repoFullName}\` | ${ref.role === "owned" ? "自有仓" : "Star 标杆"} | ${ref.primaryLanguage ?? "-"} | \`${ref.commitSha.slice(0, 8)}\` | ${ref.analyzedFileCount} | ${hs || "-"} |`,
      );
    }
    lines.push("");
  }

  // L1
  lines.push("## L1 · 第一性原理根本约束（First-Principles Constraints）");
  lines.push("");
  for (let i = 0; i < primitive.firstPrinciples.length; i++) {
    const fp = primitive.firstPrinciples[i];
    lines.push(`### ${i + 1}. ${fp.title}（${ARCHITECTURE_CONSTRAINT_CATEGORY_LABELS[fp.category]}）`);
    lines.push("");
    lines.push(`- **根本约束**：${fp.constraint}`);
    lines.push(`- **为何不可绕过**：${fp.whyIrreducible}`);
    lines.push(`- **违背后果**：${fp.failureWhenViolated}`);
    if (fp.evidence.length > 0) {
      const evStr = fp.evidence
        .map((e) => (e.url ? `[${e.repoFullName}:${e.path}](${e.url})` : `\`${e.repoFullName}:${e.path}\``))
        .join(" · ");
      lines.push(`- **源码证据**：${evStr}`);
    }
    lines.push("");
  }

  // L2
  lines.push("## L2 · 横向方案对比与 Trade-off 矩阵");
  lines.push("");
  lines.push(primitive.tradeoffMatrix.summary);
  lines.push("");
  const dims = primitive.tradeoffMatrix.dimensions;
  const header = ["技术路线", "代表仓库", ...dims.map((d) => d.label), "核心收益", "核心牺牲"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const app of primitive.tradeoffMatrix.approaches) {
    const row = [
      `**${app.name}**`,
      app.representativeRepos.map((r) => `\`${r}\``).join(", ") || "-",
      ...dims.map((d) => app.scores[d.key] ?? "-"),
      app.gains,
      app.sacrifices,
    ];
    lines.push(`| ${row.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`);
  }
  lines.push("");

  // L3
  lines.push("## L3 · 最小不可再分抽象原语（Primitive Spec）");
  lines.push("");
  lines.push(`> **核心论断**：${primitive.primitiveSpec.coreThesis}`);
  lines.push("");
  lines.push("### 核心实体与职责边界");
  lines.push("");
  lines.push("| 实体 | 职责 | 边界约束 | 关键操作 |");
  lines.push("| --- | --- | --- | --- |");
  for (const ent of primitive.primitiveSpec.entities) {
    lines.push(
      `| \`${ent.name}\` | ${ent.responsibility} | ${ent.boundaries} | ${ent.keyOperations.map((op) => `\`${op}\``).join(", ")} |`,
    );
  }
  lines.push("");
  lines.push("### 最小协议 / 接口契约");
  lines.push("");
  lines.push(`\`\`\`${primitive.primitiveSpec.contractLanguage}`);
  lines.push(primitive.primitiveSpec.protocolContractCode);
  lines.push("```");
  lines.push("");
  lines.push("### 系统不变量（Invariants）");
  lines.push("");
  for (const inv of primitive.primitiveSpec.invariants) {
    lines.push(`- ${inv}`);
  }
  lines.push("");
  lines.push("### 失败模式与安全护栏");
  lines.push("");
  lines.push("| 失败模式 | 影响 | 确定性护栏 | 检测信号 |");
  lines.push("| --- | --- | --- | --- |");
  for (const fg of primitive.primitiveSpec.failureModesAndGuardrails) {
    lines.push(`| ${fg.failureMode} | ${fg.impact} | ${fg.guardrail} | \`${fg.detectionSignal}\` |`);
  }
  lines.push("");
  lines.push("### 架构原语拓扑图");
  lines.push("");
  lines.push("```mermaid");
  lines.push(primitive.primitiveSpec.mermaidDiagram);
  lines.push("```");
  lines.push("");
  if (primitive.primitiveSpec.diagramCaption) {
    lines.push(`*${primitive.primitiveSpec.diagramCaption}*`);
    lines.push("");
  }

  // L4
  lines.push("## L4 · 自有资产底座收敛与能力升级清单");
  lines.push("");
  for (let i = 0; i < primitive.consolidationPlan.length; i++) {
    const item = primitive.consolidationPlan[i];
    lines.push(
      `### ${i + 1}. ${item.title}（${ARCHITECTURE_CONSOLIDATION_KIND_LABELS[item.kind]} · 工作量 ${item.effort} / 风险 ${item.risk}）`,
    );
    lines.push("");
    lines.push(`- **目标自有仓**：${item.targetOwnedRepos.map((r) => `\`${r}\``).join(", ")}`);
    lines.push(`- **参考标杆仓**：${item.referenceStarRepos.map((r) => `\`${r}\``).join(", ") || "-"}`);
    lines.push(`- **推荐下沉共享能力**：\`${item.sharedCapabilityName}\``);
    lines.push(`- **现状重复 / 差距**：${item.currentDuplicationOrGap}`);
    lines.push(`- **行动方案**：${item.proposedAction}`);
    lines.push(`- **预期收益**：${item.expectedImpact}`);
    if (item.decisionPacketId) {
      lines.push(`- **总裁信箱审批单**：\`${item.decisionPacketId}\`（${item.decisionStatus ?? "已提交"}）`);
    }
    lines.push("");
  }

  if (primitive.paradigmNotes.length > 0) {
    lines.push("## 附录 · 新库范式对照记录");
    lines.push("");
    for (const note of primitive.paradigmNotes) {
      lines.push(`- **[${note.verdictLabel}] \`${note.repoFullName}\`**（${note.comparedAt.slice(0, 10)}，置信度 ${(note.confidence * 100).toFixed(0)}%）：${note.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---- Canvas Projection Layout Builder (L0 -> L1 -> L2 -> L3 -> L4) ----

export function buildCanvasProjectionPayload(
  primitive: ArchitecturePrimitive,
  options: { canvasId?: string; canvasName?: string } = {},
): ArchitectureCanvasProjectionPayload {
  const nodes: ArchitectureCanvasProjectionNodeDraft[] = [];
  const edges: ArchitectureCanvasProjectionEdgeDraft[] = [];

  const rootKey = "l0_overview";
  const repoSummary = primitive.codeMapRefs
    .map(
      (r) =>
        `- **${r.repoFullName}** (${r.role === "owned" ? "自有" : "Star"}, \`${r.commitSha.slice(0, 7)}\`, ${r.analyzedFileCount} files): ${r.topHotspots
          .slice(0, 2)
          .map((h) => `\`${h.path}\``)
          .join(", ")}`,
    )
    .join("\n");

  nodes.push({
    key: rootKey,
    type: "briefing",
    title: `L0 · ${primitive.title}`,
    markdown: `${primitive.problemStatement}\n\n**状态**: ${ARCHITECTURE_PRIMITIVE_STATUS_LABELS[primitive.status]} v${primitive.version}\n\n### 参与解剖仓库（零克隆 Code Map）\n${repoSummary}`,
    position: { x: 60, y: 260 },
    size: { width: 380, height: 320 },
    metadata: { layer: "L0", slug: primitive.slug },
  });

  // L1 Constraints column
  primitive.firstPrinciples.slice(0, 5).forEach((fp, idx) => {
    const k = `l1_${idx}`;
    nodes.push({
      key: k,
      type: "note",
      title: `L1 约束 · ${fp.title}`,
      markdown: `**维度**: ${ARCHITECTURE_CONSTRAINT_CATEGORY_LABELS[fp.category]}\n\n**约束**: ${fp.constraint}\n\n**为何不可绕过**: ${fp.whyIrreducible}\n\n**违背后果**: ${fp.failureWhenViolated}`,
      position: { x: 520, y: 40 + idx * 240 },
      size: { width: 340, height: 210 },
      metadata: { layer: "L1", constraintId: fp.id, category: fp.category },
    });
    edges.push({ sourceKey: rootKey, targetKey: k, type: "derives", label: "L1 约束" });
  });

  // L2 Tradeoff Matrix card
  const l2Key = "l2_tradeoffs";
  const l2Body = [
    primitive.tradeoffMatrix.summary,
    "",
    ...primitive.tradeoffMatrix.approaches.map(
      (a) =>
        `- **${a.name}** (${a.representativeRepos.join(", ")})\n  - 收益：${a.gains}\n  - 牺牲：${a.sacrifices}`,
    ),
  ].join("\n");
  nodes.push({
    key: l2Key,
    type: "briefing",
    title: "L2 · 横向方案与 Trade-off 矩阵",
    markdown: l2Body,
    position: { x: 940, y: 80 },
    size: { width: 390, height: 340 },
    metadata: { layer: "L2" },
  });
  edges.push({ sourceKey: rootKey, targetKey: l2Key, type: "semantic_link", label: "路线取舍" });
  if (primitive.firstPrinciples.length > 0) {
    edges.push({ sourceKey: "l1_0", targetKey: l2Key, type: "derives", label: "约束推导" });
  }

  // L3 Primitive Spec card
  const l3Key = "l3_primitive";
  const l3Body = [
    `> ${primitive.primitiveSpec.coreThesis}`,
    "",
    "### 核心实体",
    ...primitive.primitiveSpec.entities.map((e) => `- **${e.name}**: ${e.responsibility}`),
    "",
    "### 最小协议契约",
    `\`\`\`${primitive.primitiveSpec.contractLanguage}\n${primitive.primitiveSpec.protocolContractCode}\n\`\`\``,
    "",
    "### 架构图（Mermaid）",
    `\`\`\`mermaid\n${primitive.primitiveSpec.mermaidDiagram}\n\`\`\``,
  ].join("\n");
  nodes.push({
    key: l3Key,
    type: "note",
    title: "L3 · 最小不可再分抽象原语",
    markdown: l3Body,
    position: { x: 940, y: 470 },
    size: { width: 420, height: 420 },
    metadata: { layer: "L3", contractLanguage: primitive.primitiveSpec.contractLanguage },
  });
  edges.push({ sourceKey: l2Key, targetKey: l3Key, type: "derives", label: "收敛原语" });

  // L4 Consolidation items column
  primitive.consolidationPlan.slice(0, 5).forEach((item, idx) => {
    const k = `l4_${idx}`;
    nodes.push({
      key: k,
      type: "task",
      title: `L4 收敛 · ${item.title}`,
      markdown: `**类型**: ${ARCHITECTURE_CONSOLIDATION_KIND_LABELS[item.kind]} · 工作量 ${item.effort} / 风险 ${item.risk}\n\n**目标自有仓**: ${item.targetOwnedRepos.join(", ")}\n**共享能力**: \`${item.sharedCapabilityName}\`\n\n**差距**: ${item.currentDuplicationOrGap}\n\n**行动**: ${item.proposedAction}`,
      position: { x: 1440, y: 80 + idx * 250 },
      size: { width: 360, height: 220 },
      metadata: {
        layer: "L4",
        consolidationItemId: item.id,
        targetOwnedRepos: item.targetOwnedRepos,
        decisionPacketId: item.decisionPacketId ?? null,
      },
    });
    edges.push({ sourceKey: l3Key, targetKey: k, type: "derives", label: "底座落地" });
  });

  return {
    primitive,
    canvasId: options.canvasId,
    canvasName: options.canvasName?.trim() || `架构原语 · ${primitive.title}`,
    canvasDescription: `${primitive.problemStatement.slice(0, 180)}（来自 #repo-evolution 第一性原理蒸馏 v${primitive.version}）`,
    nodes,
    edges,
  };
}
