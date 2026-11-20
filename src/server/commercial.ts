import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  AnalyticsSyncSnapshot,
  BlueprintAsset,
  BusinessPlaybook,
  CommercialMetrics,
  CommercialOverview,
  CompanionServiceId,
  CompanionServiceStatus,
  PilotChecklistStep,
  PilotFocusConfig,
} from "../commercial-types.ts";
import { opcLayers } from "../commercial-types.ts";
import type { OpportunityStore } from "./autonomy.ts";
import { BusinessStore } from "./business.ts";
import { CompanyStore } from "./company.ts";
import { GrowthLedger } from "./growth.ts";
import { ApiError } from "./logic.ts";
import { OperationsDepartmentStore } from "./operations-department.ts";
import { ProjectProfiles } from "./project-profiles.ts";
import { ProjectStore } from "./projects.ts";
import { submitAuth } from "./workflow/http.ts";

export const BLUEPRINT_ASSETS: BlueprintAsset[] = [
  {
    repo: "magele758/pagelens-interpret",
    product: "PageLens",
    project: "pagelens-interpret",
    layer: "L6",
    domain: "AI 浏览器插件 · 视频同传",
    role: "flagship_paid",
    summary: "1号商业试点：视频实时同声传译、纯享中文音频与后台配音预处理扩展",
    monetization: "免费体验 + $29 离线买断 / $19 年付 Pro",
  },
  {
    repo: "magele758/pagelens-agent",
    product: "PageLens",
    project: "pagelens-agent",
    layer: "L6",
    domain: "AI 浏览器插件 · 网页理解与填表",
    role: "open_core",
    summary: "BYOK 网页结构化提取、跨页辅助与电商表单操作侧栏",
    monetization: "BYOK 开源版 + Pro 工作流包 $39",
  },
  {
    repo: "magele758/audiobook",
    product: "audiobook",
    project: "audiobook",
    layer: "L6",
    domain: "桌面与音频生产力",
    role: "flagship_paid",
    summary: "PDF 与长文智能分段 + Index-TTS 参考音生成高拟真有声书（Web + macOS）",
    monetization: "开源核心 + macOS 桌面端离线授权 $29",
  },
  {
    repo: "magele758/Rubiks-Cube-Learn",
    product: "流量钩子矩阵",
    project: "Rubiks-Cube-Learn",
    layer: "L6",
    domain: "互动教育轻工具",
    role: "lead_magnet",
    summary: "零门槛 3D 魔方学习工具，挂载 UTM 导流条向主产品引流",
    monetization: "免费获客钩子（Lead Magnet）",
  },
  {
    repo: "magele758/bazi-ziwei-learning",
    product: "流量钩子矩阵",
    project: "bazi-ziwei-learning",
    layer: "L6",
    domain: "传统文化轻工具",
    role: "lead_magnet",
    summary: "高传播度互动排盘学习页，承接自然搜索流量与私域订阅",
    monetization: "免费获客钩子（Lead Magnet）",
  },
  {
    repo: "magele758/opc-commerce-kit",
    product: "OPC 商业套件",
    project: "opc-commerce-kit",
    layer: "L5",
    domain: "收银、授权与单位经济",
    role: "internal_infra",
    summary: "MoR 支付 Webhook 验签归一 + Ed25519 离线 License 签发验签 + FinOps 毛利台账",
    monetization: "全矩阵共享商业底座",
  },
  {
    repo: "magele758/opc-gtm-kit",
    product: "OPC 商业套件",
    project: "opc-gtm-kit",
    layer: "L5",
    domain: "门面、合规与多渠道增长",
    role: "internal_infra",
    summary: "产品着陆页与矩阵门户生成 + 商店隐私合规包 + UTM 归因 + 一鱼多吃推广稿",
    monetization: "全矩阵共享 GTM 引擎",
  },
  {
    repo: "magele758/opc-ops-kit",
    product: "OPC 商业套件",
    project: "opc-ops-kit",
    layer: "L5",
    domain: "客服 CRM 与隐私遥测",
    role: "internal_infra",
    summary: "统一工单分诊（联动研发选题与 Zoom 审批）+ 去隐私遥测激活与崩溃指纹聚合",
    monetization: "全矩阵共享客户运营底座",
  },
  {
    repo: "magele758/cose",
    product: "OPC 商业套件",
    project: "cose",
    layer: "L5",
    domain: "多平台内容同步",
    role: "internal_infra",
    summary: "一次编写同步至公众号、小红书、B站、知乎、X 等内容渠道的本地扩展",
    monetization: "内部增长分发执行器",
  },
  {
    repo: "magele758/magele758.github.io",
    product: "OPC 商业套件",
    project: "magele758.github.io",
    layer: "L5",
    domain: "品牌官网与产品货架",
    role: "internal_infra",
    summary: "个人品牌主页与 OPC 对外产品矩阵导航门面",
    monetization: "统一流量入口",
  },
  {
    repo: "magele758/data_analysis",
    product: "OPC 分析与内核",
    project: "data_analysis",
    layer: "L4",
    domain: "经营分析与业务本体",
    role: "open_core",
    summary: "DuckDB + Arrow + Palantir Ontology/Actions + 漏斗/RFM/归因 + Reverse ETL 告警",
    monetization: "公司 CFO 数据大脑 + 企业级开源",
  },
  {
    repo: "magele758/chromegate-gateway",
    product: "OPC 分析与内核",
    project: "chromegate-gateway",
    layer: "L3",
    domain: "受控浏览器网关与确定性验收",
    role: "internal_infra",
    summary: "按 Agent 签发 cgk_ 令牌、发布/付款人工确认弹窗、无模型 verify 验收证据包",
    monetization: "对内安全执行器（不外售）",
  },
  {
    repo: "magele758/agent-zoom",
    product: "OPC 分析与内核",
    project: "agent-zoom",
    layer: "L2",
    domain: "公司经营总控与多 Agent 评审",
    role: "open_core",
    summary: "OPC OS 主体：业务线、13 阶段交付、Zoom 统一待办、跨仓能力复用与商业总控",
    monetization: "公司总控操作系统",
  },
  {
    repo: "magele758/hyper-vibekanban",
    product: "hyper-vibekanban",
    project: "hyper-vibekanban",
    layer: "L2",
    domain: "多 Agent 编码交付工厂",
    role: "open_core",
    summary: "异步 Issue 看板、Squad DAG、Worktree 隔离并行编码与手机远程控制",
    monetization: "自托管免费 + Remote Pro $49/年",
  },
  {
    repo: "magele758/agent-term",
    product: "OPC 分析与内核",
    project: "agent-term",
    layer: "L2",
    domain: "原生终端驾驶舱",
    role: "internal_infra",
    summary: "macOS 原生分屏终端与带物理人工审批的本地高危操作兜底",
    monetization: "Founder 驾驶舱",
  },
  {
    repo: "magele758/ppeng-agent-bot",
    product: "OPC 分析与内核",
    project: "ppeng-agent-bot",
    layer: "L1",
    domain: "常驻数字员工 OS",
    role: "open_core",
    summary: "Goal Ledger 长期目标账本、Routines 定时巡检、IM 交互与 @ppeng/agent-loop 内核",
    monetization: "常驻运营 Bot 内核",
  },
  {
    repo: "magele758/learn-agent",
    product: "learn-agent",
    project: "learn-agent",
    layer: "L1",
    domain: "认知诊断与主动学习",
    role: "open_core",
    summary: "先测理解再按依赖推进教学的本地认知飞轮引擎",
    monetization: "开源认知工具",
  },
  {
    repo: "magele758/strata",
    product: "OPC 分析与内核",
    project: "strata",
    layer: "L0",
    domain: "单机事务与检索底座",
    role: "internal_infra",
    summary: "Rust 单机可组合事务存储 + BM25 全文 + HNSW 向量 + 列存副本",
    monetization: "底层存储引擎",
  },
];

export const BUSINESS_PLAYBOOKS: BusinessPlaybook[] = [
  {
    id: "flagship-extension-monetization",
    title: "旗舰插件独立变现线（1号试点）",
    badge: "首选现金流",
    summary: "围绕痛点极强的本地优先插件，用最薄的 MoR 收银 + Ed25519 离线授权跑通首单与净毛利闭环。",
    line: {
      name: "旗舰插件商业变现",
      mode: "experiment",
      goal: "让 1 号试点产品在两周内跑通「高转化门面 → UTM 获客 → 核心动作激活 → 离线 License 收款 → 漏斗毛利复盘」闭环。",
      steps: [
        "生成产品着陆页与商店隐私合规包",
        "多渠道带 UTM 首发内容分发",
        "采集首次核心价值动作（有效激活）",
        "MoR 收银自动签发 Ed25519 离线 License",
        "同步 data_analysis 核算转化率与扣除 Token 后的净毛利",
      ],
      assets: [
        { kind: "product", name: "PageLens 同传 (pagelens-interpret)", reference: "https://github.com/magele758/pagelens-interpret" },
        { kind: "project", name: "opc-commerce-kit · 离线授权与毛利台账", reference: "https://github.com/magele758/opc-commerce-kit" },
        { kind: "project", name: "opc-gtm-kit · 着陆页与 UTM 归因", reference: "https://github.com/magele758/opc-gtm-kit" },
        { kind: "project", name: "opc-ops-kit · 工单与激活遥测", reference: "https://github.com/magele758/opc-ops-kit" },
      ],
    },
    starterTrial: {
      title: "PageLens 同传 Pro 首发定价与离线授权闭环验证",
      hypothesis: "在长视频外语学习与技术演讲场景下，提供纯享中文配音与后台队列可促使用户完成 $29 买断或 $19/年付费。",
      metric: "首发渠道 UV→激活率 ≥ 25%，激活→Pro 首单转化率 ≥ 3%，扣除成本后净毛利率 ≥ 80%。",
      scope: "仅开放公开着陆页、Waitlist 与沙盒/MoR 收银台，客户端使用 Ed25519 公钥离线验签解锁 Pro。",
    },
  },
  {
    id: "open-core-prosumer",
    title: "开发者 / Prosumer Open-Core 变现线",
    badge: "高客单复利",
    summary: "用高口碑开源核心吸引开发者自传播，对桌面安装包、远程编排与团队协作能力提供付费授权。",
    line: {
      name: "Open-Core 开发者商业线",
      mode: "experiment",
      goal: "将开源 Star 与自然下载转化为桌面端或远程控制 Pro 许可收入，保持清晰开源协议边界。",
      steps: [
        "审计 MIT/Apache-2.0 与商业增值模块边界",
        "发布带 Release Notes 与演示动图的开源版本",
        "提供免折腾桌面安装包 / 手机远程增值授权",
        "将高频用户工单回流研发选题持续构筑壁垒",
      ],
      assets: [
        { kind: "product", name: "audiobook · 有声书桌面端", reference: "https://github.com/magele758/audiobook" },
        { kind: "product", name: "hyper-vibekanban · 手机远程 Agent 看板", reference: "https://github.com/magele758/hyper-vibekanban" },
        { kind: "project", name: "opc-commerce-kit · 设备席位激活", reference: "https://github.com/magele758/opc-commerce-kit" },
      ],
    },
    starterTrial: {
      title: "audiobook macOS 免配置打包版 vs 源码自建转化对比",
      hypothesis: "非技术重度阅读用户愿意为免配环境的一键 macOS 安装包支付 $29 买断费用。",
      metric: "着陆页下载点击率 ≥ 12%，付费购买转化 ≥ 2%，7 日退款率 < 5%。",
      scope: "提供开源源码免费自建入口与 Pro 签名包购买入口对照观察。",
    },
  },
  {
    id: "automated-shop-ops",
    title: "受控自动化跨境店铺运营线",
    badge: "场景现金流",
    summary: "复用 PageLens Agent 与 ChromeGate 人工闸门，在小流量真实商品上架中验证人效提升与店铺净流入。",
    line: {
      name: "店铺运营",
      mode: "experiment",
      goal: "在小范围内验证 Chrome 插件能为哪一步店铺工作节省时间或带来收入。",
      steps: [
        "ChromeGate 场景预检 (--dry-run)",
        "限定商品范围生成草稿并经人工弹窗确认发布",
        "按币种登记实际收款、退款与平台费用",
        "将表单异常观察一键转交研发候选修复",
      ],
      assets: [
        { kind: "plugin", name: "pagelens-agent · 电商表单侧栏", reference: "https://github.com/magele758/pagelens-agent" },
        { kind: "plugin", name: "chromegate-gateway · 受控执行与预检", reference: "https://github.com/magele758/chromegate-gateway" },
      ],
    },
    starterTrial: {
      title: "跨境店铺 10 款测试商品受控草稿上架与出单核算",
      hypothesis: "通过字段预检与半自动填表可将单品上架耗时压缩 70% 且零违规误发。",
      metric: "10 款草稿一次校验通过率 ≥ 90%，逐笔核对收款与平台佣金净流入。",
      scope: "仅限授权测试店铺后台，最终提交发布动作强制保留人工确认。",
    },
  },
  {
    id: "lead-magnet-funnel",
    title: "免费轻工具矩阵导流线（Lead Magnet）",
    badge: "零成本获客",
    summary: "把高趣味、天然易传播的轻网页工具变成零广告费私域漏斗入口，持续向旗舰付费产品输血。",
    line: {
      name: "轻工具流量漏斗",
      mode: "experiment",
      goal: "利用免登录轻工具承接自然搜索与社媒传播，通过嵌入式横幅向旗舰付费产品稳定导流。",
      steps: [
        "上线零门槛互动小工具子站",
        "挂载 opc-gtm-kit 生成的 UTM 导流横幅",
        "承接 Waitlist 邮件订阅并触发自动欢迎信",
        "在增长报告核对 lead_magnet 渠道激活与首单贡献",
      ],
      assets: [
        { kind: "product", name: "Rubiks-Cube-Learn", reference: "https://github.com/magele758/Rubiks-Cube-Learn" },
        { kind: "product", name: "bazi-ziwei-learning", reference: "https://github.com/magele758/bazi-ziwei-learning" },
        { kind: "method", name: "opc-gtm-kit · Lead Magnet 导流脚本", reference: "https://github.com/magele758/opc-gtm-kit" },
      ],
    },
    starterTrial: {
      title: "轻工具底部非打扰导流条向 PageLens 引流实验",
      hypothesis: "在用户完成一次互动体验后展示主产品动图卡片，可获得高于普通外链的激活率。",
      metric: "横幅点击率 ≥ 2.5%，导流访客有效激活率 ≥ 15%。",
      scope: "仅在体验结果页底部展示轻量推荐条，不阻断原工具正常使用。",
    },
  },
  {
    id: "core-rd-factory",
    title: "供给侧产研与能力复用工厂",
    badge: "工程底座",
    summary: "从每日复盘启发与客户工单出发，经自动选题、Zoom 计划审批、Herdr 隔离编码与独立评审高质量交付。",
    line: {
      name: "技术研发",
      mode: "development",
      goal: "从维护问题和新特性中选出值得交付的工作，追踪发布后的采用。",
      steps: ["收集线索与工单回流", "自动选题评分排序", "Zoom 审批工程计划", "隔离工作树开发与独立评审", "确定性验收与发版回访"],
      assets: [
        { kind: "project", name: "agent-zoom (OPC OS)", reference: "https://github.com/magele758/agent-zoom" },
        { kind: "project", name: "ppeng-agent-bot", reference: "https://github.com/magele758/ppeng-agent-bot" },
        { kind: "project", name: "chromegate-gateway", reference: "https://github.com/magele758/chromegate-gateway" },
      ],
    },
    starterTrial: {
      title: "工单缺陷到研发修复与提单用户回访闭环",
      hypothesis: "将线上 P1 缺陷工单直接转入研发候选并在发版后自动生成回访通知，可显著提升早期付费留存。",
      metric: "确认缺陷 48 小时内进入工程计划，发版后 100% 生成提单人回访草稿。",
      scope: "仅自动登记候选与草稿，代码执行计划与对外发信均经人工批准。",
    },
  },
];

const DEFAULT_PILOT: PilotFocusConfig = {
  product: "PageLens",
  project: "pagelens-interpret",
  slug: "pagelens-interpret",
  targetPrice: "$29 买断 / $19 年付",
  freezeNewInfraRepos: true,
  note: "聚焦 1 号商业试点：先跑通 PageLens 同传从着陆页、UTM 获客、有效激活、离线 License 收银到 data_analysis 毛利漏斗复盘的完整闭环。",
  updatedAt: new Date(0).toISOString(),
};

const pilotSchema = z.strictObject({
  product: z.string().trim().min(1).max(120),
  project: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(120),
  targetPrice: z.string().trim().min(1).max(120),
  freezeNewInfraRepos: z.boolean().default(true),
  note: z.string().trim().max(1000).default(""),
});

const applyPlaybookSchema = z.strictObject({
  startTrial: z.boolean().default(true),
});

const closedLoopSchema = z.strictObject({
  product: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(120).optional(),
  customerId: z.string().trim().min(1).max(120).optional(),
  channel: z.string().trim().min(1).max(80).default("xiaohongshu"),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  grossMinor: z.number().int().positive().max(10_000_000).default(2900),
  llmCostMinor: z.number().int().nonnegative().max(10_000_000).default(180),
});

export type CommercialEndpoints = {
  commerceOrigin?: string;
  gtmOrigin?: string;
  opsOrigin?: string;
  dataAnalysisOrigin?: string;
  agentHomeOrigin?: string;
  agentHubOrigin?: string;
  opcOrigin?: string;
  submitToken?: string;
};

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const res = schema.safeParse(raw);
  if (!res.success) {
    throw new ApiError(
      400,
      "commercial_input",
      res.error.issues.map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message).join(" / "),
    );
  }
  return res.data;
}

function firstExistingDir(candidates: Array<string | undefined>): string | null {
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return resolve(dir);
  }
  return null;
}

async function probeJson(
  url: string,
  timeoutMs = 1200,
): Promise<{ ok: boolean; latencyMs: number | null; body: Record<string, unknown> | null }> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, latencyMs, body: null };
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      return { ok: true, latencyMs, body: parsed && typeof parsed === "object" ? parsed : {} };
    } catch {
      return { ok: true, latencyMs, body: {} };
    }
  } catch {
    return { ok: false, latencyMs: null, body: null };
  }
}

async function postJson<T = Record<string, unknown>>(
  origin: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 6000,
): Promise<T> {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(502, "companion_error", String(data.message || data.detail || data.error || `${path} HTTP ${response.status}`));
  }
  return data as T;
}

export class CommercialHubService {
  private projects: ProjectStore;
  private company: CompanyStore;
  private profiles: ProjectProfiles;
  private business: BusinessStore;
  private growth: GrowthLedger;
  private db: DatabaseSync;
  private opportunities: OpportunityStore;
  private endpoints: CommercialEndpoints;

  constructor(db: DatabaseSync, opportunities: OpportunityStore, endpoints: CommercialEndpoints = {}) {
    this.db = db;
    this.opportunities = opportunities;
    this.endpoints = endpoints;
    this.projects = new ProjectStore(db);
    this.company = new CompanyStore(db);
    this.profiles = new ProjectProfiles(db);
    this.business = new BusinessStore(db, opportunities);
    this.growth = new GrowthLedger(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS opc_governance_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private origins() {
    return {
      commerce: this.endpoints.commerceOrigin || process.env.OPC_COMMERCE_URL || "http://127.0.0.1:52331",
      gtm: this.endpoints.gtmOrigin || process.env.OPC_GTM_URL || "http://127.0.0.1:52332",
      ops: this.endpoints.opsOrigin || process.env.OPC_OPS_URL || "http://127.0.0.1:52333",
      data_analysis: this.endpoints.dataAnalysisOrigin || process.env.OPC_DATA_ANALYSIS_URL || "http://127.0.0.1:8000",
      agent_home: this.endpoints.agentHomeOrigin || process.env.AGENT_HOME_URL || "http://127.0.0.1:37070",
      agent_hub: this.endpoints.agentHubOrigin || process.env.AGENT_HUB_URL || "http://127.0.0.1:28790",
      opc:
        this.endpoints.opcOrigin ||
        process.env.OPC_URL ||
        process.env.KUNLUN_URL ||
        `http://127.0.0.1:${process.env.PORT || "52328"}`,
      submitToken: this.endpoints.submitToken ?? process.env.WORKFLOW_SUBMIT_TOKEN ?? "",
    };
  }

  private serviceDirs() {
    const cwd = process.cwd();
    return {
      commerce: firstExistingDir([process.env.OPC_COMMERCE_DIR, resolve(cwd, "../opc-commerce-kit")]),
      gtm: firstExistingDir([process.env.OPC_GTM_DIR, resolve(cwd, "../opc-gtm-kit")]),
      ops: firstExistingDir([process.env.OPC_OPS_DIR, resolve(cwd, "../opc-ops-kit")]),
      data_analysis: firstExistingDir([
        process.env.OPC_DATA_ANALYSIS_DIR,
        resolve(cwd, "../data_analysis"),
        resolve(cwd, "../data-agent"),
        resolve(cwd, "../../self-test-grounding/data-agent"),
      ]),
    };
  }

  pilot(): PilotFocusConfig {
    const row = this.db.prepare("SELECT value FROM opc_governance_kv WHERE key='pilot_focus'").get();
    if (!row) return { ...DEFAULT_PILOT, updatedAt: new Date().toISOString() };
    try {
      return { ...DEFAULT_PILOT, ...JSON.parse(String(row.value)) };
    } catch {
      return { ...DEFAULT_PILOT, updatedAt: new Date().toISOString() };
    }
  }

  savePilot(raw: unknown): PilotFocusConfig {
    const parsed = parseInput(pilotSchema, raw);
    const next: PilotFocusConfig = { ...parsed, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO opc_governance_kv(key, value, updated_at) VALUES('pilot_focus', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(JSON.stringify(next), next.updatedAt);
    return next;
  }

  lastAnalytics(): AnalyticsSyncSnapshot | null {
    const row = this.db.prepare("SELECT value FROM opc_governance_kv WHERE key='analytics_snapshot'").get();
    if (!row) return null;
    try {
      return JSON.parse(String(row.value)) as AnalyticsSyncSnapshot;
    } catch {
      return null;
    }
  }

  private saveAnalyticsSnapshot(snapshot: AnalyticsSyncSnapshot) {
    this.db
      .prepare(
        `INSERT INTO opc_governance_kv(key, value, updated_at) VALUES('analytics_snapshot', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(JSON.stringify(snapshot), snapshot.syncedAt);
  }

  bootstrapCompany() {
    for (const asset of BLUEPRINT_ASSETS) {
      this.projects.create({ name: asset.product });
      this.company.createProject({ product: asset.product, name: asset.project, repos: [] });
    }

    const reuseByProject = new Map<string, Array<{ product: string; project: string; reference: string; purpose: string }>>([
      [
        "PageLens/pagelens-interpret",
        [
          {
            product: "OPC 商业套件",
            project: "opc-commerce-kit",
            reference: "OPCL1 Ed25519 离线验签 SDK",
            purpose: "本地离线解锁同传 Pro 配额与导出功能",
          },
          {
            product: "OPC 商业套件",
            project: "opc-gtm-kit",
            reference: "manifests/pagelens-interpret.json",
            purpose: "生成产品着陆页、Chrome 商店隐私声明与多平台带 UTM 推广稿",
          },
          {
            product: "OPC 商业套件",
            project: "opc-ops-kit",
            reference: "/api/v1/telemetry/events & /api/v1/tickets",
            purpose: "去隐私首次激活统计与用户反馈自动分诊",
          },
        ],
      ],
      [
        "PageLens/pagelens-agent",
        [
          {
            product: "OPC 分析与内核",
            project: "chromegate-gateway",
            reference: "verify scenario.json --dry-run",
            purpose: "电商草稿提交前场景校验与人工确认闸门",
          },
        ],
      ],
      [
        "audiobook/audiobook",
        [
          {
            product: "OPC 商业套件",
            project: "opc-commerce-kit",
            reference: "OPCL1 Ed25519 + 桌面设备席位控制",
            purpose: "macOS 安装包离线授权与设备数管理",
          },
        ],
      ],
    ]);

    const currentProfiles = new Map(this.profiles.all().map((p) => [`${p.product}/${p.project}`, p]));
    let profilesUpdated = 0;
    for (const asset of BLUEPRINT_ASSETS) {
      const key = `${asset.product}/${asset.project}`;
      const existing = currentProfiles.get(key);
      if (!existing) continue;
      const layerLabel = `${asset.layer} · ${opcLayers.find((l) => l.id === asset.layer)?.name ?? asset.layer}`;
      const nextLayer = existing.layer || layerLabel;
      const nextDomain = existing.domain || asset.domain;
      const presetUses = reuseByProject.get(key) ?? [];
      const mergedUses = existing.uses.length ? existing.uses : presetUses;
      if (
        nextLayer !== existing.layer ||
        nextDomain !== existing.domain ||
        JSON.stringify(mergedUses) !== JSON.stringify(existing.uses)
      ) {
        this.profiles.save({
          product: asset.product,
          project: asset.project,
          layer: nextLayer,
          domain: nextDomain,
          revision: existing.revision,
          uses: mergedUses,
        });
        profilesUpdated++;
      }
    }

    let linesConfigured = 0;
    for (const playbookId of [
      "flagship-extension-monetization",
      "open-core-prosumer",
      "automated-shop-ops",
      "core-rd-factory",
    ]) {
      const applied = this.applyPlaybook(playbookId, { startTrial: playbookId === "flagship-extension-monetization" });
      if (applied) linesConfigured++;
    }

    if (!this.db.prepare("SELECT 1 FROM opc_governance_kv WHERE key='pilot_focus'").get()) {
      const { updatedAt: _ignored, ...initialPilot } = DEFAULT_PILOT;
      void _ignored;
      this.savePilot(initialPilot);
    }

    const opsDept = new OperationsDepartmentStore(this.db);
    const defaultManagedServices = [
      {
        id: "550e8400-e29b-41d4-a716-446655440501",
        name: "OPC Commerce Kit",
        scope: "OPC 商业套件/opc-commerce-kit",
        version: "0.1.0",
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440502",
        name: "OPC GTM Kit",
        scope: "OPC 商业套件/opc-gtm-kit",
        version: "0.1.0",
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440503",
        name: "OPC Ops Kit",
        scope: "OPC 商业套件/opc-ops-kit",
        version: "0.1.0",
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440504",
        name: "Data Analysis Engine",
        scope: "OPC 分析与内核/data_analysis",
        version: "1.0.0",
      },
    ];
    for (const svc of defaultManagedServices) {
      try {
        opsDept.create(svc);
      } catch {
        // Already registered
      }
    }

    return {
      ok: true,
      productsCount: this.projects.names().length,
      projectsCount: this.company.index().projects.length,
      profilesUpdated,
      linesConfigured,
      pilot: this.pilot(),
    };
  }

  applyPlaybook(playbookId: string, rawOptions: unknown = {}) {
    const options = parseInput(applyPlaybookSchema, rawOptions ?? {});
    const playbook = BUSINESS_PLAYBOOKS.find((item) => item.id === playbookId);
    if (!playbook) throw new ApiError(404, "playbook_not_found", "未找到该业务线模板");

    const existing = this.business.lines().find((l) => l.name === playbook.line.name);
    let line = existing;
    if (!line) {
      line = this.business.create(playbook.line);
    } else if (line.assets.length === 0) {
      line = this.business.update(line.id, {
        ...playbook.line,
        steps: line.steps.length ? line.steps : playbook.line.steps,
        revision: line.revision,
      });
    }

    let trial = null;
    if (options.startTrial) {
      trial = this.business.start(line.id, {
        requestId: `playbook-${playbook.id}-starter`,
        ...playbook.starterTrial,
      });
    }
    return { playbookId: playbook.id, line, trial };
  }

  async checkServices(): Promise<{
    services: CompanionServiceStatus[];
    rawBodies: Partial<Record<CompanionServiceId, Record<string, unknown>>>;
  }> {
    const origins = this.origins();
    const dirs = this.serviceDirs();
    const specs: Array<{
      id: CompanionServiceId;
      name: string;
      repo: string;
      layer: CompanionServiceStatus["layer"];
      origin: string;
      healthPath: string;
      canStart: boolean;
    }> = [
      {
        id: "commerce",
        name: "OPC Commerce Kit（收银·离线授权·毛利）",
        repo: "magele758/opc-commerce-kit",
        layer: "L5",
        origin: origins.commerce,
        healthPath: "/api/health",
        canStart: Boolean(dirs.commerce && existsSync(join(dirs.commerce, "src/cli.ts"))),
      },
      {
        id: "gtm",
        name: "OPC GTM Kit（门面·合规·UTM·多渠道分发）",
        repo: "magele758/opc-gtm-kit",
        layer: "L5",
        origin: origins.gtm,
        healthPath: "/api/health",
        canStart: Boolean(dirs.gtm && existsSync(join(dirs.gtm, "src/cli.ts"))),
      },
      {
        id: "ops",
        name: "OPC Ops Kit（统一工单·激活遥测·崩溃指纹）",
        repo: "magele758/opc-ops-kit",
        layer: "L5",
        origin: origins.ops,
        healthPath: "/api/health",
        canStart: Boolean(dirs.ops && existsSync(join(dirs.ops, "src/cli.ts"))),
      },
      {
        id: "data_analysis",
        name: "Data Analysis（DuckDB·本体·漏斗与归因）",
        repo: "magele758/data_analysis",
        layer: "L4",
        origin: origins.data_analysis,
        healthPath: "/health",
        canStart: Boolean(
          dirs.data_analysis &&
            (existsSync(join(dirs.data_analysis, ".venv/bin/uvicorn")) ||
              existsSync(join(dirs.data_analysis, ".venv/bin/python"))),
        ),
      },
      {
        id: "agent_home",
        name: "Agent Home / ppeng-agent-bot（常驻 Bot OS）",
        repo: "magele758/ppeng-agent-bot",
        layer: "L1",
        origin: origins.agent_home,
        healthPath: "/api/health",
        canStart: false,
      },
      {
        id: "agent_hub",
        name: "Agent Hub（每日投入工作看板）",
        repo: "magele758/agent-zoom",
        layer: "L2",
        origin: origins.agent_hub,
        healthPath: "/",
        canStart: false,
      },
    ];

    const rawBodies: Partial<Record<CompanionServiceId, Record<string, unknown>>> = {};
    const services = await Promise.all(
      specs.map(async (spec): Promise<CompanionServiceStatus> => {
        const probe = await probeJson(spec.origin.replace(/\/$/, "") + spec.healthPath);
        if (probe.ok && probe.body) rawBodies[spec.id] = probe.body;
        let summary = probe.ok ? "在线运行中" : spec.canStart ? "未启动（支持一键拉起联动）" : "未检测到在线实例";
        if (probe.ok && probe.body) {
          const stats = probe.body.stats as Record<string, unknown> | undefined;
          if (spec.id === "commerce" && stats) {
            summary = `${Number(stats.orderCount ?? 0)} 笔订单 · ${Number(stats.activeLicenses ?? 0)} 张有效授权`;
          } else if (spec.id === "gtm" && stats) {
            summary = `${Number(stats.acquisitions ?? stats.totalAcquisitions ?? 0)} 次获客归因 · ${Number(stats.waitlist ?? stats.waitlistCount ?? 0)} 人候补`;
          } else if (spec.id === "ops" && stats) {
            const tickets = (stats.tickets as Record<string, unknown>) ?? {};
            const telemetry = (stats.telemetry as Record<string, unknown>) ?? {};
            summary = `${Number(tickets.open ?? 0)} 张待办工单 · ${Number(telemetry.activatedUsers ?? 0)} 位激活用户`;
          } else if (spec.id === "data_analysis") {
            summary = "DuckDB + Ontology 分析引擎就绪";
          }
        }
        return {
          id: spec.id,
          name: spec.name,
          repo: spec.repo,
          layer: spec.layer,
          origin: spec.origin,
          healthy: probe.ok,
          managedCanStart: spec.canStart,
          latencyMs: probe.latencyMs,
          summary,
          ...(probe.body ? { details: probe.body } : {}),
        };
      }),
    );

    return { services, rawBodies };
  }

  async ensureServices(): Promise<{ started: CompanionServiceId[]; services: CompanionServiceStatus[] }> {
    const origins = this.origins();
    const dirs = this.serviceDirs();
    const initial = await this.checkServices();
    const started: CompanionServiceId[] = [];
    const runtimeRoot = join(process.cwd(), "data", "companion-runtime");
    mkdirSync(runtimeRoot, { mode: 0o700, recursive: true });
    const pidFile = join(runtimeRoot, "pids.json");
    let pids: Record<string, number> = {};
    try {
      pids = JSON.parse(readFileSync(pidFile, "utf8"));
    } catch {
      pids = {};
    }

    const spawnNodeService = (id: "commerce" | "gtm" | "ops", dir: string, originUrl: string) => {
      const port = new URL(originUrl).port || (id === "commerce" ? "52331" : id === "gtm" ? "52332" : "52333");
      const dataDir = join(runtimeRoot, id);
      mkdirSync(dataDir, { mode: 0o700, recursive: true });
      const dbFile = join(dataDir, `${id}.db`);
      const child = spawn(process.execPath, ["src/cli.ts", "serve", "--port", port, "--db", dbFile], {
        cwd: dir,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: port,
          DATA_DIR: dataDir,
          OPC_COMMERCE_DB: dbFile,
          OPS_DB_PATH: dbFile,
          OPC_OS_URL: origins.opc,
          OPC_OS_TOKEN: origins.submitToken,
          DATA_ANALYSIS_URL: origins.data_analysis,
        },
      });
      child.unref();
      if (child.pid) pids[id] = child.pid;
      started.push(id);
    };

    for (const id of ["commerce", "gtm", "ops"] as const) {
      const status = initial.services.find((s) => s.id === id);
      const dir = dirs[id];
      if (!status?.healthy && dir && existsSync(join(dir, "src/cli.ts"))) {
        spawnNodeService(id, dir, origins[id]);
      }
    }

    const daStatus = initial.services.find((s) => s.id === "data_analysis");
    if (!daStatus?.healthy && dirs.data_analysis) {
      const py = join(dirs.data_analysis, ".venv/bin/python");
      if (existsSync(py)) {
        const port = new URL(origins.data_analysis).port || "8000";
        const child = spawn(py, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", port], {
          cwd: dirs.data_analysis,
          detached: true,
          stdio: "ignore",
          env: { ...process.env, DATA_AGENT_REQUIRE_AUTH: "false" },
        });
        child.unref();
        if (child.pid) pids.data_analysis = child.pid;
        started.push("data_analysis");
      }
    }

    if (started.length > 0) {
      writeFileSync(pidFile, JSON.stringify(pids, null, 2) + "\n", { mode: 0o600 });
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const check = await this.checkServices();
        if (started.every((id) => check.services.find((s) => s.id === id)?.healthy)) {
          return { started, services: check.services };
        }
        await delay(300);
      }
    }

    const finalCheck = await this.checkServices();
    return { started, services: finalCheck.services };
  }

  async overview(): Promise<CommercialOverview> {
    const pilot = this.pilot();
    const { services } = await this.checkServices();
    const origins = this.origins();

    const [commerceSum, gtmSum, opsSum] = await Promise.all([
      services.find((s) => s.id === "commerce")?.healthy
        ? probeJson(`${origins.commerce}/api/v1/summary?product=${encodeURIComponent(pilot.product)}`)
        : Promise.resolve({ ok: false, latencyMs: null, body: null }),
      services.find((s) => s.id === "gtm")?.healthy
        ? probeJson(`${origins.gtm}/api/v1/summary?product=${encodeURIComponent(pilot.product)}`)
        : Promise.resolve({ ok: false, latencyMs: null, body: null }),
      services.find((s) => s.id === "ops")?.healthy
        ? probeJson(`${origins.ops}/api/v1/summary?product=${encodeURIComponent(pilot.product)}`)
        : Promise.resolve({ ok: false, latencyMs: null, body: null }),
    ]);

    const growthReport = this.growth.report(pilot.product);
    const companyIndex = this.company.index();
    const registeredSet = new Set(companyIndex.projects.map((p) => `${p.product}/${p.name}`));
    const profiles = this.profiles.all();
    const layeredCount = profiles.filter((p) => p.layer.trim().length > 0).length;

    const currencies = Array.isArray(commerceSum.body?.currencies)
      ? (commerceSum.body!.currencies as CommercialMetrics["currencies"])
      : [];
    const orders = Number(commerceSum.body?.orderCount ?? growthReport.total.firstOrder + growthReport.total.repeatOrder);
    const activeLicenses = Number(commerceSum.body?.activeLicenses ?? 0);
    const waitlistSubscribers = Number(
      gtmSum.body?.waitlistCount ?? gtmSum.body?.waitlist ?? 0,
    );
    const campaigns = Number(gtmSum.body?.campaignCount ?? gtmSum.body?.campaigns ?? 0);
    const opsTickets = (opsSum.body?.tickets as Record<string, unknown> | undefined) ?? {};
    const opsTelemetry = (opsSum.body?.telemetry as Record<string, unknown> | undefined) ?? {};
    const openTickets = Number(opsTickets.open ?? 0);
    const pendingFollowups = Number(opsTickets.pendingFollowups ?? 0);
    const crashFreeRate =
      typeof opsTelemetry.crashFreeSessionRate === "number" ? opsTelemetry.crashFreeSessionRate : null;

    const analytics = this.lastAnalytics();
    const gtmHealthy = Boolean(services.find((s) => s.id === "gtm")?.healthy);
    const commerceHealthy = Boolean(services.find((s) => s.id === "commerce")?.healthy);
    const opsHealthy = Boolean(services.find((s) => s.id === "ops")?.healthy);

    const checklist: PilotChecklistStep[] = [
      {
        id: "blueprint",
        label: "7 层架构与公司项目台账归档",
        done: registeredSet.has(`${pilot.product}/${pilot.project}`) && layeredCount >= 6,
        detail: `已登记 ${companyIndex.projects.length} 个子项目，其中 ${layeredCount} 个完成层级标注`,
        href: "#projects?" + new URLSearchParams({ product: pilot.product }),
      },
      {
        id: "storefront",
        label: "高转化产品门面与商店隐私合规底板",
        done: gtmHealthy,
        detail: gtmHealthy
          ? `GTM 服务在线（${origins.gtm}/preview/${pilot.slug} 可直接预览门面与隐私政策）`
          : "启动 opc-gtm-kit 后自动生成产品着陆页与 Chrome 商店审核合规声明",
        href: "#commercial",
      },
      {
        id: "acquisition",
        label: "带参（UTM）渠道获客与私域候补打通",
        done: growthReport.total.acquired > 0 || waitlistSubscribers > 0,
        detail: `${pilot.product} 累计归因获客 ${growthReport.total.acquired} 人 · 候补订阅 ${waitlistSubscribers} 人`,
        href: "#growth?" + new URLSearchParams({ product: pilot.product }),
      },
      {
        id: "activation",
        label: "客户端去隐私遥测与有效激活回流",
        done: growthReport.total.activated > 0,
        detail: `${pilot.product} 已验证核心价值激活 ${growthReport.total.activated} 人`,
        href: "#growth?" + new URLSearchParams({ product: pilot.product }),
      },
      {
        id: "billing_license",
        label: "MoR 收银网关与 Ed25519 离线 License 签发",
        done: commerceHealthy && activeLicenses > 0,
        detail: commerceHealthy
          ? `离线验签公钥已就绪 · 当前有效授权 ${activeLicenses} 张`
          : "启动 opc-commerce-kit 以启用 MoR Webhook 与 OPCL1 离线签名",
        href: "#commercial",
      },
      {
        id: "first_order",
        label: "首笔真实/沙盒订单入账与净毛利核算",
        done: growthReport.total.firstOrder > 0 && currencies.length > 0,
        detail:
          currencies.length > 0
            ? `已入账 ${orders} 笔订单 · 主币种净毛利率 ${currencies[0].grossMarginPct ?? 100}%`
            : "等待首笔订单入账与 Token/基础设施成本冲抵核算",
        href: "#business-lines",
      },
      {
        id: "analytics_ops",
        label: "客服分诊闭环与 data_analysis 漏斗洞察同步",
        done: opsHealthy && Boolean(analytics && analytics.importedRows > 0),
        detail: analytics
          ? `已同步 ${analytics.importedRows} 条标准 Trace 至 DuckDB（总转化率 ${analytics.overallConversionPct ?? 0}%）`
          : "点击「同步到 data_analysis」即可在 DuckDB 跑通全链路转化漏斗",
        href: "#commercial",
      },
    ];

    const doneCount = checklist.filter((item) => item.done).length;
    const completionPct = Math.round((doneCount / checklist.length) * 100);

    const layers = opcLayers.map((layer) => ({
      ...layer,
      assets: BLUEPRINT_ASSETS.filter((a) => a.layer === layer.id).map((a) => ({
        ...a,
        enrolled: registeredSet.has(`${a.product}/${a.project}`),
      })),
    }));

    return {
      pilot,
      checklist,
      completionPct,
      layers,
      playbooks: BUSINESS_PLAYBOOKS,
      services,
      metrics: {
        currencies,
        orders,
        activeLicenses,
        waitlistSubscribers,
        campaigns,
        openTickets,
        pendingFollowups,
        crashFreeRate,
        funnel: growthReport.total,
      },
      analytics,
    };
  }

  private exportLocalGrowthTraces(product?: string) {
    const query = product
      ? this.db
          .prepare(
            "SELECT product,event_id,customer_id,kind,at,reference,channel,order_id FROM growth_events WHERE product=? ORDER BY at",
          )
          .all(product)
      : this.db
          .prepare(
            "SELECT product,event_id,customer_id,kind,at,reference,channel,order_id FROM growth_events ORDER BY at",
          )
          .all();

    return query.map((row) => {
      const createdAt = String(row.at);
      const ts = Date.parse(createdAt);
      return {
        event_id: `opc-growth-${row.product}-${row.event_id}`,
        trace_id: `cust-${row.product}-${row.customer_id}`,
        span_id: String(row.event_id).slice(0, 32),
        parent_span_id: null,
        session_id: `cust-${row.customer_id}`,
        user_id: String(row.customer_id),
        event_type: "opc_growth",
        event_name: String(row.kind),
        service_name: String(row.product),
        page_path: row.channel ? `/utm/${row.channel}` : "/app",
        page_url: String(row.reference),
        page_title: String(row.product),
        status_code: "200",
        duration_ms: 0,
        created_at: createdAt,
        timestamp_ms: Number.isFinite(ts) ? ts : Date.now(),
        properties: JSON.stringify({
          product: row.product,
          channel: row.channel ?? null,
          orderId: row.order_id ?? null,
          reference: row.reference,
        }),
      };
    });
  }

  async syncAnalytics(product?: string): Promise<AnalyticsSyncSnapshot> {
    const origins = this.origins();
    const targetProduct = product?.trim() || this.pilot().product;
    const recordsById = new Map<string, Record<string, unknown>>();
    for (const row of this.exportLocalGrowthTraces(targetProduct)) {
      recordsById.set(String(row.event_id), row);
    }

    for (const origin of [origins.commerce, origins.gtm, origins.ops]) {
      const probe = await probeJson(
        `${origin}/api/v1/export/traces?product=${encodeURIComponent(targetProduct)}`,
        2000,
      );
      const list = Array.isArray(probe.body?.records)
        ? (probe.body!.records as Array<Record<string, unknown>>)
        : Array.isArray(probe.body?.traces)
          ? (probe.body!.traces as Array<Record<string, unknown>>)
          : [];
      for (const item of list) {
        if (item && typeof item.event_id === "string") {
          recordsById.set(item.event_id, {
            ...item,
            status_code: item.status_code != null ? String(item.status_code) : "200",
          });
        }
      }
    }

    const records = [...recordsById.values()];
    if (records.length === 0) {
      throw new ApiError(400, "no_traces", `${targetProduct} 暂无可同步的增长或商业事件记录`);
    }

    const sessionId = "opc_os_live";
    const datasetName = "opc_commercial_traces";
    await postJson(origins.data_analysis, "/api/v1/import/traces", {
      session_id: sessionId,
      dataset_name: datasetName,
      records,
    });

    const funnel = await postJson<{
      steps?: Array<{ step_index: number; step_name: string; user_count: number }>;
      overall_conversion_rate?: number;
    }>(origins.data_analysis, "/api/v1/analytics/funnel", {
      session_id: sessionId,
      dataset_name: datasetName,
      steps: ["acquired", "activated", "order"],
    });

    const steps = Array.isArray(funnel.steps) ? funnel.steps : [];
    const first = steps[0]?.user_count ?? 0;
    const last = steps.at(-1)?.user_count ?? 0;
    const overallConversionPct =
      first > 0 ? Math.round((last / first) * 1000) / 10 : null;

    const snapshot: AnalyticsSyncSnapshot = {
      syncedAt: new Date().toISOString(),
      sessionId,
      datasetName,
      importedRows: records.length,
      funnelSteps: steps,
      overallConversionPct,
      summary: `已向 data_analysis (${sessionId}.${datasetName}) 写入 ${records.length} 条全链路事件，获客→激活→下单总转化率 ${overallConversionPct ?? 0}%`,
    };
    this.saveAnalyticsSnapshot(snapshot);
    return snapshot;
  }

  async runClosedLoopVerification(rawInput: unknown = {}) {
    const input = parseInput(closedLoopSchema, rawInput ?? {});
    const pilot = this.pilot();
    const product = input.product || pilot.product;
    const slug = input.slug || pilot.slug;
    const origins = this.origins();

    this.bootstrapCompany();
    await this.ensureServices();

    const stamp = Date.now().toString(36);
    const customerId = input.customerId || `pilot-cust-${stamp}`;
    const orderId = `ORD-${stamp.toUpperCase()}`;
    const baseTs = Date.now();
    const t0 = new Date(baseTs - 120_000).toISOString();
    const t1 = new Date(baseTs - 60_000).toISOString();
    const t2 = new Date(baseTs).toISOString();

    const applied = this.applyPlaybook("flagship-extension-monetization", { startTrial: true });
    const trialId = applied.trial?.id;

    // 1. GTM: Generate compliance + multi-channel UTM bundle + record acquisition
    const gtmCampaign = await postJson(origins.gtm, "/api/v1/repurpose", {
      product,
      slug,
      title: `${product} Pro 首发上线：本地优先 + 离线授权`,
      summary: "10 秒开启双语实时同传与纯享中文配音，支持离线 Ed25519 授权解锁。",
      highlights: ["实时字幕与中文配音队列", "BYOK 与本地优先隐私保护", "一次买断双设备离线验签"],
      baseUrl: `https://opc.example.com/${slug}`,
      campaign: `launch-${stamp}`,
    });

    const acqRef = `https://opc.example.com/${slug}?utm_source=${encodeURIComponent(input.channel)}&utm_campaign=launch-${stamp}`;
    const acq = await postJson(origins.gtm, "/api/v1/utm/acquire", {
      eventId: `utm-${stamp}`,
      product,
      customerId,
      channel: input.channel,
      campaign: `launch-${stamp}`,
      at: t0,
      reference: acqRef,
    });

    if (!this.db.prepare("SELECT 1 FROM growth_events WHERE product=? AND event_id=?").get(product, `utm-${stamp}`)) {
      this.growth.record({
        product,
        customerId,
        eventId: `utm-${stamp}`,
        kind: "acquired",
        channel: input.channel,
        at: t0,
        reference: acqRef,
      });
    }

    // 2. Ops: Record client meaningful activation telemetry
    const actRef = `telemetry://${slug}/first_meaningful_action/${stamp}`;
    const telemetry = await postJson(origins.ops, "/api/v1/telemetry/events", {
      eventId: `act-${stamp}`,
      product,
      customerId,
      eventName: "first_meaningful_action",
      isActivation: true,
      appVersion: "0.2.0",
      at: t1,
      reference: actRef,
    });

    if (!this.db.prepare("SELECT 1 FROM growth_events WHERE product=? AND event_id=?").get(product, `ops-act-act-${stamp}`)) {
      this.growth.record({
        product,
        customerId,
        eventId: `ops-act-act-${stamp}`,
        kind: "activated",
        at: t1,
        reference: actRef,
      });
    }

    // 3. Commerce: Record paid order -> issue Ed25519 License -> verify offline -> record LLM cost
    const orderRes = await postJson<{
      order: Record<string, unknown>;
      license: { licenseKey?: string; token?: string; key?: string; licenseId?: string };
    }>(origins.commerce, "/api/v1/orders", {
      provider: "lemonsqueezy",
      orderId,
      product,
      plan: "pro_buyout",
      customerId,
      currency: input.currency,
      grossMinor: input.grossMinor,
      feeMinor: Math.round(input.grossMinor * 0.05) + 50,
      features: ["pro", "offline_dubbing", "batch_queue"],
      maxDevices: 2,
      expiresAt: null,
      at: t2,
      reference: `mor://lemonsqueezy/orders/${orderId}`,
      trialId,
    });

    const licenseKey = String(
      orderRes.license?.licenseKey || orderRes.license?.token || orderRes.license?.key || "",
    );
    const verification = await postJson<{ valid: boolean }>(origins.commerce, "/api/v1/licenses/verify", {
      licenseKey,
      token: licenseKey,
      product,
      requiredFeature: "pro",
    });

    if (input.llmCostMinor > 0) {
      await postJson(origins.commerce, "/api/v1/costs", {
        costId: `cost-llm-${stamp}`,
        product,
        category: "llm_tokens",
        currency: input.currency,
        amountMinor: input.llmCostMinor,
        note: "同传配音推理与模型调用成本计提",
        at: t2,
        reference: `finops://llm/${orderId}`,
      });
    }

    if (!this.db.prepare("SELECT 1 FROM growth_events WHERE product=? AND order_id=?").get(product, orderId)) {
      this.growth.record({
        product,
        customerId,
        eventId: `commerce-order-${orderId}`,
        kind: "order",
        orderId,
        at: t2,
        reference: `mor://lemonsqueezy/orders/${orderId}`,
      });
    }

    if (trialId) {
      try {
        this.business.record(trialId, {
          eventId: `receipt-${orderId}`,
          kind: "receipt",
          currency: input.currency,
          minor: input.grossMinor,
          note: `首单闭环收款 ${orderId}（离线授权验签=${verification.valid ? "通过" : "异常"}）`,
          reference: `mor://lemonsqueezy/orders/${orderId}`,
        });
      } catch {
        // Ignore if evidence was already pushed by commerce bridge
      }
    }

    // 4. Data Analysis: Sync traces and compute DuckDB funnel if data_analysis is online
    let analytics: AnalyticsSyncSnapshot | null = null;
    const daProbe = await probeJson(`${origins.data_analysis}/health`, 1500);
    if (daProbe.ok) {
      analytics = await this.syncAnalytics(product);
    }

    return {
      ok: true,
      product,
      customerId,
      orderId,
      licenseKeyPreview: licenseKey ? `${licenseKey.slice(0, 22)}...${licenseKey.slice(-10)}` : "",
      licenseVerified: verification.valid === true,
      gtmCampaignReady: Boolean(gtmCampaign),
      acquisitionRecorded: Boolean(acq),
      activationRecorded: Boolean(telemetry),
      analytics,
      overview: await this.overview(),
    };
  }

  async issueLicenseProxy(body: Record<string, unknown>) {
    const origins = this.origins();
    return postJson(origins.commerce, "/api/v1/licenses/issue", body);
  }

  async verifyLicenseProxy(body: Record<string, unknown>) {
    const origins = this.origins();
    return postJson(origins.commerce, "/api/v1/licenses/verify", body);
  }

  async generateGtmProxy(body: Record<string, unknown>) {
    const origins = this.origins();
    const [repurposed, legal] = await Promise.all([
      postJson(origins.gtm, "/api/v1/repurpose", body),
      postJson(origins.gtm, "/api/v1/legal/generate", {
        slug: body.slug || this.pilot().slug,
      }),
    ]);
    return {
      previewUrl: `${origins.gtm}/preview/${encodeURIComponent(String(body.slug || this.pilot().slug))}`,
      privacyUrl: `${origins.gtm}/preview/${encodeURIComponent(String(body.slug || this.pilot().slug))}/privacy`,
      repurposed,
      legal,
    };
  }

  async submitTicketProxy(body: Record<string, unknown>) {
    const origins = this.origins();
    return postJson(origins.ops, "/api/v1/tickets", body);
  }
}

export function addCommercialRoutes(
  app: Hono,
  db: DatabaseSync,
  opportunities: OpportunityStore,
  submitToken: string | undefined,
  user: (c: Context) => unknown,
  endpoints?: CommercialEndpoints,
) {
  const hub = new CommercialHubService(db, opportunities, { ...endpoints, submitToken });
  const { permits } = submitAuth(submitToken);

  app.use("/api/opc/commercial/*", async (c, next) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/api/opc/commercial/overview", async (c) => c.json(await hub.overview()));
  app.put("/api/opc/commercial/pilot", async (c) => c.json(hub.savePilot(await c.req.json())));
  app.post("/api/opc/commercial/bootstrap", (c) => c.json(hub.bootstrapCompany()));
  app.post("/api/opc/commercial/playbooks/:id/apply", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(hub.applyPlaybook(c.req.param("id"), body));
  });
  app.post("/api/opc/commercial/services/ensure", async (c) => c.json(await hub.ensureServices()));
  app.post("/api/opc/commercial/actions/sync-analytics", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { product?: string };
    return c.json(await hub.syncAnalytics(body.product));
  });
  app.post("/api/opc/commercial/actions/closed-loop", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await hub.runClosedLoopVerification(body));
  });
  app.post("/api/opc/commercial/actions/issue-license", async (c) =>
    c.json(await hub.issueLicenseProxy((await c.req.json()) as Record<string, unknown>)),
  );
  app.post("/api/opc/commercial/actions/verify-license", async (c) =>
    c.json(await hub.verifyLicenseProxy((await c.req.json()) as Record<string, unknown>)),
  );
  app.post("/api/opc/commercial/actions/generate-gtm", async (c) =>
    c.json(await hub.generateGtmProxy((await c.req.json()) as Record<string, unknown>)),
  );
  app.post("/api/opc/commercial/actions/submit-ticket", async (c) =>
    c.json(await hub.submitTicketProxy((await c.req.json()) as Record<string, unknown>)),
  );

  return hub;
}
