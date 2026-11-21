export type CanvasNodeType =
  | "note"
  | "ink"
  | "task"
  | "portal"
  | "briefing"
  | "tombstone";

export type CanvasNodeStatus =
  | "draft"
  | "active"
  | "archived"
  | "published";

export type CanvasEdgeType =
  | "derives"
  | "blocks"
  | "portal"
  | "semantic_link"
  | "deploy_to";

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface InkPoint {
  x: number;
  y: number;
  pressure?: number;
  t?: number;
}

export interface InkStroke {
  points: InkPoint[];
  color?: string;
  width?: number;
}

export interface LiveTaskSummary {
  id: string;
  title: string;
  status: string;
  priority: number;
  assigneeType: string;
  prUrl?: string | null;
}

export interface ArchivedNodeSnapshot {
  id: string;
  type: CanvasNodeType;
  status: CanvasNodeStatus;
  title: string;
  content: Record<string, unknown>;
  position: CanvasPoint;
  size: CanvasSize;
  parentId: string | null;
  metadata: Record<string, unknown>;
}

export interface ArchivedEdgeSnapshot {
  id: string;
  sourceId: string;
  targetId: string;
  type: CanvasEdgeType;
  weight: number;
  label: string;
  metadata: Record<string, unknown>;
}

export interface CanvasSummary {
  id: string;
  name: string;
  description: string;
  viewport: CanvasViewport;
  isArchived: boolean;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasNode {
  id: string;
  canvasId: string;
  type: CanvasNodeType;
  status: CanvasNodeStatus;
  title: string;
  content: Record<string, unknown>;
  position: CanvasPoint;
  size: CanvasSize;
  parentId: string | null;
  metadata: Record<string, unknown>;
  embeddingSource: "remote" | "local" | null;
  hasEmbedding: boolean;
  liveTask?: LiveTaskSummary | null;
  reciprocalNode?: CanvasNode;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string;
  canvasId: string;
  sourceId: string;
  targetId: string;
  type: CanvasEdgeType;
  weight: number;
  label: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CanvasDetail {
  canvas: CanvasSummary;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface ExternalMemoryMatch {
  id: string;
  kind: "company_idea" | "briefing";
  title: string;
  snippet: string;
  href: string;
  similarity: number;
}

export interface KnowledgeCanvasHooks {
  searchExternalMemory?: (
    queryVector: number[],
    queryText: string,
    limit: number,
  ) => ExternalMemoryMatch[];
  createTaskFromNode?: (input: {
    title: string;
    description: string;
    project?: string;
    sourceRef: string;
  }) => { id: string; status: string; priority: number };
  getTaskSummary?: (taskId: string) => LiveTaskSummary | null;
  archiveToCompanyNote?: (input: {
    title: string;
    markdown: string;
    reference: string;
  }) => { id: string } | void;
}

export interface CreateCanvasInput {
  name: string;
  description?: string;
  viewport?: Partial<CanvasViewport>;
}

export interface UpdateCanvasInput {
  name?: string;
  description?: string;
  viewport?: Partial<CanvasViewport>;
  isArchived?: boolean;
}

export interface CreateNodeInput {
  type: CanvasNodeType;
  status?: CanvasNodeStatus;
  title: string;
  content?: Record<string, unknown>;
  position?: CanvasPoint;
  size?: CanvasSize;
  parentId?: string | null;
  metadata?: Record<string, unknown>;
  targetCanvasId?: string;
  bidirectional?: boolean;
}

export interface UpdateNodeInput {
  title?: string;
  content?: Record<string, unknown>;
  position?: CanvasPoint;
  size?: CanvasSize;
  status?: CanvasNodeStatus;
  parentId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PromoteNodeTaskInput {
  project?: string;
}

export interface ExpandSpaceInput {
  axis: "x" | "y";
  origin: number;
  delta: number;
}

export interface ExpandSpaceResult {
  axis: "x" | "y";
  origin: number;
  delta: number;
  movedCount: number;
  movedNodes: Array<{ id: string; position: CanvasPoint }>;
}

export interface CreateEdgeInput {
  sourceId: string;
  targetId: string;
  type?: CanvasEdgeType;
  weight?: number;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface SemanticSearchOptions {
  topK?: number;
  threshold?: number;
  includeAllCanvases?: boolean;
}

export interface SemanticSearchResultItem {
  canvasId: string | null;
  canvasName: string;
  nodeId: string;
  title: string;
  snippet: string;
  type: CanvasNodeType | "company_idea" | "briefing";
  score: number;
  sourceKind: "canvas_node" | "company_idea" | "briefing";
  href: string;
  position?: CanvasPoint;
}

export interface SemanticSearchResult {
  query: string;
  embeddingSource: "remote" | "local";
  results: SemanticSearchResultItem[];
}

export interface AutoLinkResult {
  threshold: number;
  created: number;
  edges: CanvasEdge[];
}

export interface OcrRecognizeInput {
  imageUrl?: string;
  imageBase64?: string;
  strokes?: InkStroke[];
  hintText?: string;
  caption?: string;
}

export interface OcrBlock {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface OcrRecognizeResult {
  text: string;
  mode: "remote_ocr" | "local_ink_analyzer";
  confidence: number;
  blocks: OcrBlock[];
  stats: {
    strokeCount: number;
    pointCount: number;
    lineGroupCount: number;
    bbox: { x: number; y: number; width: number; height: number } | null;
  };
  providerDetail?: string;
}

export interface ArchiveTombstoneInput {
  nodeIds: string[];
  title?: string;
}

export interface ArchiveTombstoneResult {
  tombstone: CanvasNode;
  markdown: string;
  archivedCount: number;
  removedNodeIds: string[];
  companyNoteId?: string;
  summarySource: "llm" | "builtin";
}

export interface RestoreTombstoneResult {
  tombstoneId: string;
  restoredNodes: CanvasNode[];
  restoredEdges: CanvasEdge[];
}

export interface BriefingIslandItem {
  id: string;
  source: string;
  summary: string;
  tags: string[];
  score?: number | null;
}

export interface BriefingIslandResult {
  nodes: CanvasNode[];
  semanticEdges: CanvasEdge[];
}

export interface CrossCanvasVectorMatch {
  canvasId: string;
  canvasName: string;
  nodeId: string;
  title: string;
  type: CanvasNodeType;
  snippet: string;
  score: number;
  href: string;
}

export interface CanvasExportResult {
  canvasId: string;
  canvasName: string;
  filename: string;
  markdown: string;
  nodeCount: number;
  edgeCount: number;
  exportedAt: string;
}
