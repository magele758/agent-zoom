import { DelegationProvider, DelegationDesk } from "./Delegation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutonomyMode, GovernancePolicy } from "../../src/kernel/types";
import type { ZoomMessage } from "../../src/zoom-types";
import { api, request } from "./api";
import { messageViews, taskKey } from "./zoom-view";
import { productStages, type ProductStageId } from "../../src/product-stages";
import { WorkflowBoard } from "./WorkflowBoard";
import { GrowthReport } from "./GrowthReport";
import { ProjectShelf } from "./ProjectShelf";
import { Overview } from "./Overview";
import { DigitalTwin } from "./DigitalTwin";
import { ExecutiveOffice } from "./ExecutiveOffice";
import { FounderMailbox } from "./FounderMailbox";
import { CommercialHub } from "./CommercialHub";
import { SecurityDepartment } from "./SecurityDepartment";
import { OperationsDepartment } from "./OperationsDepartment";
import { ResourceDepartment } from "./ResourceDepartment";
import { ActivityPage, useActivityIndex } from "./ActivityIndex";
import { Opportunities } from "./Opportunities";
import { BusinessLines } from "./BusinessLines";
import { Worklog } from "./Worklog";
import { HomeRoom } from "./HomeRoom";
import { StageDesk } from "./StageDesk";
import { CompanyIdeas } from "./CompanyIdeas";
import { RepositoryCapabilities } from "./RepositoryCapabilities";
import { RepoEvolution } from "./RepoEvolution";
import { KnowledgeCanvas } from "./KnowledgeCanvas";
import { DarkFactory } from "./DarkFactory";
import { TaskPlanning } from "./TaskPlanning";
import { MetabolismHub } from "./MetabolismHub";
import { CompanyHub } from "./CompanyHub";
import { CliLedger } from "./CliLedger";
import { chatRoomLink, companyDepartments, decisionTarget, inboxScope, type DepartmentPage } from "./zoom-routes";
import "./zoom.css";

const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";
const WORKBENCHES_STORAGE_KEY = "opc.sidebar.workbenches.open";
const SPECIALTY_WORKBENCH_ROUTES = new Set([
  "executive",
  "delegations",
  "business-lines",
  "security-department",
  "growth",
  "canvas",
  "metabolism",
  "opportunities",
  "product",
  "stage",
  "capabilities",
  "activity-index",
  "worklog",
]);
const AUTONOMY_META: Record<AutonomyMode, { short: string; hint: string }> = {
  assisted: {
    short: "人工协助",
    hint: "全人工把关：信号入池待筛、暂不自动立项/派工/免审",
  },
  semi_auto: {
    short: "半自动",
    hint: "人挑活与审批，仅后台运维自愈保持自动守护",
  },
  full_auto: {
    short: "全自治",
    hint: "低风险自动放行 + 高分自动立项 + 临期配额自动派活",
  },
};
type ArbitratorModeView = "off" | "advisory" | "delegated_safe" | "full_delegated";
const BOT_MODE_SHORT: Record<ArbitratorModeView, string> = {
  off: "人工拍板",
  advisory: "Bot 研判",
  delegated_safe: "安全代拍",
  full_delegated: "全权托管",
};
const icons = {
  all: "m3 14 3-8h12l3 8v5H3z M3 14h5l2 3h4l2-3h5",
  pending: "M12 3a9 9 0 1 1-.01 0 M12 7v5l3 2",
  folder: "M3.5 7v-2h6l2 2h9v12h-17z",
  back: "m14 6-6 6 6 6",
  channel: "m9 4-2 16 M17 4l-2 16 M4 9h16 M3 15h16",
  board: "M3 5h18v14H3z M9 5v14 M15 5v14",
  growth: "M3 5v15h18 M6 14l4-4 4 2 6-7",
  thread: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v6l3 2",
  menu: "M3 6h18 M3 12h18 M3 18h18",
  shield: "M12 3 4.5 6v6c0 3.5 2.5 6.5 7.5 9 5-2.5 7.5-5.5 7.5-9V6z M8.5 12l2.5 2.5 4.5-5",
  pulse: "M2 12h5l3-7 4 14 3-7h5",
  wallet: "M20 8V5H5a2 2 0 0 0 0 4h16v10H5a2 2 0 0 1-2-2V7 M21 12h-5v4h5",
  twin: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
  executive: "M12 3h0 M9 3h6v4H9z M12 7v4 M5 11h14 M5 11v4 M12 11v4 M19 11v4 M3 15h4v4H3z M10 15h4v4h-4z M17 15h4v4h-4z",
  canvas: "M3 5h8v6H3z M13 5h8v5h-8z M13 13h8v6h-8z M3 14h8v5H3z M11 8h2 M11 16h2",
  metabolism: "M4 6h16 M4 12h10 M4 18h7 M17 11l3 3-3 3 M14 14h6",
  planning: "M4 5h4v14H4z M10 5h4v10h-4z M16 5h4v7h-4z",
  factory: "M3 20h18v-8l-5 3v-3l-5 3v-3l-8 4z M6 11V4h3v5",
  evolution: "M5 6a2.5 2.5 0 1 0 0 .01 M5 18a2.5 2.5 0 1 0 0 .01 M19 12a2.5 2.5 0 1 0 0 .01 M7.4 7.2 16.6 11 M7.4 16.8 16.6 13",
};
function Icon({ name }: { name: keyof typeof icons }) {
  return <svg className="zo-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

function folderEntries(messages: ZoomMessage[], projects: string[]) {
  type Folder = { label: string; path: string; depth: number; count: number; parent: boolean };
  const folders = new Map<string, Folder>();
  function add(folder: string, count: number) {
    let path = "";
    const parts = folder.split("/");
    parts.forEach((label, depth) => {
      path = path ? path + "/" + label : label;
      const entry = folders.get(path) ?? { label, path, depth, count: 0, parent: false };
      entry.count += count;
      entry.parent ||= depth < parts.length - 1;
      folders.set(path, entry);
    });
  }
  for (const path of projects) add(path, 0);
  for (const item of messages) add(item.folder, 1);
  const collator = new Intl.Collator("zh-CN", { numeric: true });
  return Array.from(folders.values()).sort((a, b) => {
    const left = a.path.split("/"), right = b.path.split("/");
    for (let n = 0; n < Math.min(left.length, right.length); n++) {
      const diff = collator.compare(left[n], right[n]);
      if (diff) return diff;
    }
    return left.length - right.length;
  });
}

export function ZoomInbox({ workflowEnabled, workflowId }: {
  workflowEnabled: boolean; workflowId?: string;
}) {
  const [messages, setMessages] = useState<ZoomMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const hash = location.hash;
  const routeName = hash.slice(1).split("?")[0] || "overview";
  const pageParams = new URLSearchParams(hash.split("?")[1]);
  const legacyInbox = inboxScope(hash);
  const [product, setProduct] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [pendingDecisions, setPendingDecisions] = useState(0);
  const [pendingMailboxIssues, setPendingMailboxIssues] = useState<number | null>(null);

  const workflowView = workflowId !== undefined;
  const overviewView = !workflowView && (!hash || routeName === "overview");
  const companyArchView = !workflowView && routeName === "company-architecture";
  const strategyHubView = !workflowView && routeName === "strategy-hub";
  const cliLedgerView = !workflowView && routeName === "cli-ledger";
  const twinView = !workflowView && routeName === "digital-twin";
  const mailboxView = !workflowView && routeName === "mailbox";
  const executiveView = !workflowView && routeName === "executive";
  const activityView = !workflowView && routeName === "activity-index";
  const projectsView = !workflowView && routeName === "projects";
  const productView = !workflowView && routeName === "product";
  const growthView = !workflowView && routeName === "growth";
  const opportunitiesView = !workflowView && routeName === "opportunities";
  const businessView = !workflowView && routeName === "business-lines";
  const capabilitiesView = !workflowView && routeName === "capabilities";
  const repoEvolutionView = !workflowView && routeName === "repo-evolution";
  const ideasView = !workflowView && routeName === "ideas";
  const canvasView = !workflowView && routeName === "canvas";
  const metabolismView = !workflowView && routeName === "metabolism";
  const planningView = !workflowView && routeName === "planning";
  const factoryView = !workflowView && routeName === "dark-factory";
  const worklogView = !workflowView && routeName === "worklog";
  const stageView = !workflowView && routeName === "stage";
  const stageStep = productStages.find(s => s.id === pageParams.get("step"))?.id;
  const stageProduct = pageParams.get("product") ?? "";
  const homeView = !workflowView && (routeName === "home-room" || routeName === "chat" || routeName === "inbox");
  const page = workflowView ? "workflows" : homeView ? "home-room" : routeName;

  const activityIndex = useActivityIndex(overviewView || activityView || twinView);
  const [mobileView, setMobileView] = useState<"list" | "nav">("list");
  const [policy, setPolicy] = useState<GovernancePolicy | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [botMode, setBotMode] = useState<ArbitratorModeView | null>(null);
  const [plannotatorOnline, setPlannotatorOnline] = useState<boolean | null>(null);
  const [plannotatorUrl, setPlannotatorUrl] = useState("http://localhost:53798/");
  const [workbenchesOpen, setWorkbenchesOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(WORKBENCHES_STORAGE_KEY);
      if (saved !== null) return saved === "1";
    } catch { /* ignore storage errors */ }
    return false;
  });

  useEffect(() => {
    if (SPECIALTY_WORKBENCH_ROUTES.has(routeName)) {
      setWorkbenchesOpen(true);
    }
  }, [routeName]);

  useEffect(() => {
    let active = true;
    const loadPolicy = async () => {
      try {
        const res = await request<{ policy: GovernancePolicy }>("/api/opc/kernel/decisions/policy");
        if (active) setPolicy(res.policy);
      } catch { /* ignore transient */ }
    };
    const onPolicyEvent = (event: Event) => {
      const detail = (event as CustomEvent<GovernancePolicy>).detail;
      if (detail) setPolicy(detail);
      else void loadPolicy();
    };
    void loadPolicy();
    window.addEventListener("opc:policy-updated", onPolicyEvent);
    return () => {
      active = false;
      window.removeEventListener("opc:policy-updated", onPolicyEvent);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadAutomationStrip = async () => {
      const [arbRes, planRes] = await Promise.allSettled([
        request<{ policy?: { mode?: ArbitratorModeView; arbitrationMode?: ArbitratorModeView } }>("/api/opc/arbitrator/status"),
        request<{ available?: boolean; health?: { available?: boolean; url?: string | null }; config?: { baseUrl?: string } }>("/api/opc/plannotator/status"),
      ]);
      if (!active) return;
      if (arbRes.status === "fulfilled") {
        const mode = arbRes.value.policy?.arbitrationMode ?? arbRes.value.policy?.mode;
        if (mode) setBotMode(mode);
      }
      if (planRes.status === "fulfilled") {
        const available = planRes.value.available ?? planRes.value.health?.available ?? false;
        setPlannotatorOnline(Boolean(available));
        const url = planRes.value.health?.url ?? planRes.value.config?.baseUrl;
        if (url) setPlannotatorUrl(url);
      }
    };
    const onUpdated = () => void loadAutomationStrip();
    void loadAutomationStrip();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadAutomationStrip();
    }, 30_000);
    window.addEventListener("opc:arbitrator-updated", onUpdated);
    window.addEventListener("opc:plannotator-updated", onUpdated);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("opc:arbitrator-updated", onUpdated);
      window.removeEventListener("opc:plannotator-updated", onUpdated);
    };
  }, []);

  const switchAutonomyMode = async (mode: AutonomyMode) => {
    if (policyBusy || policy?.autonomyMode === mode) return;
    setPolicyBusy(true);
    try {
      const res = await request<{ policy: GovernancePolicy }>("/api/opc/kernel/decisions/policy", {
        method: "PUT",
        body: JSON.stringify({ autonomyMode: mode }),
      });
      setPolicy(res.policy);
      window.dispatchEvent(new CustomEvent("opc:policy-updated", { detail: res.policy }));
    } catch {
      // ignore; user can retry or inspect in Strategy Hub
    } finally {
      setPolicyBusy(false);
    }
  };

  useEffect(() => {
    setMobileView("list");
  }, [hash]);

  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++latest.current;
    try {
      const response = await api.zoomMessages();
      if (generation !== latest.current) return;
      setMessages(response.messages);
      setProjects([...(response.products ?? []), ...(response.projectFolders ?? [])]);
      const counts = response as { pendingDecisions?: number; pendingMailboxIssues?: number };
      setPendingDecisions(Number(counts.pendingDecisions ?? 0));
      if (typeof counts.pendingMailboxIssues === "number") setPendingMailboxIssues(counts.pendingMailboxIssues);
      setReady(true);
      setError("");
    } catch (reason) {
      if (generation !== latest.current) return;
      const failure = reason as { status?: number; code?: string };
      if (failure.status === 404 || failure.code === "html_response") { location.replace("#channels"); return; }
      setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await refresh();
      if (active) timer = setTimeout(() => void poll(), 2500);
    };
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      latest.current++;
    };
  }, [refresh]);

  // Redirect legacy #inbox?message=... or #inbox?stage=... links straight to their native pages.
  useEffect(() => {
    if (routeName !== "inbox") return;
    if (legacyInbox.message) {
      const target = messages.find(item => item.id === legacyInbox.message);
      if (target) {
        location.replace(decisionTarget(target));
        return;
      }
    }
    if (legacyInbox.stage && legacyInbox.stage !== "unfiled") {
      const query = new URLSearchParams({ step: legacyInbox.stage });
      if (legacyInbox.folder) {
        const [p, ...rest] = legacyInbox.folder.split("/");
        if (p) query.set("product", p);
        if (rest.length) query.set("project", rest.join("/"));
      }
      location.replace("#stage?" + query);
    }
  }, [routeName, legacyInbox.message, legacyInbox.stage, legacyInbox.folder, messages]);

  const views = useMemo(() => messageViews(messages), [messages]);
  const mailboxPending = pendingMailboxIssues ?? views.pending.length + pendingDecisions;
  const folders = useMemo(() => folderEntries(views.all, projects), [views.all, projects]);
  const productNames = folders.filter(entry => !entry.depth).map(entry => entry.path);

  const openPage = (target: DepartmentPage | "overview" | "company-architecture" | "strategy-hub" | "cli-ledger" | "digital-twin" | "mailbox" | "executive" | "product" | "growth" | "projects" | "opportunities" | "business-lines" | "worklog" | "home-room" | "ideas" | "canvas" | "metabolism" | "planning" | "dark-factory" | "capabilities" | "repo-evolution" | "activity-index" | "delegations") => {
    setMobileView("list");
    location.hash = target;
  };
  const openNav = <button type="button" className="zo-mobile-menu" aria-label="导航菜单" onClick={() => setMobileView("nav")}><Icon name="menu" /></button>;

  return <DelegationProvider messages={messages} refreshMessages={refresh}><main className="zoom" data-page={page} data-view={mobileView} data-testid="zoom-inbox">
    <aside className="zo-sidebar">
      <div className="zo-brand"><strong lang="en">OPC OS</strong></div>
      <button type="button" className="zo-close-nav" onClick={() => setMobileView("list")}><Icon name="back" />返回</button>
      <div className="zo-sidebar-scroll">
        {policy && (
          <div className="zo-autonomy" role="region" aria-label="自治档位切换">
            <div className="zo-autonomy-head">
              <span>自治档位</span>
              <a href="#strategy-hub?tab=habits">细项 ↗</a>
            </div>
            <div className="zo-autonomy-seg" role="group" aria-label="选择系统自治档位">
              {(["assisted", "semi_auto", "full_auto"] as AutonomyMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-mode={mode}
                  aria-pressed={policy.autonomyMode === mode}
                  disabled={policyBusy}
                  onClick={() => void switchAutonomyMode(mode)}
                >
                  {AUTONOMY_META[mode].short}
                </button>
              ))}
            </div>
            <p className="zo-autonomy-hint">{AUTONOMY_META[policy.autonomyMode].hint}</p>
          </div>
        )}
        {(botMode !== null || plannotatorOnline !== null) && (
          <div className="zo-bot-strip" role="region" aria-label="Bot 代拍板与 Plannotator 状态">
            <div className="zo-bot-strip-head">
              <strong>🤖 Bot 代拍板</strong>
              {botMode && (
                <span className="zo-bot-mode-tag" data-mode={botMode}>
                  {BOT_MODE_SHORT[botMode] ?? botMode}
                </span>
              )}
            </div>
            <div className="zo-bot-strip-row">
              <a
                className="zo-plannotator-pill"
                data-online={plannotatorOnline ? "true" : "false"}
                href={plannotatorUrl}
                target="_blank"
                rel="noreferrer"
                title={plannotatorOnline ? "打开本机 Plannotator Inbox (:53798)" : "Plannotator Inbox 暂未连接"}
              >
                <span className="zo-plannotator-dot" aria-hidden="true" />
                <span>{plannotatorOnline ? "Plannotator :53798" : "Plannotator 离线"}</span>
              </a>
              <button
                type="button"
                className="zo-bot-quick-link"
                onClick={() => openPage("mailbox")}
              >
                审批台 ↗
              </button>
            </div>
          </div>
        )}
        <nav aria-label="主导航" className="zo-views">
          <span className="zo-nav-section" aria-hidden="true">总裁驾驶舱</span>
          <button type="button" aria-label="全局看板" aria-pressed={overviewView} onClick={() => openPage("overview")}><Icon name="board" /><span>全局看板</span></button>
          <button type="button" aria-label="CLI 指令与进度" aria-pressed={cliLedgerView} onClick={() => openPage("cli-ledger")}><Icon name="thread" /><span>CLI 指令与进度</span></button>
          <button type="button" aria-label="公司架构与扩展落位" aria-pressed={companyArchView} onClick={() => openPage("company-architecture")}><Icon name="twin" /><span>来龙去脉与六大部门</span></button>
          <button type="button" aria-label="总裁信箱" aria-pressed={mailboxView} onClick={() => openPage("mailbox")}>
            <Icon name="all" /><span>总裁信箱 · 审批网关</span>{mailboxPending > 0 && <small>{mailboxPending}</small>}
          </button>

          <span className="zo-nav-section" aria-hidden="true">六大公司职能部门</span>
          <button type="button" aria-label="长期主线与习惯记忆" aria-pressed={strategyHubView} onClick={() => openPage("strategy-hub")}><Icon name="executive" /><span>01 · 战略与习惯记忆</span></button>
          <button type="button" aria-label="任务看板与 ROI" aria-pressed={planningView} onClick={() => openPage("planning")}><Icon name="planning" /><span>02 · 情报与产品拆解</span></button>
          <button type="button" aria-label="Agent 暗工厂" aria-pressed={factoryView} onClick={() => openPage("dark-factory")}><Icon name="factory" /><span>03 · 研发暗工厂与上线</span></button>
          <button type="button" aria-label="资源成本部门" aria-pressed={page === "resource-department"} onClick={() => openPage("resource-department")}><Icon name="wallet" /><span>04 · 算力与配额调度</span></button>
          <button type="button" aria-label="运维部门" aria-pressed={page === "operations-department"} onClick={() => openPage("operations-department")}><Icon name="pulse" /><span>05 · 自愈运维与集群</span></button>
          <button type="button" aria-label="商业与治理部" aria-pressed={page === "commercial"} onClick={() => openPage("commercial")}><Icon name="growth" /><span>06 · 商业与总账桥接</span></button>

          <span className="zo-nav-section" aria-hidden="true">高频手操直达</span>
          <button type="button" aria-label="组织数字孪生" aria-pressed={twinView} onClick={() => openPage("digital-twin")}><Icon name="twin" /><span>组织数字孪生</span></button>
          <button type="button" aria-label="开源进化图谱" aria-pressed={repoEvolutionView} onClick={() => openPage("repo-evolution")}><Icon name="evolution" /><span>开源进化图谱</span></button>
          <button type="button" aria-label="Agent Home 群聊与 Bot" aria-pressed={homeView} onClick={() => openPage("home-room")}><Icon name="channel" /><span>Agent Home 群聊</span></button>
          <button type="button" aria-label="信息与想法" aria-pressed={ideasView} onClick={() => openPage("ideas")}><Icon name="all" /><span>信息与想法</span></button>
          <button type="button" aria-label="项目目录" aria-pressed={projectsView} onClick={() => openPage("projects")}><Icon name="folder" /><span>项目目录</span></button>

          <details
            className="zo-nav-details"
            open={workbenchesOpen}
            onToggle={(e) => {
              const nextOpen = (e.currentTarget as HTMLDetailsElement).open;
              setWorkbenchesOpen(nextOpen);
              try {
                localStorage.setItem(WORKBENCHES_STORAGE_KEY, nextOpen ? "1" : "0");
              } catch { /* ignore storage errors */ }
            }}
          >
            <summary className="zo-nav-summary">
              <span>各部门专项工作台</span>
              <span className="zo-nav-summary-meta">
                <span>12</span>
                <span className="zo-nav-chevron" aria-hidden="true">▸</span>
              </span>
            </summary>
            <div className="zo-nav-sublist">
              <button type="button" aria-label="总裁办 Bot 架构" aria-pressed={executiveView} onClick={() => openPage("executive")}><Icon name="executive" /><span>总裁办 · Bot 架构</span></button>
              <button type="button" aria-label="委派台" aria-pressed={page === "delegations"} onClick={() => openPage("delegations")}><Icon name="thread" /><span>委派台</span></button>
              <button type="button" className="zo-product-nav" aria-label="公司业务线" aria-pressed={businessView} onClick={() => openPage("business-lines")}><Icon name="growth" /><span>公司业务线</span></button>
              <button type="button" aria-label="安全部门" aria-pressed={page === "security-department"} onClick={() => openPage("security-department")}><Icon name="shield" /><span>安全评审门禁</span></button>
              <button type="button" aria-label="渠道转化" aria-pressed={growthView} onClick={() => openPage("growth")}><Icon name="growth" /><span>渠道转化</span></button>
              <button type="button" aria-label="无界知识画布" aria-pressed={canvasView} onClick={() => openPage("canvas")}><Icon name="canvas" /><span>无界知识画布</span></button>
              <button type="button" aria-label="信息代谢与商业闭环" aria-pressed={metabolismView} onClick={() => openPage("metabolism")}><Icon name="metabolism" /><span>信息代谢 · 简报</span></button>
              <button type="button" aria-label="研发选题" aria-pressed={opportunitiesView} onClick={() => openPage("opportunities")}><Icon name="thread" /><span>研发选题池</span></button>
              <button type="button" aria-label="产品进程" aria-pressed={productView || stageView} onClick={() => openPage("product")}><Icon name="board" /><span>产品进程</span></button>
              <button type="button" aria-label="开源能力" aria-pressed={capabilitiesView} onClick={() => openPage("capabilities")}><Icon name="folder" /><span>开源能力库</span></button>
              <button type="button" aria-label="会话与仓库索引" aria-pressed={activityView} onClick={() => openPage("activity-index")}><Icon name="thread" /><span>会话与仓库索引</span></button>
              <button type="button" aria-label="工作投入" aria-pressed={worklogView} onClick={() => openPage("worklog")}><Icon name="pending" /><span>个人工作投入</span></button>
            </div>
          </details>
        </nav>
      </div>
      <footer className="zo-sidebar-foot">
        <a href="#channels"><Icon name="channel" />底层调试频道</a>
        {workflowEnabled && <a href="#workflows"><Icon name="board" />旧版工作流看板</a>}
      </footer>
    </aside>

    {workflowView ? <WorkflowBoard id={workflowId} nav={openNav} />
      : companyArchView ? <CompanyHub key={`arch:${pageParams.get("tab") ?? ""}`} nav={openNav} initialTab={(["story", "architecture", "mainlines", "habits"].includes(pageParams.get("tab") ?? "") ? pageParams.get("tab") as "story" | "architecture" | "mainlines" | "habits" : "architecture")} />
      : strategyHubView ? <CompanyHub key={`strat:${pageParams.get("tab") ?? ""}`} nav={openNav} initialTab={(["story", "architecture", "mainlines", "habits"].includes(pageParams.get("tab") ?? "") ? pageParams.get("tab") as "story" | "architecture" | "mainlines" | "habits" : "mainlines")} />
      : cliLedgerView ? <CliLedger nav={openNav} initialSessionId={pageParams.get("session") ?? undefined} initialProvider={pageParams.get("provider") ?? undefined} initialProject={pageParams.get("project") ?? undefined} />
      : page === "commercial" ? <CommercialHub nav={openNav} />
      : page === "security-department" ? <SecurityDepartment key={hash} nav={openNav} />
      : page === "operations-department" ? <OperationsDepartment key={hash} nav={openNav} />
      : page === "resource-department" ? <ResourceDepartment nav={openNav} />
      : page === "delegations" ? <DelegationDesk nav={openNav} />
      : activityView ? <ActivityPage index={activityIndex} params={pageParams} nav={openNav} />
      : opportunitiesView ? <Opportunities nav={openNav} knownProjects={projects} />
      : capabilitiesView ? <RepositoryCapabilities nav={openNav} />
      : repoEvolutionView ? (
          <RepoEvolution
            nav={openNav}
            hashQuery={hash.split("?")[1] ?? ""}
            initialTab={(["graph", "domains", "timeline"].includes(pageParams.get("tab") ?? "") ? pageParams.get("tab") as "graph" | "domains" | "timeline" : undefined)}
            initialLinkId={pageParams.get("link") ?? undefined}
            initialRepo={pageParams.get("repo") ?? undefined}
            initialDomainId={pageParams.get("domain") ?? undefined}
            initialNodeId={pageParams.get("node") ?? undefined}
            initialBucket={pageParams.get("bucket") ?? undefined}
          />
        )
      : ideasView ? <CompanyIdeas nav={openNav} />
      : canvasView ? <KnowledgeCanvas nav={openNav} initialCanvasId={pageParams.get("id") ?? undefined} />
      : metabolismView ? <MetabolismHub nav={openNav} initialTab={(["briefings", "pm", "commercial", "providers"].includes(pageParams.get("tab") ?? "") ? pageParams.get("tab") as "briefings" | "pm" | "commercial" | "providers" : undefined)} />
      : planningView ? <TaskPlanning nav={openNav} initialTab={(["signals", "kanban", "roi", "patrol"].includes(pageParams.get("tab") ?? "") ? pageParams.get("tab") as "signals" | "kanban" | "roi" | "patrol" : undefined)} />
      : factoryView ? <DarkFactory nav={openNav} initialRunId={pageParams.get("run") ?? undefined} />
      : worklogView ? <Worklog key={hash} line={pageParams.get("line") ?? ""} nav={openNav} />
      : businessView ? <BusinessLines nav={openNav} />
      : mailboxView ? <FounderMailbox nav={openNav} messages={messages} onResolved={() => void refresh()} onPendingCountChange={setPendingMailboxIssues} />
      : executiveView ? <ExecutiveOffice nav={openNav} pending={views.pending} />
      : twinView ? <DigitalTwin nav={openNav} messages={views.all} pending={views.pending} handled={views.handled} folders={folders} products={productNames} workflowEnabled={workflowEnabled} activityIndex={activityIndex} />
      : overviewView ? <Overview activityIndex={activityIndex} nav={openNav} products={projects.filter(name => !name.includes("/"))} messages={views.all} pending={views.pending} ready={ready} error={error} onRetry={() => void refresh()} />
      : projectsView ? <ProjectShelf key={hash} initialProduct={pageParams.get("product") ?? ""} nav={openNav}
          onInbox={name => { setMobileView("list"); location.hash = chatRoomLink({ project: name }); }}
          onProgress={name => { setProduct(name); setMobileView("list"); location.hash = "product"; }} />
      : growthView ? <GrowthReport nav={openNav} product={pageParams.get("product") ?? product} onProduct={name => { setProduct(name); location.hash = "growth?" + new URLSearchParams({ product: name }); }} products={productNames} />
      : stageView && stageStep ? <StageDesk key={hash} nav={openNav} step={stageStep} product={stageProduct}
          initialProject={pageParams.get("project") ?? ""} initialItem={pageParams.get("item") ?? ""}
          refBinding={pageParams.get("refBinding") ?? ""} refPost={pageParams.get("refPost") ?? ""} />
      : productView || stageView ? <ProductIndex items={views.all} roots={productNames} product={product} onProduct={setProduct}
          onStage={value => {
            if (value === "unfiled") location.hash = chatRoomLink({ project: product || undefined });
            else location.hash = "stage?" + new URLSearchParams(product ? { step: value, product } : { step: value });
          }} nav={openNav} />
      : <>
          {error && <div role="alert" className="zo-product" style={{ padding: "20px" }}>{error} <button type="button" onClick={() => void refresh()}>重新加载</button></div>}
          {!error && <HomeRoom project={pageParams.get("project") ?? legacyInbox.folder ?? undefined} pending={views.pending} nav={openNav} />}
        </>}
  </main></DelegationProvider>;
}

function ProductIndex({ items, roots, product, onProduct, onStage, nav }: {
  items: ZoomMessage[]; roots: string[]; product: string; onProduct: (name: string) => void;
  onStage: (stage: ProductStageId | "unfiled") => void; nav: React.ReactNode;
}) {
  const options = product && !roots.includes(product) ? [...roots, product] : roots;
  const scoped = items.filter(item => !product || product === item.folder.split("/")[0]);
  const tasks = [...new Map(scoped.map(item => [taskKey(item), item])).values()];
  const sections = [
    { title: "公司方向", stages: productStages.slice(0, 2), company: true },
    { title: "产品定义", stages: productStages.slice(2, 4) },
    { title: "交付与运行", stages: productStages.slice(4, 9) },
    { title: "市场与财务", stages: productStages.slice(9) },
  ];
  const unfiled = tasks.filter(item => !item.stage).length;
  return <section className="zo-product" aria-label="产品进程">
    <header className="zo-product-head">{nav}<h1>产品进程</h1>
      <select aria-label="产品目录" value={product} onChange={event => onProduct(event.target.value)}>
        <option value="">全部产品</option>{options.map(name => <option key={name}>{name}</option>)}
      </select>
    </header>
    <div className="zo-index-body">
      {sections.map(section => <section className={"zo-chapter" + (section.company ? " zo-company-stages" : "")} key={section.title}><h2>{section.title}{section.company && <a href="#ideas">日记、想法与关联产品 ↗</a>}</h2>
        <ol>{section.stages.map(entry => {
          const stageItems = (section.company ? items : scoped).filter(item => item.stage === entry.id);
          const count = new Set(stageItems.map(taskKey)).size;
          const pending = stageItems.filter(item => item.pending).length;
          return <li key={entry.id}><button data-testid={`zoom-stage-${entry.id}`} onClick={() => onStage(entry.id)}>
            <span className="zo-folio">{String(productStages.indexOf(entry) + 1).padStart(2, "0")}</span><strong>{entry.label}</strong>
            <span className="zo-stage-count">{count ? `${count} 项任务` : "暂无任务"}{pending > 0 && <b> · {pending} 待处理</b>}</span>
          </button></li>;
        })}</ol></section>)}
      {unfiled > 0 && <button className="zo-unfiled" onClick={() => onStage("unfiled")}>未标注阶段 · {unfiled} 项任务（在群聊讨论） ↗</button>}
      <a className="zo-unfiled" href="#growth">查看渠道转化 ↗</a>
    </div>
  </section>;
}
