import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  BriefingIngestResult,
  BriefingJournalImportResult,
  CanvasSummary,
  CommercialHeatmap,
  DailyBriefing,
  DailyDigest,
  DeploymentRecord,
  DistributionChannel,
  DistributionRecord,
  DormantMemoryHit,
  FeedbackConvertResult,
  PaymentChannel,
  PaymentOrder,
  PmEvaluation,
  ProjectIslandResult,
  UserFeedback,
  WorkflowTriggerResult,
} from "../../src/metabolism-types";
import type { ProvidersConfig, ProvidersHealthReport } from "../../src/providers-types";
import { request } from "./api";
import "./metabolism-hub.css";

type HubTab = "briefings" | "pm" | "commercial" | "providers";

const BRIEFING_SOURCES = [
  { id: "manual", label: "手工录入" },
  { id: "x", label: "X / Twitter" },
  { id: "hackernews", label: "Hacker News" },
  { id: "github", label: "GitHub Trending" },
  { id: "reddit", label: "Reddit" },
  { id: "wechat", label: "微信公众号" },
  { id: "rss", label: "RSS 订阅" },
  { id: "journal", label: "复盘日记" },
];

const DISTRIBUTION_CHANNELS: Array<{ id: DistributionChannel; label: string }> = [
  { id: "wechat", label: "微信公众号" },
  { id: "juejin", label: "掘金社区" },
  { id: "x", label: "X / Twitter Thread" },
  { id: "reddit", label: "Reddit" },
  { id: "newsletter", label: "Newsletter" },
  { id: "telegram", label: "Telegram 频道" },
];

const FEEDBACK_CATEGORY_LABELS: Record<string, string> = {
  bug: "缺陷 Bug",
  feature: "新需求",
  ux: "体验 UX",
  billing: "支付/授权",
};

const SEVERITY_LABELS: Record<string, string> = {
  high: "高危",
  medium: "中等",
  low: "常规",
};

const DEPLOY_STATUS_LABELS: Record<string, string> = {
  configured: "已配置",
  deploying: "部署中",
  deployed: "已部署",
  rolled_back: "已回滚",
  failed: "失败",
};

function scoreTone(score: number): "ok" | "mid" | "warn" {
  if (score >= 80) return "ok";
  if (score >= 60) return "mid";
  return "warn";
}

function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function MetabolismHub({ nav, initialTab }: { nav?: ReactNode; initialTab?: HubTab }) {
  const [tab, setTab] = useState<HubTab>(initialTab ?? "briefings");
  const [highlightedBriefingId, setHighlightedBriefingId] = useState<string>("");
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Tab 1: Briefings
  const [briefings, setBriefings] = useState<DailyBriefing[]>([]);
  const [briefingScope, setBriefingScope] = useState<"today" | "all">("today");
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [selectedCanvasId, setSelectedCanvasId] = useState("");
  const [customCanvasId, setCustomCanvasId] = useState("default-canvas");
  const [ingestSource, setIngestSource] = useState("x");
  const [ingestTitle, setIngestTitle] = useState("");
  const [ingestContent, setIngestContent] = useState("");
  const [latestIngest, setLatestIngest] = useState<BriefingIngestResult | null>(null);
  const [digest, setDigest] = useState<DailyDigest | null>(null);
  const [memoryMap, setMemoryMap] = useState<Record<string, DormantMemoryHit[]>>({});

  // Tab 2: PM Agent & Feedback
  const [pmEvaluations, setPmEvaluations] = useState<PmEvaluation[]>([]);
  const [activePmEval, setActivePmEval] = useState<PmEvaluation | null>(null);
  const [pmProject, setPmProject] = useState("PageLens");
  const [pmSource, setPmSource] = useState("briefing");
  const [pmContent, setPmContent] = useState("");
  const [pmThreshold, setPmThreshold] = useState(85);
  const [pmAutoCreate, setPmAutoCreate] = useState(true);
  const [pmAddOpp, setPmAddOpp] = useState(false);

  const [feedbacks, setFeedbacks] = useState<UserFeedback[]>([]);
  const [fbProject, setFbProject] = useState("PageLens");
  const [fbChannel, setFbChannel] = useState("in_app");
  const [fbRawText, setFbRawText] = useState("");
  const [fbAutoConvert, setFbAutoConvert] = useState(false);

  // Tab 3: Commercial Heatmap, Payments, Distribution, Deployments
  const [heatmap, setHeatmap] = useState<CommercialHeatmap | null>(null);
  const [costProject, setCostProject] = useState("PageLens");
  const [costMonth, setCostMonth] = useState(currentMonthStr());
  const [costAmount, setCostAmount] = useState("25");
  const [costCategory, setCostCategory] = useState("infra");
  const [costNote, setCostNote] = useState("");
  const [killConfirmProject, setKillConfirmProject] = useState<string | null>(null);
  const [killReason, setKillReason] = useState("");

  const [payments, setPayments] = useState<PaymentOrder[]>([]);
  const [payProject, setPayProject] = useState("PageLens");
  const [paySubject, setPaySubject] = useState("PageLens Pro 买断授权");
  const [payChannel, setPayChannel] = useState<PaymentChannel>("hupijiao");
  const [payAmount, setPayAmount] = useState("199");
  const [payCurrency, setPayCurrency] = useState("CNY");

  const [distributions, setDistributions] = useState<DistributionRecord[]>([]);
  const [distTitle, setDistTitle] = useState("");
  const [distSourceRef, setDistSourceRef] = useState("");
  const [distContent, setDistContent] = useState("");
  const [distChannels, setDistChannels] = useState<DistributionChannel[]>(["wechat", "juejin", "x"]);
  const [expandedDistId, setExpandedDistId] = useState<string | null>(null);

  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [depProject, setDepProject] = useState("PageLens");
  const [depHost, setDepHost] = useState("prod-edge-01.tailnet");
  const [depImage, setDepImage] = useState("ghcr.io/magele758/pagelens:v1.0.0");
  const [depCmd, setDepCmd] = useState("docker compose pull && docker compose up -d");
  const [depVersion, setDepVersion] = useState("v1.0.0");
  const [depEnvText, setDepEnvText] = useState("NODE_ENV=production\nPORT=4317");
  const [expandedDepId, setExpandedDepId] = useState<string | null>(null);

  // Tab 4: Providers
  const [providersCfg, setProvidersCfg] = useState<ProvidersConfig | null>(null);
  const [protectedPathsText, setProtectedPathsText] = useState("");
  const [providerChannelsText, setProviderChannelsText] = useState("");
  const [healthReport, setHealthReport] = useState<ProvidersHealthReport | null>(null);

  const loadBriefings = useCallback(async (scope: "today" | "all" = briefingScope) => {
    const path = scope === "today" ? "/api/opc/metabolism/briefings/today" : "/api/opc/metabolism/briefings?limit=60";
    const res = await request<{ items: DailyBriefing[]; canvases?: CanvasSummary[] }>(path);
    setBriefings(res.items);
    if (res.canvases) {
      setCanvases(res.canvases);
      setSelectedCanvasId((prev) => prev || res.canvases?.[0]?.id || "");
    }
  }, [briefingScope]);

  const loadPmAndFeedback = useCallback(async () => {
    const [pmRes, fbRes] = await Promise.all([
      request<{ items: PmEvaluation[] }>("/api/opc/metabolism/pm/evaluations?limit=30"),
      request<{ items: UserFeedback[] }>("/api/opc/metabolism/feedback?limit=50"),
    ]);
    setPmEvaluations(pmRes.items);
    setFeedbacks(fbRes.items);
  }, []);

  const loadCommercial = useCallback(async () => {
    const [hmRes, payRes, distRes, depRes] = await Promise.all([
      request<CommercialHeatmap>("/api/opc/metabolism/commercial-heatmap?months=6"),
      request<{ items: PaymentOrder[] }>("/api/opc/metabolism/payments?limit=80"),
      request<{ items: DistributionRecord[] }>("/api/opc/metabolism/distributions?limit=30"),
      request<{ items: DeploymentRecord[] }>("/api/opc/metabolism/deployments"),
    ]);
    setHeatmap(hmRes);
    setPayments(payRes.items);
    setDistributions(distRes.items);
    setDeployments(depRes.items);
  }, []);

  const loadProviders = useCallback(async () => {
    const cfg = await request<ProvidersConfig>("/api/opc/providers");
    setProvidersCfg(cfg);
    setProtectedPathsText(cfg.system.protectedPaths.join("\n"));
    setProviderChannelsText(cfg.services.distribution.channels.join(", "));
    setPmThreshold(cfg.system.pmAutoCreateThreshold);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      await Promise.all([loadBriefings(briefingScope), loadPmAndFeedback(), loadCommercial(), loadProviders()]);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载信息代谢与商业闭环数据失败");
    }
  }, [briefingScope, loadBriefings, loadCommercial, loadPmAndFeedback, loadProviders]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Consume cross-module drafts from Knowledge Canvas (Markdown -> Distribution, Node -> PM Agent) and ?briefing= deep-links
  useEffect(() => {
    try {
      const distRaw = sessionStorage.getItem("opc.k2b.distDraft");
      if (distRaw) {
        sessionStorage.removeItem("opc.k2b.distDraft");
        const draft = JSON.parse(distRaw) as { title?: string; content?: string; sourceRef?: string };
        if (draft.title) setDistTitle(draft.title);
        if (draft.content) setDistContent(draft.content);
        if (draft.sourceRef) setDistSourceRef(draft.sourceRef);
        setTab("commercial");
        setNotice("已载入来自画布的 Markdown 稿件，可直接一键多平台适配分发");
      }
      const pmRaw = sessionStorage.getItem("opc.k2b.pmDraft");
      if (pmRaw) {
        sessionStorage.removeItem("opc.k2b.pmDraft");
        const draft = JSON.parse(pmRaw) as { source?: string; project?: string; content?: string };
        if (draft.source) setPmSource(draft.source);
        if (draft.project) setPmProject(draft.project);
        if (draft.content) setPmContent(draft.content);
        setTab("pm");
        setNotice("已载入来自画布的灵感节点，可直接执行 PM Agent 双维立项评估");
      }
    } catch {
      // Ignore invalid sessionStorage drafts
    }
    const rawQuery = location.hash.split("?")[1] ?? "";
    const bid = new URLSearchParams(rawQuery).get("briefing") ?? "";
    if (bid) {
      setHighlightedBriefingId(bid);
      setBriefingScope("all");
      void loadBriefings("all");
    }
  }, [initialTab, loadBriefings]);

  const withStatus = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError("");
    setNotice(`正在执行：${label}…`);
    try {
      const res = await fn();
      return res;
    } catch (err) {
      setNotice("");
      setError(err instanceof Error ? err.message : `${label}失败`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  // ---- Tab 1 Actions ----

  const handleIngest = async (e: FormEvent) => {
    e.preventDefault();
    const res = await withStatus("资讯清洗入库", () =>
      request<BriefingIngestResult>("/api/opc/metabolism/briefings/ingest", {
        method: "POST",
        body: JSON.stringify({
          source: ingestSource,
          title: ingestTitle.trim() || undefined,
          rawContent: ingestContent,
        }),
      }),
    );
    if (res) {
      setLatestIngest(res);
      setMemoryMap((prev) => ({ ...prev, [res.briefing.id]: res.activatedMemories }));
      setIngestTitle("");
      setIngestContent("");
      await loadBriefings(briefingScope);
      setNotice(
        `已入库「${res.briefing.title}」（${res.briefing.score} 分 · ${res.engine === "llm" ? "大模型引擎" : "内置引擎"} · 唤醒 ${res.activatedMemories.length} 条沉睡记忆）`,
      );
    }
  };

  const handleImportJournal = async () => {
    const res = await withStatus("导入本机复盘日记", () =>
      request<BriefingJournalImportResult>("/api/opc/metabolism/briefings/import-journal", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (res) {
      await loadBriefings("all");
      setBriefingScope("all");
      setNotice(
        res.imported > 0
          ? `已从 ${res.day} 复盘日记导入 ${res.imported} 条简报（跳过重复 ${res.skipped} 条）`
          : res.availableDays.length > 0
            ? `${res.day} 复盘日记已全部导入（跳过 ${res.skipped} 条重复项）`
            : "本机未找到 daily-review-learning 日记文件，可先在右侧粘贴内容入库",
      );
    }
  };

  const handleTriggerWorkflow = async () => {
    const res = await withStatus("触发外部抓取 Workflow", () =>
      request<WorkflowTriggerResult>("/api/opc/metabolism/workflow/trigger", {
        method: "POST",
        body: JSON.stringify({ event: "metabolism.collect" }),
      }),
    );
    if (res) {
      setNotice(res.message);
    }
  };

  const handleGenerateDigest = async () => {
    const res = await withStatus("生成每日综述 Digest", () =>
      request<DailyDigest>("/api/opc/metabolism/briefings/digest"),
    );
    if (res) {
      setDigest(res);
      setNotice(`已生成 ${res.date} 每日综述（共 ${res.count} 条 · 均分 ${res.avgScore}）`);
    }
  };

  const handleProjectIsland = async () => {
    const targetCanvas = selectedCanvasId || customCanvasId.trim();
    if (!targetCanvas) {
      setError("请先选择或填写目标知识画布 ID");
      return;
    }
    const res = await withStatus("投射每日简报岛到知识画布", () =>
      request<ProjectIslandResult>("/api/opc/metabolism/briefings/project-island", {
        method: "POST",
        body: JSON.stringify({ canvasId: targetCanvas }),
      }),
    );
    if (res) {
      setNotice(res.message);
    }
  };

  const handleActivateMemory = async (briefingId: string) => {
    const res = await withStatus("语义唤醒沉睡记忆", () =>
      request<{ briefingId: string; memories: DormantMemoryHit[] }>(
        `/api/opc/metabolism/briefings/${encodeURIComponent(briefingId)}/activate-memory`,
        { method: "POST", body: "{}" },
      ),
    );
    if (res) {
      setMemoryMap((prev) => ({ ...prev, [briefingId]: res.memories }));
      setNotice(`已为该条简报唤醒 ${res.memories.length} 条高相关沉睡记忆`);
    }
  };

  const handleDeleteBriefing = async (briefingId: string) => {
    const res = await withStatus("删除简报", () =>
      request<{ deleted: boolean }>(`/api/opc/metabolism/briefings/${encodeURIComponent(briefingId)}`, {
        method: "DELETE",
      }),
    );
    if (res) {
      await loadBriefings(briefingScope);
      setNotice("简报记录已删除");
    }
  };

  // ---- Tab 2 Actions ----

  const handlePmEvaluate = async (e: FormEvent) => {
    e.preventDefault();
    const res = await withStatus("PM Agent 双维评分与任务拆解", () =>
      request<PmEvaluation>("/api/opc/metabolism/pm/evaluate", {
        method: "POST",
        body: JSON.stringify({
          project: pmProject,
          source: pmSource,
          content: pmContent,
          threshold: pmThreshold,
          autoCreate: pmAutoCreate,
          alsoAddOpportunity: pmAddOpp,
        }),
      }),
    );
    if (res) {
      setActivePmEval(res);
      await loadPmAndFeedback();
      setNotice(
        res.action === "created"
          ? `综合评分 ${res.combinedScore} ≥ ${res.threshold}，已自动立项并拆解 ${res.decomposedTasks.length} 个子任务！`
          : `综合评分 ${res.combinedScore} < ${res.threshold}，暂未自动建单（已保留评估记录）`,
      );
    }
  };

  const handleSubmitFeedback = async (e: FormEvent) => {
    e.preventDefault();
    const res = await withStatus("登记并分诊用户反馈", () =>
      request<UserFeedback>("/api/opc/metabolism/feedback", {
        method: "POST",
        body: JSON.stringify({
          project: fbProject,
          channel: fbChannel,
          rawText: fbRawText,
          autoCreateTask: fbAutoConvert,
        }),
      }),
    );
    if (res) {
      setFbRawText("");
      await loadPmAndFeedback();
      setNotice(
        res.generatedTaskId
          ? `反馈已入库并自动转为看板任务（${res.generatedTaskId}）`
          : `反馈已分诊（${FEEDBACK_CATEGORY_LABELS[res.category] ?? res.category} · P${res.priority}），可点击一键转单`,
      );
    }
  };

  const handleConvertFeedback = async (feedbackId: string) => {
    const res = await withStatus("反馈一键转看板任务", () =>
      request<FeedbackConvertResult>(
        `/api/opc/metabolism/feedback/${encodeURIComponent(feedbackId)}/create-task`,
        { method: "POST", body: "{}" },
      ),
    );
    if (res) {
      await loadPmAndFeedback();
      setNotice(res.alreadyConverted ? `该反馈已关联任务 ${res.taskId}` : `已创建看板任务 ${res.taskId}`);
    }
  };

  // ---- Tab 3 Actions ----

  const handleRecordCost = async (e: FormEvent) => {
    e.preventDefault();
    const amountNum = Number(costAmount);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      setError("请输入有效的美元成本金额");
      return;
    }
    const res = await withStatus("补记项目月度成本", () =>
      request("/api/opc/metabolism/commercial-heatmap/costs", {
        method: "POST",
        body: JSON.stringify({
          project: costProject,
          month: costMonth,
          amountUsd: amountNum,
          category: costCategory,
          note: costNote,
        }),
      }),
    );
    if (res) {
      setCostNote("");
      await loadCommercial();
      setNotice(`已补记 ${costProject}（${costMonth}）成本 $${amountNum.toFixed(2)}`);
    }
  };

  const handleStopProject = async (project: string) => {
    const res = await withStatus(`执行商业熔断停服 (${project})`, () =>
      request(`/api/opc/metabolism/kill-switch/${encodeURIComponent(project)}/stop`, {
        method: "POST",
        body: JSON.stringify({
          reason: killReason.trim() || undefined,
          notifyZoom: true,
        }),
      }),
    );
    if (res) {
      setKillConfirmProject(null);
      setKillReason("");
      await loadCommercial();
      setNotice(`项目「${project}」已触发 Kill Switch 熔断停服`);
    }
  };

  const handleResumeProject = async (project: string) => {
    const res = await withStatus(`恢复项目运行 (${project})`, () =>
      request(`/api/opc/metabolism/kill-switch/${encodeURIComponent(project)}/resume`, {
        method: "POST",
        body: JSON.stringify({ note: "商业模型复核通过，恢复运行" }),
      }),
    );
    if (res) {
      await loadCommercial();
      setNotice(`项目「${project}」已恢复运行`);
    }
  };

  const handleCreateOrder = async (e: FormEvent) => {
    e.preventDefault();
    const amountNum = Number(payAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError("收款金额需大于 0");
      return;
    }
    const res = await withStatus("创建多渠道收款订单", () =>
      request<PaymentOrder>("/api/opc/metabolism/payments/orders", {
        method: "POST",
        body: JSON.stringify({
          project: payProject,
          subject: paySubject,
          channel: payChannel,
          amount: amountNum,
          currency: payCurrency,
        }),
      }),
    );
    if (res) {
      await loadCommercial();
      setNotice(`收款订单 ${res.outTradeNo} 已创建（${res.sandbox ? "沙盒链接" : "正式签名链接"}）`);
    }
  };

  const handleSandboxPay = async (orderId: string) => {
    const res = await withStatus("沙盒模拟支付到账", () =>
      request<PaymentOrder>(`/api/opc/metabolism/payments/${encodeURIComponent(orderId)}/sandbox-pay`, {
        method: "POST",
        body: "{}",
      }),
    );
    if (res) {
      await loadCommercial();
      setNotice(`订单 ${res.outTradeNo} 已确认到账，商业盈亏热力图已实时刷新！`);
    }
  };

  const toggleDistChannel = (ch: DistributionChannel) => {
    setDistChannels((prev) => (prev.includes(ch) ? prev.filter((item) => item !== ch) : [...prev, ch]));
  };

  const handleDistribute = async (e: FormEvent) => {
    e.preventDefault();
    if (distChannels.length === 0) {
      setError("请至少勾选一个分发渠道");
      return;
    }
    const res = await withStatus("生成多渠道适配稿并分发", () =>
      request<DistributionRecord>("/api/opc/metabolism/distributions", {
        method: "POST",
        body: JSON.stringify({
          title: distTitle,
          content: distContent,
          channels: distChannels,
          sourceRef: distSourceRef,
        }),
      }),
    );
    if (res) {
      setExpandedDistId(res.id);
      setDistTitle("");
      setDistContent("");
      setDistSourceRef("");
      await loadCommercial();
      setNotice(`已为 ${res.channels.length} 个渠道生成适配稿件（状态：${res.status}）`);
    }
  };

  const handleCreateDeployment = async (e: FormEvent) => {
    e.preventDefault();
    const envVars: Record<string, string> = {};
    for (const line of depEnvText.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) envVars[k] = v;
      }
    }
    const res = await withStatus("新增外循环部署配置", () =>
      request<DeploymentRecord>("/api/opc/metabolism/deployments", {
        method: "POST",
        body: JSON.stringify({
          project: depProject,
          targetHost: depHost,
          dockerImage: depImage,
          deployCommand: depCmd,
          version: depVersion,
          envVars,
        }),
      }),
    );
    if (res) {
      setExpandedDepId(res.id);
      await loadCommercial();
      setNotice(`部署配置 ${res.project}@${res.version} 已登记`);
    }
  };

  const handleTriggerDeploy = async (id: string) => {
    const res = await withStatus("执行外循环部署", () =>
      request<DeploymentRecord>(`/api/opc/metabolism/deployments/${encodeURIComponent(id)}/deploy`, {
        method: "POST",
        body: "{}",
      }),
    );
    if (res) {
      setExpandedDepId(res.id);
      await loadCommercial();
      setNotice(`${res.project}@${res.version} 部署完成`);
    }
  };

  const handleRollbackDeploy = async (id: string) => {
    const res = await withStatus("回滚部署版本", () =>
      request<DeploymentRecord>(`/api/opc/metabolism/deployments/${encodeURIComponent(id)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ note: "手动一键回滚至上一稳定版本" }),
      }),
    );
    if (res) {
      setExpandedDepId(res.id);
      await loadCommercial();
      setNotice(`${res.project}@${res.version} 已执行回滚`);
    }
  };

  // ---- Tab 4 Actions ----

  const handleSaveProviders = async (e: FormEvent) => {
    e.preventDefault();
    if (!providersCfg) return;
    const payload = {
      system: {
        ...providersCfg.system,
        protectedPaths: protectedPathsText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      models: providersCfg.models,
      services: {
        ...providersCfg.services,
        distribution: {
          ...providersCfg.services.distribution,
          channels: providerChannelsText
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      },
    };
    const res = await withStatus("保存 Provider 全局配置", () =>
      request<ProvidersConfig>("/api/opc/providers", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    );
    if (res) {
      setProvidersCfg(res);
      setPmThreshold(res.system.pmAutoCreateThreshold);
      setNotice("全局 Provider 配置已落盘，已脱敏保护全部密钥");
    }
  };

  const handleHealthCheck = async () => {
    const res = await withStatus("运行全系统 Provider 健康检查", () =>
      request<ProvidersHealthReport>("/api/opc/providers/health", {
        method: "POST",
        body: "{}",
      }),
    );
    if (res) {
      setHealthReport(res);
      setNotice(`健康检查完成：整体状态 ${res.overall === "ok" ? "正常" : "部分降级"}（共 ${res.entries.length} 项）`);
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`已复制 ${label}`);
    } catch {
      setNotice(`请手动复制 ${label}`);
    }
  };

  return (
    <section className="zo-product mh-page" aria-label="信息代谢与商业闭环中枢">
      <header className="mh-head">
        <div>
          <div className="mh-title-row">
            {nav}
            <h1>信息代谢与商业闭环中枢</h1>
          </div>
          <p className="mh-sub">
            从每日资讯清洗与沉睡记忆唤醒，到 PM Agent 双维自动立项、反馈反哺、原生多渠道收款、全渠道分发与商业熔断。
          </p>
        </div>
        <div className="mh-toolbar">
          <button type="button" disabled={busy} onClick={() => void loadAll()}>
            刷新全部数据
          </button>
          <a className="mh-link-btn" href="#planning">
            前往研发看板
          </a>
        </div>
      </header>

      <div className="mh-kpis" aria-label="中枢核心指标">
        <div className="mh-kpi">
          <span>信息代谢简报</span>
          <strong>{briefings.length}</strong>
          <small>{briefingScope === "today" ? "今日已清洗入库" : "近期累计收录"}</small>
        </div>
        <div className="mh-kpi">
          <span>PM Agent 立项 / 反馈闭环</span>
          <strong>
            {pmEvaluations.filter((e) => e.action === "created").length} /{" "}
            {feedbacks.filter((f) => f.status === "converted").length}
          </strong>
          <small>
            评估 {pmEvaluations.length} 次 · 用户反馈 {feedbacks.length} 条
          </small>
        </div>
        <div className="mh-kpi">
          <span>近 6 月净盈亏</span>
          <strong
            className={
              (heatmap?.summary.totalNetProfitUsd ?? 0) >= 0 ? "mh-num-profit" : "mh-num-loss"
            }
          >
            {formatUsd(heatmap?.summary.totalNetProfitUsd ?? 0)}
          </strong>
          <small>
            营收 ${(heatmap?.summary.totalRevenueUsd ?? 0).toFixed(2)} · 成本 $
            {(heatmap?.summary.totalCostUsd ?? 0).toFixed(2)}
          </small>
        </div>
        <div className="mh-kpi">
          <span>商业熔断监控</span>
          <strong className={(heatmap?.summary.alertCount ?? 0) > 0 ? "mh-num-loss" : "mh-num-profit"}>
            {heatmap?.summary.alertCount ?? 0} 预警 / {heatmap?.summary.stoppedCount ?? 0} 停服
          </strong>
          <small>连续亏损 ≥ {heatmap?.lossKillSwitchMonths ?? 3} 个月自动预警</small>
        </div>
      </div>

      <nav className="mh-tabs" role="tablist" aria-label="中枢主功能切换">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "briefings"}
          onClick={() => setTab("briefings")}
        >
          1. 信息代谢 & 每日简报
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pm"}
          onClick={() => setTab("pm")}
        >
          2. PM Agent 自动立项 & 用户反馈
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "commercial"}
          onClick={() => setTab("commercial")}
        >
          3. 商业监控热力图、收款、分发与部署
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "providers"}
          onClick={() => setTab("providers")}
        >
          4. 外部 Provider 配置中心 & 健康检查
        </button>
      </nav>

      {notice && (
        <p role="status" className="mh-banner">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mh-banner error">
          {error}
        </p>
      )}

      {/* ==================== TAB 1: BRIEFINGS ==================== */}
      {tab === "briefings" && (
        <div className="mh-section">
          <div className="mh-action-bar">
            <button type="button" className="mh-primary" disabled={busy} onClick={() => void handleImportJournal()}>
              导入今日复盘日记
            </button>
            <button type="button" disabled={busy} onClick={() => void handleTriggerWorkflow()}>
              触发外部抓取 Workflow
            </button>
            <button type="button" disabled={busy} onClick={() => void handleGenerateDigest()}>
              生成每日综述 Digest
            </button>
            <div className="mh-island-group">
              {canvases.length > 0 ? (
                <select
                  aria-label="选择知识画布"
                  value={selectedCanvasId}
                  onChange={(e) => setSelectedCanvasId(e.target.value)}
                >
                  {canvases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label="目标知识画布 ID"
                  value={customCanvasId}
                  onChange={(e) => setCustomCanvasId(e.target.value)}
                  placeholder="画布 ID"
                />
              )}
              <button type="button" className="mh-accent" disabled={busy} onClick={() => void handleProjectIsland()}>
                一键投射简报岛到画布
              </button>
            </div>
          </div>

          {digest && (
            <div className="mh-panel mh-digest-box">
              <div className="mh-panel-head">
                <div>
                  <h3>
                    {digest.date} 每日综述（{digest.count} 条 · 均分 {digest.avgScore}）
                  </h3>
                  <div className="mh-tags">
                    {digest.topTags.map((t) => (
                      <span key={t.tag} className="mh-tag">
                        #{t.tag} ({t.count})
                      </span>
                    ))}
                  </div>
                </div>
                <div className="mh-inline-actions">
                  <button type="button" onClick={() => void copyText(digest.markdown, "每日综述 Markdown")}>
                    复制 Markdown
                  </button>
                  <button
                    type="button"
                    className="mh-primary"
                    onClick={() => {
                      setDistTitle(`${digest.date} 每日资讯综述`);
                      setDistContent(digest.markdown);
                      setDistSourceRef(`digest:${digest.date}`);
                      setTab("commercial");
                      setNotice("已将每日综述载入全渠道分发台");
                    }}
                  >
                    一鱼多吃分发 ↗
                  </button>
                  <button type="button" onClick={() => setDigest(null)}>
                    收起
                  </button>
                </div>
              </div>
              <pre className="mh-code">{digest.markdown}</pre>
            </div>
          )}

          <div className="mh-two-col">
            <div className="mh-col">
              <div className="mh-section-head">
                <h2>每日资讯卡片流</h2>
                <div className="mh-inline-actions">
                  <button
                    type="button"
                    className={briefingScope === "today" ? "mh-primary" : ""}
                    onClick={() => {
                      setBriefingScope("today");
                      void loadBriefings("today");
                    }}
                  >
                    仅今日
                  </button>
                  <button
                    type="button"
                    className={briefingScope === "all" ? "mh-primary" : ""}
                    onClick={() => {
                      setBriefingScope("all");
                      void loadBriefings("all");
                    }}
                  >
                    全部历史
                  </button>
                </div>
              </div>

              {briefings.length === 0 ? (
                <div className="mh-empty">
                  暂无简报条目。可在右侧粘贴 X / Hacker News / GitHub 原文立即清洗入库，或点击上方「导入今日复盘日记」。
                </div>
              ) : (
                <div className="mh-card-list">
                  {briefings.map((item) => {
                    const memories = memoryMap[item.id] ?? item.activatedMemories ?? [];
                    return (
                      <article
                        key={item.id}
                        className="mh-card"
                        style={
                          highlightedBriefingId === item.id
                            ? { borderColor: "#2f513e", boxShadow: "0 0 0 2px rgba(47, 81, 62, 0.25)" }
                            : undefined
                        }
                      >
                        <div className="mh-card-top">
                          <div className="mh-inline-actions">
                            <span className="mh-badge">{item.source}</span>
                            <span className={`mh-badge ${scoreTone(item.score)}`}>价值分 {item.score}</span>
                            <span className="mh-muted">{item.date}</span>
                          </div>
                          <div className="mh-inline-actions">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleActivateMemory(item.id)}
                            >
                              唤醒沉睡记忆
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPmSource(item.source);
                                setPmContent(`${item.title}\n${item.summary}\n${item.corePoints.join("\n")}`);
                                setTab("pm");
                              }}
                            >
                              送 PM 评估
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleDeleteBriefing(item.id)}
                            >
                              删除
                            </button>
                          </div>
                        </div>

                        <h3>{item.title}</h3>
                        <p className="mh-summary">{item.summary}</p>

                        <ul className="mh-points">
                          {item.corePoints.map((pt, idx) => (
                            <li key={idx}>{pt}</li>
                          ))}
                        </ul>

                        <div className="mh-tags">
                          {item.tags.map((tag) => (
                            <span key={tag} className="mh-tag">
                              #{tag}
                            </span>
                          ))}
                        </div>
                        <small className="mh-muted">评分依据：{item.scoreReason}</small>

                        {memories.length > 0 && (
                          <div className="mh-memories">
                            <strong>唤醒沉睡记忆（{memories.length}）</strong>
                            <ul>
                              {memories.map((m) => (
                                <li key={`${m.kind}-${m.id}`}>
                                  <a href={m.href}>{m.title}</a>
                                  <span className="mh-badge">
                                    {m.kind === "canvas_node"
                                      ? "画布节点"
                                      : m.kind === "company_idea"
                                        ? "公司想法"
                                        : "历史简报"}{" "}
                                    · {(m.similarity * 100).toFixed(0)}%
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mh-col">
              <div className="mh-panel">
                <div className="mh-panel-head">
                  <h2>资讯入库清洗</h2>
                  <span className="mh-badge">支持 LLM / 离线确定性双引擎</span>
                </div>
                <form className="mh-form" onSubmit={(e) => void handleIngest(e)}>
                  <div className="mh-form-row">
                    <label>
                      信息来源
                      <select value={ingestSource} onChange={(e) => setIngestSource(e.target.value)}>
                        {BRIEFING_SOURCES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      自定义标题（可选）
                      <input
                        value={ingestTitle}
                        onChange={(e) => setIngestTitle(e.target.value)}
                        placeholder="留空则自动提炼精炼标题"
                      />
                    </label>
                  </div>
                  <label>
                    原始资讯 / 长文 / 帖子内容
                    <textarea
                      rows={8}
                      required
                      value={ingestContent}
                      onChange={(e) => setIngestContent(e.target.value)}
                      placeholder="粘贴 X 帖子、Hacker News 讨论、GitHub README、行业研报或复盘笔记，系统将自动提炼 3 条核心观点、标签、价值评分并唤醒历史沉睡记忆…"
                    />
                  </label>
                  <button type="submit" className="mh-primary" disabled={busy}>
                    清洗入库并唤醒沉睡记忆
                  </button>
                </form>
              </div>

              {latestIngest && (
                <div className="mh-panel mh-live-result">
                  <div className="mh-panel-head">
                    <h3>最近入库提炼结果</h3>
                    <div className="mh-inline-actions">
                      <span className="mh-badge ok">
                        {latestIngest.engine === "llm" ? "LLM 大模型" : "内置结构化引擎"}
                      </span>
                      <span className="mh-badge">向量：{latestIngest.vectorSource}</span>
                    </div>
                  </div>
                  <strong>{latestIngest.briefing.title}</strong>
                  <p className="mh-summary">{latestIngest.briefing.summary}</p>
                  <ul className="mh-points">
                    {latestIngest.briefing.corePoints.map((pt, i) => (
                      <li key={i}>{pt}</li>
                    ))}
                  </ul>
                  {latestIngest.activatedMemories.length > 0 ? (
                    <div className="mh-memories">
                      <strong>实时激活的历史沉睡记忆</strong>
                      <ul>
                        {latestIngest.activatedMemories.map((m) => (
                          <li key={`${m.kind}-${m.id}`}>
                            <a href={m.href}>{m.title}</a>
                            <span className="mh-badge ok">{(m.similarity * 100).toFixed(0)}%</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <small className="mh-muted">暂无高相似度历史记忆，随着简报与画布积累将自动触发语义联想。</small>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== TAB 2: PM AGENT & FEEDBACK ==================== */}
      {tab === "pm" && (
        <div className="mh-section mh-two-col">
          {/* Left: PM Agent */}
          <div className="mh-col">
            <div className="mh-panel">
              <div className="mh-panel-head">
                <h2>PM Agent 双维评分 & 自动立项</h2>
                <span className="mh-badge">阈值 ≥ {pmThreshold} 自动建 Epic + SubTasks</span>
              </div>
              <form className="mh-form" onSubmit={(e) => void handlePmEvaluate(e)}>
                <div className="mh-form-row">
                  <label>
                    归属项目
                    <input
                      required
                      value={pmProject}
                      onChange={(e) => setPmProject(e.target.value)}
                      placeholder="例如 PageLens"
                    />
                  </label>
                  <label>
                    线索来源
                    <select value={pmSource} onChange={(e) => setPmSource(e.target.value)}>
                      <option value="briefing">每日简报</option>
                      <option value="feedback">用户反馈</option>
                      <option value="manual">手工提案</option>
                      <option value="market">竞品洞察</option>
                    </select>
                  </label>
                  <label>
                    自动立项阈值
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={pmThreshold}
                      onChange={(e) => setPmThreshold(Number(e.target.value) || 85)}
                    />
                  </label>
                </div>
                <label>
                  需求 / 资讯 / 商业想法描述
                  <textarea
                    rows={5}
                    required
                    value={pmContent}
                    onChange={(e) => setPmContent(e.target.value)}
                    placeholder="描述产品形态、目标用户痛点、技术实现路径与收费/变现模式（例如：Chrome 扩展 + 离线 License $29 买断，2 周完成 MVP）…"
                  />
                </label>
                <div className="mh-checkbox-row">
                  <label className="mh-check">
                    <input
                      type="checkbox"
                      checked={pmAutoCreate}
                      onChange={(e) => setPmAutoCreate(e.target.checked)}
                    />
                    达到阈值自动立项创建 Epic + SubTasks
                  </label>
                  <label className="mh-check">
                    <input
                      type="checkbox"
                      checked={pmAddOpp}
                      onChange={(e) => setPmAddOpp(e.target.checked)}
                    />
                    同步推入研发选题队列
                  </label>
                </div>
                <button type="submit" className="mh-primary" disabled={busy}>
                  运行 PM Agent 双维评估
                </button>
              </form>
            </div>

            {activePmEval && (
              <div className="mh-panel mh-pm-result">
                <div className="mh-panel-head">
                  <div>
                    <h3>{activePmEval.taskTitle}</h3>
                    <small className="mh-muted">
                      项目 {activePmEval.project} · 来源 {activePmEval.source}
                    </small>
                  </div>
                  <span className={`mh-badge ${activePmEval.action === "created" ? "ok" : "mid"}`}>
                    {activePmEval.action === "created" ? "已自动立项" : "未达立项阈值"} · 综合{" "}
                    {activePmEval.combinedScore} / {activePmEval.threshold}
                  </span>
                </div>

                <div className="mh-score-bars">
                  <div className="mh-score-row">
                    <span>技术可行性（2 周 MVP）</span>
                    <div className="mh-bar-track">
                      <div
                        className="mh-bar-fill tech"
                        style={{ width: `${activePmEval.technicalScore}%` }}
                      />
                    </div>
                    <strong>{activePmEval.technicalScore}</strong>
                  </div>
                  <div className="mh-score-row">
                    <span>商业变现潜力</span>
                    <div className="mh-bar-track">
                      <div
                        className="mh-bar-fill comm"
                        style={{ width: `${activePmEval.commercialScore}%` }}
                      />
                    </div>
                    <strong>{activePmEval.commercialScore}</strong>
                  </div>
                </div>

                <p className="mh-summary">{activePmEval.reasoning}</p>

                {activePmEval.action === "created" && (
                  <div className="mh-created-link">
                    <span>
                      Epic ID：{activePmEval.epicTaskId || "本地立项记录"}
                      {activePmEval.opportunityId ? ` · 选题 ID：${activePmEval.opportunityId}` : ""}
                    </span>
                    <a href="#planning">直达 #planning 看板查看任务树 →</a>
                  </div>
                )}

                <div className="mh-subtasks">
                  <h4>自动拆解任务树（{activePmEval.decomposedTasks.length}）</h4>
                  <ol>
                    {activePmEval.decomposedTasks.map((t, idx) => (
                      <li key={idx}>
                        <div className="mh-inline-actions">
                          <span className="mh-badge">{t.type.toUpperCase()}</span>
                          <span className="mh-badge mid">P{t.priority}</span>
                          <strong>{t.title}</strong>
                        </div>
                        <p>{t.description}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            )}

            <div className="mh-panel">
              <h3>历史 PM 评估记录（{pmEvaluations.length}）</h3>
              {pmEvaluations.length === 0 ? (
                <p className="mh-muted">暂无历史评估记录。</p>
              ) : (
                <ul className="mh-history-list">
                  {pmEvaluations.map((ev) => (
                    <li key={ev.id} onClick={() => setActivePmEval(ev)}>
                      <div>
                        <strong>{ev.taskTitle}</strong>
                        <small className="mh-muted">
                          {ev.project} · 技术 {ev.technicalScore} / 商业 {ev.commercialScore} / 综合{" "}
                          {ev.combinedScore}
                        </small>
                      </div>
                      <span className={`mh-badge ${ev.action === "created" ? "ok" : ""}`}>
                        {ev.action === "created" ? "已立项" : "观察中"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right: User Feedback */}
          <div className="mh-col">
            <div className="mh-panel">
              <div className="mh-panel-head">
                <h2>用户反馈反哺台</h2>
                <span className="mh-badge">原声提炼 → 看板任务闭环</span>
              </div>
              <form className="mh-form" onSubmit={(e) => void handleSubmitFeedback(e)}>
                <div className="mh-form-row">
                  <label>
                    所属项目
                    <input
                      required
                      value={fbProject}
                      onChange={(e) => setFbProject(e.target.value)}
                      placeholder="例如 PageLens"
                    />
                  </label>
                  <label>
                    反馈渠道
                    <select value={fbChannel} onChange={(e) => setFbChannel(e.target.value)}>
                      <option value="in_app">产品内反馈</option>
                      <option value="wechat">微信/私域</option>
                      <option value="email">邮件工单</option>
                      <option value="github">GitHub Issue</option>
                      <option value="x">X / 社媒评论</option>
                    </select>
                  </label>
                </div>
                <label>
                  用户反馈原文
                  <textarea
                    rows={4}
                    required
                    value={fbRawText}
                    onChange={(e) => setFbRawText(e.target.value)}
                    placeholder="粘贴用户的报错描述、付费卡点、交互建议或新功能诉求…"
                  />
                </label>
                <label className="mh-check">
                  <input
                    type="checkbox"
                    checked={fbAutoConvert}
                    onChange={(e) => setFbAutoConvert(e.target.checked)}
                  />
                  入库后自动转为看板研发任务
                </label>
                <button type="submit" className="mh-primary" disabled={busy}>
                  登记并智能提炼待办行动
                </button>
              </form>
            </div>

            <div className="mh-panel">
              <h3>反馈闭环追溯表（{feedbacks.length}）</h3>
              {feedbacks.length === 0 ? (
                <p className="mh-muted">暂无用户反馈记录。</p>
              ) : (
                <div className="mh-card-list">
                  {feedbacks.map((fb) => (
                    <article key={fb.id} className="mh-subcard">
                      <div className="mh-card-top">
                        <div className="mh-inline-actions">
                          <span className="mh-badge">{fb.project}</span>
                          <span className="mh-badge">
                            {FEEDBACK_CATEGORY_LABELS[fb.category] ?? fb.category}
                          </span>
                          <span
                            className={`mh-badge ${
                              fb.severity === "high" ? "warn" : fb.severity === "medium" ? "mid" : ""
                            }`}
                          >
                            {SEVERITY_LABELS[fb.severity] ?? fb.severity} · P{fb.priority}
                          </span>
                        </div>
                        {fb.generatedTaskId ? (
                          <a className="mh-badge ok" href="#planning">
                            已转任务：{fb.generatedTaskId}
                          </a>
                        ) : (
                          <button
                            type="button"
                            className="mh-primary"
                            disabled={busy}
                            onClick={() => void handleConvertFeedback(fb.id)}
                          >
                            一键转看板任务
                          </button>
                        )}
                      </div>
                      <strong className="mh-action-line">{fb.extractedAction}</strong>
                      <p className="mh-muted">原文（{fb.channel}）：{fb.rawText}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== TAB 3: COMMERCIAL HEATMAP, PAYMENTS, DISTRIBUTION, DEPLOY ==================== */}
      {tab === "commercial" && (
        <div className="mh-section mh-stack">
          {/* 3A: Commercial Heatmap & Kill Switch */}
          <div className="mh-panel">
            <div className="mh-section-head">
              <div>
                <h2>商业监控盈亏热力图 & 连续亏损熔断面板</h2>
                <p className="mh-muted">
                  按项目 × 近 6 个自然月汇总已到账收款与 Agent/基础设施成本。连续 ≥{" "}
                  {heatmap?.lossKillSwitchMonths ?? 3} 个月亏损自动标红熔断预警。
                </p>
              </div>
              <div className="mh-legend">
                <span className="mh-cell-chip profit">盈利</span>
                <span className="mh-cell-chip breakeven">持平</span>
                <span className="mh-cell-chip loss">亏损</span>
              </div>
            </div>

            {heatmap && heatmap.projects.length > 0 ? (
              <div className="mh-table-wrap opc-table-scroll" role="region" aria-label="项目月度净收支" tabIndex={0}>
                <table className="mh-heatmap-table">
                  <thead>
                    <tr>
                      <th>项目</th>
                      {heatmap.months.map((m) => (
                        <th key={m}>{m}</th>
                      ))}
                      <th>6 月累计</th>
                      <th>熔断监控 & 操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heatmap.projects.map((row) => {
                      const isStopped = row.killSwitch?.status === "stopped";
                      return (
                        <tr key={row.project} className={row.killSwitchAlert ? "mh-row-alert" : ""}>
                          <td className="mh-proj-cell">
                            <strong>{row.project}</strong>
                            {isStopped && <span className="mh-badge warn">已停服</span>}
                            {row.killSwitchAlert && !isStopped && (
                              <span className="mh-badge warn">
                                ⚠️ 触发亏损熔断（连续 {row.consecutiveLossMonths} 月）
                              </span>
                            )}
                          </td>
                          {row.cells.map((cell) => (
                            <td
                              key={cell.month}
                              className={`mh-heat-cell ${cell.status}`}
                              title={`${row.project} (${cell.month}) · 营收 $${cell.revenueUsd.toFixed(2)} / 成本 $${cell.costUsd.toFixed(2)}`}
                            >
                              <div className="mh-heat-val">{formatUsd(cell.netProfitUsd)}</div>
                              <small>
                                +{cell.revenueUsd.toFixed(0)} / -{cell.costUsd.toFixed(0)}
                              </small>
                            </td>
                          ))}
                          <td className="mh-total-cell">
                            <strong className={row.totalNetProfitUsd >= 0 ? "mh-num-profit" : "mh-num-loss"}>
                              {formatUsd(row.totalNetProfitUsd)}
                            </strong>
                          </td>
                          <td className="mh-ops-cell">
                            {isStopped ? (
                              <button
                                type="button"
                                className="mh-primary"
                                disabled={busy}
                                onClick={() => void handleResumeProject(row.project)}
                              >
                                恢复运行
                              </button>
                            ) : killConfirmProject === row.project ? (
                              <div className="mh-kill-confirm">
                                <input
                                  value={killReason}
                                  onChange={(e) => setKillReason(e.target.value)}
                                  placeholder="停服原因（可选）"
                                />
                                <button
                                  type="button"
                                  className="mh-accent"
                                  disabled={busy}
                                  onClick={() => void handleStopProject(row.project)}
                                >
                                  确认停服
                                </button>
                                <button type="button" onClick={() => setKillConfirmProject(null)}>
                                  取消
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className={row.killSwitchAlert ? "mh-accent" : ""}
                                disabled={busy}
                                onClick={() => {
                                  setKillConfirmProject(row.project);
                                  setKillReason(
                                    row.killSwitchAlert
                                      ? `连续 ${row.consecutiveLossMonths} 个月亏损（-$${row.cumulativeLossUsd.toFixed(2)}），执行止损停服`
                                      : "",
                                  );
                                }}
                              >
                                一键停服 Kill Switch
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mh-empty">
                当前尚无项目收支流水。可通过下方「补记月度成本」或「创建订单并沙盒到账」立即点亮商业盈亏热力图！
              </div>
            )}

            <form className="mh-inline-form" onSubmit={(e) => void handleRecordCost(e)}>
              <strong>补记项目月度成本（USD）：</strong>
              <input
                required
                value={costProject}
                onChange={(e) => setCostProject(e.target.value)}
                placeholder="项目名"
              />
              <input
                required
                value={costMonth}
                onChange={(e) => setCostMonth(e.target.value)}
                placeholder="YYYY-MM"
              />
              <input
                required
                type="number"
                step="0.01"
                min="0"
                value={costAmount}
                onChange={(e) => setCostAmount(e.target.value)}
                placeholder="成本 (USD)"
              />
              <select value={costCategory} onChange={(e) => setCostCategory(e.target.value)}>
                <option value="infra">云主机/基础设施</option>
                <option value="token">AI Token 算力</option>
                <option value="marketing">投放与推广</option>
                <option value="other">其他成本</option>
              </select>
              <input
                value={costNote}
                onChange={(e) => setCostNote(e.target.value)}
                placeholder="备注"
              />
              <button type="submit" disabled={busy}>
                补记成本
              </button>
            </form>
          </div>

          {/* 3B: Multi-channel Native Payments */}
          <div className="mh-two-col">
            <div className="mh-panel">
              <div className="mh-panel-head">
                <h2>多渠道原生收款台</h2>
                <span className="mh-badge">虎皮椒 MD5 / Stripe / Lemon Squeezy</span>
              </div>
              <form className="mh-form" onSubmit={(e) => void handleCreateOrder(e)}>
                <div className="mh-form-row">
                  <label>
                    归属项目
                    <input
                      required
                      value={payProject}
                      onChange={(e) => setPayProject(e.target.value)}
                    />
                  </label>
                  <label>
                    收款渠道
                    <select
                      value={payChannel}
                      onChange={(e) => {
                        const ch = e.target.value as PaymentChannel;
                        setPayChannel(ch);
                        setPayCurrency(ch === "hupijiao" ? "CNY" : "USD");
                      }}
                    >
                      <option value="hupijiao">国内 · 虎皮椒 (Hupijiao)</option>
                      <option value="stripe">全球 · Stripe</option>
                      <option value="lemonsqueezy">全球 · Lemon Squeezy</option>
                    </select>
                  </label>
                </div>
                <div className="mh-form-row">
                  <label>
                    商品/服务名称
                    <input
                      required
                      value={paySubject}
                      onChange={(e) => setPaySubject(e.target.value)}
                    />
                  </label>
                  <label>
                    金额
                    <input
                      required
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                    />
                  </label>
                  <label>
                    币种
                    <input
                      required
                      value={payCurrency}
                      onChange={(e) => setPayCurrency(e.target.value.toUpperCase())}
                      maxLength={3}
                    />
                  </label>
                </div>
                <button type="submit" className="mh-primary" disabled={busy}>
                  创建收款订单
                </button>
              </form>

              <div className="mh-sublist">
                <h4>收款流水（{payments.length}）</h4>
                {payments.length === 0 ? (
                  <p className="mh-muted">暂无订单流水。</p>
                ) : (
                  <div className="mh-table-wrap opc-table-scroll" role="region" aria-label="收款流水" tabIndex={0}>
                    <table className="mh-simple-table">
                      <thead>
                        <tr>
                          <th>单号 / 项目</th>
                          <th>渠道</th>
                          <th>金额</th>
                          <th>状态</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payments.map((ord) => (
                          <tr key={ord.id}>
                            <td>
                              <strong>{ord.outTradeNo}</strong>
                              <div className="mh-muted">
                                {ord.project} · {ord.subject}
                              </div>
                            </td>
                            <td>
                              {ord.channel}
                              {ord.sandbox ? " (沙盒)" : ""}
                            </td>
                            <td className="mh-mono">
                              {ord.amount.toFixed(2)} {ord.currency}
                            </td>
                            <td>
                              <span className={`mh-badge ${ord.status === "paid" ? "ok" : "mid"}`}>
                                {ord.status === "paid" ? "已到账" : ord.status}
                              </span>
                            </td>
                            <td>
                              <div className="mh-inline-actions">
                                <button
                                  type="button"
                                  onClick={() => void copyText(ord.payUrl, "支付链接")}
                                >
                                  复制链接
                                </button>
                                {ord.status !== "paid" && (
                                  <button
                                    type="button"
                                    className="mh-primary"
                                    disabled={busy}
                                    onClick={() => void handleSandboxPay(ord.id)}
                                  >
                                    沙盒一键到账
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* 3C: Omnichannel Content Distribution */}
            <div className="mh-panel">
              <div className="mh-panel-head">
                <h2>全渠道内容分发台</h2>
                <span className="mh-badge">一鱼多吃 · 6 平台自动改写</span>
              </div>
              <form className="mh-form" onSubmit={(e) => void handleDistribute(e)}>
                <div className="mh-form-row">
                  <label>
                    分发标题
                    <input
                      required
                      value={distTitle}
                      onChange={(e) => setDistTitle(e.target.value)}
                      placeholder="例如：我们如何用一人公司操作系统 2 周跑通首单"
                    />
                  </label>
                  <label>
                    原文/仓库链接（可选）
                    <input
                      value={distSourceRef}
                      onChange={(e) => setDistSourceRef(e.target.value)}
                      placeholder="https://github.com/..."
                    />
                  </label>
                </div>
                <label>
                  母稿正文
                  <textarea
                    rows={4}
                    required
                    value={distContent}
                    onChange={(e) => setDistContent(e.target.value)}
                    placeholder="输入产品更新、技术复盘或案例正文，一键适配公众号、掘金、X Thread、Reddit、Newsletter 与 Telegram…"
                  />
                </label>
                <div className="mh-checkbox-row">
                  {DISTRIBUTION_CHANNELS.map((ch) => (
                    <label key={ch.id} className="mh-check">
                      <input
                        type="checkbox"
                        checked={distChannels.includes(ch.id)}
                        onChange={() => toggleDistChannel(ch.id)}
                      />
                      {ch.label}
                    </label>
                  ))}
                </div>
                <button type="submit" className="mh-primary" disabled={busy}>
                  生成多渠道适配稿并分发
                </button>
              </form>

              <div className="mh-sublist">
                <h4>分发台账（{distributions.length}）</h4>
                {distributions.length === 0 ? (
                  <p className="mh-muted">暂无分发记录。</p>
                ) : (
                  <div className="mh-card-list">
                    {distributions.map((dist) => {
                      const open = expandedDistId === dist.id;
                      return (
                        <article key={dist.id} className="mh-subcard">
                          <div className="mh-card-top">
                            <div>
                              <strong>{dist.title}</strong>
                              <div className="mh-tags">
                                {dist.channels.map((ch) => (
                                  <span key={ch} className="mh-tag">
                                    {ch}
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="mh-inline-actions">
                              <span className={`mh-badge ${dist.status === "sent" ? "ok" : "mid"}`}>
                                {dist.status === "sent" ? "已推 Webhook" : "适配稿就绪"}
                              </span>
                              <button
                                type="button"
                                onClick={() => setExpandedDistId(open ? null : dist.id)}
                              >
                                {open ? "收起稿件" : "查看适配稿"}
                              </button>
                            </div>
                          </div>
                          {open && (
                            <div className="mh-adapted-grid">
                              {dist.channels.map((ch) => (
                                <div key={ch} className="mh-adapted-item">
                                  <div className="mh-card-top">
                                    <strong>{ch.toUpperCase()}</strong>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void copyText(dist.adaptedPayload[ch] ?? "", `${ch} 适配稿`)
                                      }
                                    >
                                      复制稿件
                                    </button>
                                  </div>
                                  <pre className="mh-code">{dist.adaptedPayload[ch] ?? ""}</pre>
                                </div>
                              ))}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 3D: Fractal CI/CD Outer-loop Deployments */}
          <div className="mh-panel">
            <div className="mh-panel-head">
              <h2>分形 CI/CD 外循环部署台</h2>
              <span className="mh-badge">主机 / 镜像 / 版本发布与一键回滚</span>
            </div>
            <div className="mh-two-col">
              <form className="mh-form" onSubmit={(e) => void handleCreateDeployment(e)}>
                <div className="mh-form-row">
                  <label>
                    项目名
                    <input
                      required
                      value={depProject}
                      onChange={(e) => setDepProject(e.target.value)}
                    />
                  </label>
                  <label>
                    目标主机
                    <input
                      required
                      value={depHost}
                      onChange={(e) => setDepHost(e.target.value)}
                      placeholder="ssh-host / tailnet"
                    />
                  </label>
                  <label>
                    发布版本
                    <input
                      required
                      value={depVersion}
                      onChange={(e) => setDepVersion(e.target.value)}
                      placeholder="v1.0.0"
                    />
                  </label>
                </div>
                <div className="mh-form-row">
                  <label>
                    Docker 镜像（可选）
                    <input
                      value={depImage}
                      onChange={(e) => setDepImage(e.target.value)}
                      placeholder="ghcr.io/..."
                    />
                  </label>
                  <label>
                    部署命令（可选）
                    <input
                      value={depCmd}
                      onChange={(e) => setDepCmd(e.target.value)}
                      placeholder="docker compose up -d"
                    />
                  </label>
                </div>
                <label>
                  环境变量（每行 KEY=VALUE）
                  <textarea
                    rows={3}
                    value={depEnvText}
                    onChange={(e) => setDepEnvText(e.target.value)}
                  />
                </label>
                <button type="submit" className="mh-primary" disabled={busy}>
                  登记部署配置
                </button>
              </form>

              <div>
                <h4>已登记部署目标（{deployments.length}）</h4>
                {deployments.length === 0 ? (
                  <p className="mh-muted">暂无外循环部署记录。</p>
                ) : (
                  <div className="mh-card-list">
                    {deployments.map((dep) => {
                      const open = expandedDepId === dep.id;
                      return (
                        <article key={dep.id} className="mh-subcard">
                          <div className="mh-card-top">
                            <div>
                              <strong>
                                {dep.project}@{dep.version}
                              </strong>
                              <div className="mh-muted">
                                主机：{dep.targetHost}
                                {dep.dockerImage ? ` · 镜像：${dep.dockerImage}` : ""}
                              </div>
                            </div>
                            <div className="mh-inline-actions">
                              <span
                                className={`mh-badge ${
                                  dep.status === "deployed"
                                    ? "ok"
                                    : dep.status === "rolled_back"
                                      ? "warn"
                                      : "mid"
                                }`}
                              >
                                {DEPLOY_STATUS_LABELS[dep.status] ?? dep.status}
                              </span>
                              <button
                                type="button"
                                className="mh-primary"
                                disabled={busy}
                                onClick={() => void handleTriggerDeploy(dep.id)}
                              >
                                一键部署
                              </button>
                              <button
                                type="button"
                                className="mh-accent"
                                disabled={busy}
                                onClick={() => void handleRollbackDeploy(dep.id)}
                              >
                                回滚
                              </button>
                              <button
                                type="button"
                                onClick={() => setExpandedDepId(open ? null : dep.id)}
                              >
                                {open ? "隐藏日志" : `日志 (${dep.logs.length})`}
                              </button>
                            </div>
                          </div>
                          {open && (
                            <pre className="mh-code">
                              {dep.logs
                                .map((l) => `[${l.at.slice(11, 19)}] [${l.level.toUpperCase()}] ${l.message}`)
                                .join("\n")}
                            </pre>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== TAB 4: PROVIDERS CONFIG & HEALTH CHECK ==================== */}
      {tab === "providers" && (
        <div className="mh-section mh-stack">
          <div className="mh-panel">
            <div className="mh-panel-head">
              <div>
                <h2>全系统 Provider 健康检查</h2>
                <p className="mh-muted">
                  一键探测 SQLite 底座、LLM、语义向量引擎、OCR、外部 Workflow、支付网关与内容分发通道状态。
                </p>
              </div>
              <button type="button" className="mh-primary" disabled={busy} onClick={() => void handleHealthCheck()}>
                运行健康检查
              </button>
            </div>

            {healthReport ? (
              <div className="mh-health-grid">
                {healthReport.entries.map((entry) => (
                  <div key={entry.id} className={`mh-health-card ${entry.status}`}>
                    <div className="mh-card-top">
                      <strong>
                        <span className={`mh-lamp ${entry.status}`} />
                        {entry.name}
                      </strong>
                      <span
                        className={`mh-badge ${
                          entry.status === "ok"
                            ? "ok"
                            : entry.status === "error"
                              ? "warn"
                              : "mid"
                        }`}
                      >
                        {entry.status === "ok"
                          ? "绿灯在线"
                          : entry.status === "fallback"
                            ? "黄灯降级就绪"
                            : entry.status === "unconfigured"
                              ? "未配置"
                              : "红灯异常"}
                      </span>
                    </div>
                    <p className="mh-muted">{entry.detail}</p>
                    {entry.latencyMs !== null && (
                      <small className="mh-mono">延迟 {entry.latencyMs} ms</small>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mh-muted">点击右上角「运行健康检查」查看实时绿 / 黄 / 红灯诊断报告。</p>
            )}
          </div>

          {providersCfg && (
            <form className="mh-panel mh-form-wide" onSubmit={(e) => void handleSaveProviders(e)}>
              <div className="mh-panel-head">
                <div>
                  <h2>外部 Provider 全局配置中心</h2>
                  <small className="mh-muted">
                    密钥字段已脱敏为 ********；保持不变时提交不会覆盖已保存的真实密钥。最后更新：
                    {providersCfg.updatedAt}
                  </small>
                </div>
                <button type="submit" className="mh-primary" disabled={busy}>
                  保存全部配置
                </button>
              </div>

              <div className="mh-cfg-group">
                <h3>1. 系统运行与商业风控边界</h3>
                <div className="mh-form-row">
                  <label>
                    最大并发 Agent 数
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={providersCfg.system.maxConcurrentAgents}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          system: { ...providersCfg.system, maxConcurrentAgents: Number(e.target.value) || 3 },
                        })
                      }
                    />
                  </label>
                  <label>
                    PM 自动立项阈值 (1-100)
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={providersCfg.system.pmAutoCreateThreshold}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          system: { ...providersCfg.system, pmAutoCreateThreshold: Number(e.target.value) || 85 },
                        })
                      }
                    />
                  </label>
                  <label>
                    连续亏损熔断月数
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={providersCfg.system.lossKillSwitchMonths}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          system: { ...providersCfg.system, lossKillSwitchMonths: Number(e.target.value) || 3 },
                        })
                      }
                    />
                  </label>
                  <label>
                    巡检陈旧天数
                    <input
                      type="number"
                      min={1}
                      max={90}
                      value={providersCfg.system.patrolStaleDays}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          system: { ...providersCfg.system, patrolStaleDays: Number(e.target.value) || 7 },
                        })
                      }
                    />
                  </label>
                </div>
                <div className="mh-form-row">
                  <label>
                    Agent 日志目录
                    <input
                      value={providersCfg.system.agentLogDir}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          system: { ...providersCfg.system, agentLogDir: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    受保护路径（每行一条）
                    <textarea
                      rows={3}
                      value={protectedPathsText}
                      onChange={(e) => setProtectedPathsText(e.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div className="mh-cfg-group">
                <h3>2. 模型引擎（OpenAI 兼容三元组 & Embedding）</h3>
                <div className="mh-form-row">
                  <label>
                    LLM Base URL
                    <input
                      value={providersCfg.models.llm.baseUrl}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            llm: { ...providersCfg.models.llm, baseUrl: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    LLM API Key
                    <input
                      type="password"
                      value={providersCfg.models.llm.apiKey}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            llm: { ...providersCfg.models.llm, apiKey: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    LLM Model Name
                    <input
                      value={providersCfg.models.llm.modelName}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            llm: { ...providersCfg.models.llm, modelName: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Max Tokens
                    <input
                      type="number"
                      min={128}
                      max={32768}
                      value={providersCfg.models.llm.maxTokens}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            llm: { ...providersCfg.models.llm, maxTokens: Number(e.target.value) || 2048 },
                          },
                        })
                      }
                    />
                  </label>
                </div>

                <div className="mh-form-row">
                  <label>
                    Embedding Base URL
                    <input
                      value={providersCfg.models.embedding.baseUrl}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            embedding: { ...providersCfg.models.embedding, baseUrl: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Embedding API Key
                    <input
                      type="password"
                      value={providersCfg.models.embedding.apiKey}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            embedding: { ...providersCfg.models.embedding, apiKey: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Embedding Model
                    <input
                      value={providersCfg.models.embedding.modelName}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            embedding: { ...providersCfg.models.embedding, modelName: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    维度 (Dimensions)
                    <input
                      type="number"
                      min={64}
                      max={4096}
                      value={providersCfg.models.embedding.dimensions}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          models: {
                            ...providersCfg.models,
                            embedding: { ...providersCfg.models.embedding, dimensions: Number(e.target.value) || 256 },
                          },
                        })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="mh-cfg-group">
                <h3>3. OCR、外部采集 Workflow 与内容分发 Webhook</h3>
                <div className="mh-form-row">
                  <label className="mh-check">
                    <input
                      type="checkbox"
                      checked={providersCfg.services.ocr.enabled}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            ocr: { ...providersCfg.services.ocr, enabled: e.target.checked },
                          },
                        })
                      }
                    />
                    启用远端 OCR 服务
                  </label>
                  <label>
                    OCR Endpoint
                    <input
                      value={providersCfg.services.ocr.endpoint}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            ocr: { ...providersCfg.services.ocr, endpoint: e.target.value },
                          },
                        })
                      }
                      placeholder="https://ocr.example.com/recognize"
                    />
                  </label>
                </div>

                <div className="mh-form-row">
                  <label className="mh-check">
                    <input
                      type="checkbox"
                      checked={providersCfg.services.workflow.enabled}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            workflow: { ...providersCfg.services.workflow, enabled: e.target.checked },
                          },
                        })
                      }
                    />
                    启用外部 Workflow (n8n / Webhook)
                  </label>
                  <label>
                    Workflow Webhook Endpoint
                    <input
                      value={providersCfg.services.workflow.endpoint}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            workflow: { ...providersCfg.services.workflow, endpoint: e.target.value },
                          },
                        })
                      }
                      placeholder="https://n8n.example.com/webhook/opc-briefings"
                    />
                  </label>
                  <label>
                    Workflow API Key
                    <input
                      type="password"
                      value={providersCfg.services.workflow.apiKey}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            workflow: { ...providersCfg.services.workflow, apiKey: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                </div>

                <div className="mh-form-row">
                  <label className="mh-check">
                    <input
                      type="checkbox"
                      checked={providersCfg.services.distribution.enabled}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            distribution: { ...providersCfg.services.distribution, enabled: e.target.checked },
                          },
                        })
                      }
                    />
                    启用全渠道分发 Webhook
                  </label>
                  <label>
                    分发 Webhook Endpoint
                    <input
                      value={providersCfg.services.distribution.endpoint}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            distribution: { ...providersCfg.services.distribution, endpoint: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    分发 API Key
                    <input
                      type="password"
                      value={providersCfg.services.distribution.apiKey}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            distribution: { ...providersCfg.services.distribution, apiKey: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    默认分发渠道（逗号分隔）
                    <input
                      value={providerChannelsText}
                      onChange={(e) => setProviderChannelsText(e.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div className="mh-cfg-group">
                <h3>4. 支付网关（国内虎皮椒 & 全球 Stripe / Lemon Squeezy）</h3>
                <div className="mh-form-row">
                  <label className="mh-check">
                    <input
                      type="checkbox"
                      checked={providersCfg.services.payment.domestic.enabled}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              domestic: {
                                ...providersCfg.services.payment.domestic,
                                enabled: e.target.checked,
                              },
                            },
                          },
                        })
                      }
                    />
                    启用虎皮椒收款
                  </label>
                  <label>
                    虎皮椒 AppID
                    <input
                      value={providersCfg.services.payment.domestic.appId}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              domestic: {
                                ...providersCfg.services.payment.domestic,
                                appId: e.target.value,
                              },
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    虎皮椒 AppSecret
                    <input
                      type="password"
                      value={providersCfg.services.payment.domestic.appSecret}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              domestic: {
                                ...providersCfg.services.payment.domestic,
                                appSecret: e.target.value,
                              },
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    回调 Notify URL
                    <input
                      value={providersCfg.services.payment.domestic.notifyUrl}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              domestic: {
                                ...providersCfg.services.payment.domestic,
                                notifyUrl: e.target.value,
                              },
                            },
                          },
                        })
                      }
                    />
                  </label>
                </div>

                <div className="mh-form-row">
                  <label className="mh-check">
                    <input
                      type="checkbox"
                      checked={providersCfg.services.payment.global.enabled}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              global: {
                                ...providersCfg.services.payment.global,
                                enabled: e.target.checked,
                              },
                            },
                          },
                        })
                      }
                    />
                    启用全球支付 MoR
                  </label>
                  <label>
                    全球通道类型
                    <select
                      value={providersCfg.services.payment.global.type}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              global: {
                                ...providersCfg.services.payment.global,
                                type: e.target.value as "stripe" | "lemonsqueezy",
                              },
                            },
                          },
                        })
                      }
                    >
                      <option value="lemonsqueezy">Lemon Squeezy</option>
                      <option value="stripe">Stripe</option>
                    </select>
                  </label>
                  <label>
                    Global API Key
                    <input
                      type="password"
                      value={providersCfg.services.payment.global.apiKey}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              global: {
                                ...providersCfg.services.payment.global,
                                apiKey: e.target.value,
                              },
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Webhook Secret
                    <input
                      type="password"
                      value={providersCfg.services.payment.global.webhookSecret}
                      onChange={(e) =>
                        setProvidersCfg({
                          ...providersCfg,
                          services: {
                            ...providersCfg.services,
                            payment: {
                              ...providersCfg.services.payment,
                              global: {
                                ...providersCfg.services.payment.global,
                                webhookSecret: e.target.value,
                              },
                            },
                          },
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

export default MetabolismHub;
