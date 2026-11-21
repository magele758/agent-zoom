import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  BriefingIngestResult,
  BriefingJournalImportResult,
  CanvasSummary,
  CommercialHeatmap,
  DailyBriefing,
  DailyDigest,
  DailyDigestGroup,
  DeploymentLogEntry,
  DeploymentRecord,
  DeploymentStatus,
  DistributionChannel,
  DistributionChannelResult,
  DistributionRecord,
  DormantMemoryHit,
  FeedbackCategory,
  FeedbackConvertResult,
  FeedbackSeverity,
  FeedbackStatus,
  HeatmapCell,
  HeatmapProjectRow,
  KillSwitchRecord,
  MonthlyCostEntry,
  PaymentCallbackResult,
  PaymentChannel,
  PaymentOrder,
  PaymentStatus,
  PmDecomposedTask,
  PmEvaluation,
  ProjectIslandResult,
  UserFeedback,
  WorkflowTriggerResult,
} from "../metabolism-types.ts";
import { journalRoot, listJournalDays, readJournalDay } from "./company-journal.ts";
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

export type { DormantMemoryHit };

export interface MetabolismHooks {
  createTaskTree?: (input: {
    project: string;
    title: string;
    description: string;
    priority: number;
    tags: string[];
    sourceRef: string;
    subtasks: Array<{ title: string; description: string; priority: number; type: "task" | "bug" | "prd" }>;
  }) => { epicId: string; subtaskIds: string[] };
  addOpportunity?: (input: {
    project: string;
    title: string;
    rationale: string;
    sourceId: string;
    evidence: string[];
    impact: number;
    confidence: number;
    effort: number;
  }) => { id: string };
  listCanvases?: () => Array<{ id: string; name: string }>;
  projectToCanvas?: (
    canvasId: string,
    items: Array<{ id: string; source: string; summary: string; tags: string[]; score?: number | null }>,
  ) => Promise<{ createdNodes: number; semanticEdges: number }>;
  findDormantMemories?: (vector: number[], queryText: string, limit: number) => DormantMemoryHit[];
  readAgentCostsByProjectMonth?: (months: string[]) => Record<string, Record<string, number>>;
  postAlertToZoom?: (input: {
    folder: string;
    title: string;
    body: string;
    choices?: string[];
    externalId: string;
  }) => { taskId: string; messageId: string } | void;
}

export interface MetabolismStoreOptions {
  hooks?: MetabolismHooks;
  fetchImpl?: typeof fetch;
  journalDir?: string;
}

export interface MetabolismRouteOptions extends MetabolismStoreOptions {
  submitToken?: string;
}

// ---- Zod Validation Schemas ----

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式需为 YYYY-MM-DD");
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, "月份格式需为 YYYY-MM");

const ingestSchema = z.object({
  rawContent: z.string().trim().min(1, "请输入原始资讯内容").max(50_000),
  source: z.string().trim().min(1).max(80).default("manual"),
  title: z.string().trim().max(200).optional(),
  date: dateSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const importJournalSchema = z.object({
  day: dateSchema.optional(),
});

const workflowTriggerSchema = z.object({
  workflowId: z.string().trim().max(120).optional(),
  event: z.string().trim().max(120).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const projectIslandSchema = z.object({
  canvasId: z.string().trim().min(1, "请选择目标画布").max(160),
  date: dateSchema.optional(),
});

const pmEvaluateSchema = z.object({
  content: z.string().trim().min(1, "请输入待评估的需求、资讯或想法").max(20_000),
  source: z.string().trim().min(1).max(80).default("manual"),
  project: z.string().trim().min(1).max(160).default("opc-os"),
  autoCreate: z.boolean().optional(),
  threshold: z.number().int().min(1).max(100).optional(),
  alsoAddOpportunity: z.boolean().optional(),
});

const feedbackSchema = z.object({
  project: z.string().trim().min(1, "请填写所属项目").max(160),
  channel: z.string().trim().min(1).max(80).default("in_app"),
  rawText: z.string().trim().min(1, "请输入用户反馈内容").max(10_000),
  autoCreateTask: z.boolean().optional(),
  autoCreateOnHigh: z.boolean().optional(),
});

const paymentOrderSchema = z.object({
  project: z.string().trim().min(1, "请填写所属项目").max(160),
  subject: z.string().trim().min(1, "请填写商品或服务名称").max(200),
  amount: z.number().positive("金额必须大于 0").max(10_000_000),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "币种需为 3 位大写字母")
    .optional(),
  channel: z.enum(["hupijiao", "stripe", "lemonsqueezy"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const distributionChannels = ["wechat", "juejin", "x", "reddit", "newsletter", "telegram"] as const;

const distributionSchema = z.object({
  title: z.string().trim().min(1, "请输入分发标题").max(200),
  content: z.string().trim().min(1, "请输入正文内容").max(40_000),
  channels: z.array(z.enum(distributionChannels)).min(1, "至少勾选一个分发渠道").max(10),
  sourceRef: z.string().trim().max(500).optional().default(""),
});

const deploymentSchema = z.object({
  project: z.string().trim().min(1, "请填写项目名").max(160),
  targetHost: z.string().trim().min(1, "请填写目标主机").max(200),
  dockerImage: z.string().trim().max(300).optional().default(""),
  deployCommand: z.string().trim().max(1000).optional().default(""),
  version: z.string().trim().min(1, "请填写部署版本").max(120),
  envVars: z.record(z.string().trim().min(1).max(120), z.string().max(1000)).optional().default({}),
});

const rollbackSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

const monthlyCostSchema = z.object({
  project: z.string().trim().min(1, "请填写项目名").max(160),
  month: monthSchema,
  amountUsd: z.number().min(0, "成本不能为负数").max(10_000_000),
  category: z.string().trim().min(1).max(80).optional().default("infra"),
  note: z.string().trim().max(500).optional().default(""),
});

const killSwitchStopSchema = z.object({
  reason: z.string().trim().min(1, "请填写熔断原因").max(1000).optional(),
  notifyZoom: z.boolean().optional(),
});

const killSwitchResumeSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

// ---- Utilities ----

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, code = "metabolism_input"): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      code,
      parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`).join(" / "),
    );
  }
  return parsed.data;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function todayDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function recentMonthLabels(count: number, now = new Date()): string[] {
  const n = Math.max(1, Math.min(24, Math.floor(count)));
  const result: string[] = [];
  const baseYear = now.getFullYear();
  const baseMonth = now.getMonth();
  for (let offset = n - 1; offset >= 0; offset--) {
    const dt = new Date(Date.UTC(baseYear, baseMonth - offset, 1));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    result.push(`${y}-${m}`);
  }
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function extractJsonBlock(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

const FX_TO_USD: Record<string, number> = {
  USD: 1,
  CNY: 1 / 7.2,
  RMB: 1 / 7.2,
  EUR: 1.08,
  GBP: 1.27,
  HKD: 1 / 7.8,
  JPY: 1 / 150,
  CAD: 0.73,
  AUD: 0.65,
  SGD: 0.74,
};

export function toUsd(amount: number, currency: string): number {
  const rate = FX_TO_USD[currency.toUpperCase()] ?? 1;
  return round2(amount * rate);
}

// ---- Hupijiao MD5 Signature (Official Xunhupay Convention) ----

export function signHupijiaoParams(
  params: Record<string, string | number | undefined | null>,
  appSecret: string,
): string {
  const canonical = Object.keys(params)
    .filter((k) => k !== "hash" && params[k] !== undefined && params[k] !== null && String(params[k]) !== "")
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join("&");
  return createHash("md5")
    .update(canonical + appSecret, "utf8")
    .digest("hex");
}

export function verifyHupijiaoSignature(payload: Record<string, unknown>, appSecret: string): boolean {
  const supplied = typeof payload.hash === "string" ? payload.hash.trim().toLowerCase() : "";
  if (!supplied) return false;
  const filtered: Record<string, string> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (key === "hash" || val === undefined || val === null || String(val) === "") continue;
    filtered[key] = String(val);
  }
  const expected = signHupijiaoParams(filtered, appSecret).toLowerCase();
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Deterministic Local Engines ----

const TAG_LEXICON: Array<{ tag: string; pattern: RegExp }> = [
  { tag: "AI Agent", pattern: /\b(agent|agents|mcp|multi-agent|subagent|agentic)\b|智能体|多\s*agent/i },
  { tag: "LLM", pattern: /\b(llm|gpt|claude|deepseek|gemini|openai|rag|embedding|prompt|whisper)\b|大模型|向量|推理/i },
  { tag: "商业化", pattern: /\b(saas|mrr|arr|monetiz|pricing|stripe|lemonsqueezy|checkout|revenue|license|b2b)\b|变现|付费|订阅|买断|收款|虎皮椒|毛利|营收|商业化/i },
  { tag: "独立开发", pattern: /\b(indie|solo\s*founder|opc|micro-saas|bootstrapped)\b|独立开发|一人公司|副业|冷启动/i },
  { tag: "浏览器插件", pattern: /\b(chrome\s*extension|browser\s*extension|manifest\s*v3|sidepanel)\b|浏览器插件|插件|扩展/i },
  { tag: "开源生态", pattern: /\b(open\s*source|open-core|github|repo|mit\s*license)\b|开源|仓库/i },
  { tag: "工作流自动化", pattern: /\b(workflow|n8n|webhook|cron|pipeline|ci\/cd|docker|deploy)\b|工作流|自动化|部署|流水线/i },
  { tag: "增长分发", pattern: /\b(gtm|seo|utm|reddit|newsletter|twitter|telegram|wechat|growth|funnel)\b|增长|分发|获客|漏斗|转化|公众号|掘金/i },
  { tag: "知识图谱", pattern: /\b(knowledge\s*graph|canvas|memory|second\s*brain|obsidian|notes)\b|知识画布|沉睡记忆|图谱|复盘|日记/i },
  { tag: "工程架构", pattern: /\b(sqlite|duckdb|rust|typescript|react|hono|postgres|architecture|local-first|offline)\b|架构|离线|本地优先|数据库|性能优化/i },
  { tag: "安全风控", pattern: /\b(security|auth|ed25519|md5|hmac|kill\s*switch|audit|sandbox)\b|安全|验签|熔断|风控|沙盒/i },
  { tag: "产品与反馈", pattern: /\b(feedback|ticket|onboarding|ux|ui|prd|roadmap|retention)\b|反馈|工单|用户体验|需求|立项/i },
];

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "will", "your", "about", "into",
  "more", "when", "what", "which", "their", "there", "been", "were", "also", "just", "than",
  "http", "https", "www", "com", "org", "net", "html",
]);

function cleanPlainText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~>]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function splitSentences(text: string): string[] {
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*+•\d.)\]]+\s*/, "").trim())
    .filter((line) => line.length >= 6);
  const out: string[] = [];
  for (const line of lines) {
    const parts = line
      .split(/(?<=[。！？；!?])|(?<=\.)\s+(?=[A-Z\u4e00-\u9fff0-9])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
    if (parts.length) out.push(...parts);
    else if (line.length >= 6) out.push(line);
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = s.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractTagsLocally(text: string, maxTags = 5): string[] {
  const tags: string[] = [];
  for (const entry of TAG_LEXICON) {
    if (entry.pattern.test(text)) {
      tags.push(entry.tag);
      if (tags.length >= maxTags) return tags;
    }
  }
  // Supplement with high-frequency technical English tokens if we still have room
  if (tags.length < maxTags) {
    const counts = new Map<string, number>();
    const tokens = text.match(/[A-Za-z][A-Za-z0-9.+-]{2,20}/g) ?? [];
    for (const t of tokens) {
      const low = t.toLowerCase();
      if (STOP_WORDS.has(low)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [token] of sorted) {
      if (tags.length >= maxTags) break;
      if (!tags.some((existing) => existing.toLowerCase() === token.toLowerCase())) {
        tags.push(token);
      }
    }
  }
  if (tags.length === 0) tags.push("综合观察");
  return tags.slice(0, maxTags);
}

interface LocalBriefingAnalysis {
  title: string;
  summary: string;
  corePoints: string[];
  tags: string[];
  score: number;
  scoreReason: string;
}

function analyzeBriefingLocally(rawContent: string, source: string, explicitTitle?: string): LocalBriefingAnalysis {
  const headingMatch = rawContent.match(/^\s*#{1,3}\s+(.+)$/m);
  const plain = cleanPlainText(rawContent);
  const sentences = splitSentences(plain);

  const derivedTitle = (
    explicitTitle?.trim() ||
    headingMatch?.[1]?.trim() ||
    sentences[0] ||
    plain.slice(0, 64) ||
    "未命名资讯简报"
  )
    .replace(/\s+/g, " ")
    .slice(0, 96);

  const tags = extractTagsLocally(`${derivedTitle}\n${plain}`, 5);

  const signalRegex =
    /(\d+[%$x倍万亿]|\$\d+|¥\d+|架构|方案|开源|变现|转化|效率|成本|自动化|离线|插件|模型|Agent|API|SDK|Webhook|License|SQLite|benchmark|open\s*source|workflow|revenue|pricing)/i;

  const scoredSentences = sentences.map((sentence, idx) => {
    let s = 10;
    if (sentence.length >= 20 && sentence.length <= 180) s += 14;
    else if (sentence.length > 180) s += 6;
    if (signalRegex.test(sentence)) s += 16;
    if (idx === 0) s += 8;
    if (idx === sentences.length - 1 && sentences.length > 2) s += 5;
    for (const t of tags) {
      if (sentence.toLowerCase().includes(t.toLowerCase())) s += 4;
    }
    return { sentence, score: s, idx };
  });

  scoredSentences.sort((a, b) => b.score - a.score || a.idx - b.idx);

  let corePoints = scoredSentences
    .slice(0, 3)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.sentence.slice(0, 180));

  if (corePoints.length < 3) {
    // Try splitting by commas/clauses for dense single-sentence inputs
    const clauses = plain
      .split(/[，,、；;]/)
      .map((c) => c.trim())
      .filter((c) => c.length >= 8);
    for (const clause of clauses) {
      if (corePoints.length >= 3) break;
      if (!corePoints.some((p) => p.includes(clause) || clause.includes(p))) {
        corePoints.push(clause.slice(0, 180));
      }
    }
  }
  while (corePoints.length < 3) {
    if (corePoints.length === 0) corePoints.push(derivedTitle);
    else if (corePoints.length === 1) corePoints.push(`主题聚焦于 ${tags.slice(0, 3).join(" / ")} 方向`);
    else corePoints.push(`来源 ${source}，可进一步评估与现有产品线的联动价值`);
  }
  corePoints = corePoints.slice(0, 3);

  const summary =
    sentences.length >= 2
      ? `${sentences[0].slice(0, 130)} ${sentences[1].slice(0, 110)}`.trim()
      : plain.slice(0, 220) || derivedTitle;

  // Score calculation (0-100)
  let score = 44;
  const reasons: string[] = [];

  const matchedDomains = TAG_LEXICON.filter((e) => e.pattern.test(plain)).length;
  if (matchedDomains >= 3) {
    score += 20;
    reasons.push(`跨 ${matchedDomains} 个核心技术/商业维度`);
  } else if (matchedDomains >= 1) {
    score += 12;
    reasons.push(`命中 ${matchedDomains} 个核心关注领域`);
  }

  const quantMatches = plain.match(/(\d+(?:\.\d+)?%|\$\d+(?:\.\d+)?|¥\d+(?:\.\d+)?|\d+\s*(?:ms|s|x|倍|万|亿|天|周|月|年|美元|元))/gi) ?? [];
  if (quantMatches.length >= 2) {
    score += 13;
    reasons.push("含多项量化指标/数据支撑");
  } else if (quantMatches.length === 1) {
    score += 7;
    reasons.push("含具体数据指标");
  }

  if (plain.length >= 200 && sentences.length >= 3) {
    score += 11;
    reasons.push("信息密度与结构完整");
  } else if (plain.length >= 80) {
    score += 6;
    reasons.push("上下文较为完整");
  } else if (plain.length < 40) {
    score -= 14;
    reasons.push("原文偏短，信息量有限");
  }

  if (/^(github|hackernews|journal|arxiv|rss|x|reddit)$/i.test(source)) {
    score += 6;
    reasons.push(`高信噪比来源(${source})`);
  }

  if (/(落地|实践|架构|变现|源码|开源|案例|benchmark|architecture|case\s*study|open\s*source|monetiz)/i.test(plain)) {
    score += 6;
    reasons.push("具备可执行/可借鉴落地信号");
  }

  const finalScore = clamp(score, 12, 98);
  const scoreReason = reasons.length ? reasons.join("；") : "常规资讯线索，建议结合项目节奏持续观察";

  return {
    title: derivedTitle,
    summary,
    corePoints,
    tags,
    score: finalScore,
    scoreReason,
  };
}

interface LocalPmAnalysis {
  technicalScore: number;
  commercialScore: number;
  combinedScore: number;
  taskTitle: string;
  reasoning: string;
  decomposedTasks: PmDecomposedTask[];
}

function evaluatePmLocally(content: string, project: string): LocalPmAnalysis {
  const plain = cleanPlainText(content);
  const len = plain.length;

  const techPositive: RegExp[] = [
    /\b(chrome|extension|plugin|sidepanel)\b|插件|扩展/i,
    /\b(api|webhook|sdk|mcp|rest|graphql)\b|接口/i,
    /\b(sqlite|duckdb|postgres|local-first|offline)\b|离线|本地/i,
    /\b(typescript|react|node|python|cli|bot|script)\b|脚本|桌面|网页/i,
    /\b(mvp|prototype|2\s*weeks?|1\s*week|lightweight)\b|两周|2周|一周|轻量|快速/i,
    /\b(workflow|automation|pipeline|docker|deploy|sync)\b|自动化|工作流|同步|部署/i,
    /\b(whisper|llm|embedding|ocr|tts|pdf|markdown)\b|字幕|语音|配音|识别|导出/i,
  ];
  const techHeavyPenalty =
    /(万亿参数|从零训练大模型|自建机房|芯片流片|火箭|医院临床|银行牌照|重写操作系统内核|train\s+from\s+scratch\s+1t|build\s+custom\s+silicon|launch\s+satellite)/i;
  const vaguePenalty = /(随便|不知道|想想看|以后再说|好玩而已|待定|whatever|maybe\s+someday|idk|just\s+an\s+idea|random\s+stuff)/i;

  const commercialPositive: RegExp[] = [
    /\b(pricing|paid|subscription|buyout|pro\s+plan|freemium)\b|付费|订阅|买断|年付|月付|定价|pro/i,
    /\b(stripe|lemonsqueezy|checkout|payment|billing|invoice)\b|收款|虎皮椒|支付|收银/i,
    /\b(license|ed25519|activation|seat|tier)\b|授权|激活码/i,
    /(\$\d+|¥\d+|\d+美元|\d+元\/|\b(?:mrr|arr|roi|ltv|cac|b2b|saas)\b)|变现|营收|毛利|客单|转化/i,
    /(痛点|刚需|高频|节省时间|效率提升|降本增效|用户愿意付|付费意愿|\b(?:pain\s*point|willing\s*to\s*pay|high\s*intent|urgent)\b)/i,
    /(跨境|电商|开发者|独立开发|外语学习|内容创作|团队协作|客服|企业|\b(?:developer|creator|ecommerce|enterprise|team|freelancer)\b)/i,
  ];
  const nonCommercialPenalty = /(纯公益|完全免费无变现|不收费|自娱自乐|随便玩玩|no\s+monetization|just\s+for\s+fun|never\s+charge)/i;

  let tech = 46;
  const techHits = techPositive.filter((rx) => rx.test(plain)).length;
  tech += Math.min(34, techHits * 7);
  if (len >= 90) tech += 12;
  else if (len >= 45) tech += 7;
  else if (len < 25) tech -= 20;
  if (/(步骤|架构|实现|模块|输入|输出|基于|通过|集成|\b(?:step|module|architecture|based\s+on|via|integrate)\b)/i.test(plain)) {
    tech += 6;
  }
  if (techHeavyPenalty.test(plain)) tech -= 40;
  if (vaguePenalty.test(plain)) tech -= 18;

  let comm = 40;
  const commHits = commercialPositive.filter((rx) => rx.test(plain)).length;
  comm += Math.min(44, commHits * 9);
  if (len >= 90) comm += 10;
  else if (len >= 45) comm += 5;
  else if (len < 25) comm -= 20;
  if (nonCommercialPenalty.test(plain)) comm -= 32;
  if (vaguePenalty.test(plain)) comm -= 18;

  const technicalScore = clamp(tech, 10, 98);
  const commercialScore = clamp(comm, 10, 98);
  const combinedScore = Math.round((technicalScore + commercialScore) / 2);

  const firstSentence = (splitSentences(plain)[0] || plain).replace(/\s+/g, " ").trim();
  const baseLabel = firstSentence.slice(0, 52);
  const taskTitle = `[${project}] ${baseLabel}${firstSentence.length > 52 ? "…" : ""}`;

  const isBugSignal = /(bug|崩溃|报错|失败|修复|crash|error|fix)/i.test(plain);
  const decomposedTasks: PmDecomposedTask[] = [
    {
      title: `PRD 与 MVP 范围界定：${baseLabel.slice(0, 36)}`,
      description: `明确「${baseLabel}」的目标用户画像、核心验收指标、收费切入点与 2 周最小可行版本边界。`,
      priority: 9,
      type: "prd",
    },
    {
      title: `核心能力与数据/接口实现（${project}）`,
      description: `实现核心业务逻辑、本地/远端数据结构及关键 API/自动化集成，确保离线兜底与异常可观测。`,
      priority: 8,
      type: isBugSignal ? "bug" : "task",
    },
    {
      title: `交互界面与商业化闭环接入`,
      description: `构建前端操作台与关键状态反馈，接入支付/授权/指标埋点，验证端到端用户转化路径。`,
      priority: 7,
      type: "task",
    },
    {
      title: `自动化测试、灰度验收与首发分发`,
      description: `补充核心单测与端到端回归，完成部署配置与多渠道首发推广素材准备。`,
      priority: 6,
      type: "task",
    },
  ];

  const techVerdict =
    technicalScore >= 80
      ? "技术路径清晰、组件边界明确，单人+Agent 团队可在 2 周内交付 MVP"
      : technicalScore >= 60
        ? "具备可行性，但部分技术细节与范围仍需进一步收敛"
        : "需求过于宽泛或工程复杂度远超 2 周周期，暂不建议直接开工";
  const commVerdict =
    commercialScore >= 80
      ? "付费场景与目标客群明确，具备清晰的变现路径与商业转化潜力"
      : commercialScore >= 60
        ? "存在一定用户痛点，但定价模型与获客转化路径仍待验证"
        : "缺乏明确商业买单方或变现抓手，ROI 风险较高";

  const reasoning = `技术可行性 ${technicalScore}/100（${techVerdict}）；商业潜力 ${commercialScore}/100（${commVerdict}）。综合评分 ${combinedScore}/100。`;

  return {
    technicalScore,
    commercialScore,
    combinedScore,
    taskTitle,
    reasoning,
    decomposedTasks,
  };
}

interface LocalFeedbackAnalysis {
  extractedAction: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  priority: number;
}

function analyzeFeedbackLocally(project: string, rawText: string): LocalFeedbackAnalysis {
  const plain = cleanPlainText(rawText);
  const concise = (splitSentences(plain)[0] || plain).slice(0, 90);

  let category: FeedbackCategory = "feature";
  if (/(支付|付款|退款|订阅|扣款|发票|账单|激活码|授权|license|billing|payment|stripe|refund|charge|checkout)/i.test(plain)) {
    category = "billing";
  } else if (/(报错|崩溃|失败|无法|卡死|白屏|闪退|丢失|异常|打不开|不生效|bug|crash|error|fail|broken|500|404)/i.test(plain)) {
    category = "bug";
  } else if (/(界面|样式|按钮|难用|交互|卡顿|慢|手机|移动端|排版|太复杂|繁琐|看不清|ui|ux|slow|layout|confusing|responsive)/i.test(plain)) {
    category = "ux";
  }

  let severity: FeedbackSeverity = "low";
  if (
    /(崩溃|闪退|无法使用|白屏|数据丢失|扣款失败|重复扣款|支付失败|阻断|严重|紧急|安全漏洞|crash|blocker|data\s*loss|critical|urgent|500)/i.test(
      plain,
    ) ||
    (category === "billing" && /(失败|报错|无法|没收到|重复|异常|fail|error|double)/i.test(plain))
  ) {
    severity = "high";
  } else if (category === "bug" || category === "billing" || /(经常|每次|很慢|影响|无法|broken|slow)/i.test(plain)) {
    severity = "medium";
  }

  let priority = 4;
  if (severity === "high") priority = category === "billing" ? 10 : 9;
  else if (severity === "medium") priority = category === "bug" || category === "billing" ? 7 : 6;
  else priority = category === "feature" ? 5 : 4;

  const prefixMap: Record<FeedbackCategory, string> = {
    bug: `修复 [${project}] 故障`,
    billing: `排查 [${project}] 支付/授权问题`,
    ux: `优化 [${project}] 交互体验`,
    feature: `实现 [${project}] 用户需求`,
  };
  const extractedAction = `${prefixMap[category]}：${concise}`;

  return { extractedAction, category, severity, priority };
}

function adaptContentForChannel(channel: DistributionChannel, title: string, content: string, sourceRef: string): string {
  const plain = cleanPlainText(content);
  const sentences = splitSentences(plain);
  const highlights = (sentences.length ? sentences : [plain]).slice(0, 3);
  const tags = extractTagsLocally(`${title}\n${plain}`, 4);
  const refLine = sourceRef ? `\n参考链接：${sourceRef}` : "";

  switch (channel) {
    case "wechat":
      return [
        `【${title}】`,
        "",
        `导语：${highlights[0] ?? plain.slice(0, 120)}`,
        "",
        "一、核心看点",
        ...highlights.map((h, i) => `${i + 1}. ${h}`),
        "",
        "二、深度正文",
        plain,
        refLine,
        "",
        "——",
        `标签：${tags.map((t) => `#${t}`).join(" ")}`,
        "如果这篇实践对你有启发，欢迎点个「在看」并转发给正在探索一人公司与 AI 工程的朋友。",
      ]
        .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
        .join("\n");

    case "juejin":
      return [
        `# ${title}`,
        "",
        `> TL;DR：${highlights[0] ?? plain.slice(0, 140)}`,
        "",
        "## 关键要点",
        ...highlights.map((h) => `- ${h}`),
        "",
        "## 实践与细节",
        content.trim(),
        sourceRef ? `\n## 相关仓库 / 原文\n${sourceRef}` : "",
        "",
        `标签：${tags.join(" / ")}`,
      ]
        .filter(Boolean)
        .join("\n");

    case "x": {
      const tweet1 = `1/4 ${title}\n\n${(highlights[0] ?? plain).slice(0, 175)}`;
      const tweet2 = `2/4 核心拆解：\n• ${(highlights[1] ?? highlights[0] ?? plain).slice(0, 210)}`;
      const tweet3 = `3/4 关键落地：\n• ${(highlights[2] ?? (plain.slice(120, 320) || title)).slice(0, 210)}`;
      const tweet4 = `4/4 总结与讨论：欢迎留言交流你的实践经验。${sourceRef ? `\n${sourceRef}` : ""}\n${tags
        .slice(0, 3)
        .map((t) => `#${t.replace(/\s+/g, "")}`)
        .join(" ")}`;
      return [tweet1, "---", tweet2, "---", tweet3, "---", tweet4].join("\n");
    }

    case "reddit":
      return [
        `Title: [Share & Discussion] ${title}`,
        "",
        `Hey everyone — sharing a quick write-up from our solo-builder workflow:`,
        "",
        "**TL;DR**",
        ...highlights.map((h) => `* ${h}`),
        "",
        "**Details**",
        plain.slice(0, 1500),
        sourceRef ? `\n**Link / Reference:** ${sourceRef}` : "",
        "",
        "Curious how others here are handling this in practice — open to feedback and edge cases!",
      ]
        .filter(Boolean)
        .join("\n");

    case "newsletter":
      return [
        `Subject: [OPC Weekly] ${title}`,
        "",
        "Hi 朋友，",
        "",
        `本期为你整理一条值得立刻关注的一线实践：**${title}**。`,
        "",
        "### 本期 3 个核心信号",
        ...highlights.map((h, i) => `${i + 1}. ${h}`),
        "",
        "### 完整内容",
        plain,
        sourceRef ? `\n延伸阅读：${sourceRef}` : "",
        "",
        "祝本周产出顺利，\nOPC OS 信息代谢中枢",
      ].join("\n");

    case "telegram":
      return [
        `⚡ **${title}**`,
        "",
        ...highlights.map((h) => `▪ ${h.slice(0, 140)}`),
        sourceRef ? `\n🔗 ${sourceRef}` : "",
        "",
        tags.map((t) => `#${t.replace(/\s+/g, "_")}`).join(" "),
      ]
        .filter(Boolean)
        .join("\n");
  }
}

// ---- Row Types & Mappers ----

interface BriefingRow {
  id: string;
  date: string;
  source: string;
  title: string;
  raw_content: string;
  summary: string;
  core_points: string;
  tags: string;
  score: number;
  score_reason: string;
  embedding: string;
  metadata: string;
  created_at: string;
}

function mapBriefing(row: BriefingRow, activatedMemories?: DormantMemoryHit[]): DailyBriefing {
  return {
    id: row.id,
    date: row.date,
    source: row.source,
    title: row.title,
    rawContent: row.raw_content,
    summary: row.summary,
    corePoints: safeJsonParse<string[]>(row.core_points, []),
    tags: safeJsonParse<string[]>(row.tags, []),
    score: Number(row.score),
    scoreReason: row.score_reason,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    ...(activatedMemories ? { activatedMemories } : {}),
  };
}

interface PmRow {
  id: string;
  source: string;
  project: string;
  content: string;
  technical_score: number;
  commercial_score: number;
  combined_score: number;
  threshold: number;
  action: string;
  task_title: string;
  reasoning: string;
  decomposed_tasks: string;
  epic_task_id: string | null;
  opportunity_id: string | null;
  created_at: string;
}

function mapPmEvaluation(row: PmRow, subtaskIds: string[] = [], engine: "llm" | "local" = "local"): PmEvaluation {
  return {
    id: row.id,
    source: row.source,
    project: row.project,
    content: row.content,
    technicalScore: Number(row.technical_score),
    commercialScore: Number(row.commercial_score),
    combinedScore: Number(row.combined_score),
    threshold: Number(row.threshold),
    action: row.action === "created" ? "created" : "no_action",
    taskTitle: row.task_title,
    reasoning: row.reasoning,
    decomposedTasks: safeJsonParse<PmDecomposedTask[]>(row.decomposed_tasks, []),
    epicTaskId: row.epic_task_id,
    subtaskIds,
    opportunityId: row.opportunity_id,
    engine,
    createdAt: row.created_at,
  };
}

interface FeedbackRow {
  id: string;
  project: string;
  channel: string;
  raw_text: string;
  extracted_action: string;
  category: string;
  priority: number;
  severity: string;
  status: string;
  generated_task_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapFeedback(row: FeedbackRow): UserFeedback {
  return {
    id: row.id,
    project: row.project,
    channel: row.channel,
    rawText: row.raw_text,
    extractedAction: row.extracted_action,
    category: (["bug", "feature", "ux", "billing"].includes(row.category) ? row.category : "feature") as FeedbackCategory,
    priority: Number(row.priority),
    severity: (["high", "medium", "low"].includes(row.severity) ? row.severity : "medium") as FeedbackSeverity,
    status: (["open", "triaged", "converted", "resolved"].includes(row.status) ? row.status : "triaged") as FeedbackStatus,
    generatedTaskId: row.generated_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PaymentRow {
  id: string;
  project: string;
  channel: string;
  amount: number;
  currency: string;
  subject: string;
  out_trade_no: string;
  transaction_id: string | null;
  status: string;
  pay_url: string;
  metadata: string;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapPayment(row: PaymentRow): PaymentOrder {
  const metadata = safeJsonParse<Record<string, unknown>>(row.metadata, {});
  return {
    id: row.id,
    project: row.project,
    channel: (["hupijiao", "stripe", "lemonsqueezy"].includes(row.channel) ? row.channel : "hupijiao") as PaymentChannel,
    amount: Number(row.amount),
    currency: row.currency,
    subject: row.subject,
    outTradeNo: row.out_trade_no,
    transactionId: row.transaction_id,
    status: (["pending", "paid", "failed", "refunded"].includes(row.status) ? row.status : "pending") as PaymentStatus,
    payUrl: row.pay_url,
    sandbox: Boolean(metadata.sandbox),
    metadata,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DistributionRow {
  id: string;
  title: string;
  source_ref: string;
  channels: string;
  adapted_payload: string;
  status: string;
  results: string;
  created_at: string;
}

function mapDistribution(row: DistributionRow): DistributionRecord {
  return {
    id: row.id,
    title: row.title,
    sourceRef: row.source_ref,
    channels: safeJsonParse<string[]>(row.channels, []),
    adaptedPayload: safeJsonParse<Record<string, string>>(row.adapted_payload, {}),
    status: (["sent", "partial", "draft_ready", "failed"].includes(row.status)
      ? row.status
      : "draft_ready") as DistributionRecord["status"],
    results: safeJsonParse<Record<string, DistributionChannelResult>>(row.results, {}),
    createdAt: row.created_at,
  };
}

interface DeploymentRow {
  id: string;
  project: string;
  target_host: string;
  docker_image: string;
  deploy_command: string;
  version: string;
  env_vars: string;
  status: string;
  logs: string;
  deployed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapDeployment(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    project: row.project,
    targetHost: row.target_host,
    dockerImage: row.docker_image,
    deployCommand: row.deploy_command,
    version: row.version,
    envVars: safeJsonParse<Record<string, string>>(row.env_vars, {}),
    status: (["configured", "deploying", "deployed", "rolled_back", "failed"].includes(row.status)
      ? row.status
      : "configured") as DeploymentStatus,
    logs: safeJsonParse<DeploymentLogEntry[]>(row.logs, []),
    deployedAt: row.deployed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface KillSwitchRow {
  project: string;
  status: string;
  consecutive_loss_months: number;
  cumulative_loss_usd: number;
  reason: string;
  triggered_at: string | null;
  resumed_at: string | null;
  updated_at: string;
}

function mapKillSwitch(row: KillSwitchRow): KillSwitchRecord {
  return {
    project: row.project,
    status: row.status === "stopped" ? "stopped" : "active",
    consecutiveLossMonths: Number(row.consecutive_loss_months),
    cumulativeLossUsd: Number(row.cumulative_loss_usd),
    reason: row.reason,
    triggeredAt: row.triggered_at,
    resumedAt: row.resumed_at,
    updatedAt: row.updated_at,
  };
}

// ---- Journal Markdown Section Parser ----

function splitJournalSections(markdown: string, fallbackDay: string): Array<{ title: string; content: string }> {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  let inFence = false;

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    const hMatch = !inFence ? raw.match(/^(#{2,3})\s+(.+?)\s*#*$/) : null;
    if (hMatch) {
      if (current && current.lines.join("\n").trim().length >= 16) {
        sections.push(current);
      }
      current = { title: hMatch[2].trim().slice(0, 140), lines: [] };
    } else if (current) {
      current.lines.push(raw);
    }
  }
  if (current && current.lines.join("\n").trim().length >= 16) {
    sections.push(current);
  }

  if (sections.length > 0) {
    return sections.map((s) => ({
      title: s.title,
      content: `${s.title}\n\n${s.lines.join("\n").trim()}`,
    }));
  }

  const trimmed = markdown.trim();
  if (!trimmed) return [];
  const h1 = trimmed.match(/^#\s+(.+)$/m)?.[1]?.trim() || `${fallbackDay} 每日技术复盘`;
  return [{ title: h1.slice(0, 140), content: trimmed }];
}

// ---- Main Store ----

export class MetabolismStore {
  private readonly fetchImpl: typeof fetch;
  private readonly hooks: MetabolismHooks;

  constructor(
    private readonly db: DatabaseSync,
    private readonly providers: ProvidersStore,
    private readonly options: MetabolismStoreOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.hooks = options.hooks ?? {};
    this.initTables();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_daily_briefings (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        summary TEXT NOT NULL,
        core_points TEXT NOT NULL,
        tags TEXT NOT NULL,
        score INTEGER NOT NULL,
        score_reason TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_briefings_date ON opc_daily_briefings(date DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS opc_pm_evaluations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        project TEXT NOT NULL,
        content TEXT NOT NULL,
        technical_score INTEGER NOT NULL,
        commercial_score INTEGER NOT NULL,
        combined_score INTEGER NOT NULL,
        threshold INTEGER NOT NULL,
        action TEXT NOT NULL,
        task_title TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        decomposed_tasks TEXT NOT NULL,
        epic_task_id TEXT,
        opportunity_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_pm_created ON opc_pm_evaluations(created_at DESC);

      CREATE TABLE IF NOT EXISTS opc_user_feedback (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        channel TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        extracted_action TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        generated_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_feedback_project ON opc_user_feedback(project, created_at DESC);

      CREATE TABLE IF NOT EXISTS opc_payments (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        channel TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        subject TEXT NOT NULL,
        out_trade_no TEXT NOT NULL UNIQUE,
        transaction_id TEXT,
        status TEXT NOT NULL,
        pay_url TEXT NOT NULL,
        metadata TEXT NOT NULL,
        paid_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_payments_project ON opc_payments(project, created_at DESC);

      CREATE TABLE IF NOT EXISTS opc_distributions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        channels TEXT NOT NULL,
        adapted_payload TEXT NOT NULL,
        status TEXT NOT NULL,
        results TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_deployments (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        target_host TEXT NOT NULL,
        docker_image TEXT NOT NULL,
        deploy_command TEXT NOT NULL,
        version TEXT NOT NULL,
        env_vars TEXT NOT NULL,
        status TEXT NOT NULL,
        logs TEXT NOT NULL,
        deployed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_deployments_project ON opc_deployments(project, updated_at DESC);

      CREATE TABLE IF NOT EXISTS opc_kill_switches (
        project TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        consecutive_loss_months INTEGER NOT NULL,
        cumulative_loss_usd REAL NOT NULL,
        reason TEXT NOT NULL,
        triggered_at TEXT,
        resumed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_monthly_costs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        month TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        category TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opc_monthly_costs_pm ON opc_monthly_costs(project, month);
    `);
  }

  private hasTable(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  }

  listCanvases(): CanvasSummary[] {
    return this.hooks.listCanvases ? this.hooks.listCanvases() : [];
  }

  // =========================================================================
  // 1. Information Metabolism & Daily Briefing (3C.1 - 3C.4)
  // =========================================================================

  private searchDormantMemories(
    vector: number[],
    queryText: string,
    excludeBriefingId?: string,
    limit = 6,
  ): DormantMemoryHit[] {
    const hits: DormantMemoryHit[] = [];
    const seen = new Set<string>();
    const minSim = 0.22;

    const pushHit = (hit: DormantMemoryHit) => {
      const key = `${hit.kind}:${hit.id}`;
      if (seen.has(key) || hit.similarity < minSim) return;
      seen.add(key);
      hits.push({ ...hit, similarity: round4(hit.similarity) });
    };

    // 1. External hook (e.g. Knowledge Canvas nodes & Company Ideas)
    if (this.hooks.findDormantMemories) {
      const external = this.hooks.findDormantMemories(vector, queryText, limit);
      for (const hit of external) pushHit(hit);
    }

    // 2. Historical briefings stored in SQLite
    const rows = this.db
      .prepare("SELECT id, title, date, embedding FROM opc_daily_briefings ORDER BY created_at DESC LIMIT 300")
      .all() as Array<{ id: string; title: string; date: string; embedding: string }>;
    for (const row of rows) {
      if (excludeBriefingId && row.id === excludeBriefingId) continue;
      const emb = safeJsonParse<number[]>(row.embedding, []);
      if (!emb.length) continue;
      let sim = 0;
      if (emb.length === vector.length) {
        sim = cosineSimilarity(vector, emb);
      } else {
        // Dimension mismatch fallback (e.g. remote vs local vector)
        const vLocal = localSemanticVector(queryText, LOCAL_VECTOR_DIMENSIONS);
        const rLocal = localSemanticVector(row.title, LOCAL_VECTOR_DIMENSIONS);
        sim = cosineSimilarity(vLocal, rLocal);
      }
      if (sim >= minSim) {
        pushHit({
          id: row.id,
          kind: "briefing",
          title: `[${row.date}] ${row.title}`,
          href: `#metabolism?briefing=${encodeURIComponent(row.id)}`,
          similarity: sim,
        });
      }
    }

    // 3. Local company_notes fallback if table exists
    if (this.hasTable("company_notes")) {
      try {
        const localQueryVec =
          vector.length === LOCAL_VECTOR_DIMENSIONS
            ? vector
            : localSemanticVector(queryText, LOCAL_VECTOR_DIMENSIONS);
        const notes = this.db
          .prepare("SELECT id, kind, title, body FROM company_notes ORDER BY rowid DESC LIMIT 200")
          .all() as Array<{ id: string; kind: string; title: string; body: string }>;
        for (const note of notes) {
          const noteVec = localSemanticVector(`${note.title}\n${note.body}`, LOCAL_VECTOR_DIMENSIONS);
          const sim = cosineSimilarity(localQueryVec, noteVec);
          if (sim >= 0.28) {
            pushHit({
              id: note.id,
              kind: "company_idea",
              title: note.title,
              href: `#ideas?idea=${encodeURIComponent(note.id)}`,
              similarity: sim,
            });
          }
        }
      } catch {
        // Ignore if schema differs
      }
    }

    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, limit);
  }

  async ingestBriefing(rawInput: unknown): Promise<BriefingIngestResult> {
    const input = parseOrThrow(ingestSchema, rawInput, "briefing_input");
    const targetDate = input.date ?? todayDate();
    const cfg = this.providers.get();

    const local = analyzeBriefingLocally(input.rawContent, input.source, input.title);
    let analysis: LocalBriefingAnalysis = local;
    let engine: "llm" | "local" = "local";

    const llmRes = await callConfiguredLLM(
      `请对以下来自「${input.source}」的原始资讯进行信息代谢清洗，严格输出 JSON 对象，包含字段：
- title (string, <=80字精炼标题)
- summary (string, 1-2句摘要)
- corePoints (string[], 精确3条核心观点)
- tags (string[], 最多5个关键词标签)
- score (number, 0-100 信息价值分)
- scoreReason (string, 一句话评分依据)

原始资讯：
${input.rawContent.slice(0, 6000)}`,
      {
        system: "你是 OPC OS 信息代谢引擎，只输出合法 JSON，不输出多余解释。",
        maxTokens: 900,
        config: cfg,
        fetchImpl: this.fetchImpl,
      },
    );

    if (llmRes.ok) {
      const parsed = extractJsonBlock(llmRes.text);
      if (parsed) {
        const corePoints = Array.isArray(parsed.corePoints)
          ? parsed.corePoints.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
          : [];
        const tags = Array.isArray(parsed.tags)
          ? parsed.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
          : [];
        const score = Number(parsed.score);
        if (corePoints.length >= 1 && Number.isFinite(score)) {
          analysis = {
            title: input.title?.trim() || String(parsed.title || local.title).trim().slice(0, 120),
            summary: String(parsed.summary || local.summary).trim().slice(0, 500),
            corePoints: corePoints.length === 3 ? corePoints : [...corePoints, ...local.corePoints].slice(0, 3),
            tags: tags.length ? tags : local.tags,
            score: clamp(score, 0, 100),
            scoreReason: String(parsed.scoreReason || local.scoreReason).trim().slice(0, 300),
          };
          engine = "llm";
        }
      }
    }

    const vectorText = `${analysis.title}\n${analysis.summary}\n${analysis.corePoints.join(" ")}\n${analysis.tags.join(" ")}\n${input.rawContent.slice(0, 1500)}`;
    const vecRes = await computeSemanticVector(vectorText, cfg, this.fetchImpl);

    const id = randomUUID();
    const createdAt = nowIso();
    const metadata = { ...(input.metadata ?? {}), engine, vectorSource: vecRes.source };

    const activatedMemories = this.searchDormantMemories(vecRes.vector, vectorText, id, 6);

    this.db
      .prepare(
        `INSERT INTO opc_daily_briefings
         (id, date, source, title, raw_content, summary, core_points, tags, score, score_reason, embedding, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        targetDate,
        input.source,
        analysis.title,
        input.rawContent,
        analysis.summary,
        JSON.stringify(analysis.corePoints),
        JSON.stringify(analysis.tags),
        analysis.score,
        analysis.scoreReason,
        JSON.stringify(vecRes.vector),
        JSON.stringify(metadata),
        createdAt,
      );

    const briefing: DailyBriefing = {
      id,
      date: targetDate,
      source: input.source,
      title: analysis.title,
      rawContent: input.rawContent,
      summary: analysis.summary,
      corePoints: analysis.corePoints,
      tags: analysis.tags,
      score: analysis.score,
      scoreReason: analysis.scoreReason,
      metadata,
      createdAt,
      activatedMemories,
    };

    return { briefing, activatedMemories, engine, vectorSource: vecRes.source };
  }

  async importFromJournal(rawDay?: string): Promise<BriefingJournalImportResult> {
    const parsed = parseOrThrow(importJournalSchema, rawDay ? { day: rawDay } : {}, "journal_import_input");
    const root = this.options.journalDir || journalRoot();
    const listed = await listJournalDays(root);

    if (!listed.available || listed.days.length === 0) {
      if (parsed.day) {
        throw new ApiError(404, "journal_unavailable", "本机未找到 daily-review-learning 目录或对应日期的日记文件。");
      }
      return {
        day: todayDate(),
        imported: 0,
        skipped: 0,
        availableDays: [],
        items: [],
      };
    }

    const targetDay = parsed.day ?? listed.days[0];
    const journal = await readJournalDay(root, targetDay);
    const sections = splitJournalSections(journal.markdown, targetDay);

    const existsStmt = this.db.prepare(
      "SELECT id FROM opc_daily_briefings WHERE source='journal' AND title=? AND date=? LIMIT 1",
    );

    const items: DailyBriefing[] = [];
    let imported = 0;
    let skipped = 0;

    for (const sec of sections) {
      const existing = existsStmt.get(sec.title, targetDay) as { id?: string } | undefined;
      if (existing?.id) {
        skipped += 1;
        continue;
      }
      const res = await this.ingestBriefing({
        rawContent: sec.content,
        source: "journal",
        title: sec.title,
        date: targetDay,
        metadata: { journalFile: `${targetDay}.md` },
      });
      items.push(res.briefing);
      imported += 1;
    }

    return {
      day: targetDay,
      imported,
      skipped,
      availableDays: listed.days,
      items,
    };
  }

  listBriefings(opts: { date?: string; limit?: number } = {}): DailyBriefing[] {
    const limit = clamp(opts.limit ?? 50, 1, 200);
    if (opts.date) {
      parseOrThrow(dateSchema, opts.date, "briefing_date");
      const rows = this.db
        .prepare("SELECT * FROM opc_daily_briefings WHERE date=? ORDER BY score DESC, created_at DESC LIMIT ?")
        .all(opts.date, limit) as unknown as BriefingRow[];
      return rows.map((r) => mapBriefing(r));
    }
    const rows = this.db
      .prepare("SELECT * FROM opc_daily_briefings ORDER BY date DESC, created_at DESC LIMIT ?")
      .all(limit) as unknown as BriefingRow[];
    return rows.map((r) => mapBriefing(r));
  }

  getTodayBriefings(): DailyBriefing[] {
    return this.listBriefings({ date: todayDate(), limit: 100 });
  }

  deleteBriefing(id: string): { deleted: boolean; id: string } {
    const res = this.db.prepare("DELETE FROM opc_daily_briefings WHERE id=?").run(id);
    if (!res.changes) throw new ApiError(404, "briefing_not_found", "找不到对应的每日简报记录。");
    return { deleted: true, id };
  }

  activateDormantMemories(briefingId: string, limit = 6): { briefingId: string; memories: DormantMemoryHit[] } {
    const row = this.db
      .prepare("SELECT * FROM opc_daily_briefings WHERE id=?")
      .get(briefingId) as BriefingRow | undefined;
    if (!row) throw new ApiError(404, "briefing_not_found", "找不到对应的简报记录。");
    let vec = safeJsonParse<number[]>(row.embedding, []);
    const queryText = `${row.title}\n${row.summary}\n${row.raw_content.slice(0, 1000)}`;
    if (!vec.length) vec = localSemanticVector(queryText, LOCAL_VECTOR_DIMENSIONS);
    const memories = this.searchDormantMemories(vec, queryText, briefingId, clamp(limit, 1, 20));
    return { briefingId, memories };
  }

  generateDailyDigest(date?: string): DailyDigest {
    const targetDate = date ? parseOrThrow(dateSchema, date, "digest_date") : todayDate();
    const items = this.listBriefings({ date: targetDate, limit: 200 });

    const tagCounts = new Map<string, number>();
    const grouped = new Map<string, DailyDigestGroup["items"]>();
    let totalScore = 0;

    for (const item of items) {
      totalScore += item.score;
      for (const tag of item.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
      const primary = item.tags[0] || "综合观察";
      const list = grouped.get(primary) ?? [];
      list.push({
        id: item.id,
        title: item.title,
        source: item.source,
        score: item.score,
        summary: item.summary,
        corePoints: item.corePoints,
      });
      grouped.set(primary, list);
    }

    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    const groups: DailyDigestGroup[] = [...grouped.entries()]
      .map(([tag, list]) => ({
        tag,
        items: list.sort((a, b) => b.score - a.score),
      }))
      .sort((a, b) => b.items.length - a.items.length);

    const avgScore = items.length ? Math.round(totalScore / items.length) : 0;

    const mdLines: string[] = [
      `# ${targetDate} 信息代谢每日综述`,
      "",
      `- 收录条目：**${items.length}** 条 · 平均价值分：**${avgScore}**/100`,
      `- 高频主题：${topTags.length ? topTags.map((t) => `\`${t.tag}\` (${t.count})`).join(" · ") : "暂无"}`,
      "",
    ];

    if (items.length === 0) {
      mdLines.push("> 当日暂无已清洗资讯。可在右侧粘贴原文入库，或点击「导入今日复盘日记」。");
    } else {
      for (const group of groups) {
        mdLines.push(`## ${group.tag} (${group.items.length})`);
        mdLines.push("");
        for (const item of group.items) {
          mdLines.push(`### [${item.score}分] ${item.title}（${item.source}）`);
          mdLines.push(item.summary);
          for (const pt of item.corePoints) {
            mdLines.push(`- ${pt}`);
          }
          mdLines.push("");
        }
      }
    }

    return {
      date: targetDate,
      count: items.length,
      avgScore,
      topTags,
      groups,
      markdown: mdLines.join("\n").trim(),
      generatedAt: nowIso(),
    };
  }

  async projectBriefingIsland(canvasId: string, date?: string): Promise<ProjectIslandResult> {
    const parsed = parseOrThrow(projectIslandSchema, { canvasId, date }, "project_island_input");
    let targetDate = parsed.date ?? todayDate();
    let items = this.listBriefings({ date: targetDate, limit: 50 });

    if (items.length === 0 && !parsed.date) {
      const latest = this.db
        .prepare("SELECT date FROM opc_daily_briefings ORDER BY date DESC LIMIT 1")
        .get() as { date?: string } | undefined;
      if (latest?.date) {
        targetDate = latest.date;
        items = this.listBriefings({ date: targetDate, limit: 50 });
      }
    }

    if (items.length === 0) {
      return {
        canvasId: parsed.canvasId,
        date: targetDate,
        itemCount: 0,
        createdNodes: 0,
        semanticEdges: 0,
        simulated: false,
        message: `${targetDate} 暂无简报条目可供投射`,
      };
    }

    const payload = items.map((b) => ({
      id: b.id,
      source: b.source,
      summary: `${b.title}：${b.summary}`,
      tags: b.tags,
      score: b.score,
    }));

    if (this.hooks.projectToCanvas) {
      const projected = await this.hooks.projectToCanvas(parsed.canvasId, payload);
      return {
        canvasId: parsed.canvasId,
        date: targetDate,
        itemCount: items.length,
        createdNodes: projected.createdNodes,
        semanticEdges: projected.semanticEdges,
        simulated: false,
        message: `已将 ${targetDate} 的 ${items.length} 条简报投射为画布「每日简报岛」（新增 ${projected.createdNodes} 节点、${projected.semanticEdges} 条语义连线）`,
      };
    }

    return {
      canvasId: parsed.canvasId,
      date: targetDate,
      itemCount: items.length,
      createdNodes: items.length,
      semanticEdges: Math.max(0, items.length - 1),
      simulated: true,
      message: `知识画布投射钩子尚未挂载，已为 ${targetDate} 的 ${items.length} 条简报生成投射预览`,
    };
  }

  async triggerExternalWorkflow(rawInput: unknown = {}): Promise<WorkflowTriggerResult> {
    const input = parseOrThrow(workflowTriggerSchema, rawInput ?? {}, "workflow_trigger_input");
    const wf = this.providers.get().services.workflow;
    const workflowId = input.workflowId || "daily-briefing-crawl";
    const event = input.event || "metabolism.collect";
    const triggeredAt = nowIso();

    if (!wf.enabled || !wf.endpoint) {
      return {
        triggered: false,
        configured: false,
        endpoint: wf.endpoint || "",
        workflowId,
        event,
        statusCode: null,
        message:
          "尚未启用外部 Workflow Provider 或未配置 Webhook 地址。请前往「外部 Provider 配置中心」开启 Workflow 服务并填写 n8n / Webhook Endpoint。",
        triggeredAt,
      };
    }

    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (wf.apiKey) headers.authorization = `Bearer ${wf.apiKey}`;
      const res = await this.fetchImpl(wf.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workflowId,
          event,
          payload: input.payload ?? {},
          source: "opc-os-metabolism",
          triggeredAt,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      let response: unknown = text;
      try {
        response = text ? JSON.parse(text) : null;
      } catch {
        response = text;
      }
      return {
        triggered: res.ok,
        configured: true,
        endpoint: wf.endpoint,
        workflowId,
        event,
        statusCode: res.status,
        message: res.ok ? `外部 Workflow (${workflowId}) 触发成功` : `外部 Workflow 返回 HTTP ${res.status}`,
        response,
        triggeredAt,
      };
    } catch (err) {
      return {
        triggered: false,
        configured: true,
        endpoint: wf.endpoint,
        workflowId,
        event,
        statusCode: null,
        message: `外部 Workflow 触发失败：${err instanceof Error ? err.message : String(err)}`,
        triggeredAt,
      };
    }
  }

  // =========================================================================
  // 2. PM Agent Dual-Dimension Scoring & Auto Task Creation (2.6)
  // =========================================================================

  async evaluateWithPmAgent(rawInput: unknown): Promise<PmEvaluation> {
    const input = parseOrThrow(pmEvaluateSchema, rawInput, "pm_input");
    const cfg = this.providers.get();
    const threshold = input.threshold ?? cfg.system.pmAutoCreateThreshold ?? 85;

    let result = evaluatePmLocally(input.content, input.project);
    let engine: "llm" | "local" = "local";

    const llmRes = await callConfiguredLLM(
      `你是 OPC OS 的资深一人公司 PM Agent。请对以下属于项目「${input.project}」（来源：${input.source}）的需求/线索进行双维评分并拆解任务树，严格返回 JSON：
{
  "technicalScore": 0-100 (单人+AI Agent 2周内技术可行性),
  "commercialScore": 0-100 (市场付费意愿与变现潜力),
  "taskTitle": "Epic 标题",
  "reasoning": "双维评估结论",
  "decomposedTasks": [
    { "title": "子任务标题", "description": "详细说明", "priority": 1-10, "type": "prd"|"task"|"bug" }
  ] (3到4个子任务)
}

待评估内容：
${input.content.slice(0, 6000)}`,
      {
        system: "你是严谨的产品经理兼架构师，只输出合法 JSON。",
        maxTokens: 1200,
        config: cfg,
        fetchImpl: this.fetchImpl,
      },
    );

    if (llmRes.ok) {
      const parsed = extractJsonBlock(llmRes.text);
      if (parsed) {
        const tech = Number(parsed.technicalScore);
        const comm = Number(parsed.commercialScore);
        const rawTasks = Array.isArray(parsed.decomposedTasks) ? parsed.decomposedTasks : [];
        const decomposed: PmDecomposedTask[] = rawTasks
          .map((item) => {
            const obj = item as Record<string, unknown>;
            const rawType = String(obj.type ?? "task");
            const type: "task" | "bug" | "prd" =
              rawType === "bug" || rawType === "prd" ? rawType : "task";
            return {
              title: String(obj.title ?? "").trim().slice(0, 140),
              description: String(obj.description ?? "").trim().slice(0, 600),
              priority: clamp(Number(obj.priority ?? 6), 1, 10),
              type,
            };
          })
          .filter((t) => Boolean(t.title))
          .slice(0, 4);

        if (Number.isFinite(tech) && Number.isFinite(comm)) {
          const technicalScore = clamp(tech, 0, 100);
          const commercialScore = clamp(comm, 0, 100);
          result = {
            technicalScore,
            commercialScore,
            combinedScore: Math.round((technicalScore + commercialScore) / 2),
            taskTitle: String(parsed.taskTitle || result.taskTitle).trim().slice(0, 140),
            reasoning: String(parsed.reasoning || result.reasoning).trim().slice(0, 1000),
            decomposedTasks: decomposed.length >= 2 ? decomposed : result.decomposedTasks,
          };
          engine = "llm";
        }
      }
    }

    const id = randomUUID();
    const createdAt = nowIso();
    const shouldCreate = input.autoCreate !== false && result.combinedScore >= threshold;

    let action: "created" | "no_action" = "no_action";
    let epicTaskId: string | null = null;
    let subtaskIds: string[] = [];
    let opportunityId: string | null = null;

    if (shouldCreate) {
      action = "created";
      const tags = [...extractTagsLocally(input.content, 4), "pm-agent"];
      if (this.hooks.createTaskTree) {
        const created = this.hooks.createTaskTree({
          project: input.project,
          title: result.taskTitle,
          description: `${result.reasoning}\n\n原始需求：\n${input.content}`,
          priority: result.combinedScore >= 90 ? 9 : 8,
          tags,
          sourceRef: `pm-eval:${id}`,
          subtasks: result.decomposedTasks,
        });
        epicTaskId = created.epicId;
        subtaskIds = created.subtaskIds;
      }
      if (input.alsoAddOpportunity && this.hooks.addOpportunity) {
        const opp = this.hooks.addOpportunity({
          project: input.project,
          title: result.taskTitle,
          rationale: result.reasoning,
          sourceId: `pm-eval/${id}`,
          evidence: [
            input.content.slice(0, 320),
            `PM Agent 综合评分 ${result.combinedScore}（技术 ${result.technicalScore} / 商业 ${result.commercialScore}）`,
          ],
          impact: clamp(Math.ceil(result.commercialScore / 20), 1, 5),
          confidence: clamp(Math.ceil(result.technicalScore / 20), 1, 5),
          effort: result.technicalScore >= 80 ? 2 : 3,
        });
        opportunityId = opp.id;
      }
    }

    this.db
      .prepare(
        `INSERT INTO opc_pm_evaluations
         (id, source, project, content, technical_score, commercial_score, combined_score, threshold, action, task_title, reasoning, decomposed_tasks, epic_task_id, opportunity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.source,
        input.project,
        input.content,
        result.technicalScore,
        result.commercialScore,
        result.combinedScore,
        threshold,
        action,
        result.taskTitle,
        result.reasoning,
        JSON.stringify(result.decomposedTasks),
        epicTaskId,
        opportunityId,
        createdAt,
      );

    return {
      id,
      source: input.source,
      project: input.project,
      content: input.content,
      technicalScore: result.technicalScore,
      commercialScore: result.commercialScore,
      combinedScore: result.combinedScore,
      threshold,
      action,
      taskTitle: result.taskTitle,
      reasoning: result.reasoning,
      decomposedTasks: result.decomposedTasks,
      epicTaskId,
      subtaskIds,
      opportunityId,
      engine,
      createdAt,
    };
  }

  listPmEvaluations(limit = 30): PmEvaluation[] {
    const rows = this.db
      .prepare("SELECT * FROM opc_pm_evaluations ORDER BY created_at DESC LIMIT ?")
      .all(clamp(limit, 1, 200)) as unknown as PmRow[];
    return rows.map((r) => mapPmEvaluation(r));
  }

  // =========================================================================
  // 3. User Feedback Reverse-Feed Loop (3D.5)
  // =========================================================================

  async submitFeedback(rawInput: unknown): Promise<UserFeedback> {
    const input = parseOrThrow(feedbackSchema, rawInput, "feedback_input");
    const cfg = this.providers.get();
    let analysis = analyzeFeedbackLocally(input.project, input.rawText);

    const llmRes = await callConfiguredLLM(
      `请分析来自项目「${input.project}」（渠道：${input.channel}）的用户反馈，严格返回 JSON：
{
  "extractedAction": "一条具体可执行的产品/研发待办动作",
  "category": "bug" | "feature" | "ux" | "billing",
  "severity": "high" | "medium" | "low",
  "priority": 1-10
}

用户反馈原文：
${input.rawText.slice(0, 4000)}`,
      {
        system: "你是用户反馈分诊专家，只输出合法 JSON。",
        maxTokens: 400,
        config: cfg,
        fetchImpl: this.fetchImpl,
      },
    );

    if (llmRes.ok) {
      const parsed = extractJsonBlock(llmRes.text);
      if (parsed && typeof parsed.extractedAction === "string" && parsed.extractedAction.trim()) {
        const cat = String(parsed.category ?? analysis.category);
        const sev = String(parsed.severity ?? analysis.severity);
        analysis = {
          extractedAction: parsed.extractedAction.trim().slice(0, 240),
          category: (["bug", "feature", "ux", "billing"].includes(cat) ? cat : analysis.category) as FeedbackCategory,
          severity: (["high", "medium", "low"].includes(sev) ? sev : analysis.severity) as FeedbackSeverity,
          priority: clamp(Number(parsed.priority ?? analysis.priority), 1, 10),
        };
      }
    }

    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO opc_user_feedback
         (id, project, channel, raw_text, extracted_action, category, priority, severity, status, generated_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'triaged', NULL, ?, ?)`,
      )
      .run(
        id,
        input.project,
        input.channel,
        input.rawText,
        analysis.extractedAction,
        analysis.category,
        analysis.priority,
        analysis.severity,
        ts,
        ts,
      );

    const shouldAutoConvert =
      input.autoCreateTask === true || (input.autoCreateOnHigh === true && analysis.severity === "high");

    if (shouldAutoConvert) {
      const converted = this.convertFeedbackToTask(id);
      return converted.feedback;
    }

    const row = this.db.prepare("SELECT * FROM opc_user_feedback WHERE id=?").get(id) as unknown as FeedbackRow;
    return mapFeedback(row);
  }

  convertFeedbackToTask(feedbackId: string): FeedbackConvertResult {
    const row = this.db
      .prepare("SELECT * FROM opc_user_feedback WHERE id=?")
      .get(feedbackId) as unknown as FeedbackRow | undefined;
    if (!row) throw new ApiError(404, "feedback_not_found", "找不到对应的用户反馈记录。");

    if (row.generated_task_id) {
      return {
        feedback: mapFeedback(row),
        taskId: row.generated_task_id,
        alreadyConverted: true,
      };
    }

    const taskType: "bug" | "task" = row.category === "bug" ? "bug" : "task";
    let taskId: string;

    if (this.hooks.createTaskTree) {
      const created = this.hooks.createTaskTree({
        project: row.project,
        title: row.extracted_action,
        description: `用户反馈渠道：${row.channel}\n分类：${row.category} · 严重度：${row.severity} · 优先级：P${row.priority}\n\n反馈原文：\n${row.raw_text}`,
        priority: Number(row.priority),
        tags: ["user-feedback", row.category, `severity-${row.severity}`],
        sourceRef: `feedback:${row.id}`,
        subtasks: [
          {
            title: `定位与复现：${row.extracted_action.slice(0, 60)}`,
            description: `核对用户原文并在本地复现场景：${row.raw_text.slice(0, 300)}`,
            priority: Number(row.priority),
            type: taskType,
          },
          {
            title: `实施修复与回访验证：${row.project}`,
            description: `完成改动、补充回归测试并标记反馈闭环。`,
            priority: Math.max(1, Number(row.priority) - 1),
            type: "task",
          },
        ],
      });
      taskId = created.epicId;
    } else {
      taskId = `fb-task-${row.id.slice(0, 8)}`;
    }

    const updatedAt = nowIso();
    this.db
      .prepare("UPDATE opc_user_feedback SET status='converted', generated_task_id=?, updated_at=? WHERE id=?")
      .run(taskId, updatedAt, feedbackId);

    const updated = this.db
      .prepare("SELECT * FROM opc_user_feedback WHERE id=?")
      .get(feedbackId) as unknown as FeedbackRow;

    return {
      feedback: mapFeedback(updated),
      taskId,
      alreadyConverted: false,
    };
  }

  listFeedback(project?: string, limit = 50): UserFeedback[] {
    const cap = clamp(limit, 1, 200);
    if (project?.trim()) {
      const rows = this.db
        .prepare("SELECT * FROM opc_user_feedback WHERE project=? ORDER BY created_at DESC LIMIT ?")
        .all(project.trim(), cap) as unknown as FeedbackRow[];
      return rows.map(mapFeedback);
    }
    const rows = this.db
      .prepare("SELECT * FROM opc_user_feedback ORDER BY created_at DESC LIMIT ?")
      .all(cap) as unknown as FeedbackRow[];
    return rows.map(mapFeedback);
  }

  // =========================================================================
  // 4. Multi-Channel Native Payments (3D.3)
  // =========================================================================

  createPaymentOrder(rawInput: unknown): PaymentOrder {
    const input = parseOrThrow(paymentOrderSchema, rawInput, "payment_input");
    const currency = input.currency ?? (input.channel === "hupijiao" ? "CNY" : "USD");
    const id = randomUUID();
    const outTradeNo = `OPC-${Date.now()}-${randomBytes(3).toString("hex").toUpperCase()}`;
    const ts = nowIso();
    const payCfg = this.providers.get().services.payment;

    let payUrl = "";
    let sandbox = true;
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };

    if (input.channel === "hupijiao") {
      const dom = payCfg.domestic;
      if (dom.enabled && dom.appId && dom.appSecret) {
        sandbox = false;
        const params: Record<string, string> = {
          version: "1.1",
          appid: dom.appId,
          trade_order_id: outTradeNo,
          total_fee: input.amount.toFixed(2),
          title: input.subject,
          time: String(Math.floor(Date.now() / 1000)),
          notify_url: dom.notifyUrl || "http://127.0.0.1:4317/api/opc/metabolism/payments/callback/hupijiao",
          return_url: dom.returnUrl || "http://127.0.0.1:4317/#metabolism",
          nonce_str: randomBytes(8).toString("hex"),
        };
        const hash = signHupijiaoParams(params, dom.appSecret);
        const endpoint = (dom.endpoint || "https://api.xunhupay.com").replace(/\/+$/, "");
        const qs = new URLSearchParams({ ...params, hash }).toString();
        payUrl = `${endpoint}/payment/do.html?${qs}`;
        metadata.signedParams = { ...params, hash };
      } else {
        sandbox = true;
        payUrl = `#metabolism?sandboxPay=${encodeURIComponent(outTradeNo)}&channel=hupijiao&amount=${input.amount.toFixed(2)}&currency=${currency}`;
      }
    } else if (input.channel === "stripe") {
      const glob = payCfg.global;
      if (glob.enabled && glob.type === "stripe" && glob.apiKey) {
        sandbox = false;
        payUrl = `https://checkout.stripe.com/c/pay/${encodeURIComponent(outTradeNo)}?client_reference_id=${encodeURIComponent(outTradeNo)}&currency=${currency.toLowerCase()}`;
      } else {
        sandbox = true;
        payUrl = `#metabolism?sandboxPay=${encodeURIComponent(outTradeNo)}&channel=stripe&amount=${input.amount.toFixed(2)}&currency=${currency}`;
      }
    } else {
      const glob = payCfg.global;
      if (glob.enabled && glob.type === "lemonsqueezy" && glob.apiKey) {
        sandbox = false;
        const base = (glob.endpoint || "https://api.lemonsqueezy.com/v1").replace(/\/v1\/?$/, "");
        payUrl = `${base}/checkout/buy/${encodeURIComponent(outTradeNo)}?checkout[custom][out_trade_no]=${encodeURIComponent(outTradeNo)}`;
      } else {
        sandbox = true;
        payUrl = `#metabolism?sandboxPay=${encodeURIComponent(outTradeNo)}&channel=lemonsqueezy&amount=${input.amount.toFixed(2)}&currency=${currency}`;
      }
    }

    metadata.sandbox = sandbox;

    this.db
      .prepare(
        `INSERT INTO opc_payments
         (id, project, channel, amount, currency, subject, out_trade_no, transaction_id, status, pay_url, metadata, paid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.project,
        input.channel,
        round2(input.amount),
        currency,
        input.subject,
        outTradeNo,
        payUrl,
        JSON.stringify(metadata),
        ts,
        ts,
      );

    const row = this.db.prepare("SELECT * FROM opc_payments WHERE id=?").get(id) as unknown as PaymentRow;
    return mapPayment(row);
  }

  handlePaymentCallback(channel: string, rawPayload: unknown): PaymentCallbackResult {
    const payload =
      rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : {};

    if (channel === "hupijiao") {
      const appSecret = this.providers.get().services.payment.domestic.appSecret;
      if (appSecret) {
        if (!verifyHupijiaoSignature(payload, appSecret)) {
          return { success: false, message: "Invalid signature" };
        }
      }

      const tradeStatus = String(payload.trade_status ?? payload.status ?? "").trim();
      if (tradeStatus !== "OD") {
        return { success: false, message: `Unsupported trade_status: ${tradeStatus || "missing"}` };
      }

      const outTradeNo = String(payload.trade_order_id ?? payload.out_trade_no ?? "").trim();
      if (!outTradeNo) {
        return { success: false, message: "Missing trade_order_id" };
      }

      const row = this.db
        .prepare("SELECT * FROM opc_payments WHERE out_trade_no=?")
        .get(outTradeNo) as unknown as PaymentRow | undefined;
      if (!row) {
        return { success: false, message: "Order not found" };
      }

      const transactionId =
        String(payload.open_order_id ?? payload.transaction_id ?? "").trim() ||
        `HUPI-${randomBytes(4).toString("hex").toUpperCase()}`;
      const ts = nowIso();
      this.db
        .prepare(
          "UPDATE opc_payments SET status='paid', transaction_id=?, paid_at=COALESCE(paid_at, ?), updated_at=? WHERE id=?",
        )
        .run(transactionId, ts, ts, row.id);

      const updated = this.db.prepare("SELECT * FROM opc_payments WHERE id=?").get(row.id) as unknown as PaymentRow;
      return { success: true, message: "Hupijiao payment confirmed", order: mapPayment(updated) };
    }

    if (channel === "stripe" || channel === "lemonsqueezy") {
      const eventType = String(
        payload.type ??
          (payload.meta as Record<string, unknown> | undefined)?.event_name ??
          payload.event ??
          "",
      ).trim();

      const validEvents =
        channel === "stripe"
          ? new Set(["checkout.session.completed", "payment_intent.succeeded", "charge.succeeded"])
          : new Set(["order_created", "order_paid", "subscription_payment_success"]);

      if (!validEvents.has(eventType)) {
        return { success: false, message: `Ignored ${channel} event: ${eventType || "missing"}` };
      }

      const dataObj = (payload.data as Record<string, unknown> | undefined)?.object as
        | Record<string, unknown>
        | undefined;
      const metaCustom = (payload.meta as Record<string, unknown> | undefined)?.custom_data as
        | Record<string, unknown>
        | undefined;
      const outTradeNo = String(
        payload.out_trade_no ??
          dataObj?.client_reference_id ??
          (dataObj?.metadata as Record<string, unknown> | undefined)?.out_trade_no ??
          metaCustom?.out_trade_no ??
          "",
      ).trim();

      if (!outTradeNo) {
        return { success: false, message: "Missing out_trade_no" };
      }

      const row = this.db
        .prepare("SELECT * FROM opc_payments WHERE out_trade_no=?")
        .get(outTradeNo) as unknown as PaymentRow | undefined;
      if (!row) {
        return { success: false, message: "Order not found" };
      }

      const transactionId =
        String(
          payload.transaction_id ??
            dataObj?.id ??
            (payload.data as Record<string, unknown> | undefined)?.id ??
            "",
        ).trim() || `${channel.toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;

      const ts = nowIso();
      this.db
        .prepare(
          "UPDATE opc_payments SET status='paid', transaction_id=?, paid_at=COALESCE(paid_at, ?), updated_at=? WHERE id=?",
        )
        .run(transactionId, ts, ts, row.id);

      const updated = this.db.prepare("SELECT * FROM opc_payments WHERE id=?").get(row.id) as unknown as PaymentRow;
      return { success: true, message: `${channel} payment confirmed`, order: mapPayment(updated) };
    }

    return { success: false, message: `Unsupported payment channel: ${channel}` };
  }

  confirmSandboxPayment(orderIdOrTradeNo: string): PaymentOrder {
    const row = this.db
      .prepare("SELECT * FROM opc_payments WHERE id=? OR out_trade_no=?")
      .get(orderIdOrTradeNo, orderIdOrTradeNo) as unknown as PaymentRow | undefined;
    if (!row) throw new ApiError(404, "payment_not_found", "找不到对应的收款订单。");

    if (row.status === "paid") return mapPayment(row);

    const ts = nowIso();
    const txId = `SANDBOX-${randomBytes(4).toString("hex").toUpperCase()}`;
    this.db
      .prepare("UPDATE opc_payments SET status='paid', transaction_id=?, paid_at=?, updated_at=? WHERE id=?")
      .run(txId, ts, ts, row.id);

    const updated = this.db.prepare("SELECT * FROM opc_payments WHERE id=?").get(row.id) as unknown as PaymentRow;
    return mapPayment(updated);
  }

  listPayments(project?: string, limit = 100): PaymentOrder[] {
    const cap = clamp(limit, 1, 500);
    if (project?.trim()) {
      const rows = this.db
        .prepare("SELECT * FROM opc_payments WHERE project=? ORDER BY created_at DESC LIMIT ?")
        .all(project.trim(), cap) as unknown as PaymentRow[];
      return rows.map(mapPayment);
    }
    const rows = this.db
      .prepare("SELECT * FROM opc_payments ORDER BY created_at DESC LIMIT ?")
      .all(cap) as unknown as PaymentRow[];
    return rows.map(mapPayment);
  }

  // =========================================================================
  // 5. Omnichannel Content Distribution (3D.4)
  // =========================================================================

  async distributeContent(rawInput: unknown): Promise<DistributionRecord> {
    const input = parseOrThrow(distributionSchema, rawInput, "distribution_input");
    const uniqueChannels = [...new Set(input.channels)];
    const adaptedPayload: Record<string, string> = {};

    for (const ch of uniqueChannels) {
      adaptedPayload[ch] = adaptContentForChannel(ch, input.title, input.content, input.sourceRef);
    }

    const distCfg = this.providers.get().services.distribution;
    const results: Record<string, DistributionChannelResult> = {};
    let sentCount = 0;
    let errorCount = 0;

    if (distCfg.enabled && distCfg.endpoint) {
      for (const ch of uniqueChannels) {
        try {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (distCfg.apiKey) headers.authorization = `Bearer ${distCfg.apiKey}`;
          const res = await this.fetchImpl(distCfg.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
              channel: ch,
              title: input.title,
              sourceRef: input.sourceRef,
              content: adaptedPayload[ch],
            }),
            signal: AbortSignal.timeout(8_000),
          });
          if (res.ok) {
            sentCount += 1;
            results[ch] = {
              channel: ch,
              status: "sent",
              detail: `Webhook 分发成功 (HTTP ${res.status})`,
              dispatchedAt: nowIso(),
            };
          } else {
            errorCount += 1;
            results[ch] = {
              channel: ch,
              status: "error",
              detail: `Webhook 返回 HTTP ${res.status}`,
            };
          }
        } catch (err) {
          errorCount += 1;
          results[ch] = {
            channel: ch,
            status: "error",
            detail: `Webhook 调用失败：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    } else {
      for (const ch of uniqueChannels) {
        results[ch] = {
          channel: ch,
          status: "draft_ready",
          detail: "适配稿已就绪，可一键复制或通过 cose / 外部 Webhook 同步",
        };
      }
    }

    let status: DistributionRecord["status"] = "draft_ready";
    if (distCfg.enabled && distCfg.endpoint) {
      if (sentCount === uniqueChannels.length) status = "sent";
      else if (sentCount > 0) status = "partial";
      else if (errorCount > 0) status = "failed";
    }

    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO opc_distributions
         (id, title, source_ref, channels, adapted_payload, status, results, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.sourceRef,
        JSON.stringify(uniqueChannels),
        JSON.stringify(adaptedPayload),
        status,
        JSON.stringify(results),
        createdAt,
      );

    return {
      id,
      title: input.title,
      sourceRef: input.sourceRef,
      channels: uniqueChannels,
      adaptedPayload,
      status,
      results,
      createdAt,
    };
  }

  listDistributions(limit = 50): DistributionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM opc_distributions ORDER BY created_at DESC LIMIT ?")
      .all(clamp(limit, 1, 200)) as unknown as DistributionRow[];
    return rows.map(mapDistribution);
  }

  // =========================================================================
  // 6. Fractal CI/CD Outer-Loop Deployments (3D.2)
  // =========================================================================

  listDeployments(project?: string): DeploymentRecord[] {
    if (project?.trim()) {
      const rows = this.db
        .prepare("SELECT * FROM opc_deployments WHERE project=? ORDER BY updated_at DESC")
        .all(project.trim()) as unknown as DeploymentRow[];
      return rows.map(mapDeployment);
    }
    const rows = this.db
      .prepare("SELECT * FROM opc_deployments ORDER BY updated_at DESC")
      .all() as unknown as DeploymentRow[];
    return rows.map(mapDeployment);
  }

  createDeployment(rawInput: unknown): DeploymentRecord {
    const input = parseOrThrow(deploymentSchema, rawInput, "deployment_input");
    const id = randomUUID();
    const ts = nowIso();
    const logs: DeploymentLogEntry[] = [
      {
        at: ts,
        level: "info",
        action: "create",
        message: `创建部署配置：${input.project}@${input.version} -> ${input.targetHost}${input.dockerImage ? ` (${input.dockerImage})` : ""}`,
      },
    ];

    this.db
      .prepare(
        `INSERT INTO opc_deployments
         (id, project, target_host, docker_image, deploy_command, version, env_vars, status, logs, deployed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'configured', ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.project,
        input.targetHost,
        input.dockerImage,
        input.deployCommand,
        input.version,
        JSON.stringify(input.envVars),
        JSON.stringify(logs),
        ts,
        ts,
      );

    const row = this.db.prepare("SELECT * FROM opc_deployments WHERE id=?").get(id) as unknown as DeploymentRow;
    return mapDeployment(row);
  }

  triggerDeployment(id: string): DeploymentRecord {
    const row = this.db.prepare("SELECT * FROM opc_deployments WHERE id=?").get(id) as unknown as DeploymentRow | undefined;
    if (!row) throw new ApiError(404, "deployment_not_found", "找不到对应的部署配置。");

    const ts = nowIso();
    const envVars = safeJsonParse<Record<string, string>>(row.env_vars, {});
    const logs = safeJsonParse<DeploymentLogEntry[]>(row.logs, []);

    logs.push(
      {
        at: ts,
        level: "info",
        action: "deploy",
        message: `[Preflight] 校验目标主机 ${row.target_host} 与 ${Object.keys(envVars).length} 项环境变量`,
      },
      {
        at: ts,
        level: "info",
        action: "deploy",
        message: row.docker_image
          ? `[Release] 拉取镜像 ${row.docker_image} 并滚动发布版本 ${row.version}`
          : `[Release] 执行部署命令「${row.deploy_command || "systemctl reload app"}」发布版本 ${row.version}`,
      },
      {
        at: ts,
        level: "info",
        action: "deploy",
        message: `[Healthy] ${row.project}@${row.version} 外循环部署完成，健康探针通过`,
      },
    );

    this.db
      .prepare("UPDATE opc_deployments SET status='deployed', logs=?, deployed_at=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(logs), ts, ts, id);

    const updated = this.db.prepare("SELECT * FROM opc_deployments WHERE id=?").get(id) as unknown as DeploymentRow;
    return mapDeployment(updated);
  }

  rollbackDeployment(id: string, rawInput?: unknown): DeploymentRecord {
    const parsed = rawInput ? parseOrThrow(rollbackSchema, rawInput, "rollback_input") : {};
    const row = this.db.prepare("SELECT * FROM opc_deployments WHERE id=?").get(id) as unknown as DeploymentRow | undefined;
    if (!row) throw new ApiError(404, "deployment_not_found", "找不到对应的部署配置。");

    const ts = nowIso();
    const logs = safeJsonParse<DeploymentLogEntry[]>(row.logs, []);
    logs.push({
      at: ts,
      level: "warn",
      action: "rollback",
      message: `[Rollback] 已回滚 ${row.project}@${row.version}（主机 ${row.target_host}）${parsed.note ? ` · 原因：${parsed.note}` : ""}`,
    });

    this.db
      .prepare("UPDATE opc_deployments SET status='rolled_back', logs=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(logs), ts, id);

    const updated = this.db.prepare("SELECT * FROM opc_deployments WHERE id=?").get(id) as unknown as DeploymentRow;
    return mapDeployment(updated);
  }

  // =========================================================================
  // 7. Commercial Profit Heatmap + 3-Month Loss Kill Switch (3D.6)
  // =========================================================================

  recordMonthlyCost(rawInput: unknown): MonthlyCostEntry {
    const input = parseOrThrow(monthlyCostSchema, rawInput, "monthly_cost_input");
    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO opc_monthly_costs (id, project, month, amount_usd, category, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.project, input.month, round2(input.amountUsd), input.category, input.note, createdAt);

    return {
      id,
      project: input.project,
      month: input.month,
      amountUsd: round2(input.amountUsd),
      category: input.category,
      note: input.note,
      createdAt,
    };
  }

  getCommercialHeatmap(months = 6): CommercialHeatmap {
    const monthList = recentMonthLabels(months);
    const monthSet = new Set(monthList);
    const lossKillSwitchMonths = Math.max(1, this.providers.get().system.lossKillSwitchMonths || 3);

    const flows = new Map<string, Map<string, { revenueUsd: number; costUsd: number }>>();
    const ensureProject = (project: string) => {
      let byMonth = flows.get(project);
      if (!byMonth) {
        byMonth = new Map();
        for (const m of monthList) byMonth.set(m, { revenueUsd: 0, costUsd: 0 });
        flows.set(project, byMonth);
      }
      return byMonth;
    };
    const addRevenue = (project: string, month: string, usd: number) => {
      const byMonth = ensureProject(project);
      if (!monthSet.has(month)) return;
      byMonth.get(month)!.revenueUsd += usd;
    };
    const addCost = (project: string, month: string, usd: number) => {
      const byMonth = ensureProject(project);
      if (!monthSet.has(month)) return;
      byMonth.get(month)!.costUsd += usd;
    };

    // 1. Paid orders from opc_payments
    const paymentRows = this.db
      .prepare("SELECT project, amount, currency, COALESCE(paid_at, created_at) AS ts FROM opc_payments WHERE status='paid'")
      .all() as Array<{ project: string; amount: number; currency: string; ts: string }>;
    for (const p of paymentRows) {
      const m = String(p.ts).slice(0, 7);
      addRevenue(p.project, m, toUsd(Number(p.amount), p.currency));
    }

    // 2. Manual/infra monthly costs from opc_monthly_costs
    const costRows = this.db
      .prepare("SELECT project, month, amount_usd FROM opc_monthly_costs")
      .all() as Array<{ project: string; month: string; amount_usd: number }>;
    for (const c of costRows) {
      addCost(c.project, c.month, Number(c.amount_usd));
    }

    // 3. Agent Token costs via hook
    if (this.hooks.readAgentCostsByProjectMonth) {
      const agentCosts = this.hooks.readAgentCostsByProjectMonth(monthList);
      for (const [project, byMonth] of Object.entries(agentCosts)) {
        ensureProject(project);
        for (const [month, usd] of Object.entries(byMonth)) {
          if (Number.isFinite(usd) && usd > 0) addCost(project, month, usd);
        }
      }
    }

    // 4. Optional business evidence ledger (opc_evidence + opc_trials + opc_lines)
    if (this.hasTable("opc_evidence") && this.hasTable("opc_trials")) {
      try {
        const hasLines = this.hasTable("opc_lines");
        const sql = hasLines
          ? `SELECT COALESCE(l.name, t.line_id) AS project, e.kind, e.input, e.created_at
             FROM opc_evidence e
             JOIN opc_trials t ON t.id = e.trial_id
             LEFT JOIN opc_lines l ON l.id = t.line_id
             WHERE e.kind IN ('receipt', 'refund', 'expense')`
          : `SELECT t.line_id AS project, e.kind, e.input, e.created_at
             FROM opc_evidence e
             JOIN opc_trials t ON t.id = e.trial_id
             WHERE e.kind IN ('receipt', 'refund', 'expense')`;
        const evidenceRows = this.db.prepare(sql).all() as Array<{
          project: string;
          kind: string;
          input: string;
          created_at: string;
        }>;
        for (const ev of evidenceRows) {
          const parsed = safeJsonParse<{ currency?: string; minor?: number }>(ev.input, {});
          const currency = String(parsed.currency ?? "USD").toUpperCase();
          const divisor = currency === "JPY" ? 1 : 100;
          const amountUsd = toUsd((Number(parsed.minor) || 0) / divisor, currency);
          const month = String(ev.created_at).slice(0, 7);
          if (ev.kind === "receipt") addRevenue(ev.project, month, amountUsd);
          else addCost(ev.project, month, amountUsd);
        }
      } catch {
        // Ignore if external table layout differs
      }
    }

    // 5. Ensure projects in deployments or kill switches appear
    const deployProjects = this.db.prepare("SELECT DISTINCT project FROM opc_deployments").all() as Array<{ project: string }>;
    for (const d of deployProjects) ensureProject(d.project);

    const killRows = this.db.prepare("SELECT * FROM opc_kill_switches").all() as unknown as KillSwitchRow[];
    const killMap = new Map<string, KillSwitchRecord>();
    for (const k of killRows) {
      killMap.set(k.project, mapKillSwitch(k));
      ensureProject(k.project);
    }

    const projects: HeatmapProjectRow[] = [];
    let grandRev = 0;
    let grandCost = 0;
    let alertCount = 0;
    let stoppedCount = 0;

    for (const [project, byMonth] of flows.entries()) {
      const cells: HeatmapCell[] = [];
      let totalRevenueUsd = 0;
      let totalCostUsd = 0;

      for (const month of monthList) {
        const entry = byMonth.get(month) ?? { revenueUsd: 0, costUsd: 0 };
        const revenueUsd = round2(entry.revenueUsd);
        const costUsd = round2(entry.costUsd);
        const netProfitUsd = round2(revenueUsd - costUsd);
        const status: HeatmapCell["status"] =
          netProfitUsd > 0.005 ? "profit" : netProfitUsd < -0.005 ? "loss" : "breakeven";
        cells.push({ month, revenueUsd, costUsd, netProfitUsd, status });
        totalRevenueUsd += revenueUsd;
        totalCostUsd += costUsd;
      }

      totalRevenueUsd = round2(totalRevenueUsd);
      totalCostUsd = round2(totalCostUsd);
      const totalNetProfitUsd = round2(totalRevenueUsd - totalCostUsd);

      let consecutiveLossMonths = 0;
      let trailingLossUsd = 0;
      for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i].status === "loss") {
          consecutiveLossMonths += 1;
          trailingLossUsd += Math.abs(cells[i].netProfitUsd);
        } else {
          break;
        }
      }

      const cumulativeLossUsd = round2(
        trailingLossUsd > 0 ? trailingLossUsd : Math.max(0, totalCostUsd - totalRevenueUsd),
      );
      const killSwitchAlert = consecutiveLossMonths >= lossKillSwitchMonths;
      const killSwitch = killMap.get(project) ?? null;

      if (killSwitchAlert) alertCount += 1;
      if (killSwitch?.status === "stopped") stoppedCount += 1;
      grandRev += totalRevenueUsd;
      grandCost += totalCostUsd;

      projects.push({
        project,
        cells,
        totalRevenueUsd,
        totalCostUsd,
        totalNetProfitUsd,
        consecutiveLossMonths,
        cumulativeLossUsd,
        killSwitchAlert,
        killSwitch,
      });
    }

    projects.sort((a, b) => {
      if (a.killSwitchAlert !== b.killSwitchAlert) return a.killSwitchAlert ? -1 : 1;
      if (a.totalNetProfitUsd !== b.totalNetProfitUsd) return a.totalNetProfitUsd - b.totalNetProfitUsd;
      return a.project.localeCompare(b.project);
    });

    return {
      months: monthList,
      lossKillSwitchMonths,
      projects,
      summary: {
        totalRevenueUsd: round2(grandRev),
        totalCostUsd: round2(grandCost),
        totalNetProfitUsd: round2(grandRev - grandCost),
        alertCount,
        stoppedCount,
      },
      generatedAt: nowIso(),
    };
  }

  triggerKillSwitch(
    project: string,
    rawInput: unknown = {},
  ): { killSwitch: KillSwitchRecord; zoomAlert: { taskId: string; messageId: string } | null } {
    const cleanProject = project.trim();
    if (!cleanProject) throw new ApiError(400, "kill_switch_project", "请提供有效项目名。");
    const input = parseOrThrow(killSwitchStopSchema, rawInput ?? {}, "kill_switch_input");

    const heatmap = this.getCommercialHeatmap(6);
    const row = heatmap.projects.find((p) => p.project === cleanProject);
    const consecutiveLossMonths = row?.consecutiveLossMonths ?? 0;
    const cumulativeLossUsd = row?.cumulativeLossUsd ?? 0;
    const reason =
      input.reason ||
      (consecutiveLossMonths > 0
        ? `连续 ${consecutiveLossMonths} 个月亏损（累计 -$${cumulativeLossUsd.toFixed(2)}），执行商业熔断停服`
        : "手动执行商业熔断停服");

    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO opc_kill_switches
         (project, status, consecutive_loss_months, cumulative_loss_usd, reason, triggered_at, resumed_at, updated_at)
         VALUES (?, 'stopped', ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(project) DO UPDATE SET
           status='stopped',
           consecutive_loss_months=excluded.consecutive_loss_months,
           cumulative_loss_usd=excluded.cumulative_loss_usd,
           reason=excluded.reason,
           triggered_at=excluded.triggered_at,
           resumed_at=NULL,
           updated_at=excluded.updated_at`,
      )
      .run(cleanProject, consecutiveLossMonths, cumulativeLossUsd, reason, ts, ts);

    let zoomAlert: { taskId: string; messageId: string } | null = null;
    if (input.notifyZoom !== false && this.hooks.postAlertToZoom) {
      const posted = this.hooks.postAlertToZoom({
        folder: cleanProject,
        title: `商业熔断停服：${cleanProject}`,
        body: `项目「${cleanProject}」已触发一键停服（Kill Switch）。\n- 原因：${reason}\n- 连续亏损：${consecutiveLossMonths} 个月\n- 累计亏损：$${cumulativeLossUsd.toFixed(2)}`,
        choices: ["归档该项目并停止投放", "调整商业模型后恢复"],
        externalId: `kill-switch/${cleanProject}/${Date.now()}`,
      });
      if (posted) zoomAlert = posted;
    }

    const saved = this.db
      .prepare("SELECT * FROM opc_kill_switches WHERE project=?")
      .get(cleanProject) as unknown as KillSwitchRow;

    return { killSwitch: mapKillSwitch(saved), zoomAlert };
  }

  resumeProject(project: string, rawNote?: string): KillSwitchRecord {
    const cleanProject = project.trim();
    if (!cleanProject) throw new ApiError(400, "kill_switch_project", "请提供有效项目名。");
    const parsed = rawNote ? parseOrThrow(killSwitchResumeSchema, { note: rawNote }, "kill_switch_resume") : {};
    const ts = nowIso();
    const existing = this.db
      .prepare("SELECT * FROM opc_kill_switches WHERE project=?")
      .get(cleanProject) as unknown as KillSwitchRow | undefined;

    if (existing) {
      this.db
        .prepare("UPDATE opc_kill_switches SET status='active', reason=?, resumed_at=?, updated_at=? WHERE project=?")
        .run(parsed.note || existing.reason, ts, ts, cleanProject);
    } else {
      this.db
        .prepare(
          `INSERT INTO opc_kill_switches
           (project, status, consecutive_loss_months, cumulative_loss_usd, reason, triggered_at, resumed_at, updated_at)
           VALUES (?, 'active', 0, 0, ?, NULL, ?, ?)`,
        )
        .run(cleanProject, parsed.note || "项目处于运行状态", ts, ts);
    }

    const saved = this.db
      .prepare("SELECT * FROM opc_kill_switches WHERE project=?")
      .get(cleanProject) as unknown as KillSwitchRow;
    return mapKillSwitch(saved);
  }
}

// ---- Hono Route Registration ----

async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
  }
}

export function registerMetabolismRoutes(
  app: Hono,
  db: DatabaseSync,
  providers: ProvidersStore,
  user: (c: Context) => unknown,
  options?: MetabolismRouteOptions,
): MetabolismStore {
  const store = new MetabolismStore(db, providers, options);
  const { permits } = submitAuth(options?.submitToken);
  const base = "/api/opc/metabolism";

  app.use(base + "/*", async (c, next) => {
    const path = c.req.path;
    const isPaymentWebhook = path.startsWith(base + "/payments/callback/");
    if (!isPaymentWebhook && !permits(c)) {
      user(c);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  // 1. Briefings
  app.get(base + "/briefings/today", (c) =>
    c.json({
      date: todayDate(),
      items: store.getTodayBriefings(),
      canvases: store.listCanvases(),
    }),
  );
  app.get(base + "/briefings/digest", (c) => {
    const date = c.req.query("date") || undefined;
    return c.json(store.generateDailyDigest(date));
  });
  app.get(base + "/briefings", (c) => {
    const date = c.req.query("date") || undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    return c.json({
      items: store.listBriefings({ date, limit: Number.isFinite(limit) ? limit : undefined }),
      canvases: store.listCanvases(),
    });
  });
  app.post(base + "/briefings/ingest", async (c) => c.json(await store.ingestBriefing(await readJsonBody(c)), 201));
  app.post(base + "/briefings/import-journal", async (c) => {
    const body = (await readJsonBody(c)) as { day?: string };
    return c.json(await store.importFromJournal(body?.day));
  });
  app.post(base + "/briefings/project-island", async (c) => {
    const body = (await readJsonBody(c)) as { canvasId?: string; date?: string };
    return c.json(await store.projectBriefingIsland(String(body?.canvasId ?? ""), body?.date));
  });
  app.post(base + "/briefings/:id/activate-memory", (c) =>
    c.json(store.activateDormantMemories(c.req.param("id") ?? "")),
  );
  app.delete(base + "/briefings/:id", (c) => c.json(store.deleteBriefing(c.req.param("id") ?? "")));
  app.post(base + "/workflow/trigger", async (c) => {
    const res = await store.triggerExternalWorkflow(await readJsonBody(c));
    if (!res.configured) {
      return c.json({ ...res, error: "workflow_unconfigured" }, 400);
    }
    return c.json(res, res.triggered ? 200 : 502);
  });

  // 2. PM Agent
  app.get(base + "/pm/evaluations", (c) => {
    const limit = Number(c.req.query("limit") ?? 30);
    return c.json({ items: store.listPmEvaluations(Number.isFinite(limit) ? limit : 30) });
  });
  app.post(base + "/pm/evaluate", async (c) => c.json(await store.evaluateWithPmAgent(await readJsonBody(c)), 201));

  // 3. Feedback
  app.get(base + "/feedback", (c) => {
    const project = c.req.query("project") || undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ items: store.listFeedback(project, Number.isFinite(limit) ? limit : 50) });
  });
  app.post(base + "/feedback", async (c) => c.json(await store.submitFeedback(await readJsonBody(c)), 201));
  app.post(base + "/feedback/:id/create-task", (c) =>
    c.json(store.convertFeedbackToTask(c.req.param("id") ?? "")),
  );

  // 4. Payments
  app.get(base + "/payments", (c) => {
    const project = c.req.query("project") || undefined;
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json({ items: store.listPayments(project, Number.isFinite(limit) ? limit : 100) });
  });
  app.post(base + "/payments/orders", async (c) => c.json(store.createPaymentOrder(await readJsonBody(c)), 201));
  app.post(base + "/payments/callback/:channel", async (c) => {
    const channel = c.req.param("channel") ?? "";
    const contentType = c.req.header("content-type") ?? "";
    let payload: unknown;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = await c.req.parseBody();
      payload = form;
    } else {
      payload = await readJsonBody(c);
    }
    const result = store.handlePaymentCallback(channel, payload);
    return c.json(result, result.success ? 200 : 400);
  });
  app.post(base + "/payments/:id/sandbox-pay", (c) =>
    c.json(store.confirmSandboxPayment(c.req.param("id") ?? "")),
  );

  // 5. Distributions
  app.get(base + "/distributions", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ items: store.listDistributions(Number.isFinite(limit) ? limit : 50) });
  });
  app.post(base + "/distributions", async (c) => c.json(await store.distributeContent(await readJsonBody(c)), 201));

  // 6. Deployments
  app.get(base + "/deployments", (c) => {
    const project = c.req.query("project") || undefined;
    return c.json({ items: store.listDeployments(project) });
  });
  app.post(base + "/deployments", async (c) => c.json(store.createDeployment(await readJsonBody(c)), 201));
  app.post(base + "/deployments/:id/deploy", (c) => c.json(store.triggerDeployment(c.req.param("id") ?? "")));
  app.post(base + "/deployments/:id/rollback", async (c) =>
    c.json(store.rollbackDeployment(c.req.param("id") ?? "", await readJsonBody(c))),
  );

  // 7. Commercial Heatmap & Kill Switch
  app.get(base + "/commercial-heatmap", (c) => {
    const months = Number(c.req.query("months") ?? 6);
    return c.json(store.getCommercialHeatmap(Number.isFinite(months) ? months : 6));
  });
  app.post(base + "/commercial-heatmap/costs", async (c) =>
    c.json(store.recordMonthlyCost(await readJsonBody(c)), 201),
  );
  app.post(base + "/kill-switch/:project/stop", async (c) =>
    c.json(store.triggerKillSwitch(c.req.param("project") ?? "", await readJsonBody(c))),
  );
  app.post(base + "/kill-switch/:project/resume", async (c) => {
    const body = (await readJsonBody(c)) as { note?: string };
    return c.json(store.resumeProject(c.req.param("project") ?? "", body?.note));
  });

  return store;
}
