import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CliLedgerOverview, CliSessionStatus, CliSessionSummary } from "../../src/cli-ledger-types";
import type { DarkFactoryOverview } from "../../src/dark-factory-types";
import {
  COMPANY_DEPARTMENTS,
  type AutonomyMode,
  type CompanyArchitectureSnapshot,
  type GovernancePolicy,
} from "../../src/kernel/types";
import type { CommercialHeatmap } from "../../src/metabolism-types";
import type { KanbanBoardResponse } from "../../src/task-planning-types";
import { request } from "./api";
import "./opc-story-flow.css";

type StageId = "capture" | "strategy" | "execution" | "governance" | "commercial";

interface StoryLiveData {
  arch: CompanyArchitectureSnapshot | null;
  cliLedger: CliLedgerOverview | null;
  kanban: KanbanBoardResponse | null;
  factory: DarkFactoryOverview | null;
  heatmap: CommercialHeatmap | null;
}

interface StageActionLink {
  label: string;
  href: string;
  desc: string;
  primary?: boolean;
}

interface StageDefinition {
  id: StageId;
  num: string;
  title: string;
  roleTag: string;
  tone: "capture" | "strategy" | "execution" | "governance" | "commercial";
  principle: string;
  upstream: string[];
  mechanics: string[];
  downstream: string[];
  links: StageActionLink[];
}

const ORIGIN_PILLARS: ReadonlyArray<{
  code: string;
  badge: string;
  title: string;
  body: string;
  tags: string[];
  tone: "pain" | "bridge" | "outcome";
}> = [
  {
    code: "01",
    badge: "痛点缘起",
    title: "为什么会乱（碎片化痛点）",
    body: "多个 CLI（Codex / Claude / Antigravity / Grok / Cursor）各自开窗，忘了发过什么指令、干到哪步；灵感和日报散落各处没立项；写了大量代码基建却没打通收款与止损。",
    tags: ["多 CLI 失忆断层", "灵感散落难立项", "基建空转缺止损"],
    tone: "pain",
  },
  {
    code: "02",
    badge: "OPC OS 破局思路",
    title: "OPC OS 的核心思路（统一中枢）",
    body: "把「长期主线准入 + 跨 CLI 指令追踪 + 三级自治审批网关 + 六大职能部门」装进同一个本地系统：人只定方向、下关键指令、拍板红线，其余交给 Bot 与 CLI 推进。",
    tags: ["长期主线准入", "跨 CLI 指令台账", "三级自治审批", "六大职能部门"],
    tone: "bridge",
  },
  {
    code: "03",
    badge: "一人公司运转终态",
    title: "跑通后的闭环（知识 → 现金流）",
    body: "情报与想法能沉淀立项 → 多 CLI 与暗工厂干活全透明 → 审批集中在总裁信箱 → 上线后看真实营收与盈亏热力图，反馈自动回流驱动下一轮迭代。",
    tags: ["情报沉淀立项", "并行交付透明", "营收盈亏反哺"],
    tone: "outcome",
  },
];

const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  {
    id: "capture",
    num: "01",
    title: "灵感与情报捕获",
    roleTag: "输入源头",
    tone: "capture",
    principle: "让零散想法、外部动态和用户反馈不再沉底，全部进入可检索、可唤醒、可打分的信号池。",
    upstream: [
      "日常随手记录的灵感、复盘日记与 X / HN / GitHub / Reddit 外部动态",
      "无界知识画布里沉淀的研究卡片、架构草图与竞品切片",
      "上线后由 Stage 05 回流的用户反馈、Bug 报告与商业盈亏复盘",
    ],
    mechanics: [
      "信息代谢引擎自动汇总每日简报，提取核心要点并匹配沉睡记忆",
      "PM 评估器结合技术可行性与商业价值双维打分，过滤低价值噪音",
      "把原始信息结构化为带证据与 ROI 预估的「候选想法 / 机会卡」",
    ],
    downstream: [
      "高分信号与成型想法送入 Stage 02 进行「长期主线准入校验」",
      "暂不立项的线索沉淀回无界知识画布，等待后续关联唤醒",
    ],
    links: [
      { label: "从信息到想法", href: "#ideas", desc: "把零散线索整理为可执行产品想法", primary: true },
      { label: "无界知识画布", href: "#canvas", desc: "空间化沉淀知识卡片与关联脉络" },
      { label: "信息代谢 · 每日简报", href: "#metabolism", desc: "自动汇聚信号源、唤醒记忆与 PM 评估" },
    ],
  },
  {
    id: "strategy",
    num: "02",
    title: "战略准入与拆解",
    roleTag: "定方向",
    tone: "strategy",
    principle: "先防跑偏，再谈提速：只有对齐长期主线与创始人偏好的事项，才允许占用算力与时间。",
    upstream: [
      "Stage 01 筛选出的高分机会、产品想法与用户高优需求",
      "创始人设定的长期主线（Mainlines）、里程碑与非主线冻结纪律",
    ],
    mechanics: [
      "内核准入检查（Admission Check）拦截非主线与外围基建诱惑，守住战略聚焦",
      "创始人偏好记忆库结合历史拍板习惯打分，减少重复沟通成本",
      "将批准的目标拆解为 Initiative → Feature → Task 与先后依赖，排入人机看板",
    ],
    downstream: [
      "拆解后的任务下发至 Stage 03：人工交给多 CLI 对话执行，或自动派单给暗工厂",
      "按主线权重同步配额预算给算力资源调度部",
    ],
    links: [
      { label: "长期主线与习惯记忆", href: "#strategy-hub", desc: "管理主线冻结令、里程碑与审批偏好", primary: true },
      { label: "人机看板 · 番茄 · ROI", href: "#planning", desc: "拆解任务、追踪人机协作进度与投入产出" },
      { label: "主线与资产发布树", href: "#company-architecture?tab=mainlines", desc: "核对主线、产品与代码仓库契约" },
    ],
  },
  {
    id: "execution",
    num: "03",
    title: "多 CLI 指令现场 & 暗工厂",
    roleTag: "并行干活",
    tone: "execution",
    principle: "手工多 CLI 与后台暗工厂双轨透明：所有指令、改动文件、验证命令与进度在一张台账里可见。",
    upstream: [
      "Stage 02 拆解排期好的看板任务、验收命令（verify_command）与仓库上下文",
      "创始人在终端直接向 Codex / Claude / Antigravity / Grok / Cursor 发出的关键指令",
    ],
    mechanics: [
      "轨道 A（CLI 指令台账）：自动扫描本机多 CLI 会话，串联你发过的每条指令、改过的文件与当前卡点",
      "轨道 B（Agent 暗工厂）：在隔离 Git Worktree 中自动跑 Coding-Agent，强制过外部测试与熔断门禁",
      "Agent Home 群聊承担跨角色对齐与阻塞求助，避免信息散落在几十个黑框终端里",
    ],
    downstream: [
      "产出代码分支、PR 与外部测试证据，低风险项按策略流转，红线/发布项送入 Stage 04 审批",
      "实时上报 Token 消耗、成本与运行槽位状态给算力与运维部门",
    ],
    links: [
      { label: "CLI 指令台账", href: "#cli-ledger", desc: "跨 Codex / Claude / Agy / Grok / Cursor 全程追踪指令与进度", primary: true },
      { label: "Agent 暗工厂", href: "#dark-factory", desc: "Worktree 隔离自动编码、外部验证与 PR 交付" },
      { label: "Agent Home 群聊", href: "#home-room", desc: "人机协同讨论现场、任务委派与阻塞接力" },
    ],
  },
  {
    id: "governance",
    num: "04",
    title: "总裁审批 & 运维配额守护",
    roleTag: "稳控底盘",
    tone: "governance",
    principle: "把 90% 过程噪音拦在门外，人只在总裁信箱拍板关键红线；运维与配额在后台兜底护航。",
    upstream: [
      "Stage 03 提交的发布申请、高成本/高风险变更、实验复盘与阻塞求助",
      "各 AI 套餐实时配额余量、本机与远程服务探针、仓库安全巡检结果",
    ],
    mechanics: [
      "三级自治审批网关（人工协助 / 半自动协同 / 全自治）：预算内低风险可免审，6 类红线强制人工拍板",
      "自愈运维部常驻巡检进程、磁盘与孤儿任务槽位，异常自动拉起并转交崩溃 Bug 单",
      "算力与资源部按主线权重选模路由，临期闲置额度自动榨取，安全部门守住仓库与密钥边界",
    ],
    downstream: [
      "批准放行的版本进入 Stage 05 正式上线、商业分发与收款验收",
      "每次拍板偏好自动写回战略记忆库，持续优化 Stage 02 的评估准确度",
    ],
    links: [
      { label: "总裁信箱", href: "#mailbox", desc: "唯一拍板入口：集中处理红线审批与异常分叉", primary: true },
      { label: "自愈运维部门", href: "#operations-department", desc: "服务健康守护、自动拉起与版本验证" },
      { label: "算力与资源部门", href: "#resource-department", desc: "套餐额度监控、重置窗口与成本路由" },
      { label: "安全门禁部门", href: "#security-department", desc: "项目安全评审、整改闭环与红线防护" },
    ],
  },
  {
    id: "commercial",
    num: "05",
    title: "商业收银、分发与盈亏熔断",
    roleTag: "变现闭环",
    tone: "commercial",
    principle: "写代码不是终点，收款与正现金流才是：追踪每条产品线的真实收入、算力成本与止损红线。",
    upstream: [
      "Stage 04 审批放行并稳定运行的线上产品、扩展、桌面端或 SaaS 服务",
      "各项目自动归集的 AI 算力成本、订阅支出与部署记录",
    ],
    mechanics: [
      "统一收银与离线授权端口对接支付渠道，记录真实订单并隔离沙盒测试数据",
      "多渠道内容分发（公众号 / 掘金 / X / Reddit / Newsletter）配合漏斗归因获客",
      "6 个月商业盈亏热力图自动核算净盈亏，连续亏损触达阈值时触发止损熔断预警",
    ],
    downstream: [
      "↺ 真实用户反馈、付费转化与盈亏复盘自动回流至 Stage 01 & Stage 02，驱动下一轮聚焦或果断止损",
    ],
    links: [
      { label: "商业与治理部", href: "#commercial", desc: "资产地图、变现试点、收银授权与漏斗总览", primary: true },
      { label: "盈亏热力图 & 熔断", href: "#metabolism?tab=commercial", desc: "6 月营收成本热力图、支付订单与止损开关" },
      { label: "公司业务线", href: "#business-lines", desc: "按业务线追踪增长实验、复盘与收支凭据" },
    ],
  },
];

const AUTONOMY_META: Record<AutonomyMode, { label: string; tone: "assisted" | "semi" | "full" }> = {
  assisted: { label: "人工协助模式", tone: "assisted" },
  semi_auto: { label: "半自动协同", tone: "semi" },
  full_auto: { label: "全自治运行", tone: "full" },
};

const CLI_STATUS_META: Record<CliSessionStatus, { label: string; tone: "running" | "waiting" | "done" | "blocked" | "idle" }> = {
  running: { label: "执行中", tone: "running" },
  waiting_user: { label: "待你回复", tone: "waiting" },
  completed: { label: "已完成", tone: "done" },
  blocked: { label: "已阻塞", tone: "blocked" },
  idle: { label: "空闲", tone: "idle" },
};

function formatUsd(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const formatted = abs >= 1000
    ? `${(abs / 1000).toFixed(abs >= 10000 ? 1 : 2)}k`
    : Number.isInteger(abs)
      ? String(abs)
      : abs.toFixed(2);
  if (value < 0) return `-$${formatted}`;
  if (signed && value > 0) return `+$${formatted}`;
  return `$${formatted}`;
}

function formatNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN");
}

function formatRelTime(iso: string | null | undefined): string {
  if (!iso) return "时间未知";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "时间未知";
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return "刚刚";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function FlowArrowSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 28 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 12H23M17 6L23.5 12L17 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VerticalFlowArrowSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 22"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M10 2V18.5M5 13.5L10 19L15 13.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CliSessionPreviewCard({ session }: { session: CliSessionSummary }) {
  const statusInfo = CLI_STATUS_META[session.status] ?? { label: session.status, tone: "idle" as const };
  const pct = clampPct(session.progressPct);
  const instruction = session.firstInstruction?.trim() || session.title || "（无首条指令摘要）";

  return (
    <a
      className="osf-cli-item"
      href={`#cli-ledger?session=${encodeURIComponent(session.id)}`}
      aria-label={`查看 ${session.provider} 在 ${session.project} 的会话：${instruction}`}
    >
      <div className="osf-cli-item-top">
        <span className="osf-cli-provider" data-provider={session.providerId}>
          {session.provider}
        </span>
        <strong className="osf-cli-project" title={session.workspace ?? session.project}>
          {session.project}
          {session.branch ? <em>@{session.branch}</em> : null}
        </strong>
        <span className="osf-cli-status" data-tone={statusInfo.tone}>
          {statusInfo.label}
        </span>
      </div>
      <p className="osf-cli-instruction" title={instruction}>
        {instruction}
      </p>
      <div className="osf-cli-item-foot">
        <div className="osf-cli-progress" aria-label={`任务进度 ${pct}%`}>
          <div className="osf-cli-progress-track">
            <div className="osf-cli-progress-bar" data-tone={statusInfo.tone} style={{ width: `${pct}%` }} />
          </div>
          <span className="osf-cli-pct">{pct}%</span>
        </div>
        <span className="osf-cli-meta">
          {session.stats.instructionCount} 指令 · {formatRelTime(session.updatedAt)}
        </span>
      </div>
    </a>
  );
}

export function OpcStoryFlow({ mode = "full" }: { mode?: "compact" | "full" }) {
  const isCompact = mode === "compact";
  const uid = useId().replace(/:/g, "");
  const panelId = `osf-panel-${uid}`;
  const originId = `osf-origin-${uid}`;
  const bodyId = `osf-body-${uid}`;
  const loopMarkerId = `osf-loop-arrow-${uid}`;
  const tabId = (id: StageId) => `osf-tab-${uid}-${id}`;

  const [selectedStage, setSelectedStage] = useState<StageId>(() => (isCompact ? "execution" : "capture"));
  const [collapsed, setCollapsed] = useState(false);
  const [showOriginInCompact, setShowOriginInCompact] = useState(false);

  const [data, setData] = useState<StoryLiveData>({
    arch: null,
    cliLedger: null,
    kanban: null,
    factory: null,
    heatmap: null,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failedEndpoints, setFailedEndpoints] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const tabButtonRefs = useRef<Record<StageId, HTMLButtonElement | null>>({
    capture: null,
    strategy: null,
    execution: null,
    governance: null,
    commercial: null,
  });

  const fetchLive = useCallback(async (manual = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (manual) setRefreshing(true);

    const { signal } = controller;
    const results = await Promise.allSettled([
      request<CompanyArchitectureSnapshot>("/api/opc/kernel/architecture", { signal }),
      request<CliLedgerOverview>("/api/opc/cli-ledger?days=7&limit=10", { signal }),
      request<KanbanBoardResponse>("/api/opc/planning/kanban", { signal }),
      request<DarkFactoryOverview>("/api/opc/factory/overview", { signal }),
      request<CommercialHeatmap>("/api/opc/metabolism/commercial-heatmap?months=6", { signal }),
    ]);

    if (signal.aborted) return;

    const [archRes, cliRes, kanbanRes, factoryRes, heatmapRes] = results;
    const failures = results.filter((item) => item.status === "rejected").length;

    setData((prev) => ({
      arch: archRes.status === "fulfilled" ? archRes.value : prev.arch,
      cliLedger: cliRes.status === "fulfilled" ? cliRes.value : prev.cliLedger,
      kanban: kanbanRes.status === "fulfilled" ? kanbanRes.value : prev.kanban,
      factory: factoryRes.status === "fulfilled" ? factoryRes.value : prev.factory,
      heatmap: heatmapRes.status === "fulfilled" ? heatmapRes.value : prev.heatmap,
    }));
    setFailedEndpoints(failures);
    setRefreshedAt(new Date().toISOString());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void fetchLive(false);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchLive]);

  // Keep autonomy mode live-synced when toggled from sidebar or CompanyHub
  useEffect(() => {
    const onPolicyUpdated = (event: Event) => {
      const detail = (event as CustomEvent<GovernancePolicy>).detail;
      if (!detail) return;
      setData((prev) => (prev.arch ? { ...prev, arch: { ...prev.arch, policy: detail } } : prev));
    };
    window.addEventListener("opc:policy-updated", onPolicyUpdated);
    return () => window.removeEventListener("opc:policy-updated", onPolicyUpdated);
  }, []);

  const derived = useMemo(() => {
    const { arch, cliLedger, kanban, factory, heatmap } = data;
    const activeMainlines = arch?.counts.activeMainlines ?? null;
    const totalProducts = arch?.counts.products ?? null;
    const totalAssets = arch?.counts.assets ?? null;
    const pendingDecisions = arch?.counts.pendingDecisions ?? null;
    const autoApproved = arch?.counts.autoApprovedDecisions ?? null;
    const domainEvents = arch?.counts.domainEvents ?? null;

    const departments = arch?.departments ?? [];
    const totalDepts = departments.length || COMPANY_DEPARTMENTS.length;
    const healthyDepts = departments.length
      ? departments.filter((dept) => dept.health?.healthy).length
      : null;

    const autonomyMode: AutonomyMode | null = arch?.policy?.autonomyMode ?? null;

    const cliSessions = cliLedger?.totals.sessions ?? null;
    const cliInstructions = cliLedger?.totals.instructions ?? null;
    const cliRunning = cliLedger?.totals.running ?? 0;
    const cliWaiting = cliLedger?.totals.waitingUser ?? 0;
    const cliCompleted = cliLedger?.totals.completed ?? null;
    const cliActiveTotal = cliLedger ? cliRunning + cliWaiting : null;
    const activeProviders = cliLedger
      ? cliLedger.byProvider.filter((provider) => provider.sessions > 0)
      : [];
    const topCliSessions = cliLedger?.sessions.slice(0, 3) ?? [];

    const kanbanTotal = kanban?.counts.total ?? null;
    const kanbanInProgress = kanban?.counts.in_progress ?? null;
    const kanbanReview = kanban?.counts.review ?? null;
    const kanbanDone = kanban?.counts.done ?? null;

    const factoryAgents = factory?.agents.length ?? null;
    const factoryActive = factory?.activeCount ?? 0;
    const factoryQueued = factory?.queuedCount ?? 0;
    const factoryRuns30d = factory?.metrics?.totalRuns ?? null;

    const revenue6m = heatmap?.summary.totalRevenueUsd ?? null;
    const cost6m = heatmap?.summary.totalCostUsd ?? null;
    const netProfit6m = heatmap?.summary.totalNetProfitUsd ?? null;
    const killAlerts = (heatmap?.summary.alertCount ?? 0) + (heatmap?.summary.stoppedCount ?? 0);
    const alertProjects = heatmap
      ? heatmap.projects.filter((row) => row.killSwitchAlert || row.killSwitch?.status === "stopped")
      : [];
    const hasHeatmap = heatmap !== null;

    const isExecutionActive =
      (cliLedger !== null && (cliRunning > 0 || cliWaiting > 0)) ||
      (factory !== null && (factoryActive > 0 || factoryQueued > 0));

    const needsGovernanceAttention =
      (pendingDecisions !== null && pendingDecisions > 0) ||
      (healthyDepts !== null && healthyDepts < totalDepts);

    return {
      activeMainlines,
      totalProducts,
      totalAssets,
      pendingDecisions,
      autoApproved,
      domainEvents,
      departments,
      totalDepts,
      healthyDepts,
      autonomyMode,
      cliSessions,
      cliInstructions,
      cliRunning,
      cliWaiting,
      cliCompleted,
      cliActiveTotal,
      activeProviders,
      topCliSessions,
      kanbanTotal,
      kanbanInProgress,
      kanbanReview,
      kanbanDone,
      factoryAgents,
      factoryActive,
      factoryQueued,
      factoryRuns30d,
      revenue6m,
      cost6m,
      netProfit6m,
      killAlerts,
      alertProjects,
      hasHeatmap,
      isExecutionActive,
      needsGovernanceAttention,
    };
  }, [data]);

  const stageMetrics = useMemo(() => {
    const autonomyLabel = derived.autonomyMode ? AUTONOMY_META[derived.autonomyMode].label : "待同步";

    return {
      capture: {
        primary: "知识画布 · 每日简报",
        secondary:
          derived.domainEvents !== null
            ? `信息与想法 · 事件流 ${formatNum(derived.domainEvents)} 条`
            : "信息与想法 · 多源信号输入",
        kpiChips: [
          { label: "输入通道", value: "画布 / 简报 / 想法" },
          { label: "已托管产品/资产", value: `${formatNum(derived.totalProducts)} / ${formatNum(derived.totalAssets)}` },
          { label: "领域事件流", value: `${formatNum(derived.domainEvents)} 条` },
        ],
        pulsing: false,
        alert: false,
      },
      strategy: {
        primary: `活跃主线 ${formatNum(derived.activeMainlines)} 条 · 看板 ${formatNum(derived.kanbanTotal)} 项`,
        secondary:
          derived.kanbanInProgress !== null
            ? `进行中 ${derived.kanbanInProgress} · 评审 ${derived.kanbanReview ?? 0} · 完成 ${derived.kanbanDone ?? 0}`
            : "主线准入 · 偏好打分 · 拆解排期",
        kpiChips: [
          { label: "活跃主线", value: `${formatNum(derived.activeMainlines)} 条` },
          { label: "看板总任务", value: `${formatNum(derived.kanbanTotal)} 项` },
          { label: "进行中 / 评审", value: `${formatNum(derived.kanbanInProgress)} / ${formatNum(derived.kanbanReview)}` },
          { label: "已完成", value: `${formatNum(derived.kanbanDone)} 项` },
        ],
        pulsing: false,
        alert: false,
      },
      execution: {
        primary: `近7天 ${formatNum(derived.cliSessions)} 会话 · ${formatNum(derived.cliInstructions)} 指令`,
        secondary:
          derived.cliActiveTotal !== null
            ? `${derived.cliActiveTotal} 执行/待回复 · 暗工厂 ${formatNum(derived.factoryAgents)} 代理`
            : `暗工厂 ${formatNum(derived.factoryAgents)} 代理 · 30天 ${formatNum(derived.factoryRuns30d)} 次运行`,
        kpiChips: [
          { label: "7天 CLI 会话", value: `${formatNum(derived.cliSessions)} 个` },
          { label: "下发指令总计", value: `${formatNum(derived.cliInstructions)} 条` },
          { label: "执行中 / 待回复", value: `${derived.cliRunning} / ${derived.cliWaiting}` },
          { label: "暗工厂代理 / 30天跑次", value: `${formatNum(derived.factoryAgents)} / ${formatNum(derived.factoryRuns30d)}` },
        ],
        pulsing: derived.isExecutionActive,
        alert: false,
      },
      governance: {
        primary: `待拍板 ${formatNum(derived.pendingDecisions)} 项 · 免审 ${formatNum(derived.autoApproved)} 项`,
        secondary:
          derived.healthyDepts !== null
            ? `部门健康 ${derived.healthyDepts}/${derived.totalDepts} · ${autonomyLabel}`
            : `审批网关 · 运维自愈 · 配额路由`,
        kpiChips: [
          { label: "当前自治模式", value: autonomyLabel },
          { label: "待你拍板", value: `${formatNum(derived.pendingDecisions)} 项` },
          { label: "低风险自动免审", value: `${formatNum(derived.autoApproved)} 项` },
          {
            label: "六部健康状态",
            value: derived.healthyDepts !== null ? `${derived.healthyDepts} / ${derived.totalDepts} 正常` : "—",
          },
        ],
        pulsing: false,
        alert: derived.needsGovernanceAttention,
      },
      commercial: {
        primary: `6月营收 ${formatUsd(derived.revenue6m)} · 净盈亏 ${formatUsd(derived.netProfit6m, true)}`,
        secondary: derived.hasHeatmap
          ? derived.killAlerts > 0
            ? `成本 ${formatUsd(derived.cost6m)} · ⚠ 熔断预警 ${derived.killAlerts} 项`
            : `成本 ${formatUsd(derived.cost6m)} · 盈亏熔断正常`
          : "收银总账 · 多渠分发 · 止损熔断",
        kpiChips: [
          { label: "6个月总营收", value: formatUsd(derived.revenue6m) },
          { label: "6个月总成本", value: formatUsd(derived.cost6m) },
          { label: "6个月净盈亏", value: formatUsd(derived.netProfit6m, true) },
          {
            label: "熔断预警",
            value: derived.hasHeatmap ? (derived.killAlerts > 0 ? `${derived.killAlerts} 项触发` : "0 项（正常）") : "—",
          },
        ],
        pulsing: false,
        alert: derived.killAlerts > 0,
      },
    };
  }, [derived]);

  const activeIndex = STAGE_DEFINITIONS.findIndex((item) => item.id === selectedStage);
  const currentStage = STAGE_DEFINITIONS[activeIndex] ?? STAGE_DEFINITIONS[0];
  const currentMetrics = stageMetrics[currentStage.id];

  const handleStageKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % STAGE_DEFINITIONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + STAGE_DEFINITIONS.length) % STAGE_DEFINITIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = STAGE_DEFINITIONS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextStage = STAGE_DEFINITIONS[nextIndex];
    setSelectedStage(nextStage.id);
    tabButtonRefs.current[nextStage.id]?.focus();
  };

  const stepStage = (delta: -1 | 1) => {
    const nextIdx = (activeIndex + delta + STAGE_DEFINITIONS.length) % STAGE_DEFINITIONS.length;
    setSelectedStage(STAGE_DEFINITIONS[nextIdx].id);
  };

  const showOriginLayer = !isCompact || showOriginInCompact;

  const architectureDepartments = derived.departments.length
    ? derived.departments.map((dept) => ({
        id: dept.id,
        code: dept.code,
        shortName: dept.shortName,
        name: dept.name,
        primaryRoute: dept.primaryRoute,
        healthy: dept.health?.healthy ?? true,
        summary: dept.health?.summary ?? dept.mission,
      }))
    : COMPANY_DEPARTMENTS.map((dept) => ({
        id: dept.id,
        code: dept.code,
        shortName: dept.shortName,
        name: dept.name,
        primaryRoute: dept.primaryRoute,
        healthy: null as boolean | null,
        summary: dept.mission,
      }));

  return (
    <section
      className={`osf-wrap ${isCompact ? "osf-compact" : "osf-full"}`}
      aria-label="OPC OS 来龙去脉与运作思路可视化图谱"
    >
      {/* Top Editorial Header */}
      <header className="osf-header">
        <div className="osf-header-main">
          <div className="osf-kicker-row">
            <span className="osf-kicker">OPC OS · 运转全景图谱</span>
            {derived.autonomyMode && (
              <span className="osf-mode-pill" data-tone={AUTONOMY_META[derived.autonomyMode].tone}>
                {AUTONOMY_META[derived.autonomyMode].label}
              </span>
            )}
            {derived.isExecutionActive && (
              <span className="osf-live-pill">
                <span className="osf-pulse-dot" aria-hidden="true" />
                实时推进中
              </span>
            )}
          </div>
          <h2 className="osf-title">
            {isCompact
              ? "OPC OS 运转全景图 · 从想法到收款的 5 步闭环"
              : "OPC OS 来龙去脉、运作思路与四层协作图谱"}
          </h2>
          <p className="osf-subtitle">
            {isCompact
              ? "一图看懂每个模块为什么存在、数据如何从想法流向收款，点击任意环节即可透视上下游并直达工作台。"
              : "把分散的灵感、多 CLI 终端、后台暗工厂、总裁审批与商业盈亏串成一条可追踪、可止损的一人公司操作系统。"}
          </p>
        </div>

        <div className="osf-header-actions">
          {isCompact && (
            <>
              <button
                type="button"
                className={`osf-btn osf-btn-ghost ${showOriginInCompact ? "is-active" : ""}`}
                aria-expanded={showOriginInCompact}
                aria-controls={originId}
                onClick={() => {
                  if (collapsed) setCollapsed(false);
                  setShowOriginInCompact((prev) => !prev);
                }}
              >
                {showOriginInCompact ? "收起来龙去脉" : "查看来龙去脉"}
              </button>
              <button
                type="button"
                className="osf-btn osf-btn-ghost"
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                onClick={() => setCollapsed((prev) => !prev)}
              >
                {collapsed ? "展开闭环图" : "收起全景"}
              </button>
              <a className="osf-link-cta" href="#company-architecture?tab=story">
                展开完整来龙去脉 ↗
              </a>
            </>
          )}

          {!isCompact && (
            <button
              type="button"
              className="osf-btn osf-btn-ghost"
              disabled={refreshing}
              onClick={() => void fetchLive(true)}
              aria-label="刷新实时运转指标"
            >
              {refreshing ? "同步中…" : "刷新实时数据 ↻"}
            </button>
          )}
        </div>
      </header>

      {/* Live Telemetry Summary Strip (Full mode, or when compact is collapsed) */}
      {(!isCompact || collapsed) && (
        <div className="osf-telemetry-strip" aria-label="实时运转概览" aria-live="polite">
          <a className="osf-metric-tile" href="#strategy-hub">
            <span>活跃主线 / 看板任务</span>
            <strong>
              {formatNum(derived.activeMainlines)}
              <small> / {formatNum(derived.kanbanTotal)}</small>
            </strong>
          </a>
          <a className="osf-metric-tile" href="#cli-ledger">
            <span>7天 CLI 会话 / 指令</span>
            <strong>
              {formatNum(derived.cliSessions)}
              <small> / {formatNum(derived.cliInstructions)}</small>
            </strong>
          </a>
          <a className="osf-metric-tile" href="#dark-factory">
            <span>暗工厂代理 / 30天运行</span>
            <strong>
              {formatNum(derived.factoryAgents)}
              <small> / {formatNum(derived.factoryRuns30d)}</small>
            </strong>
          </a>
          <a className="osf-metric-tile" href="#mailbox">
            <span>待拍板 / 自动免审</span>
            <strong data-warn={derived.pendingDecisions !== null && derived.pendingDecisions > 0}>
              {formatNum(derived.pendingDecisions)}
              <small> / {formatNum(derived.autoApproved)}</small>
            </strong>
          </a>
          <a className="osf-metric-tile" href="#metabolism?tab=commercial">
            <span>6月营收 / 净盈亏</span>
            <strong data-warn={derived.netProfit6m !== null && derived.netProfit6m < 0}>
              {formatUsd(derived.revenue6m)}
              <small> ({formatUsd(derived.netProfit6m, true)})</small>
            </strong>
          </a>
        </div>
      )}

      {!collapsed && (
        <div id={bodyId} className="osf-body">
          {/* LAYER 1: Origin & Philosophy */}
          {showOriginLayer && (
            <section
              id={originId}
              className="osf-layer osf-origin"
              aria-label="来龙去脉：为什么需要 OPC OS"
            >
              <div className="osf-layer-head">
                <span className="osf-layer-num">LAYER 01</span>
                <h3>来龙去脉 · 为什么会有 OPC OS</h3>
                <span className="osf-layer-note">从多端碎片失忆 → 统一本地中枢 → 知识到现金流闭环</span>
              </div>

              <div className="osf-origin-grid">
                {ORIGIN_PILLARS.map((pillar, idx) => (
                  <div className="osf-origin-slot" key={pillar.code}>
                    <article className="osf-origin-card" data-tone={pillar.tone}>
                      <div className="osf-origin-card-top">
                        <span className="osf-origin-code">{pillar.code}</span>
                        <span className="osf-origin-badge">{pillar.badge}</span>
                      </div>
                      <h4>{pillar.title}</h4>
                      <p>{pillar.body}</p>
                      <div className="osf-origin-tags">
                        {pillar.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    </article>
                    {idx < ORIGIN_PILLARS.length - 1 && (
                      <div className="osf-origin-arrow" aria-hidden="true">
                        <FlowArrowSvg className="osf-arrow-h" />
                        <VerticalFlowArrowSvg className="osf-arrow-v" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* LAYER 2: Interactive 5-Step Business Flow Graph */}
          <section className="osf-layer osf-flow-layer" aria-label="五步端到端业务闭环图">
            <div className="osf-layer-head">
              <span className="osf-layer-num">{isCompact ? "5-STEP LOOP" : "LAYER 02"}</span>
              <h3>五步端到端运转闭环 · 点击环节透视上下游思路</h3>
              <span className="osf-layer-note">
                {loading
                  ? "正在同步实时指标…"
                  : failedEndpoints > 0
                    ? `部分实时源离线 (${5 - failedEndpoints}/5 已就绪)`
                    : refreshedAt
                      ? `实时指标已同步 · ${formatRelTime(refreshedAt)}`
                      : "实时数据驱动"}
              </span>
            </div>

            {/* 5-node horizontal pipeline with SVG directional connectors */}
            <div className="osf-flow-stage" role="tablist" aria-label="OPC OS 五步运转闭环节点">
              {STAGE_DEFINITIONS.map((stage, idx) => {
                const metrics = stageMetrics[stage.id];
                const isSelected = stage.id === selectedStage;
                return (
                  <div className="osf-flow-slot" key={stage.id}>
                    <button
                      ref={(el) => {
                        tabButtonRefs.current[stage.id] = el;
                      }}
                      type="button"
                      role="tab"
                      id={tabId(stage.id)}
                      aria-selected={isSelected}
                      aria-controls={panelId}
                      tabIndex={isSelected ? 0 : -1}
                      className={`osf-node ${isSelected ? "is-selected" : ""} ${metrics.pulsing ? "is-pulsing" : ""}`}
                      data-tone={stage.tone}
                      data-alert={metrics.alert}
                      onClick={() => setSelectedStage(stage.id)}
                      onKeyDown={(e) => handleStageKeyDown(e, idx)}
                    >
                      <div className="osf-node-top">
                        <span className="osf-node-num">STAGE {stage.num}</span>
                        <span className="osf-node-role">
                          {metrics.pulsing && <span className="osf-pulse-dot" aria-hidden="true" />}
                          {stage.roleTag}
                        </span>
                      </div>
                      <strong className="osf-node-title">{stage.title}</strong>
                      <div className="osf-node-metrics">
                        <span className="osf-node-primary">{metrics.primary}</span>
                        <span className="osf-node-secondary">{metrics.secondary}</span>
                      </div>
                      <span className="osf-node-cue" aria-hidden="true">
                        {isSelected ? "正在透视 ↓" : "点击查看思路 →"}
                      </span>
                    </button>

                    {idx < STAGE_DEFINITIONS.length - 1 && (
                      <div className="osf-flow-connector" aria-hidden="true">
                        <FlowArrowSvg className="osf-arrow-h" />
                        <VerticalFlowArrowSvg className="osf-arrow-v" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bottom SVG Feedback Return Loop from Stage 05 back to Stage 01 */}
            <div className="osf-return-loop" aria-label="商业复盘与用户反馈回流路径：从第 5 步反哺回第 1 步">
              <svg
                className="osf-return-svg"
                viewBox="0 0 1000 54"
                preserveAspectRatio="none"
                fill="none"
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <marker
                    id={loopMarkerId}
                    viewBox="0 0 10 10"
                    refX="6"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M1 1.5L8.5 5L1 8.5" stroke="#2f513e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </marker>
                </defs>
                {/* Sweeping return curve from right (Stage 05) back to left (Stage 01) */}
                <path
                  d="M 905 4 L 905 24 C 905 38, 889 42, 871 42 L 129 42 C 111 42, 95 38, 95 24 L 95 8"
                  stroke="#2f513e"
                  strokeWidth="1.8"
                  strokeDasharray="6 5"
                  vectorEffect="non-scaling-stroke"
                  markerEnd={`url(#${loopMarkerId})`}
                />
                <circle cx="905" cy="5" r="3.5" fill="#8d3b24" />
              </svg>

              <button
                type="button"
                className="osf-return-pill"
                onClick={() => setSelectedStage("capture")}
                title="点击回到第 1 步，查看反馈与复盘如何反哺下一轮立项"
              >
                <span aria-hidden="true">↺</span>
                <span>用户反馈 &amp; 商业盈亏复盘反哺下一轮（⑤ → ①）</span>
              </button>
            </div>

            {/* Selected Stage Inspector Panel */}
            <div
              id={panelId}
              role="tabpanel"
              aria-labelledby={tabId(currentStage.id)}
              className="osf-inspector"
              data-tone={currentStage.tone}
            >
              <div className="osf-inspector-head">
                <div className="osf-inspector-title-group">
                  <span className="osf-inspector-eyebrow">
                    当前环节思路透视 · STAGE {currentStage.num} / 05 · {currentStage.roleTag}
                  </span>
                  <h4>{currentStage.title}</h4>
                  <p className="osf-inspector-principle">{currentStage.principle}</p>
                </div>

                <div className="osf-inspector-nav">
                  <button
                    type="button"
                    className="osf-btn osf-btn-step"
                    onClick={() => stepStage(-1)}
                    aria-label="查看上一步环节"
                  >
                    ← 上一步
                  </button>
                  <button
                    type="button"
                    className="osf-btn osf-btn-step"
                    onClick={() => stepStage(1)}
                    aria-label="查看下一步环节"
                  >
                    下一步 →
                  </button>
                </div>
              </div>

              {/* Stage-specific live KPI chips */}
              <div className="osf-inspector-kpis">
                {currentMetrics.kpiChips.map((chip) => (
                  <div className="osf-kpi-chip" key={chip.label}>
                    <span>{chip.label}</span>
                    <strong>{chip.value}</strong>
                  </div>
                ))}
              </div>

              {/* 3-column upstream / mechanics / downstream breakdown */}
              <div className="osf-inspector-grid">
                <div className="osf-inspector-col">
                  <h5>← 上游输入（从哪来）</h5>
                  <ul>
                    {currentStage.upstream.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div className="osf-inspector-col osf-inspector-col-core">
                  <h5>⚙ 本环节怎么运转（核心思路）</h5>
                  <ul>
                    {currentStage.mechanics.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div className="osf-inspector-col">
                  <h5>→ 下游流向（去哪儿）</h5>
                  <ul>
                    {currentStage.downstream.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Stage 03 Special Preview: Top 3 Recent CLI Sessions */}
              {currentStage.id === "execution" && (
                <div className="osf-cli-preview" aria-label="近期跨 CLI 指令会话预览">
                  <div className="osf-cli-preview-head">
                    <div>
                      <h5>最近活跃的跨 CLI 指令现场（Top 3）</h5>
                      {derived.activeProviders.length > 0 ? (
                        <div className="osf-provider-strip">
                          {derived.activeProviders.map((prov) => (
                            <span key={prov.providerId} className="osf-provider-chip">
                              {prov.provider} · {prov.sessions} 会话
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="osf-cli-empty-hint">
                          聚合扫描本机 Codex / Claude Code / Antigravity / Grok / Cursor 会话记录
                        </p>
                      )}
                    </div>
                    <a className="osf-link-cta" href="#cli-ledger">
                      打开完整 CLI 指令台账 ↗
                    </a>
                  </div>

                  {derived.topCliSessions.length > 0 ? (
                    <div className="osf-cli-list">
                      {derived.topCliSessions.map((session) => (
                        <CliSessionPreviewCard key={session.id} session={session} />
                      ))}
                    </div>
                  ) : (
                    <div className="osf-cli-empty">
                      近 7 天暂未扫描到活跃 CLI 会话记录；打开「CLI 指令台账」可查看全量历史、扫描源状态与进度详情。
                    </div>
                  )}
                </div>
              )}

              {/* Stage 04 Special Preview: Live 6-Department Health Strip */}
              {currentStage.id === "governance" && (
                <div className="osf-dept-strip" aria-label="六大职能部门实时健康度">
                  <div className="osf-dept-strip-head">
                    <h5>六大职能底座健康巡检</h5>
                    <a className="osf-inline-link" href="#company-architecture">
                      查看六部完整契约 ↗
                    </a>
                  </div>
                  <div className="osf-dept-pills">
                    {architectureDepartments.map((dept) => (
                      <a
                        key={dept.id}
                        className="osf-dept-pill"
                        href={`#${dept.primaryRoute}`}
                        title={dept.summary}
                      >
                        <span
                          className="osf-health-dot"
                          data-state={dept.healthy === null ? "unknown" : dept.healthy ? "ok" : "warn"}
                          aria-hidden="true"
                        />
                        <span className="osf-dept-code">{dept.code}</span>
                        <span>{dept.shortName}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Stage 05 Special Preview: Kill-Switch Alert Banner (when alerts exist) */}
              {currentStage.id === "commercial" && derived.alertProjects.length > 0 && (
                <div className="osf-alert-strip" role="status" aria-label="盈亏止损熔断预警">
                  <div className="osf-alert-strip-head">
                    <strong>⚠ 止损熔断预警（{derived.alertProjects.length} 个项目）</strong>
                    <a className="osf-inline-link" href="#metabolism?tab=commercial">
                      前往热力图处理 ↗
                    </a>
                  </div>
                  <div className="osf-alert-pills">
                    {derived.alertProjects.slice(0, 4).map((row) => (
                      <span key={row.project} className="osf-alert-pill">
                        {row.project} · 连续亏损 {row.consecutiveLossMonths} 月 · 累计 {formatUsd(row.totalNetProfitUsd, true)}
                        {row.killSwitch?.status === "stopped" ? "（已熔断）" : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Direct Workspace Action Links */}
              <div className="osf-inspector-links" aria-label="本环节关联工作台入口">
                <span className="osf-links-label">直接进入该工作台：</span>
                <div className="osf-links-grid">
                  {currentStage.links.map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      className={`osf-action-card ${link.primary ? "is-primary" : ""}`}
                    >
                      <span className="osf-action-title">
                        {link.label}
                        <span aria-hidden="true"> ↗</span>
                      </span>
                      <span className="osf-action-desc">{link.desc}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* LAYER 3: Human x Bot x CLI x Microkernel 4-Layer Architecture (Full mode only) */}
          {!isCompact && (
            <section
              className="osf-layer osf-arch-layer"
              aria-label="人、Bot、CLI 与微内核四层协作架构图"
            >
              <div className="osf-layer-head">
                <span className="osf-layer-num">LAYER 03</span>
                <h3>人 × Bot × CLI × 微内核 · 四层角色分工图</h3>
                <span className="osf-layer-note">彻底分清「谁拍板、谁协调、谁写代码、谁托底」</span>
              </div>

              <div className="osf-stack">
                {/* L1: Founder CEO */}
                <article className="osf-tier osf-tier-l1">
                  <div className="osf-tier-rail">
                    <span className="osf-tier-code">L1</span>
                    <span className="osf-tier-role">战略与终审</span>
                  </div>
                  <div className="osf-tier-body">
                    <div className="osf-tier-top">
                      <h4>创始人 CEO（你）</h4>
                      <div className="osf-tier-badges">
                        {derived.autonomyMode && (
                          <span className="osf-tier-badge">
                            {AUTONOMY_META[derived.autonomyMode].label}
                          </span>
                        )}
                        <span className="osf-tier-badge" data-accent="true">
                          待拍板 {formatNum(derived.pendingDecisions)} 项
                        </span>
                      </div>
                    </div>
                    <p>
                      只做 3 件事：<strong>定长期主线（防跑偏）</strong>、在 CLI / 群聊<strong>下达关键指令</strong>、在总裁信箱<strong>拍板红线审批</strong>。不被过程琐事淹没。
                    </p>
                    <div className="osf-tier-links">
                      <a href="#strategy-hub">长期主线准入 ↗</a>
                      <a href="#mailbox">总裁信箱拍板 ↗</a>
                      <a href="#cli-ledger">追踪我的 CLI 指令 ↗</a>
                    </div>
                  </div>
                </article>

                <div className="osf-tier-bridge" aria-hidden="true">
                  <span>↓ 下达主线纪律、预算边界与关键指令</span>
                  <span>↑ 仅呈报需拍板红线、里程碑与商业结果</span>
                </div>

                {/* L2: Executive Office & Bots */}
                <article className="osf-tier osf-tier-l2">
                  <div className="osf-tier-rail">
                    <span className="osf-tier-code">L2</span>
                    <span className="osf-tier-role">统筹与降噪</span>
                  </div>
                  <div className="osf-tier-body">
                    <div className="osf-tier-top">
                      <h4>总裁办与协调层（Agent Home Super Bot + 五部 VP）</h4>
                      <div className="osf-tier-badges">
                        <span className="osf-tier-badge">
                          低风险自动免审 {formatNum(derived.autoApproved)} 项
                        </span>
                        <span className="osf-tier-badge">
                          事件流转 {formatNum(derived.domainEvents)} 条
                        </span>
                      </div>
                    </div>
                    <p>
                      日常巡检、汇总各线汇报、挡住 <strong>90% 过程噪音</strong>，把跨项目进度、异常与实验复盘压缩为带推荐选项的决策包，送进总裁信箱。
                    </p>
                    <div className="osf-tier-links">
                      <a href="#executive">总裁办 · Bot 架构 ↗</a>
                      <a href="#home-room">Agent Home 群聊 ↗</a>
                      <a href="#digital-twin">组织数字孪生 ↗</a>
                    </div>
                  </div>
                </article>

                <div className="osf-tier-bridge" aria-hidden="true">
                  <span>↓ 拆解任务、分配配额与验收标准</span>
                  <span>↑ 回传指令进展、PR 产物、测试证据与阻塞</span>
                </div>

                {/* L3: Multi-CLI & Dark Factory Execution */}
                <article className="osf-tier osf-tier-l3">
                  <div className="osf-tier-rail">
                    <span className="osf-tier-code">L3</span>
                    <span className="osf-tier-role">双轨干活</span>
                  </div>
                  <div className="osf-tier-body">
                    <div className="osf-tier-top">
                      <h4>多 CLI &amp; 暗工厂执行层（真正写代码与交付）</h4>
                      <div className="osf-tier-badges">
                        {derived.isExecutionActive && (
                          <span className="osf-tier-badge" data-live="true">
                            <span className="osf-pulse-dot" aria-hidden="true" />
                            当前有活跃执行
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="osf-dual-tracks">
                      <div className="osf-track-box">
                        <div className="osf-track-head">
                          <strong>轨道 A · 交互式多 CLI 会话</strong>
                          <span>
                            近7天 {formatNum(derived.cliSessions)} 会话 · {formatNum(derived.cliInstructions)} 指令
                          </span>
                        </div>
                        <p>
                          你手动开启的 Codex / Claude Code / Antigravity / Grok / Cursor 终端会话，由「CLI 指令台账」全程追踪发过什么指令、改了哪些文件、停在哪一步。
                        </p>
                        <a className="osf-inline-link" href="#cli-ledger">
                          进入 CLI 指令台账 ↗
                        </a>
                      </div>

                      <div className="osf-track-box">
                        <div className="osf-track-head">
                          <strong>轨道 B · Agent 暗工厂（后台自动执行）</strong>
                          <span>
                            {formatNum(derived.factoryAgents)} 代理 · 活跃 {derived.factoryActive} · 30天{" "}
                            {formatNum(derived.factoryRuns30d)} 次
                          </span>
                        </div>
                        <p>
                          后台按 Git Worktree 隔离自动运行 Coding-Agent，强制跑外部确定性验证命令（verify_command）、受费用与时长熔断器保护并自动发起 PR。
                        </p>
                        <a className="osf-inline-link" href="#dark-factory">
                          进入 Agent 暗工厂 ↗
                        </a>
                      </div>
                    </div>
                  </div>
                </article>

                <div className="osf-tier-bridge" aria-hidden="true">
                  <span>↓ 读取发布契约、配额路由与安全边界</span>
                  <span>↑ 写入领域事件、自愈日志与算力成本总账</span>
                </div>

                {/* L4: Microkernel & 6 Departments */}
                <article className="osf-tier osf-tier-l4">
                  <div className="osf-tier-rail">
                    <span className="osf-tier-code">L4</span>
                    <span className="osf-tier-role">系统底座</span>
                  </div>
                  <div className="osf-tier-body">
                    <div className="osf-tier-top">
                      <h4>微内核与六大职能底座（Microkernel &amp; 6 Departments）</h4>
                      <div className="osf-tier-badges">
                        <span className="osf-tier-badge">
                          内核 {data.arch?.kernelVersion ? `v${data.arch.kernelVersion}` : "OPC Kernel"}
                        </span>
                        <span className="osf-tier-badge">
                          托管 {formatNum(derived.totalProducts)} 产品 · {formatNum(derived.totalAssets)} 资产
                        </span>
                      </div>
                    </div>
                    <p>
                      统一资产发布契约、领域事件总线、配额调度、自愈运维、安全门禁与商业总账，让公司能力模块化扩展而不耦合。
                    </p>
                    <div className="osf-foundation-grid">
                      {architectureDepartments.map((dept) => (
                        <a
                          key={dept.id}
                          className="osf-foundation-tile"
                          href={`#${dept.primaryRoute}`}
                          title={dept.summary}
                        >
                          <div className="osf-foundation-top">
                            <span className="osf-dept-code">{dept.code}</span>
                            <span
                              className="osf-health-dot"
                              data-state={dept.healthy === null ? "unknown" : dept.healthy ? "ok" : "warn"}
                              aria-label={dept.healthy === false ? "需关注" : "正常"}
                            />
                          </div>
                          <strong>{dept.shortName}</strong>
                          <small>{dept.name}</small>
                        </a>
                      ))}
                    </div>
                  </div>
                </article>
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
