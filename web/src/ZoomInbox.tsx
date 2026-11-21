import { DelegationProvider, DelegationDesk, MessageDelegate } from "./Delegation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ZoomAction, ZoomMessage } from "../../src/zoom-types";
import type { RepositorySnapshot } from "../../src/project-types";
import type { WorkflowDetail } from "../../src/workflow-types";
import { api } from "./api";
import { messageText, messageViews, taskKey } from "./zoom-view";
import { productStages, type ProductStageId } from "../../src/product-stages";
import { WorkflowBoard, WorkflowMessageContent } from "./WorkflowBoard";
import { GrowthReport } from "./GrowthReport";
import { ProjectShelf } from "./ProjectShelf";
import { Overview } from "./Overview";
import { DigitalTwin } from "./DigitalTwin";
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
import { CapabilityDecision, RepositoryCapabilities } from "./RepositoryCapabilities";
import { LinkedText } from "./InternalLinks";
import { companyDepartments, inboxLink, inboxScope, type DepartmentPage, type InboxFilter } from "./zoom-routes";
import "./zoom.css";

type Draft = { body: string; choice: string };
const kindNames: Record<ZoomMessage["kind"], string> = {
  task: "任务登记", progress: "进展", question: "提问", decision: "决策", completed: "完成", reply: "回复", recovery: "执行异常",
};
const filterNames = { all: "全部消息", pending: "待我处理", handled: "已处理" };
const stamp = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
function date(iso: string, compact = false) {
  const value = new Date(iso);
  return compact && value.toDateString() === new Date().toDateString() ? clock.format(value) : stamp.format(value);
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";
const icons = {
  all: "m3 14 3-8h12l3 8v5H3z M3 14h5l2 3h4l2-3h5",
  pending: "M12 3a9 9 0 1 1-.01 0 M12 7v5l3 2",
  handled: "M20 12a8 8 0 1 1-5-7.4 M8 10.5l3 3 8-8",
  folder: "M3.5 7v-2h6l2 2h9v12h-17z",
  down: "m7 10 5 5 5-5", next: "m9 6 6 6-6 6", back: "m14 6-6 6 6 6",
  channel: "m9 4-2 16 M17 4l-2 16 M4 9h16 M3 15h16",
  board: "M3 5h18v14H3z M9 5v14 M15 5v14",
  growth: "M3 5v15h18 M6 14l4-4 4 2 6-7",
  thread: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v6l3 2",
  send: "m4 12 15-7-5 15-3-6-7-2z M11 14l8-9",
  menu: "M3 6h18 M3 12h18 M3 18h18",
  shield: "M12 3 4.5 6v6c0 3.5 2.5 6.5 7.5 9 5-2.5 7.5-5.5 7.5-9V6z M8.5 12l2.5 2.5 4.5-5",
  pulse: "M2 12h5l3-7 4 14 3-7h5",
  wallet: "M20 8V5H5a2 2 0 0 0 0 4h16v10H5a2 2 0 0 1-2-2V7 M21 12h-5v4h5",
  twin: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
};
function Icon({ name }: { name: keyof typeof icons }) {
  return <svg className="zo-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

const stageName = (id: ProductStageId | "unfiled") => productStages.find(stage => stage.id === id)?.label ?? "未标注阶段";

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

const mailKind = (item: ZoomMessage) => item.capabilityRequest?.revision && item.kind === "question"
  ? "维护需求审批" : item.capabilityRequest?.revision && item.kind === "reply" ? "审批反馈" : kindNames[item.kind];

function PhaseLabel({ item }: { item: ZoomMessage }) {
  if (item.delegation && !item.pending) return <span className="zo-status">{({queued:"待认领",working:"正在办理",approval:"待本人决定",completed:"已交回",reconcile:"待对账"} as const)[item.delegation.status]}</span>;
  return <span className={item.pending ? "zo-status pending" : "zo-status"}>
    {item.pending ? item.capabilityRequest?.revision ? "待审批" : item.kind === "question" ? "待答复" : item.kind === "decision" ? "待确认" : "待处理" : mailKind(item)}
  </span>;
}

export function ZoomInbox({ workflowEnabled, workflowId }: {
  workflowEnabled: boolean; workflowId?: string;
}) {
  const [messages, setMessages] = useState<ZoomMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const hash = location.hash;
  const { filter, folder, stage, message: selected } = inboxScope(hash);
  const [product, setProduct] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const projectsView = hash.split("?")[0] === "#projects";
  const productView = location.hash === "#product";
  const growthView = hash.split("?")[0] === "#growth";
  const overviewView = !hash || hash.split("?")[0] === "#overview";
  const twinView = hash.split("?")[0] === "#digital-twin";
  const activityView = hash.split("?")[0] === "#activity-index";
  const activityIndex = useActivityIndex(overviewView || activityView || twinView);
  const opportunitiesView = hash.split("?")[0] === "#opportunities";
  const businessView = hash.split("?")[0] === "#business-lines";
  const capabilitiesView = hash.split("?")[0] === "#capabilities";
  const ideasView = hash.split("?")[0] === "#ideas";
  const homeView = hash.split("?")[0] === "#home-room";
  const worklogView = hash.split("?")[0] === "#worklog";
  const pageParams = new URLSearchParams(hash.split("?")[1]);
  const stageView = hash.split("?")[0] === "#stage";
  const stageStep = productStages.find(s => s.id === pageParams.get("step"))?.id;
  const stageProduct = pageParams.get("product") ?? "";
  const workflowView = workflowId !== undefined;
  const page = workflowView ? "workflows" : hash.slice(1).split("?")[0] || "overview";
  const inboxView = page === "inbox";
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [mobileView, setMobileView] = useState<"list" | "nav" | "detail">("list");
  useEffect(() => {
    setMobileView(selected ? "detail" : "list");
    setNotice("");
  }, [hash, selected]);
  const drafts = useRef(new Map<string, Draft>());
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

  const views = useMemo(() => messageViews(messages), [messages]);
  const folders = useMemo(() => folderEntries(views.all, projects), [views.all, projects]);
  const productNames = folders.filter(entry => !entry.depth).map(entry => entry.path);
  const rows = views[filter].filter(item =>
    (!folder || item.folder === folder || item.folder.startsWith(folder + "/")) && (!stage || (item.stage ?? "unfiled") === stage));
  // A deep link always targets its exact decision, including during polling and after it is answered.
  const activeItem = selected ? messages.find(item => item.id === selected) : rows[0];
  const activeId = activeItem?.id;
  const groups = [
    { key: "pending", title: "待处理", rows: rows.filter(item => item.pending) },
    { key: "updates", title: filter === "handled" ? "处理记录" : "最近动态", rows: rows.filter(item => !item.pending) },
  ];
  const selectScope = (nextFilter: InboxFilter, nextFolder: string, nextStage: typeof stage = "") => {
    setNotice(""); setMobileView("list");
    location.hash = inboxLink({ filter: nextFilter, folder: nextFolder, stage: nextStage });
  };
  const openMessage = (id: string) => {
    setMobileView("detail"); setNotice("");
    location.hash = inboxLink({ filter, folder, stage, message: id });
  };
  const done = async (message: string) => {
    setNotice(message); await refresh();
    if (filter === "pending") setMobileView("list");
  };

  const openPage = (page: DepartmentPage | "overview" | "digital-twin" | "product" | "growth" | "projects" | "opportunities" | "business-lines" | "worklog" | "home-room" | "ideas" | "capabilities" | "activity-index" | "delegations") => {
    if (inboxView && folder) setProduct(folder.split("/")[0]);
    setMobileView("list"); location.hash = page;
  };
  const openNav = <button type="button" className="zo-mobile-menu" aria-label="筛选与目录" onClick={() => setMobileView("nav")}><Icon name="menu" /></button>;
  return <DelegationProvider messages={messages} refreshMessages={refresh}><main className="zoom" data-page={page} data-view={mobileView} data-testid="zoom-inbox">
    <aside className="zo-sidebar">
      <div className="zo-brand"><strong lang="en">OPC OS</strong></div>
      <button type="button" className="zo-close-nav" onClick={() => setMobileView("list")}><Icon name="back" />返回列表</button>
      <div className="zo-sidebar-scroll">
      <nav aria-label="消息筛选" className="zo-views">
        <span className="zo-nav-section" aria-hidden="true">总控与待办</span>
        <button type="button" aria-label="全局看板" aria-pressed={overviewView} onClick={() => openPage("overview")}><Icon name="board" /><span>全局看板</span></button>
        <button type="button" aria-label="组织数字孪生" aria-pressed={twinView} onClick={() => openPage("digital-twin")}><Icon name="twin" /><span>组织数字孪生</span></button>
        {(Object.keys(filterNames) as InboxFilter[]).map(value => <button type="button" key={value} aria-label={filterNames[value]}
          aria-pressed={inboxView && filter === value && !folder && !stage} onClick={() => selectScope(value, "")}>
          <Icon name={value} /><span>{filterNames[value]}</span><small>{views[value].length}</small>
        </button>)}
        <button type="button" aria-label="委派台" aria-pressed={page==="delegations"} onClick={() => openPage("delegations")}><Icon name="thread" /><span>委派台</span></button>
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
        <button type="button" aria-label="研发选题" aria-pressed={opportunitiesView} onClick={() => openPage("opportunities")}><Icon name="thread" /><span>研发选题</span></button>
        <button type="button" aria-label="项目目录" aria-pressed={projectsView} onClick={() => openPage("projects")}><Icon name="folder" /><span>项目目录</span></button>
        <button type="button" aria-label="产品进程" aria-pressed={productView || stageView} onClick={() => openPage("product")}><Icon name="board" /><span>产品进程</span></button>
        <button type="button" aria-label="开源能力" aria-pressed={capabilitiesView} onClick={() => openPage("capabilities")}><Icon name="folder" /><span>开源能力</span></button>
        <button type="button" aria-label="项目讨论室" aria-pressed={homeView} onClick={() => openPage("home-room")}><Icon name="channel" /><span>项目讨论室</span></button>
        <span className="zo-nav-section" aria-hidden="true">现场与投入</span>
        <button type="button" aria-label="会话与仓库索引" aria-pressed={activityView} onClick={() => openPage("activity-index")}><Icon name="thread" /><span>会话与仓库索引</span></button>
        <button type="button" aria-label="工作投入" aria-pressed={worklogView} onClick={() => openPage("worklog")}><Icon name="pending" /><span>工作投入</span></button>
      </nav>
      <nav aria-label="目录" className="zo-directories">
        <div className="zo-dir-heading"><h2>目录</h2>
          {folder && <button type="button" onClick={() => selectScope("all", "")}>全部目录</button>}
        </div>
        {folders.filter(entry => !collapsed.some(path => entry.path.startsWith(path + "/"))).map(entry =>
          <div key={entry.path} className="zo-dir" data-current={inboxView && folder === entry.path} style={{ paddingInlineStart: Math.min(entry.depth, 6) * 12 }}>
            {entry.parent ? <button type="button" className="zo-dir-toggle" aria-label={`${collapsed.includes(entry.path) ? "展开" : "收起"} ${entry.path}`}
              aria-expanded={!collapsed.includes(entry.path)} onClick={() => setCollapsed(current => current.includes(entry.path)
                ? current.filter(path => path !== entry.path) : [...current, entry.path])}>
              <Icon name={collapsed.includes(entry.path) ? "next" : "down"} /></button> : <span className="zo-dir-indent" />}
            <button className="zo-dir-name" type="button" aria-label={entry.path} aria-current={inboxView && folder === entry.path ? "true" : undefined}
              title={entry.path} onClick={() => selectScope("all", entry.path)}><Icon name="folder" /><span>{entry.label}</span><small>{entry.count}</small></button>
          </div>)}
        {ready && !folders.length && <p className="zo-empty-folders">暂无目录</p>}
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
      : page==="delegations" ? <DelegationDesk nav={openNav}/>
      : activityView ? <ActivityPage index={activityIndex} params={pageParams} nav={openNav} />
      : opportunitiesView ? <Opportunities nav={openNav} knownProjects={projects} />
      : capabilitiesView ? <RepositoryCapabilities nav={openNav} />
      : ideasView ? <CompanyIdeas nav={openNav} />
      : homeView ? <HomeRoom project={pageParams.get("project") ?? undefined} nav={openNav} />
      : worklogView ? <Worklog key={hash} line={pageParams.get("line") ?? ""} nav={openNav} />
      : businessView ? <BusinessLines nav={openNav} />
      : twinView ? <DigitalTwin nav={openNav} messages={views.all} pending={views.pending} handled={views.handled} folders={folders} products={productNames} workflowEnabled={workflowEnabled} activityIndex={activityIndex} />
      : overviewView ? <Overview activityIndex={activityIndex} nav={openNav} products={projects.filter(name => !name.includes("/"))} messages={views.all} pending={views.pending} ready={ready} error={error} onRetry={() => void refresh()} />
      : projectsView ? <ProjectShelf key={hash} initialProduct={pageParams.get("product") ?? ""} nav={openNav} onInbox={name => selectScope("all", name)}
      onProgress={name => { setProduct(name); setMobileView("list"); location.hash = "product"; }} />
      : growthView ? <GrowthReport nav={openNav} product={pageParams.get("product") ?? product} onProduct={name=>{setProduct(name);location.hash="growth?"+new URLSearchParams({product:name});}} products={productNames} />
      : stageView && stageStep ? <StageDesk key={hash} nav={openNav} step={stageStep} product={stageProduct}
          initialProject={pageParams.get("project") ?? ""} initialItem={pageParams.get("item") ?? ""}
          refBinding={pageParams.get("refBinding") ?? ""} refPost={pageParams.get("refPost") ?? ""} />
      : productView || stageView ? <ProductIndex items={views.all} roots={productNames} product={product} onProduct={setProduct}
      onStage={value => {
        if (value === "unfiled") selectScope("all", product, value);
        else location.hash = "stage?" + new URLSearchParams(product ? { step: value, product } : { step: value });
      }} nav={openNav} /> : <>
    <section className="zo-stream" aria-label="消息列表">
      <header className="zo-stream-head">
        {openNav}
        <h1>{stage ? (folder ? folder.split("/").at(-1) + " · " : "") + stageName(stage) : folder ? folder.split("/").at(-1) : filter === "all" ? "消息" : filterNames[filter]}</h1><span>{rows.length}</span>
        {!stage && !folder && <a className="zo-index-back" href="#delegations">委派方式 ↗</a>}
        {stage && (stage === "unfiled" ? <button className="zo-index-back" onClick={() => openPage("product")}>产品进程 ↗</button>
          : <a className="zo-index-back" href={"#stage?" + new URLSearchParams({step:stage,product:folder.split("/")[0] || "",project:folder.split("/")[1] || ""})}>阶段工作单 ↗</a>)}
        {!stage && <time className="zo-today" dateTime={new Date().toLocaleDateString("sv-SE")}>
          {new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}
        </time>}
      </header>
      <div className="zo-list">
        {error && <p role="alert" className="workflow-error">{error} <button onClick={() => void refresh()}>重新加载</button></p>}
        {notice && <p role="status" className="zo-notice">{notice}</p>}
        {!ready && !error && <p role="status" className="zo-empty">正在读取消息…</p>}
        {ready && !rows.length && <div className="zo-empty">{filter === "pending" ? "目前没有需要你处理的消息" : filter === "handled" ? "暂无处理记录" : "暂无任务消息"}{folder && <p><a href={"#projects?" + new URLSearchParams({
          product: folder.split("/")[0], ...(folder.includes("/") ? { project: folder.split("/")[1] } : {})
        })}>打开项目目录 ↗</a></p>}</div>}
        {groups.filter(group => group.rows.length).map(group => <section className="zo-group" key={group.key} aria-label={group.title}>
          <h2>{group.title}<span>{group.rows.length}</span></h2>
          {group.rows.map(item => {
            const text = messageText(item);
            const excerpt = text.title === item.taskTitle ? text.body : item.taskTitle;
            return <button type="button" className="zo-preview" data-testid={`zoom-message-${item.id}`} key={item.id}
            aria-current={activeId === item.id ? "true" : undefined} aria-controls="zoom-reader"
            onClick={() => openMessage(item.id)}>
            <span className="zo-row-meta"><strong>{item.source}</strong><time dateTime={item.at}>{date(item.at, true)}</time></span>
            <span className="zo-subject">{text.title}</span>
            <span className="zo-path"><span>{mailKind(item)}</span> · {item.folder.split("/").join(" / ")}</span>
            {excerpt && <span className="zo-sr">{excerpt}</span>}
          </button>;
          })}
        </section>)}
      </div>
    </section>

    <section id="zoom-reader" className="zo-reader" aria-label="消息详情">
      <header className="zo-reader-bar">
        <button type="button" className="zo-back" onClick={() => setMobileView("list")}><Icon name="back" />返回列表</button>
        {activeItem && <span title={activeItem.folder}>{activeItem.folder.split("/").join("　/　")}{activeItem.stage && "　/　" + stageName(activeItem.stage)}</span>}
        {activeItem && <div className="zo-stepper">{([-1, 1] as const).map(direction => {
          const next = rows[rows.findIndex(item => item.id === activeItem.id) + direction];
          return <button key={direction} aria-label={direction < 0 ? "上一条消息" : "下一条消息"} disabled={!next}
            onClick={() => { if (next) openMessage(next.id); }}><Icon name={direction < 0 ? "back" : "next"} /></button>;
        })}</div>}
      </header>
      {activeItem ? <MessageDetail key={activeItem.id} item={activeItem} drafts={drafts.current}
        thread={messages.filter(other => other.origin === activeItem.origin && other.taskId === activeItem.taskId)}
        onChanged={done} /> : ready && <div className="zo-reader-empty"><Icon name="all" />
          <p>{selected ? "正在核对指定消息，可从左侧选择其他事项。" : messages.length ? "当前列表没有消息" : "等待第一条任务消息"}</p>
          {!messages.length && <small>Agent 登记任务后，可以在这里查看进展和回复提问。</small>}
        </div>}
    </section></>}
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
      {unfiled > 0 && <button className="zo-unfiled" onClick={() => onStage("unfiled")}>未标注阶段 · {unfiled} 项任务 ↗</button>}
      <a className="zo-unfiled" href="#growth">查看渠道转化 ↗</a>
    </div>
  </section>;
}

function RepositorySources({ repo }: { repo: RepositorySnapshot }) {
  return <div className="zo-repo-sources">
    <p><a href={repo.url} target="_blank" rel="noreferrer">{repo.fullName} ↗</a>
      {repo.latestRelease && <> · <a href={repo.latestRelease.url} target="_blank" rel="noreferrer">{repo.latestRelease.tag}</a></>}</p>
    {repo.items.length > 0 && <ul aria-label="最近的未关闭事项">{repo.items.map(change => <li key={change.url}>
      <a href={change.url} target="_blank" rel="noreferrer">{change.title}</a>
      <small>{change.kind === "pull" ? "PR" : "Issue"} · {repo.fullName}#{change.number}</small>
    </li>)}</ul>}
  </div>;
}

function MessageDetail({ item, thread, drafts, onChanged }: {
  item: ZoomMessage; thread: ZoomMessage[]; drafts: Map<string, Draft>; onChanged: (note: string) => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [inspected, setInspected] = useState("");
  const history = thread.filter(other => other.id !== item.id).sort((a, b) => b.at.localeCompare(a.at));
  const original = item.replyTo && thread.find(other => other.id === item.replyTo);
  const action = item.pending ? item.action : undefined;
  const actor = item.actor || item.source;
  const text = messageText(item);
  return <div className="zo-paper">
    <div className="zo-letterhead"><div className="zo-byline"><b>{actor}</b>{actor !== item.source && <span> · {item.source}</span>}
      <time dateTime={item.at}>{date(item.at)}</time></div><PhaseLabel item={item} /></div>
    <h2>{text.title}</h2>
    {(text.title !== item.taskTitle || item.context) && <p className="zo-context">
      <span>原任务</span>{[text.title !== item.taskTitle && item.taskTitle, item.context].filter(Boolean).join(" · ")}
    </p>}
    {item.capabilityRequest && <a className="zo-record-link" href={"#capabilities?" + new URLSearchParams({request:item.capabilityRequest.id})}>返回能力需求与版本记录 <Icon name="next" /></a>}
    <section aria-label="消息内容" className="zo-content">
      {original && <blockquote><LinkedText text={original.body} /></blockquote>}
      {text.body && <p className="zo-body"><LinkedText text={text.body} /></p>}
      {item.repository && <RepositorySources repo={item.repository} />}
      {item.choice && item.choice !== item.body && <p>选择 · {item.choice}</p>}
      <MessageDelegate messageId={item.id}/>
      {action?.kind === "reply" && item.capabilityRequest?.revision
        ? <CapabilityDecision requestId={item.capabilityRequest.id} revision={item.capabilityRequest.revision} questionId={item.id} onChanged={onChanged}/>
        : (action?.kind === "reply" || action?.kind === "channel-reply") &&
        <ReplyForm item={item} action={action} drafts={drafts} onChanged={onChanged} />}
      {item.origin === "workflow" && <WorkflowDetails message={item} threadLength={thread.length} onChanged={onChanged} />}
    </section>
    <section className="zo-history" aria-label="任务历史">
      <header><h3><Icon name="thread" />{item.origin === "repository" ? "维护历史" : "任务历史"}</h3><span>{history.length}</span></header>
      {history.length ? <ol>{(showAll ? history : history.slice(0, 3)).map(other =>
        <li key={other.id}><div><strong>{other.actor || other.source}</strong><span>{mailKind(other)}</span><time dateTime={other.at}>{date(other.at, true)}</time></div>
          {other.choice && other.choice !== other.body && <p>{other.choice}</p>}<p>{other.body || other.taskTitle}</p>
          {other.repository && <details><summary>查看当时的仓库记录</summary><RepositorySources repo={other.repository} /></details>}
          {other.origin === "workflow" && (other.kind === "decision" || other.attemptId) && <>
            <button className="zo-history-evidence" type="button" aria-expanded={inspected === other.id}
              onClick={() => setInspected(value => value === other.id ? "" : other.id)}>
              {inspected === other.id ? "收起记录" : other.attemptId ? "查看执行证据" : `查看计划 r${other.revision}`}
            </button>
            {inspected === other.id && <WorkflowDetails message={{ ...other, pending: false }} threadLength={thread.length} onChanged={onChanged} />}
          </>}
        </li>)}</ol> : <p className="zo-empty-history">{item.origin === "repository" ? "这是该仓库的首份维护记录。" : "这是原任务的第一条消息。"}</p>}
      {history.length > 3 && <button type="button" className="zo-text-action" onClick={() => setShowAll(!showAll)}>{showAll ? "收起历史" : `查看全部 ${history.length} 条记录`}</button>}
    </section>
    {item.businessTrial && <a className="zo-record-link" href={"#business-lines?" + new URLSearchParams({line:item.businessTrial.lineId,trial:item.businessTrial.trialId})}>返回经营实验 <Icon name="next" /></a>}
    {item.roomBinding && <a className="zo-record-link" href={"#home-room?" + new URLSearchParams({binding: item.roomBinding})}>打开原讨论 <Icon name="next" /></a>}
    {item.origin === "workflow" && !item.readOnly && <a className="zo-record-link" href={`#workflows/${item.taskId}`}>完整计划与执行记录 <Icon name="next" /></a>}
  </div>;
}

function ReplyForm({ item, action, drafts, onChanged }: {
  item: ZoomMessage; action: Extract<ZoomAction, { kind: "reply" | "channel-reply" }>; drafts: Map<string, Draft>;
  onChanged: (note: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => drafts.get(item.id) ?? { body: "", choice: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const edit = (change: Partial<Draft>) => {
    const updated = { ...draft, ...change };
    drafts.set(item.id, updated); setDraft(updated);
  };
  const reply = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.body.trim(), choice = draft.choice || undefined;
    if (busy || (!body && !choice)) return;
    setBusy(true); setError("");
    try {
      let delivery = "已保存到原任务，发起者可以取回反馈";
      if (action.kind === "channel-reply") {
        await api.post(action.roomId, { kind: "chat", body, replyTo: action.messageId });
        delivery = "回复已发到原频道";
      } else {
        const receipt = await api.zoomReply(item.taskId, { questionId: item.id, body: body || undefined, choice });
        if (item.businessTrial) delivery = "决定已写回原经营实验";
        if (item.roomBinding) delivery = receipt.state === "received" ? "回复已送达 Agent Home 的原讨论" : "答复已保存，打开原讨论核对送达状态";
      }
      drafts.delete(item.id);
      await onChanged(delivery);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return <form className="zo-reply" onSubmit={reply}>
    {item.choices && <fieldset><legend>可选答复</legend>
      {item.choices.map(value => <label key={value}><input type="radio" name="choice" value={value} checked={draft.choice === value}
        onChange={() => edit({ choice: value })} /><span>{value}</span></label>)}</fieldset>}
    <label className="zo-reply-label">回复原任务<textarea value={draft.body} rows={2} maxLength={16000}
      onChange={event => edit({ body: event.target.value })} placeholder={item.choices ? "补充说明，或直接写下你的答复…" : "写下你的答复…"} /></label>
    <p className="zo-delivery">{item.businessTrial ? "决定和补充说明将写回本轮经营实验。" : item.roomBinding ? "回复会送到已绑定的 Agent Home 房间。" : action.kind === "channel-reply" ? "回复会写入原频道的这条消息下。" : "回复保存在原任务中，发起者通过 CLI 取回后继续处理。"}</p>
    <div className="zo-reply-actions"><button type="submit" disabled={busy || (!draft.body.trim() && !draft.choice)}><Icon name="send" />发送回复</button></div>
    {error && <p role="alert" className="workflow-error">{error}</p>}
  </form>;
}

function WorkflowDetails({ message, threadLength, onChanged }: {
  message: ZoomMessage; threadLength: number; onChanged: (note: string) => Promise<void>;
}) {
  const [run, setRun] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const id = message.taskId;
  useEffect(() => {
    let active = true;
    api.workflow(id).then(result => { if (active) { setRun(result); setError(""); } })
      .catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [id, threadLength, message.pending, message.readOnly, reload]);
  if (error) return <p role="alert" className="workflow-error">{error} <button onClick={() => setReload(value => value + 1)}>重新加载</button></p>;
  if (!run) return <p role="status">正在读取计划与证据…</p>;
  return <WorkflowMessageContent run={run} message={message} onChanged={updated => {
    setRun(updated); void onChanged("决定已保存到原任务");
  }} />;
}
