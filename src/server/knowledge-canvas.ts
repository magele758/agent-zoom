import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  ArchivedEdgeSnapshot,
  ArchivedNodeSnapshot,
  ArchiveTombstoneResult,
  AutoLinkResult,
  BriefingIslandItem,
  BriefingIslandResult,
  CanvasDetail,
  CanvasEdge,
  CanvasEdgeType,
  CanvasExportResult,
  CanvasNode,
  CanvasNodeStatus,
  CanvasNodeType,
  CanvasPoint,
  CanvasSize,
  CanvasSummary,
  CanvasViewport,
  CrossCanvasVectorMatch,
  ExpandSpaceResult,
  InkStroke,
  KnowledgeCanvasHooks,
  OcrBlock,
  OcrRecognizeResult,
  RestoreTombstoneResult,
  SemanticSearchOptions,
  SemanticSearchResult,
  SemanticSearchResultItem,
} from "../knowledge-canvas-types.ts";
import { ApiError } from "./logic.ts";
import {
  callConfiguredLLM,
  computeSemanticVector,
  cosineSimilarity,
  LOCAL_VECTOR_DIMENSIONS,
  localSemanticVector,
  type ProvidersStore,
} from "./providers.ts";
import { submitAuth } from "./workflow/http.ts";

const NODE_TYPES = ["note", "ink", "task", "portal", "briefing", "tombstone"] as const;
const NODE_STATUSES = ["draft", "active", "archived", "published"] as const;
const EDGE_TYPES = ["derives", "blocks", "portal", "semantic_link", "deploy_to"] as const;

const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

const DEFAULT_NODE_SIZES: Record<CanvasNodeType, CanvasSize> = {
  note: { width: 280, height: 180 },
  ink: { width: 340, height: 260 },
  task: { width: 290, height: 170 },
  portal: { width: 260, height: 148 },
  briefing: { width: 300, height: 195 },
  tombstone: { width: 280, height: 165 },
};

const NODE_TYPE_LABELS: Record<CanvasNodeType, string> = {
  note: "笔记卡片",
  ink: "手写墨迹",
  task: "任务节点",
  briefing: "每日简报岛",
  portal: "时空任意门",
  tombstone: "结案墓碑",
};

const EDGE_TYPE_LABELS: Record<CanvasEdgeType, string> = {
  derives: "推导派生",
  blocks: "前置阻塞",
  portal: "时空传送",
  semantic_link: "语义共振",
  deploy_to: "交付部署",
};

const viewportPartialSchema = z.object({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  zoom: z.number().finite().min(0.15).max(4).optional(),
});

const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

const sizeSchema = z.object({
  width: z.number().finite().min(80).max(2400),
  height: z.number().finite().min(60).max(2400),
});

const createCanvasSchema = z.object({
  name: z.string().trim().min(1, "画布名称不能为空").max(160),
  description: z.string().trim().max(2000).optional(),
  viewport: viewportPartialSchema.optional(),
});

const updateCanvasSchema = z.object({
  name: z.string().trim().min(1, "画布名称不能为空").max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  viewport: viewportPartialSchema.optional(),
  isArchived: z.boolean().optional(),
});

const createNodeSchema = z.object({
  type: z.enum(NODE_TYPES),
  status: z.enum(NODE_STATUSES).optional(),
  title: z.string().trim().min(1, "节点标题不能为空").max(300),
  content: z.record(z.string(), z.unknown()).optional(),
  position: pointSchema.optional(),
  size: sizeSchema.optional(),
  parentId: z.string().trim().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  targetCanvasId: z.string().trim().min(1).optional(),
  bidirectional: z.boolean().optional(),
});

const updateNodeSchema = z.object({
  title: z.string().trim().min(1, "节点标题不能为空").max(300).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  position: pointSchema.optional(),
  size: sizeSchema.optional(),
  status: z.enum(NODE_STATUSES).optional(),
  parentId: z.string().trim().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const promoteTaskSchema = z.object({
  project: z.string().trim().max(200).optional(),
});

const expandSpaceSchema = z.object({
  axis: z.enum(["x", "y"]),
  origin: z.number().finite(),
  delta: z.number().finite().min(-10000).max(10000),
});

const createEdgeSchema = z.object({
  sourceId: z.string().trim().min(1),
  targetId: z.string().trim().min(1),
  type: z.enum(EDGE_TYPES).optional(),
  weight: z.number().finite().min(0).max(10).optional(),
  label: z.string().trim().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const semanticSearchSchema = z.object({
  query: z.string().trim().min(1, "检索关键词不能为空").max(2000),
  topK: z.number().int().min(1).max(50).optional(),
  threshold: z.number().finite().min(-1).max(1).optional(),
  includeAllCanvases: z.boolean().optional(),
});

const autoLinkSchema = z.object({
  threshold: z.number().finite().min(0.05).max(1).optional(),
});

const inkPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  pressure: z.number().finite().min(0).max(2).optional(),
  t: z.number().finite().optional(),
});

const inkStrokeSchema = z.object({
  points: z.array(inkPointSchema).min(1),
  color: z.string().trim().max(40).optional(),
  width: z.number().finite().min(0.5).max(40).optional(),
});

const ocrSchema = z.object({
  imageUrl: z.string().trim().url().max(2000).optional(),
  imageBase64: z.string().trim().min(1).max(12_000_000).optional(),
  strokes: z.array(inkStrokeSchema).max(2000).optional(),
  hintText: z.string().trim().max(4000).optional(),
  caption: z.string().trim().max(4000).optional(),
});

const archiveTombstoneSchema = z.object({
  nodeIds: z.array(z.string().trim().min(1)).min(1, "请至少选择一个节点进行归档降维").max(200),
  title: z.string().trim().min(1).max(300).optional(),
});

interface CanvasRow {
  id: string;
  name: string;
  description: string;
  viewport: string;
  is_archived: number;
  created_at: string;
  updated_at: string;
  node_count?: number;
  edge_count?: number;
}

interface NodeRow {
  id: string;
  canvas_id: string;
  type: string;
  status: string;
  title: string;
  content: string;
  position: string;
  size: string;
  parent_id: string | null;
  metadata: string;
  embedding: string | null;
  embedding_source: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  canvas_id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  label: string;
  metadata: string;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseViewport(raw: string | null | undefined): CanvasViewport {
  const obj = parseJsonObject(raw);
  const x = typeof obj.x === "number" && Number.isFinite(obj.x) ? obj.x : DEFAULT_VIEWPORT.x;
  const y = typeof obj.y === "number" && Number.isFinite(obj.y) ? obj.y : DEFAULT_VIEWPORT.y;
  const zoomRaw = typeof obj.zoom === "number" && Number.isFinite(obj.zoom) ? obj.zoom : DEFAULT_VIEWPORT.zoom;
  const zoom = Math.max(0.15, Math.min(4, zoomRaw));
  return { x, y, zoom };
}

function parsePoint(raw: string | null | undefined): CanvasPoint {
  const obj = parseJsonObject(raw);
  return {
    x: typeof obj.x === "number" && Number.isFinite(obj.x) ? obj.x : 120,
    y: typeof obj.y === "number" && Number.isFinite(obj.y) ? obj.y : 120,
  };
}

function parseSize(raw: string | null | undefined, type: CanvasNodeType): CanvasSize {
  const obj = parseJsonObject(raw);
  const fallback = DEFAULT_NODE_SIZES[type];
  return {
    width: typeof obj.width === "number" && Number.isFinite(obj.width) && obj.width >= 80 ? obj.width : fallback.width,
    height: typeof obj.height === "number" && Number.isFinite(obj.height) && obj.height >= 60 ? obj.height : fallback.height,
  };
}

function parseEmbedding(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "number") {
      return parsed as number[];
    }
    return null;
  } catch {
    return null;
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function extractNodeSemanticText(title: string, content: Record<string, unknown>): string {
  const parts: string[] = [];
  if (title.trim()) parts.push(title.trim());

  const stringKeys = [
    "text",
    "markdown",
    "summary",
    "description",
    "recognizedText",
    "hintText",
    "caption",
    "note",
    "source",
    "targetCanvasName",
    "project",
  ];
  for (const key of stringKeys) {
    const val = content[key];
    if (typeof val === "string" && val.trim()) {
      parts.push(val.trim());
    }
  }
  if (Array.isArray(content.tags)) {
    const tags = content.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (tags.length) parts.push(tags.join(" "));
  }
  return parts.join("\n");
}

function buildSnippet(content: Record<string, unknown>, maxLen = 160): string {
  const candidates = [
    content.summary,
    content.text,
    content.recognizedText,
    content.description,
    content.markdown,
    content.hintText,
    content.caption,
    content.note,
    content.targetCanvasName ? `时空任意门 → ${String(content.targetCanvasName)}` : undefined,
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) {
      const compact = item.replace(/\s+/g, " ").trim();
      return compact.length > maxLen ? compact.slice(0, maxLen) + "…" : compact;
    }
  }
  return "";
}

function slugifyFilename(name: string): string {
  const clean = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (clean || "knowledge-canvas").slice(0, 80) + ".md";
}

function analyzeLocalInkStrokes(
  strokes: InkStroke[],
  hintText?: string,
  caption?: string,
): OcrRecognizeResult {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let pointCount = 0;

  interface StrokeMetric {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    midY: number;
    height: number;
    pointCount: number;
  }

  const metrics: StrokeMetric[] = [];
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    let sMinX = Infinity;
    let sMaxX = -Infinity;
    let sMinY = Infinity;
    let sMaxY = -Infinity;
    for (const pt of stroke.points) {
      pointCount += 1;
      if (pt.x < sMinX) sMinX = pt.x;
      if (pt.x > sMaxX) sMaxX = pt.x;
      if (pt.y < sMinY) sMinY = pt.y;
      if (pt.y > sMaxY) sMaxY = pt.y;
    }
    if (sMinX < minX) minX = sMinX;
    if (sMaxX > maxX) maxX = sMaxX;
    if (sMinY < minY) minY = sMinY;
    if (sMaxY > maxY) maxY = sMaxY;
    metrics.push({
      minX: sMinX,
      maxX: sMaxX,
      minY: sMinY,
      maxY: sMaxY,
      midY: (sMinY + sMaxY) / 2,
      height: Math.max(4, sMaxY - sMinY),
      pointCount: stroke.points.length,
    });
  }

  const bbox =
    Number.isFinite(minX) && Number.isFinite(minY)
      ? {
          x: round(minX, 1),
          y: round(minY, 1),
          width: round(Math.max(1, maxX - minX), 1),
          height: round(Math.max(1, maxY - minY), 1),
        }
      : null;

  // Group strokes into horizontal writing lines by vertical proximity
  const sorted = [...metrics].sort((a, b) => a.midY - b.midY || a.minX - b.minX);
  const avgHeight =
    sorted.length > 0 ? sorted.reduce((acc, s) => acc + s.height, 0) / sorted.length : 18;
  const lineThreshold = Math.max(18, avgHeight * 1.1);

  const lineGroups: StrokeMetric[][] = [];
  for (const stroke of sorted) {
    const lastGroup = lineGroups[lineGroups.length - 1];
    if (!lastGroup) {
      lineGroups.push([stroke]);
      continue;
    }
    const groupMidY = lastGroup.reduce((acc, s) => acc + s.midY, 0) / lastGroup.length;
    if (Math.abs(stroke.midY - groupMidY) <= lineThreshold) {
      lastGroup.push(stroke);
    } else {
      lineGroups.push([stroke]);
    }
  }

  const manualHint = [hintText?.trim(), caption?.trim()].filter(Boolean).join("\n").trim();
  const hintLines = manualHint
    ? manualHint
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  const blocks: OcrBlock[] = [];
  if (lineGroups.length > 0) {
    lineGroups.forEach((group, idx) => {
      const gMinX = Math.min(...group.map((s) => s.minX));
      const gMaxX = Math.max(...group.map((s) => s.maxX));
      const gMinY = Math.min(...group.map((s) => s.minY));
      const gMaxY = Math.max(...group.map((s) => s.maxY));
      const gBox = {
        x: round(gMinX, 1),
        y: round(gMinY, 1),
        width: round(Math.max(1, gMaxX - gMinX), 1),
        height: round(Math.max(1, gMaxY - gMinY), 1),
      };
      const blockText =
        hintLines[idx] ??
        (idx === 0 && hintLines.length === 1
          ? hintLines[0]
          : `手写区块 #${idx + 1}（${group.length} 笔 · ${Math.round(gBox.width)}×${Math.round(gBox.height)}px）`);
      blocks.push({ text: blockText, bbox: gBox });
    });
  } else if (hintLines.length > 0) {
    hintLines.forEach((line, idx) => {
      blocks.push({
        text: line,
        bbox: { x: 0, y: idx * 24, width: Math.max(40, line.length * 12), height: 20 },
      });
    });
  }

  let text: string;
  let confidence: number;
  if (manualHint) {
    text = manualHint;
    confidence = strokes.length > 0 ? 0.88 : 0.82;
  } else if (bbox) {
    text =
      `[手写墨迹识别 · 共 ${strokes.length} 笔 / ${lineGroups.length} 个书写行区块 / 范围 ${Math.round(bbox.width)}×${Math.round(bbox.height)}px]\n` +
      blocks.map((b) => `- ${b.text}`).join("\n");
    confidence = 0.62;
  } else {
    text = "[未检测到有效笔迹或提示文本]";
    confidence = 0.2;
  }

  return {
    text,
    mode: "local_ink_analyzer",
    confidence,
    blocks,
    stats: {
      strokeCount: strokes.length,
      pointCount,
      lineGroupCount: lineGroups.length,
      bbox,
    },
    providerDetail: "内置本地手写笔迹几何分析器",
  };
}

function buildBuiltinTombstoneMarkdown(
  title: string,
  canvasName: string,
  nodes: ArchivedNodeSnapshot[],
  edges: ArchivedEdgeSnapshot[],
  archivedAt: string,
): string {
  const nodeNameMap = new Map(nodes.map((n) => [n.id, n.title]));
  const lines: string[] = [
    `# ${title}`,
    "",
    `- **来源画布**：${canvasName}`,
    `- **归档时间**：${archivedAt}`,
    `- **收束节点数**：${nodes.length}`,
    `- **关联连线数**：${edges.length}`,
    "",
    "## 收束节点摘要",
    "",
  ];

  for (const node of nodes) {
    const label = NODE_TYPE_LABELS[node.type] ?? node.type;
    lines.push(`### [${label}] ${node.title}`);
    const body = extractNodeSemanticText("", node.content).trim();
    if (body) {
      lines.push(body);
    } else {
      lines.push("（无正文内容）");
    }
    lines.push("");
  }

  if (edges.length > 0) {
    lines.push("## 关系脉络", "");
    for (const edge of edges) {
      const from = nodeNameMap.get(edge.sourceId) ?? edge.sourceId;
      const to = nodeNameMap.get(edge.targetId) ?? edge.targetId;
      const eLabel = EDGE_TYPE_LABELS[edge.type] ?? edge.type;
      const detail = edge.label ? ` · ${edge.label}` : "";
      lines.push(`- ${from} —[${eLabel}${detail}]→ ${to}`);
    }
    lines.push("");
  }

  lines.push("## 结案沉淀要点", "");
  const keyTitles = nodes.slice(0, 6).map((n) => `「${n.title}」`);
  lines.push(`- 已将 ${keyTitles.join("、")} 等 ${nodes.length} 个探索节点降维收束为可回溯档案。`);
  if (edges.some((e) => e.type === "semantic_link")) {
    lines.push("- 包含语义共振自动连接脉络，可通过墓碑随时还原原始画布拓扑。");
  }
  lines.push("");

  return lines.join("\n");
}

function parseRemoteOcrPayload(payload: unknown): { text: string; confidence: number; blocks: OcrBlock[] } | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  let text = "";
  const blocks: OcrBlock[] = [];

  if (typeof obj.text === "string" && obj.text.trim()) {
    text = obj.text.trim();
  } else if (typeof obj.recognizedText === "string" && obj.recognizedText.trim()) {
    text = obj.recognizedText.trim();
  } else if (typeof obj.result === "string" && obj.result.trim()) {
    text = obj.result.trim();
  }

  if (Array.isArray(obj.blocks)) {
    for (const item of obj.blocks) {
      if (item && typeof item === "object") {
        const b = item as Record<string, unknown>;
        const bText = typeof b.text === "string" ? b.text.trim() : "";
        const rawBox = b.bbox && typeof b.bbox === "object" ? (b.bbox as Record<string, unknown>) : {};
        if (bText) {
          blocks.push({
            text: bText,
            bbox: {
              x: typeof rawBox.x === "number" ? rawBox.x : 0,
              y: typeof rawBox.y === "number" ? rawBox.y : 0,
              width: typeof rawBox.width === "number" ? rawBox.width : 100,
              height: typeof rawBox.height === "number" ? rawBox.height : 24,
            },
          });
        }
      }
    }
  } else if (Array.isArray(obj.lines)) {
    obj.lines.forEach((line, idx) => {
      if (typeof line === "string" && line.trim()) {
        blocks.push({ text: line.trim(), bbox: { x: 0, y: idx * 24, width: 200, height: 22 } });
      } else if (line && typeof line === "object" && typeof (line as Record<string, unknown>).text === "string") {
        const lt = String((line as Record<string, unknown>).text).trim();
        if (lt) blocks.push({ text: lt, bbox: { x: 0, y: idx * 24, width: 200, height: 22 } });
      }
    });
  }

  if (!text && blocks.length > 0) {
    text = blocks.map((b) => b.text).join("\n");
  }
  if (!text) return null;

  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.92;

  return { text, confidence, blocks };
}

export interface KnowledgeCanvasStoreOptions {
  hooks?: KnowledgeCanvasHooks;
  fetchImpl?: typeof fetch;
}

export class KnowledgeCanvasStore {
  private hooks: KnowledgeCanvasHooks;
  private fetchImpl: typeof fetch;

  constructor(
    private db: DatabaseSync,
    private providers: ProvidersStore,
    options: KnowledgeCanvasStoreOptions = {},
  ) {
    this.hooks = options.hooks ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;

    db.exec(`
      CREATE TABLE IF NOT EXISTS opc_canvases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        viewport TEXT NOT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opc_canvas_nodes (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '{}',
        position TEXT NOT NULL,
        size TEXT NOT NULL,
        parent_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding TEXT,
        embedding_source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (canvas_id) REFERENCES opc_canvases(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS opc_canvas_edges (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'derives',
        weight REAL NOT NULL DEFAULT 1,
        label TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (canvas_id) REFERENCES opc_canvases(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_opc_canvas_nodes_canvas ON opc_canvas_nodes(canvas_id);
      CREATE INDEX IF NOT EXISTS idx_opc_canvas_edges_canvas ON opc_canvas_edges(canvas_id);
    `);
  }

  setHooks(hooks: KnowledgeCanvasHooks): void {
    this.hooks = hooks;
  }

  private runInTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure if no transaction is active.
      }
      throw err;
    }
  }

  private touchCanvas(canvasId: string, timestamp = nowIso()): void {
    this.db.prepare("UPDATE opc_canvases SET updated_at = ? WHERE id = ?").run(timestamp, canvasId);
  }

  private requireCanvasRow(canvasId: string): CanvasRow {
    const row = this.db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM opc_canvas_nodes n WHERE n.canvas_id = c.id) AS node_count,
                (SELECT COUNT(*) FROM opc_canvas_edges e WHERE e.canvas_id = c.id) AS edge_count
         FROM opc_canvases c
         WHERE c.id = ?`,
      )
      .get(canvasId) as CanvasRow | undefined;
    if (!row) {
      throw new ApiError(404, "canvas_not_found", `画布不存在: ${canvasId}`);
    }
    return row;
  }

  private requireNodeRow(canvasId: string, nodeId: string): NodeRow {
    const row = this.db
      .prepare("SELECT * FROM opc_canvas_nodes WHERE id = ? AND canvas_id = ?")
      .get(nodeId, canvasId) as NodeRow | undefined;
    if (!row) {
      throw new ApiError(404, "canvas_node_not_found", `画布节点不存在: ${nodeId}`);
    }
    return row;
  }

  private mapCanvasRow(row: CanvasRow): CanvasSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      viewport: parseViewport(row.viewport),
      isArchived: Boolean(row.is_archived),
      nodeCount: Number(row.node_count ?? 0),
      edgeCount: Number(row.edge_count ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapNodeRow(row: NodeRow, hydrateTask = true): CanvasNode {
    const type = (NODE_TYPES.includes(row.type as CanvasNodeType) ? row.type : "note") as CanvasNodeType;
    const status = (NODE_STATUSES.includes(row.status as CanvasNodeStatus) ? row.status : "active") as CanvasNodeStatus;
    const content = parseJsonObject(row.content);
    const node: CanvasNode = {
      id: row.id,
      canvasId: row.canvas_id,
      type,
      status,
      title: row.title,
      content,
      position: parsePoint(row.position),
      size: parseSize(row.size, type),
      parentId: row.parent_id ?? null,
      metadata: parseJsonObject(row.metadata),
      embeddingSource:
        row.embedding_source === "remote" || row.embedding_source === "local" ? row.embedding_source : null,
      hasEmbedding: Boolean(row.embedding),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    if (hydrateTask && type === "task" && typeof content.taskId === "string" && content.taskId && this.hooks.getTaskSummary) {
      try {
        node.liveTask = this.hooks.getTaskSummary(content.taskId);
      } catch {
        node.liveTask = null;
      }
    }
    return node;
  }

  private mapEdgeRow(row: EdgeRow): CanvasEdge {
    const type = (EDGE_TYPES.includes(row.type as CanvasEdgeType) ? row.type : "derives") as CanvasEdgeType;
    return {
      id: row.id,
      canvasId: row.canvas_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type,
      weight: Number(row.weight ?? 1),
      label: row.label ?? "",
      metadata: parseJsonObject(row.metadata),
      createdAt: row.created_at,
    };
  }

  private findBlankOrigin(canvasId: string): CanvasPoint {
    const rows = this.db
      .prepare("SELECT position, size, type FROM opc_canvas_nodes WHERE canvas_id = ?")
      .all(canvasId) as Array<{ position: string; size: string; type: string }>;
    if (rows.length === 0) return { x: 100, y: 100 };

    let maxRight = -Infinity;
    let minTop = Infinity;
    for (const row of rows) {
      const pos = parsePoint(row.position);
      const type = (NODE_TYPES.includes(row.type as CanvasNodeType) ? row.type : "note") as CanvasNodeType;
      const size = parseSize(row.size, type);
      if (pos.x + size.width > maxRight) maxRight = pos.x + size.width;
      if (pos.y < minTop) minTop = pos.y;
    }
    return {
      x: Math.round(Math.max(100, maxRight + 120)),
      y: Math.round(Number.isFinite(minTop) ? minTop : 100),
    };
  }

  // ---- 1. Canvas CRUD ----

  listCanvases(includeArchived = false): CanvasSummary[] {
    const sql = `
      SELECT c.*,
             (SELECT COUNT(*) FROM opc_canvas_nodes n WHERE n.canvas_id = c.id) AS node_count,
             (SELECT COUNT(*) FROM opc_canvas_edges e WHERE e.canvas_id = c.id) AS edge_count
      FROM opc_canvases c
      ${includeArchived ? "" : "WHERE c.is_archived = 0"}
      ORDER BY c.updated_at DESC, c.created_at DESC
    `;
    const rows = this.db.prepare(sql).all() as unknown as CanvasRow[];
    return rows.map((row) => this.mapCanvasRow(row));
  }

  createCanvas(raw: unknown): CanvasSummary {
    const parsed = createCanvasSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "canvas_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }
    const id = `cv_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    const viewport: CanvasViewport = {
      x: parsed.data.viewport?.x ?? DEFAULT_VIEWPORT.x,
      y: parsed.data.viewport?.y ?? DEFAULT_VIEWPORT.y,
      zoom: parsed.data.viewport?.zoom ?? DEFAULT_VIEWPORT.zoom,
    };
    this.db
      .prepare(
        `INSERT INTO opc_canvases (id, name, description, viewport, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, parsed.data.name, parsed.data.description ?? "", JSON.stringify(viewport), now, now);

    return {
      id,
      name: parsed.data.name,
      description: parsed.data.description ?? "",
      viewport,
      isArchived: false,
      nodeCount: 0,
      edgeCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  getCanvas(id: string): CanvasDetail {
    const canvasRow = this.requireCanvasRow(id);
    const nodeRows = this.db
      .prepare("SELECT * FROM opc_canvas_nodes WHERE canvas_id = ? ORDER BY created_at ASC")
      .all(id) as unknown as NodeRow[];
    const edgeRows = this.db
      .prepare("SELECT * FROM opc_canvas_edges WHERE canvas_id = ? ORDER BY created_at ASC")
      .all(id) as unknown as EdgeRow[];

    const nodes = nodeRows.map((row) => this.mapNodeRow(row, true));
    const edges = edgeRows.map((row) => this.mapEdgeRow(row));
    const canvas = this.mapCanvasRow({
      ...canvasRow,
      node_count: nodes.length,
      edge_count: edges.length,
    });
    return { canvas, nodes, edges };
  }

  updateCanvas(id: string, raw: unknown): CanvasSummary {
    const existing = this.requireCanvasRow(id);
    const parsed = updateCanvasSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "canvas_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }
    const curViewport = parseViewport(existing.viewport);
    const nextViewport: CanvasViewport = parsed.data.viewport
      ? {
          x: parsed.data.viewport.x ?? curViewport.x,
          y: parsed.data.viewport.y ?? curViewport.y,
          zoom: parsed.data.viewport.zoom ?? curViewport.zoom,
        }
      : curViewport;

    const nextName = parsed.data.name ?? existing.name;
    const nextDesc = parsed.data.description ?? existing.description;
    const nextArchived =
      parsed.data.isArchived !== undefined ? (parsed.data.isArchived ? 1 : 0) : existing.is_archived;
    const now = nowIso();

    this.db
      .prepare(
        `UPDATE opc_canvases
         SET name = ?, description = ?, viewport = ?, is_archived = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextName, nextDesc, JSON.stringify(nextViewport), nextArchived, now, id);

    return this.mapCanvasRow({
      ...existing,
      name: nextName,
      description: nextDesc,
      viewport: JSON.stringify(nextViewport),
      is_archived: nextArchived,
      updated_at: now,
    });
  }

  deleteCanvas(id: string): { deleted: true; id: string } {
    this.requireCanvasRow(id);
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM opc_canvas_edges WHERE canvas_id = ?").run(id);
      this.db.prepare("DELETE FROM opc_canvas_nodes WHERE canvas_id = ?").run(id);
      this.db.prepare("DELETE FROM opc_canvases WHERE id = ?").run(id);
    });
    return { deleted: true, id };
  }

  // ---- 2. Node CRUD + Semantic Vectorization + Bidirectional Warp Portals ----

  async createNode(canvasId: string, raw: unknown): Promise<CanvasNode> {
    const sourceCanvasRow = this.requireCanvasRow(canvasId);
    const parsed = createNodeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "canvas_node_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }

    const input = parsed.data;
    const content: Record<string, unknown> = { ...(input.content ?? {}) };
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    const status: CanvasNodeStatus = input.status ?? (input.type === "tombstone" ? "archived" : "active");
    const position: CanvasPoint = input.position ?? { x: 120, y: 120 };
    const size: CanvasSize = input.size ?? { ...DEFAULT_NODE_SIZES[input.type] };

    const targetCanvasId =
      input.targetCanvasId ??
      (typeof content.targetCanvasId === "string" && content.targetCanvasId.trim()
        ? content.targetCanvasId.trim()
        : undefined);
    const bidirectional = input.bidirectional ?? Boolean(content.bidirectional);

    let targetCanvasRow: CanvasRow | undefined;
    if (input.type === "portal" && targetCanvasId) {
      if (targetCanvasId === canvasId) {
        throw new ApiError(400, "portal_self_target", "时空任意门的目标画布不能是当前画布本身");
      }
      targetCanvasRow = this.requireCanvasRow(targetCanvasId);
      content.targetCanvasId = targetCanvasRow.id;
      content.targetCanvasName = targetCanvasRow.name;
      content.bidirectional = bidirectional;
    }

    const nodeId = `nd_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    const semanticText = extractNodeSemanticText(input.title, content);
    const vectorResult = await computeSemanticVector(semanticText, this.providers.get(), this.fetchImpl);

    let reciprocalNode: CanvasNode | undefined;
    let reciprocalId: string | undefined;
    let reciprocalTitle = "";
    let reciprocalContent: Record<string, unknown> = {};
    let reciprocalPosition: CanvasPoint = { x: 140, y: 140 };
    let reciprocalVector: { vector: number[]; source: "remote" | "local" } | null = null;

    if (input.type === "portal" && bidirectional && targetCanvasRow) {
      reciprocalId = `nd_${randomUUID().slice(0, 12)}`;
      reciprocalTitle = `任意门 ← ${sourceCanvasRow.name}`;
      reciprocalContent = {
        targetCanvasId: sourceCanvasRow.id,
        targetCanvasName: sourceCanvasRow.name,
        bidirectional: true,
        reciprocalNodeId: nodeId,
        originNodeTitle: input.title,
      };
      content.reciprocalNodeId = reciprocalId;
      reciprocalPosition = this.findBlankOrigin(targetCanvasRow.id);
      const rVec = await computeSemanticVector(
        extractNodeSemanticText(reciprocalTitle, reciprocalContent),
        this.providers.get(),
        this.fetchImpl,
      );
      reciprocalVector = { vector: rVec.vector, source: rVec.source };
    }

    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO opc_canvas_nodes (
            id, canvas_id, type, status, title, content, position, size, parent_id, metadata,
            embedding, embedding_source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nodeId,
          canvasId,
          input.type,
          status,
          input.title,
          JSON.stringify(content),
          JSON.stringify(position),
          JSON.stringify(size),
          input.parentId ?? null,
          JSON.stringify(metadata),
          JSON.stringify(vectorResult.vector),
          vectorResult.source,
          now,
          now,
        );
      this.touchCanvas(canvasId, now);

      if (reciprocalId && targetCanvasRow && reciprocalVector) {
        const reciprocalSize = { ...DEFAULT_NODE_SIZES.portal };
        this.db
          .prepare(
            `INSERT INTO opc_canvas_nodes (
              id, canvas_id, type, status, title, content, position, size, parent_id, metadata,
              embedding, embedding_source, created_at, updated_at
            ) VALUES (?, ?, 'portal', 'active', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            reciprocalId,
            targetCanvasRow.id,
            reciprocalTitle,
            JSON.stringify(reciprocalContent),
            JSON.stringify(reciprocalPosition),
            JSON.stringify(reciprocalSize),
            JSON.stringify({ autoReciprocal: true }),
            JSON.stringify(reciprocalVector.vector),
            reciprocalVector.source,
            now,
            now,
          );
        this.touchCanvas(targetCanvasRow.id, now);
      }
    });

    const created = this.mapNodeRow(this.requireNodeRow(canvasId, nodeId), true);
    if (reciprocalId && targetCanvasRow) {
      reciprocalNode = this.mapNodeRow(this.requireNodeRow(targetCanvasRow.id, reciprocalId), false);
      created.reciprocalNode = reciprocalNode;
    }
    return created;
  }

  async updateNode(canvasId: string, nodeId: string, raw: unknown): Promise<CanvasNode> {
    this.requireCanvasRow(canvasId);
    const existing = this.requireNodeRow(canvasId, nodeId);
    const parsed = updateNodeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "canvas_node_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }

    const patch = parsed.data;
    const type = existing.type as CanvasNodeType;
    const nextTitle = patch.title ?? existing.title;
    const existingContent = parseJsonObject(existing.content);
    const nextContent = patch.content ? { ...existingContent, ...patch.content } : existingContent;
    const nextPosition = patch.position ?? parsePoint(existing.position);
    const nextSize = patch.size ?? parseSize(existing.size, type);
    const nextStatus = patch.status ?? (existing.status as CanvasNodeStatus);
    const nextParentId = patch.parentId !== undefined ? patch.parentId : existing.parent_id;
    const existingMetadata = parseJsonObject(existing.metadata);
    const nextMetadata = patch.metadata ? { ...existingMetadata, ...patch.metadata } : existingMetadata;

    let embeddingJson = existing.embedding;
    let embeddingSource = existing.embedding_source;
    const semanticChanged = patch.title !== undefined || patch.content !== undefined || !existing.embedding;

    if (semanticChanged) {
      const semanticText = extractNodeSemanticText(nextTitle, nextContent);
      const vectorResult = await computeSemanticVector(semanticText, this.providers.get(), this.fetchImpl);
      embeddingJson = JSON.stringify(vectorResult.vector);
      embeddingSource = vectorResult.source;
    }

    const now = nowIso();
    this.db
      .prepare(
        `UPDATE opc_canvas_nodes
         SET title = ?, content = ?, position = ?, size = ?, status = ?, parent_id = ?,
             metadata = ?, embedding = ?, embedding_source = ?, updated_at = ?
         WHERE id = ? AND canvas_id = ?`,
      )
      .run(
        nextTitle,
        JSON.stringify(nextContent),
        JSON.stringify(nextPosition),
        JSON.stringify(nextSize),
        nextStatus,
        nextParentId,
        JSON.stringify(nextMetadata),
        embeddingJson,
        embeddingSource,
        now,
        nodeId,
        canvasId,
      );
    this.touchCanvas(canvasId, now);

    return this.mapNodeRow(this.requireNodeRow(canvasId, nodeId), true);
  }

  deleteNode(canvasId: string, nodeId: string): { deleted: true; id: string; removedEdges: number } {
    this.requireCanvasRow(canvasId);
    this.requireNodeRow(canvasId, nodeId);

    const removedEdges = this.runInTransaction(() => {
      const edgeRes = this.db
        .prepare("DELETE FROM opc_canvas_edges WHERE canvas_id = ? AND (source_id = ? OR target_id = ?)")
        .run(canvasId, nodeId, nodeId);
      this.db.prepare("DELETE FROM opc_canvas_nodes WHERE canvas_id = ? AND id = ?").run(canvasId, nodeId);
      this.touchCanvas(canvasId);
      return Number(edgeRes.changes ?? 0);
    });

    return { deleted: true, id: nodeId, removedEdges };
  }

  async promoteNodeToTask(canvasId: string, nodeId: string, raw: unknown = {}): Promise<CanvasNode> {
    this.requireCanvasRow(canvasId);
    const existing = this.requireNodeRow(canvasId, nodeId);
    const parsed = promoteTaskSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new ApiError(
        400,
        "promote_task_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }

    if (!this.hooks.createTaskFromNode) {
      throw new ApiError(
        501,
        "task_hook_unconfigured",
        "当前实例未注入 createTaskFromNode 钩子，无法将画布节点升级为真实任务",
      );
    }

    const content = parseJsonObject(existing.content);
    const description =
      extractNodeSemanticText("", content).trim() || `由无界知识画布节点「${existing.title}」转化`;
    const project =
      parsed.data.project || (typeof content.project === "string" ? content.project : undefined);
    const sourceRef = `canvas:${canvasId}/node:${nodeId}`;

    const createdTask = this.hooks.createTaskFromNode({
      title: existing.title,
      description,
      project,
      sourceRef,
    });

    const now = nowIso();
    const nextContent: Record<string, unknown> = {
      ...content,
      taskId: createdTask.id,
      taskStatus: createdTask.status,
      priority: createdTask.priority,
      project: project ?? "",
      sourceRef,
      promotedAt: now,
    };

    const vec = await computeSemanticVector(
      extractNodeSemanticText(existing.title, nextContent),
      this.providers.get(),
      this.fetchImpl,
    );

    this.db
      .prepare(
        `UPDATE opc_canvas_nodes
         SET type = 'task', status = 'active', content = ?, embedding = ?, embedding_source = ?, updated_at = ?
         WHERE id = ? AND canvas_id = ?`,
      )
      .run(
        JSON.stringify(nextContent),
        JSON.stringify(vec.vector),
        vec.source,
        now,
        nodeId,
        canvasId,
      );
    this.touchCanvas(canvasId, now);

    return this.mapNodeRow(this.requireNodeRow(canvasId, nodeId), true);
  }

  // ---- 3. Dynamic Space Expansion (3A.4) ----

  expandSpace(canvasId: string, raw: unknown): ExpandSpaceResult {
    this.requireCanvasRow(canvasId);
    const parsed = expandSpaceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "expand_space_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }

    const { axis, origin, delta } = parsed.data;
    const rows = this.db
      .prepare("SELECT id, position FROM opc_canvas_nodes WHERE canvas_id = ?")
      .all(canvasId) as Array<{ id: string; position: string }>;

    const candidates = rows
      .map((row) => ({ id: row.id, position: parsePoint(row.position) }))
      .filter((item) => item.position[axis] >= origin);

    if (candidates.length === 0 || delta === 0) {
      return { axis, origin, delta: 0, movedCount: 0, movedNodes: [] };
    }

    // Prevent negative overlap across the origin split line while preserving relative distances
    let effectiveDelta = delta;
    if (delta < 0) {
      const minCoord = Math.min(...candidates.map((c) => c.position[axis]));
      effectiveDelta = Math.max(delta, origin - minCoord);
    }

    if (effectiveDelta === 0) {
      return { axis, origin, delta: 0, movedCount: 0, movedNodes: [] };
    }

    const now = nowIso();
    const movedNodes: Array<{ id: string; position: CanvasPoint }> = [];

    this.runInTransaction(() => {
      const stmt = this.db.prepare(
        "UPDATE opc_canvas_nodes SET position = ?, updated_at = ? WHERE id = ? AND canvas_id = ?",
      );
      for (const item of candidates) {
        const nextPos: CanvasPoint = {
          x: axis === "x" ? round(item.position.x + effectiveDelta, 2) : item.position.x,
          y: axis === "y" ? round(item.position.y + effectiveDelta, 2) : item.position.y,
        };
        stmt.run(JSON.stringify(nextPos), now, item.id, canvasId);
        movedNodes.push({ id: item.id, position: nextPos });
      }
      this.touchCanvas(canvasId, now);
    });

    return {
      axis,
      origin,
      delta: effectiveDelta,
      movedCount: movedNodes.length,
      movedNodes,
    };
  }

  // ---- 4. Edge CRUD ----

  createEdge(canvasId: string, raw: unknown): CanvasEdge {
    this.requireCanvasRow(canvasId);
    const parsed = createEdgeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "canvas_edge_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }

    const { sourceId, targetId, type = "derives", weight = 1, label = "", metadata = {} } = parsed.data;
    if (sourceId === targetId) {
      throw new ApiError(400, "canvas_edge_self", "连线的源节点与目标节点不能相同");
    }
    this.requireNodeRow(canvasId, sourceId);
    this.requireNodeRow(canvasId, targetId);

    const id = `ed_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO opc_canvas_edges (id, canvas_id, source_id, target_id, type, weight, label, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, canvasId, sourceId, targetId, type, weight, label, JSON.stringify(metadata), now);
    this.touchCanvas(canvasId, now);

    return {
      id,
      canvasId,
      sourceId,
      targetId,
      type,
      weight,
      label,
      metadata,
      createdAt: now,
    };
  }

  deleteEdge(canvasId: string, edgeId: string): { deleted: true; id: string } {
    this.requireCanvasRow(canvasId);
    const row = this.db
      .prepare("SELECT id FROM opc_canvas_edges WHERE id = ? AND canvas_id = ?")
      .get(edgeId, canvasId) as { id?: string } | undefined;
    if (!row?.id) {
      throw new ApiError(404, "canvas_edge_not_found", `画布连线不存在: ${edgeId}`);
    }
    this.db.prepare("DELETE FROM opc_canvas_edges WHERE id = ? AND canvas_id = ?").run(edgeId, canvasId);
    this.touchCanvas(canvasId);
    return { deleted: true, id: edgeId };
  }

  // ---- 5. Semantic Compass (3B.4) & Cross-Canvas Vector Lookup ----

  async semanticSearch(
    canvasId: string,
    query: string,
    options: SemanticSearchOptions = {},
  ): Promise<SemanticSearchResult> {
    this.requireCanvasRow(canvasId);
    const trimmed = query.trim();
    if (!trimmed) {
      throw new ApiError(400, "semantic_query_empty", "检索关键词不能为空");
    }

    const topK = Math.max(1, Math.min(50, Math.floor(options.topK ?? 8)));
    const threshold = options.threshold ?? 0.15;
    const includeAllCanvases = options.includeAllCanvases ?? true;

    const queryVecResult = await computeSemanticVector(trimmed, this.providers.get(), this.fetchImpl);
    const queryVec = queryVecResult.vector;

    const sql = includeAllCanvases
      ? `SELECT n.*, c.name AS canvas_name
         FROM opc_canvas_nodes n
         JOIN opc_canvases c ON c.id = n.canvas_id
         WHERE c.is_archived = 0 AND n.status != 'archived'`
      : `SELECT n.*, c.name AS canvas_name
         FROM opc_canvas_nodes n
         JOIN opc_canvases c ON c.id = n.canvas_id
         WHERE n.canvas_id = ? AND n.status != 'archived'`;

    const rows = (
      includeAllCanvases ? this.db.prepare(sql).all() : this.db.prepare(sql).all(canvasId)
    ) as unknown as Array<NodeRow & { canvas_name: string }>;

    const matches: SemanticSearchResultItem[] = [];
    for (const row of rows) {
      const content = parseJsonObject(row.content);
      let vec = parseEmbedding(row.embedding);
      if (!vec || vec.length !== queryVec.length) {
        vec = localSemanticVector(extractNodeSemanticText(row.title, content), queryVec.length);
      }
      const score = cosineSimilarity(queryVec, vec);
      if (score < threshold) continue;
      const nodeType = (NODE_TYPES.includes(row.type as CanvasNodeType) ? row.type : "note") as CanvasNodeType;
      matches.push({
        canvasId: row.canvas_id,
        canvasName: row.canvas_name,
        nodeId: row.id,
        title: row.title,
        snippet: buildSnippet(content),
        type: nodeType,
        score: round(score, 4),
        sourceKind: "canvas_node",
        href: `#canvas?id=${encodeURIComponent(row.canvas_id)}&node=${encodeURIComponent(row.id)}`,
        position: parsePoint(row.position),
      });
    }

    if (this.hooks.searchExternalMemory) {
      try {
        const external = this.hooks.searchExternalMemory(queryVec, trimmed, topK) ?? [];
        for (const item of external) {
          if (item.similarity < threshold) continue;
          matches.push({
            canvasId: null,
            canvasName: item.kind === "briefing" ? "每日简报" : "公司想法",
            nodeId: item.id,
            title: item.title,
            snippet: item.snippet,
            type: item.kind,
            score: round(item.similarity, 4),
            sourceKind: item.kind,
            href: item.href,
          });
        }
      } catch {
        // External memory hook failures degrade cleanly without breaking canvas search.
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return {
      query: trimmed,
      embeddingSource: queryVecResult.source,
      results: matches.slice(0, topK),
    };
  }

  searchNodesByVector(
    vector: number[],
    limit = 6,
    threshold = 0.35,
  ): CrossCanvasVectorMatch[] {
    if (!Array.isArray(vector) || vector.length === 0) return [];
    const maxItems = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT n.*, c.name AS canvas_name
         FROM opc_canvas_nodes n
         JOIN opc_canvases c ON c.id = n.canvas_id
         WHERE c.is_archived = 0 AND n.status != 'archived'`,
      )
      .all() as unknown as Array<NodeRow & { canvas_name: string }>;

    const matches: CrossCanvasVectorMatch[] = [];
    for (const row of rows) {
      const content = parseJsonObject(row.content);
      let nodeVec = parseEmbedding(row.embedding);
      if (!nodeVec || nodeVec.length !== vector.length) {
        if (vector.length === LOCAL_VECTOR_DIMENSIONS) {
          nodeVec = localSemanticVector(extractNodeSemanticText(row.title, content), LOCAL_VECTOR_DIMENSIONS);
        } else {
          continue;
        }
      }
      const score = cosineSimilarity(vector, nodeVec);
      if (score < threshold) continue;
      const nodeType = (NODE_TYPES.includes(row.type as CanvasNodeType) ? row.type : "note") as CanvasNodeType;
      matches.push({
        canvasId: row.canvas_id,
        canvasName: row.canvas_name,
        nodeId: row.id,
        title: row.title,
        type: nodeType,
        snippet: buildSnippet(content),
        score: round(score, 4),
        href: `#canvas?id=${encodeURIComponent(row.canvas_id)}&node=${encodeURIComponent(row.id)}`,
      });
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, maxItems);
  }

  // ---- 6. Semantic Auto-Link (3B.5) ----

  async autoLinkBySemantics(canvasId: string, threshold = 0.55): Promise<AutoLinkResult> {
    this.requireCanvasRow(canvasId);
    const clampedThreshold = Math.max(0.05, Math.min(1, threshold));

    const nodeRows = this.db
      .prepare(
        `SELECT * FROM opc_canvas_nodes
         WHERE canvas_id = ? AND status != 'archived' AND type != 'tombstone'
         ORDER BY created_at ASC`,
      )
      .all(canvasId) as unknown as NodeRow[];

    const nodesWithVectors: Array<{ id: string; vector: number[] }> = [];
    for (const row of nodeRows) {
      let vec = parseEmbedding(row.embedding);
      if (!vec) {
        const content = parseJsonObject(row.content);
        const computed = await computeSemanticVector(
          extractNodeSemanticText(row.title, content),
          this.providers.get(),
          this.fetchImpl,
        );
        vec = computed.vector;
        this.db
          .prepare("UPDATE opc_canvas_nodes SET embedding = ?, embedding_source = ? WHERE id = ?")
          .run(JSON.stringify(vec), computed.source, row.id);
      }
      nodesWithVectors.push({ id: row.id, vector: vec });
    }

    const existingEdges = this.db
      .prepare("SELECT source_id, target_id FROM opc_canvas_edges WHERE canvas_id = ?")
      .all(canvasId) as Array<{ source_id: string; target_id: string }>;
    const existingPairs = new Set(existingEdges.map((e) => pairKey(e.source_id, e.target_id)));

    const toCreate: Array<{ sourceId: string; targetId: string; sim: number }> = [];
    for (let i = 0; i < nodesWithVectors.length; i++) {
      for (let j = i + 1; j < nodesWithVectors.length; j++) {
        const a = nodesWithVectors[i];
        const b = nodesWithVectors[j];
        const key = pairKey(a.id, b.id);
        if (existingPairs.has(key)) continue;
        if (a.vector.length !== b.vector.length) continue;
        const sim = cosineSimilarity(a.vector, b.vector);
        if (sim >= clampedThreshold) {
          existingPairs.add(key);
          toCreate.push({ sourceId: a.id, targetId: b.id, sim });
        }
      }
    }

    const createdEdges: CanvasEdge[] = [];
    if (toCreate.length > 0) {
      const now = nowIso();
      this.runInTransaction(() => {
        const stmt = this.db.prepare(
          `INSERT INTO opc_canvas_edges (id, canvas_id, source_id, target_id, type, weight, label, metadata, created_at)
           VALUES (?, ?, ?, ?, 'semantic_link', ?, ?, ?, ?)`,
        );
        for (const item of toCreate) {
          const id = `ed_${randomUUID().slice(0, 12)}`;
          const weight = round(item.sim, 3);
          const label = `sim=${item.sim.toFixed(2)}`;
          const metadata = { autoLinked: true, similarity: round(item.sim, 4) };
          stmt.run(id, canvasId, item.sourceId, item.targetId, weight, label, JSON.stringify(metadata), now);
          createdEdges.push({
            id,
            canvasId,
            sourceId: item.sourceId,
            targetId: item.targetId,
            type: "semantic_link",
            weight,
            label,
            metadata,
            createdAt: now,
          });
        }
        this.touchCanvas(canvasId, now);
      });
    }

    return {
      threshold: clampedThreshold,
      created: createdEdges.length,
      edges: createdEdges,
    };
  }

  // ---- 7. OCR Recognition (3B.1) ----

  async ocrRecognize(raw: unknown): Promise<OcrRecognizeResult> {
    const parsed = ocrSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "ocr_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }

    const input = parsed.data;
    const strokes = input.strokes ?? [];
    if (!input.imageUrl && !input.imageBase64 && strokes.length === 0 && !input.hintText && !input.caption) {
      throw new ApiError(400, "ocr_empty_input", "请提供图片（imageUrl/imageBase64）、手写笔迹（strokes）或辅助文字");
    }

    const ocrConfig = this.providers.get().services.ocr;
    if (ocrConfig.enabled && ocrConfig.endpoint && (input.imageUrl || input.imageBase64)) {
      try {
        const res = await this.fetchImpl(ocrConfig.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            imageUrl: input.imageUrl,
            imageBase64: input.imageBase64,
            hintText: input.hintText ?? input.caption,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const payload = (await res.json()) as unknown;
          const remote = parseRemoteOcrPayload(payload);
          if (remote) {
            const localStats = analyzeLocalInkStrokes(strokes, input.hintText, input.caption).stats;
            return {
              text: remote.text,
              mode: "remote_ocr",
              confidence: remote.confidence,
              blocks: remote.blocks,
              stats: localStats,
              providerDetail: ocrConfig.endpoint,
            };
          }
        }
      } catch {
        // Fall through cleanly to local ink analyzer.
      }
    }

    return analyzeLocalInkStrokes(strokes, input.hintText, input.caption);
  }

  // ---- 8. One-Click Archive Dimensionality Reduction → Tombstone (3B.6) & Restore ----

  async archiveNodesToTombstone(canvasId: string, raw: unknown): Promise<ArchiveTombstoneResult> {
    const canvasRow = this.requireCanvasRow(canvasId);
    const parsed = archiveTombstoneSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "archive_tombstone_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }

    const uniqueIds = [...new Set(parsed.data.nodeIds)];
    const targetRows: NodeRow[] = uniqueIds.map((id) => this.requireNodeRow(canvasId, id));
    if (targetRows.some((row) => row.type === "tombstone")) {
      throw new ApiError(400, "archive_tombstone_nested", "不能对结案墓碑节点重复执行归档降维");
    }

    const archivedNodes: ArchivedNodeSnapshot[] = targetRows.map((row) => {
      const type = (NODE_TYPES.includes(row.type as CanvasNodeType) ? row.type : "note") as CanvasNodeType;
      const status = (NODE_STATUSES.includes(row.status as CanvasNodeStatus) ? row.status : "active") as CanvasNodeStatus;
      return {
        id: row.id,
        type,
        status,
        title: row.title,
        content: parseJsonObject(row.content),
        position: parsePoint(row.position),
        size: parseSize(row.size, type),
        parentId: row.parent_id ?? null,
        metadata: parseJsonObject(row.metadata),
      };
    });

    const idSet = new Set(uniqueIds);
    const allEdges = this.db
      .prepare("SELECT * FROM opc_canvas_edges WHERE canvas_id = ?")
      .all(canvasId) as unknown as EdgeRow[];
    const touchedEdges: ArchivedEdgeSnapshot[] = allEdges
      .filter((e) => idSet.has(e.source_id) || idSet.has(e.target_id))
      .map((row) => {
        const mapped = this.mapEdgeRow(row);
        return {
          id: mapped.id,
          sourceId: mapped.sourceId,
          targetId: mapped.targetId,
          type: mapped.type,
          weight: mapped.weight,
          label: mapped.label,
          metadata: mapped.metadata,
        };
      });

    const centroid: CanvasPoint = {
      x: Math.round(archivedNodes.reduce((sum, n) => sum + n.position.x, 0) / archivedNodes.length),
      y: Math.round(archivedNodes.reduce((sum, n) => sum + n.position.y, 0) / archivedNodes.length),
    };

    const tombstoneTitle =
      parsed.data.title ??
      (archivedNodes.length === 1
        ? `结案墓碑：${archivedNodes[0].title}`
        : `结案墓碑：${archivedNodes[0].title} 等 ${archivedNodes.length} 项`);

    const archivedAt = nowIso();
    const fallbackMarkdown = buildBuiltinTombstoneMarkdown(
      tombstoneTitle,
      canvasRow.name,
      archivedNodes,
      touchedEdges,
      archivedAt,
    );

    const llmPrompt = [
      `请将以下来自知识画布「${canvasRow.name}」的 ${archivedNodes.length} 个探索节点提炼为一份清晰、结构化的中文结案归档 Markdown 文档（包含核心背景、关键结论、决策与行动项）：`,
      "",
      fallbackMarkdown,
    ].join("\n");

    const llmResult = await callConfiguredLLM(llmPrompt, {
      system: "你是 OPC OS 知识架构师，擅长把发散的画布节点降维提炼为高信息密度的结案 Markdown 文档。",
      config: this.providers.get(),
      fetchImpl: this.fetchImpl,
    });

    const markdown = llmResult.ok ? llmResult.text : fallbackMarkdown;
    const summarySource: "llm" | "builtin" = llmResult.ok ? "llm" : "builtin";

    let companyNoteId: string | undefined;
    if (this.hooks.archiveToCompanyNote) {
      try {
        const noteRes = this.hooks.archiveToCompanyNote({
          title: tombstoneTitle,
          markdown,
          reference: `canvas:${canvasId}`,
        });
        if (noteRes && typeof noteRes.id === "string") {
          companyNoteId = noteRes.id;
        }
      } catch {
        // Keep tombstone archival resilient even if external note sink fails.
      }
    }

    const tombstoneId = `nd_${randomUUID().slice(0, 12)}`;
    const tombstoneContent: Record<string, unknown> = {
      markdown,
      archivedCount: archivedNodes.length,
      archivedNodes,
      archivedEdges: touchedEdges,
      archivedAt,
      companyNoteId: companyNoteId ?? null,
      summarySource,
    };

    const vec = await computeSemanticVector(
      `${tombstoneTitle}\n${markdown}`,
      this.providers.get(),
      this.fetchImpl,
    );

    this.runInTransaction(() => {
      const delEdgeStmt = this.db.prepare(
        "DELETE FROM opc_canvas_edges WHERE canvas_id = ? AND (source_id = ? OR target_id = ?)",
      );
      const delNodeStmt = this.db.prepare("DELETE FROM opc_canvas_nodes WHERE canvas_id = ? AND id = ?");
      for (const id of uniqueIds) {
        delEdgeStmt.run(canvasId, id, id);
        delNodeStmt.run(canvasId, id);
      }

      this.db
        .prepare(
          `INSERT INTO opc_canvas_nodes (
            id, canvas_id, type, status, title, content, position, size, parent_id, metadata,
            embedding, embedding_source, created_at, updated_at
          ) VALUES (?, ?, 'tombstone', 'archived', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          tombstoneId,
          canvasId,
          tombstoneTitle,
          JSON.stringify(tombstoneContent),
          JSON.stringify(centroid),
          JSON.stringify(DEFAULT_NODE_SIZES.tombstone),
          JSON.stringify({ archivedCount: archivedNodes.length, summarySource }),
          JSON.stringify(vec.vector),
          vec.source,
          archivedAt,
          archivedAt,
        );

      this.touchCanvas(canvasId, archivedAt);
    });

    const tombstone = this.mapNodeRow(this.requireNodeRow(canvasId, tombstoneId), false);
    return {
      tombstone,
      markdown,
      archivedCount: archivedNodes.length,
      removedNodeIds: uniqueIds,
      companyNoteId,
      summarySource,
    };
  }

  async restoreTombstone(canvasId: string, tombstoneId: string): Promise<RestoreTombstoneResult> {
    this.requireCanvasRow(canvasId);
    const row = this.requireNodeRow(canvasId, tombstoneId);
    if (row.type !== "tombstone") {
      throw new ApiError(400, "not_a_tombstone", `节点 ${tombstoneId} 不是结案墓碑节点`);
    }

    const content = parseJsonObject(row.content);
    const archivedNodes = Array.isArray(content.archivedNodes)
      ? (content.archivedNodes as ArchivedNodeSnapshot[])
      : [];
    const archivedEdges = Array.isArray(content.archivedEdges)
      ? (content.archivedEdges as ArchivedEdgeSnapshot[])
      : [];

    if (archivedNodes.length === 0) {
      throw new ApiError(400, "tombstone_empty", "该结案墓碑没有可还原的节点快照");
    }

    const preparedNodes: Array<{
      snapshot: ArchivedNodeSnapshot;
      vector: number[];
      source: "remote" | "local";
    }> = [];
    for (const snap of archivedNodes) {
      const vec = await computeSemanticVector(
        extractNodeSemanticText(snap.title, snap.content ?? {}),
        this.providers.get(),
        this.fetchImpl,
      );
      preparedNodes.push({ snapshot: snap, vector: vec.vector, source: vec.source });
    }

    const now = nowIso();
    const restoredIds: string[] = [];
    const restoredEdgeIds: string[] = [];

    this.runInTransaction(() => {
      // Remove tombstone and any edges attached to it
      this.db
        .prepare("DELETE FROM opc_canvas_edges WHERE canvas_id = ? AND (source_id = ? OR target_id = ?)")
        .run(canvasId, tombstoneId, tombstoneId);
      this.db
        .prepare("DELETE FROM opc_canvas_nodes WHERE canvas_id = ? AND id = ?")
        .run(canvasId, tombstoneId);

      const insertNode = this.db.prepare(
        `INSERT INTO opc_canvas_nodes (
          id, canvas_id, type, status, title, content, position, size, parent_id, metadata,
          embedding, embedding_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const idMap = new Map<string, string>();
      for (const { snapshot, vector, source } of preparedNodes) {
        const collision = this.db
          .prepare("SELECT id FROM opc_canvas_nodes WHERE id = ?")
          .get(snapshot.id) as { id?: string } | undefined;
        const targetId = collision?.id ? `nd_${randomUUID().slice(0, 12)}` : snapshot.id;
        idMap.set(snapshot.id, targetId);

        const type = (NODE_TYPES.includes(snapshot.type) ? snapshot.type : "note") as CanvasNodeType;
        const status = (NODE_STATUSES.includes(snapshot.status) ? snapshot.status : "active") as CanvasNodeStatus;
        insertNode.run(
          targetId,
          canvasId,
          type,
          status,
          snapshot.title,
          JSON.stringify(snapshot.content ?? {}),
          JSON.stringify(snapshot.position ?? { x: 120, y: 120 }),
          JSON.stringify(snapshot.size ?? DEFAULT_NODE_SIZES[type]),
          snapshot.parentId ?? null,
          JSON.stringify(snapshot.metadata ?? {}),
          JSON.stringify(vector),
          source,
          now,
          now,
        );
        restoredIds.push(targetId);
      }

      const existingIds = new Set(
        (
          this.db.prepare("SELECT id FROM opc_canvas_nodes WHERE canvas_id = ?").all(canvasId) as Array<{
            id: string;
          }>
        ).map((r) => r.id),
      );

      const insertEdge = this.db.prepare(
        `INSERT INTO opc_canvas_edges (id, canvas_id, source_id, target_id, type, weight, label, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const edge of archivedEdges) {
        const mappedSource = idMap.get(edge.sourceId) ?? edge.sourceId;
        const mappedTarget = idMap.get(edge.targetId) ?? edge.targetId;
        if (mappedSource === mappedTarget) continue;
        if (!existingIds.has(mappedSource) || !existingIds.has(mappedTarget)) continue;

        const edgeCollision = this.db
          .prepare("SELECT id FROM opc_canvas_edges WHERE id = ?")
          .get(edge.id) as { id?: string } | undefined;
        const edgeId = edgeCollision?.id ? `ed_${randomUUID().slice(0, 12)}` : edge.id;
        const edgeType = (EDGE_TYPES.includes(edge.type) ? edge.type : "derives") as CanvasEdgeType;

        insertEdge.run(
          edgeId,
          canvasId,
          mappedSource,
          mappedTarget,
          edgeType,
          edge.weight ?? 1,
          edge.label ?? "",
          JSON.stringify(edge.metadata ?? {}),
          now,
        );
        restoredEdgeIds.push(edgeId);
      }

      this.touchCanvas(canvasId, now);
    });

    const restoredNodes = restoredIds.map((id) => this.mapNodeRow(this.requireNodeRow(canvasId, id), true));
    const restoredEdges = restoredEdgeIds
      .map((id) =>
        this.db.prepare("SELECT * FROM opc_canvas_edges WHERE id = ? AND canvas_id = ?").get(id, canvasId) as
          | EdgeRow
          | undefined,
      )
      .filter((r): r is EdgeRow => Boolean(r))
      .map((r) => this.mapEdgeRow(r));

    return { tombstoneId, restoredNodes, restoredEdges };
  }

  // ---- 9. Full Canvas Markdown Export ----

  exportMarkdown(canvasId: string): CanvasExportResult {
    const detail = this.getCanvas(canvasId);
    const exportedAt = nowIso();
    const nodeById = new Map(detail.nodes.map((n) => [n.id, n]));

    const lines: string[] = [
      `# ${detail.canvas.name}`,
      "",
      detail.canvas.description ? `> ${detail.canvas.description}` : "> OPC OS 无界知识画布导出文档",
      "",
      `- **画布 ID**：\`${detail.canvas.id}\``,
      `- **节点总数**：${detail.nodes.length}`,
      `- **连线总数**：${detail.edges.length}`,
      `- **导出时间**：${exportedAt}`,
      "",
    ];

    const typeOrder: CanvasNodeType[] = ["note", "ink", "task", "briefing", "portal", "tombstone"];
    for (const type of typeOrder) {
      const group = detail.nodes.filter((n) => n.type === type);
      if (group.length === 0) continue;

      lines.push(`## ${NODE_TYPE_LABELS[type]} (${group.length})`, "");
      for (const node of group) {
        lines.push(`### ${node.title}`);
        lines.push(
          `- **状态**：\`${node.status}\` · **坐标**：(${Math.round(node.position.x)}, ${Math.round(node.position.y)})`,
        );

        if (type === "note") {
          const text = String(node.content.text ?? node.content.markdown ?? "").trim();
          if (Array.isArray(node.content.tags) && node.content.tags.length > 0) {
            lines.push(`- **标签**：${node.content.tags.map((t) => `\`${String(t)}\``).join(" ")}`);
          }
          if (text) lines.push("", text);
        } else if (type === "ink") {
          const strokes = Array.isArray(node.content.strokes) ? node.content.strokes : [];
          lines.push(`- **笔迹数**：${strokes.length} 笔`);
          const recognized = String(node.content.recognizedText ?? node.content.hintText ?? "").trim();
          if (recognized) lines.push("", recognized);
        } else if (type === "task") {
          const taskStatus = node.liveTask?.status ?? String(node.content.taskStatus ?? "draft");
          const priority = node.liveTask?.priority ?? node.content.priority;
          if (node.content.taskId) lines.push(`- **任务 ID**：\`${String(node.content.taskId)}\``);
          lines.push(`- **执行状态**：${taskStatus}${priority != null ? ` · P${String(priority)}` : ""}`);
          if (node.liveTask?.prUrl) lines.push(`- **PR**：${node.liveTask.prUrl}`);
          const desc = String(node.content.description ?? node.content.text ?? "").trim();
          if (desc) lines.push("", desc);
        } else if (type === "briefing") {
          if (node.content.source) lines.push(`- **来源**：${String(node.content.source)}`);
          if (node.content.score != null) lines.push(`- **价值评分**：${String(node.content.score)}`);
          if (Array.isArray(node.content.tags) && node.content.tags.length > 0) {
            lines.push(`- **主题标签**：${node.content.tags.map((t) => `\`${String(t)}\``).join(" ")}`);
          }
          const summary = String(node.content.summary ?? "").trim();
          if (summary) lines.push("", summary);
        } else if (type === "portal") {
          lines.push(
            `- **目标画布**：${String(node.content.targetCanvasName ?? node.content.targetCanvasId ?? "未指定")}${
              node.content.bidirectional ? "（双向任意门）" : ""
            }`,
          );
        } else if (type === "tombstone") {
          lines.push(`- **已收束节点**：${String(node.content.archivedCount ?? 0)} 项`);
          const md = String(node.content.markdown ?? "").trim();
          if (md) lines.push("", md);
        }

        lines.push("");
      }
    }

    lines.push(`## 知识关系图谱 (${detail.edges.length})`, "");
    if (detail.edges.length === 0) {
      lines.push("（当前画布暂无连线）", "");
    } else {
      for (const edge of detail.edges) {
        const src = nodeById.get(edge.sourceId)?.title ?? edge.sourceId;
        const dst = nodeById.get(edge.targetId)?.title ?? edge.targetId;
        const eLabel = EDGE_TYPE_LABELS[edge.type] ?? edge.type;
        const extra = edge.label ? ` · ${edge.label}` : "";
        lines.push(`- **${src}** —[${eLabel}${extra} | w=${edge.weight}]→ **${dst}**`);
      }
      lines.push("");
    }

    return {
      canvasId: detail.canvas.id,
      canvasName: detail.canvas.name,
      filename: slugifyFilename(detail.canvas.name),
      markdown: lines.join("\n"),
      nodeCount: detail.nodes.length,
      edgeCount: detail.edges.length,
      exportedAt,
    };
  }

  // ---- 10. External Module Integration: Briefing Island Projection ----

  async projectBriefingIsland(
    canvasId: string,
    items: BriefingIslandItem[],
    options: { linkThreshold?: number } = {},
  ): Promise<BriefingIslandResult> {
    this.requireCanvasRow(canvasId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new ApiError(400, "briefing_island_empty", "投射每日简报岛至少需要 1 条简报条目");
    }

    const linkThreshold = Math.max(0.05, Math.min(1, options.linkThreshold ?? 0.35));

    // Snapshot pre-existing non-archived nodes for cross-linking
    const existingRows = this.db
      .prepare(
        `SELECT * FROM opc_canvas_nodes
         WHERE canvas_id = ? AND status != 'archived' AND type != 'tombstone'`,
      )
      .all(canvasId) as unknown as NodeRow[];

    const existingWithVectors: Array<{ id: string; vector: number[] }> = [];
    for (const row of existingRows) {
      let vec = parseEmbedding(row.embedding);
      if (!vec) {
        const content = parseJsonObject(row.content);
        const computed = await computeSemanticVector(
          extractNodeSemanticText(row.title, content),
          this.providers.get(),
          this.fetchImpl,
        );
        vec = computed.vector;
      }
      existingWithVectors.push({ id: row.id, vector: vec });
    }

    const origin = this.findBlankOrigin(canvasId);
    const colPitch = 340;
    const rowPitch = 230;
    const cols = items.length <= 2 ? items.length : 2;
    const now = nowIso();

    const prepared: Array<{
      id: string;
      title: string;
      content: Record<string, unknown>;
      position: CanvasPoint;
      size: CanvasSize;
      vector: number[];
      source: "remote" | "local";
    }> = [];

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const firstLine = item.summary.replace(/\s+/g, " ").trim();
      const shortHeadline = firstLine.length > 36 ? firstLine.slice(0, 36) + "…" : firstLine;
      const title = `[${item.source}] ${shortHeadline}`;
      const content: Record<string, unknown> = {
        briefingId: item.id,
        source: item.source,
        summary: item.summary,
        tags: item.tags ?? [],
        score: item.score ?? null,
      };
      const position: CanvasPoint = {
        x: origin.x + (idx % cols) * colPitch,
        y: origin.y + Math.floor(idx / cols) * rowPitch,
      };
      const vec = await computeSemanticVector(
        extractNodeSemanticText(title, content),
        this.providers.get(),
        this.fetchImpl,
      );
      prepared.push({
        id: `nd_${randomUUID().slice(0, 12)}`,
        title,
        content,
        position,
        size: { ...DEFAULT_NODE_SIZES.briefing },
        vector: vec.vector,
        source: vec.source,
      });
    }

    const semanticEdges: CanvasEdge[] = [];

    this.runInTransaction(() => {
      const insertNode = this.db.prepare(
        `INSERT INTO opc_canvas_nodes (
          id, canvas_id, type, status, title, content, position, size, parent_id, metadata,
          embedding, embedding_source, created_at, updated_at
        ) VALUES (?, ?, 'briefing', 'active', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      );
      const insertEdge = this.db.prepare(
        `INSERT INTO opc_canvas_edges (id, canvas_id, source_id, target_id, type, weight, label, metadata, created_at)
         VALUES (?, ?, ?, ?, 'semantic_link', ?, ?, ?, ?)`,
      );

      for (const item of prepared) {
        insertNode.run(
          item.id,
          canvasId,
          item.title,
          JSON.stringify(item.content),
          JSON.stringify(item.position),
          JSON.stringify(item.size),
          JSON.stringify({ briefingIsland: true }),
          JSON.stringify(item.vector),
          item.source,
          now,
          now,
        );

        for (const existing of existingWithVectors) {
          if (existing.vector.length !== item.vector.length) continue;
          const sim = cosineSimilarity(item.vector, existing.vector);
          if (sim >= linkThreshold) {
            const edgeId = `ed_${randomUUID().slice(0, 12)}`;
            const weight = round(sim, 3);
            const label = `sim=${sim.toFixed(2)}`;
            const metadata = { briefingAutoLink: true, similarity: round(sim, 4) };
            insertEdge.run(edgeId, canvasId, item.id, existing.id, weight, label, JSON.stringify(metadata), now);
            semanticEdges.push({
              id: edgeId,
              canvasId,
              sourceId: item.id,
              targetId: existing.id,
              type: "semantic_link",
              weight,
              label,
              metadata,
              createdAt: now,
            });
          }
        }
      }

      this.touchCanvas(canvasId, now);
    });

    const createdNodes = prepared.map((p) => this.mapNodeRow(this.requireNodeRow(canvasId, p.id), false));
    return { nodes: createdNodes, semanticEdges };
  }
}

async function readOptionalJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

export interface RegisterKnowledgeCanvasOptions {
  submitToken?: string;
  hooks?: KnowledgeCanvasHooks;
  fetchImpl?: typeof fetch;
}

export function registerKnowledgeCanvasRoutes(
  app: Hono,
  db: DatabaseSync,
  providers: ProvidersStore,
  user: (c: Context) => unknown,
  options: RegisterKnowledgeCanvasOptions = {},
): KnowledgeCanvasStore {
  const store = new KnowledgeCanvasStore(db, providers, {
    hooks: options.hooks,
    fetchImpl: options.fetchImpl,
  });
  const { permits } = submitAuth(options.submitToken);
  const base = "/api/opc/canvases";

  app.use(base, async (c, next) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(base + "/*", async (c, next) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/api/opc/canvases", (c) => {
    const includeArchived =
      c.req.query("includeArchived") === "1" || c.req.query("includeArchived") === "true";
    return c.json({ canvases: store.listCanvases(includeArchived) });
  });

  app.post("/api/opc/canvases", async (c) => c.json(store.createCanvas(await c.req.json()), 201));

  // Register static /ocr route before parameterized /:id routes
  app.post("/api/opc/canvases/ocr", async (c) => c.json(await store.ocrRecognize(await c.req.json())));

  app.get("/api/opc/canvases/:id", (c) => c.json(store.getCanvas(c.req.param("id"))));

  app.patch("/api/opc/canvases/:id", async (c) =>
    c.json(store.updateCanvas(c.req.param("id"), await c.req.json())),
  );

  app.delete("/api/opc/canvases/:id", (c) => c.json(store.deleteCanvas(c.req.param("id"))));

  app.post("/api/opc/canvases/:id/nodes", async (c) =>
    c.json(await store.createNode(c.req.param("id"), await c.req.json()), 201),
  );

  app.patch("/api/opc/canvases/:id/nodes/:nodeId", async (c) =>
    c.json(await store.updateNode(c.req.param("id"), c.req.param("nodeId"), await c.req.json())),
  );

  app.delete("/api/opc/canvases/:id/nodes/:nodeId", (c) =>
    c.json(store.deleteNode(c.req.param("id"), c.req.param("nodeId"))),
  );

  app.post("/api/opc/canvases/:id/nodes/:nodeId/promote-task", async (c) =>
    c.json(
      await store.promoteNodeToTask(
        c.req.param("id"),
        c.req.param("nodeId"),
        await readOptionalJson(c),
      ),
    ),
  );

  app.post("/api/opc/canvases/:id/expand-space", async (c) =>
    c.json(store.expandSpace(c.req.param("id"), await c.req.json())),
  );

  app.post("/api/opc/canvases/:id/edges", async (c) =>
    c.json(store.createEdge(c.req.param("id"), await c.req.json()), 201),
  );

  app.delete("/api/opc/canvases/:id/edges/:edgeId", (c) =>
    c.json(store.deleteEdge(c.req.param("id"), c.req.param("edgeId"))),
  );

  app.post("/api/opc/canvases/:id/semantic-search", async (c) => {
    const body = await c.req.json();
    const parsed = semanticSearchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "semantic_search_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }
    return c.json(
      await store.semanticSearch(c.req.param("id"), parsed.data.query, {
        topK: parsed.data.topK,
        threshold: parsed.data.threshold,
        includeAllCanvases: parsed.data.includeAllCanvases,
      }),
    );
  });

  app.post("/api/opc/canvases/:id/auto-link", async (c) => {
    const body = await readOptionalJson(c);
    const parsed = autoLinkSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "auto_link_input",
        parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join(" / "),
      );
    }
    return c.json(await store.autoLinkBySemantics(c.req.param("id"), parsed.data.threshold));
  });

  app.post("/api/opc/canvases/:id/archive-tombstone", async (c) =>
    c.json(await store.archiveNodesToTombstone(c.req.param("id"), await c.req.json()), 201),
  );

  app.post("/api/opc/canvases/:id/tombstones/:nodeId/restore", async (c) =>
    c.json(await store.restoreTombstone(c.req.param("id"), c.req.param("nodeId"))),
  );

  app.get("/api/opc/canvases/:id/export", (c) => {
    const result = store.exportMarkdown(c.req.param("id"));
    if (c.req.query("format") === "raw" || c.req.query("download") === "1") {
      c.header("Content-Type", "text/markdown; charset=utf-8");
      c.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      );
      return c.body(result.markdown);
    }
    return c.json(result);
  });

  return store;
}
