import { DelegateWork } from "./Delegation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Opportunity, OpportunityProject } from "../../src/autonomy-types";
import type { CapabilityIndex, RepoCapability } from "../../src/repo-capabilities-types";
import { api, request, type OpportunityDraft, type OpportunityIndex } from "./api";
import "./opportunities.css";

const kinds = { feature: "吸收新特性", issue: "项目问题", upgrade: "升级维护", growth: "增长特性" };
const states = { queued: "待选", selected: "已选入计划", skipped: "已跳过" };
const ratings = { impact: "影响", confidence: "把握", effort: "投入" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "请求失败";
const link = (project: string, id?: string) => {
  const query = new URLSearchParams();
  if (project) query.set("project", project);
  if (id) query.set("item", id);
  return "#opportunities" + (query.size ? "?" + query : "");
};

function Source({ text }: { text: string }) {
  if (/^#ideas\?idea=[\da-f-]{36}$/i.test(text)) return <a href={text}>回到来源想法 ↗</a>;
  if (/^#capabilities\?request=[\da-f-]{36}$/i.test(text)) return <a href={text}>回到原能力需求 ↗</a>;
  if (text.startsWith("#business-lines?")) return <a href={text}>回到提出特性的经营实验 ↗</a>;
  if (/^https?:\/\//i.test(text)) return <a href={text} target="_blank" rel="noreferrer">{text} ↗</a>;
  return <span>{text}</span>;
}

function LeadForm({ project, projects, busy, onSave, onCancel }: {
  project: string; projects: string[]; busy: boolean;
  onSave: (draft: OpportunityDraft) => void; onCancel: () => void;
}) {
  const [available, setAvailable] = useState<RepoCapability[]>([]);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request<CapabilityIndex>("/api/opc/capabilities", {signal:controller.signal})
      .then(c => {if(!controller.signal.aborted)setAvailable(c.capabilities);})
      .catch(e => {if(!controller.signal.aborted)setCatalogError(errorMessage(e));});
    return () => controller.abort();
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    const capabilityRefs=data.getAll("capabilityRefs").map(String);
    onSave({
      ...(capabilityRefs.length ? {capabilityRefs} : {}),
      project: field("project"), title: field("title"), kind: field("kind") as Opportunity["kind"],
      sourceId: field("sourceId"), rationale: field("rationale"),
      evidence: field("evidence").split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      impact: Number(field("impact")), confidence: Number(field("confidence")), effort: Number(field("effort")),
    });
  }
  return <form className="opc-lead-form" aria-label="记录研发线索" onSubmit={submit}>
    <header><h2>记录研发线索</h2><button type="button" onClick={onCancel} disabled={busy}>收起</button></header>
    <fieldset disabled={busy}>
      <div className="opc-form-pair">
        <label>研发项目<input autoFocus={!project} name="project" list="opc-projects" defaultValue={project} required maxLength={256} placeholder="选择或输入项目名" /></label>
        <datalist id="opc-projects">{projects.map(name => <option key={name} value={name} />)}</datalist>
        <label>类型<select name="kind">{Object.entries(kinds).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      </div>
      <label>希望解决什么问题<input autoFocus={Boolean(project)} name="title" placeholder="例如：修复上架时漏检必填字段" required maxLength={200} /></label>
      <label>为什么值得做<textarea name="rationale" required maxLength={1000} rows={2} placeholder="谁会受益？预计改善什么？" /></label>
      <label>来源标识<input name="sourceId" required maxLength={360} placeholder="Issue 链接、日记条目或原系统的固定编号" /></label>
      <label>依据（最多 8 条，每行最多 360 字）<textarea name="evidence" required rows={2} placeholder="复现步骤、使用反馈或证据链接" /></label>
      {available.length > 0 && <details className="opc-pick-refs"><summary>引用已有能力版本（可选）</summary>
        <p>勾选后，选题会先核对复用或原仓补充需求。</p>{available.map(cap=><label key={cap.id}>
          <input type="checkbox" name="capabilityRefs" value={cap.id}/>{cap.repo} · {cap.name} · {cap.version}</label>)}</details>}
      {catalogError && <p role="status">能力目录暂时无法读取。{catalogError}</p>}
      <div className="opc-ratings">{(Object.keys(ratings) as (keyof typeof ratings)[]).map(key =>
        <label key={key}>{ratings[key]}<select name={key} defaultValue={3}>{[1,2,3,4,5].map(n =>
          <option value={n} key={n}>{n}{n === 1 ? " · 低" : n === 5 ? " · 高" : ""}</option>)}</select></label>)}</div>
      <button className="opc-primary" type="submit">保存线索</button>
    </fieldset>
  </form>;
}

function LeadDetail({ item, busy, onSkip }: { item: Opportunity; busy: boolean; onSkip: () => void }) {
  return <article className="opc-detail" aria-label="线索详情">
    <p className="opc-meta">{item.project}　/　{kinds[item.kind]}</p>
    <h2>{item.title}</h2>
    {item.state==="queued" && <DelegateWork key={item.id} label="委派评估此候选" operation={{key:"opportunity:"+item.id,requiresApproval:true,title:"评估研发候选 · "+item.title,href:link(item.project,item.id),detail:[item.project,item.rationale,item.reason,...item.evidence].filter(Boolean).join("\n")}}/>}
    <dl className="opc-decision">
      <div><dt>判断依据</dt><dd>{item.rationale}</dd></div>
      <div><dt>排序理由</dt><dd>{item.reason}</dd></div>
    </dl>
    <dl className="opc-measures">{(Object.keys(ratings) as (keyof typeof ratings)[]).map(k =>
      <div key={k}><dt>{ratings[k]}</dt><dd>{item[k]} <small>/ 5</small></dd></div>)}</dl>
    <h3>原始证据</h3>
    <ul className="opc-sources">{item.evidence.map((value, i) => <li key={i}><Source text={value} /></li>)}</ul>
    <p className="opc-source">来源标识　<Source text={item.sourceId} /></p>
    {item.reuse && <section className="opc-reuse"><h3>{item.reuse.status==="needs_decision"?"先评估已有能力":item.reuse.status==="adopted"?"已采用原项目的能力":"原维护项目已受理"}</h3>
      {item.reuse.status==="needs_decision" && <p>此候选暂停自动选题。选择一个已有版本，比较调用入口，或向维护方提交缺口。</p>}
      <ul>{item.reuse.capabilities.map(c=><li key={c.id}><a href={"#capabilities?"+new URLSearchParams(item.reuse?.status==="needs_decision" ? {capability:c.id,consumer:item.project,opportunity:item.id} : {capability:c.id})}>
        {c.name} · {c.version} ↗</a>　{c.repo}</li>)}</ul>
      {item.reuse.requestIds.map(id=><p key={id}><a href={"#capabilities?"+new URLSearchParams({request:id})}>查看复用或维护回执 ↗</a></p>)}
    </section>}
    <div className="opc-detail-foot"><strong>{states[item.state]}</strong>
      {item.state==="queued" && !item.reuse && <a href={"#capabilities?"+new URLSearchParams({consumer:item.project,opportunity:item.id})}>为此线索查找已有能力 ↗</a>}
      {item.runId && <a className="opc-action-link" href={`#workflows/${encodeURIComponent(item.runId)}`}>查看计划与交付 →</a>}
      {item.state === "queued" && <button type="button" disabled={busy} onClick={onSkip}>跳过此项</button>}
    </div>
  </article>;
}

function ProjectPolicy({ project, policy, busy, canSelect, act, pick }: {
  project: string; policy?: OpportunityProject; busy: boolean; canSelect: boolean;
  act: () => void; pick: () => void;
}) {
  if (!project) return null;
  return <section className="opc-policy" aria-label="自动选题策略">
    <div><h2>{project}</h2><p>自动选题{policy?.enabled ? "已开启" : "已暂停"}，选中后生成待批计划。</p>
      {policy?.workspace && <small>本地仓库　{policy.workspace}</small>}
      {policy?.problem && <small className="opc-problem">{policy.problem}</small>}
    </div>
    <div className="opc-controls">
      <button type="button" disabled={busy || (!policy?.enabled && !policy?.workspace)} onClick={act}>{policy?.enabled ? "暂停自动选题" : "开启自动选题"}</button>
      <button type="button" className="opc-primary" disabled={busy || !canSelect} onClick={pick}>选择下一项</button>
    </div>
  </section>;
}

export function Opportunities({ nav, knownProjects }: { nav: ReactNode; knownProjects: string[] }) {
  const [index, setIndex] = useState<OpportunityIndex | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [filter, setFilter] = useState<Opportunity["state"]>("queued");
  const serial = useRef(0);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const thisCall = ++serial.current;
    try {
      const data = await api.opportunities();
      if (!alive.current || serial.current !== thisCall) return;
      setIndex(data); setLoadError("");
    } catch (error) {
      if (alive.current && serial.current === thisCall) setLoadError(errorMessage(error));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const update = () => { if (!document.hidden && !busyRef.current) void refresh(); };
    window.addEventListener("focus", update);
    const timer = setInterval(update, 5000);
    return () => { alive.current = false; serial.current++; window.removeEventListener("focus", update); clearInterval(timer); };
  }, [refresh]);

  const query = new URLSearchParams(location.hash.split("?")[1]);
  const requestedProject = query.get("project") ?? "";
  const projects = [...new Set([...(index?.projects.map(p => p.project) ?? []), ...(index?.opportunities.map(o => o.project) ?? []), ...knownProjects])].sort();
  const sourceProject = index?.opportunities.find(o => o.id === query.get("item"))?.project;
  const project = requestedProject || sourceProject || index?.projects.find(p => p.workspace)?.project || projects[0] || "";
  const policy = index?.projects.find(p => p.project === project);
  const items = (index?.opportunities ?? []).filter(o => o.project === project);
  const explicit = items.find(item => item.id === query.get("item"));
  const activeFilter = explicit?.state ?? filter;
  const rows = items.filter(item => item.state === activeFilter);
  const active = explicit ?? rows[0];

  function changeProject(next: string) {
    generation.current++;
    setFilter("queued"); setFormOpen(false); setNotice(""); setActionError("");
    location.hash = link(next);
  }
  function showForm() {
    setFormOpen(true); setActionError(""); setNotice("");
  }
  async function mutate(action: () => Promise<{ item?: Opportunity; text: string }>, closeForm = false) {
    if (busyRef.current) return;
    const started = generation.current;
    busyRef.current = true; setBusy(true); setActionError(""); setNotice("");
    try {
      const { item, text } = await action();
      if (!alive.current) return;
      if (started === generation.current) {
        if (closeForm) setFormOpen(false);
        setNotice(text);
        if (item) { setFilter(item.state); location.hash = link(item.project, item.id); }
      }
      await refresh();
    } catch (error) {
      if (alive.current && started === generation.current) setActionError(errorMessage(error));
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="zo-product opc-opportunities" aria-label="研发选题">
    <header className="opc-title">{nav}<div><a href="#overview">公司总览</a><h1>研发选题</h1></div>
      <button className="opc-primary" type="button" onClick={showForm} disabled={busy}>记录线索</button></header>
    <div className="opc-project-picker"><label>研发项目 <select aria-label="研发项目" value={project} onChange={e => changeProject(e.target.value)}>
      {!project && <option value="">尚无项目</option>}
      {requestedProject && !projects.includes(requestedProject) && <option>{requestedProject}</option>}
      {projects.map(name => <option key={name}>{name}</option>)}
    </select></label><div><a href={"#capabilities?" + new URLSearchParams({consumer:project})}>查找已有能力 ↗</a>　<a href="#business-lines">查看其他业务线 ↗</a></div></div>
    {loadError && <p role="alert" className="opc-error">{loadError} <button type="button" onClick={() => void refresh()}>重新读取</button></p>}
    {!index && !loadError && <p role="status">正在读取研发线索…</p>}
    {formOpen && <LeadForm project={project} projects={projects} busy={busy} onCancel={() => { setFormOpen(false); setActionError(""); }}
      onSave={draft => void mutate(async () => ({ item: await api.addOpportunity(draft), text: "已保存，可在项目下查看原始线索。" }), true)} />}
    {actionError && <p role="alert" className="opc-error">{actionError}</p>}
    {notice && <p role="status" className="opc-notice">{notice}</p>}
    {index && <>
      <ProjectPolicy project={project} policy={policy} busy={busy} canSelect={Boolean(policy?.workspace && items.some(item => item.state === "queued" && item.reuse?.status !== "needs_decision"))}
        act={() => void mutate(async () => {
          const next = await api.setOpportunityPolicy(project, !policy?.enabled);
          return { text: next.enabled ? "已开启自动选题。可在下方查看该项目选中的计划。" : "已暂停自动选题。已有计划可继续查看。" };
        })}
        pick={() => void mutate(async () => {
          const result = await api.selectOpportunity(project);
          return { item: result.opportunity ?? undefined, text: result.opportunity ? "已定位此项目选中的计划。" : "当前没有可选线索。" };
        })}/>
      {project && !policy?.workspace && !policy?.problem && <p className="opc-notice">此项目可以记录线索。绑定本地执行仓库后可生成计划。</p>}
      <div className="opc-workbench">
        <section className="opc-candidates" aria-label="研发线索列表">
          <h2>项目线索</h2>
          <nav className="opc-filters" aria-label="按线索状态筛选">{(Object.keys(states) as Opportunity["state"][]).map(s =>
            <button type="button" key={s} aria-pressed={activeFilter === s} onClick={() => { setFilter(s); location.hash = link(project); }}>
              {states[s]} <small>{items.filter(o => o.state === s).length}</small></button>)}</nav>
          {rows.length ? <ul>{rows.map(item => <li key={item.id}><a aria-current={active?.id === item.id ? "true" : undefined} href={link(project, item.id)}>
            <span>{kinds[item.kind]} <small>得分 {item.score}</small></span><strong>{item.title}</strong></a></li>)}</ul>
            : <p className="opc-empty">{activeFilter === "queued" ? "还没有候选线索。" : activeFilter === "selected" ? "还没有选入计划的线索。" : "还没有跳过的线索。"}</p>}
        </section>
        {active ? <LeadDetail item={active} busy={busy} onSkip={() => void mutate(async () => ({
          item: await api.skipOpportunity(active.id), text: "这条线索已跳过，依据保存在项目记录中。"
        }))} /> : <div className="opc-blank">{activeFilter === "queued" && !formOpen && <><h2>记录下一条值得验证的线索</h2>
          <p>从 Issue、日记条目或用户反馈开始，留下来源和可复查的依据。</p><button type="button" onClick={showForm}>记录第一条线索 →</button></>}</div>}
      </div>
    </>}
  </section>;
}
