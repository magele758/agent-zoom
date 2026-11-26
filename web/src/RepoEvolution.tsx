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
  REPO_ABSORPTION_STATUS_LABELS,
  REPO_AUTOMATION_MODE_LABELS,
  REPO_EVOLUTION_EVENT_LABELS,
  REPO_RELATION_LABELS,
  REPO_VITALITY_LABELS,
  type AnalyzeLinkResult,
  type BatchUpdateRepoNodesInput,
  type BatchUpdateRepoNodesResult,
  type ClusterAndRecallResult,
  type ImportGithubListsResult,
  type PromoteLinkToOpportunityResult,
  type RepoAbsorptionEvent,
  type RepoAbsorptionLink,
  type RepoAbsorptionStatus,
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
  type SubmitLinkToMailboxResult,
} from "../../src/repo-evolution-types";
import { request } from "./api";
import { RepositoryIndexContent } from "./RepositoryIndexContent";
import "./repo-evolution.css";

const API_BASE = "/api/opc/repo-evolution";
const UNASSIGNED_DOMAIN_ID = "__unassigned_owned__";
const DEFAULT_STARS_PER_OWNED = 12;
const CORE_RADIUS = 72;

type MainTab = "graph" | "domains" | "timeline";
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
 * 在圆环上对有序目标角度执行防重叠松弛，保证任意相邻项（含首尾跨越 2π）严格满足 minGap 且尽量贴近父节点角度。
 */
function relaxCircularAngles(targetAngles: number[], minGap: number): number[] {
  const n = targetAngles.length;
  if (n === 0) return [];
  if (n === 1) return [targetAngles[0]];

  const twoPi = Math.PI * 2;
  const safeGap = Math.min(minGap, (twoPi * 0.96) / n);

  // targetAngles are generated clockwise along the continuous [-π/2, 3π/2] circle
  const targets = [...targetAngles];
  const angles = [...targets];

  // Ensure monotonically ordered starting state
  for (let i = 1; i < n; i++) {
    if (angles[i] < angles[i - 1] + safeGap) {
      angles[i] = angles[i - 1] + safeGap;
    }
  }
  // Re-center mean angle onto target mean
  const avgDiff = angles.reduce((acc, a, i) => acc + (a - targets[i]), 0) / n;
  for (let i = 0; i < n; i++) angles[i] -= avgDiff;

  const projectGaps = () => {
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const gap = next === 0 ? angles[0] + twoPi - angles[n - 1] : angles[next] - angles[i];
      if (gap < safeGap) {
        const push = (safeGap - gap) * 0.52;
        angles[i] -= push;
        angles[next] += push;
      }
    }
  };

  // Iterative spring + circular gap relaxation
  for (let iter = 0; iter < 24; iter++) {
    for (let i = 0; i < n; i++) {
      angles[i] += (targets[i] - angles[i]) * 0.12;
    }
    projectGaps();
  }

  // Final strict gap-enforcement passes so zero residual overlap remains
  for (let pass = 0; pass < 8; pass++) {
    projectGaps();
  }

  return angles;
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

  // Sector angular span weights
  const rawWeights = sectorModels.map((sec) => {
    const expL2 = expandedDomainIds.has(sec.id);
    if (!expL2) return 1.35;
    let starWeight = 0;
    for (const o of sec.ownedNodes) {
      if (activeExpandedOwnedSet.has(o.id)) {
        const cnt = (anchoredStarsByOwned.get(o.id)?.length ?? 0) + ((ownedLocalHidden.get(o.id) ?? 0) + o.truncatedStarCount > 0 ? 1 : 0);
        starWeight += cnt;
      }
    }
    return 1.35 + Math.max(0.35, sec.ownedNodes.length * 0.62) + starWeight * 0.28;
  });

  const D = sectorModels.length;
  const twoPi = Math.PI * 2;
  const minSectorAngle = D > 0 ? Math.min(0.46, twoPi / Math.max(1, D * 1.48)) : twoPi;

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

  // Compute R1 ensuring zero overlap between adjacent Ring 1 domain cards
  let minAdjacentR1Delta = twoPi;
  const sectorMidAngles: number[] = [];
  const sectorStarts: number[] = [];
  const sectorEnds: number[] = [];
  let cursor = -Math.PI / 2;
  for (let i = 0; i < D; i++) {
    const start = cursor;
    const end = cursor + sectorSpans[i];
    sectorStarts.push(start);
    sectorEnds.push(end);
    sectorMidAngles.push((start + end) / 2);
    cursor = end;
  }
  for (let i = 0; i < D; i++) {
    const next = (i + 1) % D;
    const delta = next === 0 ? sectorMidAngles[0] + twoPi - sectorMidAngles[i] : sectorMidAngles[next] - sectorMidAngles[i];
    if (delta < minAdjacentR1Delta) minAdjacentR1Delta = delta;
  }

  const r1 =
    D <= 1 ? 210 : Math.max(220, Math.min(300, Math.ceil(186 / Math.max(0.36, minAdjacentR1Delta))));

  const sectors: PositionedSector[] = [];
  const sectorMap = new Map<string, PositionedSector>();

  for (let i = 0; i < D; i++) {
    const sec = sectorModels[i];
    const midAngle = sectorMidAngles[i];
    const pt = polar(r1, midAngle);
    const expandedL2 = expandedDomainIds.has(sec.id) && sec.ownedNodes.length > 0;
    const hasExpandedL3 = expandedL2 && sec.ownedNodes.some((o) => activeExpandedOwnedSet.has(o.id));
    const item: PositionedSector = {
      sector: sec,
      startAngle: sectorStarts[i],
      endAngle: sectorEnds[i],
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

  // Ring 2 Owned layout
  const totalVisibleOwned = visibleOwnedSet.size;
  const hasL2 = totalVisibleOwned > 0;
  const denseSectorExists = sectors.some((s) => s.expandedL2 && s.sector.ownedNodes.length >= 4);
  const useR2Stagger = denseSectorExists || totalVisibleOwned > 15;
  const r2 = hasL2
    ? Math.max(
        r1 + 210,
        Math.ceil(((totalVisibleOwned / (useR2Stagger ? 1.75 : 1)) * 164) / twoPi),
      )
    : r1 + 210;
  const r2Inner = useR2Stagger ? r2 - 28 : r2;
  const r2Outer = useR2Stagger ? r2 + 32 : r2;

  const ownedList: PositionedOwned[] = [];
  const ownedMap = new Map<string, PositionedOwned>();

  // Pre-collect Ring 2 raw target angles across sectors
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
    const pad = Math.min(0.11, span * 0.14);
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

  if (ownedDrafts.length > 0) {
    const r2MinGap = (useR2Stagger ? 104 : 168) / r2;
    const relaxedOwnedAngles = relaxCircularAngles(
      ownedDrafts.map((d) => d.targetAngle),
      r2MinGap,
    );
    ownedDrafts.forEach((draft, idx) => {
      const ang = relaxedOwnedAngles[idx];
      const rad = useR2Stagger ? (idx % 2 === 0 ? r2Inner : r2Outer) : r2;
      const pt = polar(rad, ang);
      const item: PositionedOwned = {
        node: draft.node,
        sectorId: draft.sectorId,
        angle: ang,
        r: rad,
        x: pt.x,
        y: pt.y,
        expandedL3: draft.expandedL3,
        shownStarCount: draft.shownStarCount,
        moreStarCount: draft.moreStarCount,
      };
      ownedList.push(item);
      ownedMap.set(draft.node.id, item);
    });
  }

  // Ring 3 Star & "+N 更多" layout
  type Ring3Draft =
    | { kind: "star"; star: RepoRadialStarNode; owned: PositionedOwned; targetAngle: number }
    | { kind: "more"; owned: PositionedOwned; moreCount: number; localHidden: number; serverTruncated: number; targetAngle: number };

  const ring3Drafts: Ring3Draft[] = [];
  const expandedOwnedOrdered = ownedList.filter((o) => o.expandedL3);

  // Estimate initial per-item angular spread around each expanded owned repo
  let totalRing3Items = 0;
  for (const po of expandedOwnedOrdered) {
    const anchored = anchoredStarsByOwned.get(po.node.id) ?? [];
    totalRing3Items += anchored.length + (po.moreStarCount > 0 ? 1 : 0);
  }

  const hasL3 = totalRing3Items > 0;
  const numSubOrbits = totalRing3Items > 66 ? 3 : totalRing3Items >= 4 ? 2 : 1;
  const r3Base = hasL3
    ? Math.max(
        r2Outer + 195,
        Math.ceil(((totalRing3Items * (164 / numSubOrbits)) / twoPi)),
      )
    : r2Outer + 195;

  const r3Step = 94;
  const r3Radii: number[] = [];
  if (hasL3) {
    for (let k = 0; k < numSubOrbits; k++) {
      r3Radii.push(r3Base + k * r3Step);
    }
  }

  const desiredStep = hasL3
    ? Math.max((160 / numSubOrbits) / r3Base, Math.min(0.105, (twoPi * 0.72) / Math.max(totalRing3Items, 8)))
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

  if (ring3Drafts.length > 0) {
    const minRing3Gap = (158 / numSubOrbits) / r3Base;
    const relaxedRing3 = relaxCircularAngles(
      ring3Drafts.map((d) => d.targetAngle),
      minRing3Gap,
    );

    ring3Drafts.forEach((draft, idx) => {
      const ang = relaxedRing3[idx];
      const subOrbit = idx % numSubOrbits;
      const rad = r3Radii[subOrbit] ?? r3Base;
      const pt = polar(rad, ang);

      if (draft.kind === "star") {
        const item: PositionedStar = {
          node: draft.star,
          anchorOwnedId: draft.owned.node.id,
          sectorId: draft.owned.sectorId,
          angle: ang,
          r: rad,
          subOrbit,
          x: pt.x,
          y: pt.y,
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
          angle: ang,
          r: rad,
          subOrbit,
          x: pt.x,
          y: pt.y,
        });
      }
    });
  }

  // Visible Ring 3 -> Ring 2 links
  const links: PositionedRadialLink[] = [];
  for (const link of radialGraph.links) {
    const src = starMap.get(link.starNodeId);
    const tgt = ownedMap.get(link.ownedNodeId);
    if (!src || !tgt) continue;
    const curve = orbitalAbsorptionCurve(src, tgt, r2Outer, r3Base);
    links.push({ link, ...curve });
  }

  // Floating Nebula outer satellite anchor (always clear of active rings)
  const outerRingRadius = hasL3
    ? (r3Radii[r3Radii.length - 1] ?? r3Base) + 76
    : hasL2
      ? r2Outer + 76
      : r1 + 78;
  const floatingAngle = Math.PI * 0.24;
  const floatingR = outerRingRadius + 96;
  const floatingPt = polar(floatingR, floatingAngle);
  const floatingAnchor = { x: floatingPt.x, y: floatingPt.y, r: floatingR, angle: floatingAngle };

  // Compute exact world bounding box for Fit View
  let minX = -outerRingRadius - 30;
  let maxX = outerRingRadius + 30;
  let minY = -outerRingRadius - 30;
  let maxY = outerRingRadius + 30;

  const includePoint = (x: number, y: number, padX: number, padY: number) => {
    if (x - padX < minX) minX = x - padX;
    if (x + padX > maxX) maxX = x + padX;
    if (y - padY < minY) minY = y - padY;
    if (y + padY > maxY) maxY = y + padY;
  };

  for (const s of sectors) includePoint(s.x, s.y, 92, 42);
  for (const o of ownedList) includePoint(o.x, o.y, 88, 36);
  for (const st of starList) includePoint(st.x, st.y, 82, 28);
  for (const mp of morePills) includePoint(mp.x, mp.y, 72, 26);
  if (radialGraph.floatingPool && radialGraph.floatingPool.totalCount > 0) {
    includePoint(floatingAnchor.x, floatingAnchor.y, 108, 44);
  }

  return {
    r1,
    r2,
    r2Outer,
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
  const [activeTab, setActiveTab] = useState<MainTab>(initialTab ?? "graph");

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
    const padX = 48;
    const padY = 72;
    const zoom = clamp(Math.min((rect.width - padX) / bw, (rect.height - padY) / bh), 0.24, 1.32);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    setViewport({
      x: Math.round(rect.width / 2 - cx * zoom),
      y: Math.round(rect.height / 2 - cy * zoom),
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
        const maxFitZoom = clamp(Math.min((width - 48) / bw, (height - 72) / bh), 0.24, 1.32);
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        setViewport((vp) => {
          if (width < prev.width && vp.zoom > maxFitZoom * 1.04) {
            return {
              x: Math.round(width / 2 - cx * maxFitZoom),
              y: Math.round(height / 2 - cy * maxFitZoom),
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

  // Hash deep-link sync
  useEffect(() => {
    const params = new URLSearchParams(hashQuery);
    const tabParam = params.get("tab") as MainTab | null;
    const linkParam = params.get("link") || initialLinkId || "";
    const repoParam = params.get("repo") || initialRepo || "";
    const domainParam = params.get("domain") || initialDomainId || "";
    const nodeParam = params.get("node") || initialNodeId || "";
    const bucketParam = params.get("bucket") || initialBucket || "";

    if (tabParam && ["graph", "domains", "timeline"].includes(tabParam)) {
      setActiveTab(tabParam);
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
        const nextZoom = clamp(Math.round(vp.zoom * factor * 1000) / 1000, 0.22, 2.2);
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
      const nextZoom = clamp(Math.round(vp.zoom * deltaFactor * 1000) / 1000, 0.22, 2.2);
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
      setNotice({
        text:
          res.notice ||
          (res.privacyBlocked
            ? "目标为私有仓且未开启 LLM 隐私授权，已使用本地确定性结构分析。"
            : res.usedLlm
              ? `LLM 模块级深度分析完成：共提炼 ${res.link.moduleAnalysis.length} 个可吸收模块点。`
              : `确定性结构化模块分析完成：共提炼 ${res.link.moduleAnalysis.length} 个可吸收模块点。`),
      });
      void refreshGraphs();
    } catch (err) {
      setError(describeError(err, "执行模块级深度分析失败"));
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

        {/* 3 主视图切换 Tab */}
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

                      {/* Ring 2 轨道圈 */}
                      <circle
                        className="re-orbit-ring"
                        cx={0}
                        cy={0}
                        r={radialLayout.r2}
                        fill="none"
                        stroke={svgPalette.orbitR2Stroke}
                        strokeWidth={radialLayout.hasL2 ? 1.3 : 1}
                        strokeDasharray="6 6"
                        style={{ opacity: radialLayout.hasL2 ? 1 : 0.32 }}
                      />
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

        {/* ================= 右侧 Inspector 抽屉（领域态 / 节点态 / 连线态 / 散落星云态） ================= */}
        {inspectorMode !== "none" && (
          <aside className="re-inspector" aria-label="详情与深度分析抽屉" data-testid="repo-evolution-inspector">
            <div className="re-inspector-head">
              <div className="re-inspector-title">
                <span style={{ fontSize: 11, color: "#656c64", letterSpacing: "0.05em" }}>
                  {inspectorMode === "domain"
                    ? "第一层领域 · 扇区检视器"
                    : inspectorMode === "node"
                      ? "仓库节点检视器"
                      : inspectorMode === "floating"
                        ? "外围星云 · 游离散落池"
                        : "吸收边 · 模块级深度分析"}
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

                    {/* 核心操作按钮 */}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4 }}>
                      <button
                        type="button"
                        className="re-primary"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleAnalyzeLink(selectedLink.id)}
                      >
                        {busyAction === "analyze" ? "深度分析中…" : "模块级深度分析"}
                      </button>
                      <button
                        type="button"
                        className="re-indigo"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleSubmitToMailbox(selectedLink.id)}
                      >
                        {busyAction === "submit-mailbox" ? "提交中…" : "提交总裁信箱评估"}
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

                  {/* 结构化模块级分析卡片列表 */}
                  <div className="re-section-box">
                    <h3>
                      <span>结构化模块级吸收分析 ({selectedLink.moduleAnalysis.length})</span>
                      <button
                        type="button"
                        className="re-mini"
                        onClick={() => setAddingModule((v) => !v)}
                      >
                        {addingModule ? "收起" : "+ 手动补充模块"}
                      </button>
                    </h3>
                    {selectedLink.analysisSource && (
                      <div style={{ fontSize: 11.5, color: "#616861" }}>
                        分析来源：
                        {selectedLink.analysisSource === "llm"
                          ? "LLM 深度代码结构对比"
                          : selectedLink.analysisSource === "deterministic"
                            ? "本地确定性结构化分析"
                            : "手动维护"}
                        {selectedLink.analyzedAt ? ` · ${formatTimeFull(selectedLink.analyzedAt)}` : ""}
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
                        尚未生成模块级深度分析。点击上方「模块级深度分析」将对比双方文件树与 README，产出具体的源模块 → 目标模块吸收建议与代码证据。
                      </div>
                    ) : (
                      <div className="re-module-list">
                        {selectedLink.moduleAnalysis.map((mod) => (
                          <article key={mod.id} className="re-module-card">
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
                              <span className="re-pill">工作量 {mod.effort}</span>
                              <span
                                className={`re-pill ${
                                  mod.risk === "high" ? "rejected" : mod.risk === "medium" ? "suggested" : "active"
                                }`}
                              >
                                {mod.risk === "high" ? "高风险" : mod.risk === "medium" ? "中风险" : "低风险"}
                              </span>
                            </div>

                            <p className="re-module-kv">
                              <strong>可吸收机制：</strong>
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
