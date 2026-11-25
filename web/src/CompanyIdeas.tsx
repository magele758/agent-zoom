import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Token, Tokens } from "marked";
import type { CompanyIdea, CompanyIndex, CompanyNote, JournalExcerpt } from "../../src/company-types";
import type { OpportunityIndex } from "../../src/autonomy-types";
import type { HomeRoomIdeaRef } from "../../src/home-room-types";
import { DelegateWork } from "./Delegation";
import { api, request } from "./api";
import { chatRoomLink } from "./zoom-routes";
import "./company-ideas.css";

const company = "/api/zoom/company";
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const href = (query: Record<string, string>) => "#ideas?" + new URLSearchParams(query);
const readLocation = () => new URLSearchParams(location.hash.split("?")[1]);
const displayDay = (day: string) => day.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1 年 $2 月 $3 日");
const opportunityLink = (id: string) => "#opportunities?" + new URLSearchParams({ item: id });

type Journal = { day: string; markdown: string; excerpts: JournalExcerpt[]; article: CompanyNote };
type ReadableJournal = Journal & {tokens:Token[] | null};
type Section = { id: string; title: string; depth: number; note?: JournalExcerpt };
type Clip = { id: string; url: string; reviewUrl?: string; duplicate: boolean };
type Learning = {
  available: boolean; canClip?: boolean; homeUrl?: string; reason?: string;
  documents?: { id: string; title: string; kind: string; url: string }[];
  sessions?: { id: string; title: string; url: string; completed: boolean; updatedAt: string }[];
};
type DispatchResult = { opportunityId: string; runId: string | null; status: "plan" | "queue" | "unbound" | "reuse" | "skipped" };
type Draft = { id: string; body: string; source?: CompanyNote };

function httpLink(value: string) {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch { /* Relative source links remain plain text. */ }
  return "";
}

function ExternalLink({ url, children }: { url?: string; children: ReactNode }) {
  const safe = url && httpLink(url);
  return safe ? <a href={safe} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
}

function markdownNodes(tokens: Token[], anchors?: Map<Token, string>): ReactNode[] {
  return tokens.map((token, index) => <Fragment key={index}>{renderToken(token, anchors?.get(token))}</Fragment>);
}

function renderToken(token: Token, anchor?: string): ReactNode {
  const children = () => "tokens" in token && token.tokens ? markdownNodes(token.tokens) : "text" in token ? token.text : "";
  switch (token.type) {
    case "heading": {
      const headings = ["h2", "h3", "h4", "h5", "h6"] as const;
      const Heading = headings[Math.min(token.depth - 1, headings.length - 1)] || "h2";
      return <Heading id={anchor ? "ci-section-" + anchor : undefined} tabIndex={anchor ? -1 : undefined}>{children()}</Heading>;
    }
    case "paragraph": return <p>{children()}</p>;
    case "strong": return <strong>{children()}</strong>;
    case "em": return <em>{children()}</em>;
    case "del": return <del>{children()}</del>;
    case "text": case "escape": return children();
    case "codespan": return <code>{token.text}</code>;
    case "code": return <pre><code>{token.text}</code></pre>;
    case "br": return <br/>;
    case "hr": return <hr/>;
    case "blockquote": return <blockquote>{children()}</blockquote>;
    case "link": return <ExternalLink url={token.href}>{children()}</ExternalLink>;
    case "image": return <ExternalLink url={token.href}>{token.text || "查看原图"} ↗</ExternalLink>;
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item,index) => <li key={index}>{markdownNodes(item.tokens)}</li>);
      return list.ordered ? <ol start={list.start || 1}>{items}</ol> : <ul>{items}</ul>;
    }
    case "checkbox": return <span aria-label={token.checked ? "已完成" : "未完成"}>{token.checked ? "☑ " : "☐ "}</span>;
    case "table": {
      const table = token as Tokens.Table;
      return <div className="ci-table opc-table-scroll" role="region" aria-label="日读表格" tabIndex={0}><table><thead><tr>{table.header.map((cell,index) =>
        <th key={index} scope="col">{markdownNodes(cell.tokens)}</th>)}</tr></thead><tbody>
        {table.rows.map((row,index) => <tr key={index}>{row.map((cell,column) =>
          <td key={column}>{markdownNodes(cell.tokens)}</td>)}</tr>)}</tbody></table></div>;
    }
    case "html": return token.text.trim().startsWith("<!--") ? null : token.text;
    default: return null;
  }
}

function parseJournal(journal: ReadableJournal | null) {
  const tokens = journal?.tokens || [];
  const plain = journal && !journal.tokens ? journal.markdown : "";
  const sections: Section[] = [];
  const anchors = new Map<Token,string>();
  let line = 1;
  for (const token of tokens) {
    if (token.type === "heading") {
      const note = journal?.excerpts.find(excerpt => excerpt.line === line);
      const id = note?.id || "line-" + line;
      anchors.set(token,id);
      sections.push({ id, title: note?.title || token.text, depth: token.depth, note });
    }
    line += (token.raw.match(/\n/g) || []).length;
  }
  return { tokens, sections, anchors, plain };
}

function LearningShelf({ data, status }: { data: Learning | null; status: string }) {
  if (status) return <p className="ci-quiet">{status}</p>;
  if (!data) return <p role="status">正在读取 Learn Agent…</p>;
  if (!data.available) return <p className="ci-quiet">{data.reason || "Learn Agent 暂不可用。"}</p>;
  return <div className="ci-learning-shelf">
    <ExternalLink url={data.homeUrl}>打开 Learn Agent ↗</ExternalLink>
    <h3>最近课堂</h3>
    {data.sessions?.length ? <ul>{data.sessions.map(row => <li key={row.id}>
      <ExternalLink url={row.url}>{row.title}</ExternalLink><small>{row.completed ? "已完成" : "进行中"}</small>
    </li>)}</ul> : <p>暂无课堂。可从日读文章添加学习资料。</p>}
    {Boolean(data.documents?.length) && <><h3>已有资料</h3><ul>
      {data.documents?.map(row => <li key={row.id}><ExternalLink url={row.url}>{row.title}</ExternalLink></li>)}
    </ul></>}
  </div>;
}

function ClipForm({ status, data, day, source, created }: {
  status: string; data: Learning | null; day: string; source: CompanyNote; created: () => void;
}) {
  const [open,setOpen] = useState(false);
  const [question,setQuestion] = useState("");
  const [clip,setClip] = useState<Clip | null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const guard = useRef(false);
  async function start(event: FormEvent) {
    event.preventDefault();
    if (guard.current) return;
    guard.current = true; setBusy(true); setError("");
    try {
      const result = await request<Clip>(company + "/learn/clip",post({
        day, articleId: source.id, ...(question.trim() && {question:question.trim()}),
      }));
      setClip(result); created();
    } catch (error) { setError(describe(error)); }
    finally { guard.current = false; setBusy(false); }
  }
  if (clip) return <div className="ci-lesson-result" role="status">
    {clip.duplicate ? "已在 Learn Agent 资料中。" : "已送到 Learn Agent。"}
    <ExternalLink url={clip.url}>打开学习资料 ↗</ExternalLink>
    {clip.reviewUrl && <ExternalLink url={clip.reviewUrl}>打开学习图谱 ↗</ExternalLink>}
  </div>;
  return <div className="ci-lesson">
    {!open ? <button type="button" onClick={() => setOpen(true)}>用 Learn Agent 学习</button> :
      <form className="ci-lesson-form" onSubmit={event => void start(event)}>
        <p>{source.title}</p>
        {data?.available && data.canClip ? <>
          <label>这次想学什么 <small>选填</small><input value={question} onChange={event => setQuestion(event.target.value)} maxLength={4000} disabled={busy}/></label>
          <button className="ci-main" disabled={busy}>{busy ? "正在送出…" : "送去学习"}</button>
        </> : <p className="ci-quiet">{status || data?.reason || (data ? "当前连接只能查看已有学习记录。" : "正在连接 Learn Agent…")}</p>}
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>收起</button>
        {error && <p role="alert">{error}</p>}
      </form>}
  </div>;
}

function IdeaDetail({ idea, index, candidates, updated }: {
  idea: CompanyIdea; index: CompanyIndex; candidates: OpportunityIndex; updated: () => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [pipeline, setPipeline] = useState<"quick" | "full-product">("quick");
  const [newProduct,setNewProduct] = useState("");
  const [product,setProduct] = useState("");
  const [newProject,setNewProject] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [roomRefs,setRoomRefs] = useState<HomeRoomIdeaRef[]>([]);
  const [lastResult,setLastResult] = useState<DispatchResult | null>(null);
  const guard = useRef(false);
  const links = index.information.filter(note => idea.sources.includes(note.id));
  const referrals = index.referrals.filter(item => item.idea === idea.id);
  const selected = index.projects.find(item => item.product + "/" + item.name === target);
  const latestRun = lastResult && (lastResult.runId || candidates.opportunities.find(item => item.id === lastResult.opportunityId)?.runId);
  const waiting = referrals.some(referral => candidates.opportunities.some(item =>
    item.id === referral.opportunityId && item.state === "queued" && item.dispatchedAt));
  useEffect(() => {
    if (!waiting) return;
    const poll = window.setInterval(() => {if (!document.hidden) void updated().catch(() => {});},5000);
    return () => window.clearInterval(poll);
  },[waiting,updated]);
  useEffect(() => {
    const control = new AbortController();
    request<{ references: HomeRoomIdeaRef[] }>("/api/opc/home-rooms/references?" + new URLSearchParams({ idea: idea.id }), {
      signal: control.signal,
    })
      .then(result => { if (!control.signal.aborted) setRoomRefs(result.references); })
      .catch(() => { if (!control.signal.aborted) setRoomRefs([]); });
    return () => control.abort();
  }, [idea.id]);
  async function act(work: () => Promise<unknown>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError("");
    try { await work(); await updated(); }
    catch (error) { setError(describe(error)); }
    finally { guard.current = false; setBusy(false); }
  }
  async function dispatch(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    await act(async () => {
      setLastResult(await request<DispatchResult>(company + "/ideas/" + idea.id + "/dispatch",
        post({product: selected.product, name: selected.name, ...(pipeline !== "quick" && { pipeline })})));
    });
  }
  const deliveryText: Record<DispatchResult["status"],string> = {
    plan: "计划已创建，等待你确认。",
    queue: "已进入项目研发队列，空出执行位置后起草计划。",
    unbound: "已交给项目。配置项目的执行目录后可以起草计划。",
    reuse: "已交给项目。请先处理相关能力的复用决定。",
    skipped: "这个项目此前已略过此项，可以打开研发记录。",
  };
  return <article className="ci-detail">
    <p className="ci-kicker">已保存的问题</p>
    <h2>想验证什么</h2>
    <p className="ci-reason">{idea.body || idea.title}</p>
    <section className="ci-dispatch"><h3>派给项目研发</h3>
      <form className="ci-fieldrow" onSubmit={event => void dispatch(event)}>
        <label>研发项目<select value={target} onChange={event => {setTarget(event.target.value);setLastResult(null);}}>
          <option value="">{index.projects.length ? "选择项目" : "还没有项目"}</option>
          {index.products.map(name => {
            const projects = index.projects.filter(item => item.product === name);
            return projects.length > 0 && <optgroup key={name} label={name}>{projects.map(item =>
              <option key={item.name} value={name + "/" + item.name}>{name} / {item.name}</option>)}</optgroup>;
          })}
        </select></label>
        <label>流程模式<select value={pipeline} onChange={event => setPipeline(event.target.value as "quick" | "full-product")}>
          <option value="quick">快速编码直发（Coding Agent：实现 → 独立评审）</option>
          <option value="full-product">产研全流程（Coding Agent 调研→PRD→视觉稿→开发→评审 · PM Bot 串联）</option>
        </select></label>
        <button className="ci-main" disabled={!selected || busy}>{busy ? "处理中…" : "发起研发"}</button>
      </form>
      {lastResult && <p role="status">{deliveryText[latestRun ? "plan" : lastResult.status]} <a href={latestRun ?
        "#workflows/" + latestRun : opportunityLink(lastResult.opportunityId)}>{latestRun ? "查看计划" : "查看研发记录"} ↗</a></p>}
      {error && <p role="alert">{error}</p>}
      {Boolean(referrals.length) && <ul className="ci-referrals">{referrals.map(row => {
        const record = candidates.opportunities.find(opportunity => opportunity.id === row.opportunityId);
        const status = record?.runId ? "已进入计划" : record?.state === "skipped" ? "已略过" : "项目研发记录";
        return <li key={row.opportunityId}><strong>{row.product} / {row.name}</strong>
          <a href={record?.runId ? "#workflows/" + record.runId : opportunityLink(row.opportunityId)}>{status} ↗</a>
          <details className="ci-project-links"><summary>项目入口</summary><div>
            <a href={chatRoomLink({ idea: idea.id, project: row.product + "/" + row.name })}>Agent Home 群聊</a>
            <a href={"#stage?" + new URLSearchParams({ step: "prd", product: row.product, project: row.name })}>起草 PRD</a>
          </div></details>
        </li>;
      })}</ul>}
      <details className="ci-project-options"><summary>关联产品或新建项目</summary>
        {!!index.products.length && <form className="ci-fieldrow" onSubmit={event => {
          event.preventDefault();
          if (product && newProject.trim()) void act(async () => {
            await api.createCompanyProject(product,newProject.trim());
            setTarget(product + "/" + newProject.trim()); setNewProject("");
          });
        }}>
          <label>所属产品<select required value={product} onChange={event => setProduct(event.target.value)}>
            <option value="">选择产品</option>{index.products.map(name => <option key={name}>{name}</option>)}
          </select></label>
          <label>新项目名称<input value={newProject} maxLength={100} required onChange={event => setNewProject(event.target.value)}/></label>
          <button disabled={busy || !product || !newProject.trim()}>建立项目</button>
        </form>}
        <form className="ci-fieldrow" onSubmit={event => {
          event.preventDefault();
          if (newProduct.trim()) void act(async () => {
            const name = newProduct.trim();
            await api.createProject(name);
            await request(company + "/ideas/" + idea.id + "/products", post({product: name}));
            setProduct(name);setNewProduct("");
          });
        }}>
          <label>新产品名称<input value={newProduct} maxLength={100} required onChange={event => setNewProduct(event.target.value)}/></label>
          <button disabled={busy || !newProduct.trim()}>新建产品</button>
        </form>
        {!!index.products.filter(name => !idea.products.includes(name)).length && <button disabled={!product || idea.products.includes(product) || busy}
          onClick={() => void act(() => request(company + "/ideas/" + idea.id + "/products",post({product})))}>关联选中产品</button>}
        {idea.products.length > 0 && <p>关联产品 · {idea.products.join("、")}</p>}
      </details>
    </section>
    {links.length > 0 && <section><h3>引用原文</h3>{links.map(note => {
      const day = /daily-review-learning\/(\d{4}-\d{2}-\d{2})\.md/.exec(note.reference)?.[1];
      return <blockquote className="ci-quote" key={note.id}>
        <cite>{day ? <a href={href({day,section:note.id})}>{note.title} ↗</a> : note.title}</cite>
        {note.body && <p>{note.body}</p>}
      </blockquote>;
    })}</section>}
    <div className="ci-detail-links">
      <a href={"#stage?" + new URLSearchParams({step:"idea",item:idea.id})}>让 agent 研究这个想法 ↗</a>
      <a href={"#home-room?" + new URLSearchParams({idea:idea.id})}>到 Agent Home 群聊讨论 ↗</a>
    </div>
    <DelegateWork key={idea.id} label="委派研究这个想法" operation={{key:"idea:"+idea.id,title:idea.title,
      href:href({idea:idea.id}),detail:[idea.body,...links.map(note=>note.title+" "+note.reference)].filter(Boolean).join("\n") || idea.title}}/>
    {roomRefs.length > 0 && <section aria-label="相关项目讨论"><h3>相关项目讨论</h3><ul className="ci-room-refs">{roomRefs.map(ref => <li key={ref.postId}>
      <a href={ref.roomId ? "#home-room?" + new URLSearchParams({room:ref.roomId}) : "#home-room?" + new URLSearchParams({binding:ref.bindingId,post:ref.postId})}>{ref.project} / {ref.roomTitle} · @{ref.botName} ↗</a><p>{ref.excerpt}</p>
    </li>)}</ul></section>}
  </article>;
}

export function CompanyIdeas({ nav }: { nav?: ReactNode }) {
  const [route,setRoute] = useState(readLocation);
  const [index,setIndex] = useState<CompanyIndex | null>(null);
  const [candidates,setCandidates] = useState<OpportunityIndex>({projects:[],opportunities:[]});
  const [days,setDays] = useState<string[] | null>(null);
  const [readDays,setReadDays] = useState<Set<string>>(() => new Set());
  const [readLoaded,setReadLoaded] = useState(false);
  const [unreadOnly,setUnreadOnly] = useState(false);
  const [readBusy,setReadBusy] = useState(false);
  const [journal,setJournal] = useState<ReadableJournal | null>(null);
  const [learning,setLearning] = useState<Learning | null>(null);
  const [draft,setDraft] = useState<Draft | null>(null);
  const [limit,setLimit] = useState(30);
  const [filter,setFilter] = useState("");
  const [error,setError] = useState("");
  const [learnError,setLearnError] = useState("");
  const [journalError,setJournalError] = useState("");
  const [revision,setRevision] = useState(0);
  const [learnRevision,setLearnRevision] = useState(0);
  const [busy,setBusy] = useState(false);
  const [saveError,setSaveError] = useState("");
  const [mobileOpen,setMobileOpen] = useState(() => route.has("day") || route.has("idea"));
  const reader = useRef<HTMLDivElement>(null);
  const contents = useRef<HTMLDetailsElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const saveGuard = useRef(false);
  const manualUnread = useRef<Set<string>>(new Set());
  const previousDay = useRef("");
  const tab = route.has("idea") || route.get("tab") === "saved" ? "saved" : route.get("tab") === "learn" ? "learn" : "journal";
  const activeDay = route.get("day") || days?.[0] || "";
  const sectionId = route.get("section") || route.get("excerpt") || "";
  const {sections,anchors,tokens,plain} = useMemo(() => parseJournal(journal),[journal]);
  const articleBody = useMemo(() => markdownNodes(tokens,anchors),[tokens,anchors]);
  const idea = index?.ideas.find(item => item.id === route.get("idea")) || (!route.has("idea") ? index?.ideas[0] : undefined);
  const section = sections.find(item => item.id === sectionId);
  const source = journal && (journal.excerpts.find(note => note.id === sectionId) || journal.article);
  const dayIndex = days?.indexOf(activeDay) ?? -1;
  const query = filter.trim().toLowerCase();
  const unreadDays = useMemo(() => (days || []).filter(day => !readDays.has(day)), [days, readDays]);
  const unreadCount = unreadDays.length;
  const activeUnread = Boolean(activeDay && readLoaded && !readDays.has(activeDay));
  const visibleDays = (days || []).filter(day =>
    (!query || day.includes(query) || displayDay(day).includes(query)) &&
    (!unreadOnly || !readDays.has(day) || day === activeDay));
  const visibleIdeas = (index?.ideas || []).filter(item => !query || (item.body + item.title).toLowerCase().includes(query));

  const setDayRead = useCallback(async (day: string, read: boolean, manual: boolean) => {
    if (!day) return;
    if (manual) {
      if (!read) manualUnread.current.add(day);
      else manualUnread.current.delete(day);
      setReadBusy(true);
    }
    setReadDays(prev => {
      const next = new Set(prev);
      if (read) next.add(day);
      else next.delete(day);
      return next;
    });
    try {
      const result = await request<{ day: string; read: boolean; readDays: string[] }>(
        company + "/journal/" + encodeURIComponent(day) + "/read",
        { method: "PUT", body: JSON.stringify({ read }) },
      );
      setReadDays(new Set(result.readDays));
    } catch {
      // Keep optimistic state if offline/transient; next refresh reconciles.
    } finally {
      if (manual) setReadBusy(false);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    if (!unreadDays.length || readBusy) return;
    setReadBusy(true);
    const targets = [...unreadDays];
    manualUnread.current.clear();
    setReadDays(prev => {
      const next = new Set(prev);
      for (const day of targets) next.add(day);
      return next;
    });
    try {
      const result = await request<{ readDays: string[] }>(company + "/journal/read-all", post({ days: targets }));
      setReadDays(new Set(result.readDays));
    } finally {
      setReadBusy(false);
    }
  }, [unreadDays, readBusy]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const [data,queue] = await Promise.all([api.companyIndex(signal),api.opportunities(signal)]);
    if (!signal?.aborted) { setIndex(data);setCandidates(queue); }
  },[]);
  useEffect(() => {
    const control = new AbortController();
    setError("");
    reload(control.signal).catch(error => { if (!control.signal.aborted) setError(describe(error)); });
    request<{ available: boolean; days: string[]; readDays?: string[] }>(company + "/journal",{signal:control.signal}).then(result => {
      if (control.signal.aborted) return;
      setDays(result.days);
      setReadDays(new Set(result.readDays ?? []));
      setReadLoaded(true);
      if (!result.available) setJournalError("暂时无法读取本机 daily-review-learning。");
    }).catch(error => { if (!control.signal.aborted) setJournalError(describe(error)); });
    return () => control.abort();
  },[revision]);
  useEffect(() => {
    if (previousDay.current && previousDay.current !== activeDay) {
      manualUnread.current.delete(previousDay.current);
    }
    previousDay.current = activeDay;
  }, [activeDay]);
  useEffect(() => {
    if (tab !== "journal" || !readLoaded || !activeDay || !journal || journal.day !== activeDay) return;
    if (readDays.has(activeDay) || manualUnread.current.has(activeDay)) return;
    const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
    if (narrow && !mobileOpen) return;
    const timer = window.setTimeout(() => {
      if (!document.hidden && !manualUnread.current.has(activeDay)) {
        void setDayRead(activeDay, true, false);
      }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [tab, readLoaded, activeDay, journal, readDays, mobileOpen, setDayRead]);
  useEffect(() => {
    const control = new AbortController();
    if (!activeDay) return;
    setJournal(null);setJournalError("");
    request<Journal>(company + "/journal/" + encodeURIComponent(activeDay),{signal:control.signal})
      .then(async result => {
        let tokens: Token[] | null = null;
        try { tokens = (await import("marked")).marked.lexer(result.markdown); }
        catch { /* Fall back to the complete plain text. */ }
        if (!control.signal.aborted) setJournal({...result,tokens});
      })
      .catch(error => { if (!control.signal.aborted) setJournalError(describe(error)); });
    return () => control.abort();
  },[activeDay,revision]);
  useEffect(() => {
    const control = new AbortController();
    request<Learning>(company + "/learn", {signal:control.signal}).then(result => {
      if (!control.signal.aborted) {setLearning(result);setLearnError("");}
    }).catch(error => {if (!control.signal.aborted) setLearnError(describe(error));});
    return () => control.abort();
  },[learnRevision]);
  useEffect(() => {
    const follow = () => {
      if (!location.hash.startsWith("#ideas")) return;
      const next = readLocation();
      setRoute(next);setMobileOpen(next.has("day") || next.has("idea") || next.get("tab") === "learn");
    };
    window.addEventListener("hashchange",follow);
    return () => window.removeEventListener("hashchange",follow);
  },[]);
  useEffect(() => {
    if (tab !== "journal" || !sectionId || !journal) {reader.current?.scrollTo({top:0});return;}
    const frame = requestAnimationFrame(() => {
      const heading = document.getElementById("ci-section-" + sectionId);
      heading?.scrollIntoView({block:"start"});
    });
    return () => cancelAnimationFrame(frame);
  },[sectionId,journal,tab,idea?.id]);
  useEffect(() => {
    if (draft && tab === "journal") editor.current?.focus();
  },[draft?.id,tab]);
  function switchTab(next: "journal" | "saved" | "learn") {
    setFilter("");
    location.hash = next === "journal" ? "#ideas" : href({tab:next});
  }
  function openDraft(note?: CompanyNote) {
    setMobileOpen(true);setSaveError("");
    if (!draft) setDraft({id:crypto.randomUUID(),body:"",source:note});
    else editor.current?.focus();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft?.body.trim() || saveGuard.current) return;
    saveGuard.current = true;setBusy(true);setSaveError("");
    try {
      if (draft.source) {
        const {id,title,body,reference} = draft.source;
        await request(company + "/information", post({id,title,body,reference}));
      }
      await request(company + "/ideas",post({id:draft.id,body:draft.body.trim(),sources:draft.source ? [draft.source.id] : []}));
      await reload();
      location.hash = href({idea:draft.id});setDraft(null);
    } catch(error) { setSaveError(describe(error)); }
    finally { saveGuard.current = false;setBusy(false); }
  }
  return <section className="zo-product ci-page">
    <header className="zo-product-head ci-head">{nav}<h1>信息与想法</h1></header>
    <div className="ci-layout" data-open={mobileOpen}>
      <aside className="ci-index" aria-label="信息与想法导航">
        <div className="ci-index-tools">
          <nav aria-label="内容分类">
            <button type="button" aria-pressed={tab === "journal"} onClick={() => switchTab("journal")}>日读</button>
            <button type="button" aria-pressed={tab === "saved"} onClick={() => switchTab("saved")}>已保存</button>
            <button type="button" aria-pressed={tab === "learn"} onClick={() => switchTab("learn")}>学习</button>
          </nav>
          {tab !== "learn" && <details className="ci-find"><summary>查找</summary>
            <input type="search" aria-label={tab === "journal" ? "筛选文章日期" : "筛选已保存的问题"} value={filter}
              onChange={event => {setFilter(event.target.value);setLimit(30);}}/>
          </details>}
        </div>
        {tab === "journal" && <>
          <div className="ci-list-head">
            <h2 className="ci-list-heading">文章列表{readLoaded && unreadCount > 0 && <span className="ci-unread-badge">{unreadCount} 未读</span>}</h2>
            {readLoaded && Boolean(days?.length) && <div className="ci-read-filter" role="group" aria-label="文章阅读筛选">
              <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>全部</button>
              <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>未读{unreadCount > 0 ? ` (${unreadCount})` : ""}</button>
              {unreadCount > 0 && <button type="button" className="ci-read-all" disabled={readBusy} onClick={() => void markAllRead()}>全部已读</button>}
            </div>}
          </div>
          {!days && !journalError && <p role="status">正在读取日读…</p>}
          {visibleDays.slice(0,limit).map(day => {
            const unread = readLoaded && !readDays.has(day);
            return <a className="ci-list-item" href={href({day})} key={day}
              data-unread={unread ? "true" : "false"}
              aria-current={day === activeDay ? "page" : undefined}
              onClick={() => setMobileOpen(true)}>
              <span className="ci-day-row">
                {unread && <span className="ci-unread-dot" aria-label="未读" title="未读" />}
                <strong>{displayDay(day)}</strong>
              </span>
              {day === days?.[0] && <small>最近更新</small>}
            </a>;
          })}
          {!!days && !visibleDays.length && <p className="ci-quiet">{query ? "没有匹配日期。" : unreadOnly ? "所有文章都已读完。" : "暂无日读。"}</p>}
          {visibleDays.length > limit && <button type="button" className="ci-more" onClick={() => setLimit(limit+30)}>再看 30 天</button>}
          {!visibleDays.length && !unreadOnly && <button type="button" className="ci-more" onClick={() => openDraft()}>写下想验证的事</button>}
        </>}
        {tab === "saved" && <>
          <h2 className="ci-list-heading">想验证的事</h2>
          {visibleIdeas.map(item => <a className="ci-list-item" href={href({idea:item.id})} key={item.id}
            aria-current={item.id === idea?.id ? "page" : undefined} onClick={() => setMobileOpen(true)}>
            <strong>{item.body || item.title}</strong><small>{item.products.join(" · ") || "待选项目"}</small>
          </a>)}
          {index && !visibleIdeas.length && <p className="ci-quiet">{query ? "没有匹配的问题。" : "还没有保存的问题。"}</p>}
        </>}
        {tab === "learn" && <div className="ci-learning-entry">
          <p className="ci-quiet">{learning?.available ? "Learn Agent 已连接" : "学习资料与课堂"}</p>
          <button type="button" className="ci-more" onClick={() => {setMobileOpen(true);setLearnRevision(n => n+1);}}>打开学习目录</button>
        </div>}
      </aside>
      <div className="ci-reader" ref={reader}>
        <div className="ci-reader-inner">
          <button type="button" className="ci-mobile-back" onClick={() => setMobileOpen(false)}>‹ 返回列表</button>
          {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(n=>n+1)}>重新读取</button></p>}
          {tab === "learn" && <article><h2>Learn Agent</h2>
            <LearningShelf data={learning} status={learnError}/>
            <button type="button" className="ci-more" onClick={() => setLearnRevision(n=>n+1)}>刷新学习目录</button>
          </article>}
          {tab === "saved" && idea && index &&
            <IdeaDetail key={idea.id} idea={idea} index={index} candidates={candidates} updated={reload}/>}
          {tab === "saved" && !idea && index && <p>{route.has("idea") ? "找不到这条已保存的问题。" : "读文章时，可以随时写下想验证的事。"}</p>}
          {tab === "journal" && <>
            {journalError && <p role="alert">{journalError} <button type="button" onClick={() => setRevision(n=>n+1)}>重新读取</button></p>}
            {journal && <div className="ci-article-header">
              <div className="ci-date-nav">
                <p className="ci-kicker">daily-review-learning{activeUnread && <span className="ci-unread-pill">未读</span>}</p>
                {days && dayIndex >= 0 && <nav aria-label="前后日读">
                  {days[dayIndex+1] && <a href={href({day:days[dayIndex+1]})}>‹ 前一天</a>}
                  {dayIndex > 0 && <a href={href({day:days[dayIndex-1]})}>后一天 ›</a>}
                </nav>}
              </div>
              <h2>{displayDay(activeDay)}</h2>
            </div>}
            {journal && <div className="ci-reading-tools">
              <div className="ci-actions">
                <button type="button" className="ci-main" onClick={() => openDraft(source || undefined)}>写下想验证的事</button>
                {readLoaded && activeDay && <button type="button" disabled={readBusy}
                  onClick={() => void setDayRead(activeDay, activeUnread, true)}>
                  {activeUnread ? "标为已读" : "标为未读"}
                </button>}
                {sections.length > 1 && <button type="button" onClick={() => {
                  if (contents.current) {
                    contents.current.open = true;
                    contents.current.querySelector("summary")?.focus({preventScroll:true});
                    contents.current.scrollIntoView({block:"start"});
                  }
                }}>目录</button>}
                {source && <ClipForm key={source.id} day={activeDay} source={source} status={learnError} data={learning}
                  created={() => setLearnRevision(n=>n+1)}/>}
                <a href="#canvas">无界知识画布 ↗</a>
                <a href="#metabolism">简报清洗与 PM 自动立项 ↗</a>
              </div>
              {source && section && <p className="ci-reading-section">本次引用 · {section.title} <a href={href({day:activeDay})}>改用整篇</a></p>}
            </div>}
            {!journal && !journalError && days?.length !== 0 && <p role="status">正在打开文章…</p>}
            {!!draft && <form className="ci-draft" onSubmit={event => void save(event)}>
              <label>想验证什么<textarea ref={editor} rows={4} maxLength={5000} required value={draft.body}
                onChange={event => setDraft({...draft,body:event.target.value})}
                placeholder="例如：把独立测试证据加到发布流程，能减少哪些返工？"/></label>
              {draft.source && <p className="ci-quiet">引用原文 · {draft.source.title} <button type="button" disabled={busy}
                onClick={() => setDraft({...draft,source:undefined})}>移除引用</button></p>}
              {saveError && <p role="alert">{saveError}</p>}
              <div className="ci-actions"><button className="ci-main" disabled={busy || !draft.body.trim()}>
                {busy ? "保存中…" : "保存"}</button>
                <button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button>
              </div>
            </form>}
            {journal && <>
              {sections.length > 1 && <details ref={contents} className="ci-toc"><summary>文章目录</summary>
                <nav aria-label="文章目录">{sections.filter(item => item.depth < 5).map(item =>
                  <a key={item.id} data-depth={item.depth} aria-current={sectionId === item.id ? "location" : undefined}
                    href={href({day:activeDay,section:item.id})}>{item.title}</a>)}</nav>
              </details>}
              <article className="ci-article-body" aria-label="日读全文">
                {articleBody.length > 0 ? articleBody : plain ? <pre className="ci-plain">{plain}</pre> : <p>这一天的日读没有正文。</p>}
              </article>
              {days && dayIndex >= 0 && <nav aria-label="切换日读日期" className="ci-article-nav">
                {days[dayIndex+1] && <a href={href({day:days[dayIndex+1]})}>‹ {displayDay(days[dayIndex+1])}</a>}
                {dayIndex > 0 && <a href={href({day:days[dayIndex-1]})}>{displayDay(days[dayIndex-1])} ›</a>}
              </nav>}
            </>}
          </>}
        </div>
      </div>
    </div>
  </section>;
}
