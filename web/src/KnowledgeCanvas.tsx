import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  ArchiveTombstoneResult,
  AutoLinkResult,
  CanvasDetail,
  CanvasEdge,
  CanvasEdgeType,
  CanvasExportResult,
  CanvasNode,
  CanvasNodeStatus,
  CanvasNodeType,
  CanvasPoint,
  CanvasSummary,
  CanvasViewport,
  ExpandSpaceResult,
  InkStroke,
  OcrRecognizeResult,
  RestoreTombstoneResult,
  SemanticSearchResult,
  SemanticSearchResultItem,
} from "../../src/knowledge-canvas-types";
import { request } from "./api";
import "./knowledge-canvas.css";

type CanvasToolMode = "select" | "ink" | "expand" | "connect";
type SidebarTab = "compass" | "inspector" | "outline";

interface PortalBreadcrumb {
  canvasId: string;
  canvasName: string;
}

interface ExpandDragState {
  axis: "x" | "y";
  originWorld: number;
  currentWorld: number;
}

const NODE_TYPE_META: Record<CanvasNodeType, { label: string; icon: string }> = {
  note: { label: "笔记", icon: "✎" },
  ink: { label: "墨迹", icon: "✒" },
  task: { label: "任务", icon: "☑" },
  portal: { label: "任意门", icon: "⬡" },
  briefing: { label: "简报岛", icon: "◈" },
  tombstone: { label: "墓碑", icon: "🪦" },
};

const EDGE_TYPE_META: Record<CanvasEdgeType, { label: string; color: string }> = {
  derives: { label: "推导派生", color: "#3c5446" },
  blocks: { label: "前置阻塞", color: "#9c3822" },
  portal: { label: "时空传送", color: "#4d3f8c" },
  semantic_link: { label: "语义共振", color: "#b9751d" },
  deploy_to: { label: "交付部署", color: "#246874" },
};

const INK_COLORS = [
  { name: "深墨", value: "#232d27" },
  { name: "赭石", value: "#8d3b24" },
  { name: "松绿", value: "#2f513e" },
  { name: "靛青", value: "#384b7a" },
];

const API_BASE = "/api/opc/canvases";

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function parseHashCanvasParams(): { canvasId: string; nodeId: string } {
  const rawQuery = location.hash.split("?")[1] ?? "";
  const params = new URLSearchParams(rawQuery);
  return {
    canvasId: params.get("id") ?? "",
    nodeId: params.get("node") ?? "",
  };
}

function strokeToSvgPath(stroke: InkStroke): string {
  if (!stroke.points.length) return "";
  if (stroke.points.length === 1) {
    const p = stroke.points[0];
    return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + 0.5).toFixed(1)} ${(p.y + 0.5).toFixed(1)}`;
  }
  const cmds = [`M ${stroke.points[0].x.toFixed(1)} ${stroke.points[0].y.toFixed(1)}`];
  for (let i = 1; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    cmds.push(`L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  return cmds.join(" ");
}

function computeBezier(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): { d: string; midX: number; midY: number } {
  const sx = source.x + source.width / 2;
  const sy = source.y + source.height / 2;
  const tx = target.x + target.width / 2;
  const ty = target.y + target.height / 2;
  const dx = tx - sx;
  const dy = ty - sy;

  let x1 = sx;
  let y1 = sy;
  let x2 = tx;
  let y2 = ty;
  let cx1 = sx;
  let cy1 = sy;
  let cx2 = tx;
  let cy2 = ty;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    x1 = sx + (dir * source.width) / 2;
    x2 = tx - (dir * target.width) / 2;
    const pull = Math.max(48, Math.min(220, Math.abs(x2 - x1) * 0.45));
    cx1 = x1 + dir * pull;
    cy1 = y1;
    cx2 = x2 - dir * pull;
    cy2 = y2;
  } else {
    const dir = dy >= 0 ? 1 : -1;
    y1 = sy + (dir * source.height) / 2;
    y2 = ty - (dir * target.height) / 2;
    const pull = Math.max(48, Math.min(220, Math.abs(y2 - y1) * 0.45));
    cx1 = x1;
    cy1 = y1 + dir * pull;
    cx2 = x2;
    cy2 = y2 - dir * pull;
  }

  // Cubic Bezier midpoint at t = 0.5
  const midX = 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2;
  const midY = 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2;
  return {
    d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
    midX,
    midY,
  };
}

function InkNodePad({
  node,
  busy,
  onSaveStrokes,
  onRunOcr,
}: {
  node: CanvasNode;
  busy: boolean;
  onSaveStrokes: (node: CanvasNode, strokes: InkStroke[], hintText: string) => Promise<void>;
  onRunOcr: (node: CanvasNode, strokes: InkStroke[], hintText: string) => Promise<void>;
}) {
  const initialStrokes = useMemo(
    () => (Array.isArray(node.content.strokes) ? (node.content.strokes as InkStroke[]) : []),
    [node.content.strokes],
  );
  const [strokes, setStrokes] = useState<InkStroke[]>(initialStrokes);
  const [activeStroke, setActiveStroke] = useState<InkStroke | null>(null);
  const [inkColor, setInkColor] = useState("#232d27");
  const [inkWidth, setInkWidth] = useState(2.6);
  const [hintText, setHintText] = useState(String(node.content.hintText ?? ""));
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drawingRef = useRef<InkStroke | null>(null);

  useEffect(() => {
    setStrokes(initialStrokes);
  }, [initialStrokes]);

  useEffect(() => {
    setHintText(String(node.content.hintText ?? ""));
  }, [node.content.hintText]);

  const toLocalPoint = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0, pressure: 0.5, t: Date.now() };
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width > 0 ? 320 / rect.width : 1;
    const scaleY = rect.height > 0 ? 150 / rect.height : 1;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX * 10) / 10,
      y: Math.round((e.clientY - rect.top) * scaleY * 10) / 10,
      pressure: e.pressure && e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5,
      t: Date.now(),
    };
  };

  const handlePointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toLocalPoint(e);
    const next: InkStroke = { color: inkColor, width: inkWidth, points: [pt] };
    drawingRef.current = next;
    setActiveStroke(next);
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawingRef.current) return;
    e.stopPropagation();
    const pt = toLocalPoint(e);
    const updated: InkStroke = {
      ...drawingRef.current,
      points: [...drawingRef.current.points, pt],
    };
    drawingRef.current = updated;
    setActiveStroke(updated);
  };

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawingRef.current) return;
    e.stopPropagation();
    const finished = drawingRef.current;
    drawingRef.current = null;
    setActiveStroke(null);
    const nextStrokes = [...strokes, finished];
    setStrokes(nextStrokes);
    void onSaveStrokes(node, nextStrokes, hintText);
  };

  const handleUndo = () => {
    if (!strokes.length) return;
    const nextStrokes = strokes.slice(0, -1);
    setStrokes(nextStrokes);
    void onSaveStrokes(node, nextStrokes, hintText);
  };

  const handleClear = () => {
    setStrokes([]);
    void onSaveStrokes(node, [], hintText);
  };

  const recognizedText = String(node.content.recognizedText ?? "").trim();

  return (
    <div className="kc-ink-pad-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <svg
        ref={svgRef}
        className="kc-ink-pad"
        viewBox="0 0 320 150"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-label={`手写画板：${node.title}`}
      >
        {strokes.map((st, idx) => (
          <path
            key={idx}
            d={strokeToSvgPath(st)}
            fill="none"
            stroke={st.color || "#232d27"}
            strokeWidth={st.width || 2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {activeStroke && (
          <path
            d={strokeToSvgPath(activeStroke)}
            fill="none"
            stroke={activeStroke.color || "#232d27"}
            strokeWidth={activeStroke.width || 2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>

      <div className="kc-ink-tools">
        {INK_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            className="kc-ink-swatch"
            style={{ background: c.value }}
            data-current={inkColor === c.value ? "true" : "false"}
            title={c.name}
            aria-label={`墨色 ${c.name}`}
            onClick={() => setInkColor(c.value)}
          />
        ))}
        <button
          type="button"
          className="kc-ghost"
          onClick={() => setInkWidth((w) => (w >= 4 ? 1.8 : Math.round((w + 1.1) * 10) / 10))}
          title="切换笔锋粗细"
        >
          笔粗 {inkWidth.toFixed(1)}
        </button>
        <button type="button" disabled={busy || strokes.length === 0} onClick={handleUndo}>
          撤销一笔
        </button>
        <button type="button" disabled={busy || strokes.length === 0} onClick={handleClear}>
          清空
        </button>
      </div>

      <div className="kc-ink-tools">
        <input
          type="text"
          value={hintText}
          onChange={(e) => setHintText(e.target.value)}
          onBlur={() => void onSaveStrokes(node, strokes, hintText)}
          placeholder="可选：笔迹注记/提示词"
          style={{ flex: 1, minWidth: 90, fontSize: 11.5, padding: "4px 6px" }}
        />
        <button
          type="button"
          className="kc-primary"
          disabled={busy || (strokes.length === 0 && !hintText.trim())}
          onClick={() => void onRunOcr(node, strokes, hintText)}
        >
          OCR 转文字笔记
        </button>
      </div>

      {recognizedText && (
        <div className="kc-ocr-preview" title="最近一次 OCR 识别结果">
          {recognizedText}
        </div>
      )}
    </div>
  );
}

export function KnowledgeCanvas({
  nav,
  initialCanvasId,
}: {
  nav?: ReactNode;
  initialCanvasId?: string;
}) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [activeDetail, setActiveDetail] = useState<CanvasDetail | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  const [portalHistory, setPortalHistory] = useState<PortalBreadcrumb[]>([]);

  const [mode, setMode] = useState<CanvasToolMode>("select");
  const [expandAxis, setExpandAxis] = useState<"x" | "y">("x");
  const [connectEdgeType, setConnectEdgeType] = useState<CanvasEdgeType>("derives");
  const [connectSourceId, setConnectSourceId] = useState<string | null>(null);
  const [connectCursorWorld, setConnectCursorWorld] = useState<CanvasPoint | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("compass");
  const [compassQuery, setCompassQuery] = useState("");
  const [compassAllCanvases, setCompassAllCanvases] = useState(true);
  const [compassResults, setCompassResults] = useState<SemanticSearchResultItem[]>([]);
  const [compassSource, setCompassSource] = useState<"remote" | "local" | null>(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Interactive gesture states
  const [isPanning, setIsPanning] = useState(false);
  const [expandHoverWorld, setExpandHoverWorld] = useState<CanvasPoint | null>(null);
  const [expandDrag, setExpandDrag] = useState<ExpandDragState | null>(null);

  // Modals
  const [portalModalOpen, setPortalModalOpen] = useState(false);
  const [portalTargetId, setPortalTargetId] = useState("");
  const [portalTitle, setPortalTitle] = useState("");
  const [portalBidirectional, setPortalBidirectional] = useState(true);
  const [tombstoneModalNode, setTombstoneModalNode] = useState<CanvasNode | null>(null);
  const [exportModal, setExportModal] = useState<CanvasExportResult | null>(null);

  // Create canvas form
  const [newCanvasName, setNewCanvasName] = useState("");
  const [newCanvasDesc, setNewCanvasDesc] = useState("");

  // Inspector form local draft
  const [inspTitle, setInspTitle] = useState("");
  const [inspStatus, setInspStatus] = useState<CanvasNodeStatus>("active");
  const [inspBody, setInspBody] = useState("");
  const [inspTags, setInspTags] = useState("");
  const [inspX, setInspX] = useState("0");
  const [inspY, setInspY] = useState("0");
  const [inspW, setInspW] = useState("280");
  const [inspH, setInspH] = useState("180");

  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<CanvasViewport>(viewport);
  viewportRef.current = viewport;

  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panRef = useRef<{ startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);
  const dragNodeRef = useRef<{
    nodeId: string;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const loadCanvases = useCallback(async (archived = includeArchived) => {
    try {
      const res = await request<{ canvases: CanvasSummary[] }>(
        `${API_BASE}?includeArchived=${archived ? "1" : "0"}`,
      );
      setCanvases(res.canvases);
      setError("");
    } catch (err) {
      setError(describeError(err, "加载画布列表失败"));
    }
  }, [includeArchived]);

  const scheduleViewportSave = useCallback((canvasId: string, nextViewport: CanvasViewport) => {
    if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
    viewportSaveTimer.current = setTimeout(() => {
      void request<CanvasSummary>(`${API_BASE}/${encodeURIComponent(canvasId)}`, {
        method: "PATCH",
        body: JSON.stringify({ viewport: nextViewport }),
      }).catch(() => {
        // Silent debounce persistence error
      });
    }, 350);
  }, []);

  const focusNode = useCallback(
    (node: CanvasNode, canvasIdForSave?: string) => {
      const stage = stageRef.current;
      const stageW = stage?.clientWidth ?? 900;
      const stageH = stage?.clientHeight ?? 620;
      const zoom = Math.max(0.7, Math.min(1.4, viewportRef.current.zoom || 1));
      const cx = node.position.x + node.size.width / 2;
      const cy = node.position.y + node.size.height / 2;
      const nextVp: CanvasViewport = {
        x: Math.round(stageW / 2 - cx * zoom),
        y: Math.round(stageH / 2 - cy * zoom),
        zoom,
      };
      setViewport(nextVp);
      setSelectedIds(new Set([node.id]));
      setHighlightedNodeId(node.id);
      setTimeout(() => setHighlightedNodeId((cur) => (cur === node.id ? null : cur)), 2200);
      if (canvasIdForSave) scheduleViewportSave(canvasIdForSave, nextVp);
    },
    [scheduleViewportSave],
  );

  const openCanvas = useCallback(
    async (
      canvasId: string,
      options: { pushBreadcrumb?: PortalBreadcrumb; focusNodeId?: string } = {},
    ) => {
      setBusy(true);
      setError("");
      try {
        const detail = await request<CanvasDetail>(`${API_BASE}/${encodeURIComponent(canvasId)}`);
        if (options.pushBreadcrumb) {
          setPortalHistory((prev) => [...prev, options.pushBreadcrumb!]);
        }
        setActiveDetail(detail);
        setViewport(detail.canvas.viewport);
        setSelectedIds(new Set());
        setConnectSourceId(null);
        setExpandDrag(null);
        setCompassResults([]);

        if (options.focusNodeId) {
          const target = detail.nodes.find((n) => n.id === options.focusNodeId);
          if (target) {
            requestAnimationFrame(() => focusNode(target, detail.canvas.id));
          }
        }
      } catch (err) {
        setError(describeError(err, "打开画布失败"));
      } finally {
        setBusy(false);
      }
    },
    [focusNode],
  );

  useEffect(() => {
    void loadCanvases(includeArchived);
  }, [loadCanvases, includeArchived]);

  useEffect(() => {
    const hashParams = parseHashCanvasParams();
    const targetId = initialCanvasId || hashParams.canvasId;
    if (targetId) {
      void openCanvas(targetId, { focusNodeId: hashParams.nodeId || undefined });
    }
  }, [initialCanvasId, openCanvas]);

  useEffect(() => {
    return () => {
      if (viewportSaveTimer.current) clearTimeout(viewportSaveTimer.current);
    };
  }, []);

  const primarySelectedNode = useMemo(() => {
    if (!activeDetail || selectedIds.size === 0) return null;
    const firstId = Array.from(selectedIds)[selectedIds.size - 1];
    return activeDetail.nodes.find((n) => n.id === firstId) ?? null;
  }, [activeDetail, selectedIds]);

  useEffect(() => {
    if (!primarySelectedNode) return;
    setInspTitle(primarySelectedNode.title);
    setInspStatus(primarySelectedNode.status);
    const c = primarySelectedNode.content;
    setInspBody(
      String(
        c.text ?? c.description ?? c.summary ?? c.recognizedText ?? c.hintText ?? c.note ?? "",
      ),
    );
    setInspTags(Array.isArray(c.tags) ? c.tags.map(String).join(", ") : "");
    setInspX(String(Math.round(primarySelectedNode.position.x)));
    setInspY(String(Math.round(primarySelectedNode.position.y)));
    setInspW(String(Math.round(primarySelectedNode.size.width)));
    setInspH(String(Math.round(primarySelectedNode.size.height)));
  }, [primarySelectedNode]);

  const refreshActiveCanvas = useCallback(async () => {
    if (!activeDetail) return;
    const detail = await request<CanvasDetail>(`${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}`);
    setActiveDetail(detail);
    void loadCanvases(includeArchived);
  }, [activeDetail, includeArchived, loadCanvases]);

  // ---- Canvas List Actions ----

  const handleCreateCanvas = async (e: FormEvent) => {
    e.preventDefault();
    const name = newCanvasName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const created = await request<CanvasSummary>(API_BASE, {
        method: "POST",
        body: JSON.stringify({ name, description: newCanvasDesc.trim() }),
      });
      setNewCanvasName("");
      setNewCanvasDesc("");
      await loadCanvases(includeArchived);
      await openCanvas(created.id);
      setNotice(`已创建画布「${created.name}」`);
    } catch (err) {
      setError(describeError(err, "创建画布失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleArchiveCanvas = async (canvas: CanvasSummary) => {
    setBusy(true);
    try {
      await request<CanvasSummary>(`${API_BASE}/${encodeURIComponent(canvas.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ isArchived: !canvas.isArchived }),
      });
      await loadCanvases(includeArchived);
      setNotice(canvas.isArchived ? `已恢复画布「${canvas.name}」` : `已归档画布「${canvas.name}」`);
    } catch (err) {
      setError(describeError(err, "更新画布归档状态失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCanvas = async (canvas: CanvasSummary) => {
    if (!window.confirm(`确定永久删除画布「${canvas.name}」及其所有节点与连线？`)) return;
    setBusy(true);
    try {
      await request<{ deleted: boolean }>(`${API_BASE}/${encodeURIComponent(canvas.id)}`, {
        method: "DELETE",
      });
      if (activeDetail?.canvas.id === canvas.id) {
        setActiveDetail(null);
        setPortalHistory([]);
      }
      await loadCanvases(includeArchived);
      setNotice(`已删除画布「${canvas.name}」`);
    } catch (err) {
      setError(describeError(err, "删除画布失败"));
    } finally {
      setBusy(false);
    }
  };

  // ---- Node & Edge Actions ----

  const computeNewNodePosition = useCallback((): CanvasPoint => {
    const stage = stageRef.current;
    const w = stage?.clientWidth ?? 900;
    const h = stage?.clientHeight ?? 600;
    const vp = viewportRef.current;
    const jitter = ((activeDetail?.nodes.length ?? 0) % 5) * 28;
    return {
      x: Math.round((w * 0.42 - vp.x) / vp.zoom + jitter),
      y: Math.round((h * 0.35 - vp.y) / vp.zoom + jitter),
    };
  }, [activeDetail?.nodes.length]);

  const handleQuickAddNode = async (type: CanvasNodeType, customPosition?: CanvasPoint) => {
    if (!activeDetail) return;
    if (type === "portal") {
      const others = canvases.filter((c) => c.id !== activeDetail.canvas.id && !c.isArchived);
      setPortalTargetId(others[0]?.id ?? "");
      setPortalTitle(others[0] ? `穿越 → ${others[0].name}` : "时空任意门");
      setPortalBidirectional(true);
      setPortalModalOpen(true);
      return;
    }

    setBusy(true);
    setError("");
    const pos = customPosition ?? computeNewNodePosition();
    const defaults: Record<Exclude<CanvasNodeType, "portal">, { title: string; content: Record<string, unknown> }> = {
      note: {
        title: `新笔记 #${activeDetail.nodes.length + 1}`,
        content: { text: "点击右侧「属性编辑」写入思考内容，或使用语义自动连线发现潜在共振。", tags: [] },
      },
      ink: {
        title: `手写墨迹 #${activeDetail.nodes.length + 1}`,
        content: { strokes: [], hintText: "" },
      },
      task: {
        title: `待执行任务 #${activeDetail.nodes.length + 1}`,
        content: { description: "可直接升级为 OPC OS 真实任务并同步状态", taskStatus: "draft", priority: 2 },
      },
      briefing: {
        title: `简报卡片 #${activeDetail.nodes.length + 1}`,
        content: { source: "手动摘录", summary: "记录高价值行业情报", tags: ["briefing"] },
      },
      tombstone: {
        title: "结案墓碑",
        content: { markdown: "# 结案归档", archivedCount: 0, archivedNodes: [] },
      },
    };

    try {
      const created = await request<CanvasNode>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes`,
        {
          method: "POST",
          body: JSON.stringify({
            type,
            title: defaults[type].title,
            content: defaults[type].content,
            position: pos,
          }),
        },
      );
      setActiveDetail((prev) =>
        prev
          ? {
              ...prev,
              canvas: { ...prev.canvas, nodeCount: prev.nodes.length + 1 },
              nodes: [...prev.nodes, created],
            }
          : prev,
      );
      setSelectedIds(new Set([created.id]));
      setNotice(`已添加${NODE_TYPE_META[type].label}「${created.title}」`);
    } catch (err) {
      setError(describeError(err, "创建节点失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePortal = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeDetail || !portalTargetId) return;
    setBusy(true);
    setError("");
    try {
      const created = await request<CanvasNode>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "portal",
            title: portalTitle.trim() || "时空任意门",
            targetCanvasId: portalTargetId,
            bidirectional: portalBidirectional,
            position: computeNewNodePosition(),
          }),
        },
      );
      setPortalModalOpen(false);
      setActiveDetail((prev) =>
        prev
          ? {
              ...prev,
              canvas: { ...prev.canvas, nodeCount: prev.nodes.length + 1 },
              nodes: [...prev.nodes, created],
            }
          : prev,
      );
      setSelectedIds(new Set([created.id]));
      void loadCanvases(includeArchived);
      setNotice(
        portalBidirectional
          ? `已建立双向时空任意门「${created.title}」（目标画布已同步生成返回门）`
          : `已建立时空任意门「${created.title}」`,
      );
    } catch (err) {
      setError(describeError(err, "创建时空任意门失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleWarpPortal = (node: CanvasNode) => {
    if (!activeDetail) return;
    const targetId = typeof node.content.targetCanvasId === "string" ? node.content.targetCanvasId : "";
    if (!targetId) {
      setError("该任意门未绑定目标画布");
      return;
    }
    const reciprocalId =
      typeof node.content.reciprocalNodeId === "string" ? node.content.reciprocalNodeId : undefined;
    void openCanvas(targetId, {
      pushBreadcrumb: { canvasId: activeDetail.canvas.id, canvasName: activeDetail.canvas.name },
      focusNodeId: reciprocalId,
    });
  };

  const handleBreadcrumbReturn = () => {
    if (!portalHistory.length) return;
    const prev = portalHistory[portalHistory.length - 1];
    setPortalHistory((list) => list.slice(0, -1));
    void openCanvas(prev.canvasId);
  };

  const handleSaveInkStrokes = async (node: CanvasNode, strokes: InkStroke[], hintText: string) => {
    if (!activeDetail) return;
    try {
      const updated = await request<CanvasNode>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes/${encodeURIComponent(node.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ content: { strokes, hintText } }),
        },
      );
      setActiveDetail((prev) =>
        prev ? { ...prev, nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)) } : prev,
      );
    } catch (err) {
      setError(describeError(err, "保存手写笔迹失败"));
    }
  };

  const handleRunInkOcr = async (node: CanvasNode, strokes: InkStroke[], hintText: string) => {
    if (!activeDetail) return;
    setBusy(true);
    setError("");
    try {
      const ocr = await request<OcrRecognizeResult>(`${API_BASE}/ocr`, {
        method: "POST",
        body: JSON.stringify({ strokes, hintText: hintText.trim() || undefined }),
      });

      const updatedInk = await request<CanvasNode>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes/${encodeURIComponent(node.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            content: { strokes, hintText, recognizedText: ocr.text, ocrMode: ocr.mode },
          }),
        },
      );

      const derivedNote = await request<CanvasNode>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "note",
            title: `OCR：${node.title}`,
            content: {
              text: ocr.text,
              tags: ["ocr", ocr.mode === "remote_ocr" ? "remote" : "local-ink"],
              sourceInkNodeId: node.id,
            },
            position: { x: Math.round(node.position.x + node.size.width + 64), y: Math.round(node.position.y) },
          }),
        },
      );

      const edge = await request<CanvasEdge>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/edges`,
        {
          method: "POST",
          body: JSON.stringify({
            sourceId: node.id,
            targetId: derivedNote.id,
            type: "derives",
            label: ocr.mode === "remote_ocr" ? "OCR 识别" : "笔迹分析",
          }),
        },
      );

      setActiveDetail((prev) =>
        prev
          ? {
              ...prev,
              canvas: {
                ...prev.canvas,
                nodeCount: prev.nodes.length + 1,
                edgeCount: prev.edges.length + 1,
              },
              nodes: [...prev.nodes.map((n) => (n.id === updatedInk.id ? updatedInk : n)), derivedNote],
              edges: [...prev.edges, edge],
            }
          : prev,
      );
      setSelectedIds(new Set([derivedNote.id]));
      setNotice(
        `OCR 识别完成（${ocr.mode === "remote_ocr" ? "远端 OCR" : "本地笔迹分析"} · 置信度 ${Math.round(ocr.confidence * 100)}%），已生成文字笔记`,
      );
    } catch (err) {
      setError(describeError(err, "OCR 识别失败"));
    } finally {
      setBusy(false);
    }
  };

  const handlePromoteToTask = async (node: CanvasNode) => {
    if (!activeDetail) return;
    setBusy(true);
    setError("");
    try {
      const updated = await request<CanvasNode>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes/${encodeURIComponent(node.id)}/promote-task`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setActiveDetail((prev) =>
        prev ? { ...prev, nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)) } : prev,
      );
      setNotice(`已升级为真实任务：${String(updated.content.taskId ?? updated.title)}`);
    } catch (err) {
      setError(describeError(err, "升级为真实任务失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteNode = async (nodeId: string) => {
    if (!activeDetail) return;
    setBusy(true);
    setError("");
    try {
      await request<{ deleted: boolean }>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes/${encodeURIComponent(nodeId)}`,
        { method: "DELETE" },
      );
      setActiveDetail((prev) =>
        prev
          ? {
              ...prev,
              nodes: prev.nodes.filter((n) => n.id !== nodeId),
              edges: prev.edges.filter((e) => e.sourceId !== nodeId && e.targetId !== nodeId),
            }
          : prev,
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
      setNotice("已删除节点及关联连线");
    } catch (err) {
      setError(describeError(err, "删除节点失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEdge = async (edgeId: string) => {
    if (!activeDetail) return;
    setBusy(true);
    setError("");
    try {
      await request<{ deleted: boolean }>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/edges/${encodeURIComponent(edgeId)}`,
        { method: "DELETE" },
      );
      setActiveDetail((prev) =>
        prev ? { ...prev, edges: prev.edges.filter((e) => e.id !== edgeId) } : prev,
      );
      setNotice("已移除连线");
    } catch (err) {
      setError(describeError(err, "删除连线失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleAutoLink = async () => {
    if (!activeDetail) return;
    setBusy(true);
    setError("");
    try {
      const res = await request<AutoLinkResult>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/auto-link`,
        { method: "POST", body: JSON.stringify({ threshold: 0.55 }) },
      );
      if (res.created > 0) {
        setActiveDetail((prev) =>
          prev
            ? {
                ...prev,
                canvas: { ...prev.canvas, edgeCount: prev.edges.length + res.edges.length },
                edges: [...prev.edges, ...res.edges],
              }
            : prev,
        );
        setNotice(`语义共振完成：新增 ${res.created} 条高相似度语义连线 (threshold ≥ ${res.threshold})`);
      } else {
        setNotice("语义扫描完成：暂无超过阈值的新共振节点对");
      }
    } catch (err) {
      setError(describeError(err, "语义自动连线失败"));
    } finally {
      setBusy(false);
    }
  };

  const archivableSelectedIds = useMemo(() => {
    if (!activeDetail) return [];
    return activeDetail.nodes
      .filter((n) => selectedIds.has(n.id) && n.type !== "tombstone")
      .map((n) => n.id);
  }, [activeDetail, selectedIds]);

  const handleArchiveToTombstone = async () => {
    if (!activeDetail || archivableSelectedIds.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await request<ArchiveTombstoneResult>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/archive-tombstone`,
        {
          method: "POST",
          body: JSON.stringify({ nodeIds: archivableSelectedIds }),
        },
      );
      await refreshActiveCanvas();
      setSelectedIds(new Set([res.tombstone.id]));
      setTombstoneModalNode(res.tombstone);
      setNotice(
        `已将 ${res.archivedCount} 个节点降维收束为结案墓碑（${res.summarySource === "llm" ? "大模型总结" : "结构化提炼"}）`,
      );
    } catch (err) {
      setError(describeError(err, "归档降维失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreTombstone = async (tombstoneId: string) => {
    if (!activeDetail) return;
    setBusy(true);
    setError("");
    try {
      const res = await request<RestoreTombstoneResult>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/tombstones/${encodeURIComponent(tombstoneId)}/restore`,
        { method: "POST", body: "{}" },
      );
      setTombstoneModalNode(null);
      await refreshActiveCanvas();
      setSelectedIds(new Set(res.restoredNodes.map((n) => n.id)));
      setNotice(`已从结案墓碑还原 ${res.restoredNodes.length} 个节点与 ${res.restoredEdges.length} 条连线`);
    } catch (err) {
      setError(describeError(err, "还原墓碑节点群失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleExportMarkdown = async () => {
    if (!activeDetail) return;
    setBusy(true);
    setError("");
    try {
      const res = await request<CanvasExportResult>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/export`,
      );
      setExportModal(res);
    } catch (err) {
      setError(describeError(err, "导出 Markdown 失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadExport = () => {
    if (!exportModal) return;
    const blob = new Blob([exportModal.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportModal.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSemanticSearch = async (queryOverride?: string) => {
    if (!activeDetail) return;
    const q = (queryOverride ?? compassQuery).trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      const res = await request<SemanticSearchResult>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/semantic-search`,
        {
          method: "POST",
          body: JSON.stringify({
            query: q,
            topK: 10,
            threshold: 0.12,
            includeAllCanvases: compassAllCanvases,
          }),
        },
      );
      setCompassResults(res.results);
      setCompassSource(res.embeddingSource);
      setSidebarOpen(true);
      setSidebarTab("compass");
    } catch (err) {
      setError(describeError(err, "语义指南针检索失败"));
    } finally {
      setBusy(false);
    }
  };

  const handleResonateSelectedNode = () => {
    if (!primarySelectedNode) return;
    const contentText = String(
      primarySelectedNode.content.text ??
        primarySelectedNode.content.summary ??
        primarySelectedNode.content.description ??
        primarySelectedNode.content.recognizedText ??
        "",
    ).slice(0, 180);
    const query = `${primarySelectedNode.title} ${contentText}`.trim();
    setCompassQuery(query);
    void handleSemanticSearch(query);
  };

  const handleSendNodeToPm = () => {
    if (!primarySelectedNode || !activeDetail) return;
    const body = String(
      primarySelectedNode.content.text ??
        primarySelectedNode.content.summary ??
        primarySelectedNode.content.description ??
        primarySelectedNode.content.recognizedText ??
        primarySelectedNode.content.markdown ??
        "",
    ).trim();
    const content = [primarySelectedNode.title, body].filter(Boolean).join("\n\n");
    try {
      sessionStorage.setItem(
        "opc.k2b.pmDraft",
        JSON.stringify({
          source: "canvas",
          project: activeDetail.canvas.name.slice(0, 40) || "default",
          content,
        }),
      );
    } catch {
      // Ignore storage quota errors
    }
    location.hash = "metabolism?tab=pm";
  };

  const handleSendMarkdownToDistribution = (title: string, markdown: string, sourceRef: string) => {
    try {
      sessionStorage.setItem(
        "opc.k2b.distDraft",
        JSON.stringify({ title, content: markdown, sourceRef }),
      );
    } catch {
      // Ignore storage quota errors
    }
    location.hash = "metabolism?tab=commercial";
  };

  const handleSaveInspector = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeDetail || !primarySelectedNode) return;
    setBusy(true);
    setError("");
    const patchContent: Record<string, unknown> = {};
    if (primarySelectedNode.type === "note") {
      patchContent.text = inspBody;
      patchContent.tags = inspTags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (primarySelectedNode.type === "task") {
      patchContent.description = inspBody;
    } else if (primarySelectedNode.type === "briefing") {
      patchContent.summary = inspBody;
      patchContent.tags = inspTags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (primarySelectedNode.type === "ink") {
      patchContent.hintText = inspBody;
    } else if (primarySelectedNode.type === "portal") {
      patchContent.note = inspBody;
    }

    try {
      const updated = await request<CanvasNode>(
        `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes/${encodeURIComponent(primarySelectedNode.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            title: inspTitle.trim() || primarySelectedNode.title,
            status: inspStatus,
            content: patchContent,
            position: { x: Number(inspX) || 0, y: Number(inspY) || 0 },
            size: {
              width: Math.max(140, Number(inspW) || primarySelectedNode.size.width),
              height: Math.max(100, Number(inspH) || primarySelectedNode.size.height),
            },
          }),
        },
      );
      setActiveDetail((prev) =>
        prev ? { ...prev, nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)) } : prev,
      );
      setNotice(`已更新节点「${updated.title}」并刷新语义向量`);
    } catch (err) {
      setError(describeError(err, "更新节点属性失败"));
    } finally {
      setBusy(false);
    }
  };

  // ---- Infinite Canvas Stage Coordinates, Zoom, Pan, Expand-Space ----

  const clientToWorld = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const vp = viewportRef.current;
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    };
  }, []);

  const applyZoom = useCallback(
    (factor: number, pivotClientX?: number, pivotClientY?: number) => {
      if (!activeDetail) return;
      const stage = stageRef.current;
      const rect = stage?.getBoundingClientRect();
      const vp = viewportRef.current;
      const nextZoom = Math.max(0.25, Math.min(2.5, Math.round(vp.zoom * factor * 100) / 100));
      const px = pivotClientX !== undefined && rect ? pivotClientX - rect.left : (rect?.width ?? 900) / 2;
      const py = pivotClientY !== undefined && rect ? pivotClientY - rect.top : (rect?.height ?? 600) / 2;
      const worldX = (px - vp.x) / vp.zoom;
      const worldY = (py - vp.y) / vp.zoom;
      const nextVp: CanvasViewport = {
        x: Math.round(px - worldX * nextZoom),
        y: Math.round(py - worldY * nextZoom),
        zoom: nextZoom,
      };
      setViewport(nextVp);
      scheduleViewportSave(activeDetail.canvas.id, nextVp);
    },
    [activeDetail, scheduleViewportSave],
  );

  const handleFitView = useCallback(() => {
    if (!activeDetail) return;
    const stage = stageRef.current;
    const stageW = stage?.clientWidth ?? 900;
    const stageH = stage?.clientHeight ?? 600;
    if (activeDetail.nodes.length === 0) {
      const reset = { x: 0, y: 0, zoom: 1 };
      setViewport(reset);
      scheduleViewportSave(activeDetail.canvas.id, reset);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of activeDetail.nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + n.size.width);
      maxY = Math.max(maxY, n.position.y + n.size.height);
    }
    const pad = 80;
    const boxW = Math.max(200, maxX - minX);
    const boxH = Math.max(160, maxY - minY);
    const zoom = Math.max(0.3, Math.min(1.25, Math.min((stageW - pad * 2) / boxW, (stageH - pad * 2) / boxH)));
    const nextVp: CanvasViewport = {
      x: Math.round((stageW - boxW * zoom) / 2 - minX * zoom),
      y: Math.round((stageH - boxH * zoom) / 2 - minY * zoom),
      zoom: Math.round(zoom * 100) / 100,
    };
    setViewport(nextVp);
    scheduleViewportSave(activeDetail.canvas.id, nextVp);
  }, [activeDetail, scheduleViewportSave]);

  const handleStageWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.91;
    applyZoom(factor, e.clientX, e.clientY);
  };

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeDetail) return;
    if (e.button !== 0 && e.button !== 1) return;

    const worldPt = clientToWorld(e.clientX, e.clientY);

    if (mode === "expand") {
      e.currentTarget.setPointerCapture(e.pointerId);
      const originWorld = expandAxis === "x" ? Math.round(worldPt.x) : Math.round(worldPt.y);
      setExpandDrag({ axis: expandAxis, originWorld, currentWorld: originWorld });
      return;
    }

    if (mode === "ink") {
      void handleQuickAddNode("ink", { x: Math.round(worldPt.x - 160), y: Math.round(worldPt.y - 60) });
      return;
    }

    if (mode === "connect") {
      setConnectSourceId(null);
      setConnectCursorWorld(null);
      return;
    }

    // Select mode: pan viewport on blank background
    if (!e.shiftKey) setSelectedIds(new Set());
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: viewportRef.current.x,
      startY: viewportRef.current.y,
    };
    setIsPanning(true);
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const worldPt = clientToWorld(e.clientX, e.clientY);

    if (mode === "expand") {
      setExpandHoverWorld(worldPt);
      if (expandDrag) {
        setExpandDrag((prev) =>
          prev ? { ...prev, currentWorld: Math.round(prev.axis === "x" ? worldPt.x : worldPt.y) } : null,
        );
      }
      return;
    }

    if (mode === "connect" && connectSourceId) {
      setConnectCursorWorld(worldPt);
    }

    if (dragNodeRef.current && activeDetail) {
      const drag = dragNodeRef.current;
      const dx = (e.clientX - drag.startClientX) / viewportRef.current.zoom;
      const dy = (e.clientY - drag.startClientY) / viewportRef.current.zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
      const nextPos: CanvasPoint = {
        x: Math.round(drag.originX + dx),
        y: Math.round(drag.originY + dy),
      };
      setActiveDetail((prev) =>
        prev
          ? { ...prev, nodes: prev.nodes.map((n) => (n.id === drag.nodeId ? { ...n, position: nextPos } : n)) }
          : prev,
      );
      return;
    }

    if (panRef.current) {
      const dx = e.clientX - panRef.current.startClientX;
      const dy = e.clientY - panRef.current.startClientY;
      setViewport({
        x: Math.round(panRef.current.startX + dx),
        y: Math.round(panRef.current.startY + dy),
        zoom: viewportRef.current.zoom,
      });
    }
  };

  const handleStagePointerUp = async () => {
    if (expandDrag && activeDetail) {
      const rawDelta = Math.round(expandDrag.currentWorld - expandDrag.originWorld);
      const { axis, originWorld } = expandDrag;
      setExpandDrag(null);
      if (Math.abs(rawDelta) >= 12) {
        setBusy(true);
        setError("");
        try {
          const res = await request<ExpandSpaceResult>(
            `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/expand-space`,
            {
              method: "POST",
              body: JSON.stringify({ axis, origin: originWorld, delta: rawDelta }),
            },
          );
          if (res.movedCount > 0) {
            const movedMap = new Map(res.movedNodes.map((m) => [m.id, m.position]));
            setActiveDetail((prev) =>
              prev
                ? {
                    ...prev,
                    nodes: prev.nodes.map((n) =>
                      movedMap.has(n.id) ? { ...n, position: movedMap.get(n.id)! } : n,
                    ),
                  }
                : prev,
            );
            setNotice(
              `动态空间扩写完成：沿 ${axis.toUpperCase()} 轴平移 ${res.delta > 0 ? "+" : ""}${res.delta}px，共推动 ${res.movedCount} 个节点`,
            );
          } else {
            setNotice("该扩写轴线之后暂无节点需要平移");
          }
        } catch (err) {
          setError(describeError(err, "动态空间扩写失败"));
        } finally {
          setBusy(false);
        }
      }
      return;
    }

    if (dragNodeRef.current && activeDetail) {
      const drag = dragNodeRef.current;
      dragNodeRef.current = null;
      if (drag.moved) {
        const movedNode = activeDetail.nodes.find((n) => n.id === drag.nodeId);
        if (movedNode) {
          void request<CanvasNode>(
            `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/nodes/${encodeURIComponent(movedNode.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ position: movedNode.position }),
            },
          ).catch((err) => setError(describeError(err, "持久化节点坐标失败")));
        }
      }
      return;
    }

    if (panRef.current && activeDetail) {
      panRef.current = null;
      setIsPanning(false);
      scheduleViewportSave(activeDetail.canvas.id, viewportRef.current);
    }
  };

  const handleNodeClick = async (e: React.MouseEvent, node: CanvasNode) => {
    e.stopPropagation();
    if (!activeDetail) return;

    if (mode === "connect") {
      if (!connectSourceId) {
        setConnectSourceId(node.id);
        setNotice(`连线起点：「${node.title}」，请点击目标节点完成连线`);
        return;
      }
      if (connectSourceId === node.id) {
        setConnectSourceId(null);
        return;
      }
      setBusy(true);
      setError("");
      try {
        const created = await request<CanvasEdge>(
          `${API_BASE}/${encodeURIComponent(activeDetail.canvas.id)}/edges`,
          {
            method: "POST",
            body: JSON.stringify({
              sourceId: connectSourceId,
              targetId: node.id,
              type: connectEdgeType,
              label: EDGE_TYPE_META[connectEdgeType].label,
            }),
          },
        );
        setActiveDetail((prev) =>
          prev
            ? {
                ...prev,
                canvas: { ...prev.canvas, edgeCount: prev.edges.length + 1 },
                edges: [...prev.edges, created],
              }
            : prev,
        );
        setConnectSourceId(null);
        setConnectCursorWorld(null);
        setNotice(`已建立「${EDGE_TYPE_META[connectEdgeType].label}」连线`);
      } catch (err) {
        setError(describeError(err, "创建连线失败"));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (e.shiftKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
    } else {
      setSelectedIds(new Set([node.id]));
    }
  };

  const handleNodeHeadPointerDown = (e: ReactPointerEvent<HTMLElement>, node: CanvasNode) => {
    if (mode !== "select") return;
    e.stopPropagation();
    stageRef.current?.setPointerCapture(e.pointerId);
    dragNodeRef.current = {
      nodeId: node.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originX: node.position.x,
      originY: node.position.y,
      moved: false,
    };
  };

  const toggleNodeCheckbox = (nodeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  // Compute rendered node positions (including live expand-space preview offset)
  const expandPreviewDelta = useMemo(() => {
    if (!expandDrag || !activeDetail) return 0;
    const rawDelta = expandDrag.currentWorld - expandDrag.originWorld;
    if (rawDelta >= 0) return rawDelta;
    const affected = activeDetail.nodes.filter(
      (n) => n.position[expandDrag.axis] >= expandDrag.originWorld,
    );
    if (affected.length === 0) return 0;
    const minCoord = Math.min(...affected.map((n) => n.position[expandDrag.axis]));
    return Math.max(rawDelta, expandDrag.originWorld - minCoord);
  }, [expandDrag, activeDetail]);

  const renderedNodes = useMemo(() => {
    if (!activeDetail) return [];
    if (!expandDrag || expandPreviewDelta === 0) return activeDetail.nodes;
    return activeDetail.nodes.map((n) => {
      if (n.position[expandDrag.axis] < expandDrag.originWorld) return n;
      return {
        ...n,
        position: {
          x: expandDrag.axis === "x" ? n.position.x + expandPreviewDelta : n.position.x,
          y: expandDrag.axis === "y" ? n.position.y + expandPreviewDelta : n.position.y,
        },
      };
    });
  }, [activeDetail, expandDrag, expandPreviewDelta]);

  const renderedNodeMap = useMemo(
    () => new Map(renderedNodes.map((n) => [n.id, n])),
    [renderedNodes],
  );

  // ---- Render View 1: Canvas Space List ----
  if (!activeDetail) {
    return (
      <section className="zo-product kc-page" aria-label="无界知识画布">
        <div className="kc-lobby">
          <header className="kc-lobby-head">
            <div>
              <div className="kc-title-row">
                {nav}
                <h1>无界知识画布</h1>
              </div>
              <p className="kc-sub">
                空间化思维与知识共振层：融合笔记卡片、压感手写墨迹 OCR、实时任务节点、双向时空任意门、动态空间扩写、语义指南针与一键结案墓碑。
              </p>
            </div>
            <div className="kc-topbar-group">
              <button
                type="button"
                className={includeArchived ? "kc-active" : ""}
                onClick={() => setIncludeArchived((v) => !v)}
              >
                {includeArchived ? "隐藏已归档画布" : "显示已归档画布"}
              </button>
              <button type="button" onClick={() => void loadCanvases(includeArchived)}>
                刷新列表
              </button>
            </div>
          </header>

          {notice && (
            <div role="status" className="kc-banner" style={{ marginInline: 0 }}>
              <span>{notice}</span>
              <button type="button" className="kc-ghost" onClick={() => setNotice("")}>
                ×
              </button>
            </div>
          )}
          {error && (
            <div role="alert" className="kc-banner error" style={{ marginInline: 0 }}>
              <span>{error}</span>
              <button type="button" className="kc-ghost" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}

          <form className="kc-create-bar" onSubmit={(e) => void handleCreateCanvas(e)}>
            <input
              name="name"
              type="text"
              value={newCanvasName}
              onChange={(e) => setNewCanvasName(e.target.value)}
              placeholder="新建画布名称（例如：Q2 产品商业化地图）"
              required
            />
            <input
              name="description"
              type="text"
              value={newCanvasDesc}
              onChange={(e) => setNewCanvasDesc(e.target.value)}
              placeholder="画布简介（可选）"
            />
            <button type="submit" className="kc-primary" disabled={busy || !newCanvasName.trim()}>
              + 新建知识画布
            </button>
          </form>

          {canvases.length === 0 ? (
            <div className="kc-empty">
              <h3>尚无知识画布</h3>
              <p style={{ marginTop: 8 }}>
                在上方输入名称创建第一张无限画布，开始构建跨空间、可语义共振的个人知识地图。
              </p>
            </div>
          ) : (
            <div className="kc-grid">
              {canvases.map((c) => (
                <article
                  key={c.id}
                  className="kc-space-card"
                  data-archived={c.isArchived ? "true" : "false"}
                >
                  <div>
                    <h3 onClick={() => void openCanvas(c.id)}>{c.name}</h3>
                    <p className="kc-space-desc">{c.description || "无界空间思考画布"}</p>
                  </div>
                  <div className="kc-space-meta">
                    <span>节点 {c.nodeCount}</span>
                    <span>· 连线 {c.edgeCount}</span>
                    <span>· 更新 {formatShortTime(c.updatedAt)}</span>
                    {c.isArchived && <span>· 已归档</span>}
                  </div>
                  <div className="kc-space-actions">
                    <button
                      type="button"
                      className="kc-primary"
                      onClick={() => void openCanvas(c.id)}
                    >
                      进入画布 →
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleArchiveCanvas(c)}
                    >
                      {c.isArchived ? "取消归档" : "归档"}
                    </button>
                    <button
                      type="button"
                      className="kc-danger"
                      disabled={busy}
                      onClick={() => void handleDeleteCanvas(c)}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  // ---- Render View 2: Infinite Canvas Workspace ----
  const otherCanvases = canvases.filter(
    (c) => c.id !== activeDetail.canvas.id && !c.isArchived,
  );
  const expandAffectedCount = expandDrag
    ? activeDetail.nodes.filter((n) => n.position[expandDrag.axis] >= expandDrag.originWorld).length
    : 0;
  const latestBreadcrumb = portalHistory[portalHistory.length - 1];

  return (
    <section className="zo-product kc-page" aria-label={`知识画布：${activeDetail.canvas.name}`}>
      {/* 顶部工具栏 */}
      <header className="kc-topbar">
        <div className="kc-topbar-group">
          {nav}
          <button
            type="button"
            onClick={() => {
              setActiveDetail(null);
              setPortalHistory([]);
              void loadCanvases(includeArchived);
            }}
          >
            ← 列表
          </button>
          {latestBreadcrumb && (
            <button
              type="button"
              className="kc-portal-btn"
              onClick={handleBreadcrumbReturn}
              title="通过时空任意门返回上一画布"
            >
              ← 返回来源画布：{latestBreadcrumb.canvasName}
            </button>
          )}
          <span className="kc-canvas-title-badge" title={activeDetail.canvas.name}>
            {activeDetail.canvas.name}
          </span>
        </div>

        <span className="kc-topbar-sep" aria-hidden="true" />

        {/* 模式切换 */}
        <div className="kc-topbar-group" role="group" aria-label="画布交互模式">
          <button
            type="button"
            className={mode === "select" ? "kc-active" : ""}
            onClick={() => {
              setMode("select");
              setConnectSourceId(null);
            }}
          >
            选择/拖拽
          </button>
          <button
            type="button"
            className={mode === "ink" ? "kc-active" : ""}
            onClick={() => setMode("ink")}
          >
            ✒ 手写墨迹笔
          </button>
          <button
            type="button"
            className={mode === "expand" ? "kc-active" : ""}
            onClick={() => setMode("expand")}
          >
            ⇳ 动态空间扩写
          </button>
          {mode === "expand" && (
            <select
              aria-label="扩写轴向"
              value={expandAxis}
              onChange={(e) => setExpandAxis(e.target.value as "x" | "y")}
              style={{ padding: "4px 6px", fontSize: 12 }}
            >
              <option value="x">横向 X 轴</option>
              <option value="y">纵向 Y 轴</option>
            </select>
          )}
          <button
            type="button"
            className={mode === "connect" ? "kc-active" : ""}
            onClick={() => {
              setMode("connect");
              setConnectSourceId(null);
            }}
          >
            ⤤ 连线模式
          </button>
          {mode === "connect" && (
            <select
              aria-label="连线类型"
              value={connectEdgeType}
              onChange={(e) => setConnectEdgeType(e.target.value as CanvasEdgeType)}
              style={{ padding: "4px 6px", fontSize: 12 }}
            >
              {(Object.keys(EDGE_TYPE_META) as CanvasEdgeType[]).map((t) => (
                <option key={t} value={t}>
                  {EDGE_TYPE_META[t].label}
                </option>
              ))}
            </select>
          )}
        </div>

        <span className="kc-topbar-sep" aria-hidden="true" />

        {/* 快捷添加节点 */}
        <div className="kc-topbar-group">
          <button type="button" disabled={busy} onClick={() => void handleQuickAddNode("note")}>
            + 笔记
          </button>
          <button type="button" disabled={busy} onClick={() => void handleQuickAddNode("ink")}>
            + 手写块
          </button>
          <button type="button" disabled={busy} onClick={() => void handleQuickAddNode("task")}>
            + 任务卡
          </button>
          <button
            type="button"
            className="kc-portal-btn"
            disabled={busy}
            onClick={() => void handleQuickAddNode("portal")}
          >
            ⬡ 时空任意门
          </button>
        </div>

        <span className="kc-topbar-sep" aria-hidden="true" />

        {/* 共振、归档、导出与缩放 */}
        <div className="kc-topbar-group">
          <button type="button" className="kc-primary" disabled={busy} onClick={() => void handleAutoLink()}>
            ✨ 语义自动连线
          </button>
          <button
            type="button"
            className="kc-accent"
            disabled={busy || archivableSelectedIds.length === 0}
            onClick={() => void handleArchiveToTombstone()}
            title="选中 1 个及以上节点，一键降维总结为结案墓碑"
          >
            📦 归档降维成墓碑{archivableSelectedIds.length > 0 ? ` (${archivableSelectedIds.length})` : ""}
          </button>
          <button type="button" disabled={busy} onClick={() => void handleExportMarkdown()}>
            ⬇ 导出 Markdown
          </button>
        </div>

        <div className="kc-topbar-group" style={{ marginLeft: "auto" }}>
          <button type="button" onClick={() => applyZoom(0.85)} aria-label="缩小">
            −
          </button>
          <button
            type="button"
            className="kc-zoom-readout"
            onClick={() => {
              const reset = { ...viewport, zoom: 1 };
              setViewport(reset);
              scheduleViewportSave(activeDetail.canvas.id, reset);
            }}
            title="重置为 100%"
          >
            {Math.round(viewport.zoom * 100)}%
          </button>
          <button type="button" onClick={() => applyZoom(1.18)} aria-label="放大">
            +
          </button>
          <button type="button" onClick={handleFitView}>
            适应全图
          </button>
          <button
            type="button"
            className={sidebarOpen ? "kc-active" : ""}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            🧭 语义指南针
          </button>
        </div>
      </header>

      {notice && (
        <div role="status" className="kc-banner">
          <span>{notice}</span>
          <button type="button" className="kc-ghost" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="kc-banner error">
          <span>{error}</span>
          <button type="button" className="kc-ghost" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}

      {/* 主工作区 = 无限画布舞台 + 右侧语义指南针侧边栏 */}
      <div className="kc-workspace">
        <div
          ref={stageRef}
          className="kc-stage"
          data-mode={mode}
          data-expand-axis={expandAxis}
          data-panning={isPanning ? "true" : "false"}
          style={{
            backgroundImage: "radial-gradient(circle, #d3cebe 1.2px, transparent 1.2px)",
            backgroundSize: `${Math.max(12, 24 * viewport.zoom)}px ${Math.max(12, 24 * viewport.zoom)}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
          onWheel={handleStageWheel}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={() => void handleStagePointerUp()}
          onPointerLeave={() => {
            if (!expandDrag) setExpandHoverWorld(null);
          }}
        >
          {/* 模式操作提示 */}
          {mode !== "select" && (
            <div className="kc-mode-hint">
              {mode === "ink" && "手写墨迹笔模式：点击画布空白处即时落笔建块，或在已有手写块中自由书写"}
              {mode === "expand" &&
                `动态空间扩写模式（${expandAxis === "x" ? "横向 X" : "纵向 Y"}）：按下并向${expandAxis === "x" ? "右" : "下"}拖动，整体推移轴线之后的全部节点`}
              {mode === "connect" &&
                (connectSourceId
                  ? `连线模式（${EDGE_TYPE_META[connectEdgeType].label}）：请点击目标节点完成连线`
                  : `连线模式（${EDGE_TYPE_META[connectEdgeType].label}）：先点击源节点，再点击目标节点`)}
            </div>
          )}

          {/* 动态空间扩写引导线 & 阴影预览带 */}
          {mode === "expand" && (expandDrag || expandHoverWorld) && (
            <div className="kc-expand-overlay">
              {(() => {
                const axis = expandDrag ? expandDrag.axis : expandAxis;
                const originW = expandDrag
                  ? expandDrag.originWorld
                  : axis === "x"
                    ? expandHoverWorld!.x
                    : expandHoverWorld!.y;
                const originScreen =
                  axis === "x" ? originW * viewport.zoom + viewport.x : originW * viewport.zoom + viewport.y;
                const deltaScreen = expandDrag ? expandPreviewDelta * viewport.zoom : 0;

                if (axis === "x") {
                  return (
                    <>
                      <div className="kc-expand-guide-x" style={{ left: originScreen }} />
                      {expandDrag && Math.abs(deltaScreen) > 2 && (
                        <div
                          className="kc-expand-band"
                          style={{
                            top: 0,
                            bottom: 0,
                            left: Math.min(originScreen, originScreen + deltaScreen),
                            width: Math.abs(deltaScreen),
                          }}
                        />
                      )}
                      <div className="kc-expand-pill" style={{ left: Math.max(8, originScreen + 10), top: 48 }}>
                        {expandDrag
                          ? `↔ X 扩写 ${expandPreviewDelta >= 0 ? "+" : ""}${Math.round(expandPreviewDelta)}px · 影响 ${expandAffectedCount} 节点`
                          : `↔ 按下右拖沿 X=${Math.round(originW)} 扩写`}
                      </div>
                    </>
                  );
                }
                return (
                  <>
                    <div className="kc-expand-guide-y" style={{ top: originScreen }} />
                    {expandDrag && Math.abs(deltaScreen) > 2 && (
                      <div
                        className="kc-expand-band"
                        style={{
                          left: 0,
                          right: 0,
                          top: Math.min(originScreen, originScreen + deltaScreen),
                          height: Math.abs(deltaScreen),
                        }}
                      />
                    )}
                    <div className="kc-expand-pill" style={{ left: 16, top: Math.max(46, originScreen + 8) }}>
                      {expandDrag
                        ? `↕ Y 扩写 ${expandPreviewDelta >= 0 ? "+" : ""}${Math.round(expandPreviewDelta)}px · 影响 ${expandAffectedCount} 节点`
                        : `↕ 按下下拖沿 Y=${Math.round(originW)} 扩写`}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* 世界坐标系容器 */}
          <div
            className="kc-world"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            {/* SVG 贝塞尔连线层 */}
            <svg className="kc-edges-svg" aria-label="画布关系连线层">
              <defs>
                {(Object.keys(EDGE_TYPE_META) as CanvasEdgeType[]).map((edgeType) => (
                  <marker
                    key={edgeType}
                    id={`kc-arrow-${edgeType}`}
                    viewBox="0 0 10 10"
                    refX="8.5"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.2 L 9 5 L 0 8.8 z" fill={EDGE_TYPE_META[edgeType].color} />
                  </marker>
                ))}
              </defs>

              {activeDetail.edges.map((edge) => {
                const src = renderedNodeMap.get(edge.sourceId);
                const dst = renderedNodeMap.get(edge.targetId);
                if (!src || !dst) return null;
                const curve = computeBezier(
                  { ...src.position, ...src.size },
                  { ...dst.position, ...dst.size },
                );
                const labelText = edge.label || EDGE_TYPE_META[edge.type].label;
                const boxW = Math.max(54, labelText.length * 7.8 + 14);
                return (
                  <g key={edge.id}>
                    <path
                      className="kc-edge-path"
                      data-type={edge.type}
                      d={curve.d}
                      markerEnd={`url(#kc-arrow-${edge.type})`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (window.confirm(`删除连线「${labelText}」？`)) {
                          void handleDeleteEdge(edge.id);
                        }
                      }}
                    >
                      <title>{`${EDGE_TYPE_META[edge.type].label}${edge.label ? ` (${edge.label})` : ""} · 点击删除`}</title>
                    </path>
                    {labelText && (
                      <g transform={`translate(${curve.midX.toFixed(1)}, ${curve.midY.toFixed(1)})`}>
                        <rect
                          className="kc-edge-label-bg"
                          x={-boxW / 2}
                          y={-10}
                          width={boxW}
                          height={20}
                        />
                        <text className="kc-edge-label-text" textAnchor="middle" dominantBaseline="central">
                          {labelText}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* 连线模式拖拽预览 */}
              {mode === "connect" && connectSourceId && connectCursorWorld && (() => {
                const src = renderedNodeMap.get(connectSourceId);
                if (!src) return null;
                const curve = computeBezier(
                  { ...src.position, ...src.size },
                  { x: connectCursorWorld.x, y: connectCursorWorld.y, width: 2, height: 2 },
                );
                return (
                  <path
                    d={curve.d}
                    fill="none"
                    stroke={EDGE_TYPE_META[connectEdgeType].color}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                  />
                );
              })()}
            </svg>

            {/* 节点层 */}
            {renderedNodes.map((node) => {
              const isSelected = selectedIds.has(node.id);
              const meta = NODE_TYPE_META[node.type];
              const content = node.content;
              const tags = Array.isArray(content.tags) ? content.tags.map(String) : [];

              return (
                <article
                  key={node.id}
                  className="kc-node"
                  data-type={node.type}
                  data-selected={isSelected ? "true" : "false"}
                  data-connect-source={connectSourceId === node.id ? "true" : "false"}
                  data-highlight={highlightedNodeId === node.id ? "true" : "false"}
                  style={{
                    left: node.position.x,
                    top: node.position.y,
                    width: node.size.width,
                    height: node.size.height,
                  }}
                  onClick={(e) => void handleNodeClick(e, node)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (node.type === "portal") {
                      handleWarpPortal(node);
                    } else if (node.type === "tombstone") {
                      setTombstoneModalNode(node);
                    } else {
                      setSelectedIds(new Set([node.id]));
                      setSidebarOpen(true);
                      setSidebarTab("inspector");
                    }
                  }}
                >
                  <header
                    className="kc-node-head"
                    onPointerDown={(e) => handleNodeHeadPointerDown(e, node)}
                  >
                    <input
                      type="checkbox"
                      className="kc-node-check"
                      checked={isSelected}
                      aria-label={`选择节点 ${node.title}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleNodeCheckbox(node.id)}
                    />
                    <span className="kc-node-type-pill">
                      {meta.icon} {meta.label}
                    </span>
                    <span className="kc-node-title" title={node.title}>
                      {node.title}
                    </span>
                  </header>

                  <div className="kc-node-body">
                    {node.type === "note" && (
                      <>
                        <div className="kc-node-text">
                          {String(content.text ?? content.markdown ?? "双击或在右侧编辑笔记正文…")}
                        </div>
                        {tags.length > 0 && (
                          <div className="kc-tag-row">
                            {tags.map((t) => (
                              <span key={t} className="kc-tag">
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    {node.type === "ink" && (
                      <InkNodePad
                        node={node}
                        busy={busy}
                        onSaveStrokes={handleSaveInkStrokes}
                        onRunOcr={handleRunInkOcr}
                      />
                    )}

                    {node.type === "task" && (
                      <>
                        <div className="kc-task-badges">
                          <span className={`kc-pill ${node.liveTask ? "ok" : "warn"}`}>
                            {node.liveTask
                              ? `实时状态：${node.liveTask.status}`
                              : String(content.taskStatus ?? "草稿任务")}
                          </span>
                          {(node.liveTask?.priority != null || content.priority != null) && (
                            <span className="kc-pill">
                              P{String(node.liveTask?.priority ?? content.priority)}
                            </span>
                          )}
                          {node.liveTask?.assigneeType && (
                            <span className="kc-pill">{node.liveTask.assigneeType}</span>
                          )}
                        </div>
                        <div className="kc-node-text">
                          {String(content.description ?? content.text ?? "待细化任务说明")}
                        </div>
                        {node.liveTask?.prUrl && (
                          <a
                            className="kc-link"
                            href={node.liveTask.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            关联 PR ↗
                          </a>
                        )}
                      </>
                    )}

                    {node.type === "portal" && (
                      <>
                        <div className="kc-task-badges">
                          <span className="kc-pill portal">
                            目标：{String(content.targetCanvasName ?? content.targetCanvasId ?? "未绑定")}
                          </span>
                          {Boolean(content.bidirectional) && (
                            <span className="kc-pill portal">⇄ 双向通道</span>
                          )}
                        </div>
                        <div className="kc-node-text">
                          {String(content.note ?? "双击卡片或点击下方按钮瞬间穿越至目标画布，并保留返回面包屑。")}
                        </div>
                      </>
                    )}

                    {node.type === "briefing" && (
                      <>
                        <div className="kc-task-badges">
                          <span className="kc-pill brief">
                            来源：{String(content.source ?? "每日简报")}
                          </span>
                          {content.score != null && (
                            <span className="kc-pill ok">评分 {String(content.score)}</span>
                          )}
                        </div>
                        <div className="kc-node-text">{String(content.summary ?? "")}</div>
                        {tags.length > 0 && (
                          <div className="kc-tag-row">
                            {tags.map((t) => (
                              <span key={t} className="kc-tag">
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    {node.type === "tombstone" && (
                      <>
                        <div className="kc-task-badges">
                          <span className="kc-pill">
                            已收束 {String(content.archivedCount ?? 0)} 个节点
                          </span>
                          {typeof content.archivedAt === "string" && (
                            <span className="kc-pill">{formatShortTime(content.archivedAt)}</span>
                          )}
                        </div>
                        <div className="kc-node-text">
                          {String(content.markdown ?? "").slice(0, 120)}
                          {String(content.markdown ?? "").length > 120 ? "…" : ""}
                        </div>
                      </>
                    )}
                  </div>

                  {/* 节点底部快捷操作 */}
                  {(node.type === "portal" || node.type === "task" || node.type === "tombstone") && (
                    <footer className="kc-node-foot" onPointerDown={(e) => e.stopPropagation()}>
                      {node.type === "portal" && (
                        <button
                          type="button"
                          className="kc-portal-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleWarpPortal(node);
                          }}
                        >
                          穿越 ↗
                        </button>
                      )}

                      {node.type === "task" && (
                        <>
                          {!content.taskId ? (
                            <button
                              type="button"
                              className="kc-primary"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handlePromoteToTask(node);
                              }}
                            >
                              转为真实任务
                            </button>
                          ) : (
                            <a
                              className="kc-link"
                              href="#planning"
                              onClick={(e) => e.stopPropagation()}
                            >
                              前往任务看板 #{String(content.taskId)} ↗
                            </a>
                          )}
                        </>
                      )}

                      {node.type === "tombstone" && (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTombstoneModalNode(node);
                            }}
                          >
                            展开归档文档
                          </button>
                          <button
                            type="button"
                            className="kc-accent"
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRestoreTombstone(node.id);
                            }}
                          >
                            还原原节点群
                          </button>
                        </>
                      )}
                    </footer>
                  )}
                </article>
              );
            })}
          </div>

          {/* 多选悬浮操作栏 */}
          {selectedIds.size > 0 && (
            <div className="kc-floating-bar">
              <span>已选中 {selectedIds.size} 个节点</span>
              {archivableSelectedIds.length > 0 && (
                <button
                  type="button"
                  className="kc-accent"
                  disabled={busy}
                  onClick={() => void handleArchiveToTombstone()}
                >
                  📦 归档降维成墓碑 ({archivableSelectedIds.length})
                </button>
              )}
              {primarySelectedNode && (
                <>
                  <button
                    type="button"
                    className="kc-primary"
                    onClick={handleResonateSelectedNode}
                  >
                    🧭 语义共鸣
                  </button>
                  <button
                    type="button"
                    onClick={handleSendNodeToPm}
                  >
                    🤖 送 PM 评估 ↗
                  </button>
                </>
              )}
              <button type="button" onClick={() => setSelectedIds(new Set())}>
                取消选择
              </button>
            </div>
          )}
        </div>

        {/* 右侧可折叠「语义指南针」与属性大纲侧边栏 */}
        {sidebarOpen && (
          <aside className="kc-sidebar" aria-label="语义指南针与属性面板">
            <div className="kc-sidebar-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === "compass"}
                onClick={() => setSidebarTab("compass")}
              >
                🧭 语义指南针
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === "inspector"}
                onClick={() => setSidebarTab("inspector")}
              >
                ✎ 属性编辑
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarTab === "outline"}
                onClick={() => setSidebarTab("outline")}
              >
                ☰ 大纲 ({activeDetail.nodes.length})
              </button>
            </div>

            <div className="kc-sidebar-body">
              {sidebarTab === "compass" && (
                <>
                  <form
                    className="kc-compass-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleSemanticSearch();
                    }}
                  >
                    <div className="kc-compass-row">
                      <input
                        type="text"
                        value={compassQuery}
                        onChange={(e) => setCompassQuery(e.target.value)}
                        placeholder="输入主题或想法检索跨画布共鸣…"
                      />
                      <button type="submit" className="kc-primary" disabled={busy || !compassQuery.trim()}>
                        搜索
                      </button>
                    </div>
                    <div className="kc-compass-opts">
                      <label>
                        <input
                          type="checkbox"
                          checked={compassAllCanvases}
                          onChange={(e) => setCompassAllCanvases(e.target.checked)}
                        />
                        跨画布 + 外部记忆库
                      </label>
                      <button
                        type="button"
                        disabled={busy || !primarySelectedNode}
                        onClick={handleResonateSelectedNode}
                      >
                        以当前选中节点共鸣
                      </button>
                    </div>
                  </form>

                  {compassSource && (
                    <small style={{ color: "#5c6a60", fontSize: 11.5 }}>
                      向量引擎：{compassSource === "remote" ? "远端 Embedding" : "本地中英文语义向量"} · 命中{" "}
                      {compassResults.length} 条
                    </small>
                  )}

                  <div className="kc-result-list">
                    {compassResults.length === 0 ? (
                      <p style={{ fontSize: 12.5, color: "#5e6b62", marginTop: 6 }}>
                        输入关键词或选中节点点击「共鸣」，系统将跨画布检索高相似度卡片、历史公司想法与每日简报。
                      </p>
                    ) : (
                      compassResults.map((item) => {
                        const pct = Math.max(0, Math.min(100, Math.round(item.score * 100)));
                        const isSameCanvas = item.canvasId === activeDetail.canvas.id;
                        return (
                          <div key={`${item.sourceKind}-${item.nodeId}`} className="kc-result-card">
                            <div className="kc-result-top">
                              <span className="kc-pill">
                                {item.sourceKind === "canvas_node"
                                  ? isSameCanvas
                                    ? "当前画布"
                                    : `画布：${item.canvasName}`
                                  : item.canvasName}
                              </span>
                              <strong style={{ fontFamily: "var(--digits, monospace)", color: "#2f513e" }}>
                                {pct}%
                              </strong>
                            </div>
                            <div className="kc-score-bar">
                              <div className="kc-score-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <strong style={{ fontSize: 13 }}>{item.title}</strong>
                            {item.snippet && <div className="kc-result-snippet">{item.snippet}</div>}
                            <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                              {item.sourceKind === "canvas_node" && item.canvasId ? (
                                isSameCanvas ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const found = activeDetail.nodes.find((n) => n.id === item.nodeId);
                                      if (found) focusNode(found, activeDetail.canvas.id);
                                    }}
                                  >
                                    定位画布中心
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="kc-portal-btn"
                                    onClick={() =>
                                      void openCanvas(item.canvasId!, {
                                        pushBreadcrumb: {
                                          canvasId: activeDetail.canvas.id,
                                          canvasName: activeDetail.canvas.name,
                                        },
                                        focusNodeId: item.nodeId,
                                      })
                                    }
                                  >
                                    跨画布跳转 ↗
                                  </button>
                                )
                              ) : (
                                <a className="kc-link" href={item.href}>
                                  打开外部记忆 ↗
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}

              {sidebarTab === "inspector" && (
                <>
                  {!primarySelectedNode ? (
                    <p style={{ fontSize: 12.5, color: "#5e6b62" }}>
                      请在画布中点击选中任意节点以编辑标题、正文、状态与尺寸坐标。
                    </p>
                  ) : (
                    <form className="kc-inspector-form" onSubmit={(e) => void handleSaveInspector(e)}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span className="kc-pill">
                          {NODE_TYPE_META[primarySelectedNode.type].icon}{" "}
                          {NODE_TYPE_META[primarySelectedNode.type].label}
                        </span>
                        <small style={{ fontFamily: "var(--digits, monospace)", color: "#68736a" }}>
                          {primarySelectedNode.id}
                        </small>
                      </div>

                      <label>
                        节点标题
                        <input
                          type="text"
                          value={inspTitle}
                          onChange={(e) => setInspTitle(e.target.value)}
                          required
                        />
                      </label>

                      <label>
                        状态
                        <select
                          value={inspStatus}
                          onChange={(e) => setInspStatus(e.target.value as CanvasNodeStatus)}
                        >
                          <option value="draft">draft（草稿）</option>
                          <option value="active">active（活跃）</option>
                          <option value="published">published（已发布）</option>
                          <option value="archived">archived（已归档）</option>
                        </select>
                      </label>

                      {primarySelectedNode.type !== "tombstone" && (
                        <label>
                          {primarySelectedNode.type === "ink" ? "笔迹注记 / OCR 提示" : "内容正文"}
                          <textarea
                            rows={5}
                            value={inspBody}
                            onChange={(e) => setInspBody(e.target.value)}
                          />
                        </label>
                      )}

                      {(primarySelectedNode.type === "note" || primarySelectedNode.type === "briefing") && (
                        <label>
                          标签（逗号分隔）
                          <input
                            type="text"
                            value={inspTags}
                            onChange={(e) => setInspTags(e.target.value)}
                            placeholder="ai, product, license"
                          />
                        </label>
                      )}

                      <div className="kc-inspector-grid">
                        <label>
                          X 坐标
                          <input type="number" value={inspX} onChange={(e) => setInspX(e.target.value)} />
                        </label>
                        <label>
                          Y 坐标
                          <input type="number" value={inspY} onChange={(e) => setInspY(e.target.value)} />
                        </label>
                        <label>
                          宽度
                          <input type="number" value={inspW} onChange={(e) => setInspW(e.target.value)} />
                        </label>
                        <label>
                          高度
                          <input type="number" value={inspH} onChange={(e) => setInspH(e.target.value)} />
                        </label>
                      </div>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        <button type="submit" className="kc-primary" disabled={busy}>
                          保存修改
                        </button>
                        {primarySelectedNode.type !== "task" && primarySelectedNode.type !== "tombstone" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePromoteToTask(primarySelectedNode)}
                          >
                            转为真实任务
                          </button>
                        )}
                        <button
                          type="button"
                          className="kc-danger"
                          disabled={busy}
                          onClick={() => void handleDeleteNode(primarySelectedNode.id)}
                        >
                          删除节点
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}

              {sidebarTab === "outline" && (
                <>
                  <h4 style={{ fontSize: 13 }}>画布节点 ({activeDetail.nodes.length})</h4>
                  <ul className="kc-outline-list">
                    {activeDetail.nodes.map((node) => (
                      <li key={node.id} className="kc-outline-item">
                        <div
                          className="kc-outline-item-main"
                          onClick={() => focusNode(node, activeDetail.canvas.id)}
                        >
                          <strong>
                            {NODE_TYPE_META[node.type].icon} {node.title}
                          </strong>
                          <small>
                            {NODE_TYPE_META[node.type].label} · ({Math.round(node.position.x)},{" "}
                            {Math.round(node.position.y)})
                          </small>
                        </div>
                        <button
                          type="button"
                          className="kc-ghost"
                          onClick={() => {
                            setSelectedIds(new Set([node.id]));
                            setSidebarTab("inspector");
                          }}
                        >
                          编辑
                        </button>
                      </li>
                    ))}
                  </ul>

                  <h4 style={{ fontSize: 13, marginTop: 8 }}>关系连线 ({activeDetail.edges.length})</h4>
                  <ul className="kc-outline-list">
                    {activeDetail.edges.length === 0 ? (
                      <li style={{ fontSize: 12, color: "#616e64" }}>暂无连线，可开启「连线模式」或点击「语义自动连线」。</li>
                    ) : (
                      activeDetail.edges.map((edge) => {
                        const src = activeDetail.nodes.find((n) => n.id === edge.sourceId);
                        const dst = activeDetail.nodes.find((n) => n.id === edge.targetId);
                        return (
                          <li key={edge.id} className="kc-outline-item">
                            <div className="kc-outline-item-main">
                              <strong>
                                {src?.title ?? edge.sourceId} → {dst?.title ?? edge.targetId}
                              </strong>
                              <small>
                                {EDGE_TYPE_META[edge.type].label}
                                {edge.label ? ` · ${edge.label}` : ""}
                              </small>
                            </div>
                            <button
                              type="button"
                              className="kc-danger"
                              disabled={busy}
                              onClick={() => void handleDeleteEdge(edge.id)}
                            >
                              删
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* 弹窗 1：创建时空任意门 */}
      {portalModalOpen && (
        <div className="kc-modal-backdrop" onClick={() => setPortalModalOpen(false)}>
          <div className="kc-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="创建时空任意门">
            <header className="kc-modal-head">
              <h3>⬡ 建立时空任意门</h3>
              <button type="button" className="kc-ghost" onClick={() => setPortalModalOpen(false)}>
                ×
              </button>
            </header>
            <form onSubmit={(e) => void handleCreatePortal(e)}>
              <div className="kc-modal-body">
                {otherCanvases.length === 0 ? (
                  <p style={{ fontSize: 13, color: "#6e4630" }}>
                    目前没有其他可连接的画布，请先回到列表新建至少另一张画布。
                  </p>
                ) : (
                  <>
                    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13 }}>
                      <strong>选择目标画布</strong>
                      <select
                        value={portalTargetId}
                        onChange={(e) => {
                          setPortalTargetId(e.target.value);
                          const found = otherCanvases.find((c) => c.id === e.target.value);
                          if (found) setPortalTitle(`穿越 → ${found.name}`);
                        }}
                        required
                      >
                        {otherCanvases.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}（{c.nodeCount} 节点）
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 13 }}>
                      <strong>任意门标题</strong>
                      <input
                        type="text"
                        value={portalTitle}
                        onChange={(e) => setPortalTitle(e.target.value)}
                        required
                      />
                    </label>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={portalBidirectional}
                        onChange={(e) => setPortalBidirectional(e.target.checked)}
                      />
                      双向建门（在目标画布自动创建返回当前画布的任意门）
                    </label>
                  </>
                )}
              </div>
              <footer className="kc-modal-foot">
                <button type="button" onClick={() => setPortalModalOpen(false)}>
                  取消
                </button>
                <button
                  type="submit"
                  className="kc-portal-btn"
                  disabled={busy || !portalTargetId || otherCanvases.length === 0}
                >
                  建立任意门
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}

      {/* 弹窗 2：结案墓碑归档文档查看器 */}
      {tombstoneModalNode && (
        <div className="kc-modal-backdrop" onClick={() => setTombstoneModalNode(null)}>
          <div className="kc-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="结案墓碑归档文档">
            <header className="kc-modal-head">
              <h3>🪦 {tombstoneModalNode.title}</h3>
              <button type="button" className="kc-ghost" onClick={() => setTombstoneModalNode(null)}>
                ×
              </button>
            </header>
            <div className="kc-modal-body">
              <div className="kc-task-badges">
                <span className="kc-pill">
                  已收束节点：{String(tombstoneModalNode.content.archivedCount ?? 0)}
                </span>
                {typeof tombstoneModalNode.content.archivedAt === "string" && (
                  <span className="kc-pill">
                    归档时间：{formatShortTime(tombstoneModalNode.content.archivedAt)}
                  </span>
                )}
                {typeof tombstoneModalNode.content.companyNoteId === "string" &&
                  tombstoneModalNode.content.companyNoteId && (
                    <span className="kc-pill ok">
                      已沉淀公司文档：{tombstoneModalNode.content.companyNoteId}
                    </span>
                  )}
              </div>
              <pre className="kc-markdown-pre">
                {String(tombstoneModalNode.content.markdown ?? "（无归档正文）")}
              </pre>
            </div>
            <footer className="kc-modal-foot">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(String(tombstoneModalNode.content.markdown ?? ""));
                  setNotice("已复制归档 Markdown 到剪贴板");
                }}
              >
                复制 Markdown
              </button>
              <button
                type="button"
                className="kc-primary"
                onClick={() =>
                  handleSendMarkdownToDistribution(
                    tombstoneModalNode.title,
                    String(tombstoneModalNode.content.markdown ?? ""),
                    `canvas:${activeDetail?.canvas.id ?? ""}:${tombstoneModalNode.id}`,
                  )
                }
              >
                发往全渠道分发 ↗
              </button>
              <button
                type="button"
                className="kc-accent"
                disabled={busy}
                onClick={() => void handleRestoreTombstone(tombstoneModalNode.id)}
              >
                还原原节点群
              </button>
              <button type="button" className="kc-primary" onClick={() => setTombstoneModalNode(null)}>
                关闭
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* 弹窗 3：整页 Markdown 导出预览 */}
      {exportModal && (
        <div className="kc-modal-backdrop" onClick={() => setExportModal(null)}>
          <div className="kc-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="画布 Markdown 导出">
            <header className="kc-modal-head">
              <h3>⬇ 导出 Markdown · {exportModal.filename}</h3>
              <button type="button" className="kc-ghost" onClick={() => setExportModal(null)}>
                ×
              </button>
            </header>
            <div className="kc-modal-body">
              <div className="kc-task-badges">
                <span className="kc-pill">节点 {exportModal.nodeCount}</span>
                <span className="kc-pill">连线 {exportModal.edgeCount}</span>
                <span className="kc-pill">导出于 {formatShortTime(exportModal.exportedAt)}</span>
              </div>
              <pre className="kc-markdown-pre">{exportModal.markdown}</pre>
            </div>
            <footer className="kc-modal-foot">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(exportModal.markdown);
                  setNotice("已复制整页 Markdown 到剪贴板");
                }}
              >
                复制到剪贴板
              </button>
              <button
                type="button"
                onClick={() =>
                  handleSendMarkdownToDistribution(
                    activeDetail?.canvas.name || exportModal.filename,
                    exportModal.markdown,
                    `canvas:${activeDetail?.canvas.id ?? ""}`,
                  )
                }
              >
                发往全渠道分发 ↗
              </button>
              <button type="button" className="kc-primary" onClick={handleDownloadExport}>
                下载 .md 文件
              </button>
              <button type="button" onClick={() => setExportModal(null)}>
                关闭
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
