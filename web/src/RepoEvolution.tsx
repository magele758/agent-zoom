import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { IndexedRepo, RepoContent } from "../../src/activity-index-types";
import {
  ARCHITECTURE_CONSOLIDATION_KIND_LABELS,
  ARCHITECTURE_CONSTRAINT_CATEGORY_LABELS,
  ARCHITECTURE_PRIMITIVE_STATUS_LABELS,
  PARADIGM_VERDICT_LABELS,
  REPO_ABSORPTION_STATUS_LABELS,
  REPO_AUTOMATION_MODE_LABELS,
  REPO_CODE_LAYER_COLORS,
  REPO_CODE_LAYER_LABELS,
  REPO_EVOLUTION_EVENT_LABELS,
  REPO_RELATION_LABELS,
  REPO_VITALITY_LABELS,
  type AnalyzeLinkResult,
  type ArchitectureClusterRecommendation,
  type ArchitectureCodeMapRef,
  type ArchitectureConsolidationItem,
  type ArchitectureDistillationRun,
  type ArchitectureEvidenceRef,
  type ArchitecturePrimitive,
  type ArchitecturePrimitiveExportJson,
  type ArchitecturePrimitiveStatus,
  type BatchUpdateRepoNodesInput,
  type BatchUpdateRepoNodesResult,
  type ClusterAndRecallResult,
  type CompareRepoToPrimitiveResult,
  type DistillArchitecturePrimitiveResult,
  type GenerateCodeMapResponse,
  type GetCodeMapResponse,
  type ImportGithubListsResult,
  type ProjectPrimitiveToCanvasResult,
  type PromoteLinkToOpportunityResult,
  type RepoAbsorptionEvent,
  type RepoAbsorptionLink,
  type RepoAbsorptionStatus,
  type RepoCodeLayer,
  type RepoCodeMap,
  type RepoCodeMapBrief,
  type RepoCodeMapHotspot,
  type RepoDomain,
  type RepoDomainCluster,
  type RepoEvolutionAutomationMode,
  type RepoEvolutionConfig,
  type RepoEvolutionContentSearchResult,
  type RepoEvolutionEventType,
  type RepoEvolutionMacroGraph,
  type RepoEvolutionNode,
  type RepoEvolutionNodesPage,
  type RepoEvolutionRadialGraph,
  type RepoEvolutionSyncJob,
  type RepoEvolutionSyncPhase,
  type RepoEvolutionTimelinePage,
  type RepoModuleAnalysisItem,
  type RepoModuleEffort,
  type RepoModuleRisk,
  type RepoNodeBucketFilter,
  type RepoNodeSortBy,
  type RepoRadialDomainNode,
  type RepoRadialLink,
  type RepoRadialOwnedNode,
  type RepoRadialStarNode,
  type RepoRelationType,
  type RepoVisibility,
  type RepoVitality,
  type SubmitConsolidationResult,
  type SubmitLinkToMailboxResult,
} from "../../src/repo-evolution-types";
import { request } from "./api";
import { RepositoryIndexContent } from "./RepositoryIndexContent";
import "./repo-evolution.css";

const API_BASE = "/api/opc/repo-evolution";
const UNASSIGNED_DOMAIN_ID = "__unassigned_owned__";
const DEFAULT_STARS_PER_OWNED = 12;
const CORE_RADIUS = 72;

type MainTab = "graph" | "domains" | "timeline" | "architecture";
type HaloTheme = "cosmic" | "washi";
type InspectorMode = "none" | "domain" | "node" | "link" | "floating";

interface NodeDetailResponse {
  node: RepoEvolutionNode;
  outgoingLinks: RepoAbsorptionLink[];
  incomingLinks: RepoAbsorptionLink[];
}

interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface RadialSectorModel {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  isSynthetic: boolean;
  domain: RepoRadialDomainNode | null;
  ownedNodes: RepoRadialOwnedNode[];
  ownedCount: number;
  linkedStarCount: number;
  domainStarCount: number;
  pendingReviewCount: number;
  hasSpotlight: boolean;
}

interface PositionedSector {
  sector: RadialSectorModel;
  startAngle: number;
  endAngle: number;
  midAngle: number;
  x: number;
  y: number;
  r: number;
  expandedL2: boolean;
  hasExpandedL3: boolean;
}

interface PositionedOwned {
  node: RepoRadialOwnedNode;
  sectorId: string;
  angle: number;
  r: number;
  x: number;
  y: number;
  expandedL3: boolean;
  shownStarCount: number;
  moreStarCount: number;
}

interface PositionedStar {
  node: RepoRadialStarNode;
  anchorOwnedId: string;
  sectorId: string;
  angle: number;
  r: number;
  subOrbit: number;
  x: number;
  y: number;
  visibleTargetIds: string[];
}

interface PositionedMorePill {
  id: string;
  owned: RepoRadialOwnedNode;
  sectorId: string;
  moreCount: number;
  localHidden: number;
  serverTruncated: number;
  angle: number;
  r: number;
  subOrbit: number;
  x: number;
  y: number;
}

interface PositionedRadialLink {
  link: RepoRadialLink;
  d: string;
  midX: number;
  midY: number;
  isLongArc: boolean;
}

const DOMAIN_COLORS = [
  "#2b4e3c",
  "#483d82",
  "#9c3a21",
  "#246874",
  "#b9751d",
  "#6b4e71",
  "#3d6442",
  "#38567a",
  "#8a5a36",
  "#4f5d54",
];

const SYNC_PHASE_LABELS: Record<RepoEvolutionSyncPhase, string> = {
  init: "初始化连接",
  owned_repos: "拉取自有公开/私有仓",
  star_lists: "拉取 GitHub Star Lists",
  starred_repos: "分页拉取 Star 仓库",
  embedding: "计算语义向量与活性",
  done: "同步完成",
  error: "同步中断",
};

const RELATION_KEYS = Object.keys(REPO_RELATION_LABELS) as RepoRelationType[];
const STATUS_KEYS = Object.keys(REPO_ABSORPTION_STATUS_LABELS) as RepoAbsorptionStatus[];
const EVENT_KEYS = Object.keys(REPO_EVOLUTION_EVENT_LABELS) as RepoEvolutionEventType[];

const POOL_BUCKET_ITEMS: Array<{ id: RepoNodeBucketFilter; label: string; statKey?: keyof RepoEvolutionMacroGraph["stats"] }> = [
  { id: "all", label: "全部仓库" },
  { id: "spotlight", label: "重点关注 (ai-agent-node 等)", statKey: "spotlightCount" },
  { id: "owned", label: "我的开源库（含私有）", statKey: "ownedCount" },
  { id: "unclassified", label: "未归类池", statKey: "unclassifiedCount" },
  { id: "classified_unlinked", label: "已归类未连线", statKey: "classifiedUnlinkedCount" },
  { id: "stale_pool", label: "陈旧沉淀池", statKey: "stalePoolCount" },
  { id: "floating", label: "游离散落总池", statKey: "floatingPoolCount" },
  { id: "ai_suggested", label: "AI 待确认建议", statKey: "aiSuggestedCount" },
  { id: "linked", label: "已建立吸收边" },
];

const DOMAIN_ICON_MAP: Record<string, string> = {
  bot: "🤖",
  code: "⌘",
  brain: "🧠",
  globe: "🌐",
  film: "🎬",
  chart: "📊",
  terminal: "⌨",
  database: "⛁",
  layout: "❖",
  shield: "🛡",
  cpu: "⚡",
  bookmark: "🔖",
  layers: "▤",
};

function formatDomainIcon(icon?: string | null): string {
  if (!icon) return "◈";
  const key = icon.trim().toLowerCase();
  if (!key) return "◈";
  if (DOMAIN_ICON_MAP[key]) return DOMAIN_ICON_MAP[key];
  if (/^[a-z0-9_-]+$/i.test(key)) return "◈";
  return icon.trim();
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function safeExternalUrl(raw?: string | null): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || u.protocol === "http:") return u.href;
  } catch {
    // ignore invalid URL
  }
  return "";
}

function formatStars(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("zh-CN", { year: "2-digit", month: "2-digit", day: "2-digit" });
}

function formatTimeFull(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 按视觉字符宽度截断（中文/全角计 1.75，ASCII 计 1），确保 SVG 胶囊内文本绝不溢出边界。
 */
function truncateVisual(text: string, maxUnits: number): string {
  let units = 0;
  let cutIdx = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const w = code > 0x2e7f ? 1.75 : 1;
    if (units + w > maxUnits) {
      cutIdx = Math.max(1, i - 1);
      return `${text.slice(0, cutIdx)}…`;
    }
    units += w;
  }
  return text;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function polar(r: number, angle: number): { x: number; y: number } {
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

/**
 * 为深空星夜主题适度提亮低明度领域色标，确保在暗底画布上有清晰发光轮廓与高对比度。
 */
function resolveDomainAccent(hex: string | null | undefined, theme: HaloTheme): string {
  const raw = (hex || "#2b4e3c").trim();
  if (theme === "washi") return raw;
  const m = /^#([0-9a-f]{6})$/i.exec(raw);
  if (!m) return "#60a5fa";
  const intVal = parseInt(m[1], 16);
  const r = ((intVal >> 16) & 255) / 255;
  const g = ((intVal >> 8) & 255) / 255;
  const b = (intVal & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  const boostedS = Math.max(54, Math.min(82, Math.round(s * 100 + 20)));
  const boostedL = Math.max(60, Math.min(72, Math.round(l * 100 + 28)));
  return `hsl(${Math.round(h)}, ${boostedS}%, ${boostedL}%)`;
}

function edgeStatusVisual(
  status: RepoAbsorptionStatus,
  theme: HaloTheme,
): { stroke: string; dash?: string; width: number; markerId: string } {
  if (theme === "cosmic") {
    switch (status) {
      case "suggested":
        return { stroke: "#f59e0b", dash: "6 4", width: 1.85, markerId: "re-arrow-c-amber" };
      case "in_review":
        return { stroke: "#a78bfa", width: 2.5, markerId: "re-arrow-c-violet" };
      case "approved":
        return { stroke: "#34d399", width: 2.45, markerId: "re-arrow-c-emerald" };
      case "absorbing":
        return { stroke: "#2dd4bf", width: 2.7, markerId: "re-arrow-c-emerald" };
      case "absorbed":
        return { stroke: "#10b981", width: 2.9, markerId: "re-arrow-c-emerald" };
      case "watching":
        return { stroke: "#94a3b8", dash: "4 3", width: 1.55, markerId: "re-arrow-c-slate" };
      case "rejected":
        return { stroke: "#f87171", dash: "2 3", width: 1.4, markerId: "re-arrow-c-rose" };
    }
  }
  switch (status) {
    case "suggested":
      return { stroke: "#b9751d", dash: "6 4", width: 1.9, markerId: "re-arrow-w-amber" };
    case "in_review":
      return { stroke: "#483d82", width: 2.5, markerId: "re-arrow-w-indigo" };
    case "approved":
      return { stroke: "#2a6b48", width: 2.45, markerId: "re-arrow-w-pine" };
    case "absorbing":
      return { stroke: "#1f7a53", width: 2.7, markerId: "re-arrow-w-pine" };
    case "absorbed":
      return { stroke: "#1c5e3a", width: 2.9, markerId: "re-arrow-w-pine" };
    case "watching":
      return { stroke: "#7b847d", dash: "4 3", width: 1.55, markerId: "re-arrow-w-gray" };
    case "rejected":
      return { stroke: "#b05a4c", dash: "2 3", width: 1.4, markerId: "re-arrow-w-rust" };
  }
}

/**
 * 扇区环形光晕路径（环形扇片 R_in -> R_out）
 */
function annularSectorPath(rIn: number, rOut: number, startAngle: number, endAngle: number): string {
  const span = Math.max(0.01, endAngle - startAngle);
  if (span >= Math.PI * 1.995) {
    // Full ring fallback
    return [
      `M ${rOut} 0 A ${rOut} ${rOut} 0 1 1 ${-rOut} 0 A ${rOut} ${rOut} 0 1 1 ${rOut} 0 Z`,
      `M ${rIn} 0 A ${rIn} ${rIn} 0 1 0 ${-rIn} 0 A ${rIn} ${rIn} 0 1 0 ${rIn} 0 Z`,
    ].join(" ");
  }
  const largeArc = span > Math.PI ? 1 : 0;
  const p1 = polar(rOut, startAngle);
  const p2 = polar(rOut, endAngle);
  const p3 = polar(rIn, endAngle);
  const p4 = polar(rIn, startAngle);
  return [
    `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`,
    `A ${rOut.toFixed(1)} ${rOut.toFixed(1)} 0 ${largeArc} 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    `L ${p3.x.toFixed(1)} ${p3.y.toFixed(1)}`,
    `A ${rIn.toFixed(1)} ${rIn.toFixed(1)} 0 ${largeArc} 0 ${p4.x.toFixed(1)} ${p4.y.toFixed(1)}`,
    "Z",
  ].join(" ");
}

/**
 * R1 -> R2 柔和径向曲线
 */
function radialBranchCurve(
  fromR: number,
  fromAngle: number,
  toR: number,
  toAngle: number,
): string {
  const p1 = polar(fromR, fromAngle);
  const p2 = polar(toR, toAngle);
  const midR = fromR + (toR - fromR) * 0.52;
  const c1 = polar(midR, fromAngle);
  const c2 = polar(midR, toAngle);
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}

/**
 * R3 Star -> R2 Owned 吸收曲线：
 * - 同扇区短角度：平滑径向内收 S 曲线
 * - 跨扇区 1 对 N：沿 R2–R3 轨道走廊优雅弧线绕行，绝不杂乱斜穿中心核与第一层领域环！
 */
function orbitalAbsorptionCurve(
  star: PositionedStar,
  owned: PositionedOwned,
  r2Outer: number,
  r3Base: number,
): { d: string; midX: number; midY: number; isLongArc: boolean } {
  const dTheta = wrapAngle(owned.angle - star.angle);
  const absTheta = Math.abs(dTheta);
  const p1 = { x: star.x, y: star.y };
  const p2 = { x: owned.x, y: owned.y };

  if (absTheta <= 0.42) {
    const midR = owned.r + (star.r - owned.r) * 0.52;
    const c1 = polar(midR, star.angle);
    const c2 = polar(midR, owned.angle);
    const midX = 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x;
    const midY = 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y;
    return {
      d: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
      midX,
      midY,
      isLongArc: false,
    };
  }

  // Cross-sector orbital corridor curve
  const corridorR = Math.max(r2Outer + 66, (r2Outer + r3Base) * 0.52 + Math.min(48, absTheta * 20));
  const c1 = polar(corridorR, star.angle + dTheta * 0.32);
  const c2 = polar(corridorR, star.angle + dTheta * 0.68);
  const midX = 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x;
  const midY = 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y;
  return {
    d: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    midX,
    midY,
    isLongArc: true,
  };
}

/**
 * 将高优先级/重点仓库安排在扇区视觉中轴位置
 */
function arrangeCenterWeighted<T>(items: T[]): T[] {
  if (items.length <= 2) return items;
  const out: T[] = new Array(items.length);
  const mid = Math.floor(items.length / 2);
  out[mid] = items[0];
  let offset = 1;
  let idx = 1;
  while (idx < items.length) {
    if (mid - offset >= 0 && idx < items.length) {
      out[mid - offset] = items[idx++];
    }
    if (mid + offset < items.length && idx < items.length) {
      out[mid + offset] = items[idx++];
    }
    offset++;
  }
  return out;
}

/**
 * 检测一组同尺寸卡片中心点是否存在任意 AABB 重叠（严格按真实卡片宽高 + 安全外边距校验，杜绝上下与 45° 斜角压边）。
 */
function hasAabbOverlap(
  coords: Array<{ x: number; y: number }>,
  boxW: number,
  boxH: number,
): boolean {
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const a = coords[i];
    for (let j = i + 1; j < n; j++) {
      const b = coords[j];
      if (Math.abs(a.x - b.x) < boxW && Math.abs(a.y - b.y) < boxH) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 水平矩形卡片 (boxW × boxH) 在圆环半径 r、角度 midAngle 处防碰撞所需的精确各向异性最小角距：
 * 水平卡片在左右侧翼（3/9 点）仅需约 boxH/r 弧长，在上下极点（12/6 点）需约 boxW/r 弧长，
 * 相比等距圆弧可将整环半径压缩约 2–3 倍同时保持严格 0 重叠。
 */
function anisotropicGapRad(midAngle: number, r: number, boxW: number, boxH: number): number {
  const absSin = Math.abs(Math.sin(midAngle));
  const absCos = Math.abs(Math.cos(midAngle));
  const reqX = absSin > 0.015 ? boxW / (r * absSin) : Math.PI;
  const reqY = absCos > 0.015 ? boxH / (r * absCos) : Math.PI;
  return Math.min(Math.PI * 0.45, Math.min(reqX, reqY) * 1.07);
}

/**
 * 在单个同心圆环上按各向异性 AABB 间距松弛角度，严格保证 0 重叠并贴近目标角度。
 */
function packSingleOrbitAnisotropic(params: {
  targetAngles: number[];
  initialR: number;
  boxW: number;
  boxH: number;
  radiusIncrement?: number;
}): {
  r: number;
  angles: number[];
  coords: Array<{ x: number; y: number; r: number; angle: number }>;
} {
  const { targetAngles, initialR, boxW, boxH, radiusIncrement = 22 } = params;
  const n = targetAngles.length;
  const twoPi = Math.PI * 2;
  if (n === 0) return { r: initialR, angles: [], coords: [] };
  if (n === 1) {
    const pt = polar(initialR, targetAngles[0]);
    return {
      r: initialR,
      angles: [targetAngles[0]],
      coords: [{ x: pt.x, y: pt.y, r: initialR, angle: targetAngles[0] }],
    };
  }

  // Exact analytical single-ring capacity density for horizontal boxW × boxH cards:
  // ∫_0^{2π} max(|sin θ|/W, |cos θ|/H) dθ = 4 * (sin(θ0)/H + cos(θ0)/W), where tan(θ0) = W/H
  const theta0 = Math.atan2(boxW, boxH);
  const densityPerPx = 4 * (Math.sin(theta0) / boxH + Math.cos(theta0) / boxW);
  const analyticalMinR = Math.ceil((n * 1.14) / densityPerPx);

  let r = Math.max(initialR, analyticalMinR);
  const targets = [...targetAngles];

  for (let attempt = 0; attempt < 36; attempt++) {
    const angles = [...targets];
    // Initial monotonic separation using local anisotropic gap
    for (let i = 1; i < n; i++) {
      const mid = (angles[i - 1] + angles[i]) * 0.5;
      const g = anisotropicGapRad(mid, r, boxW, boxH);
      if (angles[i] < angles[i - 1] + g) angles[i] = angles[i - 1] + g;
    }
    const avgDiff = angles.reduce((acc, a, i) => acc + (a - targets[i]), 0) / n;
    for (let i = 0; i < n; i++) angles[i] -= avgDiff;

    const projectAnisotropic = () => {
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const a1 = angles[i];
        const a2 = next === 0 ? angles[0] + twoPi : angles[next];
        const gap = a2 - a1;
        const mid = (a1 + a2) * 0.5;
        const req = anisotropicGapRad(mid, r, boxW, boxH);
        if (gap < req) {
          const push = (req - gap) * 0.53;
          angles[i] -= push;
          angles[next] += push;
        }
      }
    };

    const spring = attempt === 0 ? 0.08 : attempt < 4 ? 0.03 : 0.008;
    for (let iter = 0; iter < 28; iter++) {
      for (let i = 0; i < n; i++) {
        angles[i] += (targets[i] - angles[i]) * spring;
      }
      projectAnisotropic();
    }
    for (let pass = 0; pass < 22; pass++) {
      projectAnisotropic();
    }

    const coords = angles.map((angle) => {
      const pt = polar(r, angle);
      return { x: pt.x, y: pt.y, r, angle };
    });

    if (!hasAabbOverlap(coords, boxW, boxH)) {
      return { r, angles, coords };
    }

    r += radiusIncrement;
  }

  // Final guaranteed-safe spacing along anisotropic arc-length parameterization
  const stepAngles: number[] = [];
  const totalSlots = n;
  const start = targets[0];
  let accAngle = start;
  for (let i = 0; i < totalSlots; i++) {
    stepAngles.push(accAngle);
    accAngle += anisotropicGapRad(accAngle, r, boxW, boxH);
  }
  const span = Math.max(0.01, accAngle - start);
  const scale = twoPi / span;
  const finalAngles = stepAngles.map((a) => start + (a - start) * scale);
  const finalCoords = finalAngles.map((angle) => {
    const pt = polar(r, angle);
    return { x: pt.x, y: pt.y, r, angle };
  });
  return { r, angles: finalAngles, coords: finalCoords };
}

/**
 * 面向多子轨圆环的确定性 0-AABB 重叠求解器：
 * 1. 相邻子轨径向步距严格 >= hypot(boxW, boxH) + 6，从欧氏几何上彻底杜绝任何跨子轨 45° 斜角压边；
 * 2. 每条子轨独立执行各向异性 AABB 角度松弛（3/9 点紧凑、12/6 点舒展），既极度紧凑清晰又严格 0 重叠！
 */
function solveCollisionFreeMultiOrbit(params: {
  targetAngles: number[];
  initialRBase: number;
  numSubOrbits: number;
  boxW: number;
  boxH: number;
  radiusIncrement: number;
}): {
  rBase: number;
  radii: number[];
  angles: number[];
  subOrbits: number[];
  coords: Array<{ x: number; y: number; r: number; angle: number; subOrbit: number }>;
} {
  const { targetAngles, initialRBase, numSubOrbits, boxW, boxH, radiusIncrement } = params;
  const n = targetAngles.length;

  if (n === 0) {
    return { rBase: initialRBase, radii: [], angles: [], subOrbits: [], coords: [] };
  }

  // Euclidean diagonal-proof inter-orbit radial step: guarantees |Δx| >= boxW OR |Δy| >= boxH at EVERY angle θ!
  const orbitStep = Math.ceil(Math.hypot(boxW, boxH)) + 6;
  const kCount = Math.max(1, Math.min(numSubOrbits, n));

  if (n === 1) {
    const pt = polar(initialRBase, targetAngles[0]);
    return {
      rBase: initialRBase,
      radii: [initialRBase],
      angles: [targetAngles[0]],
      subOrbits: [0],
      coords: [{ x: pt.x, y: pt.y, r: initialRBase, angle: targetAngles[0], subOrbit: 0 }],
    };
  }

  // Partition items cyclically across the K concentric sub-orbits so every sector distributes cleanly across tracks
  const bucketIndices: number[][] = Array.from({ length: kCount }, () => []);
  for (let i = 0; i < n; i++) {
    bucketIndices[i % kCount].push(i);
  }

  // First pack innermost orbit (track 0) to determine the tightest collision-free inner radius rBase
  const innerPacked = packSingleOrbitAnisotropic({
    targetAngles: bucketIndices[0].map((idx) => targetAngles[idx]),
    initialR: initialRBase,
    boxW,
    boxH,
    radiusIncrement,
  });

  let rBase = innerPacked.r;
  const radii: number[] = [];
  const outAngles = new Array<number>(n);
  const outSubOrbits = new Array<number>(n);
  const outCoords = new Array<{ x: number; y: number; r: number; angle: number; subOrbit: number }>(n);

  // Pack each sub-orbit at r_k >= rBase + k * orbitStep (outer orbits strictly stay >= orbitStep outside inner ones!)
  let prevR = rBase - orbitStep;
  for (let k = 0; k < kCount; k++) {
    const idxs = bucketIndices[k];
    const minOrbitR = k === 0 ? rBase : prevR + orbitStep;
    const packed =
      k === 0
        ? innerPacked
        : packSingleOrbitAnisotropic({
            targetAngles: idxs.map((idx) => targetAngles[idx]),
            initialR: minOrbitR,
            boxW,
            boxH,
            radiusIncrement,
          });
    prevR = packed.r;
    radii.push(packed.r);
    idxs.forEach((origIdx, j) => {
      const c = packed.coords[j];
      outAngles[origIdx] = c.angle;
      outSubOrbits[origIdx] = k;
      outCoords[origIdx] = { ...c, subOrbit: k };
    });
  }

  return {
    rBase: radii[0] ?? rBase,
    radii,
    angles: outAngles,
    subOrbits: outSubOrbits,
    coords: outCoords,
  };
}

/**
 * 计算完整的三层同心光环大 Graph 几何布局
 */
function computeRadialHaloLayout(params: {
  radialGraph: RepoEvolutionRadialGraph | null;
  expandedDomainIds: Set<string>;
  expandedOwnedIds: Set<string>;
  ownedStarCaps: Record<string, number>;
}) {
  const { radialGraph, expandedDomainIds, expandedOwnedIds, ownedStarCaps } = params;

  const emptyBounds: WorldBounds = { minX: -320, maxX: 320, minY: -320, maxY: 320 };
  if (!radialGraph) {
    return {
      r1: 215,
      r2: 420,
      r2Outer: 420,
      r2Radii: [] as number[],
      r3Radii: [] as number[],
      hasL2: false,
      hasL3: false,
      sectors: [] as PositionedSector[],
      sectorMap: new Map<string, PositionedSector>(),
      ownedList: [] as PositionedOwned[],
      ownedMap: new Map<string, PositionedOwned>(),
      starList: [] as PositionedStar[],
      starMap: new Map<string, PositionedStar>(),
      morePills: [] as PositionedMorePill[],
      links: [] as PositionedRadialLink[],
      floatingAnchor: { x: 280, y: 240, r: 368, angle: Math.PI * 0.24 },
      bounds: emptyBounds,
    };
  }

  const domainIdSet = new Set(radialGraph.domains.map((d) => d.id));
  const ownedBySector = new Map<string, RepoRadialOwnedNode[]>();
  const unassignedOwned: RepoRadialOwnedNode[] = [];

  for (const owned of radialGraph.ownedNodes) {
    if (owned.primaryDomainId && domainIdSet.has(owned.primaryDomainId)) {
      const arr = ownedBySector.get(owned.primaryDomainId) ?? [];
      arr.push(owned);
      ownedBySector.set(owned.primaryDomainId, arr);
    } else {
      unassignedOwned.push(owned);
    }
  }

  const sortOwned = (list: RepoRadialOwnedNode[]) =>
    arrangeCenterWeighted(
      [...list].sort((a, b) => {
        const spotA = a.priorityTier === "spotlight" ? 1 : 0;
        const spotB = b.priorityTier === "spotlight" ? 1 : 0;
        if (spotA !== spotB) return spotB - spotA;
        if (a.isFork !== b.isFork) return a.isFork ? 1 : -1;
        if (a.totalStarCount !== b.totalStarCount) return b.totalStarCount - a.totalStarCount;
        if (a.starsCount !== b.starsCount) return b.starsCount - a.starsCount;
        return a.name.localeCompare(b.name);
      }),
    );

  const sectorModels: RadialSectorModel[] = radialGraph.domains.map((d) => {
    const ownedList = sortOwned(ownedBySector.get(d.id) ?? []);
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      color: d.color || "#2b4e3c",
      icon: d.icon,
      isSynthetic: false,
      domain: d,
      ownedNodes: ownedList,
      ownedCount: ownedList.length,
      linkedStarCount: d.linkedStarCount,
      domainStarCount: d.domainStarCount,
      pendingReviewCount: d.pendingReviewCount,
      hasSpotlight: d.hasSpotlight || ownedList.some((o) => o.priorityTier === "spotlight"),
    };
  });

  if (unassignedOwned.length > 0) {
    const sortedUnassigned = sortOwned(unassignedOwned);
    sectorModels.push({
      id: UNASSIGNED_DOMAIN_ID,
      name: "待归类自有库",
      description: "尚未指定技术领域的自有开源库，可点击节点在右侧检视抽屉中快速归类。",
      color: "#64748b",
      icon: "◌",
      isSynthetic: true,
      domain: null,
      ownedNodes: sortedUnassigned,
      ownedCount: sortedUnassigned.length,
      linkedStarCount: sortedUnassigned.reduce((s, o) => s + o.linkedStarCount, 0),
      domainStarCount: 0,
      pendingReviewCount: sortedUnassigned.reduce((s, o) => s + o.inReviewCount, 0),
      hasSpotlight: sortedUnassigned.some((o) => o.priorityTier === "spotlight"),
    });
  }

  // Index stars and links for quick lookup
  const starById = new Map<string, RepoRadialStarNode>();
  for (const s of radialGraph.starNodes) starById.set(s.id, s);

  const linksByOwned = new Map<string, RepoRadialLink[]>();
  for (const l of radialGraph.links) {
    const arr = linksByOwned.get(l.ownedNodeId) ?? [];
    arr.push(l);
    linksByOwned.set(l.ownedNodeId, arr);
  }
  const statusWeight = (st: RepoAbsorptionStatus) => {
    if (st === "in_review") return 5;
    if (st === "absorbed" || st === "absorbing" || st === "approved") return 4;
    if (st === "suggested") return 3;
    if (st === "watching") return 2;
    return 1;
  };
  for (const arr of linksByOwned.values()) {
    arr.sort((a, b) => {
      const sw = statusWeight(b.status) - statusWeight(a.status);
      if (sw !== 0) return sw;
      return b.strength - a.strength;
    });
  }

  // Determine which owned nodes are visible & expanded to L3
  const visibleOwnedSet = new Set<string>();
  const activeExpandedOwnedSet = new Set<string>();
  for (const sec of sectorModels) {
    if (!expandedDomainIds.has(sec.id)) continue;
    for (const o of sec.ownedNodes) {
      visibleOwnedSet.add(o.id);
      if (expandedOwnedIds.has(o.id)) {
        activeExpandedOwnedSet.add(o.id);
      }
    }
  }

  // Collect visible Ring 3 stars (deduplicated across 1-to-N targets) + per-owned local hidden counts
  const visibleStarIds = new Set<string>();
  const ownedShownCount = new Map<string, number>();
  const ownedLocalHidden = new Map<string, number>();

  for (const ownedId of activeExpandedOwnedSet) {
    const incoming = linksByOwned.get(ownedId) ?? [];
    const cap = ownedStarCaps[ownedId] ?? DEFAULT_STARS_PER_OWNED;
    let shown = 0;
    let hidden = 0;
    for (const link of incoming) {
      if (!starById.has(link.starNodeId)) continue;
      if (shown < cap) {
        visibleStarIds.add(link.starNodeId);
        shown++;
      } else {
        hidden++;
      }
    }
    ownedShownCount.set(ownedId, shown);
    ownedLocalHidden.set(ownedId, hidden);
  }

  // Assign each unique visible star to its primary expanded target owned repo
  const anchoredStarsByOwned = new Map<string, RepoRadialStarNode[]>();
  const visibleTargetsByStar = new Map<string, string[]>();

  for (const starId of visibleStarIds) {
    const star = starById.get(starId);
    if (!star) continue;
    const expandedTargets = star.targetOwnedIds.filter((oid) => activeExpandedOwnedSet.has(oid));
    // Fallback check from links in case targetOwnedIds omitted something
    if (expandedTargets.length === 0) {
      for (const l of radialGraph.links) {
        if (l.starNodeId === starId && activeExpandedOwnedSet.has(l.ownedNodeId) && !expandedTargets.includes(l.ownedNodeId)) {
          expandedTargets.push(l.ownedNodeId);
        }
      }
    }
    if (expandedTargets.length === 0) continue;
    const anchorOwnedId = expandedTargets[0];
    visibleTargetsByStar.set(starId, expandedTargets);
    const arr = anchoredStarsByOwned.get(anchorOwnedId) ?? [];
    arr.push(star);
    anchoredStarsByOwned.set(anchorOwnedId, arr);
  }

  // Recompute localHidden accurately (stars already visible via another expanded target aren't hidden!)
  for (const ownedId of activeExpandedOwnedSet) {
    const incoming = linksByOwned.get(ownedId) ?? [];
    let hidden = 0;
    let shown = 0;
    for (const link of incoming) {
      if (!starById.has(link.starNodeId)) continue;
      if (visibleStarIds.has(link.starNodeId)) shown++;
      else hidden++;
    }
    ownedShownCount.set(ownedId, shown);
    ownedLocalHidden.set(ownedId, hidden);
  }

  // Sector angular span weights (keep collapsed sectors spacious enough to avoid compressing Ring 1!)
  const rawWeights = sectorModels.map((sec) => {
    const expL2 = expandedDomainIds.has(sec.id);
    if (!expL2) return 1.5;
    let starWeight = 0;
    for (const o of sec.ownedNodes) {
      if (activeExpandedOwnedSet.has(o.id)) {
        const cnt = (anchoredStarsByOwned.get(o.id)?.length ?? 0) + ((ownedLocalHidden.get(o.id) ?? 0) + o.truncatedStarCount > 0 ? 1 : 0);
        starWeight += cnt;
      }
    }
    return 1.5 + Math.max(0.3, sec.ownedNodes.length * 0.48) + starWeight * 0.16;
  });

  const D = sectorModels.length;
  const twoPi = Math.PI * 2;
  const minSectorAngle = D > 0 ? Math.min(0.48, twoPi / Math.max(1, D * 1.24)) : twoPi;

  const sectorSpans: number[] = new Array(D).fill(0);
  if (D === 1) {
    sectorSpans[0] = twoPi;
  } else if (D > 1) {
    const fixed = new Array<boolean>(D).fill(false);
    let remainingRad = twoPi;
    for (let pass = 0; pass < D; pass++) {
      let freeWeight = 0;
      for (let i = 0; i < D; i++) {
        if (!fixed[i]) freeWeight += rawWeights[i];
      }
      let anyFloored = false;
      for (let i = 0; i < D; i++) {
        if (fixed[i]) continue;
        const proposed = freeWeight > 0 ? (rawWeights[i] / freeWeight) * remainingRad : remainingRad / D;
        if (proposed < minSectorAngle) {
          sectorSpans[i] = minSectorAngle;
          fixed[i] = true;
          remainingRad -= minSectorAngle;
          anyFloored = true;
        }
      }
      if (!anyFloored) {
        for (let i = 0; i < D; i++) {
          if (!fixed[i]) {
            sectorSpans[i] = freeWeight > 0 ? (rawWeights[i] / freeWeight) * remainingRad : remainingRad / D;
          }
        }
        break;
      }
    }
  }

  // Pack Ring 1 using exact anisotropic AABB packing (178×60 + 16px breathing margin = 194×74)
  // so 12 domains sit compactly (~R1 265–310px) with strictly 0 overlaps at top/bottom/flanks!
  const r1RawMids: number[] = [];
  let cursor = -Math.PI / 2;
  for (let i = 0; i < D; i++) {
    const start = cursor;
    const end = cursor + sectorSpans[i];
    r1RawMids.push((start + end) / 2);
    cursor = end;
  }

  const r1Packed = packSingleOrbitAnisotropic({
    targetAngles: r1RawMids,
    initialR: D <= 1 ? 210 : 255,
    boxW: 194,
    boxH: 74,
    radiusIncrement: 18,
  });
  const r1 = r1Packed.r;

  // Derive clean non-overlapping sector boundaries from packed Ring 1 angles
  const sectors: PositionedSector[] = [];
  const sectorMap = new Map<string, PositionedSector>();

  for (let i = 0; i < D; i++) {
    const sec = sectorModels[i];
    const midAngle = r1Packed.angles[i];
    const prevAngle = i === 0 ? r1Packed.angles[D - 1] - twoPi : r1Packed.angles[i - 1];
    const nextAngle = i === D - 1 ? r1Packed.angles[0] + twoPi : r1Packed.angles[i + 1];
    const startAngle = D === 1 ? -Math.PI / 2 : (prevAngle + midAngle) / 2;
    const endAngle = D === 1 ? Math.PI * 1.5 : (midAngle + nextAngle) / 2;
    const pt = r1Packed.coords[i];
    const expandedL2 = expandedDomainIds.has(sec.id) && sec.ownedNodes.length > 0;
    const hasExpandedL3 = expandedL2 && sec.ownedNodes.some((o) => activeExpandedOwnedSet.has(o.id));
    const item: PositionedSector = {
      sector: sec,
      startAngle,
      endAngle,
      midAngle,
      x: pt.x,
      y: pt.y,
      r: r1,
      expandedL2,
      hasExpandedL3,
    };
    sectors.push(item);
    sectorMap.set(sec.id, item);
  }

  // Ring 2 Owned layout (Euclidean-separated concentric sub-orbits + anisotropic AABB packing)
  const totalVisibleOwned = visibleOwnedSet.size;
  const hasL2 = totalVisibleOwned > 0;

  const ownedList: PositionedOwned[] = [];
  const ownedMap = new Map<string, PositionedOwned>();

  const ownedDrafts: Array<{
    node: RepoRadialOwnedNode;
    sectorId: string;
    targetAngle: number;
    expandedL3: boolean;
    shownStarCount: number;
    moreStarCount: number;
  }> = [];

  for (const ps of sectors) {
    if (!ps.expandedL2) continue;
    const list = ps.sector.ownedNodes;
    const k = list.length;
    const span = ps.endAngle - ps.startAngle;
    const pad = Math.min(0.06, span * 0.08);
    const usableStart = ps.startAngle + pad;
    const usableSpan = Math.max(0.02, span - pad * 2);

    for (let j = 0; j < k; j++) {
      const owned = list[j];
      const angle = k === 1 ? ps.midAngle : usableStart + (usableSpan * (j + 0.5)) / k;
      const expandedL3 = activeExpandedOwnedSet.has(owned.id);
      const localHidden = ownedLocalHidden.get(owned.id) ?? 0;
      const moreCount = expandedL3 ? localHidden + owned.truncatedStarCount : 0;
      ownedDrafts.push({
        node: owned,
        sectorId: ps.sector.id,
        targetAngle: angle,
        expandedL3,
        shownStarCount: ownedShownCount.get(owned.id) ?? 0,
        moreStarCount: moreCount,
      });
    }
  }

  // Ring 2 clears Ring 1 half-diag (98) + Ring 2 half-diag (90) + 32px corridor = r1 + 220
  const r2NumOrbits = ownedDrafts.length > 34 ? 2 : 1;
  const r2InitialBase = r1 + 220;
  const r2Solved = solveCollisionFreeMultiOrbit({
    targetAngles: ownedDrafts.map((d) => d.targetAngle),
    initialRBase: r2InitialBase,
    numSubOrbits: r2NumOrbits,
    boxW: 178, // 162 card + 16px margin (covers spotlight halo & +N★ corner badge)
    boxH: 66,  // 48 card + 9px top badge + 9px margin
    radiusIncrement: 28,
  });

  const r2 = hasL2
    ? (r2Solved.radii[0] + r2Solved.radii[r2Solved.radii.length - 1]) / 2
    : r1 + 220;
  const r2Outer = hasL2
    ? (r2Solved.radii[r2Solved.radii.length - 1] ?? r2Solved.rBase)
    : r1 + 220;

  ownedDrafts.forEach((draft, idx) => {
    const c = r2Solved.coords[idx];
    const item: PositionedOwned = {
      node: draft.node,
      sectorId: draft.sectorId,
      angle: c.angle,
      r: c.r,
      x: c.x,
      y: c.y,
      expandedL3: draft.expandedL3,
      shownStarCount: draft.shownStarCount,
      moreStarCount: draft.moreStarCount,
    };
    ownedList.push(item);
    ownedMap.set(draft.node.id, item);
  });

  // Ring 3 Star & "+N 更多" layout (Euclidean-separated concentric sub-orbits + anisotropic AABB packing)
  type Ring3Draft =
    | { kind: "star"; star: RepoRadialStarNode; owned: PositionedOwned; targetAngle: number }
    | { kind: "more"; owned: PositionedOwned; moreCount: number; localHidden: number; serverTruncated: number; targetAngle: number };

  const ring3Drafts: Ring3Draft[] = [];
  const expandedOwnedOrdered = ownedList.filter((o) => o.expandedL3);

  let totalRing3Items = 0;
  for (const po of expandedOwnedOrdered) {
    const anchored = anchoredStarsByOwned.get(po.node.id) ?? [];
    totalRing3Items += anchored.length + (po.moreStarCount > 0 ? 1 : 0);
  }

  const hasL3 = totalRing3Items > 0;
  // With anisotropic packing, twin/triple sub-orbits keep even single-sector L3 bursts compact & airy!
  const numSubOrbits =
    totalRing3Items > 125 ? 3 : totalRing3Items > 14 ? 2 : 1;
  // Ring 3 clears Ring 2 outermost half-diag (90) + Ring 3 half-diag (82) + 46px corridor = r2Outer + 218
  const r3InitialBase = r2Outer + 218;

  const desiredStep = hasL3
    ? Math.max(0.032, Math.min(0.085, (twoPi * 0.82) / Math.max(totalRing3Items, 10)))
    : 0.08;

  for (const po of expandedOwnedOrdered) {
    const anchored = arrangeCenterWeighted(
      [...(anchoredStarsByOwned.get(po.node.id) ?? [])].sort((a, b) => {
        if (a.isMultiTarget !== b.isMultiTarget) return a.isMultiTarget ? -1 : 1;
        return b.maxStrength - a.maxStrength;
      }),
    );
    const hasMore = po.moreStarCount > 0;
    const count = anchored.length + (hasMore ? 1 : 0);
    if (count === 0) continue;

    const totalArc = (count - 1) * desiredStep;
    const startAng = po.angle - totalArc / 2;

    anchored.forEach((star, i) => {
      ring3Drafts.push({
        kind: "star",
        star,
        owned: po,
        targetAngle: startAng + i * desiredStep,
      });
    });

    if (hasMore) {
      ring3Drafts.push({
        kind: "more",
        owned: po,
        moreCount: po.moreStarCount,
        localHidden: ownedLocalHidden.get(po.node.id) ?? 0,
        serverTruncated: po.node.truncatedStarCount,
        targetAngle: startAng + anchored.length * desiredStep,
      });
    }
  }

  const starList: PositionedStar[] = [];
  const starMap = new Map<string, PositionedStar>();
  const morePills: PositionedMorePill[] = [];

  const r3Solved = solveCollisionFreeMultiOrbit({
    targetAngles: ring3Drafts.map((d) => d.targetAngle),
    initialRBase: r3InitialBase,
    numSubOrbits,
    boxW: 162, // 148 star pill + 14px margin (covers ×N badge & stroke)
    boxH: 52,  // 36 star pill + 8px top badge + 8px margin
    radiusIncrement: 32,
  });

  const r3Base = hasL3 ? r3Solved.rBase : r3InitialBase;
  const r3Radii = hasL3 ? r3Solved.radii : [];

  ring3Drafts.forEach((draft, idx) => {
    const c = r3Solved.coords[idx];
    if (draft.kind === "star") {
      const item: PositionedStar = {
        node: draft.star,
        anchorOwnedId: draft.owned.node.id,
        sectorId: draft.owned.sectorId,
        angle: c.angle,
        r: c.r,
        subOrbit: c.subOrbit,
        x: c.x,
        y: c.y,
        visibleTargetIds: visibleTargetsByStar.get(draft.star.id) ?? [draft.owned.node.id],
      };
      starList.push(item);
      starMap.set(draft.star.id, item);
    } else {
      morePills.push({
        id: `more:${draft.owned.node.id}`,
        owned: draft.owned.node,
        sectorId: draft.owned.sectorId,
        moreCount: draft.moreCount,
        localHidden: draft.localHidden,
        serverTruncated: draft.serverTruncated,
        angle: c.angle,
        r: c.r,
        subOrbit: c.subOrbit,
        x: c.x,
        y: c.y,
      });
    }
  });

  // Visible Ring 3 -> Ring 2 links
  const links: PositionedRadialLink[] = [];
  for (const link of radialGraph.links) {
    const src = starMap.get(link.starNodeId);
    const tgt = ownedMap.get(link.ownedNodeId);
    if (!src || !tgt) continue;
    const curve = orbitalAbsorptionCurve(src, tgt, r2Outer, r3Base);
    links.push({ link, ...curve });
  }

  // Floating Nebula outer satellite anchor (Euclidean-proven clear of outermost active ring!)
  const outermostTrackR = hasL3
    ? (r3Radii[r3Radii.length - 1] ?? r3Base)
    : hasL2
      ? r2Outer
      : r1;
  const floatingAngle = Math.PI * 0.24;
  const floatingR = outermostTrackR + 225;
  const floatingPt = polar(floatingR, floatingAngle);
  const floatingAnchor = { x: floatingPt.x, y: floatingPt.y, r: floatingR, angle: floatingAngle };

  // Compute exact world bounding box for Fit View (including orbit labels + all outer card badges + Floating Nebula)
  const ringGuideExtent = outermostTrackR + 58;
  let minX = -ringGuideExtent;
  let maxX = ringGuideExtent;
  let minY = -ringGuideExtent - 24;
  let maxY = ringGuideExtent;

  const includePoint = (x: number, y: number, padX: number, padY: number) => {
    if (x - padX < minX) minX = x - padX;
    if (x + padX > maxX) maxX = x + padX;
    if (y - padY < minY) minY = y - padY;
    if (y + padY > maxY) maxY = y + padY;
  };

  for (const s of sectors) includePoint(s.x, s.y, 98, 42);
  for (const o of ownedList) includePoint(o.x, o.y, 92, 42);
  for (const st of starList) includePoint(st.x, st.y, 86, 34);
  for (const mp of morePills) includePoint(mp.x, mp.y, 64, 24);
  if (radialGraph.floatingPool && radialGraph.floatingPool.totalCount > 0) {
    includePoint(floatingAnchor.x, floatingAnchor.y, 114, 48);
  }

  return {
    r1,
    r2,
    r2Outer,
    r2Radii: hasL2 ? r2Solved.radii : [],
    r3Radii,
    hasL2,
    hasL3,
    sectors,
    sectorMap,
    ownedList,
    ownedMap,
    starList,
    starMap,
    morePills,
    links,
    floatingAnchor,
    bounds: { minX, maxX, minY, maxY },
  };
}

function toIndexedRepo(node: RepoEvolutionNode): IndexedRepo {
  return {
    fullName: node.fullName,
    url: node.url,
    description: node.description,
    visibility: node.visibility,
    relations: [node.role],
    paths: [],
    language: node.primaryLanguage,
    pushedAt: node.pushedAt,
    defaultBranch: node.defaultBranch,
    managed: [],
  };
}

/**
 * 仓库内容与 README 预览组件：
 * 默认通过 `/api/opc/repo-evolution/nodes/:id/content` 读取任意 Star 仓与私有自有仓，
 * 同时支持一键切换至内嵌 `<RepositoryIndexContent />` 以便读取本地检出索引。
 */
function RepoNodeContentPreview({ node }: { node: RepoEvolutionNode }) {
  const [sourceMode, setSourceMode] = useState<"evolution" | "activity_index">("evolution");
  const [content, setContent] = useState<RepoContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retrySeq, setRetrySeq] = useState(0);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResult, setSearchResult] = useState<(RepoEvolutionContentSearchResult & { query: string }) | null>(null);

  useEffect(() => {
    setSourceMode("evolution");
    setContent(null);
    setError("");
    setQuery("");
    setSearchResult(null);
    setSearchError("");
  }, [node.id]);

  useEffect(() => {
    if (sourceMode !== "evolution") return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request<RepoContent>(`${API_BASE}/nodes/${encodeURIComponent(node.id)}/content`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted) setContent(res);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err, "暂时无法读取仓库内容"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [node.id, sourceMode, retrySeq]);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError("");
    try {
      const res = await request<RepoEvolutionContentSearchResult>(
        `${API_BASE}/nodes/${encodeURIComponent(node.id)}/search?${new URLSearchParams({ q })}`,
      );
      setSearchResult({ ...res, query: q });
    } catch (err) {
      setSearchError(describeError(err, "仓内搜索失败"));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="re-readme-panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 11.5, color: "#586058" }}>
          数据源：{sourceMode === "evolution" ? "进化图谱引擎（支持 Star/私有仓）" : "活动索引（RepositoryIndexContent）"}
        </span>
        <button
          type="button"
          className="re-mini"
          onClick={() => setSourceMode((m) => (m === "evolution" ? "activity_index" : "evolution"))}
        >
          {sourceMode === "evolution" ? "切至本地索引组件" : "切回图谱预览"}
        </button>
      </div>

      {sourceMode === "activity_index" ? (
        <RepositoryIndexContent repo={toIndexedRepo(node)} />
      ) : (
        <section className="idx-content" aria-label="仓库内容与 README">
          <form onSubmit={(e) => void handleSearch(e)} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在仓内搜索文件或代码关键词…"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="submit" disabled={!query.trim() || searching}>
              {searching ? "搜索中…" : "搜索"}
            </button>
          </form>

          {searchError && <p role="alert" style={{ color: "#9c3a21", fontSize: 12 }}>{searchError}</p>}
          {searchResult && (
            <div className="idx-code-results" style={{ marginBottom: 8, fontSize: 12 }}>
              <p style={{ margin: "0 0 4px" }}>
                “{searchResult.query}” · {searchResult.source} · {searchResult.items.length} 条匹配
              </p>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {searchResult.items.slice(0, 12).map((item, idx) => {
                  const href = safeExternalUrl(item.url);
                  return (
                    <li key={`${item.path}-${idx}`}>
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer">
                          {item.path}
                          {item.line !== undefined ? `:${item.line}` : ""}
                        </a>
                      ) : (
                        <code>{item.path}</code>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {loading && <p role="status" style={{ fontSize: 12, color: "#5e645d" }}>正在拉取根目录与 README…</p>}
          {error && (
            <p role="alert" style={{ fontSize: 12, color: "#9c3a21" }}>
              {error}{" "}
              <button type="button" className="re-mini" onClick={() => setRetrySeq((n) => n + 1)}>
                重试
              </button>
            </p>
          )}
          {content && (
            <>
              <p className="idx-content-meta" style={{ fontSize: 11.5, margin: "4px 0 6px" }}>
                {content.source}
                {content.ref ? ` · ${content.ref.slice(0, 8)}` : ""}
                {content.note ? ` · ${content.note}` : ""}
              </p>
              <details className="idx-filetree" style={{ marginBottom: 8 }}>
                <summary style={{ fontSize: 12, cursor: "pointer" }}>
                  根目录文件树 · {content.files.length} 项
                </summary>
                <ul style={{ fontSize: 12, marginTop: 4 }}>
                  {content.files.slice(0, 40).map((f) => {
                    const href = safeExternalUrl(f.url);
                    return (
                      <li key={f.name}>
                        <span>{f.directory ? "目录" : "文件"}</span>
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer">{f.name}</a>
                        ) : (
                          <code>{f.name}</code>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
              <section className="idx-readme">
                <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <strong style={{ fontSize: 12.5 }}>README</strong>
                  {safeExternalUrl(content.readme?.url) && (
                    <a href={safeExternalUrl(content.readme?.url)} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                      查看原文 ↗
                    </a>
                  )}
                </header>
                {content.readme ? (
                  <>
                    <pre>{content.readme.text}</pre>
                    {content.readme.truncated && <small style={{ color: "#686c64" }}>已截断显示前段内容。</small>}
                  </>
                ) : (
                  <p style={{ fontSize: 12, color: "#686c64" }}>该仓库暂无可读取的 README。</p>
                )}
              </section>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// ============================================================================
// Round 3 Helper Utilities & Subcomponents
// (Zero-Clone Code Map Panel, Mermaid Architecture Diagram, Architecture Studio)
// ============================================================================

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function triggerMarkdownDownload(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".md") ? filename : `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderEvidenceChips(evidence: ArchitectureEvidenceRef[], keyPrefix: string) {
  if (!evidence || evidence.length === 0) return null;
  return (
    <div className="re-arch-evidence-row">
      {evidence.map((ev, idx) => {
        const href = safeExternalUrl(ev.url);
        const label = `${ev.repoFullName}:${ev.path}`;
        return (
          <span key={`${keyPrefix}-ev-${idx}`} className="re-arch-evidence-chip" title={ev.note || label}>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer">
                📄 {label} ↗
              </a>
            ) : (
              <code>📄 {label}</code>
            )}
            {ev.symbols && ev.symbols.length > 0 && (
              <span className="re-arch-evidence-syms">
                {ev.symbols.slice(0, 3).map((sym) => (
                  <code key={sym}>{sym}</code>
                ))}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ---- Structured Zero-Dependency Mermaid SVG Renderer (Flowchart / Graph / Sequence) ----

interface ParsedFlowNode {
  id: string;
  label: string;
  shape: "rect" | "round" | "stadium" | "cylinder" | "diamond" | "circle";
  subgraphId: string | null;
}

interface ParsedFlowEdge {
  from: string;
  to: string;
  label: string;
  style: "solid" | "dashed" | "thick";
}

interface ParsedFlowSubgraph {
  id: string;
  title: string;
  nodeIds: string[];
}

interface ParsedFlowchart {
  kind: "flowchart";
  direction: "TD" | "LR";
  nodes: ParsedFlowNode[];
  edges: ParsedFlowEdge[];
  subgraphs: ParsedFlowSubgraph[];
}

interface ParsedSequence {
  kind: "sequence";
  participants: Array<{ id: string; label: string }>;
  messages: Array<{ from: string; to: string; label: string; dashed: boolean }>;
}

function cleanMermaidLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function wrapLinesForSvg(text: string, maxUnitsPerLine = 22, maxLines = 3): string[] {
  const rawLines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const raw of rawLines) {
    let cur = "";
    let curUnits = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const w = raw.charCodeAt(i) > 0x2e7f ? 1.75 : 1;
      if (curUnits + w > maxUnitsPerLine && cur.length > 0) {
        out.push(cur.trim());
        cur = ch;
        curUnits = w;
        if (out.length >= maxLines) break;
      } else {
        cur += ch;
        curUnits += w;
      }
    }
    if (out.length >= maxLines) break;
    if (cur.trim()) out.push(cur.trim());
  }
  if (out.length === 0) return [truncateVisual(text || "Node", maxUnitsPerLine)];
  if (out.length > maxLines) {
    const sliced = out.slice(0, maxLines);
    sliced[maxLines - 1] = truncateVisual(sliced[maxLines - 1], maxUnitsPerLine - 1);
    return sliced;
  }
  return out;
}

function parseMermaidNodeToken(
  token: string,
  nodeMap: Map<string, ParsedFlowNode>,
  activeSubgraph: ParsedFlowSubgraph | null,
): string | null {
  const trimmed = token.trim().replace(/;+$/, "").replace(/:::[A-Za-z0-9_-]+$/, "").trim();
  if (!trimmed) return null;

  const patterns: Array<{ re: RegExp; shape: ParsedFlowNode["shape"] }> = [
    { re: /^([A-Za-z0-9_.-]+)\s*\(\[([\s\S]+?)\]\)$/, shape: "stadium" },
    { re: /^([A-Za-z0-9_.-]+)\s*\[\(([\s\S]+?)\)\]$/, shape: "cylinder" },
    { re: /^([A-Za-z0-9_.-]+)\s*\(\(([\s\S]+?)\)\)$/, shape: "circle" },
    { re: /^([A-Za-z0-9_.-]+)\s*\[\[([\s\S]+?)\]\]$/, shape: "rect" },
    { re: /^([A-Za-z0-9_.-]+)\s*\{([\s\S]+?)\}$/, shape: "diamond" },
    { re: /^([A-Za-z0-9_.-]+)\s*\[([\s\S]+?)\]$/, shape: "rect" },
    { re: /^([A-Za-z0-9_.-]+)\s*\(([\s\S]+?)\)$/, shape: "round" },
    { re: /^([A-Za-z0-9_.-]+)$/, shape: "rect" },
  ];

  for (const p of patterns) {
    const m = p.re.exec(trimmed);
    if (!m) continue;
    const id = m[1];
    const label = m[2] !== undefined ? cleanMermaidLabel(m[2]) : id;
    const existing = nodeMap.get(id);
    if (existing) {
      if (m[2] !== undefined) {
        existing.label = label;
        existing.shape = p.shape;
      }
      if (!existing.subgraphId && activeSubgraph) {
        existing.subgraphId = activeSubgraph.id;
        if (!activeSubgraph.nodeIds.includes(id)) activeSubgraph.nodeIds.push(id);
      }
    } else {
      nodeMap.set(id, {
        id,
        label,
        shape: p.shape,
        subgraphId: activeSubgraph?.id ?? null,
      });
      if (activeSubgraph && !activeSubgraph.nodeIds.includes(id)) {
        activeSubgraph.nodeIds.push(id);
      }
    }
    return id;
  }
  return null;
}

function parseMermaidDiagram(raw: string): ParsedFlowchart | ParsedSequence | null {
  const cleaned = raw
    .replace(/^```(?:mermaid)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!cleaned) return null;

  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/%%.*$/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  // Sequence diagram parser
  if (/^sequenceDiagram\b/i.test(lines[0])) {
    const partMap = new Map<string, { id: string; label: string }>();
    const messages: ParsedSequence["messages"] = [];
    const ensurePart = (id: string, label?: string) => {
      const key = id.trim();
      if (!key) return;
      if (!partMap.has(key)) {
        partMap.set(key, { id: key, label: cleanMermaidLabel(label || key) });
      } else if (label) {
        partMap.get(key)!.label = cleanMermaidLabel(label);
      }
    };

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const pm = /^(?:participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/i.exec(line);
      if (pm) {
        ensurePart(pm[1], pm[2]);
        continue;
      }
      const mm = /^([A-Za-z0-9_.-]+)\s*(--?>>?|--?>|--?x)\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (mm) {
        ensurePart(mm[1]);
        ensurePart(mm[3]);
        messages.push({
          from: mm[1],
          to: mm[3],
          dashed: mm[2].startsWith("--"),
          label: cleanMermaidLabel(mm[4]),
        });
      }
    }
    if (partMap.size > 0) {
      return { kind: "sequence", participants: Array.from(partMap.values()), messages };
    }
    return null;
  }

  // Flowchart / Graph parser
  let direction: "TD" | "LR" = "TD";
  let startIdx = 0;
  const headerMatch = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i.exec(lines[0]);
  if (headerMatch) {
    const dir = headerMatch[1].toUpperCase();
    direction = dir === "LR" || dir === "RL" ? "LR" : "TD";
    startIdx = 1;
  } else if (/^(?:flowchart|graph)\b/i.test(lines[0])) {
    startIdx = 1;
  }

  const nodeMap = new Map<string, ParsedFlowNode>();
  const edges: ParsedFlowEdge[] = [];
  const subgraphs: ParsedFlowSubgraph[] = [];
  const subgraphStack: ParsedFlowSubgraph[] = [];

  const arrowPattern =
    /(\s*(?:-\.\s+[^.\n]+?\s+\.-+>|==\s+[^=\n]+?\s+==+>|---\s+[^-\n>|]+?\s+-->|--\s+[^-\n>|]+?\s+-->|-\.+->|==+>|--+>|---)\s*(?:\|([^|]+)\|)?\s*)/;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (
      /^(?:classDef|class|style|linkStyle|click|direction)\b/i.test(line)
    ) {
      continue;
    }
    if (/^subgraph\b/i.test(line)) {
      const rest = line.replace(/^subgraph\s+/i, "").trim();
      const subBracket = /^([A-Za-z0-9_.-]+)\s*\[(.+)\]$/.exec(rest);
      const id = subBracket ? subBracket[1] : `sg_${subgraphs.length + 1}`;
      const title = subBracket ? cleanMermaidLabel(subBracket[2]) : cleanMermaidLabel(rest || `Layer ${subgraphs.length + 1}`);
      const sg: ParsedFlowSubgraph = { id, title, nodeIds: [] };
      subgraphs.push(sg);
      subgraphStack.push(sg);
      continue;
    }
    if (/^end$/i.test(line)) {
      subgraphStack.pop();
      continue;
    }

    const activeSg = subgraphStack[subgraphStack.length - 1] ?? null;

    // Split chained edges while preserving arrow operator & optional |label|
    const parts: string[] = [];
    const ops: Array<{ op: string; label: string }> = [];
    let cursor = line;
    while (cursor.length > 0) {
      const m = arrowPattern.exec(cursor);
      if (!m || m.index === undefined) {
        parts.push(cursor.trim());
        break;
      }
      parts.push(cursor.slice(0, m.index).trim());
      const fullOp = m[1].trim();
      let edgeLabel = m[2] ? cleanMermaidLabel(m[2]) : "";
      if (!edgeLabel) {
        const inlineDash = /^--\s+(.+?)\s+-->$/.exec(fullOp);
        const inlineDot = /^-\.\s+(.+?)\s+\.->$/.exec(fullOp);
        const inlineThick = /^==\s+(.+?)\s+==>$/.exec(fullOp);
        if (inlineDash) edgeLabel = cleanMermaidLabel(inlineDash[1]);
        else if (inlineDot) edgeLabel = cleanMermaidLabel(inlineDot[1]);
        else if (inlineThick) edgeLabel = cleanMermaidLabel(inlineThick[1]);
      }
      ops.push({ op: fullOp, label: edgeLabel });
      cursor = cursor.slice(m.index + m[0].length);
    }

    if (ops.length === 0) {
      for (const seg of parts[0].split("&")) {
        parseMermaidNodeToken(seg, nodeMap, activeSg);
      }
      continue;
    }

    const stepGroups: string[][] = parts.map((group) =>
      group
        .split("&")
        .map((tok) => parseMermaidNodeToken(tok, nodeMap, activeSg))
        .filter((id): id is string => Boolean(id)),
    );

    for (let k = 0; k < ops.length; k++) {
      const fromGroup = stepGroups[k] ?? [];
      const toGroup = stepGroups[k + 1] ?? [];
      const opStr = ops[k].op;
      const style: ParsedFlowEdge["style"] = opStr.includes(".")
        ? "dashed"
        : opStr.includes("=")
          ? "thick"
          : "solid";
      for (const fromId of fromGroup) {
        for (const toId of toGroup) {
          edges.push({ from: fromId, to: toId, label: ops[k].label, style });
        }
      }
    }
  }

  const nodes = Array.from(nodeMap.values());
  if (nodes.length === 0) return null;
  return { kind: "flowchart", direction, nodes, edges, subgraphs };
}

function MermaidArchitectureDiagram({
  code,
  caption,
}: {
  code: string;
  caption?: string;
}) {
  const [viewMode, setViewMode] = useState<"diagram" | "source">("diagram");
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseMermaidDiagram(code), [code]);

  const handleCopy = async () => {
    const ok = await copyTextSafe(code);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  const renderedSvg = useMemo(() => {
    if (!parsed) return null;

    if (parsed.kind === "sequence") {
      const colW = 176;
      const padX = 36;
      const topY = 24;
      const headH = 42;
      const rowH = 46;
      const width = Math.max(540, padX * 2 + parsed.participants.length * colW);
      const height = Math.max(220, topY + headH + 28 + Math.max(1, parsed.messages.length) * rowH + 36);
      const xById = new Map<string, number>();
      parsed.participants.forEach((p, idx) => {
        xById.set(p.id, padX + colW * idx + colW / 2);
      });

      return (
        <svg
          className="re-mermaid-svg"
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: "100%", maxWidth: width, height: "auto" }}
          role="img"
          aria-label={caption || "架构时序图"}
        >
          <defs>
            <marker id="re-mmd-seq-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#2b4e3c" />
            </marker>
          </defs>
          {parsed.participants.map((p) => {
            const cx = xById.get(p.id) ?? padX;
            const lines = wrapLinesForSvg(p.label, 18, 2);
            return (
              <g key={p.id}>
                <line x1={cx} y1={topY + headH} x2={cx} y2={height - 20} stroke="#c8c2b2" strokeWidth={1.3} strokeDasharray="4 4" />
                <rect x={cx - 72} y={topY} width={144} height={headH} rx={4} fill="#fffdf8" stroke="#2b4e3c" strokeWidth={1.5} />
                <text x={cx} y={topY + (lines.length === 1 ? 25 : 18)} textAnchor="middle" fill="#1e2721" fontSize="12" fontWeight="650">
                  {lines.map((ln, idx) => (
                    <tspan key={idx} x={cx} dy={idx === 0 ? 0 : 14}>
                      {ln}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
          {parsed.messages.map((m, idx) => {
            const x1 = xById.get(m.from) ?? padX;
            const x2 = xById.get(m.to) ?? padX;
            const y = topY + headH + 30 + idx * rowH;
            const midX = (x1 + x2) / 2;
            const isSelf = x1 === x2;
            return (
              <g key={`seq-${idx}`}>
                {isSelf ? (
                  <path
                    d={`M ${x1} ${y} C ${x1 + 48} ${y}, ${x1 + 48} ${y + 20}, ${x1 + 4} ${y + 20}`}
                    fill="none"
                    stroke="#2b4e3c"
                    strokeWidth={1.6}
                    strokeDasharray={m.dashed ? "5 3" : undefined}
                    markerEnd="url(#re-mmd-seq-arrow)"
                  />
                ) : (
                  <line
                    x1={x1}
                    y1={y}
                    x2={x2 > x1 ? x2 - 4 : x2 + 4}
                    y2={y}
                    stroke="#2b4e3c"
                    strokeWidth={1.6}
                    strokeDasharray={m.dashed ? "5 3" : undefined}
                    markerEnd="url(#re-mmd-seq-arrow)"
                  />
                )}
                {m.label && (
                  <text x={isSelf ? x1 + 52 : midX} y={y - 7} textAnchor={isSelf ? "start" : "middle"} fill="#374038" fontSize="11.5">
                    {truncateVisual(m.label, 34)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      );
    }

    // Flowchart topological layered SVG layout
    const { nodes, edges, subgraphs, direction } = parsed;
    const nodeIds = nodes.map((n) => n.id);
    const inDeg = new Map<string, number>();
    const outAdj = new Map<string, string[]>();
    for (const id of nodeIds) {
      inDeg.set(id, 0);
      outAdj.set(id, []);
    }
    for (const e of edges) {
      if (e.from === e.to) continue;
      if (!outAdj.has(e.from) || !inDeg.has(e.to)) continue;
      outAdj.get(e.from)!.push(e.to);
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    }

    // Assign topological ranks safely (cycle-proof via bounded Bellman-Ford / Kahn hybrid)
    const rankMap = new Map<string, number>();
    for (const id of nodeIds) rankMap.set(id, 0);
    const maxRank = Math.max(1, Math.min(nodes.length - 1, 10));
    for (let pass = 0; pass < Math.min(nodes.length, 14); pass++) {
      let changed = false;
      for (const e of edges) {
        if (e.from === e.to) continue;
        const rf = rankMap.get(e.from);
        const rt = rankMap.get(e.to);
        if (rf !== undefined && rt !== undefined && rt <= rf && rf + 1 <= maxRank) {
          rankMap.set(e.to, rf + 1);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const layers = new Map<number, ParsedFlowNode[]>();
    for (const node of nodes) {
      const r = rankMap.get(node.id) ?? 0;
      const arr = layers.get(r) ?? [];
      arr.push(node);
      layers.set(r, arr);
    }
    const sortedRanks = Array.from(layers.keys()).sort((a, b) => a - b);

    // Compute exact dimensions for each node so text never clips or overflows
    const nodeMetrics = new Map<
      string,
      { lines: string[]; w: number; h: number; x: number; y: number; cx: number; cy: number }
    >();
    for (const node of nodes) {
      const lines = wrapLinesForSvg(node.label, direction === "LR" ? 18 : 22, 3);
      const maxLineUnits = Math.max(
        10,
        ...lines.map((ln) => {
          let u = 0;
          for (let i = 0; i < ln.length; i++) u += ln.charCodeAt(i) > 0x2e7f ? 1.75 : 1;
          return u;
        }),
      );
      const w = Math.max(126, Math.min(238, Math.round(maxLineUnits * 7.6 + 34)));
      const h = Math.max(46, lines.length * 17 + 22);
      nodeMetrics.set(node.id, { lines, w, h, x: 0, y: 0, cx: 0, cy: 0 });
    }

    const padX = 42;
    const padY = 44;
    const gapAlong = direction === "LR" ? 72 : 64;
    const gapCross = direction === "LR" ? 28 : 30;

    let canvasW = 560;
    let canvasH = 260;

    if (direction === "LR") {
      // Ranks go left -> right; nodes within rank stack top -> bottom
      const colWidths = sortedRanks.map((r) =>
        Math.max(...(layers.get(r) ?? []).map((n) => nodeMetrics.get(n.id)!.w)),
      );
      const colHeights = sortedRanks.map((r) => {
        const list = layers.get(r) ?? [];
        return list.reduce((acc, n) => acc + nodeMetrics.get(n.id)!.h, 0) + Math.max(0, list.length - 1) * gapCross;
      });
      const maxColH = Math.max(180, ...colHeights);
      let curX = padX;
      sortedRanks.forEach((r, idx) => {
        const list = layers.get(r) ?? [];
        const colW = colWidths[idx];
        const colH = colHeights[idx];
        let curY = padY + Math.round((maxColH - colH) / 2);
        for (const n of list) {
          const m = nodeMetrics.get(n.id)!;
          m.x = curX + Math.round((colW - m.w) / 2);
          m.y = curY;
          m.cx = m.x + m.w / 2;
          m.cy = m.y + m.h / 2;
          curY += m.h + gapCross;
        }
        curX += colW + gapAlong;
      });
      canvasW = Math.max(580, curX - gapAlong + padX);
      canvasH = Math.max(240, maxColH + padY * 2);
    } else {
      // TD: Ranks go top -> bottom; nodes within rank sit left -> right
      const rowHeights = sortedRanks.map((r) =>
        Math.max(...(layers.get(r) ?? []).map((n) => nodeMetrics.get(n.id)!.h)),
      );
      const rowWidths = sortedRanks.map((r) => {
        const list = layers.get(r) ?? [];
        return list.reduce((acc, n) => acc + nodeMetrics.get(n.id)!.w, 0) + Math.max(0, list.length - 1) * gapCross;
      });
      const maxRowW = Math.max(500, ...rowWidths);
      let curY = padY;
      sortedRanks.forEach((r, idx) => {
        const list = layers.get(r) ?? [];
        const rowH = rowHeights[idx];
        const rowW = rowWidths[idx];
        let curX = padX + Math.round((maxRowW - rowW) / 2);
        for (const n of list) {
          const m = nodeMetrics.get(n.id)!;
          m.x = curX;
          m.y = curY + Math.round((rowH - m.h) / 2);
          m.cx = m.x + m.w / 2;
          m.cy = m.y + m.h / 2;
          curX += m.w + gapCross;
        }
        curY += rowH + gapAlong;
      });
      canvasW = Math.max(580, maxRowW + padX * 2);
      canvasH = Math.max(240, curY - gapAlong + padY);
    }

    const sgPalette = ["#2b4e3c", "#483d82", "#246874", "#9c3a21", "#b9751d"];
    const sgColorById = new Map<string, string>();
    subgraphs.forEach((sg, idx) => sgColorById.set(sg.id, sgPalette[idx % sgPalette.length]));

    const sgBoxes = subgraphs
      .map((sg) => {
        const ms = sg.nodeIds
          .map((id) => nodeMetrics.get(id))
          .filter((m): m is NonNullable<typeof m> => Boolean(m));
        if (ms.length === 0) return null;
        const minX = Math.min(...ms.map((m) => m.x)) - 16;
        const minY = Math.min(...ms.map((m) => m.y)) - 30;
        const maxX = Math.max(...ms.map((m) => m.x + m.w)) + 16;
        const maxY = Math.max(...ms.map((m) => m.y + m.h)) + 14;
        return {
          sg,
          x: Math.max(8, minX),
          y: Math.max(8, minY),
          w: Math.max(120, maxX - Math.max(8, minX)),
          h: Math.max(70, maxY - Math.max(8, minY)),
          color: sgColorById.get(sg.id) || "#2b4e3c",
        };
      })
      .filter((b): b is NonNullable<typeof b> => Boolean(b));

    return (
      <svg
        className="re-mermaid-svg"
        viewBox={`0 0 ${canvasW} ${canvasH}`}
        style={{ width: "100%", maxWidth: Math.max(canvasW, 760), height: "auto" }}
        role="img"
        aria-label={caption || "第一性原理最小架构图"}
      >
        <defs>
          <marker id="re-mmd-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#3a4c42" />
          </marker>
          <marker id="re-mmd-arrow-thick" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#483d82" />
          </marker>
        </defs>

        {/* Subgraph Containers */}
        {sgBoxes.map((b) => (
          <g key={`sg-${b.sg.id}`}>
            <rect
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={5}
              fill={b.color}
              fillOpacity={0.05}
              stroke={b.color}
              strokeOpacity={0.36}
              strokeWidth={1.25}
              strokeDasharray="5 3"
            />
            <text x={b.x + 10} y={b.y + 17} fill={b.color} fontSize="11" fontWeight="700">
              {truncateVisual(b.sg.title, 34)}
            </text>
          </g>
        ))}

        {/* Edges */}
        {edges.map((e, idx) => {
          const from = nodeMetrics.get(e.from);
          const to = nodeMetrics.get(e.to);
          if (!from || !to) return null;

          let sx = from.cx;
          let sy = from.cy;
          let tx = to.cx;
          let ty = to.cy;
          let d = "";
          let lx = (sx + tx) / 2;
          let ly = (sy + ty) / 2;

          if (direction === "LR") {
            const forward = to.cx >= from.cx;
            sx = forward ? from.x + from.w : from.x;
            sy = from.cy;
            tx = forward ? to.x - 3 : to.x + to.w + 3;
            ty = to.cy;
            const dx = Math.max(28, Math.abs(tx - sx) * 0.48);
            const c1x = forward ? sx + dx : sx - dx;
            const c2x = forward ? tx - dx : tx + dx;
            const bendY = !forward ? (from.cy === to.cy ? -34 : 0) : 0;
            d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${(sy + bendY).toFixed(1)}, ${c2x.toFixed(1)} ${(ty + bendY).toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
            lx = (sx + tx) / 2;
            ly = (sy + ty) / 2 + bendY * 0.72;
          } else {
            const forward = to.cy >= from.cy;
            sx = from.cx;
            sy = forward ? from.y + from.h : from.y;
            tx = to.cx;
            ty = forward ? to.y - 3 : to.y + to.h + 3;
            const dy = Math.max(24, Math.abs(ty - sy) * 0.48);
            const c1y = forward ? sy + dy : sy - dy;
            const c2y = forward ? ty - dy : ty + dy;
            const bendX = !forward ? 44 : 0;
            d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(sx + bendX).toFixed(1)} ${c1y.toFixed(1)}, ${(tx + bendX).toFixed(1)} ${c2y.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
            lx = (sx + tx) / 2 + bendX * 0.72;
            ly = (sy + ty) / 2;
          }

          const stroke = e.style === "thick" ? "#483d82" : "#4b5d53";
          const sw = e.style === "thick" ? 2.2 : 1.5;
          const labelShort = e.label ? truncateVisual(e.label, 20) : "";
          const labelW = labelShort ? Math.max(40, labelShort.length * 6.8 + 14) : 0;

          return (
            <g key={`edge-${idx}`}>
              <path
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={sw}
                strokeDasharray={e.style === "dashed" ? "5 3" : undefined}
                markerEnd={e.style === "thick" ? "url(#re-mmd-arrow-thick)" : "url(#re-mmd-arrow)"}
              />
              {labelShort && (
                <g transform={`translate(${lx.toFixed(1)}, ${ly.toFixed(1)})`}>
                  <rect
                    x={-labelW / 2}
                    y={-10}
                    width={labelW}
                    height={19}
                    rx={9}
                    fill="#fcfaf3"
                    stroke="#cbc5b6"
                    strokeWidth={0.9}
                  />
                  <text x={0} y={3.5} textAnchor="middle" fill="#3b443e" fontSize="10.5" fontWeight="550">
                    {labelShort}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {nodes.map((node, idx) => {
          const m = nodeMetrics.get(node.id)!;
          const accent = (node.subgraphId && sgColorById.get(node.subgraphId)) || (idx === 0 ? "#2b4e3c" : "#3a506b");
          const rx = node.shape === "stadium" || node.shape === "circle" ? Math.min(22, m.h / 2) : node.shape === "round" ? 9 : 4;
          const textStartY = m.cy - ((m.lines.length - 1) * 16) / 2 + 4;
          return (
            <g key={`node-${node.id}`}>
              {node.shape === "diamond" ? (
                <polygon
                  points={`${m.cx},${m.y - 3} ${m.x + m.w + 4},${m.cy} ${m.cx},${m.y + m.h + 3} ${m.x - 4},${m.cy}`}
                  fill="#fffdf8"
                  stroke={accent}
                  strokeWidth={1.6}
                />
              ) : (
                <>
                  <rect
                    x={m.x}
                    y={m.y}
                    width={m.w}
                    height={m.h}
                    rx={rx}
                    fill="#fffdf8"
                    stroke={accent}
                    strokeWidth={1.55}
                  />
                  {node.shape === "cylinder" && (
                    <ellipse
                      cx={m.cx}
                      cy={m.y + 6}
                      rx={m.w / 2 - 2}
                      ry={5}
                      fill="#f1ede0"
                      stroke={accent}
                      strokeWidth={1.1}
                    />
                  )}
                  <rect
                    x={m.x}
                    y={m.y}
                    width={4}
                    height={m.h}
                    rx={2}
                    fill={accent}
                    opacity={0.85}
                  />
                </>
              )}
              <text x={m.cx} y={textStartY} textAnchor="middle" fill="#1d2620" fontSize="12" fontWeight="600">
                {m.lines.map((ln, lineIdx) => (
                  <tspan key={lineIdx} x={m.cx} dy={lineIdx === 0 ? 0 : 16}>
                    {ln}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }, [parsed, caption]);

  return (
    <div className="re-mermaid-card" data-testid="arch-mermaid-diagram">
      <div className="re-mermaid-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong>架构原语拓扑图（Mermaid）</strong>
          <span className="re-pill">
            {parsed?.kind === "sequence"
              ? `时序图 · ${parsed.participants.length} 角色`
              : parsed?.kind === "flowchart"
                ? `架构图 · ${parsed.nodes.length} 节点 / ${parsed.edges.length} 边`
                : "源码视图"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          {renderedSvg && (
            <div className="re-seg-mini" role="group" aria-label="架构图视图切换">
              <button
                type="button"
                className={viewMode === "diagram" ? "re-active" : ""}
                onClick={() => setViewMode("diagram")}
              >
                SVG 视图
              </button>
              <button
                type="button"
                className={viewMode === "source" ? "re-active" : ""}
                onClick={() => setViewMode("source")}
              >
                Mermaid 源码
              </button>
            </div>
          )}
          <button type="button" className="re-mini" onClick={() => void handleCopy()}>
            {copied ? "✓ 已复制" : "复制 Mermaid"}
          </button>
        </div>
      </div>

      {renderedSvg && viewMode === "diagram" ? (
        <div className="re-mermaid-stage">{renderedSvg}</div>
      ) : (
        <pre className="re-code-block" style={{ margin: 0, borderRadius: 0, border: 0 }}>
          <code>{code}</code>
        </pre>
      )}

      {caption && <div className="re-mermaid-caption">{caption}</div>}
    </div>
  );
}

// ---- Zero-Clone Code Map Drawer Panel (Node Inspector) ----

function ZeroCloneCodeMapPanel({
  node,
  onCodeMapLoaded,
  onNotice,
  onError,
}: {
  node: RepoEvolutionNode;
  onCodeMapLoaded?: (codeMap: RepoCodeMap | null) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [codeMap, setCodeMap] = useState<RepoCodeMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [expandedHotspots, setExpandedHotspots] = useState<Set<string>>(() => new Set());
  const [showAllHotspots, setShowAllHotspots] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCodeMap(null);
    setShowAllHotspots(false);
    request<GetCodeMapResponse>(`${API_BASE}/nodes/${encodeURIComponent(node.id)}/code-map`)
      .then((res) => {
        if (!active) return;
        setCodeMap(res.codeMap);
        onCodeMapLoaded?.(res.codeMap);
        if (res.codeMap) {
          setExpandedHotspots(new Set(res.codeMap.hotspots.slice(0, 2).map((h) => h.path)));
        } else {
          setExpandedHotspots(new Set());
        }
      })
      .catch(() => {
        if (!active) return;
        setCodeMap(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [node.id]);

  const handleScan = async (force: boolean) => {
    setScanning(true);
    onError("");
    try {
      const res = await request<GenerateCodeMapResponse>(
        `${API_BASE}/nodes/${encodeURIComponent(node.id)}/code-map`,
        {
          method: "POST",
          body: JSON.stringify({ force }),
        },
      );
      setCodeMap(res.codeMap);
      onCodeMapLoaded?.(res.codeMap);
      setExpandedHotspots(new Set(res.codeMap.hotspots.slice(0, 2).map((h) => h.path)));
      onNotice(
        res.notice ||
          (res.cached
            ? `Code Map 命中同 Commit 缓存（${res.codeMap.commitSha.slice(0, 7)}），0 MB 本地克隆。`
            : `零克隆 Code Map 扫描完成：纯内存解析 ${res.codeMap.analyzedFileCount} 个核心源码文件，识别 ${res.codeMap.hotspots.length} 个热点文件。`),
      );
    } catch (err) {
      onError(describeError(err, "零克隆 Code Map 扫描失败"));
    } finally {
      setScanning(false);
    }
  };

  const toggleHotspot = (filePath: string) => {
    setExpandedHotspots((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const visibleLayers = useMemo(
    () => (codeMap?.layers ?? []).filter((l) => l.fileCount > 0),
    [codeMap],
  );
  const totalLayerFiles = useMemo(
    () => visibleLayers.reduce((sum, l) => sum + l.fileCount, 0) || 1,
    [visibleLayers],
  );
  const visibleHotspots: RepoCodeMapHotspot[] = useMemo(() => {
    if (!codeMap) return [];
    return showAllHotspots ? codeMap.hotspots : codeMap.hotspots.slice(0, 6);
  }, [codeMap, showAllHotspots]);

  return (
    <div className="re-section-box re-codemap-box" data-testid="node-codemap-section">
      <h3>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span>零克隆 Code Map</span>
          <span className="re-zero-clone-badge" data-testid="codemap-zero-clone-badge">
            0 MB 本地克隆 · 纯内存解析
          </span>
        </span>
        <button
          type="button"
          className={codeMap ? "re-mini" : "re-mini re-primary"}
          data-testid="codemap-scan-btn"
          disabled={scanning || loading}
          onClick={() => void handleScan(Boolean(codeMap))}
        >
          {scanning ? "扫描解析中…" : codeMap ? "↻ 刷新扫描" : "⚡ 一键零克隆扫描"}
        </button>
      </h3>

      {node.visibility === "private" && (
        <div className="re-codemap-privacy-note">
          🔒 私有仓仅在本地/纯内存执行静态 import/export 解析，绝不落盘 clone，绝不外发 LLM。
        </div>
      )}

      {loading && !codeMap && (
        <div className="re-codemap-empty">正在查询零克隆 Code Map 缓存…</div>
      )}

      {!loading && !codeMap && (
        <div className="re-codemap-empty">
          <p style={{ margin: "0 0 8px" }}>
            通过 GitHub Trees API + GraphQL Batch Blobs 纯内存解析核心源码 import 依赖与导出符号（0 字节本地盘占用），快速锁定真正值得精读的 Hotspot 核心入口文件。
          </p>
          <button
            type="button"
            className="re-primary re-mini"
            disabled={scanning}
            onClick={() => void handleScan(false)}
          >
            {scanning ? "正在零克隆纯内存解析…" : "⚡ 立即生成零克隆 Code Map"}
          </button>
        </div>
      )}

      {codeMap && (
        <>
          {/* 缓存与拓扑统计条 */}
          <div className="re-codemap-telemetry">
            <span className="re-pill">
              Commit <code>{codeMap.commitSha.slice(0, 8)}</code>
            </span>
            <span className="re-pill">文件 {codeMap.totalTreeFiles}（精析 {codeMap.analyzedFileCount}）</span>
            <span className="re-pill">Import 边 {codeMap.edgeCount}</span>
            <span className={`re-pill ${codeMap.cycleCount > 0 ? "suggested" : "active"}`}>
              循环依赖 {codeMap.cycleCount}
            </span>
            <span className="re-pill">
              {codeMap.source === "local_readonly_memory" ? "本机只读内存" : "GitHub 远程内存"}
            </span>
            <span className="re-pill">
              {codeMap.cached ? "✓ 同 Commit 缓存" : `${codeMap.fetchDurationMs}ms 扫描`}
            </span>
          </div>

          {/* 分层占比可视化条 */}
          {visibleLayers.length > 0 && (
            <div className="re-codemap-layers" data-testid="codemap-layer-bar">
              <div className="re-codemap-subhead">
                <span>架构分层占比</span>
                <small className="re-mono">{codeMap.primaryLanguages.slice(0, 3).map((l) => `${l.language} (${l.count})`).join(" · ")}</small>
              </div>
              <div className="re-layer-bar" role="img" aria-label="代码分层占比条">
                {visibleLayers.map((layer) => {
                  const pct = Math.max(2, (layer.fileCount / totalLayerFiles) * 100);
                  const color = REPO_CODE_LAYER_COLORS[layer.layer] ?? "#64748b";
                  return (
                    <div
                      key={layer.layer}
                      className="re-layer-seg"
                      style={{ width: `${pct}%`, background: color }}
                      title={`${REPO_CODE_LAYER_LABELS[layer.layer] ?? layer.label}: ${layer.fileCount} 文件 (${Math.round(layer.share * 100)}%)`}
                    />
                  );
                })}
              </div>
              <div className="re-layer-legend">
                {visibleLayers.map((layer) => (
                  <span key={layer.layer} className="re-layer-chip">
                    <span
                      className="re-domain-dot"
                      style={{ background: REPO_CODE_LAYER_COLORS[layer.layer] ?? "#64748b" }}
                    />
                    <span>{REPO_CODE_LAYER_LABELS[layer.layer] ?? layer.label}</span>
                    <strong className="re-mono">{layer.fileCount}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Hotspot 核心热点文件卡片 */}
          <div className="re-codemap-hotspots" data-testid="codemap-hotspots">
            <div className="re-codemap-subhead">
              <span>🔥 Hotspot 核心热点文件 ({codeMap.hotspots.length})</span>
              {codeMap.hotspots.length > 6 && (
                <button
                  type="button"
                  className="re-ghost re-mini"
                  onClick={() => setShowAllHotspots((v) => !v)}
                >
                  {showAllHotspots ? "收起" : `展开全部 ${codeMap.hotspots.length}`}
                </button>
              )}
            </div>

            {visibleHotspots.length === 0 ? (
              <div className="re-codemap-empty">暂未提取到显著入度热点文件。</div>
            ) : (
              <div className="re-hotspot-list">
                {visibleHotspots.map((h) => {
                  const expanded = expandedHotspots.has(h.path);
                  const href = safeExternalUrl(h.url);
                  const layerColor = REPO_CODE_LAYER_COLORS[h.layer] ?? "#64748b";
                  return (
                    <article key={h.path} className="re-hotspot-card" data-testid="codemap-hotspot-card">
                      <div className="re-hotspot-banner">
                        <span className="re-hotspot-rec-pill">
                          {h.importedByCount > 0
                            ? `被 ${h.importedByCount} 个文件引用 · 建议从此开始阅读`
                            : "核心枢纽入口 · 建议从此开始阅读"}
                        </span>
                        <span
                          className="re-pill"
                          style={{
                            borderColor: layerColor,
                            color: layerColor,
                            background: "#fffdf8",
                            fontWeight: 600,
                          }}
                        >
                          {REPO_CODE_LAYER_LABELS[h.layer] ?? h.layer}
                        </span>
                      </div>

                      <div className="re-hotspot-path-row">
                        {href ? (
                          <a className="re-hotspot-path" href={href} target="_blank" rel="noreferrer">
                            {h.path} ↗
                          </a>
                        ) : (
                          <code className="re-hotspot-path">{h.path}</code>
                        )}
                      </div>

                      {h.startReadingReason && (
                        <div className="re-hotspot-reason">{h.startReadingReason}</div>
                      )}

                      <div className="re-hotspot-meta">
                        <span className="re-mono">
                          {h.language} · {h.lineCount} 行 · 引用 {h.importsCount} · 入度 {h.importedByCount}
                        </span>
                        {h.exportedSymbols.length > 0 && (
                          <button
                            type="button"
                            className="re-ghost re-mini"
                            onClick={() => toggleHotspot(h.path)}
                          >
                            {expanded
                              ? `收起符号 (${h.exportedSymbols.length}) ▴`
                              : `导出符号 (${h.exportedSymbols.length}) ▾`}
                          </button>
                        )}
                      </div>

                      {expanded && h.exportedSymbols.length > 0 && (
                        <ul className="re-symbol-list">
                          {h.exportedSymbols.slice(0, 14).map((sym, idx) => (
                            <li key={`${h.path}-${sym.name}-${idx}`} className="re-symbol-item">
                              <span className="re-symbol-kind">{sym.kind}</span>
                              <code className="re-symbol-name">
                                {sym.name}
                                {sym.line ? `:${sym.line}` : ""}
                              </code>
                              {sym.signature && (
                                <span className="re-symbol-sig" title={sym.signature}>
                                  {truncateVisual(sym.signature, 46)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {/* 循环依赖提示 */}
          {codeMap.cycles.length > 0 ? (
            <div className="re-cycle-alert" role="note">
              <strong>⚠ 检测到 {codeMap.cycles.length} 组内部循环依赖</strong>
              <ul>
                {codeMap.cycles.slice(0, 5).map((c, idx) => (
                  <li key={`cyc-${idx}`} className="re-mono">
                    {c.paths.join(" → ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="re-cycle-ok">✓ 静态 Import 图未检测到内部循环依赖</div>
          )}

          {/* 外部高频依赖 & 关键接口 */}
          {(codeMap.topExternalDeps.length > 0 || codeMap.keyInterfaces.length > 0) && (
            <details className="re-codemap-extra">
              <summary>
                外部依赖 ({codeMap.topExternalDeps.length}) · 关键接口签名 ({codeMap.keyInterfaces.length})
              </summary>
              {codeMap.topExternalDeps.length > 0 && (
                <div className="re-badge-row" style={{ marginTop: 6 }}>
                  {codeMap.topExternalDeps.slice(0, 12).map((dep) => (
                    <span key={dep.name} className="re-pill re-mono">
                      {dep.name} ×{dep.count}
                    </span>
                  ))}
                </div>
              )}
              {codeMap.keyInterfaces.length > 0 && (
                <ul className="re-symbol-list" style={{ marginTop: 8 }}>
                  {codeMap.keyInterfaces.slice(0, 8).map((ki, idx) => (
                    <li key={`ki-${ki.path}-${ki.name}-${idx}`} className="re-symbol-item">
                      <span className="re-symbol-kind">{ki.kind}</span>
                      <code className="re-symbol-name">{ki.name}</code>
                      <span className="re-symbol-sig" title={ki.signature}>
                        {ki.path}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
}

// ---- Tab 4: First-Principles Architecture Primitives Studio ----

function ArchitectureStudioTab({
  radialGraph,
  domains,
  allOwnedForCheckboxes,
  initialPrimitiveId,
  onPrimitiveCountChange,
  onOpenNodeCodeMap,
  onLocateNode,
  onNotice,
  onError,
}: {
  radialGraph: RepoEvolutionRadialGraph | null;
  domains: Array<{ id: string; name: string; color: string }>;
  allOwnedForCheckboxes: Array<{
    id: string;
    name: string;
    owner: string;
    fullName: string;
    priorityTier: string;
    visibility: string;
    isFork: boolean;
  }>;
  initialPrimitiveId?: string;
  onPrimitiveCountChange?: (count: number) => void;
  onOpenNodeCodeMap: (nodeId: string) => void;
  onLocateNode: (nodeId: string) => void;
  onNotice: (n: { text: string; href?: string; hrefLabel?: string }) => void;
  onError: (msg: string) => void;
}) {
  const [primitives, setPrimitives] = useState<ArchitecturePrimitive[]>([]);
  const [clusters, setClusters] = useState<ArchitectureClusterRecommendation[]>([]);
  const [selectedId, setSelectedId] = useState<string>(initialPrimitiveId || "");
  const [selectedPrimitive, setSelectedPrimitive] = useState<ArchitecturePrimitive | null>(null);
  const [selectedRuns, setSelectedRuns] = useState<ArchitectureDistillationRun[]>([]);

  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<ArchitecturePrimitiveStatus | "all">("all");

  // Busy states
  const [distillingClusterId, setDistillingClusterId] = useState<string>("");
  const [busyOp, setBusyOp] = useState<string>("");
  const [copiedContract, setCopiedContract] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);

  // Consolidation note drafts per itemId
  const [consolidationNotes, setConsolidationNotes] = useState<Record<string, string>>({});

  // Custom Cross-Repo Distillation modal state
  const [customOpen, setCustomOpen] = useState(false);
  const [customTitle, setCustomTitle] = useState("");
  const [customDomainId, setCustomDomainId] = useState("");
  const [customProblem, setCustomProblem] = useState("");
  const [customOwnedSearch, setCustomOwnedSearch] = useState("");
  const [customOwnedIds, setCustomOwnedIds] = useState<Set<string>>(() => new Set());
  const [customStarSearch, setCustomStarSearch] = useState("");
  const [customStarResults, setCustomStarResults] = useState<RepoEvolutionNode[]>([]);
  const [customStarIds, setCustomStarIds] = useState<Set<string>>(() => new Set());
  const [customStarLabels, setCustomStarLabels] = useState<Record<string, string>>({});
  const [customForceCodeMap, setCustomForceCodeMap] = useState(false);

  // Bottom Paradigm Drift Comparator state
  const [compareSearch, setCompareSearch] = useState("");
  const [compareResults, setCompareResults] = useState<RepoEvolutionNode[]>([]);
  const [compareSelectedNode, setCompareSelectedNode] = useState<{ id: string; fullName: string } | null>(null);
  const [compareDropdownOpen, setCompareDropdownOpen] = useState(false);

  const loadStudioOverview = useCallback(
    async (selectOverrideId?: string) => {
      setListLoading(true);
      try {
        const [primRes, clusterRes] = await Promise.all([
          request<{ primitives: ArchitecturePrimitive[]; total: number }>(`${API_BASE}/architecture/primitives`),
          request<{ clusters: ArchitectureClusterRecommendation[] }>(`${API_BASE}/architecture/clusters`),
        ]);
        setPrimitives(primRes.primitives);
        setClusters(clusterRes.clusters);
        onPrimitiveCountChange?.(primRes.primitives.length);
        setSelectedId((prev) => {
          const wanted = selectOverrideId || prev || initialPrimitiveId || "";
          if (wanted && primRes.primitives.some((p) => p.id === wanted)) return wanted;
          return primRes.primitives[0]?.id ?? "";
        });
      } catch (err) {
        onError(describeError(err, "加载架构原语台数据失败"));
      } finally {
        setListLoading(false);
      }
    },
    [initialPrimitiveId, onError, onPrimitiveCountChange],
  );

  useEffect(() => {
    void loadStudioOverview();
  }, [loadStudioOverview]);

  useEffect(() => {
    if (initialPrimitiveId) {
      setSelectedId(initialPrimitiveId);
    }
  }, [initialPrimitiveId]);

  const loadPrimitiveDetail = useCallback(
    async (id: string) => {
      if (!id) {
        setSelectedPrimitive(null);
        setSelectedRuns([]);
        return;
      }
      setDetailLoading(true);
      try {
        const res = await request<{ primitive: ArchitecturePrimitive; runs: ArchitectureDistillationRun[] }>(
          `${API_BASE}/architecture/primitives/${encodeURIComponent(id)}`,
        );
        setSelectedPrimitive(res.primitive);
        setSelectedRuns(res.runs ?? []);
        setPrimitives((prev) => prev.map((p) => (p.id === res.primitive.id ? res.primitive : p)));
      } catch (err) {
        onError(describeError(err, "读取架构原语详情失败"));
      } finally {
        setDetailLoading(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    if (!selectedId) {
      setSelectedPrimitive(null);
      setSelectedRuns([]);
      return;
    }
    const cached = primitives.find((p) => p.id === selectedId);
    if (cached) setSelectedPrimitive(cached);
    void loadPrimitiveDetail(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Debounced Star repo search for Custom Distill modal
  useEffect(() => {
    if (!customOpen) return;
    const q = customStarSearch.trim();
    const controller = new AbortController();
    const t = window.setTimeout(() => {
      const qs = new URLSearchParams({ role: "starred", pageSize: "20", page: "1", sortBy: "stars" });
      if (q) qs.set("q", q);
      request<RepoEvolutionNodesPage>(`${API_BASE}/nodes?${qs.toString()}`, { signal: controller.signal })
        .then((res) => {
          if (!controller.signal.aborted) setCustomStarResults(res.items);
        })
        .catch(() => {});
    }, 200);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [customOpen, customStarSearch]);

  // Debounced Star repo search for Paradigm Drift Comparator
  useEffect(() => {
    const q = compareSearch.trim();
    if (!q) {
      setCompareResults([]);
      return;
    }
    const controller = new AbortController();
    const t = window.setTimeout(() => {
      const qs = new URLSearchParams({ role: "starred", q, pageSize: "12", page: "1", sortBy: "stars" });
      request<RepoEvolutionNodesPage>(`${API_BASE}/nodes?${qs.toString()}`, { signal: controller.signal })
        .then((res) => {
          if (!controller.signal.aborted) {
            setCompareResults(res.items);
            setCompareDropdownOpen(true);
          }
        })
        .catch(() => {});
    }, 220);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [compareSearch]);

  const filteredPrimitives = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return primitives.filter((p) => {
      if (filterStatus !== "all" && p.status !== filterStatus) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        (p.domainName ?? "").toLowerCase().includes(q) ||
        p.problemStatement.toLowerCase().includes(q)
      );
    });
  }, [primitives, filterQuery, filterStatus]);

  const quickCompareStars = useMemo(() => {
    const existingIds = new Set(selectedPrimitive?.starNodeIds ?? []);
    return (radialGraph?.starNodes ?? [])
      .slice()
      .sort((a, b) => Number(existingIds.has(a.id)) - Number(existingIds.has(b.id)) || b.starsCount - a.starsCount)
      .slice(0, 14);
  }, [radialGraph?.starNodes, selectedPrimitive?.starNodeIds]);

  const filteredOwnedForCustom = useMemo(() => {
    const q = customOwnedSearch.trim().toLowerCase();
    return allOwnedForCheckboxes.filter(
      (o) => !q || o.fullName.toLowerCase().includes(q) || o.name.toLowerCase().includes(q),
    );
  }, [allOwnedForCheckboxes, customOwnedSearch]);

  // ---- Studio Actions ----

  const handleDistillCluster = async (cluster: ArchitectureClusterRecommendation, forceCodeMap = false) => {
    setDistillingClusterId(cluster.id);
    onError("");
    try {
      const res = await request<DistillArchitecturePrimitiveResult>(`${API_BASE}/architecture/distill`, {
        method: "POST",
        body: JSON.stringify({
          clusterId: cluster.id,
          forceCodeMap,
        }),
      });
      setSelectedPrimitive(res.primitive);
      setSelectedId(res.primitive.id);
      onNotice({
        text:
          res.notice ||
          `已完成「${res.primitive.title}」零克隆第一性原理蒸馏（扫描 ${res.run.codeMapsScanned} 仓 · 缓存 ${res.run.codeMapsCached} 仓 · v${res.primitive.version}）。`,
      });
      await loadStudioOverview(res.primitive.id);
    } catch (err) {
      onError(describeError(err, `蒸馏「${cluster.title}」失败`));
    } finally {
      setDistillingClusterId("");
    }
  };

  const handleSubmitCustomDistill = async (e: FormEvent) => {
    e.preventDefault();
    const title = customTitle.trim();
    if (!title) return;
    if (customOwnedIds.size === 0 && customStarIds.size === 0) {
      onError("请至少勾选 1 个自有仓或 Star 仓进行跨库蒸馏");
      return;
    }
    setBusyOp("custom-distill");
    onError("");
    try {
      const res = await request<DistillArchitecturePrimitiveResult>(`${API_BASE}/architecture/distill`, {
        method: "POST",
        body: JSON.stringify({
          title,
          domainId: customDomainId || undefined,
          problemStatement: customProblem.trim() || undefined,
          ownedNodeIds: Array.from(customOwnedIds),
          starNodeIds: Array.from(customStarIds),
          forceCodeMap: customForceCodeMap,
        }),
      });
      setCustomOpen(false);
      setCustomTitle("");
      setCustomProblem("");
      setCustomOwnedIds(new Set());
      setCustomStarIds(new Set());
      setCustomStarLabels({});
      setSelectedPrimitive(res.primitive);
      setSelectedId(res.primitive.id);
      onNotice({
        text:
          res.notice ||
          `自定义跨库蒸馏完成：「${res.primitive.title}」（v${res.primitive.version}，0 MB 本地克隆）。`,
      });
      await loadStudioOverview(res.primitive.id);
    } catch (err) {
      onError(describeError(err, "自定义跨库蒸馏失败"));
    } finally {
      setBusyOp("");
    }
  };

  const handleStatusChange = async (status: ArchitecturePrimitiveStatus) => {
    if (!selectedPrimitive || selectedPrimitive.status === status) return;
    setBusyOp(`status:${status}`);
    onError("");
    try {
      const res = await request<{ primitive: ArchitecturePrimitive }>(
        `${API_BASE}/architecture/primitives/${encodeURIComponent(selectedPrimitive.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status }),
        },
      );
      setSelectedPrimitive(res.primitive);
      setPrimitives((prev) => prev.map((p) => (p.id === res.primitive.id ? res.primitive : p)));
      onNotice({ text: `架构原语状态已切换为「${ARCHITECTURE_PRIMITIVE_STATUS_LABELS[status]}」。` });
    } catch (err) {
      onError(describeError(err, "切换原语状态失败"));
    } finally {
      setBusyOp("");
    }
  };

  const handleRedistillCurrent = async () => {
    if (!selectedPrimitive) return;
    setBusyOp("redistill");
    onError("");
    try {
      const res = await request<DistillArchitecturePrimitiveResult>(`${API_BASE}/architecture/distill`, {
        method: "POST",
        body: JSON.stringify({
          primitiveId: selectedPrimitive.id,
          title: selectedPrimitive.title,
          domainId: selectedPrimitive.domainId,
          problemStatement: selectedPrimitive.problemStatement,
          ownedNodeIds: selectedPrimitive.ownedNodeIds,
          starNodeIds: selectedPrimitive.starNodeIds,
          forceCodeMap: true,
        }),
      });
      setSelectedPrimitive(res.primitive);
      onNotice({
        text:
          res.notice ||
          `已重新零克隆蒸馏「${res.primitive.title}」至 v${res.primitive.version}（扫描 ${res.run.codeMapsScanned} 仓）。`,
      });
      await loadStudioOverview(res.primitive.id);
      await loadPrimitiveDetail(res.primitive.id);
    } catch (err) {
      onError(describeError(err, "重新蒸馏失败"));
    } finally {
      setBusyOp("");
    }
  };

  const handleDeleteCurrent = async () => {
    if (!selectedPrimitive) return;
    if (!window.confirm(`确认删除架构原语「${selectedPrimitive.title}」？此操作不可撤销。`)) return;
    setBusyOp("delete");
    onError("");
    try {
      await request<{ ok: boolean }>(
        `${API_BASE}/architecture/primitives/${encodeURIComponent(selectedPrimitive.id)}`,
        { method: "DELETE" },
      );
      const remaining = primitives.filter((p) => p.id !== selectedPrimitive.id);
      setPrimitives(remaining);
      onPrimitiveCountChange?.(remaining.length);
      const nextId = remaining[0]?.id ?? "";
      setSelectedId(nextId);
      setSelectedPrimitive(remaining[0] ?? null);
      onNotice({ text: `已删除架构原语「${selectedPrimitive.title}」。` });
      void loadStudioOverview(nextId);
    } catch (err) {
      onError(describeError(err, "删除架构原语失败"));
    } finally {
      setBusyOp("");
    }
  };

  const handleProjectCanvas = async () => {
    if (!selectedPrimitive) return;
    setBusyOp("project-canvas");
    onError("");
    try {
      const res = await request<ProjectPrimitiveToCanvasResult>(
        `${API_BASE}/architecture/primitives/${encodeURIComponent(selectedPrimitive.id)}/project-canvas`,
        {
          method: "POST",
          body: JSON.stringify({
            canvasId: selectedPrimitive.canvasProjection?.canvasId,
            canvasName: `架构原语 · ${selectedPrimitive.title}`,
          }),
        },
      );
      setSelectedPrimitive(res.primitive);
      setPrimitives((prev) => prev.map((p) => (p.id === res.primitive.id ? res.primitive : p)));
      const canvasHref = res.href || `#canvas?id=${encodeURIComponent(res.canvasId)}`;
      onNotice({
        text: `已将 L1–L4 架构原语投射到无界知识画布「${res.canvasName}」（${res.nodeCount} 节点 / ${res.edgeCount} 连线）。`,
        href: canvasHref,
        hrefLabel: "直达知识画布 ↗",
      });
    } catch (err) {
      onError(describeError(err, "投射到无界知识画布失败"));
    } finally {
      setBusyOp("");
    }
  };

  const handleExportAdr = async (mode: "download" | "copy") => {
    if (!selectedPrimitive) return;
    setBusyOp(`export-${mode}`);
    onError("");
    try {
      const res = await request<ArchitecturePrimitiveExportJson>(
        `${API_BASE}/architecture/primitives/${encodeURIComponent(selectedPrimitive.id)}/export.md?format=json`,
      );
      if (mode === "download") {
        triggerMarkdownDownload(res.filename || `${selectedPrimitive.slug}-adr-v${selectedPrimitive.version}.md`, res.markdown);
        onNotice({ text: `已下载 ADR 架构规范：${res.filename}` });
      } else {
        const ok = await copyTextSafe(res.markdown);
        if (ok) {
          setCopiedMd(true);
          window.setTimeout(() => setCopiedMd(false), 2000);
          onNotice({ text: `已复制「${selectedPrimitive.title}」完整 ADR Markdown 到剪贴板。` });
        } else {
          onError("浏览器拒绝访问剪贴板，请改用「导出 ADR .md」下载文件。");
        }
      }
    } catch (err) {
      onError(describeError(err, "导出 ADR Markdown 失败"));
    } finally {
      setBusyOp("");
    }
  };

  const handleSubmitConsolidation = async (item: ArchitectureConsolidationItem) => {
    if (!selectedPrimitive) return;
    setBusyOp(`consolidate:${item.id}`);
    onError("");
    try {
      const note = consolidationNotes[item.id]?.trim();
      const res = await request<SubmitConsolidationResult>(
        `${API_BASE}/architecture/primitives/${encodeURIComponent(selectedPrimitive.id)}/submit-consolidation`,
        {
          method: "POST",
          body: JSON.stringify({
            itemId: item.id,
            note: note || undefined,
          }),
        },
      );
      setSelectedPrimitive(res.primitive);
      setPrimitives((prev) => prev.map((p) => (p.id === res.primitive.id ? res.primitive : p)));
      setConsolidationNotes((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      onNotice({
        text: res.reusedPending
          ? `底座收敛项「${item.title}」已有待批评估单在总裁信箱中（已自动复用）。`
          : `已将底座收敛提案「${item.title}」提交总裁信箱，等待你拍板决策。`,
        href: `#mailbox?decision=${encodeURIComponent(res.packet.id)}`,
        hrefLabel: "前往总裁信箱审批 ↗",
      });
    } catch (err) {
      onError(describeError(err, "提交底座收敛评估单失败"));
    } finally {
      setBusyOp("");
    }
  };

  const handleCompareRepo = async () => {
    if (!selectedPrimitive || !compareSelectedNode) return;
    setBusyOp("compare-repo");
    onError("");
    try {
      const res = await request<CompareRepoToPrimitiveResult>(
        `${API_BASE}/architecture/primitives/${encodeURIComponent(selectedPrimitive.id)}/compare-repo`,
        {
          method: "POST",
          body: JSON.stringify({
            nodeId: compareSelectedNode.id,
          }),
        },
      );
      setSelectedPrimitive(res.primitive);
      setPrimitives((prev) => prev.map((p) => (p.id === res.primitive.id ? res.primitive : p)));
      onNotice({
        text:
          res.notice ||
          `范式对照完成：${res.note.repoFullName} → ${PARADIGM_VERDICT_LABELS[res.note.verdict]}（置信度 ${Math.round(res.note.confidence * 100)}%）。`,
      });
      void loadPrimitiveDetail(selectedPrimitive.id);
    } catch (err) {
      onError(describeError(err, "执行新库范式对照检测失败"));
    } finally {
      setBusyOp("");
    }
  };

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const ownedCodeMapRefs: ArchitectureCodeMapRef[] = useMemo(
    () => (selectedPrimitive?.codeMapRefs ?? []).filter((r) => r.role === "owned" || r.role === "both"),
    [selectedPrimitive],
  );
  const starCodeMapRefs: ArchitectureCodeMapRef[] = useMemo(
    () => (selectedPrimitive?.codeMapRefs ?? []).filter((r) => r.role === "starred"),
    [selectedPrimitive],
  );

  return (
    <div className="re-arch-layout" data-testid="architecture-studio-tab">
      {/* 左侧边栏（两段式：已沉淀架构原语库 + 高密度推荐蒸馏簇） */}
      <aside className="re-arch-rail" aria-label="架构原语库与推荐蒸馏簇">
        {/* 段 1：已沉淀架构原语库 */}
        <section className="re-arch-rail-block">
          <div className="re-rail-head">
            <h3>已沉淀架构原语库 ({primitives.length})</h3>
            <button
              type="button"
              className="re-mini re-primary"
              data-testid="arch-custom-distill-btn"
              onClick={() => setCustomOpen(true)}
            >
              + 自定义蒸馏
            </button>
          </div>

          <div className="re-arch-filter-row">
            <input
              type="search"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="筛选原语标题 / 领域…"
              aria-label="筛选架构原语"
            />
            <select
              aria-label="原语状态筛选"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as ArchitecturePrimitiveStatus | "all")}
            >
              <option value="all">全部状态</option>
              <option value="draft">草案</option>
              <option value="validated">已验证</option>
              <option value="canonical">规范 Canonical</option>
            </select>
          </div>

          {listLoading && primitives.length === 0 ? (
            <p style={{ margin: "6px 0", fontSize: 12, color: "#656b64" }}>正在加载架构原语库…</p>
          ) : filteredPrimitives.length === 0 ? (
            <div className="re-arch-rail-empty">
              {primitives.length === 0
                ? "尚未沉淀架构原语。可从下方「高密度推荐蒸馏簇」一键零克隆蒸馏首份蓝图。"
                : "当前筛选条件下无匹配原语。"}
            </div>
          ) : (
            <ul className="re-arch-prim-list">
              {filteredPrimitives.map((p) => {
                const isSelected = selectedPrimitive?.id === p.id || selectedId === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="re-arch-prim-item"
                      data-testid="arch-primitive-item"
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => setSelectedId(p.id)}
                    >
                      <div className="re-arch-prim-head">
                        <span className="re-arch-prim-domain">
                          <span
                            className="re-domain-dot"
                            style={{ background: p.domainColor || "#2b4e3c" }}
                          />
                          <span>{p.domainName || "跨领域原语"}</span>
                        </span>
                        <span className={`re-arch-status-pill ${p.status}`}>
                          {ARCHITECTURE_PRIMITIVE_STATUS_LABELS[p.status]}
                        </span>
                      </div>
                      <strong className="re-arch-prim-title">{p.title}</strong>
                      <div className="re-arch-prim-meta">
                        <span className="re-mono">
                          {p.ownedNodeIds.length} 自有 × {p.starNodeIds.length} Star
                        </span>
                        <span className="re-mono">
                          v{p.version}
                          {p.privacyRestricted ? " · 🔒" : ""}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 段 2：高密度推荐蒸馏簇 */}
        <section className="re-arch-rail-block">
          <div className="re-rail-head">
            <h3>高密度推荐蒸馏簇 ({clusters.length})</h3>
            <button
              type="button"
              className="re-mini"
              disabled={listLoading}
              onClick={() => void loadStudioOverview()}
            >
              ↻ 刷新
            </button>
          </div>
          <p className="re-arch-rail-hint">
            自动从图谱 1 对 N Star 枢纽与多胞胎自有仓聚类发现，一键执行 0 MB 零克隆跨库解剖。
          </p>

          {clusters.length === 0 ? (
            <div className="re-arch-rail-empty">
              暂无推荐簇。可先在图谱建立更多 1 对 N 吸收边，或点击上方「+ 自定义蒸馏」。
            </div>
          ) : (
            <div className="re-cluster-list">
              {clusters.map((c) => {
                const isDistilling = distillingClusterId === c.id;
                const alreadyExists = Boolean(c.existingPrimitiveId);
                return (
                  <article key={c.id} className="re-cluster-card" data-testid="arch-cluster-card">
                    <div className="re-cluster-head">
                      <span className="re-arch-prim-domain">
                        <span
                          className="re-domain-dot"
                          style={{ background: c.domainColor || "#483d82" }}
                        />
                        <strong>{c.title}</strong>
                      </span>
                      <span className="re-pill re-mono">密度 {Math.round(c.densityScore * 100)}</span>
                    </div>
                    <p className="re-cluster-rationale">{c.rationale}</p>
                    <div className="re-cluster-stats re-mono">
                      <span>{c.ownedNodes.length} 自有仓</span>
                      <span>·</span>
                      <span>{c.starNodes.length} Star 枢纽</span>
                      <span>·</span>
                      <span>{c.linkCount} 吸收边</span>
                    </div>
                    <div className="re-badge-row">
                      {c.ownedNodes.slice(0, 3).map((n) => (
                        <span key={n.id} className="re-pill active">
                          自有: {n.name}
                        </span>
                      ))}
                      {c.starNodes.slice(0, 3).map((n) => (
                        <span key={n.id} className="re-pill">
                          ★ {n.name}
                        </span>
                      ))}
                    </div>
                    {isDistilling && (
                      <div className="re-distill-progress" role="status">
                        <span className="re-distill-spinner" />
                        <span>零克隆拉取源码树 + 提炼 L0–L4 第一性原理原语…</span>
                      </div>
                    )}
                    <div className="re-cluster-actions">
                      {alreadyExists ? (
                        <>
                          <button
                            type="button"
                            className="re-mini re-primary"
                            onClick={() => setSelectedId(c.existingPrimitiveId!)}
                          >
                            查看已沉淀蓝图
                          </button>
                          <button
                            type="button"
                            className="re-mini"
                            disabled={Boolean(distillingClusterId || busyOp)}
                            onClick={() => void handleDistillCluster(c, true)}
                          >
                            {isDistilling ? "重蒸馏中…" : "重新蒸馏"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="re-mini re-indigo"
                          data-testid="arch-distill-cluster-btn"
                          disabled={Boolean(distillingClusterId || busyOp)}
                          onClick={() => void handleDistillCluster(c, false)}
                        >
                          {isDistilling ? "零克隆蒸馏中…" : "⚡ 一键零克隆蒸馏"}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </aside>

      {/* 右侧白皮书式架构蓝图主区 */}
      <main className="re-arch-main" aria-label="架构原语白皮书主区">
        {!selectedPrimitive ? (
          <div className="re-arch-empty-canvas">
            <div className="re-empty-card">
              <h2>第一性原理架构原语台</h2>
              <p>
                将多胞胎自有仓与标杆 Star 仓进行 <strong>0 MB 零克隆源码级解剖</strong>，跨越框架表象，沉淀 L1 根本约束、L2 横向权衡矩阵、L3 最小不可再分抽象原语（契约代码 + 架构图 + 护栏）与 L4 自有资产底座收敛清单。
              </p>
              <div className="re-empty-actions">
                <button
                  type="button"
                  className="re-primary"
                  onClick={() => setCustomOpen(true)}
                >
                  + 自定义跨库蒸馏
                </button>
                {clusters[0] && (
                  <button
                    type="button"
                    className="re-indigo"
                    disabled={Boolean(distillingClusterId)}
                    onClick={() => void handleDistillCluster(clusters[0], false)}
                  >
                    ⚡ 蒸馏首个推荐簇：{clusters[0].title}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="re-arch-paper" data-testid="arch-whitepaper">
            {/* 顶栏操作条 */}
            <header className="re-arch-toolbar">
              <div className="re-arch-toolbar-left">
                <div className="re-seg-mini" role="group" aria-label="架构原语状态切换" data-testid="arch-status-switcher">
                  {(["draft", "validated", "canonical"] as ArchitecturePrimitiveStatus[]).map((st) => (
                    <button
                      key={st}
                      type="button"
                      className={selectedPrimitive.status === st ? "re-active" : ""}
                      disabled={Boolean(busyOp)}
                      onClick={() => void handleStatusChange(st)}
                    >
                      {ARCHITECTURE_PRIMITIVE_STATUS_LABELS[st]}
                    </button>
                  ))}
                </div>
                <span className="re-pill re-mono">v{selectedPrimitive.version}</span>
                <span className="re-pill">
                  {selectedPrimitive.distillationSource === "llm" ? "LLM + Code Map 证据" : "确定性 Code Map 蒸馏"}
                </span>
                {selectedPrimitive.privacyRestricted && (
                  <span className="re-pill private">🔒 私有仓零外发模式</span>
                )}
              </div>

              <div className="re-arch-toolbar-right">
                {selectedPrimitive.canvasProjection ? (
                  <>
                    <a
                      className="re-link-btn re-canvas-link-btn"
                      data-testid="arch-open-canvas-link"
                      href={
                        selectedPrimitive.canvasProjection.href ||
                        `#canvas?id=${encodeURIComponent(selectedPrimitive.canvasProjection.canvasId)}`
                      }
                    >
                      🎨 打开无界画布 ({selectedPrimitive.canvasProjection.nodeCount} 节点) ↗
                    </a>
                    <button
                      type="button"
                      className="re-mini"
                      data-testid="arch-project-canvas-btn"
                      disabled={Boolean(busyOp)}
                      onClick={() => void handleProjectCanvas()}
                    >
                      {busyOp === "project-canvas" ? "同步中…" : "↻ 重投画布"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="re-mini re-indigo"
                    data-testid="arch-project-canvas-btn"
                    disabled={Boolean(busyOp)}
                    onClick={() => void handleProjectCanvas()}
                  >
                    {busyOp === "project-canvas" ? "投射画布中…" : "🎨 投射到无界知识画布"}
                  </button>
                )}

                <button
                  type="button"
                  className="re-mini"
                  data-testid="arch-export-md-btn"
                  disabled={Boolean(busyOp)}
                  onClick={() => void handleExportAdr("download")}
                >
                  {busyOp === "export-download" ? "导出中…" : "⬇ 导出 ADR .md"}
                </button>
                <button
                  type="button"
                  className="re-mini"
                  disabled={Boolean(busyOp)}
                  onClick={() => void handleExportAdr("copy")}
                >
                  {copiedMd ? "✓ 已复制 MD" : "复制 ADR"}
                </button>
                <button
                  type="button"
                  className="re-mini"
                  disabled={Boolean(busyOp)}
                  onClick={() => void handleRedistillCurrent()}
                >
                  {busyOp === "redistill" ? "重蒸馏中…" : "↻ 重新蒸馏"}
                </button>
                <button
                  type="button"
                  className="re-mini re-danger"
                  disabled={Boolean(busyOp)}
                  onClick={() => void handleDeleteCurrent()}
                >
                  删除
                </button>
              </div>
            </header>

            <div className="re-arch-scroll">
              <article className="re-arch-doc">
                {detailLoading && (
                  <div style={{ fontSize: 12, color: "#5e645d" }}>正在同步最新蓝图与蒸馏日志…</div>
                )}

                {/* 白皮书封面头 */}
                <div className="re-arch-hero">
                  <div className="re-badge-row">
                    {selectedPrimitive.domainName && (
                      <span className="re-pill" style={{ borderColor: selectedPrimitive.domainColor || "#2b4e3c" }}>
                        <span
                          className="re-domain-dot"
                          style={{ background: selectedPrimitive.domainColor || "#2b4e3c" }}
                        />
                        {selectedPrimitive.domainName}
                      </span>
                    )}
                    <span className="re-zero-clone-badge">0 MB 本地克隆 · 源码证据驱动</span>
                    <span className="re-pill re-mono">{selectedPrimitive.slug}</span>
                    <span className="re-pill">更新于 {formatTimeFull(selectedPrimitive.updatedAt)}</span>
                  </div>

                  <h1>{selectedPrimitive.title}</h1>
                  <p className="re-arch-problem">{selectedPrimitive.problemStatement}</p>

                  {/* 章节锚点导航 */}
                  <nav className="re-arch-toc" aria-label="架构原语章节导航">
                    <button type="button" className="re-mini" onClick={() => scrollToSection("arch-sec-l0")}>
                      L0 证据仓 ({selectedPrimitive.codeMapRefs.length})
                    </button>
                    <button type="button" className="re-mini" onClick={() => scrollToSection("arch-sec-l1")}>
                      L1 根本约束 ({selectedPrimitive.firstPrinciples.length})
                    </button>
                    <button type="button" className="re-mini" onClick={() => scrollToSection("arch-sec-l2")}>
                      L2 Trade-off 矩阵 ({selectedPrimitive.tradeoffMatrix.approaches.length})
                    </button>
                    <button type="button" className="re-mini" onClick={() => scrollToSection("arch-sec-l3")}>
                      L3 最小抽象原语
                    </button>
                    <button type="button" className="re-mini" onClick={() => scrollToSection("arch-sec-l4")}>
                      L4 底座收敛 ({selectedPrimitive.consolidationPlan.length})
                    </button>
                    <button type="button" className="re-mini" onClick={() => scrollToSection("arch-sec-paradigm")}>
                      范式对照检测 ({selectedPrimitive.paradigmNotes.length})
                    </button>
                  </nav>
                </div>

                {/* ============ L0：参与解剖仓库与 Code Map 证据条 ============ */}
                <section id="arch-sec-l0" className="re-arch-section" data-testid="arch-section-l0">
                  <div className="re-arch-sec-head">
                    <span className="re-arch-layer-tag">L0</span>
                    <div>
                      <h2>参与解剖仓库与零克隆 Code Map 证据</h2>
                      <p>点击任意仓库芯片可直接打开其零克隆 Code Map 抽屉，或点击「光环」跳回同心图谱定位。</p>
                    </div>
                  </div>

                  <div className="re-l0-groups">
                    <div className="re-l0-group">
                      <h3>我的自有资产仓 ({ownedCodeMapRefs.length})</h3>
                      <div className="re-l0-chip-grid">
                        {ownedCodeMapRefs.map((ref) => (
                          <div key={ref.nodeId} className="re-l0-chip owned" data-testid="arch-l0-repo-chip">
                            <div className="re-l0-chip-top">
                              <button
                                type="button"
                                className="re-l0-name-btn"
                                title="打开该仓的零克隆 Code Map 详情"
                                onClick={() => onOpenNodeCodeMap(ref.nodeId)}
                              >
                                {ref.visibility === "private" ? "🔒 " : ""}
                                <strong>{ref.repoFullName}</strong>
                              </button>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button
                                  type="button"
                                  className="re-mini"
                                  title="打开零克隆 Code Map"
                                  onClick={() => onOpenNodeCodeMap(ref.nodeId)}
                                >
                                  Code Map
                                </button>
                                <button
                                  type="button"
                                  className="re-mini"
                                  title="在同心光环图谱中定位"
                                  onClick={() => onLocateNode(ref.nodeId)}
                                >
                                  ⌖ 光环
                                </button>
                              </div>
                            </div>
                            <div className="re-l0-meta re-mono">
                              <span>{ref.primaryLanguage || "多语言"}</span>
                              <span>·</span>
                              <span>Commit {ref.commitSha.slice(0, 7)}</span>
                              <span>·</span>
                              <span>解析 {ref.analyzedFileCount} 文件</span>
                            </div>
                            {ref.topHotspots.length > 0 && (
                              <div className="re-l0-hotspots">
                                {ref.topHotspots.slice(0, 3).map((h) => {
                                  const href = safeExternalUrl(h.url);
                                  return (
                                    <div key={h.path} className="re-l0-hotspot-line">
                                      {href ? (
                                        <a href={href} target="_blank" rel="noreferrer" className="re-mono">
                                          {h.path} ↗
                                        </a>
                                      ) : (
                                        <code className="re-mono">{h.path}</code>
                                      )}
                                      <small>入度 {h.importedByCount}</small>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ))}
                        {ownedCodeMapRefs.length === 0 && (
                          <span className="re-arch-muted">暂无自有仓 Code Map 证据记录。</span>
                        )}
                      </div>
                    </div>

                    <div className="re-l0-group">
                      <h3>标杆 Star 仓 ({starCodeMapRefs.length})</h3>
                      <div className="re-l0-chip-grid">
                        {starCodeMapRefs.map((ref) => (
                          <div key={ref.nodeId} className="re-l0-chip starred" data-testid="arch-l0-repo-chip">
                            <div className="re-l0-chip-top">
                              <button
                                type="button"
                                className="re-l0-name-btn"
                                title="打开该仓的零克隆 Code Map 详情"
                                onClick={() => onOpenNodeCodeMap(ref.nodeId)}
                              >
                                ★ <strong>{ref.repoFullName}</strong>
                              </button>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button
                                  type="button"
                                  className="re-mini"
                                  title="打开零克隆 Code Map"
                                  onClick={() => onOpenNodeCodeMap(ref.nodeId)}
                                >
                                  Code Map
                                </button>
                                <button
                                  type="button"
                                  className="re-mini"
                                  title="在同心光环图谱中定位"
                                  onClick={() => onLocateNode(ref.nodeId)}
                                >
                                  ⌖ 光环
                                </button>
                              </div>
                            </div>
                            <div className="re-l0-meta re-mono">
                              <span>★ {formatStars(ref.starsCount)}</span>
                              <span>·</span>
                              <span>{ref.primaryLanguage || "多语言"}</span>
                              <span>·</span>
                              <span>{ref.commitSha.slice(0, 7)}</span>
                              <span>·</span>
                              <span>{ref.analyzedFileCount} 文件</span>
                            </div>
                            {ref.topHotspots.length > 0 && (
                              <div className="re-l0-hotspots">
                                {ref.topHotspots.slice(0, 3).map((h) => {
                                  const href = safeExternalUrl(h.url);
                                  return (
                                    <div key={h.path} className="re-l0-hotspot-line">
                                      {href ? (
                                        <a href={href} target="_blank" rel="noreferrer" className="re-mono">
                                          {h.path} ↗
                                        </a>
                                      ) : (
                                        <code className="re-mono">{h.path}</code>
                                      )}
                                      <small>入度 {h.importedByCount}</small>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ))}
                        {starCodeMapRefs.length === 0 && (
                          <span className="re-arch-muted">暂无 Star 仓 Code Map 证据记录。</span>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                {/* ============ L1：根本约束（First-Principles Constraints） ============ */}
                <section id="arch-sec-l1" className="re-arch-section" data-testid="arch-section-l1">
                  <div className="re-arch-sec-head">
                    <span className="re-arch-layer-tag">L1</span>
                    <div>
                      <h2>根本约束（First-Principles Constraints）</h2>
                      <p>剥离语言与框架语法糖之后，由物理延迟、工程复杂性、安全隔离与成本边界决定的不可绕过约束。</p>
                    </div>
                  </div>

                  <div className="re-principles-grid">
                    {selectedPrimitive.firstPrinciples.map((fp, idx) => (
                      <article key={fp.id || `fp-${idx}`} className="re-principle-card" data-category={fp.category}>
                        <div className="re-principle-head">
                          <span className={`re-cat-pill ${fp.category}`}>
                            {ARCHITECTURE_CONSTRAINT_CATEGORY_LABELS[fp.category] ?? fp.category}
                          </span>
                          <span className="re-mono" style={{ fontSize: 11, color: "#686e67" }}>
                            FP-{String(idx + 1).padStart(2, "0")}
                          </span>
                        </div>
                        <h3>{fp.title}</h3>
                        <p className="re-principle-constraint">{fp.constraint}</p>
                        <div className="re-principle-kv-grid">
                          <div className="re-principle-kv">
                            <strong>为何不可绕过</strong>
                            <span>{fp.whyIrreducible}</span>
                          </div>
                          <div className="re-principle-kv warn">
                            <strong>违背后的失效模式</strong>
                            <span>{fp.failureWhenViolated}</span>
                          </div>
                        </div>
                        {renderEvidenceChips(fp.evidence, `fp-${fp.id || idx}`)}
                      </article>
                    ))}
                  </div>
                </section>

                {/* ============ L2：横向方案对比与 Trade-off 矩阵 ============ */}
                <section id="arch-sec-l2" className="re-arch-section" data-testid="arch-section-l2">
                  <div className="re-arch-sec-head">
                    <span className="re-arch-layer-tag">L2</span>
                    <div>
                      <h2>横向方案对比与 Trade-off 矩阵</h2>
                      <p>揭示不同开源路线分别牺牲了什么、换取了什么，附真实源码路径证据。</p>
                    </div>
                  </div>

                  {selectedPrimitive.tradeoffMatrix.summary && (
                    <div className="re-rationale-callout" style={{ marginBottom: 12 }}>
                      <strong>核心路线分岔洞察：</strong>
                      {selectedPrimitive.tradeoffMatrix.summary}
                    </div>
                  )}

                  <div className="re-tradeoff-scroll">
                    <table className="re-tradeoff-table" data-testid="arch-tradeoff-table">
                      <thead>
                        <tr>
                          <th style={{ minWidth: 185 }}>架构路线与代表仓</th>
                          {selectedPrimitive.tradeoffMatrix.dimensions.map((dim) => (
                            <th key={dim.key} style={{ minWidth: 126 }} title={dim.description}>
                              <div>{dim.label}</div>
                              {dim.description && <small className="re-th-sub">{dim.description}</small>}
                            </th>
                          ))}
                          <th style={{ minWidth: 170 }}>换取收益 (Gains)</th>
                          <th style={{ minWidth: 170 }}>付出牺牲 (Sacrifices)</th>
                          <th style={{ minWidth: 155 }}>适用场景 & 源码证据</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedPrimitive.tradeoffMatrix.approaches.map((app) => (
                          <tr key={app.id}>
                            <td>
                              <strong className="re-approach-name">{app.name}</strong>
                              <div className="re-badge-row" style={{ marginTop: 5 }}>
                                {app.representativeRepos.map((repo) => (
                                  <span key={repo} className="re-pill re-mono">
                                    {repo}
                                  </span>
                                ))}
                              </div>
                            </td>
                            {selectedPrimitive.tradeoffMatrix.dimensions.map((dim) => (
                              <td key={dim.key}>{app.scores?.[dim.key] || "—"}</td>
                            ))}
                            <td className="re-cell-gain">{app.gains}</td>
                            <td className="re-cell-sacrifice">{app.sacrifices}</td>
                            <td>
                              <div style={{ marginBottom: 6 }}>{app.bestFor}</div>
                              {renderEvidenceChips(app.evidence, `app-${app.id}`)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* ============ L3：最小不可再分抽象原语（Primitive Spec） ============ */}
                <section id="arch-sec-l3" className="re-arch-section" data-testid="arch-section-l3">
                  <div className="re-arch-sec-head">
                    <span className="re-arch-layer-tag">L3</span>
                    <div>
                      <h2>最小不可再分抽象原语（Primitive Spec）</h2>
                      <p>如果今天从零构建自有底座，剥离一切偶然复杂度后的最小核心实体、协议契约、拓扑图与安全护栏。</p>
                    </div>
                  </div>

                  {/* 核心命题与不变量 */}
                  <div className="re-thesis-banner">
                    <div className="re-thesis-label">CORE THESIS · 最小原语核心命题</div>
                    <p>{selectedPrimitive.primitiveSpec.coreThesis}</p>
                    {selectedPrimitive.primitiveSpec.invariants.length > 0 && (
                      <div className="re-invariants-row">
                        {selectedPrimitive.primitiveSpec.invariants.map((inv, idx) => (
                          <span key={`inv-${idx}`} className="re-invariant-chip">
                            ❖ {inv}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 核心实体与职责卡片 */}
                  <h3 className="re-subblock-title">核心实体与边界职责</h3>
                  <div className="re-entities-grid">
                    {selectedPrimitive.primitiveSpec.entities.map((ent, idx) => (
                      <article key={`${ent.name}-${idx}`} className="re-entity-card">
                        <div className="re-entity-head">
                          <strong>{ent.name}</strong>
                          <span className="re-mono">E{idx + 1}</span>
                        </div>
                        <p className="re-entity-resp">{ent.responsibility}</p>
                        <div className="re-entity-boundary">
                          <strong>职责边界：</strong>
                          {ent.boundaries}
                        </div>
                        {ent.keyOperations.length > 0 && (
                          <div className="re-badge-row" style={{ marginTop: 4 }}>
                            {ent.keyOperations.map((op) => (
                              <code key={op} className="re-op-chip">
                                {op}
                              </code>
                            ))}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>

                  {/* 最小协议/接口契约代码块 */}
                  <div className="re-contract-frame">
                    <div className="re-contract-head">
                      <span>
                        <strong>最小协议 / 接口契约</strong>
                        <span className="re-pill re-mono" style={{ marginLeft: 8 }}>
                          {selectedPrimitive.primitiveSpec.contractLanguage.toUpperCase()}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => {
                          void copyTextSafe(selectedPrimitive.primitiveSpec.protocolContractCode).then((ok) => {
                            if (ok) {
                              setCopiedContract(true);
                              window.setTimeout(() => setCopiedContract(false), 1800);
                            }
                          });
                        }}
                      >
                        {copiedContract ? "✓ 已复制契约" : "复制契约代码"}
                      </button>
                    </div>
                    <pre className="re-code-block" style={{ margin: 0, borderRadius: 0, border: 0 }}>
                      <code>{selectedPrimitive.primitiveSpec.protocolContractCode}</code>
                    </pre>
                  </div>

                  {/* Mermaid 架构图清晰可视化区域 */}
                  {selectedPrimitive.primitiveSpec.mermaidDiagram && (
                    <MermaidArchitectureDiagram
                      code={selectedPrimitive.primitiveSpec.mermaidDiagram}
                      caption={selectedPrimitive.primitiveSpec.diagramCaption}
                    />
                  )}

                  {/* 失败模式与安全护栏清单 */}
                  {selectedPrimitive.primitiveSpec.failureModesAndGuardrails.length > 0 && (
                    <>
                      <h3 className="re-subblock-title">失败模式与安全护栏清单</h3>
                      <div className="re-guardrail-grid">
                        {selectedPrimitive.primitiveSpec.failureModesAndGuardrails.map((g, idx) => (
                          <article key={`gr-${idx}`} className="re-guardrail-card">
                            <div className="re-guardrail-title">
                              <span className="re-pill rejected">失效 #{idx + 1}</span>
                              <strong>{g.failureMode}</strong>
                            </div>
                            <p className="re-module-kv">
                              <strong>影响面：</strong>
                              {g.impact}
                            </p>
                            <p className="re-module-kv">
                              <strong>安全护栏：</strong>
                              {g.guardrail}
                            </p>
                            <p className="re-module-kv">
                              <strong>检测信号：</strong>
                              <code className="re-mono">{g.detectionSignal}</code>
                            </p>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                {/* ============ L4：自有资产底座收敛与升级清单 ============ */}
                <section id="arch-sec-l4" className="re-arch-section" data-testid="arch-section-l4">
                  <div className="re-arch-sec-head">
                    <span className="re-arch-layer-tag l4">L4</span>
                    <div>
                      <h2>自有资产底座收敛与能力升级清单</h2>
                      <p>识别重复造轮子的多胞胎自有仓组合，明确应下沉的共享能力底座，每项可一键提交总裁信箱审批立项。</p>
                    </div>
                  </div>

                  <div className="re-consolidation-list">
                    {selectedPrimitive.consolidationPlan.map((item) => {
                      const submitting = busyOp === `consolidate:${item.id}`;
                      return (
                        <article
                          key={item.id}
                          className="re-consolidation-card"
                          data-testid="arch-consolidation-card"
                        >
                          <div className="re-consolidation-head">
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <div className="re-badge-row">
                                <span className="re-pill in_review">
                                  {ARCHITECTURE_CONSOLIDATION_KIND_LABELS[item.kind] ?? item.kind}
                                </span>
                                <span className="re-pill">工作量 {item.effort}</span>
                                <span
                                  className={`re-pill ${
                                    item.risk === "high"
                                      ? "rejected"
                                      : item.risk === "medium"
                                        ? "suggested"
                                        : "active"
                                  }`}
                                >
                                  {item.risk === "high" ? "高风险" : item.risk === "medium" ? "中风险" : "低风险"}
                                </span>
                              </div>
                              <h3>{item.title}</h3>
                            </div>
                            <div className="re-shared-cap-badge">
                              <span>推荐下沉共享底座</span>
                              <strong>📦 {item.sharedCapabilityName}</strong>
                            </div>
                          </div>

                          {/* 多胞胎自有仓组合 + 参考 Star 仓 */}
                          <div className="re-consolidation-repos">
                            <div className="re-badge-row">
                              <span style={{ fontSize: 11.5, fontWeight: 650, color: "#2b4e3c" }}>
                                涉及自有仓组合：
                              </span>
                              {item.targetOwnedRepos.map((repo, rIdx) => {
                                const nid = item.targetNodeIds[rIdx];
                                return nid ? (
                                  <button
                                    key={`${item.id}-own-${repo}`}
                                    type="button"
                                    className="re-mini"
                                    onClick={() => onOpenNodeCodeMap(nid)}
                                  >
                                    🧬 {repo}
                                  </button>
                                ) : (
                                  <span key={`${item.id}-own-${repo}`} className="re-pill active">
                                    🧬 {repo}
                                  </span>
                                );
                              })}
                            </div>
                            {item.referenceStarRepos.length > 0 && (
                              <div className="re-badge-row">
                                <span style={{ fontSize: 11.5, fontWeight: 650, color: "#5e645d" }}>
                                  参考标杆 Star：
                                </span>
                                {item.referenceStarRepos.map((repo) => (
                                  <span key={`${item.id}-star-${repo}`} className="re-pill">
                                    ★ {repo}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="re-consolidation-body">
                            <p className="re-module-kv">
                              <strong>重复造轮子 / 现状差距：</strong>
                              {item.currentDuplicationOrGap}
                            </p>
                            <p className="re-module-kv">
                              <strong>收敛与升级落地动作：</strong>
                              {item.proposedAction}
                            </p>
                            <p className="re-module-kv">
                              <strong>预期收益：</strong>
                              {item.expectedImpact}
                            </p>
                          </div>

                          {renderEvidenceChips(item.evidence, `cons-${item.id}`)}

                          <div className="re-consolidation-foot">
                            {item.decisionPacketId ? (
                              <div className="re-mailbox-card" style={{ width: "100%" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                  <span>
                                    <strong>📮 已提交总裁信箱审批</strong> · 审批单 <code>{item.decisionPacketId}</code>
                                    {item.decisionStatus ? ` (${item.decisionStatus})` : ""}
                                  </span>
                                  <a
                                    className="re-link-btn"
                                    href={`#mailbox?decision=${encodeURIComponent(item.decisionPacketId)}`}
                                  >
                                    在总裁信箱打开审批单 ↗
                                  </a>
                                </div>
                              </div>
                            ) : (
                              <>
                                <input
                                  type="text"
                                  value={consolidationNotes[item.id] ?? ""}
                                  onChange={(e) =>
                                    setConsolidationNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                                  }
                                  placeholder="可选：提交总裁信箱时附带备注或优先级说明…"
                                  style={{ flex: "1 1 220px" }}
                                />
                                <button
                                  type="button"
                                  className="re-indigo"
                                  data-testid="arch-submit-consolidation-btn"
                                  disabled={Boolean(busyOp)}
                                  onClick={() => void handleSubmitConsolidation(item)}
                                >
                                  {submitting ? "提交审批中…" : "📮 提交总裁信箱评估"}
                                </button>
                              </>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>

                {/* ============ 底部：新库范式对照检测面板 ============ */}
                <section
                  id="arch-sec-paradigm"
                  className="re-arch-section re-paradigm-section"
                  data-testid="arch-paradigm-panel"
                >
                  <div className="re-arch-sec-head">
                    <span className="re-arch-layer-tag paradigm">Δ</span>
                    <div>
                      <h2>新库范式对照检测（Paradigm Drift Detector）</h2>
                      <p>
                        选择或搜索任意一个 Star 仓，系统零克隆扫描其 Code Map 并对照本架构原语的 L1–L3 假设，判别是「范式印证」「工程微调」还是打破底层假设的「范式跃迁」。
                      </p>
                    </div>
                  </div>

                  <div className="re-paradigm-picker">
                    <div className="re-paradigm-search-wrap">
                      <input
                        type="search"
                        data-testid="arch-compare-search-input"
                        value={compareSearch}
                        onFocus={() => setCompareDropdownOpen(true)}
                        onBlur={() => window.setTimeout(() => setCompareDropdownOpen(false), 180)}
                        onChange={(e) => {
                          setCompareSearch(e.target.value);
                          setCompareDropdownOpen(true);
                        }}
                        placeholder="搜索任意 Star 仓名（支持 2,000+ Star 全库检索）或从下方快速选择…"
                      />
                      {compareDropdownOpen && (compareSearch.trim() ? compareResults : quickCompareStars).length > 0 && (
                        <ul className="re-search-dropdown" style={{ left: 0, right: "auto", width: "100%" }}>
                          {(compareSearch.trim() ? compareResults : quickCompareStars).map((repo) => (
                            <li key={repo.id}>
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  setCompareSelectedNode({ id: repo.id, fullName: repo.fullName });
                                  setCompareSearch(repo.fullName);
                                  setCompareDropdownOpen(false);
                                }}
                              >
                                <span>
                                  <strong>{repo.fullName}</strong>
                                  <small style={{ display: "block", color: "#656b64" }}>
                                    {repo.primaryLanguage || "—"} · ★ {formatStars(repo.starsCount)}
                                    {repo.description ? ` · ${truncateVisual(repo.description, 44)}` : ""}
                                  </small>
                                </span>
                                <span className="re-pill">选择</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <button
                      type="button"
                      className="re-primary"
                      data-testid="arch-compare-repo-btn"
                      disabled={!compareSelectedNode || Boolean(busyOp)}
                      onClick={() => void handleCompareRepo()}
                    >
                      {busyOp === "compare-repo" ? "零克隆对照检测中…" : "⚡ 对照原语检测范式漂移"}
                    </button>
                  </div>

                  {quickCompareStars.length > 0 && (
                    <div className="re-badge-row" style={{ marginTop: 8 }}>
                      <span style={{ fontSize: 11.5, color: "#60665f" }}>快捷推荐待检仓：</span>
                      {quickCompareStars.slice(0, 6).map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`re-mini ${compareSelectedNode?.id === s.id ? "re-active" : ""}`}
                          onClick={() => {
                            setCompareSelectedNode({ id: s.id, fullName: s.fullName });
                            setCompareSearch(s.fullName);
                          }}
                        >
                          ★ {s.fullName}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 历史对照记录列表 */}
                  <div className="re-paradigm-notes-list">
                    {selectedPrimitive.paradigmNotes.length === 0 ? (
                      <div className="re-codemap-empty" style={{ marginTop: 10 }}>
                        尚未执行新库范式对照检测。选择上方任意 Star 仓即可检验它是否挑战了本原语的第一性原理。
                      </div>
                    ) : (
                      selectedPrimitive.paradigmNotes.map((note) => (
                        <article
                          key={note.id}
                          className={`re-paradigm-card ${note.verdict}`}
                          data-testid="arch-paradigm-note-card"
                        >
                          <div className="re-paradigm-card-head">
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span className={`re-verdict-badge ${note.verdict}`}>
                                {note.verdict === "paradigm_shift"
                                  ? "⚡ "
                                  : note.verdict === "engineering_tweak"
                                    ? "⚙ "
                                    : "✓ "}
                                {PARADIGM_VERDICT_LABELS[note.verdict] || note.verdictLabel}
                              </span>
                              <button
                                type="button"
                                className="re-l0-name-btn"
                                onClick={() => onOpenNodeCodeMap(note.repoNodeId)}
                              >
                                <strong>{note.repoFullName}</strong>
                              </button>
                              <span className="re-pill re-mono">Commit {note.commitSha.slice(0, 7)}</span>
                              <span className="re-pill re-mono">置信度 {Math.round(note.confidence * 100)}%</span>
                            </div>
                            <span style={{ fontSize: 11.5, color: "#646b64" }}>
                              {note.usedLlm ? "LLM 深度对照" : "Code Map 结构对照"} · {formatTimeFull(note.comparedAt)}
                            </span>
                          </div>

                          <p className="re-paradigm-summary">{note.summary}</p>

                          <div className="re-paradigm-cols">
                            {note.challengedAssumptions.length > 0 && (
                              <div className="re-paradigm-col warn">
                                <strong>被挑战的核心假设</strong>
                                <ul>
                                  {note.challengedAssumptions.map((x, idx) => (
                                    <li key={`ca-${idx}`}>{x}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {note.confirmedPrinciples.length > 0 && (
                              <div className="re-paradigm-col ok">
                                <strong>被印证的第一性原理</strong>
                                <ul>
                                  {note.confirmedPrinciples.map((x, idx) => (
                                    <li key={`cp-${idx}`}>{x}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {note.deltaCapabilities.length > 0 && (
                              <div className="re-paradigm-col delta">
                                <strong>增量能力与工程差异</strong>
                                <ul>
                                  {note.deltaCapabilities.map((x, idx) => (
                                    <li key={`dc-${idx}`}>{x}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>

                          {renderEvidenceChips(note.evidence, `pn-${note.id}`)}
                        </article>
                      ))
                    )}
                  </div>
                </section>

                {/* 蒸馏运行历史日志（折叠） */}
                {selectedRuns.length > 0 && (
                  <details className="re-arch-runs-box">
                    <summary>蒸馏与对照运行审计日志 ({selectedRuns.length})</summary>
                    <ul className="re-arch-runs-list">
                      {selectedRuns.map((run) => (
                        <li key={run.id} className="re-mono">
                          <span>{formatTimeFull(run.createdAt)}</span>
                          <span>·</span>
                          <span>
                            {run.triggerKind === "compare_repo"
                              ? "范式对照"
                              : run.triggerKind === "redistill"
                                ? "重新蒸馏"
                                : "首次蒸馏"}
                          </span>
                          <span>·</span>
                          <span>
                            扫描 {run.codeMapsScanned} / 缓存 {run.codeMapsCached}
                          </span>
                          <span>·</span>
                          <span>{run.usedLlm ? "LLM" : "确定性引擎"}</span>
                          <span>·</span>
                          <span>{(run.durationMs / 1000).toFixed(1)}s</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            </div>
          </div>
        )}
      </main>

      {/* 自定义跨库蒸馏弹窗 */}
      {customOpen && (
        <div className="re-modal-backdrop" onClick={() => setCustomOpen(false)}>
          <form
            className="re-modal re-modal-wide"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void handleSubmitCustomDistill(e)}
          >
            <div className="re-modal-head">
              <h2>自定义跨库第一性原理蒸馏</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setCustomOpen(false)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <div className="re-form-grid">
                <label className="re-field">
                  <span>架构主题名称（必填）</span>
                  <input
                    type="text"
                    required
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="如：受控浏览器感知与动作执行网关"
                  />
                </label>
                <label className="re-field">
                  <span>归属技术领域（选填）</span>
                  <select value={customDomainId} onChange={(e) => setCustomDomainId(e.target.value)}>
                    <option value="">自动推断 / 跨领域</option>
                    {domains.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="re-field">
                <span>要解决的核心架构问题（选填）</span>
                <textarea
                  rows={2}
                  value={customProblem}
                  onChange={(e) => setCustomProblem(e.target.value)}
                  placeholder="说明希望跨库抽象的核心痛点、约束或底座收敛目标…"
                />
              </label>

              <div className="re-form-grid">
                <div className="re-field">
                  <span>勾选参与的自有仓 ({customOwnedIds.size})</span>
                  <input
                    type="search"
                    value={customOwnedSearch}
                    onChange={(e) => setCustomOwnedSearch(e.target.value)}
                    placeholder="筛选我的开源库…"
                  />
                  <div className="re-checkbox-list" style={{ maxHeight: 190 }}>
                    {filteredOwnedForCustom.map((o) => {
                      const checked = customOwnedIds.has(o.id);
                      return (
                        <label key={o.id} className="re-checkbox-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setCustomOwnedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(o.id)) next.delete(o.id);
                                else next.add(o.id);
                                return next;
                              });
                            }}
                          />
                          <span>
                            {o.priorityTier === "spotlight" ? "★ " : ""}
                            {o.visibility === "private" ? "🔒 " : ""}
                            <strong>{o.name}</strong>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="re-field">
                  <span>勾选标杆 Star 仓 ({customStarIds.size})</span>
                  <input
                    type="search"
                    value={customStarSearch}
                    onChange={(e) => setCustomStarSearch(e.target.value)}
                    placeholder="搜索 2,000+ Star 仓名…"
                  />
                  {customStarIds.size > 0 && (
                    <div className="re-badge-row">
                      {Array.from(customStarIds).map((sid) => (
                        <span key={sid} className="re-pill active">
                          ★ {customStarLabels[sid] || sid}
                          <button
                            type="button"
                            className="re-ghost re-mini"
                            style={{ padding: "0 2px" }}
                            onClick={() =>
                              setCustomStarIds((prev) => {
                                const next = new Set(prev);
                                next.delete(sid);
                                return next;
                              })
                            }
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="re-checkbox-list" style={{ maxHeight: 190 }}>
                    {customStarResults.map((s) => {
                      const checked = customStarIds.has(s.id);
                      return (
                        <label key={s.id} className="re-checkbox-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setCustomStarIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(s.id)) next.delete(s.id);
                                else next.add(s.id);
                                return next;
                              });
                              setCustomStarLabels((prev) => ({ ...prev, [s.id]: s.fullName }));
                            }}
                          />
                          <span>
                            <strong>{s.fullName}</strong>{" "}
                            <small style={{ color: "#686e67" }}>★{formatStars(s.starsCount)}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              <label className="re-check-toggle" style={{ alignSelf: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={customForceCodeMap}
                  onChange={(e) => setCustomForceCodeMap(e.target.checked)}
                />
                <span>强制重新执行零克隆 Code Map 扫描（忽略同 Commit 缓存）</span>
              </label>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setCustomOpen(false)}>
                取消
              </button>
              <button
                type="submit"
                className="re-indigo"
                disabled={busyOp === "custom-distill" || !customTitle.trim() || (customOwnedIds.size === 0 && customStarIds.size === 0)}
              >
                {busyOp === "custom-distill" ? "零克隆跨库蒸馏中…" : "⚡ 开始零克隆跨库蒸馏"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export function RepoEvolution({
  nav,
  hashQuery = "",
  initialTab,
  initialLinkId,
  initialRepo,
  initialDomainId,
  initialNodeId,
  initialBucket,
}: {
  nav?: ReactNode;
  hashQuery?: string;
  initialTab?: MainTab;
  initialLinkId?: string;
  initialRepo?: string;
  initialDomainId?: string;
  initialNodeId?: string;
  initialBucket?: string;
}) {
  const [activeTab, setActiveTab] = useState<MainTab>(() => {
    const qTab = new URLSearchParams(hashQuery).get("tab");
    if (qTab === "graph" || qTab === "domains" || qTab === "timeline" || qTab === "architecture") {
      return qTab;
    }
    return initialTab ?? "graph";
  });
  const [deepLinkPrimitiveId, setDeepLinkPrimitiveId] = useState<string>(
    () => new URLSearchParams(hashQuery).get("primitive") || "",
  );
  const [primitiveCount, setPrimitiveCount] = useState<number>(0);

  // Halo visual theme (default: cosmic star-halo, toggleable to washi paper astrolabe)
  const [haloTheme, setHaloTheme] = useState<HaloTheme>(() => {
    try {
      const saved = window.localStorage.getItem("re.radial.theme");
      if (saved === "washi" || saved === "cosmic") return saved;
    } catch {
      // ignore storage errors
    }
    return "cosmic";
  });

  // Core data states
  const [radialGraph, setRadialGraph] = useState<RepoEvolutionRadialGraph | null>(null);
  const [macroGraph, setMacroGraph] = useState<RepoEvolutionMacroGraph | null>(null);

  // Radial query controls
  const [includeForks, setIncludeForks] = useState(false);
  const [includeRejected, setIncludeRejected] = useState(false);
  const [statusFilter, setStatusFilter] = useState<RepoAbsorptionStatus | "all">("all");
  const [maxStarsPerOwned, setMaxStarsPerOwned] = useState(16);

  // Progressive concentric expansion state
  const [expandedDomainIds, setExpandedDomainIds] = useState<Set<string>>(() => new Set());
  const [expandedOwnedIds, setExpandedOwnedIds] = useState<Set<string>>(() => new Set());
  const [ownedStarCaps, setOwnedStarCaps] = useState<Record<string, number>>({});
  const initializedExpansionRef = useRef(false);

  // Viewport & pan/zoom state (world origin (0,0) = Center Core)
  const [viewport, setViewport] = useState<ViewportState>({ x: 460, y: 310, zoom: 0.72 });
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredDomainId, setHoveredDomainId] = useState<string | null>(null);
  const [hoveredOwnedId, setHoveredOwnedId] = useState<string | null>(null);
  const [hoveredStarId, setHoveredStarId] = useState<string | null>(null);
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);

  // Pending camera target after state update / layout recalculation
  const pendingFocusTargetRef = useRef<
    | { kind: "fit" }
    | { kind: "domain"; id: string }
    | { kind: "owned"; id: string }
    | { kind: "star"; id: string }
    | { kind: "link"; id: string }
    | null
  >({ kind: "fit" });

  // Quick graph search
  const [graphSearch, setGraphSearch] = useState("");
  const [graphSearchResults, setGraphSearchResults] = useState<RepoEvolutionNode[]>([]);
  const [graphSearchOpen, setGraphSearchOpen] = useState(false);

  // Inspector drawer state (domain / node / link / floating / none)
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("none");
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null);
  const [selectedNodeDetail, setSelectedNodeDetail] = useState<NodeDetailResponse | null>(null);
  const [selectedLink, setSelectedLink] = useState<RepoAbsorptionLink | null>(null);
  const [inspectorLoading, setInspectorLoading] = useState(false);

  // Inline Domain Inspector edit form state
  const [domainEditOpen, setDomainEditOpen] = useState(false);
  const [domainEditName, setDomainEditName] = useState("");
  const [domainEditIcon, setDomainEditIcon] = useState("");
  const [domainEditDesc, setDomainEditDesc] = useState("");
  const [domainEditColor, setDomainEditColor] = useState("#2b4e3c");
  const [domainEditKeywords, setDomainEditKeywords] = useState("");

  // Node inspector form state
  const [nodeNotesDraft, setNodeNotesDraft] = useState("");
  const [bulkTargets, setBulkTargets] = useState<Set<string>>(new Set());
  const [bulkRelationType, setBulkRelationType] = useState<RepoRelationType>("direct_module");
  const [bulkRationale, setBulkRationale] = useState("");
  const [showNodeReadme, setShowNodeReadme] = useState(false);

  // Link inspector edit state
  const [linkCodeMaps, setLinkCodeMaps] = useState<{
    source: RepoCodeMapBrief | null;
    target: RepoCodeMapBrief | null;
  } | null>(null);
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkEditRelation, setLinkEditRelation] = useState<RepoRelationType>("direct_module");
  const [linkEditStatus, setLinkEditStatus] = useState<RepoAbsorptionStatus>("suggested");
  const [linkEditStrength, setLinkEditStrength] = useState(75);
  const [linkEditRationale, setLinkEditRationale] = useState("");
  const [mailboxNote, setMailboxNote] = useState("");
  const [addingModule, setAddingModule] = useState(false);
  const [newModSource, setNewModSource] = useState("");
  const [newModTarget, setNewModTarget] = useState("");
  const [newModMechanism, setNewModMechanism] = useState("");
  const [newModGap, setNewModGap] = useState("");
  const [newModPlan, setNewModPlan] = useState("");
  const [newModEffort, setNewModEffort] = useState<RepoModuleEffort>("M");
  const [newModRisk, setNewModRisk] = useState<RepoModuleRisk>("low");

  // View 2: Domains & Floating Pool states
  const [poolBucket, setPoolBucket] = useState<RepoNodeBucketFilter>(
    (initialBucket as RepoNodeBucketFilter) || "floating",
  );
  const [poolDomainId, setPoolDomainId] = useState<string>("");
  const [poolQuery, setPoolQuery] = useState("");
  const [poolQueryDebounced, setPoolQueryDebounced] = useState("");
  const [poolVitality, setPoolVitality] = useState<RepoVitality | "all">("all");
  const [poolVisibility, setPoolVisibility] = useState<RepoVisibility | "all">("all");
  const [poolLanguage, setPoolLanguage] = useState("");
  const [poolSortBy, setPoolSortBy] = useState<RepoNodeSortBy>("starred_at");
  const [poolPage, setPoolPage] = useState(1);
  const [poolPageSize, setPoolPageSize] = useState(50);
  const [nodesPage, setNodesPage] = useState<RepoEvolutionNodesPage | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [checkedNodeIds, setCheckedNodeIds] = useState<Set<string>>(new Set());
  const [batchTargetDomainId, setBatchTargetDomainId] = useState("");

  // Quick 1-to-N modal from table row
  const [quickLinkNode, setQuickLinkNode] = useState<RepoEvolutionNode | null>(null);
  const [quickLinkTargets, setQuickLinkTargets] = useState<Set<string>>(new Set());
  const [quickLinkRelation, setQuickLinkRelation] = useState<RepoRelationType>("direct_module");
  const [quickLinkRationale, setQuickLinkRationale] = useState("");

  // Domain CRUD modals
  const [domainModal, setDomainModal] = useState<{
    mode: "create" | "edit";
    domain?: RepoDomain | RepoRadialDomainNode;
    name: string;
    description: string;
    color: string;
    icon: string;
    seedKeywords: string;
  } | null>(null);
  const [mergeModal, setMergeModal] = useState<{
    sourceDomainId: string;
    targetDomainId: string;
  } | null>(null);

  // View 3: Evolution Timeline states
  const [timelinePage, setTimelinePage] = useState<RepoEvolutionTimelinePage | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineTargetId, setTimelineTargetId] = useState("");
  const [timelineRepoName, setTimelineRepoName] = useState(initialRepo ?? "");
  const [timelineDomainId, setTimelineDomainId] = useState("");
  const [timelineEventType, setTimelineEventType] = useState<RepoEvolutionEventType | "all">("all");

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cfgSpotlight, setCfgSpotlight] = useState<string[]>(["ai-agent-node"]);
  const [cfgNewSpotlight, setCfgNewSpotlight] = useState("");
  const [cfgDormantMonths, setCfgDormantMonths] = useState(12);
  const [cfgStaleMonths, setCfgStaleMonths] = useState(24);
  const [cfgMinClusterSim, setCfgMinClusterSim] = useState(0.28);
  const [cfgMinLinkSim, setCfgMinLinkSim] = useState(0.32);
  const [cfgSpotlightBonus, setCfgSpotlightBonus] = useState(0.08);
  const [cfgAllowPrivateLlm, setCfgAllowPrivateLlm] = useState(false);
  const [cfgAutomationMode, setCfgAutomationMode] = useState<RepoEvolutionAutomationMode>("mailbox_review");

  // Sync job & global notices
  const [activeSyncJob, setActiveSyncJob] = useState<RepoEvolutionSyncJob | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState<{ text: string; href?: string; hrefLabel?: string } | null>(null);
  const [error, setError] = useState("");

  const panStartRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lastStageSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastCompletedJobRef = useRef<string | null>(null);

  const toggleHaloTheme = () => {
    setHaloTheme((prev) => {
      const next: HaloTheme = prev === "cosmic" ? "washi" : "cosmic";
      try {
        window.localStorage.setItem("re.radial.theme", next);
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  // ---- Data Fetchers ----

  const loadRadialGraph = useCallback(
    async (overrides?: {
      includeForks?: boolean;
      includeRejected?: boolean;
      status?: RepoAbsorptionStatus | "all";
      maxStarsPerOwned?: number;
    }) => {
      const incForks = overrides?.includeForks ?? includeForks;
      const incRej = overrides?.includeRejected ?? includeRejected;
      const st = overrides?.status ?? statusFilter;
      const perOwned = overrides?.maxStarsPerOwned ?? maxStarsPerOwned;

      const qs = new URLSearchParams({
        includeForks: incForks ? "true" : "false",
        includeRejected: incRej ? "true" : "false",
        maxStarsPerOwned: String(perOwned),
        maxTotalStars: String(Math.min(600, Math.max(240, perOwned * 15))),
      });
      if (st !== "all") qs.set("status", st);

      try {
        const data = await request<RepoEvolutionRadialGraph>(`${API_BASE}/graph/radial?${qs.toString()}`);
        setRadialGraph(data);
        if (data.activeSyncJob) {
          setActiveSyncJob(data.activeSyncJob);
        } else if (data.latestSyncJob && (data.latestSyncJob.status === "failed" || data.latestSyncJob.status === "running")) {
          setActiveSyncJob(data.latestSyncJob);
        }

        // First-load intelligent expansion: expand L1 + L2 across all domains with owned repos,
        // and auto-expand L3 for Spotlight owned repo(s) (or top linked repo if none) so the 3-ring halo shines immediately!
        if (!initializedExpansionRef.current && (data.domains.length > 0 || data.ownedNodes.length > 0)) {
          initializedExpansionRef.current = true;
          const domainIdsWithOwned = new Set<string>();
          for (const o of data.ownedNodes) {
            domainIdsWithOwned.add(o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID);
          }
          setExpandedDomainIds(domainIdsWithOwned);

          const spotWithLinks = data.ownedNodes
            .filter((o) => o.priorityTier === "spotlight" && o.linkedStarCount > 0)
            .slice(0, 2);
          const initialL3 = new Set<string>();
          if (spotWithLinks.length > 0) {
            for (const o of spotWithLinks) initialL3.add(o.id);
          } else {
            const topLinked = [...data.ownedNodes]
              .filter((o) => o.linkedStarCount > 0)
              .sort((a, b) => b.linkedStarCount - a.linkedStarCount)
              .slice(0, 2);
            for (const o of topLinked) initialL3.add(o.id);
          }
          setExpandedOwnedIds(initialL3);
          pendingFocusTargetRef.current = { kind: "fit" };
        }

        setError("");
        return data;
      } catch (err) {
        setError(describeError(err, "加载同心光环图谱失败"));
        return null;
      }
    },
    [includeForks, includeRejected, statusFilter, maxStarsPerOwned],
  );

  const loadMacroGraph = useCallback(async () => {
    try {
      const data = await request<RepoEvolutionMacroGraph>(`${API_BASE}/graph/macro`);
      setMacroGraph(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  const refreshGraphs = useCallback(async () => {
    await Promise.all([loadRadialGraph(), loadMacroGraph()]);
  }, [loadRadialGraph, loadMacroGraph]);

  const loadNodesPage = useCallback(async () => {
    setPoolLoading(true);
    const qs = new URLSearchParams({
      bucket: poolBucket,
      sortBy: poolSortBy,
      sortDir: poolSortBy === "name" ? "asc" : "desc",
      page: String(poolPage),
      pageSize: String(poolPageSize),
    });
    if (poolDomainId) qs.set("domainId", poolDomainId);
    if (poolQueryDebounced.trim()) qs.set("q", poolQueryDebounced.trim());
    if (poolVitality !== "all") qs.set("vitality", poolVitality);
    if (poolVisibility !== "all") qs.set("visibility", poolVisibility);
    if (poolLanguage) qs.set("language", poolLanguage);
    try {
      const res = await request<RepoEvolutionNodesPage>(`${API_BASE}/nodes?${qs.toString()}`);
      setNodesPage(res);
      setError("");
    } catch (err) {
      setError(describeError(err, "加载仓库列表失败"));
    } finally {
      setPoolLoading(false);
    }
  }, [poolBucket, poolDomainId, poolQueryDebounced, poolVitality, poolVisibility, poolLanguage, poolSortBy, poolPage, poolPageSize]);

  const loadTimeline = useCallback(
    async (append = false) => {
      setTimelineLoading(true);
      const offset = append && timelinePage ? timelinePage.items.length : 0;
      const qs = new URLSearchParams({ limit: "60", offset: String(offset) });
      if (timelineTargetId) qs.set("targetNodeId", timelineTargetId);
      if (timelineRepoName.trim()) qs.set("repoFullName", timelineRepoName.trim());
      if (timelineDomainId) qs.set("domainId", timelineDomainId);
      if (timelineEventType !== "all") qs.set("eventType", timelineEventType);
      try {
        const res = await request<RepoEvolutionTimelinePage>(`${API_BASE}/timeline?${qs.toString()}`);
        setTimelinePage((prev) =>
          append && prev ? { ...res, items: [...prev.items, ...res.items] } : res,
        );
        setError("");
      } catch (err) {
        setError(describeError(err, "加载进化时间线失败"));
      } finally {
        setTimelineLoading(false);
      }
    },
    [timelineTargetId, timelineRepoName, timelineDomainId, timelineEventType, timelinePage],
  );

  // ---- Inspector Openers ----

  const openDomainInspector = useCallback(
    (domainId: string) => {
      setSelectedDomainId(domainId);
      setInspectorMode("domain");
      setDomainEditOpen(false);
      const d = radialGraph?.domains.find((item) => item.id === domainId);
      if (d) {
        setDomainEditName(d.name);
        setDomainEditIcon(d.icon || "◈");
        setDomainEditDesc(d.description || "");
        setDomainEditColor(d.color || "#2b4e3c");
        setDomainEditKeywords(d.seedKeywords.join(", "));
      }
    },
    [radialGraph?.domains],
  );

  const openNodeInspector = useCallback(async (nodeId: string) => {
    setInspectorMode("node");
    setInspectorLoading(true);
    setShowNodeReadme(false);
    try {
      const res = await request<NodeDetailResponse>(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}`);
      setSelectedNodeDetail(res);
      setNodeNotesDraft(res.node.notes ?? "");
      setBulkTargets(new Set(res.outgoingLinks.map((l) => l.targetNodeId)));
      setBulkRationale("");
      setError("");
      return res;
    } catch (err) {
      setError(describeError(err, "读取仓库详情失败"));
      return null;
    } finally {
      setInspectorLoading(false);
    }
  }, []);

  const openLinkInspector = useCallback(async (linkOrId: RepoAbsorptionLink | RepoRadialLink | string) => {
    setInspectorMode("link");
    setLinkEditing(false);
    setAddingModule(false);
    setMailboxNote("");
    setLinkCodeMaps(null);
    if (typeof linkOrId !== "string") {
      setSelectedLink(linkOrId as RepoAbsorptionLink);
      setLinkEditRelation(linkOrId.relationType);
      setLinkEditStatus(linkOrId.status);
      setLinkEditStrength(Math.round(linkOrId.strength * 100));
      setLinkEditRationale(linkOrId.rationale ?? "");
    }
    const id = typeof linkOrId === "string" ? linkOrId : linkOrId.id;
    setInspectorLoading(true);
    try {
      const fresh = await request<RepoAbsorptionLink>(`${API_BASE}/links/${encodeURIComponent(id)}`);
      setSelectedLink(fresh);
      setLinkEditRelation(fresh.relationType);
      setLinkEditStatus(fresh.status);
      setLinkEditStrength(Math.round(fresh.strength * 100));
      setLinkEditRationale(fresh.rationale ?? "");
      setError("");

      // Non-blocking background check of cached zero-clone Code Maps for both endpoints
      void Promise.all([
        request<GetCodeMapResponse>(`${API_BASE}/nodes/${encodeURIComponent(fresh.sourceNodeId)}/code-map`).catch(() => null),
        request<GetCodeMapResponse>(`${API_BASE}/nodes/${encodeURIComponent(fresh.targetNodeId)}/code-map`).catch(() => null),
      ]).then(([srcRes, tgtRes]) => {
        const toBrief = (cm: RepoCodeMap | null | undefined): RepoCodeMapBrief | null =>
          cm
            ? {
                id: cm.id,
                nodeId: cm.nodeId,
                repoFullName: cm.repoFullName,
                commitSha: cm.commitSha,
                source: cm.source,
                zeroLocalClone: true,
                diskBytesCloned: 0,
                totalTreeFiles: cm.totalTreeFiles,
                analyzedFileCount: cm.analyzedFileCount,
                edgeCount: cm.edgeCount,
                cycleCount: cm.cycleCount,
                hotspotCount: cm.hotspots.length,
                cached: cm.cached,
                generatedAt: cm.generatedAt,
              }
            : null;
        setLinkCodeMaps({
          source: toBrief(srcRes?.codeMap),
          target: toBrief(tgtRes?.codeMap),
        });
      });

      return fresh;
    } catch (err) {
      setError(describeError(err, "读取吸收边详情失败"));
      return null;
    } finally {
      setInspectorLoading(false);
    }
  }, []);

  // ---- Derived Concentric Halo Layout ----

  const radialLayout = useMemo(
    () =>
      computeRadialHaloLayout({
        radialGraph,
        expandedDomainIds,
        expandedOwnedIds,
        ownedStarCaps,
      }),
    [radialGraph, expandedDomainIds, expandedOwnedIds, ownedStarCaps],
  );

  // ---- Viewport Fit & Focus Math ----

  const fitViewToBounds = useCallback((bounds: WorldBounds) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return;

    lastStageSizeRef.current = { width: rect.width, height: rect.height };
    const bw = Math.max(240, bounds.maxX - bounds.minX);
    const bh = Math.max(240, bounds.maxY - bounds.minY);
    const padLeft = 36;
    const padRight = 36;
    const padTop = 58;
    const padBottom = 56;
    const availW = Math.max(120, rect.width - padLeft - padRight);
    const availH = Math.max(120, rect.height - padTop - padBottom);
    const zoom = clamp(Math.min(availW / bw, availH / bh), 0.08, 1.35);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    setViewport({
      x: Math.round(padLeft + availW / 2 - cx * zoom),
      y: Math.round(padTop + availH / 2 - cy * zoom),
      zoom: Math.round(zoom * 1000) / 1000,
    });
  }, []);

  const fitView = useCallback(() => {
    fitViewToBounds(radialLayout.bounds);
  }, [fitViewToBounds, radialLayout.bounds]);

  const centerOnWorldPoint = useCallback((wx: number, wy: number, minZoom = 0.72) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return;
    lastStageSizeRef.current = { width: rect.width, height: rect.height };
    setViewport((prev) => {
      const nextZoom = clamp(Math.max(prev.zoom, minZoom), 0.35, 1.45);
      return {
        x: Math.round(rect.width / 2 - wx * nextZoom),
        y: Math.round(rect.height / 2 - wy * nextZoom),
        zoom: Math.round(nextZoom * 1000) / 1000,
      };
    });
  }, []);

  // Execute pending camera target once radialLayout reflects the newly expanded layers
  useEffect(() => {
    if (activeTab !== "graph") return;
    const target = pendingFocusTargetRef.current;
    if (!target || !radialGraph) return;

    if (target.kind === "fit") {
      pendingFocusTargetRef.current = null;
      const raf = window.requestAnimationFrame(() => fitViewToBounds(radialLayout.bounds));
      return () => window.cancelAnimationFrame(raf);
    }

    if (target.kind === "domain") {
      const pos = radialLayout.sectorMap.get(target.id);
      if (pos) {
        pendingFocusTargetRef.current = null;
        const raf = window.requestAnimationFrame(() => centerOnWorldPoint(pos.x, pos.y, 0.72));
        return () => window.cancelAnimationFrame(raf);
      }
    } else if (target.kind === "owned") {
      const pos = radialLayout.ownedMap.get(target.id);
      if (pos) {
        pendingFocusTargetRef.current = null;
        const raf = window.requestAnimationFrame(() => centerOnWorldPoint(pos.x, pos.y, 0.78));
        return () => window.cancelAnimationFrame(raf);
      }
    } else if (target.kind === "star") {
      const pos = radialLayout.starMap.get(target.id);
      if (pos) {
        pendingFocusTargetRef.current = null;
        const raf = window.requestAnimationFrame(() => centerOnWorldPoint(pos.x, pos.y, 0.85));
        return () => window.cancelAnimationFrame(raf);
      }
    } else if (target.kind === "link") {
      const pos = radialLayout.links.find((l) => l.link.id === target.id);
      if (pos) {
        pendingFocusTargetRef.current = null;
        const raf = window.requestAnimationFrame(() => centerOnWorldPoint(pos.midX, pos.midY, 0.78));
        return () => window.cancelAnimationFrame(raf);
      }
    }
  }, [activeTab, radialGraph, radialLayout, fitViewToBounds, centerOnWorldPoint]);

  // Keep halo centered & never clipped when Inspector opens/closes or window resizes
  useEffect(() => {
    if (activeTab !== "graph") return;
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width < 80 || height < 80) return;
      const prev = lastStageSizeRef.current;
      lastStageSizeRef.current = { width, height };
      if (!prev) {
        fitViewToBounds(radialLayout.bounds);
        return;
      }
      if (Math.abs(prev.width - width) > 4 || Math.abs(prev.height - height) > 4) {
        // When stage shrinks (e.g. Inspector drawer opens), keep halo centered and ensure it fits cleanly without clipping
        const b = radialLayout.bounds;
        const bw = Math.max(240, b.maxX - b.minX);
        const bh = Math.max(240, b.maxY - b.minY);
        const padLeft = 36;
        const padRight = 36;
        const padTop = 58;
        const padBottom = 56;
        const availW = Math.max(120, width - padLeft - padRight);
        const availH = Math.max(120, height - padTop - padBottom);
        const maxFitZoom = clamp(Math.min(availW / bw, availH / bh), 0.08, 1.35);
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        setViewport((vp) => {
          if (width < prev.width && vp.zoom > maxFitZoom * 1.04) {
            return {
              x: Math.round(padLeft + availW / 2 - cx * maxFitZoom),
              y: Math.round(padTop + availH / 2 - cy * maxFitZoom),
              zoom: Math.round(maxFitZoom * 1000) / 1000,
            };
          }
          const dx = (width - prev.width) / 2;
          const dy = (height - prev.height) / 2;
          return {
            ...vp,
            x: Math.round(vp.x + dx),
            y: Math.round(vp.y + dy),
          };
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeTab, fitViewToBounds, radialLayout.bounds]);

  // ---- Locate / Expand Helpers (Cross-tab & Search & Deep-Link) ----

  const locateDomainInRadial = useCallback(
    (domainId: string, expandL3 = false) => {
      setActiveTab("graph");
      setExpandedDomainIds((prev) => {
        const next = new Set(prev);
        next.add(domainId);
        return next;
      });
      if (expandL3 && radialGraph) {
        const ownedInDom = radialGraph.ownedNodes.filter((o) => (o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID) === domainId);
        setExpandedOwnedIds((prev) => {
          const next = new Set(prev);
          for (const o of ownedInDom) {
            if (o.linkedStarCount > 0) next.add(o.id);
          }
          return next;
        });
      }
      openDomainInspector(domainId);
      pendingFocusTargetRef.current = { kind: "domain", id: domainId };
    },
    [radialGraph, openDomainInspector],
  );

  const locateNodeInRadial = useCallback(
    async (nodeOrId: RepoEvolutionNode | RepoRadialOwnedNode | RepoRadialStarNode | string) => {
      setActiveTab("graph");
      const nodeId = typeof nodeOrId === "string" ? nodeOrId : nodeOrId.id;
      const detail = await openNodeInspector(nodeId);
      const node = detail?.node;
      if (!node) return;

      // Ensure forks are visible if user searched for a fork owned repo
      let latestGraph = radialGraph;
      if (node.role !== "starred" && node.isFork && !includeForks) {
        setIncludeForks(true);
        latestGraph = (await loadRadialGraph({ includeForks: true })) ?? radialGraph;
      }

      if (node.role === "owned" || node.role === "both") {
        const sectorId = node.primaryDomainId ?? UNASSIGNED_DOMAIN_ID;
        setExpandedDomainIds((prev) => {
          const next = new Set(prev);
          next.add(sectorId);
          return next;
        });
        setExpandedOwnedIds((prev) => {
          const next = new Set(prev);
          next.add(node.id);
          return next;
        });
        pendingFocusTargetRef.current = { kind: "owned", id: node.id };
        return;
      }

      // Star repo: expand all target owned repos (and their domains!) so 1-to-N curves immediately appear
      const outgoing = detail.outgoingLinks ?? [];
      if (outgoing.length > 0 && latestGraph) {
        const ownedById = new Map(latestGraph.ownedNodes.map((o) => [o.id, o]));
        const domainIdsToOpen = new Set<string>();
        const ownedIdsToOpen = new Set<string>();
        for (const l of outgoing) {
          const tgt = ownedById.get(l.targetNodeId);
          if (tgt) {
            domainIdsToOpen.add(tgt.primaryDomainId ?? UNASSIGNED_DOMAIN_ID);
            ownedIdsToOpen.add(tgt.id);
          }
        }
        if (ownedIdsToOpen.size > 0) {
          setExpandedDomainIds((prev) => new Set([...prev, ...domainIdsToOpen]));
          setExpandedOwnedIds((prev) => new Set([...prev, ...ownedIdsToOpen]));
          setOwnedStarCaps((prev) => {
            const next = { ...prev };
            for (const oid of ownedIdsToOpen) {
              next[oid] = Math.max(next[oid] ?? DEFAULT_STARS_PER_OWNED, 48);
            }
            return next;
          });
          pendingFocusTargetRef.current = { kind: "star", id: node.id };
          return;
        }
      }

      // Unlinked Star repo in floating pool
      if (node.primaryDomainId) {
        setExpandedDomainIds((prev) => new Set([...prev, node.primaryDomainId!]));
        pendingFocusTargetRef.current = { kind: "domain", id: node.primaryDomainId };
      }
      setNotice({
        text: `「${node.fullName}」当前尚未建立吸收连线，可在右侧检视抽屉中勾选 1 对 N 目标自有仓直接接入第三层光环。`,
      });
    },
    [radialGraph, includeForks, loadRadialGraph, openNodeInspector],
  );

  const locateLinkInRadial = useCallback(
    async (linkId: string) => {
      setActiveTab("graph");
      const link = await openLinkInspector(linkId);
      if (!link) return;
      let latestGraph = radialGraph;
      if (link.status === "rejected" && !includeRejected) {
        setIncludeRejected(true);
        latestGraph = (await loadRadialGraph({ includeRejected: true })) ?? radialGraph;
      }
      const targetOwned = latestGraph?.ownedNodes.find((o) => o.id === link.targetNodeId);
      if (targetOwned) {
        const secId = targetOwned.primaryDomainId ?? UNASSIGNED_DOMAIN_ID;
        setExpandedDomainIds((prev) => new Set([...prev, secId]));
        setExpandedOwnedIds((prev) => new Set([...prev, targetOwned.id]));
        setOwnedStarCaps((prev) => ({
          ...prev,
          [targetOwned.id]: Math.max(prev[targetOwned.id] ?? DEFAULT_STARS_PER_OWNED, 48),
        }));
      }
      pendingFocusTargetRef.current = { kind: "link", id: link.id };
    },
    [radialGraph, includeRejected, loadRadialGraph, openLinkInspector],
  );

  // ---- Initial Load & Effects ----

  useEffect(() => {
    void loadRadialGraph();
  }, [loadRadialGraph]);

  useEffect(() => {
    void loadMacroGraph();
  }, [loadMacroGraph]);

  // Preload Architecture Primitives count for topbar badge
  useEffect(() => {
    request<{ primitives: ArchitecturePrimitive[]; total: number }>(`${API_BASE}/architecture/primitives`)
      .then((res) => setPrimitiveCount(res.total ?? res.primitives.length))
      .catch(() => {});
  }, []);

  // Hash deep-link sync
  useEffect(() => {
    const params = new URLSearchParams(hashQuery);
    const tabParam = params.get("tab") as MainTab | null;
    const primitiveParam = params.get("primitive") || "";
    const linkParam = params.get("link") || initialLinkId || "";
    const repoParam = params.get("repo") || initialRepo || "";
    const domainParam = params.get("domain") || initialDomainId || "";
    const nodeParam = params.get("node") || initialNodeId || "";
    const bucketParam = params.get("bucket") || initialBucket || "";

    if (tabParam && ["graph", "domains", "timeline", "architecture"].includes(tabParam)) {
      setActiveTab(tabParam);
    }

    if (primitiveParam) {
      setActiveTab("architecture");
      setDeepLinkPrimitiveId(primitiveParam);
      return;
    }

    if (linkParam) {
      void locateLinkInRadial(linkParam);
      return;
    }

    if (tabParam === "timeline" && repoParam) {
      setTimelineRepoName(repoParam);
      setTimelineTargetId("");
      return;
    }

    if (domainParam) {
      locateDomainInRadial(domainParam, true);
      return;
    }

    if (nodeParam) {
      void locateNodeInRadial(nodeParam);
      return;
    }

    if (repoParam && tabParam !== "timeline") {
      setGraphSearch(repoParam);
      return;
    }

    if (bucketParam) {
      setActiveTab("domains");
      setPoolBucket(bucketParam as RepoNodeBucketFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashQuery]);

  // Debounce pool search
  useEffect(() => {
    const t = window.setTimeout(() => {
      setPoolQueryDebounced(poolQuery);
      setPoolPage(1);
    }, 260);
    return () => window.clearTimeout(t);
  }, [poolQuery]);

  // Load pool nodes when on domains tab
  useEffect(() => {
    if (activeTab === "domains") {
      void loadNodesPage();
    }
  }, [activeTab, loadNodesPage]);

  // Load timeline when on timeline tab
  useEffect(() => {
    if (activeTab === "timeline") {
      void loadTimeline(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, timelineTargetId, timelineRepoName, timelineDomainId, timelineEventType]);

  // Quick graph search debounce
  useEffect(() => {
    const q = graphSearch.trim();
    if (!q) {
      setGraphSearchResults([]);
      return;
    }
    const controller = new AbortController();
    const t = window.setTimeout(() => {
      request<RepoEvolutionNodesPage>(
        `${API_BASE}/nodes?${new URLSearchParams({ q, pageSize: "10", page: "1" })}`,
        { signal: controller.signal },
      )
        .then((res) => {
          if (!controller.signal.aborted) {
            setGraphSearchResults(res.items);
            setGraphSearchOpen(true);
          }
        })
        .catch(() => {});
    }, 200);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [graphSearch]);

  // Poll active sync job
  useEffect(() => {
    if (!activeSyncJob || (activeSyncJob.status !== "queued" && activeSyncJob.status !== "running")) {
      return;
    }
    const timer = window.setInterval(() => {
      void request<RepoEvolutionSyncJob>(`${API_BASE}/sync/jobs/${encodeURIComponent(activeSyncJob.id)}`)
        .then((job) => {
          setActiveSyncJob(job);
          if (job.status === "completed" && lastCompletedJobRef.current !== job.id) {
            lastCompletedJobRef.current = job.id;
            setNotice({
              text: `GitHub 同步完成：自有仓 ${job.ownedFetched}，Star 仓 ${job.starredFetched}，Lists ${job.listsFetched}，向量更新 ${job.embeddingsComputed}。`,
            });
            void refreshGraphs();
            if (activeTab === "domains") void loadNodesPage();
            if (activeTab === "timeline") void loadTimeline(false);
          } else if (job.status === "failed") {
            setError(job.errorMessage || "GitHub 同步中途失败，可点击断点续传重试");
          }
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeSyncJob, activeTab, refreshGraphs, loadNodesPage, loadTimeline]);

  // ---- Pan & Pointer-Centered Wheel Zoom ----

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    panStartRef.current = { clientX: e.clientX, clientY: e.clientY, x: viewport.x, y: viewport.y };
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) return;
    const dx = e.clientX - panStartRef.current.clientX;
    const dy = e.clientY - panStartRef.current.clientY;
    setViewport((vp) => ({
      ...vp,
      x: Math.round(panStartRef.current!.x + dx),
      y: Math.round(panStartRef.current!.y + dy),
    }));
  };

  const handleStagePointerUp = () => {
    panStartRef.current = null;
    setIsPanning(false);
  };

  // Pointer-centered wheel zoom on radial stage (Figma / Obsidian style smooth zoom)
  useEffect(() => {
    if (activeTab !== "graph") return;
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = clamp(-e.deltaY * 0.0016, -0.18, 0.18);
      const factor = Math.exp(delta);
      setViewport((vp) => {
        const nextZoom = clamp(Math.round(vp.zoom * factor * 1000) / 1000, 0.08, 2.2);
        const ratio = nextZoom / vp.zoom;
        return {
          x: Math.round(mx - (mx - vp.x) * ratio),
          y: Math.round(my - (my - vp.y) * ratio),
          zoom: nextZoom,
        };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeTab]);

  const zoomByStep = (deltaFactor: number) => {
    const el = stageRef.current;
    const rect = el?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 480;
    const cy = rect ? rect.height / 2 : 300;
    setViewport((vp) => {
      const nextZoom = clamp(Math.round(vp.zoom * deltaFactor * 1000) / 1000, 0.08, 2.2);
      const ratio = nextZoom / vp.zoom;
      return {
        x: Math.round(cx - (cx - vp.x) * ratio),
        y: Math.round(cy - (cy - vp.y) * ratio),
        zoom: nextZoom,
      };
    });
  };

  // ---- Layer Preset & Progressive Toggle Actions ----

  const applyLayerL1 = () => {
    setExpandedDomainIds(new Set());
    setExpandedOwnedIds(new Set());
    pendingFocusTargetRef.current = { kind: "fit" };
  };

  const applyLayerL2 = () => {
    if (!radialGraph) return;
    const doms = new Set<string>();
    for (const o of radialGraph.ownedNodes) {
      doms.add(o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID);
    }
    setExpandedDomainIds(doms);
    setExpandedOwnedIds(new Set());
    pendingFocusTargetRef.current = { kind: "fit" };
  };

  const applyLayerL3SelectedOrTop = () => {
    if (!radialGraph) return;
    const doms = new Set<string>();
    for (const o of radialGraph.ownedNodes) {
      doms.add(o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID);
    }
    setExpandedDomainIds(doms);

    const nextOwned = new Set<string>();
    // If a domain or owned repo is currently selected, prioritize its L3!
    if (inspectorMode === "domain" && selectedDomainId) {
      for (const o of radialGraph.ownedNodes) {
        if ((o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID) === selectedDomainId && o.linkedStarCount > 0) {
          nextOwned.add(o.id);
        }
      }
    } else if (inspectorMode === "node" && selectedNodeDetail?.node.role !== "starred") {
      nextOwned.add(selectedNodeDetail!.node.id);
    }
    if (nextOwned.size === 0) {
      const ranked = [...radialGraph.ownedNodes]
        .filter((o) => o.linkedStarCount > 0)
        .sort((a, b) => {
          const sa = a.priorityTier === "spotlight" ? 1 : 0;
          const sb = b.priorityTier === "spotlight" ? 1 : 0;
          if (sa !== sb) return sb - sa;
          return b.linkedStarCount - a.linkedStarCount;
        })
        .slice(0, 6);
      for (const o of ranked) nextOwned.add(o.id);
    }
    setExpandedOwnedIds(nextOwned);
    pendingFocusTargetRef.current = { kind: "fit" };
  };

  const applyExpandAll = () => {
    if (!radialGraph) return;
    const doms = new Set<string>();
    const owneds = new Set<string>();
    for (const o of radialGraph.ownedNodes) {
      doms.add(o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID);
      if (o.linkedStarCount > 0 || o.totalStarCount > 0) owneds.add(o.id);
    }
    setExpandedDomainIds(doms);
    setExpandedOwnedIds(owneds);
    pendingFocusTargetRef.current = { kind: "fit" };
  };

  const toggleDomainExpand = (sectorId: string, alsoInspect = false) => {
    const isOpen = expandedDomainIds.has(sectorId);
    setExpandedDomainIds((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(sectorId);
      else next.add(sectorId);
      return next;
    });
    if (isOpen && radialGraph) {
      // Also collapse any L3 owned repos inside this domain
      setExpandedOwnedIds((prev) => {
        const next = new Set(prev);
        for (const o of radialGraph.ownedNodes) {
          if ((o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID) === sectorId) next.delete(o.id);
        }
        return next;
      });
    }
    if (alsoInspect && sectorId !== UNASSIGNED_DOMAIN_ID) {
      openDomainInspector(sectorId);
    }
    pendingFocusTargetRef.current = { kind: "fit" };
  };

  const toggleOwnedExpand = (owned: RepoRadialOwnedNode, alsoInspect = false) => {
    const isOpen = expandedOwnedIds.has(owned.id);
    if (owned.totalStarCount > 0 || owned.linkedStarCount > 0) {
      setExpandedOwnedIds((prev) => {
        const next = new Set(prev);
        if (isOpen) next.delete(owned.id);
        else next.add(owned.id);
        return next;
      });
      pendingFocusTargetRef.current = { kind: "fit" };
    }
    if (alsoInspect) {
      void openNodeInspector(owned.id);
    }
  };

  const handleMoreStarsClick = async (pill: PositionedMorePill) => {
    if (pill.localHidden > 0) {
      setOwnedStarCaps((prev) => ({
        ...prev,
        [pill.owned.id]: (prev[pill.owned.id] ?? DEFAULT_STARS_PER_OWNED) + 14,
      }));
      pendingFocusTargetRef.current = { kind: "fit" };
      return;
    }
    if (pill.serverTruncated > 0 && maxStarsPerOwned < 48) {
      const nextMax = Math.min(48, maxStarsPerOwned + 16);
      setMaxStarsPerOwned(nextMax);
      setOwnedStarCaps((prev) => ({
        ...prev,
        [pill.owned.id]: Math.max(prev[pill.owned.id] ?? DEFAULT_STARS_PER_OWNED, nextMax),
      }));
      await loadRadialGraph({ maxStarsPerOwned: nextMax });
      pendingFocusTargetRef.current = { kind: "fit" };
      return;
    }
    // Fallback: jump to full table view filtered by this repo's domain
    setActiveTab("domains");
    setPoolBucket("linked");
    setPoolDomainId(pill.owned.primaryDomainId ?? "");
    setPoolPage(1);
  };

  // ---- Topbar Actions ----

  const triggerSync = async (mode: "incremental" | "full", resumeJobId?: string) => {
    setBusyAction(`sync:${mode}`);
    setError("");
    try {
      const job = await request<RepoEvolutionSyncJob>(`${API_BASE}/sync`, {
        method: "POST",
        body: JSON.stringify({ mode, ...(resumeJobId ? { resumeJobId } : {}) }),
      });
      setActiveSyncJob(job);
      setNotice({
        text: mode === "full" ? "已启动 GitHub 全量同步任务（后台分页拉取）" : "已启动 GitHub 增量同步任务",
      });
    } catch (err) {
      setError(describeError(err, "启动 GitHub 同步失败"));
    } finally {
      setBusyAction("");
    }
  };

  const triggerClusterAndRecall = async () => {
    setBusyAction("cluster");
    setError("");
    try {
      const res = await request<ClusterAndRecallResult>(`${API_BASE}/cluster-and-recall`, {
        method: "POST",
        body: JSON.stringify({
          recomputeEmbeddings: true,
          enrichOwnedProfiles: true,
        }),
      });
      setNotice({
        text: `精准分类与召回完成（${(res.durationMs / 1000).toFixed(1)}s）：画像补全 ${res.ownedProfilesEnriched ?? 0} · 归类 ${res.domainsAssigned} · 召回边 ${res.linksSuggested}（Spotlight ${res.spotlightMatches}）· 保留散落池 ${res.skippedStaleOrLowMatch}。`,
      });
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
      if (activeTab === "timeline") await loadTimeline(false);
    } catch (err) {
      setError(describeError(err, "AI 分类与召回失败"));
    } finally {
      setBusyAction("");
    }
  };

  const triggerRecalibrate = async () => {
    setBusyAction("recalibrate");
    setError("");
    try {
      const res = await request<ClusterAndRecallResult>(`${API_BASE}/recalibrate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setNotice({
        text: `分类体系与关联校准完成（${(res.durationMs / 1000).toFixed(1)}s）：校准领域 ${res.domainsCalibrated ?? 0} · 画像补全 ${res.ownedProfilesEnriched ?? 0} · 自有归类 ${res.ownedDomainsAssigned ?? 0} · 清理旧建议 ${res.clearedSuggestedLinks ?? 0} · 重建高置信边 ${res.linksSuggested}（Spotlight ${res.spotlightMatches}）。`,
      });
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
      if (activeTab === "timeline") await loadTimeline(false);
    } catch (err) {
      setError(describeError(err, "校准分类体系失败"));
    } finally {
      setBusyAction("");
    }
  };

  const openSettings = () => {
    const cfg = radialGraph?.config ?? macroGraph?.config;
    if (cfg) {
      setCfgSpotlight(cfg.spotlightRepos);
      setCfgDormantMonths(cfg.dormantMonths);
      setCfgStaleMonths(cfg.staleMonths);
      setCfgMinClusterSim(cfg.minClusterSimilarity);
      setCfgMinLinkSim(cfg.minLinkSimilarity);
      setCfgSpotlightBonus(cfg.spotlightBonus);
      setCfgAllowPrivateLlm(cfg.allowPrivateLlmByDefault);
      setCfgAutomationMode(cfg.automationMode);
    }
    setCfgNewSpotlight("");
    setSettingsOpen(true);
  };

  const saveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setBusyAction("config");
    setError("");
    try {
      const updated = await request<RepoEvolutionConfig>(`${API_BASE}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          spotlightRepos: cfgSpotlight,
          dormantMonths: Number(cfgDormantMonths),
          staleMonths: Number(cfgStaleMonths),
          minClusterSimilarity: Number(cfgMinClusterSim),
          minLinkSimilarity: Number(cfgMinLinkSim),
          spotlightBonus: Number(cfgSpotlightBonus),
          allowPrivateLlmByDefault: cfgAllowPrivateLlm,
          automationMode: cfgAutomationMode,
        }),
      });
      setRadialGraph((prev) => (prev ? { ...prev, config: updated } : prev));
      setMacroGraph((prev) => (prev ? { ...prev, config: updated } : prev));
      setSettingsOpen(false);
      setNotice({ text: "进化图谱配置已保存（重点关注仓、陈旧阈值与隐私开关已生效）。" });
      await refreshGraphs();
    } catch (err) {
      setError(describeError(err, "保存配置失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- Domain Inline Edit Mutation (from Inspector) ----

  const handleSaveInlineDomain = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedDomainId || !domainEditName.trim()) return;
    setBusyAction("domain-inline-save");
    setError("");
    const seedKeywords = domainEditKeywords
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await request<RepoDomain>(`${API_BASE}/domains/${encodeURIComponent(selectedDomainId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: domainEditName.trim(),
          icon: domainEditIcon.trim() || "◈",
          description: domainEditDesc.trim(),
          color: domainEditColor,
          seedKeywords,
        }),
      });
      setDomainEditOpen(false);
      setNotice({ text: `已更新领域「${domainEditName.trim()}」，同心光环已实时刷新。` });
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "保存领域信息失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- Node Inspector Mutations ----

  const handleUpdateNode = async (nodeId: string, patch: Record<string, unknown>, successMsg: string) => {
    setBusyAction("node-update");
    setError("");
    try {
      const updated = await request<RepoEvolutionNode>(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setSelectedNodeDetail((prev) => (prev && prev.node.id === updated.id ? { ...prev, node: updated } : prev));
      // If user moved an owned repo to a new domain, ensure the new domain is expanded so it shows immediately!
      if ("primaryDomainId" in patch && updated.role !== "starred") {
        const nextSector = updated.primaryDomainId ?? UNASSIGNED_DOMAIN_ID;
        setExpandedDomainIds((prev) => new Set([...prev, nextSector]));
      }
      setNotice({ text: successMsg });
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "更新仓库属性失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleBulkLinkFromInspector = async () => {
    if (!selectedNodeDetail) return;
    const targetIds = Array.from(bulkTargets);
    if (targetIds.length === 0) {
      setError("请至少勾选 1 个目标自有仓");
      return;
    }
    setBusyAction("bulk-link");
    setError("");
    try {
      const res = await request<{ links: RepoAbsorptionLink[] }>(
        `${API_BASE}/nodes/${encodeURIComponent(selectedNodeDetail.node.id)}/links/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            targetNodeIds: targetIds,
            relationType: bulkRelationType,
            rationale: bulkRationale.trim() || undefined,
          }),
        },
      );
      setNotice({ text: `已同步 ${selectedNodeDetail.node.fullName} 的 1 对 ${res.links.length} 吸收关联，光环已实时连线。` });
      // Auto-expand the linked owned repos & their domains so the user sees the new 1-to-N rays!
      if (radialGraph) {
        const ownedMap = new Map(radialGraph.ownedNodes.map((o) => [o.id, o]));
        const domAdd = new Set<string>();
        const ownAdd = new Set<string>();
        for (const tid of targetIds) {
          const o = ownedMap.get(tid);
          if (o) {
            domAdd.add(o.primaryDomainId ?? UNASSIGNED_DOMAIN_ID);
            ownAdd.add(o.id);
          }
        }
        if (domAdd.size > 0) setExpandedDomainIds((prev) => new Set([...prev, ...domAdd]));
        if (ownAdd.size > 0) setExpandedOwnedIds((prev) => new Set([...prev, ...ownAdd]));
      }
      await openNodeInspector(selectedNodeDetail.node.id);
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "批量建立关联失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- Link Inspector Mutations ----

  const handleAnalyzeLink = async (linkId: string, opts: { force?: boolean; allowPrivateOverride?: boolean } = {}) => {
    setBusyAction("analyze");
    setError("");
    try {
      const res = await request<AnalyzeLinkResult>(`${API_BASE}/links/${encodeURIComponent(linkId)}/analyze`, {
        method: "POST",
        body: JSON.stringify({ force: opts.force ?? true, allowPrivateOverride: opts.allowPrivateOverride }),
      });
      setSelectedLink(res.link);
      if (res.sourceCodeMap !== undefined || res.targetCodeMap !== undefined) {
        setLinkCodeMaps({
          source: res.sourceCodeMap ?? null,
          target: res.targetCodeMap ?? null,
        });
      }
      setNotice({
        text:
          res.notice ||
          (res.privacyBlocked
            ? "目标为私有仓且未开启 LLM 隐私授权，已使用 0 MB 零克隆 Code Map 本地确定性源码对照分析。"
            : res.usedLlm
              ? `零克隆源码级吸收研究完成（LLM + Code Map）：共提炼 ${res.link.moduleAnalysis.length} 个源码级可吸收模块方案。`
              : `零克隆 Code Map 结构化源码对照完成：共提炼 ${res.link.moduleAnalysis.length} 个源码级可吸收模块方案。`),
      });
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "执行零克隆源码级吸收研究失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleSubmitToMailbox = async (linkId: string) => {
    setBusyAction("submit-mailbox");
    setError("");
    try {
      const res = await request<SubmitLinkToMailboxResult>(
        `${API_BASE}/links/${encodeURIComponent(linkId)}/submit-mailbox`,
        {
          method: "POST",
          body: JSON.stringify({ note: mailboxNote.trim() || undefined }),
        },
      );
      setSelectedLink(res.link);
      setMailboxNote("");
      setNotice({
        text: res.reusedPending
          ? "该边已有待审批提案在总裁信箱中（已自动防重复用）。"
          : "已生成开源吸收评估单并送达总裁信箱，待你拍板（V1 仅人工留痕不自动改代码）。",
        href: `#mailbox?decision=${encodeURIComponent(res.packet.id)}`,
        hrefLabel: "前往总裁信箱审批 ↗",
      });
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "提交总裁信箱评估失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handlePromoteOpportunity = async (linkId: string) => {
    setBusyAction("promote-opp");
    setError("");
    try {
      const res = await request<PromoteLinkToOpportunityResult>(
        `${API_BASE}/links/${encodeURIComponent(linkId)}/promote-opportunity`,
        {
          method: "POST",
          body: JSON.stringify({ pipeline: "quick" }),
        },
      );
      setSelectedLink(res.link);
      setNotice({
        text: `已手动转为研发选题（项目：${res.project}）。`,
        href: "#opportunities",
        hrefLabel: "查看研发选题池 ↗",
      });
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "转为研发选题失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleSaveLinkEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedLink) return;
    setBusyAction("save-link");
    setError("");
    try {
      const updated = await request<RepoAbsorptionLink>(
        `${API_BASE}/links/${encodeURIComponent(selectedLink.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            relationType: linkEditRelation,
            status: linkEditStatus,
            strength: Math.max(0.05, Math.min(1, linkEditStrength / 100)),
            rationale: linkEditRationale.trim(),
          }),
        },
      );
      setSelectedLink(updated);
      setLinkEditing(false);
      setNotice({ text: "吸收边属性已更新。" });
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "保存吸收边失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleDeleteLink = async (link: RepoAbsorptionLink) => {
    if (!window.confirm(`确认删除「${link.sourceRepoFullName} → ${link.targetRepoFullName}」的吸收边？`)) {
      return;
    }
    setBusyAction("delete-link");
    setError("");
    try {
      await request<{ ok: boolean }>(`${API_BASE}/links/${encodeURIComponent(link.id)}`, {
        method: "DELETE",
      });
      setSelectedLink(null);
      setInspectorMode("none");
      setNotice({ text: "已删除吸收边。" });
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "删除吸收边失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleAddManualModule = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedLink || !newModSource.trim() || !newModMechanism.trim()) return;
    const item: RepoModuleAnalysisItem = {
      id: `mod-manual-${Date.now()}`,
      sourceModulePath: newModSource.trim(),
      targetModulePath: newModTarget.trim() || "待定目标模块",
      absorbableMechanism: newModMechanism.trim(),
      currentGap: newModGap.trim() || "当前自有仓尚无等价实现",
      adaptationPlan: newModPlan.trim() || "人工评审后制定适配计划",
      effort: newModEffort,
      risk: newModRisk,
      evidenceLinks: [],
    };
    const nextModules = [...selectedLink.moduleAnalysis, item];
    setBusyAction("add-module");
    try {
      const updated = await request<RepoAbsorptionLink>(
        `${API_BASE}/links/${encodeURIComponent(selectedLink.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ moduleAnalysis: nextModules }),
        },
      );
      setSelectedLink(updated);
      setAddingModule(false);
      setNewModSource("");
      setNewModTarget("");
      setNewModMechanism("");
      setNewModGap("");
      setNewModPlan("");
      setNotice({ text: "已添加手动模块分析条目。" });
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "添加模块分析失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleRemoveModuleItem = async (modId: string) => {
    if (!selectedLink) return;
    const nextModules = selectedLink.moduleAnalysis.filter((m) => m.id !== modId);
    setBusyAction("remove-module");
    try {
      const updated = await request<RepoAbsorptionLink>(
        `${API_BASE}/links/${encodeURIComponent(selectedLink.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ moduleAnalysis: nextModules }),
        },
      );
      setSelectedLink(updated);
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "删除模块条目失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- View 2: Domain CRUD & Batch Pool Actions ----

  const handleSaveDomain = async (e: FormEvent) => {
    e.preventDefault();
    if (!domainModal || !domainModal.name.trim()) return;
    setBusyAction("domain-save");
    setError("");
    const seedKeywords = domainModal.seedKeywords
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      if (domainModal.mode === "create") {
        await request<RepoDomain>(`${API_BASE}/domains`, {
          method: "POST",
          body: JSON.stringify({
            name: domainModal.name.trim(),
            description: domainModal.description.trim(),
            color: domainModal.color,
            icon: domainModal.icon.trim() || "◈",
            seedKeywords,
          }),
        });
        setNotice({ text: `已新建领域「${domainModal.name.trim()}」。` });
      } else if (domainModal.domain) {
        await request<RepoDomain>(`${API_BASE}/domains/${encodeURIComponent(domainModal.domain.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: domainModal.name.trim(),
            description: domainModal.description.trim(),
            color: domainModal.color,
            icon: domainModal.icon.trim() || "◈",
            seedKeywords,
          }),
        });
        setNotice({ text: `已更新领域「${domainModal.name.trim()}」。` });
      }
      setDomainModal(null);
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "保存领域失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleDeleteDomain = async (domain: RepoDomainCluster) => {
    if (!window.confirm(`删除领域「${domain.name}」后，该领域下 ${domain.totalNodes} 个仓库将回到未归类池，确认删除？`)) {
      return;
    }
    setBusyAction("domain-del");
    setError("");
    try {
      await request<{ ok: boolean }>(`${API_BASE}/domains/${encodeURIComponent(domain.id)}`, {
        method: "DELETE",
      });
      if (poolDomainId === domain.id) setPoolDomainId("");
      if (selectedDomainId === domain.id) {
        setSelectedDomainId(null);
        setInspectorMode("none");
      }
      setNotice({ text: `已删除领域「${domain.name}」。` });
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "删除领域失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleMergeDomains = async (e: FormEvent) => {
    e.preventDefault();
    if (!mergeModal || !mergeModal.sourceDomainId || !mergeModal.targetDomainId || mergeModal.sourceDomainId === mergeModal.targetDomainId) {
      return;
    }
    setBusyAction("domain-merge");
    setError("");
    try {
      const res = await request<{ targetDomain: RepoDomain; movedNodes: number }>(`${API_BASE}/domains/merge`, {
        method: "POST",
        body: JSON.stringify(mergeModal),
      });
      if (poolDomainId === mergeModal.sourceDomainId) setPoolDomainId(mergeModal.targetDomainId);
      if (selectedDomainId === mergeModal.sourceDomainId) setSelectedDomainId(mergeModal.targetDomainId);
      setMergeModal(null);
      setNotice({ text: `已合并领域至「${res.targetDomain.name}」，迁移 ${res.movedNodes} 个仓库。` });
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "合并领域失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleImportGithubLists = async () => {
    setBusyAction("import-lists");
    setError("");
    try {
      const res = await request<ImportGithubListsResult>(`${API_BASE}/domains/import-github-lists`, {
        method: "POST",
        body: "{}",
      });
      setNotice({ text: `已导入 GitHub Star Lists：新增/同步领域 ${res.importedDomains} 个，自动归类 ${res.assignedNodes} 个仓库。` });
      await refreshGraphs();
      if (activeTab === "domains") await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "导入 GitHub Star Lists 失败"));
    } finally {
      setBusyAction("");
    }
  };

  const handleBatchNodes = async (action: BatchUpdateRepoNodesInput["action"], domainId?: string | null) => {
    const ids = Array.from(checkedNodeIds);
    if (ids.length === 0) return;
    setBusyAction("batch-nodes");
    setError("");
    try {
      const res = await request<BatchUpdateRepoNodesResult>(`${API_BASE}/nodes/batch`, {
        method: "POST",
        body: JSON.stringify({
          nodeIds: ids,
          action,
          ...(domainId !== undefined ? { domainId } : {}),
        }),
      });
      setCheckedNodeIds(new Set());
      setNotice({ text: `批量操作完成，共更新 ${res.updatedCount} 个仓库。` });
      await refreshGraphs();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "批量更新仓库失败"));
    } finally {
      setBusyAction("");
    }
  };

  const openQuickLinkModal = async (node: RepoEvolutionNode) => {
    setQuickLinkNode(node);
    setQuickLinkRelation("direct_module");
    setQuickLinkRationale("");
    setQuickLinkTargets(new Set());
    try {
      const detail = await request<NodeDetailResponse>(`${API_BASE}/nodes/${encodeURIComponent(node.id)}`);
      setQuickLinkTargets(new Set(detail.outgoingLinks.map((l) => l.targetNodeId)));
    } catch {
      // allow user to check freely
    }
  };

  const submitQuickLinkModal = async (e: FormEvent) => {
    e.preventDefault();
    if (!quickLinkNode) return;
    const ids = Array.from(quickLinkTargets);
    if (ids.length === 0) {
      setError("请至少勾选 1 个我的开源库");
      return;
    }
    setBusyAction("quick-link");
    setError("");
    try {
      const res = await request<{ links: RepoAbsorptionLink[] }>(
        `${API_BASE}/nodes/${encodeURIComponent(quickLinkNode.id)}/links/bulk`,
        {
          method: "POST",
          body: JSON.stringify({
            targetNodeIds: ids,
            relationType: quickLinkRelation,
            rationale: quickLinkRationale.trim() || undefined,
          }),
        },
      );
      setQuickLinkNode(null);
      setNotice({ text: `已为 ${quickLinkNode.fullName} 建立 ${res.links.length} 条吸收关联。` });
      await refreshGraphs();
      await loadNodesPage();
    } catch (err) {
      setError(describeError(err, "保存 1 对 N 关联失败"));
    } finally {
      setBusyAction("");
    }
  };

  // ---- Focus Dimming & Highlighting Lineage ----

  const haloHighlight = useMemo(() => {
    const selectedNodeId = inspectorMode === "node" && selectedNodeDetail ? selectedNodeDetail.node.id : null;
    const selectedLinkId = inspectorMode === "link" && selectedLink ? selectedLink.id : null;
    const selectedDomId = inspectorMode === "domain" ? selectedDomainId : null;

    const isHover = Boolean(hoveredLinkId || hoveredStarId || hoveredOwnedId || hoveredDomainId);
    const activeLinkId = hoveredLinkId ?? (!isHover ? selectedLinkId : null);
    const activeStarId =
      hoveredStarId ?? (!isHover && selectedNodeId && radialLayout.starMap.has(selectedNodeId) ? selectedNodeId : null);
    const activeOwnedId =
      hoveredOwnedId ?? (!isHover && selectedNodeId && radialLayout.ownedMap.has(selectedNodeId) ? selectedNodeId : null);
    const activeDomainId = hoveredDomainId ?? (!isHover ? selectedDomId : null);

    if (!activeLinkId && !activeStarId && !activeOwnedId && !activeDomainId) {
      return {
        active: false,
        isHover: false,
        domainIds: new Set<string>(),
        ownedIds: new Set<string>(),
        starIds: new Set<string>(),
        linkIds: new Set<string>(),
      };
    }

    const domainIds = new Set<string>();
    const ownedIds = new Set<string>();
    const starIds = new Set<string>();
    const linkIds = new Set<string>();

    if (activeLinkId) {
      const rl = radialLayout.links.find((item) => item.link.id === activeLinkId);
      if (rl) {
        linkIds.add(rl.link.id);
        starIds.add(rl.link.starNodeId);
        ownedIds.add(rl.link.ownedNodeId);
        const oPos = radialLayout.ownedMap.get(rl.link.ownedNodeId);
        if (oPos) domainIds.add(oPos.sectorId);
        const sPos = radialLayout.starMap.get(rl.link.starNodeId);
        if (sPos) domainIds.add(sPos.sectorId);
      }
    } else if (activeStarId) {
      starIds.add(activeStarId);
      for (const rl of radialLayout.links) {
        if (rl.link.starNodeId === activeStarId) {
          linkIds.add(rl.link.id);
          ownedIds.add(rl.link.ownedNodeId);
          const oPos = radialLayout.ownedMap.get(rl.link.ownedNodeId);
          if (oPos) domainIds.add(oPos.sectorId);
        }
      }
      const sPos = radialLayout.starMap.get(activeStarId);
      if (sPos) domainIds.add(sPos.sectorId);
    } else if (activeOwnedId) {
      ownedIds.add(activeOwnedId);
      const oPos = radialLayout.ownedMap.get(activeOwnedId);
      if (oPos) domainIds.add(oPos.sectorId);
      for (const rl of radialLayout.links) {
        if (rl.link.ownedNodeId === activeOwnedId) {
          linkIds.add(rl.link.id);
          starIds.add(rl.link.starNodeId);
        }
      }
    } else if (activeDomainId) {
      domainIds.add(activeDomainId);
      for (const po of radialLayout.ownedList) {
        if (po.sectorId === activeDomainId) ownedIds.add(po.node.id);
      }
      for (const rl of radialLayout.links) {
        if (ownedIds.has(rl.link.ownedNodeId)) {
          linkIds.add(rl.link.id);
          starIds.add(rl.link.starNodeId);
        }
      }
    }

    return {
      active: true,
      isHover,
      domainIds,
      ownedIds,
      starIds,
      linkIds,
    };
  }, [
    radialLayout,
    hoveredLinkId,
    hoveredStarId,
    hoveredOwnedId,
    hoveredDomainId,
    inspectorMode,
    selectedNodeDetail,
    selectedLink,
    selectedDomainId,
  ]);

  // ---- Derived Data for Tabs & Controls ----

  const rStats = radialGraph?.stats;
  const mStats = macroGraph?.stats;
  const domainClusters = macroGraph?.domains ?? [];
  const radialDomains = radialGraph?.domains ?? [];
  const allOwnedForCheckboxes = macroGraph?.ownedRepos ?? radialGraph?.ownedNodes ?? [];
  const spotlightOwned = useMemo(
    () => (radialGraph?.ownedNodes ?? []).filter((r) => r.priorityTier === "spotlight"),
    [radialGraph?.ownedNodes],
  );
  const selectedDomainObj = useMemo(
    () => radialDomains.find((d) => d.id === selectedDomainId) ?? null,
    [radialDomains, selectedDomainId],
  );
  const selectedOwnedRadialProfile = useMemo(() => {
    if (inspectorMode !== "node" || !selectedNodeDetail) return null;
    return radialGraph?.ownedNodes.find((o) => o.id === selectedNodeDetail.node.id) ?? null;
  }, [inspectorMode, selectedNodeDetail, radialGraph?.ownedNodes]);

  // Local domain matches for search dropdown
  const matchingDomainsForSearch = useMemo(() => {
    const q = graphSearch.trim().toLowerCase();
    if (!q) return [];
    return radialDomains
      .filter((d) => d.name.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q))
      .slice(0, 3);
  }, [graphSearch, radialDomains]);

  // Depth active level readout
  const currentDepthLabel = !radialLayout.hasL2 ? "L1" : !radialLayout.hasL3 ? "L2" : "L3";

  // Timeline grouped by YYYY-MM-DD
  const timelineGroups = useMemo(() => {
    const items = timelinePage?.items ?? [];
    const groups = new Map<string, RepoAbsorptionEvent[]>();
    for (const ev of items) {
      const day = ev.createdAt ? ev.createdAt.slice(0, 10) : "未知日期";
      const arr = groups.get(day) ?? [];
      arr.push(ev);
      groups.set(day, arr);
    }
    return Array.from(groups.entries());
  }, [timelinePage?.items]);

  const syncProgressPct = useMemo(() => {
    if (!activeSyncJob) return null;
    if (activeSyncJob.status === "completed") return 100;
    if (activeSyncJob.starredTotal && activeSyncJob.starredTotal > 0) {
      return Math.min(98, Math.round((activeSyncJob.starredFetched / activeSyncJob.starredTotal) * 100));
    }
    if (activeSyncJob.ownedTotal && activeSyncJob.ownedTotal > 0 && activeSyncJob.phase === "owned_repos") {
      return Math.min(40, Math.round((activeSyncJob.ownedFetched / activeSyncJob.ownedTotal) * 40));
    }
    return null;
  }, [activeSyncJob]);

  const allPoolChecked =
    Boolean(nodesPage && nodesPage.items.length > 0) &&
    nodesPage!.items.every((item) => checkedNodeIds.has(item.id));

  const toggleAllPool = () => {
    if (!nodesPage) return;
    if (allPoolChecked) {
      setCheckedNodeIds(new Set());
    } else {
      setCheckedNodeIds(new Set(nodesPage.items.map((n) => n.id)));
    }
  };

  // Theme colors for SVG primitives
  const svgPalette = useMemo(() => {
    if (haloTheme === "cosmic") {
      return {
        orbitStroke: "rgba(148, 184, 232, 0.2)",
        orbitR2Stroke: "rgba(94, 212, 174, 0.22)",
        orbitR3Stroke: "rgba(245, 192, 92, 0.19)",
        orbitR3bStroke: "rgba(148, 163, 184, 0.14)",
        meridianStroke: "rgba(148, 184, 232, 0.06)",
        ringLabelFill: "rgba(176, 198, 228, 0.56)",
        coreFill: "#101a2e",
        coreStroke: "#60a5fa",
        coreTitle: "#f8fafc",
        coreSub: "#94a3b8",
        coreMeta: "#38bdf8",
        cardFill: "rgba(15, 24, 42, 0.92)",
        cardSelectedFill: "rgba(24, 40, 68, 0.96)",
        cardSpotFill: "rgba(38, 30, 14, 0.94)",
        cardStroke: "rgba(148, 179, 226, 0.3)",
        cardSpotStroke: "#f5b942",
        cardPrivStroke: "#a78bfa",
        textPrimary: "#f1f5f9",
        textSecondary: "#94a3b8",
        textMuted: "#64748b",
        badgeBg: "rgba(30, 41, 59, 0.94)",
        badgeStroke: "rgba(148, 179, 226, 0.38)",
        nebulaFill: "rgba(19, 28, 46, 0.88)",
        nebulaStroke: "rgba(245, 185, 66, 0.45)",
        nebulaText: "#fde68a",
        nebulaSub: "#cbd5e1",
        dimNodeOpacity: 0.16,
        dimSelectedOpacity: 0.26,
        dimEdgeOpacity: 0.08,
      };
    }
    return {
      orbitStroke: "rgba(43, 78, 60, 0.18)",
      orbitR2Stroke: "rgba(43, 78, 60, 0.2)",
      orbitR3Stroke: "rgba(185, 117, 29, 0.22)",
      orbitR3bStroke: "rgba(120, 128, 120, 0.16)",
      meridianStroke: "rgba(35, 45, 39, 0.06)",
      ringLabelFill: "rgba(79, 87, 80, 0.68)",
      coreFill: "#fffdf8",
      coreStroke: "#2b4e3c",
      coreTitle: "#1d2620",
      coreSub: "#576058",
      coreMeta: "#2b4e3c",
      cardFill: "rgba(255, 253, 248, 0.96)",
      cardSelectedFill: "#eef6f1",
      cardSpotFill: "#fffbf0",
      cardStroke: "#c7c1b2",
      cardSpotStroke: "#c79c4c",
      cardPrivStroke: "#7b5e8f",
      textPrimary: "#1d2620",
      textSecondary: "#545d55",
      textMuted: "#747b73",
      badgeBg: "#f5f1e6",
      badgeStroke: "#cbc4b4",
      nebulaFill: "rgba(247, 244, 234, 0.95)",
      nebulaStroke: "#a89e8a",
      nebulaText: "#564a35",
      nebulaSub: "#6f6759",
      dimNodeOpacity: 0.2,
      dimSelectedOpacity: 0.3,
      dimEdgeOpacity: 0.1,
    };
  }, [haloTheme]);

  // ---- Render ----

  return (
    <section className="zo-product re-page" aria-label="开源进化与吸收图谱" data-testid="repo-evolution-page">
      {/* 顶部控制栏 */}
      <header className="re-topbar">
        <div className="re-topbar-row">
          <div className="re-title-group">
            {nav}
            <h1>开源进化与吸收图谱</h1>
            <span className="re-subtitle">
              同心三层可展开光环 · 中心领域环 → 我的开源库环 → Star 1 对 N 滋养环 · 模块级吸收评估
            </span>
          </div>
          <div className="re-actions-group">
            <button
              type="button"
              className="re-primary"
              disabled={Boolean(busyAction) || activeSyncJob?.status === "running"}
              onClick={() => void triggerSync("incremental")}
            >
              {busyAction === "sync:incremental" ? "启动中…" : "增量同步 GitHub"}
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction) || activeSyncJob?.status === "running"}
              onClick={() => void triggerSync("full")}
            >
              {busyAction === "sync:full" ? "启动中…" : "全量同步"}
            </button>
            <button
              type="button"
              className="re-indigo"
              disabled={Boolean(busyAction)}
              onClick={() => void triggerClusterAndRecall()}
            >
              {busyAction === "cluster" ? "精准聚类召回中…" : "AI 精准聚类与召回"}
            </button>
            <button
              type="button"
              data-testid="radial-recalibrate-btn"
              disabled={Boolean(busyAction)}
              title="一键校准内置领域体系、补全自有库画像并清理低质 AI 建议边（保留所有人工审批与手动连线）"
              onClick={() => void triggerRecalibrate()}
            >
              {busyAction === "recalibrate" ? "校准分类中…" : "校准分类与关联"}
            </button>
            <button type="button" onClick={openSettings}>
              ⚙ 设置
            </button>
          </div>
        </div>

        {/* 5 项核心指标条 */}
        <div className="re-metrics-bar" role="region" aria-label="开源进化核心指标">
          <button
            type="button"
            className="re-metric-card"
            data-tone="pine"
            onClick={() => {
              setActiveTab("domains");
              setPoolBucket("owned");
              setPoolDomainId("");
              setPoolPage(1);
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">我的开源库（原创）</span>
              <span className="re-metric-value">{rStats?.ownedOriginalCount ?? mStats?.ownedOriginalCount ?? mStats?.ownedCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              全部 {rStats?.ownedCount ?? mStats?.ownedCount ?? 0} · Fork {rStats?.ownedForkCount ?? mStats?.ownedForkCount ?? 0} · 🔒 私有 {rStats?.ownedPrivateCount ?? mStats?.ownedPrivateCount ?? 0} · ★ 重点 {rStats?.spotlightCount ?? mStats?.spotlightCount ?? 0}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            onClick={() => {
              setActiveTab("domains");
              setPoolBucket("all");
              setPoolDomainId("");
              setPoolPage(1);
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">Star 仓库总数</span>
              <span className="re-metric-value">{rStats?.starredCount ?? mStats?.starredCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              已关联 {rStats?.linkedStarCount ?? 0} · 1对N跨库 {rStats?.multiTargetStarCount ?? 0} · 活跃 {mStats?.activeStarredCount ?? 0}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            data-tone="pine"
            onClick={() => {
              setActiveTab("graph");
              applyExpandAll();
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">已建立吸收边</span>
              <span className="re-metric-value">{rStats?.linkCount ?? mStats?.linkCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              已批/落地 {rStats?.approvedCount ?? ((mStats?.approvedLinkCount ?? 0) + (mStats?.absorbingLinkCount ?? 0) + (mStats?.absorbedLinkCount ?? 0))} · 建议/待审 {rStats?.pendingReviewCount ?? mStats?.suggestedLinkCount ?? 0}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            data-tone="indigo"
            onClick={() => {
              if ((rStats?.inReviewCount ?? mStats?.inReviewLinkCount ?? 0) > 0) {
                setActiveTab("graph");
                setStatusFilter("in_review");
                applyExpandAll();
              } else {
                location.hash = "#mailbox";
              }
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">待总裁信箱审批</span>
              <span className="re-metric-value">{rStats?.inReviewCount ?? mStats?.inReviewLinkCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              {(rStats?.inReviewCount ?? mStats?.inReviewLinkCount ?? 0) > 0 ? "点击光环筛选待批边 · 或进信箱拍板" : "暂无待批吸收单 · 去总裁信箱 ↗"}
            </span>
          </button>

          <button
            type="button"
            className="re-metric-card"
            data-tone="amber"
            onClick={() => {
              setActiveTab("domains");
              setPoolBucket("floating");
              setPoolDomainId("");
              setPoolPage(1);
            }}
          >
            <div className="re-metric-head">
              <span className="re-metric-label">游离散落池</span>
              <span className="re-metric-value">{rStats?.floatingPoolCount ?? mStats?.floatingPoolCount ?? 0}</span>
            </div>
            <span className="re-metric-sub">
              未归类 {rStats?.unclassifiedCount ?? mStats?.unclassifiedCount ?? 0} · 归类未连 {rStats?.classifiedUnlinkedCount ?? mStats?.classifiedUnlinkedCount ?? 0} · 陈旧 {rStats?.stalePoolCount ?? mStats?.stalePoolCount ?? 0}
            </span>
          </button>
        </div>

        {/* 4 主视图切换 Tab */}
        <div className="re-tabs-row">
          <div className="re-main-tabs" role="tablist" aria-label="开源进化工作台视图">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "graph"}
              onClick={() => setActiveTab("graph")}
            >
              同心光环图谱
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "domains"}
              onClick={() => setActiveTab("domains")}
            >
              领域与散落池
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "timeline"}
              onClick={() => setActiveTab("timeline")}
            >
              进化时间线
            </button>
            <button
              type="button"
              role="tab"
              data-testid="re-tab-architecture"
              aria-selected={activeTab === "architecture"}
              onClick={() => {
                setActiveTab("architecture");
                setInspectorMode("none");
              }}
            >
              架构原语台
              {primitiveCount > 0 && <span className="re-tab-count">{primitiveCount}</span>}
            </button>
          </div>

          <div className="re-actions-group">
            {(radialGraph?.config ?? macroGraph?.config) && (
              <span className="re-auto-badge" title="可在右上角设置中查看或调整">
                档位：{REPO_AUTOMATION_MODE_LABELS[(radialGraph?.config ?? macroGraph?.config)!.automationMode]}
              </span>
            )}
            <a className="re-link-btn" href="#mailbox">
              总裁信箱 ↗
            </a>
          </div>
        </div>

        {/* 后台同步实时进度条 */}
        {activeSyncJob && (activeSyncJob.status === "queued" || activeSyncJob.status === "running" || activeSyncJob.status === "failed") && (
          <div className="re-sync-bar" data-status={activeSyncJob.status} role="status">
            <div className="re-sync-bar-head">
              <span>
                <strong>
                  {activeSyncJob.status === "failed"
                    ? "⚠️ GitHub 同步中断"
                    : `🔄 GitHub ${activeSyncJob.mode === "full" ? "全量" : "增量"}同步中`}
                </strong>
                {" · "}阶段：{SYNC_PHASE_LABELS[activeSyncJob.phase] ?? activeSyncJob.phase}
                {" · "}自有 {activeSyncJob.ownedFetched}{activeSyncJob.ownedTotal ? `/${activeSyncJob.ownedTotal}` : ""}
                {" · "}Star {activeSyncJob.starredFetched}{activeSyncJob.starredTotal ? `/${activeSyncJob.starredTotal}` : ""}
                {" · "}Lists {activeSyncJob.listsFetched}
                {" · "}向量 {activeSyncJob.embeddingsComputed}
                {activeSyncJob.errorMessage ? ` · ${activeSyncJob.errorMessage}` : ""}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {activeSyncJob.status === "failed" && activeSyncJob.cursor && (
                  <button
                    type="button"
                    className="re-mini re-primary"
                    onClick={() => void triggerSync(activeSyncJob.mode === "full" ? "full" : "incremental", activeSyncJob.id)}
                  >
                    断点续传
                  </button>
                )}
                {activeSyncJob.status === "failed" && (
                  <button type="button" className="re-mini re-ghost" onClick={() => setActiveSyncJob(null)}>
                    关闭
                  </button>
                )}
              </div>
            </div>
            {(activeSyncJob.status === "queued" || activeSyncJob.status === "running") && (
              <div className="re-sync-progress-track">
                <div
                  className={`re-sync-progress-fill ${syncProgressPct === null ? "indeterminate" : ""}`}
                  style={syncProgressPct !== null ? { width: `${syncProgressPct}%` } : undefined}
                />
              </div>
            )}
          </div>
        )}
      </header>

      {/* 通知 / 错误横幅 */}
      {notice && (
        <div className="re-banner" role="status">
          <span>{notice.text}</span>
          <div className="re-banner-actions">
            {notice.href && (
              <a className="re-link-btn" href={notice.href}>
                {notice.hrefLabel || "查看 ↗"}
              </a>
            )}
            <button type="button" className="re-ghost re-mini" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="re-banner error" role="alert">
          <span>{error}</span>
          <button type="button" className="re-ghost re-mini" onClick={() => setError("")}>
            ✕
          </button>
        </div>
      )}

      {/* 主工作区 */}
      <div className="re-body">
        {/* ================= 视图 1：同心三层可展开光环大 Graph ================= */}
        {activeTab === "graph" && (
          <div className="re-graph-wrap">
            {/* 图谱操控工具条 */}
            <div className="re-graph-subbar">
              <div className="re-graph-subbar-left">
                <div className="re-depth-group" role="group" aria-label="同心光环展开层级">
                  <button
                    type="button"
                    data-testid="radial-layer-l1"
                    className={currentDepthLabel === "L1" ? "re-active" : ""}
                    onClick={applyLayerL1}
                    title="收起至第一层：中心核 + 领域环"
                  >
                    L1 领域环
                  </button>
                  <button
                    type="button"
                    data-testid="radial-layer-l2"
                    className={currentDepthLabel === "L2" ? "re-active" : ""}
                    onClick={applyLayerL2}
                    title="展开至第二层：领域环 + 我的开源库环"
                  >
                    L2 +我的库
                  </button>
                  <button
                    type="button"
                    data-testid="radial-layer-l3"
                    className={currentDepthLabel === "L3" ? "re-active" : ""}
                    onClick={applyLayerL3SelectedOrTop}
                    title="展开精选 / 当前选中领域至第三层 Star 环"
                  >
                    L3 展开精选
                  </button>
                </div>

                <button
                  type="button"
                  className="re-mini"
                  data-testid="radial-expand-all"
                  onClick={applyExpandAll}
                  title="展开全部三层光环"
                >
                  展开全部
                </button>
                <button
                  type="button"
                  className="re-mini"
                  data-testid="radial-collapse-l1"
                  onClick={applyLayerL1}
                  title="一键收起至第一层领域环"
                >
                  收起至领域环
                </button>

                <span className="re-subbar-divider" aria-hidden="true" />

                {spotlightOwned.slice(0, 3).map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    className="re-mini re-spotlight-chip"
                    onClick={() => void locateNodeInRadial(repo)}
                    title={`在光环中定位重点关注仓 ${repo.fullName} 并展开其第三层 Star`}
                  >
                    ★ {repo.name}
                  </button>
                ))}
              </div>

              <div className="re-graph-subbar-right">
                <label className="re-check-toggle" title="默认隐藏 Fork 仓，仅聚焦你的原创开源库">
                  <input
                    type="checkbox"
                    data-testid="radial-toggle-forks"
                    checked={includeForks}
                    onChange={(e) => {
                      setIncludeForks(e.target.checked);
                      pendingFocusTargetRef.current = { kind: "fit" };
                    }}
                  />
                  显示 Fork 仓 ({rStats?.ownedForkCount ?? 0})
                </label>

                <select
                  aria-label="按吸收状态筛选连线"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as RepoAbsorptionStatus | "all")}
                >
                  <option value="all">全部边状态</option>
                  {STATUS_KEYS.map((st) => (
                    <option key={st} value={st}>
                      {REPO_ABSORPTION_STATUS_LABELS[st]}
                    </option>
                  ))}
                </select>

                <label className="re-check-toggle">
                  <input
                    type="checkbox"
                    checked={includeRejected}
                    onChange={(e) => setIncludeRejected(e.target.checked)}
                  />
                  含已驳回
                </label>

                <button
                  type="button"
                  className="re-mini re-theme-btn"
                  data-theme={haloTheme}
                  data-testid="radial-theme-toggle"
                  onClick={toggleHaloTheme}
                  title="一键切换「星夜光环 / 宣纸星轨」双主题"
                >
                  {haloTheme === "cosmic" ? "✦ 星夜光环" : "📜 宣纸星轨"}
                </button>

                {/* 搜索定位节点并自动展开所在层级 */}
                <div className="re-search-box">
                  <input
                    type="search"
                    data-testid="radial-search-input"
                    value={graphSearch}
                    onChange={(e) => setGraphSearch(e.target.value)}
                    onFocus={() => (graphSearchResults.length > 0 || matchingDomainsForSearch.length > 0) && setGraphSearchOpen(true)}
                    onBlur={() => window.setTimeout(() => setGraphSearchOpen(false), 180)}
                    placeholder="搜索定位领域 / 自有库 / Star…"
                    aria-label="搜索定位光环节点"
                  />
                  {graphSearchOpen && (matchingDomainsForSearch.length > 0 || graphSearchResults.length > 0) && (
                    <ul className="re-search-dropdown" role="listbox">
                      {matchingDomainsForSearch.map((dom) => (
                        <li key={`dom-${dom.id}`}>
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setGraphSearchOpen(false);
                              setGraphSearch("");
                              locateDomainInRadial(dom.id, true);
                            }}
                          >
                            <span>
                              {formatDomainIcon(dom.icon)} <strong>{dom.name}</strong>
                            </span>
                            <span className="re-pill">第一层领域 · {dom.ownedOriginalCount} 库</span>
                          </button>
                        </li>
                      ))}
                      {graphSearchResults.map((node) => (
                        <li key={node.id}>
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setGraphSearchOpen(false);
                              setGraphSearch("");
                              void locateNodeInRadial(node);
                            }}
                          >
                            <span>
                              {node.priorityTier === "spotlight" ? "★ " : ""}
                              {node.visibility === "private" ? "🔒 " : ""}
                              {node.isFork ? "⑂ " : ""}
                              <strong>{node.fullName}</strong>
                            </span>
                            <span className="re-pill">
                              {node.role !== "starred" ? "L2 自有" : `L3 ★ ${formatStars(node.starsCount)}`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* 同心光环 SVG 画布 */}
            <div
              ref={stageRef}
              className="re-stage"
              data-halo-theme={haloTheme}
              data-panning={isPanning ? "true" : "false"}
              data-testid="radial-halo-stage"
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerUp}
              onDoubleClick={() => fitView()}
            >
              {/* 顶部悬浮状态条 */}
              {radialGraph && (
                <div className="re-halo-hud-top">
                  <div className="re-halo-status-pill">
                    <span>
                      当前层级 <strong>{currentDepthLabel}</strong>
                    </span>
                    <span>
                      R1 领域 <strong>{radialLayout.sectors.length}</strong>
                    </span>
                    <span>
                      R2 展开自有 <strong>{radialLayout.ownedList.length}</strong>/{radialGraph.ownedNodes.length}
                    </span>
                    <span>
                      R3 展开 Star <strong>{radialLayout.starList.length}</strong>（连线{" "}
                      <strong>{radialLayout.links.length}</strong>）
                    </span>
                    {statusFilter !== "all" && (
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => setStatusFilter("all")}
                        title="清除状态筛选"
                      >
                        筛选：{REPO_ABSORPTION_STATUS_LABELS[statusFilter]} ✕
                      </button>
                    )}
                    <span style={{ opacity: 0.78 }}>点击领域展开库 · 点击自有库展开 Star · 悬停聚焦 1 对 N</span>
                  </div>

                  {radialGraph.truncated && (
                    <div className="re-truncate-banner">
                      <span>已按单库上限 {maxStarsPerOwned} 仓防重叠渲染，点击弧尾 +N 节点可继续展开</span>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => {
                          setActiveTab("domains");
                          setPoolBucket("linked");
                        }}
                      >
                        表格全量 →
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 空态引导 */}
              {radialGraph && rStats && rStats.ownedCount === 0 && rStats.starredCount === 0 ? (
                <div className="re-empty-stage">
                  <div className="re-empty-card">
                    <h2>尚未同步 GitHub 仓库与 Star 数据</h2>
                    <p>
                      首次同步将通过本机已登录的 <code>gh</code> CLI 拉取你的公开与私有自有仓（默认重点关注{" "}
                      <strong>ai-agent-node</strong>）、全部 GitHub Star 仓及 Star Lists，并在 PostgreSQL 18 + pgvector 中构建同心三层光环图谱。
                    </p>
                    <div className="re-empty-actions">
                      <button
                        type="button"
                        className="re-primary"
                        disabled={Boolean(busyAction)}
                        onClick={() => void triggerSync("incremental")}
                      >
                        立即增量同步 GitHub
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyAction)}
                        onClick={() => void triggerSync("full")}
                      >
                        全量同步全部 Star
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <svg
                  className="re-svg"
                  role="img"
                  aria-label="同心光环三层可展开开源演进大 Graph"
                  data-testid="radial-halo-svg"
                >
                  <defs>
                    {/* 中心核柔光径向渐变 */}
                    <radialGradient id="re-core-aura-cosmic" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.34" />
                      <stop offset="55%" stopColor="#3b82f6" stopOpacity="0.1" />
                      <stop offset="100%" stopColor="#0f172a" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="re-core-aura-washi" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#2b4e3c" stopOpacity="0.14" />
                      <stop offset="65%" stopColor="#b9751d" stopOpacity="0.05" />
                      <stop offset="100%" stopColor="#faf6ec" stopOpacity="0" />
                    </radialGradient>

                    {/* Spotlight 金色微光滤镜 */}
                    <filter id="re-glow-gold" x="-30%" y="-30%" width="160%" height="160%">
                      <feGaussianBlur stdDeviation="4.5" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <filter id="re-glow-soft" x="-25%" y="-25%" width="150%" height="150%">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>

                    {/* 深空星夜箭头 */}
                    <marker id="re-arrow-c-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#f59e0b" />
                    </marker>
                    <marker id="re-arrow-c-violet" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#a78bfa" />
                    </marker>
                    <marker id="re-arrow-c-emerald" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#34d399" />
                    </marker>
                    <marker id="re-arrow-c-slate" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#94a3b8" />
                    </marker>
                    <marker id="re-arrow-c-rose" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#f87171" />
                    </marker>

                    {/* 宣纸星轨箭头 */}
                    <marker id="re-arrow-w-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#b9751d" />
                    </marker>
                    <marker id="re-arrow-w-indigo" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#483d82" />
                    </marker>
                    <marker id="re-arrow-w-pine" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#2a6b48" />
                    </marker>
                    <marker id="re-arrow-w-gray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#7b847d" />
                    </marker>
                    <marker id="re-arrow-w-rust" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                      <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#b05a4c" />
                    </marker>
                  </defs>

                  <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
                    {/* ======== 0. 同心星轨背景装饰层（经纬射线 + 同心淡轨圈 + 扇区柔和光晕） ======== */}
                    <g aria-hidden="true">
                      {/* 中心核外围柔光 */}
                      <circle
                        cx={0}
                        cy={0}
                        r={CORE_RADIUS + 76}
                        fill={haloTheme === "cosmic" ? "url(#re-core-aura-cosmic)" : "url(#re-core-aura-washi)"}
                      />

                      {/* 12 条星盘子午线 */}
                      {Array.from({ length: 12 }).map((_, idx) => {
                        const ang = (idx * Math.PI) / 6;
                        const maxGuideR = radialLayout.hasL3
                          ? (radialLayout.r3Radii[radialLayout.r3Radii.length - 1] ?? 650) + 42
                          : radialLayout.hasL2
                            ? radialLayout.r2Outer + 44
                            : radialLayout.r1 + 52;
                        const p1 = polar(CORE_RADIUS + 14, ang);
                        const p2 = polar(maxGuideR, ang);
                        return (
                          <line
                            key={`meridian-${idx}`}
                            x1={p1.x}
                            y1={p1.y}
                            x2={p2.x}
                            y2={p2.y}
                            stroke={svgPalette.meridianStroke}
                            strokeWidth={1}
                          />
                        );
                      })}

                      {/* 各领域展开态 / 悬停态扇区柔和光晕 */}
                      {radialLayout.sectors.map((ps) => {
                        const isDomHot = haloHighlight.domainIds.has(ps.sector.id);
                        if (!ps.expandedL2 && !isDomHot) return null;
                        const accent = resolveDomainAccent(ps.sector.color, haloTheme);
                        const outerR = ps.hasExpandedL3
                          ? (radialLayout.r3Radii[radialLayout.r3Radii.length - 1] ?? 650) + 34
                          : ps.expandedL2
                            ? radialLayout.r2Outer + 36
                            : radialLayout.r1 + 42;
                        const opacity = isDomHot
                          ? haloTheme === "cosmic"
                            ? 0.14
                            : 0.11
                          : haloTheme === "cosmic"
                            ? 0.055
                            : 0.045;
                        return (
                          <path
                            key={`wedge-${ps.sector.id}`}
                            className="re-sector-wedge"
                            d={annularSectorPath(CORE_RADIUS + 20, outerR, ps.startAngle + 0.015, ps.endAngle - 0.015)}
                            fill={accent}
                            style={{ opacity }}
                          />
                        );
                      })}

                      {/* Ring 1 轨道圈 */}
                      <circle
                        className="re-orbit-ring"
                        cx={0}
                        cy={0}
                        r={radialLayout.r1}
                        fill="none"
                        stroke={svgPalette.orbitStroke}
                        strokeWidth={1.35}
                      />
                      <text
                        x={0}
                        y={-radialLayout.r1 - 12}
                        textAnchor="middle"
                        fontSize={10.5}
                        fontWeight={600}
                        letterSpacing="0.14em"
                        fill={svgPalette.ringLabelFill}
                      >
                        RING 1 · 领域环
                      </text>

                      {/* Ring 2 轨道圈（含多子轨同心虚线环） */}
                      {radialLayout.hasL2 ? (
                        radialLayout.r2Radii.map((rad, idx) => (
                          <circle
                            key={`orbit-r2-${idx}`}
                            className="re-orbit-ring"
                            cx={0}
                            cy={0}
                            r={rad}
                            fill="none"
                            stroke={svgPalette.orbitR2Stroke}
                            strokeWidth={idx === 0 ? 1.3 : 1}
                            strokeDasharray={idx === 0 ? "6 6" : "3 7"}
                            style={{ opacity: idx === 0 ? 1 : 0.65 }}
                          />
                        ))
                      ) : (
                        <circle
                          className="re-orbit-ring"
                          cx={0}
                          cy={0}
                          r={radialLayout.r2}
                          fill="none"
                          stroke={svgPalette.orbitR2Stroke}
                          strokeWidth={1}
                          strokeDasharray="6 6"
                          style={{ opacity: 0.32 }}
                        />
                      )}
                      {radialLayout.hasL2 && (
                        <text
                          x={0}
                          y={-radialLayout.r2Outer - 14}
                          textAnchor="middle"
                          fontSize={10.5}
                          fontWeight={600}
                          letterSpacing="0.14em"
                          fill={svgPalette.ringLabelFill}
                        >
                          RING 2 · 我的开源库环
                        </text>
                      )}

                      {/* Ring 3 双子/三子防重叠轨道圈 */}
                      {radialLayout.r3Radii.map((rad, idx) => (
                        <circle
                          key={`orbit-r3-${idx}`}
                          className="re-orbit-ring"
                          cx={0}
                          cy={0}
                          r={rad}
                          fill="none"
                          stroke={idx === 0 ? svgPalette.orbitR3Stroke : svgPalette.orbitR3bStroke}
                          strokeWidth={idx === 0 ? 1.25 : 1}
                          strokeDasharray={idx === 0 ? "5 7" : "3 7"}
                        />
                      ))}
                      {radialLayout.hasL3 && (
                        <text
                          x={0}
                          y={-(radialLayout.r3Radii[radialLayout.r3Radii.length - 1] ?? 660) - 18}
                          textAnchor="middle"
                          fontSize={10.5}
                          fontWeight={600}
                          letterSpacing="0.14em"
                          fill={svgPalette.ringLabelFill}
                        >
                          RING 3 · STAR 滋养环 (1 对 N)
                        </text>
                      )}
                    </g>

                    {/* ======== 1. 中心核 → 第一层领域辐射光束 ======== */}
                    <g aria-hidden="true">
                      {radialLayout.sectors.map((ps) => {
                        const accent = resolveDomainAccent(ps.sector.color, haloTheme);
                        const isHot = haloHighlight.domainIds.has(ps.sector.id);
                        const p1 = polar(CORE_RADIUS + 4, ps.midAngle);
                        const p2 = polar(radialLayout.r1 - 28, ps.midAngle);
                        const opacity = haloHighlight.active
                          ? isHot
                            ? 0.92
                            : 0.1
                          : ps.expandedL2
                            ? 0.52
                            : 0.28;
                        return (
                          <line
                            key={`beam-core-${ps.sector.id}`}
                            x1={p1.x}
                            y1={p1.y}
                            x2={p2.x}
                            y2={p2.y}
                            stroke={accent}
                            strokeWidth={isHot ? 2.4 : ps.expandedL2 ? 1.6 : 1.15}
                            strokeDasharray={ps.sector.isSynthetic ? "4 4" : undefined}
                            style={{ opacity, transition: "opacity 0.2s ease" }}
                          />
                        );
                      })}
                    </g>

                    {/* ======== 2. 第一层领域 → 第二层我的开源库 放射弧线 ======== */}
                    <g aria-hidden="true">
                      {radialLayout.ownedList.map((po) => {
                        const ps = radialLayout.sectorMap.get(po.sectorId);
                        if (!ps) return null;
                        const accent = resolveDomainAccent(ps.sector.color, haloTheme);
                        const isHot =
                          haloHighlight.ownedIds.has(po.node.id) ||
                          (haloHighlight.domainIds.has(po.sectorId) && !hoveredOwnedId && !hoveredStarId && !hoveredLinkId);
                        const opacity = haloHighlight.active
                          ? isHot
                            ? 0.88
                            : 0.08
                          : po.expandedL3
                            ? 0.62
                            : 0.36;
                        return (
                          <path
                            key={`branch-r1-r2-${po.node.id}`}
                            d={radialBranchCurve(ps.r + 22, ps.midAngle, po.r - 22, po.angle)}
                            fill="none"
                            stroke={accent}
                            strokeWidth={isHot ? 2.3 : po.expandedL3 ? 1.65 : 1.2}
                            strokeDasharray={po.node.isFork ? "4 4" : undefined}
                            style={{ opacity, transition: "opacity 0.2s ease" }}
                          />
                        );
                      })}
                    </g>

                    {/* ======== 3. 第三层 Star → 第二层我的开源库 1 对 N 贝塞尔连线 ======== */}
                    <g>
                      {radialLayout.links.map(({ link, d, midX, midY, isLongArc }) => {
                        const vis = edgeStatusVisual(link.status, haloTheme);
                        const isSelected = inspectorMode === "link" && selectedLink?.id === link.id;
                        const isHot = haloHighlight.linkIds.has(link.id) || isSelected;
                        const opacity = haloHighlight.active
                          ? isHot
                            ? 0.98
                            : svgPalette.dimEdgeOpacity
                          : isLongArc
                            ? 0.66
                            : 0.72;
                        const showBadge =
                          isHot ||
                          isSelected ||
                          link.status === "in_review" ||
                          link.status === "approved" ||
                          link.status === "absorbed" ||
                          radialLayout.links.length <= 14;
                        const badgeText =
                          link.moduleAnalysisCount > 0
                            ? `${link.moduleAnalysisCount} 模块`
                            : `${Math.round(link.strength * 100)}%`;
                        const badgeW = Math.max(40, badgeText.length * 6.8 + 12);

                        return (
                          <g
                            key={link.id}
                            className="re-svg-edge"
                            data-testid={`radial-link-${link.id}`}
                            style={{ opacity }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseEnter={() => setHoveredLinkId(link.id)}
                            onMouseLeave={() => setHoveredLinkId(null)}
                            onClick={() => void openLinkInspector(link)}
                          >
                            <title>{`${link.sourceRepoFullName} → ${link.targetRepoFullName}\n状态：${REPO_ABSORPTION_STATUS_LABELS[link.status]} · 强度 ${Math.round(link.strength * 100)}%${link.isCrossSector ? " · 跨领域 1 对 N" : ""}\n${link.rationale}`}</title>
                            <path d={d} className="re-svg-edge-hit" />
                            <path
                              d={d}
                              fill="none"
                              stroke={vis.stroke}
                              strokeWidth={isHot || isSelected ? vis.width + 1.35 : vis.width}
                              strokeDasharray={vis.dash}
                              markerEnd={`url(#${vis.markerId})`}
                              filter={isHot && haloTheme === "cosmic" ? "url(#re-glow-soft)" : undefined}
                            />
                            {showBadge && (
                              <g transform={`translate(${midX}, ${midY})`}>
                                <rect
                                  x={-badgeW / 2}
                                  y={-9}
                                  width={badgeW}
                                  height={18}
                                  rx={9}
                                  fill={isSelected ? vis.stroke : svgPalette.badgeBg}
                                  stroke={vis.stroke}
                                  strokeWidth={isHot || isSelected ? 1.5 : 1}
                                />
                                <text
                                  x={0}
                                  y={3.5}
                                  textAnchor="middle"
                                  fontSize={9.5}
                                  fontWeight={650}
                                  fontFamily="IBM Plex Mono, monospace"
                                  fill={isSelected ? "#ffffff" : svgPalette.textPrimary}
                                >
                                  {badgeText}
                                </text>
                              </g>
                            )}
                          </g>
                        );
                      })}
                    </g>

                    {/* ======== 4. 外围散落星云（游离散落 / 陈旧沉淀入口，不污染主环） ======== */}
                    {radialGraph?.floatingPool && radialGraph.floatingPool.totalCount > 0 && (() => {
                      const fp = radialGraph.floatingPool;
                      const fa = radialLayout.floatingAnchor;
                      const tetherStart = polar(fa.r - 86, fa.angle);
                      const isSelected = inspectorMode === "floating";
                      return (
                        <g
                          className="re-svg-node"
                          data-testid="radial-floating-nebula"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => setInspectorMode("floating")}
                        >
                          <title>游离散落 / 陈旧星云：点击展开散落抽屉或进入批量整理工作台</title>
                          <line
                            x1={tetherStart.x}
                            y1={tetherStart.y}
                            x2={fa.x}
                            y2={fa.y}
                            stroke={svgPalette.nebulaStroke}
                            strokeWidth={1.2}
                            strokeDasharray="4 4"
                            opacity={0.65}
                          />
                          <g transform={`translate(${fa.x}, ${fa.y})`}>
                            <rect
                              className="re-node-shell"
                              x={-98}
                              y={-34}
                              width={196}
                              height={68}
                              rx={34}
                              fill={svgPalette.nebulaFill}
                              stroke={isSelected ? svgPalette.cardSpotStroke : svgPalette.nebulaStroke}
                              strokeWidth={isSelected ? 2.2 : 1.5}
                              strokeDasharray="6 4"
                            />
                            <text x={0} y={-8} textAnchor="middle" fontSize={12} fontWeight={700} fill={svgPalette.nebulaText}>
                              ◌ 游离散落 / 陈旧星云
                            </text>
                            <text
                              x={0}
                              y={10}
                              textAnchor="middle"
                              fontSize={11}
                              fontFamily="IBM Plex Mono, monospace"
                              fill={svgPalette.nebulaSub}
                            >
                              {fp.totalCount} 仓 · 未归类 {fp.unclassifiedCount} · 陈旧 {fp.staleCount}
                            </text>
                            <text x={0} y={24} textAnchor="middle" fontSize={9.5} fill={svgPalette.textMuted}>
                              点击展开散落抽屉 / 进入整理工作台
                            </text>
                          </g>
                        </g>
                      );
                    })()}

                    {/* ======== 5. 第三层 · 我 Star 的库环（Ring 3） ======== */}
                    <g>
                      {radialLayout.starList.map((ps) => {
                        const star = ps.node;
                        const isSelected = inspectorMode === "node" && selectedNodeDetail?.node.id === star.id;
                        const isHot = haloHighlight.starIds.has(star.id) || isSelected;
                        const opacity = haloHighlight.active
                          ? isHot
                            ? 1
                            : haloHighlight.isHover
                              ? svgPalette.dimNodeOpacity
                              : svgPalette.dimSelectedOpacity
                          : 1;
                        const accent = resolveDomainAccent(star.primaryDomainColor, haloTheme);
                        const w = 148;
                        const h = 36;

                        return (
                          <g
                            key={star.id}
                            className="re-svg-node"
                            data-testid={`radial-star-${star.id}`}
                            transform={`translate(${ps.x}, ${ps.y})`}
                            style={{ opacity }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseEnter={() => setHoveredStarId(star.id)}
                            onMouseLeave={() => setHoveredStarId(null)}
                            onClick={() => void openNodeInspector(star.id)}
                          >
                            <title>{`${star.fullName}${star.isMultiTarget ? ` [1 对 ${star.targetOwnedIds.length} 多目标滋养]` : ""}\n★ ${formatStars(star.starsCount)} · ${star.primaryLanguage || "多语言"} · ${REPO_VITALITY_LABELS[star.vitality]}\n${star.description || ""}`}</title>
                            <rect
                              className="re-node-shell"
                              x={-w / 2}
                              y={-h / 2}
                              width={w}
                              height={h}
                              rx={18}
                              fill={isSelected ? svgPalette.cardSelectedFill : svgPalette.cardFill}
                              stroke={
                                isSelected
                                  ? accent
                                  : star.isMultiTarget
                                    ? svgPalette.cardSpotStroke
                                    : isHot && haloHighlight.active
                                      ? accent
                                      : svgPalette.cardStroke
                              }
                              strokeWidth={isSelected || (isHot && haloHighlight.active) ? 2 : star.isMultiTarget ? 1.5 : 1.05}
                              filter={star.isMultiTarget && haloTheme === "cosmic" ? "url(#re-glow-soft)" : undefined}
                            />
                            {/* 左侧星点 */}
                            <circle
                              cx={-w / 2 + 13}
                              cy={0}
                              r={star.isMultiTarget ? 5 : 4}
                              fill={star.isMultiTarget ? svgPalette.cardSpotStroke : accent}
                            />
                            <text
                              x={-w / 2 + 23}
                              y={-2}
                              fontSize={11}
                              fontWeight={650}
                              fill={svgPalette.textPrimary}
                            >
                              {truncateVisual(star.name, 16.5)}
                            </text>
                            <text
                              x={-w / 2 + 23}
                              y={11.5}
                              fontSize={9.5}
                              fontFamily="IBM Plex Mono, monospace"
                              fill={svgPalette.textSecondary}
                            >
                              ★ {formatStars(star.starsCount)}
                              {star.primaryLanguage ? ` · ${truncateVisual(star.primaryLanguage, 9)}` : ""}
                            </text>

                            {/* 1 对 N 多目标微光徽标（优雅栖于右上角） */}
                            {star.isMultiTarget && (
                              <g transform={`translate(${w / 2 - 12}, ${-h / 2})`}>
                                <rect
                                  x={-13}
                                  y={-8}
                                  width={26}
                                  height={16}
                                  rx={8}
                                  fill={haloTheme === "cosmic" ? "#f59e0b" : "#b9751d"}
                                />
                                <text
                                  x={0}
                                  y={3.5}
                                  textAnchor="middle"
                                  fontSize={9.5}
                                  fontWeight={750}
                                  fontFamily="IBM Plex Mono, monospace"
                                  fill="#ffffff"
                                >
                                  ×{star.targetOwnedIds.length}
                                </text>
                              </g>
                            )}
                          </g>
                        );
                      })}

                      {/* 第三层弧尾 `+N 更多` 节点 */}
                      {radialLayout.morePills.map((mp) => {
                        const opacity = haloHighlight.active
                          ? haloHighlight.ownedIds.has(mp.owned.id)
                            ? 1
                            : 0.22
                          : 0.92;
                        return (
                          <g
                            key={mp.id}
                            className="re-svg-node"
                            data-testid={`radial-more-${mp.owned.id}`}
                            transform={`translate(${mp.x}, ${mp.y})`}
                            style={{ opacity }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => void handleMoreStarsClick(mp)}
                          >
                            <title>{`继续展开「${mp.owned.name}」的其余 ${mp.moreCount} 个关联 Star 仓`}</title>
                            <rect
                              className="re-node-shell"
                              x={-54}
                              y={-15}
                              width={108}
                              height={30}
                              rx={15}
                              fill={svgPalette.badgeBg}
                              stroke={svgPalette.cardSpotStroke}
                              strokeWidth={1.3}
                              strokeDasharray="4 3"
                            />
                            <text
                              x={0}
                              y={4}
                              textAnchor="middle"
                              fontSize={10.5}
                              fontWeight={650}
                              fontFamily="IBM Plex Mono, monospace"
                              fill={haloTheme === "cosmic" ? "#fde68a" : "#7d4d0e"}
                            >
                              +{mp.moreCount} 更多 Star
                            </text>
                          </g>
                        );
                      })}
                    </g>

                    {/* ======== 6. 第二层 · 我的开源库环（Ring 2） ======== */}
                    <g>
                      {radialLayout.ownedList.map((po) => {
                        const repo = po.node;
                        const ps = radialLayout.sectorMap.get(po.sectorId);
                        const accent = resolveDomainAccent(ps?.sector.color ?? repo.primaryDomainColor, haloTheme);
                        const isSpot = repo.priorityTier === "spotlight";
                        const isPriv = repo.visibility === "private";
                        const isSelected = inspectorMode === "node" && selectedNodeDetail?.node.id === repo.id;
                        const isHot = haloHighlight.ownedIds.has(repo.id) || isSelected;
                        const opacity = haloHighlight.active
                          ? isHot
                            ? 1
                            : haloHighlight.isHover
                              ? svgPalette.dimNodeOpacity
                              : svgPalette.dimSelectedOpacity
                          : repo.isFork
                            ? 0.8
                            : 1;
                        const w = 162;
                        const h = 48;
                        const starTotal = Math.max(repo.totalStarCount, repo.linkedStarCount);

                        return (
                          <g
                            key={repo.id}
                            className="re-svg-node"
                            data-testid={`radial-owned-${repo.id}`}
                            transform={`translate(${po.x}, ${po.y})`}
                            style={{ opacity }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseEnter={() => setHoveredOwnedId(repo.id)}
                            onMouseLeave={() => setHoveredOwnedId(null)}
                            onClick={() => toggleOwnedExpand(repo, true)}
                          >
                            <title>{`${repo.fullName}${isSpot ? " [★ 重点关注]" : ""}${isPriv ? " [🔒 私有仓]" : ""}${repo.isFork ? " [⑂ Fork]" : ""}\n关联 Star：${starTotal}（点击展开/收起第三层 Star 环）${repo.profileSummary ? `\n画像：${repo.profileSummary}` : ""}`}</title>

                            {/* Spotlight 金色外光环 */}
                            {isSpot && (
                              <rect
                                x={-w / 2 - 4}
                                y={-h / 2 - 4}
                                width={w + 8}
                                height={h + 8}
                                rx={12}
                                fill="none"
                                stroke={svgPalette.cardSpotStroke}
                                strokeWidth={1.6}
                                opacity={0.62}
                                filter="url(#re-glow-gold)"
                              />
                            )}

                            <rect
                              className="re-node-shell"
                              x={-w / 2}
                              y={-h / 2}
                              width={w}
                              height={h}
                              rx={9}
                              fill={
                                isSelected
                                  ? svgPalette.cardSelectedFill
                                  : isSpot
                                    ? svgPalette.cardSpotFill
                                    : svgPalette.cardFill
                              }
                              stroke={
                                isSelected
                                  ? accent
                                  : isSpot
                                    ? svgPalette.cardSpotStroke
                                    : isPriv
                                      ? svgPalette.cardPrivStroke
                                      : isHot && haloHighlight.active
                                        ? accent
                                        : svgPalette.cardStroke
                              }
                              strokeWidth={isSelected || isSpot ? 2 : 1.25}
                              strokeDasharray={repo.isFork ? "5 3" : undefined}
                            />

                            {/* 左侧领域色条 */}
                            <rect
                              x={-w / 2}
                              y={-h / 2 + 6}
                              width={4}
                              height={h - 12}
                              rx={2}
                              fill={isSpot ? svgPalette.cardSpotStroke : accent}
                            />

                            {/* 仓名（顶部留宽，右上角胶囊栖于边框上不挤压仓名） */}
                            <text
                              x={-w / 2 + 12}
                              y={-2}
                              fontSize={12}
                              fontWeight={700}
                              fill={svgPalette.textPrimary}
                            >
                              {isSpot ? "★ " : ""}
                              {isPriv ? "🔒 " : ""}
                              {repo.isFork ? "⑂ " : ""}
                              {truncateVisual(repo.name, isSpot || isPriv ? 16 : 18.5)}
                            </text>

                            {/* 次行语言/状态 */}
                            <text
                              x={-w / 2 + 12}
                              y={14}
                              fontSize={10}
                              fill={svgPalette.textSecondary}
                            >
                              {repo.primaryLanguage || "多语言"}
                              {repo.inReviewCount > 0
                                ? ` · 待批 ${repo.inReviewCount}`
                                : repo.approvedCount > 0
                                  ? ` · 已批 ${repo.approvedCount}`
                                  : isPriv
                                    ? " · 私有"
                                    : " · 原创"}
                            </text>

                            {/* 右上角 Star 展开/收起胶囊 */}
                            {starTotal > 0 ? (
                              <g
                                transform={`translate(${w / 2 - 20}, ${-h / 2})`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleOwnedExpand(repo, false);
                                }}
                              >
                                <rect
                                  x={-22}
                                  y={-9}
                                  width={44}
                                  height={18}
                                  rx={9}
                                  fill={po.expandedL3 ? accent : svgPalette.badgeBg}
                                  stroke={accent}
                                  strokeWidth={1.25}
                                />
                                <text
                                  x={0}
                                  y={3.5}
                                  textAnchor="middle"
                                  fontSize={9.5}
                                  fontWeight={700}
                                  fontFamily="IBM Plex Mono, monospace"
                                  fill={po.expandedL3 ? "#ffffff" : svgPalette.textPrimary}
                                >
                                  {po.expandedL3 ? `−${po.shownStarCount}★` : `+${starTotal}★`}
                                </text>
                              </g>
                            ) : (
                              <text
                                x={w / 2 - 10}
                                y={14}
                                textAnchor="end"
                                fontSize={9.5}
                                fontFamily="IBM Plex Mono, monospace"
                                fill={svgPalette.textMuted}
                              >
                                0★
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </g>

                    {/* ======== 7. 第一层 · 中心环分散领域（Ring 1） ======== */}
                    <g>
                      {radialLayout.sectors.map((ps) => {
                        const sec = ps.sector;
                        const accent = resolveDomainAccent(sec.color, haloTheme);
                        const isSelected = inspectorMode === "domain" && selectedDomainId === sec.id;
                        const isHot = haloHighlight.domainIds.has(sec.id) || isSelected;
                        const opacity = haloHighlight.active
                          ? isHot
                            ? 1
                            : haloHighlight.isHover
                              ? svgPalette.dimNodeOpacity + 0.08
                              : svgPalette.dimSelectedOpacity + 0.1
                          : 1;
                        const w = 178;
                        const h = 60;

                        return (
                          <g
                            key={sec.id}
                            className="re-svg-node"
                            data-testid={`radial-domain-${sec.id}`}
                            transform={`translate(${ps.x}, ${ps.y})`}
                            style={{ opacity }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseEnter={() => setHoveredDomainId(sec.id)}
                            onMouseLeave={() => setHoveredDomainId(null)}
                            onClick={() => toggleDomainExpand(sec.id, true)}
                          >
                            <title>{`${sec.name}（点击展开/收起第二层自有库并查看领域详情）\n自有仓：${sec.ownedCount} · 关联 Star：${sec.linkedStarCount} · 领域总 Star：${sec.domainStarCount}\n${sec.description || ""}`}</title>

                            {/* 展开态柔和外光圈 */}
                            {(ps.expandedL2 || isHot) && (
                              <rect
                                x={-w / 2 - 4}
                                y={-h / 2 - 4}
                                width={w + 8}
                                height={h + 8}
                                rx={34}
                                fill="none"
                                stroke={accent}
                                strokeWidth={1.5}
                                opacity={isHot ? 0.8 : 0.42}
                                filter={haloTheme === "cosmic" ? "url(#re-glow-soft)" : undefined}
                              />
                            )}

                            <rect
                              className="re-node-shell"
                              x={-w / 2}
                              y={-h / 2}
                              width={w}
                              height={h}
                              rx={30}
                              fill={isSelected ? svgPalette.cardSelectedFill : svgPalette.cardFill}
                              stroke={ps.expandedL2 || isSelected || isHot ? accent : svgPalette.cardStroke}
                              strokeWidth={ps.expandedL2 || isSelected ? 2.1 : 1.4}
                              strokeDasharray={sec.isSynthetic ? "5 4" : undefined}
                            />

                            {/* 左侧领域色环与符号 */}
                            <circle
                              cx={-w / 2 + 26}
                              cy={0}
                              r={15.5}
                              fill={accent}
                              fillOpacity={haloTheme === "cosmic" ? 0.22 : 0.14}
                              stroke={accent}
                              strokeWidth={1.6}
                            />
                            <text
                              x={-w / 2 + 26}
                              y={5}
                              textAnchor="middle"
                              fontSize={13.5}
                            >
                              {formatDomainIcon(sec.icon)}
                            </text>

                            {/* 领域中文名与实时计数 */}
                            <text
                              x={-w / 2 + 48}
                              y={-5}
                              fontSize={12}
                              fontWeight={700}
                              fill={svgPalette.textPrimary}
                            >
                              {truncateVisual(sec.name, 14.5)}
                            </text>
                            <text
                              x={-w / 2 + 48}
                              y={12}
                              fontSize={10}
                              fontFamily="IBM Plex Mono, monospace"
                              fill={svgPalette.textSecondary}
                            >
                              自有 {sec.ownedCount} · Star {sec.linkedStarCount}
                            </text>

                            {/* 右侧 + / − 展开态圆钮 */}
                            {sec.ownedCount > 0 && (
                              <g
                                transform={`translate(${w / 2 - 17}, 0)`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleDomainExpand(sec.id, false);
                                }}
                              >
                                <circle
                                  r={10.5}
                                  fill={ps.expandedL2 ? accent : svgPalette.badgeBg}
                                  stroke={accent}
                                  strokeWidth={1.3}
                                />
                                <text
                                  x={0}
                                  y={4}
                                  textAnchor="middle"
                                  fontSize={13}
                                  fontWeight={700}
                                  fill={ps.expandedL2 ? "#ffffff" : accent}
                                >
                                  {ps.expandedL2 ? "−" : "+"}
                                </text>
                              </g>
                            )}

                            {/* Spotlight 标识角标 */}
                            {sec.hasSpotlight && (
                              <g transform={`translate(${-w / 2 + 11}, ${-h / 2 + 6})`}>
                                <circle r={8} fill={svgPalette.cardSpotStroke} />
                                <text x={0} y={3.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#111827">
                                  ★
                                </text>
                              </g>
                            )}
                          </g>
                        );
                      })}
                    </g>

                    {/* ======== 8. 中心核（Center Core, r = 0） ======== */}
                    <g
                      className="re-svg-node"
                      data-testid="radial-center-core"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setInspectorMode("none");
                        setSelectedDomainId(null);
                        fitView();
                      }}
                    >
                      <title>开源演进中枢 · 点击清除选中并居中适配光环视图</title>
                      <circle
                        className="re-core-pulse-ring"
                        cx={0}
                        cy={0}
                        r={CORE_RADIUS + 11}
                        fill="none"
                        stroke={svgPalette.coreStroke}
                        strokeWidth={1.3}
                        strokeDasharray="6 5"
                      />
                      <circle
                        cx={0}
                        cy={0}
                        r={CORE_RADIUS}
                        fill={svgPalette.coreFill}
                        stroke={svgPalette.coreStroke}
                        strokeWidth={2.4}
                        filter={haloTheme === "cosmic" ? "url(#re-glow-soft)" : undefined}
                      />
                      <circle
                        cx={0}
                        cy={0}
                        r={CORE_RADIUS - 8}
                        fill="none"
                        stroke={svgPalette.coreStroke}
                        strokeWidth={0.8}
                        opacity={0.38}
                      />
                      <text
                        x={0}
                        y={-24}
                        textAnchor="middle"
                        fontSize={9.5}
                        fontWeight={650}
                        letterSpacing="0.18em"
                        fontFamily="IBM Plex Mono, monospace"
                        fill={svgPalette.coreMeta}
                      >
                        OPC OS HALO
                      </text>
                      <text
                        x={0}
                        y={-3}
                        textAnchor="middle"
                        fontSize={14.5}
                        fontWeight={750}
                        fill={svgPalette.coreTitle}
                      >
                        开源演进中枢
                      </text>
                      <text
                        x={0}
                        y={16}
                        textAnchor="middle"
                        fontSize={10.5}
                        fontFamily="IBM Plex Mono, monospace"
                        fill={svgPalette.coreSub}
                      >
                        {rStats?.domainCount ?? radialDomains.length} 领域 · {rStats?.ownedOriginalCount ?? radialGraph?.ownedNodes.length ?? 0} 自有
                      </text>
                      <text
                        x={0}
                        y={32}
                        textAnchor="middle"
                        fontSize={10.5}
                        fontWeight={650}
                        fontFamily="IBM Plex Mono, monospace"
                        fill={svgPalette.coreMeta}
                      >
                        {rStats?.linkedStarCount ?? 0} 关联 Star
                      </text>
                    </g>
                  </g>
                </svg>
              )}

              {/* 左下状态图例 */}
              <div className="re-legend-dock" aria-label="同心光环图例">
                <span className="re-legend-item">
                  <i className="re-legend-line suggested" /> AI 建议
                </span>
                <span className="re-legend-item">
                  <i className="re-legend-line in_review" /> 信箱待批
                </span>
                <span className="re-legend-item">
                  <i className="re-legend-line approved" /> 已批/吸收
                </span>
                <span className="re-legend-item">
                  <i className="re-legend-line watching" /> 暂存观察
                </span>
                <span className="re-legend-item">
                  <i className="re-legend-dot" style={{ background: "#f5b942" }} /> ★ Spotlight / ×N 跨库 Star
                </span>
              </div>

              {/* 右下缩放与居中适配控制条 */}
              <div className="re-zoom-dock" onPointerDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="re-mini"
                  aria-label="缩小图谱"
                  onClick={() => zoomByStep(0.84)}
                >
                  −
                </button>
                <span className="re-zoom-readout">{Math.round(viewport.zoom * 100)}%</span>
                <button
                  type="button"
                  className="re-mini"
                  aria-label="放大图谱"
                  onClick={() => zoomByStep(1.19)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="re-mini"
                  data-testid="radial-fit-view"
                  onClick={fitView}
                  title="居中适配光环至当前可视区域"
                >
                  居中适配
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ================= 视图 2：领域整理与散落池工作台 ================= */}
        {activeTab === "domains" && (
          <div className="re-pool-layout">
            <aside className="re-pool-rail" aria-label="领域与散落池导航">
              <div className="re-rail-section">
                <div className="re-rail-head">
                  <h3>快捷池与重点视图</h3>
                </div>
                {POOL_BUCKET_ITEMS.map((item) => {
                  const count = item.statKey && mStats ? mStats[item.statKey] : null;
                  const active = poolBucket === item.id && !poolDomainId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="re-rail-btn"
                      aria-pressed={active}
                      onClick={() => {
                        setPoolBucket(item.id);
                        setPoolDomainId("");
                        setPoolPage(1);
                        setCheckedNodeIds(new Set());
                      }}
                    >
                      <span>{item.label}</span>
                      {count !== null && <span className="re-rail-count">{count}</span>}
                    </button>
                  );
                })}
              </div>

              <div className="re-rail-section">
                <div className="re-rail-head">
                  <h3>领域分组 ({domainClusters.length || radialDomains.length})</h3>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      className="re-mini"
                      onClick={() =>
                        setDomainModal({
                          mode: "create",
                          name: "",
                          description: "",
                          color: DOMAIN_COLORS[radialDomains.length % DOMAIN_COLORS.length],
                          icon: "◈",
                          seedKeywords: "",
                        })
                      }
                    >
                      + 新建
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={busyAction === "import-lists"}
                      onClick={() => void handleImportGithubLists()}
                      title="导入 GitHub Star Lists 为领域"
                    >
                      {busyAction === "import-lists" ? "导入…" : "导入 Lists"}
                    </button>
                  </div>
                </div>

                {domainClusters.map((domain) => {
                  const active = poolDomainId === domain.id;
                  return (
                    <div key={domain.id} className="re-domain-row">
                      <button
                        type="button"
                        className="re-rail-btn"
                        aria-pressed={active}
                        onClick={() => {
                          setPoolDomainId(domain.id);
                          setPoolBucket("all");
                          setPoolPage(1);
                          setCheckedNodeIds(new Set());
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span className="re-domain-dot" style={{ background: domain.color || "#2b4e3c" }} />
                          <span className="re-domain-name-text" title={domain.description || domain.name}>
                            {domain.name}
                          </span>
                        </span>
                        <span className="re-rail-count">{domain.totalNodes}</span>
                      </button>
                      <button
                        type="button"
                        className="re-ghost re-mini"
                        title="在同心光环中定位此领域"
                        aria-label={`在光环中定位领域 ${domain.name}`}
                        onClick={() => locateDomainInRadial(domain.id, true)}
                      >
                        ◎
                      </button>
                      <button
                        type="button"
                        className="re-ghost re-mini"
                        title="编辑领域"
                        aria-label={`编辑领域 ${domain.name}`}
                        onClick={() =>
                          setDomainModal({
                            mode: "edit",
                            domain,
                            name: domain.name,
                            description: domain.description,
                            color: domain.color,
                            icon: domain.icon,
                            seedKeywords: domain.seedKeywords.join(", "),
                          })
                        }
                      >
                        ✎
                      </button>
                      {domainClusters.length > 1 && (
                        <button
                          type="button"
                          className="re-ghost re-mini"
                          title="合并到其他领域"
                          aria-label={`合并领域 ${domain.name}`}
                          onClick={() => {
                            const other = domainClusters.find((d) => d.id !== domain.id);
                            setMergeModal({
                              sourceDomainId: domain.id,
                              targetDomainId: other?.id ?? "",
                            });
                          }}
                        >
                          ⇄
                        </button>
                      )}
                      {domain.source !== "builtin" && (
                        <button
                          type="button"
                          className="re-ghost re-mini"
                          title="删除领域"
                          aria-label={`删除领域 ${domain.name}`}
                          onClick={() => void handleDeleteDomain(domain)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </aside>

            <div className="re-pool-main">
              <div className="re-pool-filters">
                <input
                  type="search"
                  value={poolQuery}
                  onChange={(e) => setPoolQuery(e.target.value)}
                  placeholder="搜索仓库名、描述、Topic…"
                  aria-label="搜索仓库"
                />
                <select
                  aria-label="活性筛选"
                  value={poolVitality}
                  onChange={(e) => {
                    setPoolVitality(e.target.value as RepoVitality | "all");
                    setPoolPage(1);
                  }}
                >
                  <option value="all">全部活性</option>
                  <option value="active">活跃 ({nodesPage?.facets.vitalityCounts.active ?? 0})</option>
                  <option value="dormant">静默 ({nodesPage?.facets.vitalityCounts.dormant ?? 0})</option>
                  <option value="stale">陈旧 ({nodesPage?.facets.vitalityCounts.stale ?? 0})</option>
                  <option value="archived">已归档 ({nodesPage?.facets.vitalityCounts.archived ?? 0})</option>
                </select>
                <select
                  aria-label="语言筛选"
                  value={poolLanguage}
                  onChange={(e) => {
                    setPoolLanguage(e.target.value);
                    setPoolPage(1);
                  }}
                >
                  <option value="">全部语言</option>
                  {(nodesPage?.facets.languages ?? []).slice(0, 30).map((l) => (
                    <option key={l.name} value={l.name}>
                      {l.name} ({l.count})
                    </option>
                  ))}
                </select>
                <select
                  aria-label="可见性筛选"
                  value={poolVisibility}
                  onChange={(e) => {
                    setPoolVisibility(e.target.value as RepoVisibility | "all");
                    setPoolPage(1);
                  }}
                >
                  <option value="all">全部可见性</option>
                  <option value="public">公开</option>
                  <option value="private">🔒 私有</option>
                </select>
                <select
                  aria-label="排序方式"
                  value={poolSortBy}
                  onChange={(e) => {
                    setPoolSortBy(e.target.value as RepoNodeSortBy);
                    setPoolPage(1);
                  }}
                >
                  <option value="starred_at">按 Star 时间</option>
                  <option value="pushed_at">按最近推送</option>
                  <option value="stars">按 Star 数量</option>
                  <option value="priority">按重点优先级</option>
                  <option value="name">按仓库名</option>
                </select>
              </div>

              {checkedNodeIds.size > 0 && (
                <div className="re-batch-bar" role="region" aria-label="批量操作仓库">
                  <span>已选中 <strong>{checkedNodeIds.size}</strong> 个仓库</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <select
                      aria-label="选择目标领域"
                      value={batchTargetDomainId}
                      onChange={(e) => setBatchTargetDomainId(e.target.value)}
                    >
                      <option value="">选择目标领域…</option>
                      {radialDomains.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="re-primary re-mini"
                      disabled={!batchTargetDomainId || Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("assign_domain", batchTargetDomainId)}
                    >
                      批量改领域
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("clear_domain")}
                    >
                      移回未归类
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("archive_stale")}
                    >
                      批量标陈旧归档
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("restore_standard")}
                    >
                      打捞恢复
                    </button>
                    <button
                      type="button"
                      className="re-mini"
                      disabled={Boolean(busyAction)}
                      onClick={() => void handleBatchNodes("set_spotlight")}
                    >
                      设为重点关注
                    </button>
                    <button type="button" className="re-mini" onClick={() => setCheckedNodeIds(new Set())}>
                      取消
                    </button>
                  </div>
                </div>
              )}

              <div className="re-table-scroll">
                <table className="re-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label="全选当前页"
                          checked={allPoolChecked}
                          onChange={toggleAllPool}
                        />
                      </th>
                      <th>仓库</th>
                      <th>所属领域</th>
                      <th>活性 / Star / 推送</th>
                      <th>吸收关联</th>
                      <th>快捷操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poolLoading && !nodesPage ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: 28, color: "#656b64" }}>
                          正在加载仓库数据…
                        </td>
                      </tr>
                    ) : !nodesPage || nodesPage.items.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: 32, color: "#656b64" }}>
                          当前池子或筛选条件下暂无仓库。
                        </td>
                      </tr>
                    ) : (
                      nodesPage.items.map((node) => {
                        const checked = checkedNodeIds.has(node.id);
                        return (
                          <tr key={node.id} data-selected={checked ? "true" : "false"}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`勾选 ${node.fullName}`}
                                checked={checked}
                                onChange={() => {
                                  setCheckedNodeIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(node.id)) next.delete(node.id);
                                    else next.add(node.id);
                                    return next;
                                  });
                                }}
                              />
                            </td>
                            <td>
                              <div className="re-repo-cell">
                                <div className="re-repo-cell-head">
                                  <button
                                    type="button"
                                    className="re-repo-name-btn"
                                    onClick={() => void openNodeInspector(node.id)}
                                  >
                                    {node.fullName}
                                  </button>
                                  {node.priorityTier === "spotlight" && <span className="re-pill spotlight">★ 重点</span>}
                                  {node.visibility === "private" && <span className="re-pill private">🔒 私有</span>}
                                  {node.isFork && <span className="re-pill fork">⑂ Fork</span>}
                                  {(node.role === "owned" || node.role === "both") && <span className="re-pill active">自有</span>}
                                  {node.primaryLanguage && <span className="re-pill">{node.primaryLanguage}</span>}
                                </div>
                                {node.description && <div className="re-repo-desc">{node.description}</div>}
                              </div>
                            </td>
                            <td>
                              {node.primaryDomainName ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  <span className="re-pill">
                                    <span className="re-domain-dot" style={{ background: node.primaryDomainColor || "#2b4e3c" }} />
                                    {node.primaryDomainName}
                                  </span>
                                  <small style={{ color: "#6f756e", fontSize: 11 }}>
                                    {node.domainAssignedBy === "ai"
                                      ? `AI 推荐${node.domainConfidence ? ` (${Math.round(node.domainConfidence * 100)}%)` : ""}`
                                      : node.domainAssignedBy === "github_list"
                                        ? "GitHub List"
                                        : "手动指定"}
                                  </small>
                                </div>
                              ) : (
                                <span className="re-pill stale">未归类</span>
                              )}
                            </td>
                            <td>
                              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                <span className={`re-pill ${node.vitality}`}>{REPO_VITALITY_LABELS[node.vitality]}</span>
                                <span className="re-mono" style={{ color: "#585f57" }}>
                                  ★ {formatStars(node.starsCount)} · 推 {formatDateShort(node.pushedAt)}
                                </span>
                              </div>
                            </td>
                            <td>
                              <span className={node.linkCount > 0 ? "re-pill active" : "re-pill"}>
                                {node.linkCount > 0 ? `已连 ${node.linkCount} 边` : "未连线"}
                              </span>
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                                {node.role !== "owned" && (
                                  <button
                                    type="button"
                                    className="re-mini re-primary"
                                    onClick={() => void openQuickLinkModal(node)}
                                  >
                                    1 对 N 关联
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="re-mini"
                                  onClick={() => void locateNodeInRadial(node)}
                                >
                                  在图谱中定位
                                </button>
                                <button
                                  type="button"
                                  className="re-mini"
                                  onClick={() => void openNodeInspector(node.id)}
                                >
                                  详情
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="re-pager">
                <span>
                  共 <strong>{nodesPage?.total ?? 0}</strong> 条 · 第 {nodesPage?.page ?? 1} / {Math.max(1, nodesPage?.totalPages ?? 1)} 页
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <select
                    aria-label="每页条数"
                    value={poolPageSize}
                    onChange={(e) => {
                      setPoolPageSize(Number(e.target.value));
                      setPoolPage(1);
                    }}
                  >
                    <option value={25}>25 条/页</option>
                    <option value={50}>50 条/页</option>
                    <option value={100}>100 条/页</option>
                  </select>
                  <button
                    type="button"
                    className="re-mini"
                    disabled={!nodesPage || nodesPage.page <= 1 || poolLoading}
                    onClick={() => setPoolPage((p) => Math.max(1, p - 1))}
                  >
                    ← 上一页
                  </button>
                  <button
                    type="button"
                    className="re-mini"
                    disabled={!nodesPage || nodesPage.page >= nodesPage.totalPages || poolLoading}
                    onClick={() => setPoolPage((p) => p + 1)}
                  >
                    下一页 →
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================= 视图 3：进化时间线 ================= */}
        {activeTab === "timeline" && (
          <div className="re-timeline-wrap">
            <div className="re-timeline-bar">
              <div className="re-stage-pipeline" aria-label="吸收进化标准链路">
                <span className="re-stage-step">1. 发现关联</span>
                <span>→</span>
                <span className="re-stage-step">2. 模块分析</span>
                <span>→</span>
                <span className="re-stage-step">3. 发总裁信箱</span>
                <span>→</span>
                <span className="re-stage-step">4. 创始人批示（批准 / 暂缓 / 驳回）</span>
                <span>→</span>
                <span className="re-stage-step">5. 吸收落地</span>
              </div>

              <div className="re-actions-group">
                <button
                  type="button"
                  className={!timelineTargetId && !timelineRepoName ? "re-active re-mini" : "re-mini"}
                  onClick={() => {
                    setTimelineTargetId("");
                    setTimelineRepoName("");
                  }}
                >
                  全局时间线
                </button>
                {spotlightOwned.map((repo) => {
                  const active = timelineTargetId === repo.id || timelineRepoName === repo.name || timelineRepoName === repo.fullName;
                  return (
                    <button
                      key={repo.id}
                      type="button"
                      className={active ? "re-active re-mini" : "re-mini re-spotlight-chip"}
                      onClick={() => {
                        setTimelineTargetId(repo.id);
                        setTimelineRepoName("");
                      }}
                    >
                      ★ {repo.name}
                    </button>
                  );
                })}
                {spotlightOwned.length === 0 && (
                  <button
                    type="button"
                    className={timelineRepoName === "ai-agent-node" ? "re-active re-mini" : "re-mini re-spotlight-chip"}
                    onClick={() => {
                      setTimelineTargetId("");
                      setTimelineRepoName("ai-agent-node");
                    }}
                  >
                    ★ ai-agent-node
                  </button>
                )}

                <select
                  aria-label="按我的开源库筛选"
                  value={timelineTargetId}
                  onChange={(e) => {
                    setTimelineTargetId(e.target.value);
                    setTimelineRepoName("");
                  }}
                >
                  <option value="">指定我的开源库（全部）</option>
                  {allOwnedForCheckboxes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.priorityTier === "spotlight" ? "★ " : ""}
                      {r.visibility === "private" ? "🔒 " : ""}
                      {r.fullName}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="按领域筛选时间线"
                  value={timelineDomainId}
                  onChange={(e) => setTimelineDomainId(e.target.value)}
                >
                  <option value="">全部领域</option>
                  {radialDomains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="按事件类型筛选"
                  value={timelineEventType}
                  onChange={(e) => setTimelineEventType(e.target.value as RepoEvolutionEventType | "all")}
                >
                  <option value="all">全部事件类型</option>
                  {EVENT_KEYS.map((et) => (
                    <option key={et} value={et}>
                      {REPO_EVOLUTION_EVENT_LABELS[et]}
                    </option>
                  ))}
                </select>

                <button type="button" className="re-mini" disabled={timelineLoading} onClick={() => void loadTimeline(false)}>
                  刷新
                </button>
              </div>
            </div>

            <div className="re-timeline-scroll">
              <div className="re-timeline-container">
                {timelineLoading && !timelinePage ? (
                  <p role="status" style={{ color: "#656b64", textAlign: "center", padding: 32 }}>
                    正在读取进化时间线…
                  </p>
                ) : timelineGroups.length === 0 ? (
                  <div className="re-empty-card" style={{ margin: "24px auto" }}>
                    <h3>暂无匹配的进化记录</h3>
                    <p>
                      当你执行同步、AI 精准聚类召回、模块级深度分析、提交总裁信箱或完成审批批示后，完整演变轨迹会自动沉淀在这里。
                    </p>
                  </div>
                ) : (
                  timelineGroups.map(([day, events]) => (
                    <section key={day} className="re-timeline-day">
                      <div className="re-timeline-day-label">
                        {day} · {events.length} 条记录
                      </div>
                      <ol className="re-timeline-list">
                        {events.map((ev) => (
                          <li key={ev.id} className="re-timeline-item">
                            <span className="re-timeline-dot" data-type={ev.eventType} aria-hidden="true" />
                            <div className="re-timeline-head">
                              <div className="re-badge-row">
                                <span className="re-pill">
                                  {REPO_EVOLUTION_EVENT_LABELS[ev.eventType] ?? ev.eventType}
                                </span>
                                {ev.domainName && <span className="re-pill">{ev.domainName}</span>}
                                <span style={{ fontSize: 11.5, color: "#666d66" }}>操作者：{ev.actor}</span>
                              </div>
                              <time className="re-mono" style={{ color: "#676d66" }}>
                                {formatTimeFull(ev.createdAt)}
                              </time>
                            </div>
                            <div className="re-timeline-title">{ev.title}</div>
                            {ev.summary && <div className="re-timeline-summary">{ev.summary}</div>}
                            <div className="re-timeline-foot">
                              <div className="re-badge-row">
                                {ev.sourceRepoFullName && ev.targetRepoFullName ? (
                                  <span className="re-mono" style={{ color: "#2b4e3c", fontWeight: 600 }}>
                                    {ev.sourceRepoFullName} → {ev.targetRepoFullName}
                                  </span>
                                ) : ev.targetRepoFullName || ev.sourceRepoFullName ? (
                                  <span className="re-mono" style={{ color: "#4c544d" }}>
                                    {ev.targetRepoFullName || ev.sourceRepoFullName}
                                  </span>
                                ) : null}
                              </div>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                {ev.linkId && (
                                  <button
                                    type="button"
                                    className="re-mini re-primary"
                                    onClick={() => void locateLinkInRadial(ev.linkId!)}
                                  >
                                    在光环中定位该边 →
                                  </button>
                                )}
                                {ev.decisionPacketId && (
                                  <a
                                    className="re-link-btn"
                                    style={{ padding: "2px 8px", fontSize: 11.5 }}
                                    href={`#mailbox?decision=${encodeURIComponent(ev.decisionPacketId)}`}
                                  >
                                    查看总裁信箱审批 ↗
                                  </a>
                                )}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))
                )}

                {timelinePage && timelinePage.items.length < timelinePage.total && (
                  <div style={{ textAlign: "center" }}>
                    <button type="button" disabled={timelineLoading} onClick={() => void loadTimeline(true)}>
                      {timelineLoading ? "加载中…" : `加载更多（已显示 ${timelinePage.items.length} / ${timelinePage.total}）`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================= 视图 4：架构原语台（第一性原理沉淀） ================= */}
        {activeTab === "architecture" && (
          <ArchitectureStudioTab
            radialGraph={radialGraph}
            domains={radialDomains}
            allOwnedForCheckboxes={allOwnedForCheckboxes}
            initialPrimitiveId={deepLinkPrimitiveId}
            onPrimitiveCountChange={setPrimitiveCount}
            onOpenNodeCodeMap={(nodeId) => void openNodeInspector(nodeId)}
            onLocateNode={(nodeId) => void locateNodeInRadial(nodeId)}
            onNotice={(n) => setNotice(n)}
            onError={(msg) => setError(msg)}
          />
        )}

        {/* ================= 右侧 Inspector 抽屉（领域态 / 节点态 / 连线态 / 散落星云态） ================= */}
        {inspectorMode !== "none" && (
          <aside className="re-inspector" aria-label="详情与深度分析抽屉" data-testid="repo-evolution-inspector">
            <div className="re-inspector-head">
              <div className="re-inspector-title">
                <span style={{ fontSize: 11, color: "#656c64", letterSpacing: "0.05em" }}>
                  {inspectorMode === "domain"
                    ? "第一层领域 · 扇区检视器"
                    : inspectorMode === "node"
                      ? "仓库节点检视器 · 零克隆 Code Map"
                      : inspectorMode === "floating"
                        ? "外围星云 · 游离散落池"
                        : "吸收边 · 零克隆源码级吸收研究"}
                </span>
                <h2>
                  {inspectorMode === "domain"
                    ? selectedDomainObj
                      ? `${formatDomainIcon(selectedDomainObj.icon)} ${selectedDomainObj.name}`
                      : "领域详情"
                    : inspectorMode === "floating"
                      ? "◌ 游离散落 / 陈旧星云"
                      : inspectorMode === "node"
                        ? selectedNodeDetail?.node.fullName || "读取中…"
                        : selectedLink
                          ? `${selectedLink.sourceRepoFullName} → ${selectedLink.targetRepoFullName}`
                          : "读取中…"}
                </h2>
              </div>
              <button
                type="button"
                className="re-ghost re-mini"
                aria-label="关闭检视抽屉"
                onClick={() => {
                  setInspectorMode("none");
                  setSelectedDomainId(null);
                }}
              >
                ✕
              </button>
            </div>

            <div className="re-inspector-body">
              {inspectorLoading && inspectorMode !== "domain" && inspectorMode !== "floating" && !selectedNodeDetail && !selectedLink && (
                <p role="status" style={{ color: "#636a63", fontSize: 12.5 }}>正在加载详情…</p>
              )}

              {/* ---- 领域态 Inspector ---- */}
              {inspectorMode === "domain" && selectedDomainObj && (() => {
                const isExpL2 = expandedDomainIds.has(selectedDomainObj.id);
                const domainOwned = (radialGraph?.ownedNodes ?? []).filter(
                  (o) => o.primaryDomainId === selectedDomainObj.id,
                );
                const domainOwnedIds = new Set(domainOwned.map((o) => o.id));
                const anyL3Open = domainOwned.some((o) => expandedOwnedIds.has(o.id));
                const domainStars = (radialGraph?.starNodes ?? []).filter(
                  (s) =>
                    s.primaryDomainId === selectedDomainObj.id ||
                    s.targetOwnedIds.some((tid) => domainOwnedIds.has(tid)),
                );

                return (
                  <>
                    <div className="re-section-box">
                      <div className="re-badge-row">
                        <span className="re-pill">
                          <span className="re-domain-dot" style={{ background: selectedDomainObj.color }} />
                          {selectedDomainObj.slug}
                        </span>
                        <span className="re-pill">
                          {selectedDomainObj.source === "builtin"
                            ? "校准核心领域"
                            : selectedDomainObj.source === "github_list"
                              ? "GitHub List"
                              : "自定义领域"}
                        </span>
                        {selectedDomainObj.hasSpotlight && <span className="re-pill spotlight">★ 含重点关注仓</span>}
                      </div>

                      {selectedDomainObj.description && (
                        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#363e37" }}>
                          {selectedDomainObj.description}
                        </p>
                      )}

                      <div className="re-domain-stat-grid">
                        <div className="re-domain-stat-cell">
                          <span>第二层自有库（原创/全部）</span>
                          <strong>
                            {selectedDomainObj.ownedOriginalCount} / {selectedDomainObj.ownedCount}
                          </strong>
                        </div>
                        <div className="re-domain-stat-cell">
                          <span>第三层已关联 Star</span>
                          <strong>{selectedDomainObj.linkedStarCount}</strong>
                        </div>
                        <div className="re-domain-stat-cell">
                          <span>领域总 Star 仓</span>
                          <strong>{selectedDomainObj.domainStarCount}</strong>
                        </div>
                        <div className="re-domain-stat-cell">
                          <span>待批 / 已批吸收边</span>
                          <strong>
                            {selectedDomainObj.pendingReviewCount} / {selectedDomainObj.approvedCount}
                          </strong>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 2 }}>
                        <button
                          type="button"
                          className="re-mini re-primary"
                          onClick={() => toggleDomainExpand(selectedDomainObj.id, false)}
                        >
                          {isExpL2 ? "收起本领域 L2" : "展开本领域 L2"}
                        </button>
                        <button
                          type="button"
                          className="re-mini"
                          disabled={domainOwned.length === 0}
                          onClick={() => {
                            setExpandedDomainIds((prev) => new Set([...prev, selectedDomainObj.id]));
                            setExpandedOwnedIds((prev) => {
                              const next = new Set(prev);
                              for (const o of domainOwned) {
                                if (anyL3Open) next.delete(o.id);
                                else if (o.linkedStarCount > 0 || o.totalStarCount > 0) next.add(o.id);
                              }
                              return next;
                            });
                            pendingFocusTargetRef.current = { kind: "fit" };
                          }}
                        >
                          {anyL3Open ? "收起本领域 L3 Star" : "展开本领域全部 L3 Star"}
                        </button>
                        <button
                          type="button"
                          className="re-mini"
                          onClick={() => {
                            setDomainEditOpen((v) => !v);
                            setDomainEditName(selectedDomainObj.name);
                            setDomainEditIcon(selectedDomainObj.icon || "◈");
                            setDomainEditDesc(selectedDomainObj.description || "");
                            setDomainEditColor(selectedDomainObj.color || "#2b4e3c");
                            setDomainEditKeywords(selectedDomainObj.seedKeywords.join(", "));
                          }}
                        >
                          {domainEditOpen ? "收起编辑" : "✎ 编辑领域"}
                        </button>
                        <button
                          type="button"
                          className="re-mini"
                          onClick={() => {
                            setActiveTab("domains");
                            setPoolDomainId(selectedDomainObj.id);
                            setPoolBucket("all");
                            setPoolPage(1);
                          }}
                        >
                          表格查看全量 →
                        </button>
                      </div>
                    </div>

                    {/* 内联编辑领域表单 */}
                    {domainEditOpen && (
                      <form className="re-section-box" onSubmit={(e) => void handleSaveInlineDomain(e)}>
                        <h3>编辑领域定义与关键词</h3>
                        <div className="re-form-grid">
                          <label className="re-field">
                            <span>领域名称</span>
                            <input
                              type="text"
                              required
                              value={domainEditName}
                              onChange={(e) => setDomainEditName(e.target.value)}
                            />
                          </label>
                          <label className="re-field">
                            <span>图标符号</span>
                            <input
                              type="text"
                              maxLength={12}
                              value={domainEditIcon}
                              onChange={(e) => setDomainEditIcon(e.target.value)}
                            />
                          </label>
                        </div>
                        <label className="re-field">
                          <span>领域描述</span>
                          <textarea
                            rows={2}
                            value={domainEditDesc}
                            onChange={(e) => setDomainEditDesc(e.target.value)}
                          />
                        </label>
                        <label className="re-field">
                          <span>种子特征词（逗号分隔）</span>
                          <input
                            type="text"
                            value={domainEditKeywords}
                            onChange={(e) => setDomainEditKeywords(e.target.value)}
                          />
                        </label>
                        <div className="re-field">
                          <span>领域色标</span>
                          <div className="re-swatch-row">
                            {DOMAIN_COLORS.map((c) => (
                              <button
                                key={c}
                                type="button"
                                className="re-swatch"
                                style={{ background: c }}
                                data-current={domainEditColor === c ? "true" : "false"}
                                aria-label={`选择色标 ${c}`}
                                onClick={() => setDomainEditColor(c)}
                              />
                            ))}
                          </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                          <button type="button" className="re-mini" onClick={() => setDomainEditOpen(false)}>
                            取消
                          </button>
                          <button type="submit" className="re-mini re-primary" disabled={Boolean(busyAction)}>
                            {busyAction === "domain-inline-save" ? "保存中…" : "保存领域修改"}
                          </button>
                        </div>
                      </form>
                    )}

                    {/* 领域特征词 */}
                    {selectedDomainObj.seedKeywords.length > 0 && (
                      <div className="re-section-box">
                        <h3>领域特征词 ({selectedDomainObj.seedKeywords.length})</h3>
                        <div className="re-badge-row">
                          {selectedDomainObj.seedKeywords.slice(0, 18).map((kw) => (
                            <span key={kw} className="re-pill">#{kw}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 旗下第二层我的开源库 */}
                    <div className="re-section-box">
                      <h3>旗下我的开源库 ({domainOwned.length})</h3>
                      {domainOwned.length === 0 ? (
                        <p style={{ margin: 0, fontSize: 12, color: "#646b64" }}>
                          当前筛选条件下该领域暂无显示中的自有库（如包含 Fork 可打开顶部“显示 Fork 仓”）。
                        </p>
                      ) : (
                        <ul className="re-link-list">
                          {domainOwned.map((o) => (
                            <li key={o.id}>
                              <button
                                type="button"
                                className="re-link-item-btn"
                                onClick={() => {
                                  setExpandedDomainIds((prev) => new Set([...prev, selectedDomainObj.id]));
                                  setExpandedOwnedIds((prev) => new Set([...prev, o.id]));
                                  void openNodeInspector(o.id);
                                  pendingFocusTargetRef.current = { kind: "owned", id: o.id };
                                }}
                              >
                                <span style={{ minWidth: 0 }}>
                                  <strong style={{ display: "block", fontSize: 12.5 }}>
                                    {o.priorityTier === "spotlight" ? "★ " : ""}
                                    {o.visibility === "private" ? "🔒 " : ""}
                                    {o.isFork ? "⑂ " : ""}
                                    {o.name}
                                  </strong>
                                  <small style={{ color: "#666c65" }}>
                                    {o.primaryLanguage || "多语言"} · 关联 {o.totalStarCount} Star
                                  </small>
                                </span>
                                <span className={o.totalStarCount > 0 ? "re-pill active" : "re-pill"}>
                                  {expandedOwnedIds.has(o.id) ? "L3 已展开" : `+${o.totalStarCount} ★`}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* 关联第三层 Star 仓 */}
                    <div className="re-section-box">
                      <h3>关联 Star 滋养源 ({domainStars.length})</h3>
                      {domainStars.length === 0 ? (
                        <p style={{ margin: 0, fontSize: 12, color: "#646b64" }}>
                          该领域下暂未召回关联 Star 仓，可在「领域与散落池」中手动建立 1 对 N 关联。
                        </p>
                      ) : (
                        <ul className="re-link-list">
                          {domainStars.slice(0, 24).map((st) => (
                            <li key={st.id}>
                              <button
                                type="button"
                                className="re-link-item-btn"
                                onClick={() => void locateNodeInRadial(st)}
                              >
                                <span style={{ minWidth: 0 }}>
                                  <strong style={{ display: "block", fontSize: 12 }}>{st.fullName}</strong>
                                  <small style={{ color: "#666c65" }}>
                                    ★ {formatStars(st.starsCount)} · {st.primaryLanguage || "多语言"}
                                  </small>
                                </span>
                                {st.isMultiTarget ? (
                                  <span className="re-pill multi">1对{st.targetOwnedIds.length}</span>
                                ) : (
                                  <span className="re-pill">{Math.round(st.maxStrength * 100)}%</span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* ---- 游离散落星云抽屉 ---- */}
              {inspectorMode === "floating" && radialGraph?.floatingPool && (() => {
                const fp = radialGraph.floatingPool;
                return (
                  <>
                    <div className="re-section-box">
                      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#434b44" }}>
                        低相关、陈旧或尚未归类的 Star 仓会被温和隔离在主光环之外的「游离散落星云」，保证三层同心光环干净锐利、绝不硬凑误连。
                      </p>
                      <div className="re-domain-stat-grid">
                        <div className="re-domain-stat-cell">
                          <span>散落池总量</span>
                          <strong>{fp.totalCount}</strong>
                        </div>
                        <div className="re-domain-stat-cell">
                          <span>未归类</span>
                          <strong>{fp.unclassifiedCount}</strong>
                        </div>
                        <div className="re-domain-stat-cell">
                          <span>已归类未连线</span>
                          <strong>{fp.classifiedUnlinkedCount}</strong>
                        </div>
                        <div className="re-domain-stat-cell">
                          <span>陈旧 / 归档</span>
                          <strong>{fp.staleCount + fp.archivedCount}</strong>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="re-primary"
                        onClick={() => {
                          setActiveTab("domains");
                          setPoolBucket("floating");
                          setPoolDomainId("");
                          setPoolPage(1);
                          setInspectorMode("none");
                        }}
                      >
                        进入「领域与散落池」批量整理工作台 →
                      </button>
                    </div>

                    {fp.sampleRepos.length > 0 && (
                      <div className="re-section-box">
                        <h3>代表性散落仓样例（点击快速打捞归类）</h3>
                        <ul className="re-link-list">
                          {fp.sampleRepos.map((repo) => (
                            <li key={repo.id}>
                              <button
                                type="button"
                                className="re-link-item-btn"
                                onClick={() => void openNodeInspector(repo.id)}
                              >
                                <span style={{ minWidth: 0 }}>
                                  <strong style={{ display: "block", fontSize: 12.5 }}>{repo.fullName}</strong>
                                  <small style={{ color: "#666c65" }}>
                                    ★ {formatStars(repo.starsCount)} · {repo.primaryLanguage || "多语言"} · {REPO_VITALITY_LABELS[repo.vitality]}
                                  </small>
                                </span>
                                <span className="re-pill">打捞 →</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                );
              })()}

              {/* ---- 节点态 Inspector ---- */}
              {inspectorMode === "node" && selectedNodeDetail && (() => {
                const node = selectedNodeDetail.node;
                const ghHref = safeExternalUrl(node.url);
                return (
                  <>
                    <div className="re-section-box">
                      <div className="re-badge-row">
                        <span className={`re-pill ${node.vitality}`}>{REPO_VITALITY_LABELS[node.vitality]}</span>
                        <span className="re-pill">
                          {node.role === "owned" ? "我的开源库 (L2)" : node.role === "both" ? "自有+Star" : "Star 仓 (L3)"}
                        </span>
                        {node.visibility === "private" && <span className="re-pill private">🔒 私有仓</span>}
                        {node.priorityTier === "spotlight" && <span className="re-pill spotlight">★ 重点关注</span>}
                        {node.isFork && <span className="re-pill fork">⑂ Fork</span>}
                        {node.primaryLanguage && <span className="re-pill">{node.primaryLanguage}</span>}
                      </div>

                      {node.description && (
                        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#363e37" }}>
                          {node.description}
                        </p>
                      )}

                      {selectedOwnedRadialProfile &&
                        (selectedOwnedRadialProfile.profileSummary ||
                          selectedOwnedRadialProfile.techStack.length > 0 ||
                          selectedOwnedRadialProfile.keyModules.length > 0) && (
                          <div className="re-profile-box">
                            <strong>技术画像摘要</strong>
                            {selectedOwnedRadialProfile.profileSummary && (
                              <span>{selectedOwnedRadialProfile.profileSummary}</span>
                            )}
                            {selectedOwnedRadialProfile.techStack.length > 0 && (
                              <div className="re-badge-row">
                                {selectedOwnedRadialProfile.techStack.slice(0, 8).map((t) => (
                                  <span key={t} className="re-pill">{t}</span>
                                ))}
                              </div>
                            )}
                            {selectedOwnedRadialProfile.keyModules.length > 0 && (
                              <small style={{ color: "#4e5c53" }}>
                                核心模块：{selectedOwnedRadialProfile.keyModules.slice(0, 6).join(" · ")}
                              </small>
                            )}
                          </div>
                        )}

                      <div className="re-mono" style={{ fontSize: 11.5, color: "#5c635b", display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <span>★ {formatStars(node.starsCount)}</span>
                        <span>⑂ {node.forksCount}</span>
                        <span>推送 {formatDateShort(node.pushedAt)}</span>
                        {node.starredAt && <span>Star {formatDateShort(node.starredAt)}</span>}
                      </div>

                      {node.topics.length > 0 && (
                        <div className="re-badge-row">
                          {node.topics.slice(0, 10).map((t) => (
                            <span key={t} className="re-pill">#{t}</span>
                          ))}
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4 }}>
                        <button
                          type="button"
                          className="re-mini re-primary"
                          onClick={() => void locateNodeInRadial(node)}
                        >
                          在光环中居中定位
                        </button>
                        <button
                          type="button"
                          className="re-mini"
                          disabled={Boolean(busyAction)}
                          onClick={() =>
                            void handleUpdateNode(
                              node.id,
                              { priorityTier: node.priorityTier === "spotlight" ? "standard" : "spotlight" },
                              node.priorityTier === "spotlight" ? "已取消重点关注" : "已设为重点关注 (Spotlight)",
                            )
                          }
                        >
                          {node.priorityTier === "spotlight" ? "取消 ★ 重点" : "设为 ★ 重点关注"}
                        </button>
                        {ghHref && (
                          <a className="re-link-btn" style={{ padding: "2px 8px", fontSize: 11.5 }} href={ghHref} target="_blank" rel="noreferrer">
                            GitHub ↗
                          </a>
                        )}
                      </div>
                    </div>

                    {/* 私有仓 LLM 隐私开关 */}
                    {node.visibility === "private" && (
                      <label className="re-privacy-box">
                        <input
                          type="checkbox"
                          checked={node.allowLlmAnalysis}
                          disabled={Boolean(busyAction)}
                          onChange={(e) =>
                            void handleUpdateNode(
                              node.id,
                              { allowLlmAnalysis: e.target.checked },
                              e.target.checked ? "已允许对该私有仓执行 LLM 深度模块分析" : "已关闭该私有仓 LLM 外发分析（仅本地确定性分析）",
                            )
                          }
                        />
                        <span>
                          <strong>私有仓 LLM 分析隐私授权</strong>
                          <br />
                          允许将本私有仓的 README/目录结构摘要送入外部 LLM 进行模块对比（默认关闭以保护私密代码）。
                        </span>
                      </label>
                    )}

                    {/* 零克隆 Code Map（0 MB 本地克隆 · 纯内存解析） */}
                    <ZeroCloneCodeMapPanel
                      node={node}
                      onNotice={(text) => setNotice({ text })}
                      onError={(msg) => setError(msg)}
                    />

                    {/* 领域归属修改（手工订正立刻反映到光环位置！） */}
                    <div className="re-section-box">
                      <h3>领域归属（修改后立即更新光环位置）</h3>
                      <label className="re-field">
                        <span>主领域</span>
                        <select
                          aria-label="主领域归属"
                          data-testid="inspector-primary-domain-select"
                          value={node.primaryDomainId ?? ""}
                          disabled={Boolean(busyAction)}
                          onChange={(e) =>
                            void handleUpdateNode(
                              node.id,
                              { primaryDomainId: e.target.value || null },
                              e.target.value ? "已更新主领域归属，同心光环位置已即时刷新" : "已移回未归类散落池",
                            )
                          }
                        >
                          <option value="">未归类（游离散落池）</option>
                          {radialDomains.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="re-field">
                        <span>副领域标签（多选）</span>
                        <div className="re-domain-chips">
                          {radialDomains
                            .filter((d) => d.id !== node.primaryDomainId)
                            .map((d) => {
                              const selected = node.secondaryDomainIds.includes(d.id);
                              return (
                                <button
                                  key={d.id}
                                  type="button"
                                  className="re-domain-chip"
                                  data-selected={selected ? "true" : "false"}
                                  disabled={Boolean(busyAction)}
                                  onClick={() => {
                                    const next = selected
                                      ? node.secondaryDomainIds.filter((id) => id !== d.id)
                                      : [...node.secondaryDomainIds, d.id];
                                    void handleUpdateNode(node.id, { secondaryDomainIds: next }, "已更新副领域标签");
                                  }}
                                >
                                  {d.name}
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </div>

                    {/* 一键关联到多个我的开源库（Checkbox 1 对 N） */}
                    {node.role !== "owned" && allOwnedForCheckboxes.length > 0 && (
                      <div className="re-section-box">
                        <h3>一键关联到多个我的开源库（1 对 N）</h3>
                        <div className="re-checkbox-list">
                          {allOwnedForCheckboxes.map((owned) => {
                            const checked = bulkTargets.has(owned.id);
                            return (
                              <label key={owned.id} className="re-checkbox-item">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setBulkTargets((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(owned.id)) next.delete(owned.id);
                                      else next.add(owned.id);
                                      return next;
                                    });
                                  }}
                                />
                                <span>
                                  {owned.priorityTier === "spotlight" ? "★ " : ""}
                                  {owned.visibility === "private" ? "🔒 " : ""}
                                  {owned.isFork ? "⑂ " : ""}
                                  <strong>{owned.name}</strong>
                                  <small style={{ color: "#686e67", marginLeft: 5 }}>{owned.owner}</small>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                          <select
                            aria-label="吸收关系类型"
                            value={bulkRelationType}
                            onChange={(e) => setBulkRelationType(e.target.value as RepoRelationType)}
                          >
                            {RELATION_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {REPO_RELATION_LABELS[k]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="re-primary"
                            disabled={bulkTargets.size === 0 || Boolean(busyAction)}
                            onClick={() => void handleBulkLinkFromInspector()}
                          >
                            {busyAction === "bulk-link" ? "关联中…" : `应用关联 (${bulkTargets.size} 库)`}
                          </button>
                        </div>
                        <input
                          type="text"
                          value={bulkRationale}
                          onChange={(e) => setBulkRationale(e.target.value)}
                          placeholder="可选：简要说明可吸收的技术机制…"
                        />
                      </div>
                    )}

                    {/* 关联的吸收边列表 */}
                    {(selectedNodeDetail.outgoingLinks.length > 0 || selectedNodeDetail.incomingLinks.length > 0) && (
                      <div className="re-section-box">
                        <h3>
                          已建立的吸收边 (
                          {selectedNodeDetail.outgoingLinks.length + selectedNodeDetail.incomingLinks.length})
                        </h3>
                        <ul className="re-link-list">
                          {[...selectedNodeDetail.outgoingLinks, ...selectedNodeDetail.incomingLinks].map((link) => (
                            <li key={link.id}>
                              <button
                                type="button"
                                className="re-link-item-btn"
                                onClick={() => void openLinkInspector(link)}
                              >
                                <span style={{ minWidth: 0 }}>
                                  <strong style={{ display: "block", fontSize: 12.5 }}>
                                    {link.sourceNodeId === node.id
                                      ? `→ ${link.targetRepoFullName}`
                                      : `← ${link.sourceRepoFullName}`}
                                  </strong>
                                  <small style={{ color: "#666c65" }}>
                                    {REPO_RELATION_LABELS[link.relationType]} · {link.moduleAnalysis.length} 模块点
                                  </small>
                                </span>
                                <span className={`re-pill ${link.status}`}>
                                  {REPO_ABSORPTION_STATUS_LABELS[link.status]}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 备注 */}
                    <div className="re-section-box">
                      <h3>个人备注</h3>
                      <textarea
                        rows={2}
                        value={nodeNotesDraft}
                        onChange={(e) => setNodeNotesDraft(e.target.value)}
                        placeholder="记录对该仓库架构或模块的观察笔记…"
                      />
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="re-mini"
                          disabled={Boolean(busyAction)}
                          onClick={() => void handleUpdateNode(node.id, { notes: nodeNotesDraft }, "已保存仓库备注")}
                        >
                          保存备注
                        </button>
                      </div>
                    </div>

                    {/* 内嵌 RepositoryIndexContent / README 预览 */}
                    <div className="re-section-box">
                      <h3>
                        <span>仓库文件树与 README 预览</span>
                        <button
                          type="button"
                          className="re-mini"
                          onClick={() => setShowNodeReadme((v) => !v)}
                        >
                          {showNodeReadme ? "收起预览" : "展开读取 README"}
                        </button>
                      </h3>
                      {showNodeReadme ? (
                        <RepoNodeContentPreview node={node} />
                      ) : (
                        <p style={{ margin: 0, fontSize: 12, color: "#646b64" }}>
                          按需加载根目录文件树、仓内代码搜索与 README 全文（内嵌 RepositoryIndexContent 能力）。
                        </p>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* ---- 连线态 Inspector（匹配依据 rationale + 模块级深度分析 + 总裁信箱） ---- */}
              {inspectorMode === "link" && selectedLink && (
                <>
                  <div className="re-section-box">
                    <div className="re-badge-row">
                      <span className={`re-pill ${selectedLink.status}`}>
                        {REPO_ABSORPTION_STATUS_LABELS[selectedLink.status]}
                      </span>
                      <span className="re-pill">{REPO_RELATION_LABELS[selectedLink.relationType]}</span>
                      <span className="re-pill">契合度 {Math.round(selectedLink.strength * 100)}%</span>
                      <span className="re-pill">{selectedLink.createdBy === "ai" ? "精准召回" : "手动建立"}</span>
                    </div>

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => void openNodeInspector(selectedLink.sourceNodeId)}
                      >
                        Star 源：{selectedLink.sourceRepoFullName}
                      </button>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => void openNodeInspector(selectedLink.targetNodeId)}
                      >
                        自有库：{selectedLink.targetRepoFullName}
                      </button>
                    </div>

                    {selectedLink.rationale && (
                      <div className="re-rationale-callout">
                        <strong style={{ display: "block", fontSize: 11.5, marginBottom: 3, color: "#7d4c10" }}>
                          匹配依据与技术契合点
                        </strong>
                        {selectedLink.rationale}
                      </div>
                    )}

                    {/* 双仓零克隆 Code Map 证据对照条 */}
                    <div className="re-link-codemap-strip" data-testid="link-codemap-strip">
                      <button
                        type="button"
                        className="re-link-cm-cell"
                        title="点击查看源 Star 仓零克隆 Code Map"
                        onClick={() => void openNodeInspector(selectedLink.sourceNodeId)}
                      >
                        <span style={{ fontWeight: 650, color: "#1d4230" }}>
                          源仓 Code Map {linkCodeMaps?.source ? "✓" : "待扫描"}
                        </span>
                        <span className="re-mono" style={{ fontSize: 10.5, color: "#556159" }}>
                          {linkCodeMaps?.source
                            ? `${linkCodeMaps.source.commitSha.slice(0, 7)} · ${linkCodeMaps.source.hotspotCount} 热点 · ${linkCodeMaps.source.analyzedFileCount} 文件`
                            : "点击研究将自动纯内存扫描 (0 MB)"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="re-link-cm-cell"
                        title="点击查看目标自有仓零克隆 Code Map"
                        onClick={() => void openNodeInspector(selectedLink.targetNodeId)}
                      >
                        <span style={{ fontWeight: 650, color: "#362a6e" }}>
                          目标仓 Code Map {linkCodeMaps?.target ? "✓" : "待扫描"}
                        </span>
                        <span className="re-mono" style={{ fontSize: 10.5, color: "#556159" }}>
                          {linkCodeMaps?.target
                            ? `${linkCodeMaps.target.commitSha.slice(0, 7)} · ${linkCodeMaps.target.hotspotCount} 热点 · ${linkCodeMaps.target.analyzedFileCount} 文件`
                            : "点击研究将自动纯内存扫描 (0 MB)"}
                        </span>
                      </button>
                    </div>

                    {/* 核心操作按钮 */}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4 }}>
                      <button
                        type="button"
                        className="re-primary"
                        data-testid="link-analyze-btn"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleAnalyzeLink(selectedLink.id)}
                      >
                        {busyAction === "analyze" ? "双仓零克隆解析中…" : "⚡ 零克隆源码级吸收研究"}
                      </button>
                      <button
                        type="button"
                        className="re-indigo"
                        data-testid="link-submit-mailbox-btn"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleSubmitToMailbox(selectedLink.id)}
                      >
                        {busyAction === "submit-mailbox" ? "提交中…" : "📮 提交总裁信箱评估"}
                      </button>
                      <button type="button" className="re-mini" onClick={() => setLinkEditing((v) => !v)}>
                        {linkEditing ? "收起编辑" : "编辑边"}
                      </button>
                      <button
                        type="button"
                        className="re-mini re-danger"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleDeleteLink(selectedLink)}
                      >
                        删除边
                      </button>
                    </div>

                    <input
                      type="text"
                      value={mailboxNote}
                      onChange={(e) => setMailboxNote(e.target.value)}
                      placeholder="可选：提交总裁信箱时附带给自己的评审备注…"
                    />
                  </div>

                  {/* 总裁信箱审批闭环状态卡片 */}
                  {selectedLink.decisionPacketId && (
                    <div className="re-mailbox-card">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <strong>📮 已关联总裁信箱评估单</strong>
                        <span className={`re-pill ${selectedLink.status}`}>
                          {selectedLink.decisionStatus || REPO_ABSORPTION_STATUS_LABELS[selectedLink.status]}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, color: "#433969" }}>
                        审批单 ID：<code>{selectedLink.decisionPacketId}</code>（V1 审批后写入图谱与时间线，不自动改代码）
                      </span>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <a
                          className="re-link-btn"
                          href={`#mailbox?decision=${encodeURIComponent(selectedLink.decisionPacketId)}`}
                        >
                          在总裁信箱打开审批单 ↗
                        </a>
                        {selectedLink.status === "approved" && !selectedLink.opportunityId && (
                          <button
                            type="button"
                            className="re-mini re-primary"
                            disabled={Boolean(busyAction)}
                            onClick={() => void handlePromoteOpportunity(selectedLink.id)}
                          >
                            {busyAction === "promote-opp" ? "转换中…" : "手动转为研发选题"}
                          </button>
                        )}
                        {selectedLink.opportunityId && (
                          <a className="re-link-btn" href="#opportunities">
                            已转研发选题 ↗
                          </a>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 内联编辑边表单 */}
                  {linkEditing && (
                    <form className="re-section-box" onSubmit={(e) => void handleSaveLinkEdit(e)}>
                      <h3>编辑吸收边属性</h3>
                      <div className="re-form-grid">
                        <label className="re-field">
                          <span>关系类型</span>
                          <select
                            value={linkEditRelation}
                            onChange={(e) => setLinkEditRelation(e.target.value as RepoRelationType)}
                          >
                            {RELATION_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {REPO_RELATION_LABELS[k]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="re-field">
                          <span>吸收状态</span>
                          <select
                            value={linkEditStatus}
                            onChange={(e) => setLinkEditStatus(e.target.value as RepoAbsorptionStatus)}
                          >
                            {STATUS_KEYS.map((st) => (
                              <option key={st} value={st}>
                                {REPO_ABSORPTION_STATUS_LABELS[st]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className="re-field">
                        <span>吸收强度：{linkEditStrength}%</span>
                        <input
                          type="range"
                          min={5}
                          max={100}
                          value={linkEditStrength}
                          onChange={(e) => setLinkEditStrength(Number(e.target.value))}
                        />
                      </label>
                      <label className="re-field">
                        <span>核心理由</span>
                        <textarea
                          rows={2}
                          value={linkEditRationale}
                          onChange={(e) => setLinkEditRationale(e.target.value)}
                        />
                      </label>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                        <button type="button" className="re-mini" onClick={() => setLinkEditing(false)}>
                          取消
                        </button>
                        <button type="submit" className="re-mini re-primary" disabled={Boolean(busyAction)}>
                          保存修改
                        </button>
                      </div>
                    </form>
                  )}

                  {/* 结构化源码级模块吸收分析卡片列表 */}
                  <div className="re-section-box">
                    <h3>
                      <span>源码级模块吸收方案 ({selectedLink.moduleAnalysis.length})</span>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => setAddingModule((v) => !v)}
                      >
                        {addingModule ? "收起" : "+ 手动补充模块"}
                      </button>
                    </h3>
                    {selectedLink.analysisSource && (
                      <div style={{ fontSize: 11.5, color: "#616861", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <span>
                          分析来源：
                          {selectedLink.analysisSource === "llm"
                            ? "LLM + 零克隆 Code Map 源码对比"
                            : selectedLink.analysisSource === "deterministic"
                              ? "零克隆 Code Map 确定性源码对照"
                              : "手动维护"}
                          {selectedLink.analyzedAt ? ` · ${formatTimeFull(selectedLink.analyzedAt)}` : ""}
                        </span>
                      </div>
                    )}

                    {addingModule && (
                      <form
                        onSubmit={(e) => void handleAddManualModule(e)}
                        style={{ display: "flex", flexDirection: "column", gap: 7, padding: 9, background: "#f7f4ea", border: "1px solid #d5d0c3" }}
                      >
                        <input
                          type="text"
                          required
                          value={newModSource}
                          onChange={(e) => setNewModSource(e.target.value)}
                          placeholder="源仓模块路径（如 src/scheduler/queue.ts）"
                        />
                        <input
                          type="text"
                          value={newModTarget}
                          onChange={(e) => setNewModTarget(e.target.value)}
                          placeholder="目标自有仓模块路径（如 packages/core/executor.ts）"
                        />
                        <textarea
                          rows={2}
                          required
                          value={newModMechanism}
                          onChange={(e) => setNewModMechanism(e.target.value)}
                          placeholder="可吸收机制（必填）"
                        />
                        <input
                          type="text"
                          value={newModGap}
                          onChange={(e) => setNewModGap(e.target.value)}
                          placeholder="现状差距"
                        />
                        <input
                          type="text"
                          value={newModPlan}
                          onChange={(e) => setNewModPlan(e.target.value)}
                          placeholder="适配落地建议"
                        />
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <select value={newModEffort} onChange={(e) => setNewModEffort(e.target.value as RepoModuleEffort)}>
                            <option value="S">工作量 S</option>
                            <option value="M">工作量 M</option>
                            <option value="L">工作量 L</option>
                          </select>
                          <select value={newModRisk} onChange={(e) => setNewModRisk(e.target.value as RepoModuleRisk)}>
                            <option value="low">低风险</option>
                            <option value="medium">中风险</option>
                            <option value="high">高风险</option>
                          </select>
                          <button type="submit" className="re-mini re-primary" style={{ marginLeft: "auto" }} disabled={Boolean(busyAction)}>
                            添加模块点
                          </button>
                        </div>
                      </form>
                    )}

                    {selectedLink.moduleAnalysis.length === 0 ? (
                      <div style={{ padding: "12px 10px", background: "#faf7ee", border: "1px dashed #c7c1b2", fontSize: 12.5, color: "#5e645d" }}>
                        尚未生成源码级吸收研究。点击上方「⚡ 零克隆源码级吸收研究」将纯内存解析双方 Code Map Hotspot 文件与导出符号（0 MB 本地克隆），产出源 Hotspot → 目标承载模块的精确改造步骤与验收标准。
                      </div>
                    ) : (
                      <div className="re-module-list">
                        {selectedLink.moduleAnalysis.map((mod) => (
                          <article key={mod.id} className="re-module-card" data-testid="link-module-card">
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                              <div className="re-module-path">
                                <span>{mod.sourceModulePath}</span>
                                <span className="re-module-arrow">→</span>
                                <span>{mod.targetModulePath}</span>
                              </div>
                              <button
                                type="button"
                                className="re-ghost re-mini"
                                title="移除该模块点"
                                onClick={() => void handleRemoveModuleItem(mod.id)}
                              >
                                ✕
                              </button>
                            </div>

                            <div className="re-badge-row">
                              {mod.groundedByCodeMap && (
                                <span className="re-zero-clone-badge">✓ 零克隆源码证据</span>
                              )}
                              {mod.sourceLayer && (
                                <span
                                  className="re-pill"
                                  style={{
                                    borderColor: REPO_CODE_LAYER_COLORS[mod.sourceLayer],
                                    color: REPO_CODE_LAYER_COLORS[mod.sourceLayer],
                                    background: "#fffdf8",
                                  }}
                                >
                                  源:{REPO_CODE_LAYER_LABELS[mod.sourceLayer]}
                                </span>
                              )}
                              {mod.targetLayer && (
                                <span
                                  className="re-pill"
                                  style={{
                                    borderColor: REPO_CODE_LAYER_COLORS[mod.targetLayer],
                                    color: REPO_CODE_LAYER_COLORS[mod.targetLayer],
                                    background: "#fffdf8",
                                  }}
                                >
                                  目标:{REPO_CODE_LAYER_LABELS[mod.targetLayer]}
                                </span>
                              )}
                              <span className="re-pill">工作量 {mod.effort}</span>
                              <span
                                className={`re-pill ${
                                  mod.risk === "high" ? "rejected" : mod.risk === "medium" ? "suggested" : "active"
                                }`}
                              >
                                {mod.risk === "high" ? "高风险" : mod.risk === "medium" ? "中风险" : "低风险"}
                              </span>
                            </div>

                            {/* 导出符号对照条 */}
                            {((mod.sourceSymbols && mod.sourceSymbols.length > 0) ||
                              (mod.targetSymbols && mod.targetSymbols.length > 0)) && (
                              <div className="re-symbol-compare-bar" data-testid="link-symbol-compare">
                                <strong style={{ color: "#4d554e" }}>符号对照：</strong>
                                {(mod.sourceSymbols ?? []).slice(0, 4).map((sym) => (
                                  <code key={`src-${sym}`}>{sym}</code>
                                ))}
                                <span className="re-module-arrow" style={{ margin: "0 2px" }}>→</span>
                                {(mod.targetSymbols && mod.targetSymbols.length > 0
                                  ? mod.targetSymbols.slice(0, 4)
                                  : ["新增/扩展承载符号"]
                                ).map((sym) => (
                                  <code key={`tgt-${sym}`}>{sym}</code>
                                ))}
                              </div>
                            )}

                            <p className="re-module-kv">
                              <strong>核心机制：</strong>
                              {mod.absorbableMechanism}
                            </p>
                            <p className="re-module-kv">
                              <strong>现状差距：</strong>
                              {mod.currentGap}
                            </p>
                            <p className="re-module-kv">
                              <strong>适配方案：</strong>
                              {mod.adaptationPlan}
                            </p>

                            {mod.steps && mod.steps.length > 0 && (
                              <div className="re-module-kv">
                                <strong>分步改造步骤：</strong>
                                <ol className="re-steps-list">
                                  {mod.steps.map((step, sIdx) => (
                                    <li key={`${mod.id}-step-${sIdx}`}>{step}</li>
                                  ))}
                                </ol>
                              </div>
                            )}

                            {mod.acceptanceCriteria && mod.acceptanceCriteria.length > 0 && (
                              <div className="re-module-kv">
                                <strong>验收标准：</strong>
                                <ul className="re-criteria-list">
                                  {mod.acceptanceCriteria.map((ac, aIdx) => (
                                    <li key={`${mod.id}-ac-${aIdx}`}>{ac}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {mod.evidenceLinks.length > 0 && (
                              <div className="re-evidence-links">
                                {mod.evidenceLinks.map((ev, idx) => {
                                  const href = safeExternalUrl(ev.url);
                                  return href ? (
                                    <a key={`${mod.id}-ev-${idx}`} href={href} target="_blank" rel="noreferrer">
                                      🔗 {ev.label || ev.path || "代码证据"} ↗
                                    </a>
                                  ) : (
                                    <code key={`${mod.id}-ev-${idx}`} style={{ fontSize: 11 }}>
                                      {ev.path || ev.label}
                                    </code>
                                  );
                                })}
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    )}

                    {selectedLink.moduleAnalysis.length > 0 && !selectedLink.decisionPacketId && (
                      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
                        <button
                          type="button"
                          className="re-indigo"
                          disabled={Boolean(busyAction)}
                          onClick={() => void handleSubmitToMailbox(selectedLink.id)}
                        >
                          {busyAction === "submit-mailbox" ? "提交中…" : "📮 一键提交总裁信箱评估"}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* ================= 模态框 1：设置 ================= */}
      {settingsOpen && (
        <div className="re-modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void saveSettings(e)}>
            <div className="re-modal-head">
              <h2>开源进化图谱设置</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <div className="re-field">
                <span>重点关注仓（Spotlight · 置顶并获得召回加权，默认含 ai-agent-node）</span>
                <div className="re-spotlight-tags">
                  {cfgSpotlight.map((name) => (
                    <span key={name} className="re-spotlight-tag">
                      ★ {name}
                      <button
                        type="button"
                        className="re-ghost re-mini"
                        onClick={() => setCfgSpotlight((list) => list.filter((x) => x !== name))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input
                    type="text"
                    value={cfgNewSpotlight}
                    onChange={(e) => setCfgNewSpotlight(e.target.value)}
                    placeholder="输入仓库名或 owner/repo（如 ai-agent-node）"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const v = cfgNewSpotlight.trim();
                      if (v && !cfgSpotlight.includes(v)) {
                        setCfgSpotlight((list) => [...list, v]);
                      }
                      setCfgNewSpotlight("");
                    }}
                  >
                    + 添加重点仓
                  </button>
                </div>
              </div>

              <div className="re-form-grid">
                <label className="re-field">
                  <span>静默判定阈值（月无推送）</span>
                  <input
                    type="number"
                    min={3}
                    max={48}
                    value={cfgDormantMonths}
                    onChange={(e) => setCfgDormantMonths(Number(e.target.value))}
                  />
                </label>
                <label className="re-field">
                  <span>陈旧沉淀池阈值（月无推送）</span>
                  <input
                    type="number"
                    min={6}
                    max={96}
                    value={cfgStaleMonths}
                    onChange={(e) => setCfgStaleMonths(Number(e.target.value))}
                  />
                </label>
                <label className="re-field">
                  <span>语义聚类最低相似度 (0.1–0.9)</span>
                  <input
                    type="number"
                    step={0.02}
                    min={0.1}
                    max={0.9}
                    value={cfgMinClusterSim}
                    onChange={(e) => setCfgMinClusterSim(Number(e.target.value))}
                  />
                </label>
                <label className="re-field">
                  <span>候选吸收边最低相似度 (0.1–0.9)</span>
                  <input
                    type="number"
                    step={0.02}
                    min={0.1}
                    max={0.9}
                    value={cfgMinLinkSim}
                    onChange={(e) => setCfgMinLinkSim(Number(e.target.value))}
                  />
                </label>
              </div>

              <label className="re-privacy-box">
                <input
                  type="checkbox"
                  checked={cfgAllowPrivateLlm}
                  onChange={(e) => setCfgAllowPrivateLlm(e.target.checked)}
                />
                <span>
                  <strong>私有仓默认允许外部 LLM 分析</strong>
                  <br />
                  建议保持关闭：关闭后私有仓默认只使用本地确定性结构分析，需要时可在单个私有仓检视抽屉按需开启授权。
                </span>
              </label>

              <label className="re-field">
                <span>自动化档位（V1 默认总裁信箱人工拍板留痕，后续档位为平滑演进预留）</span>
                <select
                  value={cfgAutomationMode}
                  onChange={(e) => setCfgAutomationMode(e.target.value as RepoEvolutionAutomationMode)}
                >
                  {(Object.keys(REPO_AUTOMATION_MODE_LABELS) as RepoEvolutionAutomationMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {REPO_AUTOMATION_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button type="submit" className="re-primary" disabled={busyAction === "config"}>
                {busyAction === "config" ? "保存中…" : "保存配置"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================= 模态框 2：新建 / 编辑领域 ================= */}
      {domainModal && (
        <div className="re-modal-backdrop" onClick={() => setDomainModal(null)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleSaveDomain(e)}>
            <div className="re-modal-head">
              <h2>{domainModal.mode === "create" ? "新建技术领域" : `编辑领域：${domainModal.domain?.name}`}</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setDomainModal(null)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <div className="re-form-grid">
                <label className="re-field">
                  <span>领域名称</span>
                  <input
                    type="text"
                    required
                    value={domainModal.name}
                    onChange={(e) => setDomainModal((m) => (m ? { ...m, name: e.target.value } : m))}
                    placeholder="如：AI Agent 运行时与编排"
                  />
                </label>
                <label className="re-field">
                  <span>徽标字符</span>
                  <input
                    type="text"
                    maxLength={12}
                    value={domainModal.icon}
                    onChange={(e) => setDomainModal((m) => (m ? { ...m, icon: e.target.value } : m))}
                    placeholder="◈"
                  />
                </label>
              </div>
              <label className="re-field">
                <span>领域描述</span>
                <textarea
                  rows={2}
                  value={domainModal.description}
                  onChange={(e) => setDomainModal((m) => (m ? { ...m, description: e.target.value } : m))}
                  placeholder="说明该领域涵盖的技术方向，也会参与语义聚类…"
                />
              </label>
              <label className="re-field">
                <span>种子关键词（逗号分隔，用于增强 AI 自动聚类）</span>
                <input
                  type="text"
                  value={domainModal.seedKeywords}
                  onChange={(e) => setDomainModal((m) => (m ? { ...m, seedKeywords: e.target.value } : m))}
                  placeholder="agent, mcp, workflow, tool-use, memory"
                />
              </label>
              <div className="re-field">
                <span>领域色标</span>
                <div className="re-swatch-row">
                  {DOMAIN_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="re-swatch"
                      style={{ background: c }}
                      data-current={domainModal.color === c ? "true" : "false"}
                      aria-label={`选择色标 ${c}`}
                      onClick={() => setDomainModal((m) => (m ? { ...m, color: c } : m))}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setDomainModal(null)}>
                取消
              </button>
              <button type="submit" className="re-primary" disabled={busyAction === "domain-save" || !domainModal.name.trim()}>
                {busyAction === "domain-save" ? "保存中…" : "保存领域"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================= 模态框 3：合并领域 ================= */}
      {mergeModal && (
        <div className="re-modal-backdrop" onClick={() => setMergeModal(null)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleMergeDomains(e)}>
            <div className="re-modal-head">
              <h2>合并技术领域</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setMergeModal(null)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <p style={{ margin: 0, fontSize: 13, color: "#4e554e" }}>
                将源领域下的全部仓库（主领域与副领域归属）迁移到目标领域，并移除源领域。
              </p>
              <label className="re-field">
                <span>源领域（将被合并移除）</span>
                <select
                  value={mergeModal.sourceDomainId}
                  onChange={(e) => setMergeModal((m) => (m ? { ...m, sourceDomainId: e.target.value } : m))}
                >
                  {domainClusters.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.totalNodes})
                    </option>
                  ))}
                </select>
              </label>
              <label className="re-field">
                <span>目标领域（保留）</span>
                <select
                  value={mergeModal.targetDomainId}
                  onChange={(e) => setMergeModal((m) => (m ? { ...m, targetDomainId: e.target.value } : m))}
                >
                  {domainClusters
                    .filter((d) => d.id !== mergeModal.sourceDomainId)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.totalNodes})
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setMergeModal(null)}>
                取消
              </button>
              <button
                type="submit"
                className="re-accent"
                disabled={busyAction === "domain-merge" || !mergeModal.targetDomainId || mergeModal.sourceDomainId === mergeModal.targetDomainId}
              >
                {busyAction === "domain-merge" ? "合并中…" : "确认合并"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ================= 模态框 4：表格单行 1 对 N 快速关联 ================= */}
      {quickLinkNode && (
        <div className="re-modal-backdrop" onClick={() => setQuickLinkNode(null)}>
          <form className="re-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submitQuickLinkModal(e)}>
            <div className="re-modal-head">
              <h2>1 对 N 关联：{quickLinkNode.fullName}</h2>
              <button type="button" className="re-ghost re-mini" onClick={() => setQuickLinkNode(null)}>
                ✕
              </button>
            </div>
            <div className="re-modal-body">
              <p style={{ margin: 0, fontSize: 12.5, color: "#525952" }}>
                勾选 1 个或多个我的开源库，将该 Star 仓的架构、模块或工作流纳入同心光环图谱。
              </p>
              <div className="re-checkbox-list" style={{ maxHeight: 240 }}>
                {allOwnedForCheckboxes.map((owned) => {
                  const checked = quickLinkTargets.has(owned.id);
                  return (
                    <label key={owned.id} className="re-checkbox-item">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setQuickLinkTargets((prev) => {
                            const next = new Set(prev);
                            if (next.has(owned.id)) next.delete(owned.id);
                            else next.add(owned.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        {owned.priorityTier === "spotlight" ? "★ " : ""}
                        {owned.visibility === "private" ? "🔒 " : ""}
                        {owned.isFork ? "⑂ " : ""}
                        <strong>{owned.fullName}</strong>
                      </span>
                    </label>
                  );
                })}
              </div>
              <label className="re-field">
                <span>关系类型</span>
                <select
                  value={quickLinkRelation}
                  onChange={(e) => setQuickLinkRelation(e.target.value as RepoRelationType)}
                >
                  {RELATION_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {REPO_RELATION_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="re-field">
                <span>吸收理由（选填）</span>
                <textarea
                  rows={2}
                  value={quickLinkRationale}
                  onChange={(e) => setQuickLinkRationale(e.target.value)}
                  placeholder="说明哪些模块或思路值得对应自有库借鉴…"
                />
              </label>
            </div>
            <div className="re-modal-foot">
              <button type="button" onClick={() => setQuickLinkNode(null)}>
                取消
              </button>
              <button
                type="submit"
                className="re-primary"
                disabled={busyAction === "quick-link" || quickLinkTargets.size === 0}
              >
                {busyAction === "quick-link" ? "保存中…" : `建立 ${quickLinkTargets.size} 条吸收边`}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
