import { DelegationProvider, DelegationDesk } from "./Delegation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZoomMessage } from "../../src/zoom-types";
import { api } from "./api";
import { messageViews, taskKey } from "./zoom-view";
import { productStages, type ProductStageId } from "../../src/product-stages";
import { WorkflowBoard } from "./WorkflowBoard";
import { GrowthReport } from "./GrowthReport";
import { ProjectShelf } from "./ProjectShelf";
import { Overview } from "./Overview";
import { DigitalTwin } from "./DigitalTwin";
import { ExecutiveOffice } from "./ExecutiveOffice";
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
import { KnowledgeCanvas } from "./KnowledgeCanvas";
import { DarkFactory } from "./DarkFactory";
import { TaskPlanning } from "./TaskPlanning";
import { MetabolismHub } from "./MetabolismHub";
import { chatRoomLink, companyDepartments, decisionTarget, inboxScope, type DepartmentPage } from "./zoom-routes";
import "./zoom.css";

const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";
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

  const workflowView = workflowId !== undefined;
  const overviewView = !workflowView && (!hash || routeName === "overview");
  const twinView = !workflowView && routeName === "digital-twin";
  const executiveView = !workflowView && routeName === "executive";
  const activityView = !workflowView && routeName === "activity-index";
  const projectsView = !workflowView && routeName === "projects";
  const productView = !workflowView && routeName === "product";
  const growthView = !workflowView && routeName === "growth";
  const opportunitiesView = !workflowView && routeName === "opportunities";
  const businessView = !workflowView && routeName === "business-lines";
  const capabilitiesView = !workflowView && routeName === "capabilities";
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
  const folders = useMemo(() => folderEntries(views.all, projects), [views.all, projects]);
  const productNames = folders.filter(entry => !entry.depth).map(entry => entry.path);

  const openPage = (target: DepartmentPage | "overview" | "digital-twin" | "executive" | "product" | "growth" | "projects" | "opportunities" | "business-lines" | "worklog" | "home-room" | "ideas" | "canvas" | "metabolism" | "planning" | "dark-factory" | "capabilities" | "activity-index" | "delegations") => {
    setMobileView("list");
    location.hash = target;
  };
  const openNav = <button type="button" className="zo-mobile-menu" aria-label="导航菜单" onClick={() => setMobileView("nav")}><Icon name="menu" /></button>;

  return <DelegationProvider messages={messages} refreshMessages={refresh}><main className="zoom" data-page={page} data-view={mobileView} data-testid="zoom-inbox">
    <aside className="zo-sidebar">
      <div className="zo-brand"><strong lang="en">OPC OS</strong></div>
      <button type="button" className="zo-close-nav" onClick={() => setMobileView("list")}><Icon name="back" />返回</button>
      <div className="zo-sidebar-scroll">
        <nav aria-label="主导航" className="zo-views">
          <span className="zo-nav-section" aria-hidden="true">总控与群聊</span>
          <button type="button" aria-label="全局看板" aria-pressed={overviewView} onClick={() => openPage("overview")}><Icon name="board" /><span>全局看板</span></button>
          <button type="button" aria-label="组织数字孪生" aria-pressed={twinView} onClick={() => openPage("digital-twin")}><Icon name="twin" /><span>组织数字孪生</span></button>
          <button type="button" aria-label="总裁办 Bot 架构" aria-pressed={executiveView} onClick={() => openPage("executive")}><Icon name="executive" /><span>总裁办 · Bot 架构</span></button>
          <button type="button" aria-label="Agent Home 群聊" aria-pressed={homeView} onClick={() => openPage("home-room")}>
            <Icon name="channel" /><span>Agent Home 群聊</span>{views.pending.length > 0 && <small>{views.pending.length}</small>}
          </button>
          <button type="button" aria-label="委派台" aria-pressed={page === "delegations"} onClick={() => openPage("delegations")}><Icon name="thread" /><span>委派台</span></button>

          <span className="zo-nav-section" aria-hidden="true">经营与公司部门</span>
          <button type="button" className="zo-product-nav" aria-label="公司业务线" aria-pressed={businessView} onClick={() => openPage("business-lines")}><Icon name="growth" /><span>公司业务线</span></button>
          {companyDepartments.map(department =>
            <button type="button" key={department.page} aria-label={department.name} aria-pressed={page === department.page} onClick={() => openPage(department.page)}>
              <Icon name={department.icon} /><span>{department.name}</span>
            </button>
          )}
          <button type="button" aria-label="渠道转化" aria-pressed={growthView} onClick={() => openPage("growth")}><Icon name="growth" /><span>渠道转化</span></button>

          <span className="zo-nav-section" aria-hidden="true">产研与资产复用</span>
          <button type="button" aria-label="信息与想法" aria-pressed={ideasView} onClick={() => openPage("ideas")}><Icon name="all" /><span>信息与想法</span></button>
          <button type="button" aria-label="无界知识画布" aria-pressed={canvasView} onClick={() => openPage("canvas")}><Icon name="canvas" /><span>无界知识画布</span></button>
          <button type="button" aria-label="信息代谢与商业闭环" aria-pressed={metabolismView} onClick={() => openPage("metabolism")}><Icon name="metabolism" /><span>信息代谢 · PM</span></button>
          <button type="button" aria-label="任务看板与 ROI" aria-pressed={planningView} onClick={() => openPage("planning")}><Icon name="planning" /><span>任务看板 · ROI</span></button>
          <button type="button" aria-label="Agent 暗工厂" aria-pressed={factoryView} onClick={() => openPage("dark-factory")}><Icon name="factory" /><span>Agent 暗工厂</span></button>
          <button type="button" aria-label="研发选题" aria-pressed={opportunitiesView} onClick={() => openPage("opportunities")}><Icon name="thread" /><span>研发选题</span></button>
          <button type="button" aria-label="项目目录" aria-pressed={projectsView} onClick={() => openPage("projects")}><Icon name="folder" /><span>项目目录</span></button>
          <button type="button" aria-label="产品进程" aria-pressed={productView || stageView} onClick={() => openPage("product")}><Icon name="board" /><span>产品进程</span></button>
          <button type="button" aria-label="开源能力" aria-pressed={capabilitiesView} onClick={() => openPage("capabilities")}><Icon name="folder" /><span>开源能力</span></button>

          <span className="zo-nav-section" aria-hidden="true">现场与投入</span>
          <button type="button" aria-label="会话与仓库索引" aria-pressed={activityView} onClick={() => openPage("activity-index")}><Icon name="thread" /><span>会话与仓库索引</span></button>
          <button type="button" aria-label="工作投入" aria-pressed={worklogView} onClick={() => openPage("worklog")}><Icon name="pending" /><span>工作投入</span></button>
        </nav>
      </div>
      <footer className="zo-sidebar-foot">
        <a href="#channels"><Icon name="channel" />频道</a>
        {workflowEnabled && <a href="#workflows"><Icon name="board" />工作流看板</a>}
      </footer>
    </aside>

    {workflowView ? <WorkflowBoard id={workflowId} nav={openNav} />
      : page === "commercial" ? <CommercialHub nav={openNav} />
      : page === "security-department" ? <SecurityDepartment key={hash} nav={openNav} />
      : page === "operations-department" ? <OperationsDepartment key={hash} nav={openNav} />
      : page === "resource-department" ? <ResourceDepartment nav={openNav} />
      : page === "delegations" ? <DelegationDesk nav={openNav} />
      : activityView ? <ActivityPage index={activityIndex} params={pageParams} nav={openNav} />
      : opportunitiesView ? <Opportunities nav={openNav} knownProjects={projects} />
      : capabilitiesView ? <RepositoryCapabilities nav={openNav} />
      : ideasView ? <CompanyIdeas nav={openNav} />
      : canvasView ? <KnowledgeCanvas nav={openNav} initialCanvasId={pageParams.get("id") ?? undefined} />
      : metabolismView ? <MetabolismHub nav={openNav} initialTab={(["briefings", "pm", "commercial", "providers"].includes(pageParams.get("tab") ?? "") ? pageParams.get("tab") as "briefings" | "pm" | "commercial" | "providers" : undefined)} />
      : planningView ? <TaskPlanning nav={openNav} initialTab={(["kanban", "roi", "patrol"].includes(pageParams.get("tab") ?? "") ? pageParams.get("tab") as "kanban" | "roi" | "patrol" : undefined)} />
      : factoryView ? <DarkFactory nav={openNav} initialRunId={pageParams.get("run") ?? undefined} />
      : worklogView ? <Worklog key={hash} line={pageParams.get("line") ?? ""} nav={openNav} />
      : businessView ? <BusinessLines nav={openNav} />
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
