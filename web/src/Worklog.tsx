import { DelegateWork } from "./Delegation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { HubDay, HubItem, WorklogBinding, WorklogIndex, WorklogTarget } from "../../src/worklog-types";
import { api } from "./api";
import "./worklog.css";

const states = { doing: "进行中", done: "完成", stuck: "卡住", todo: "待办" };
const defaultHubOrigin = "http://127.0.0.1:28790";
const hubUrl = (date: string, origin = defaultHubOrigin) => origin + "/#d=" + encodeURIComponent(date);
const message = (error: unknown) => error instanceof Error ? error.message : "读取失败";
const valueOf = (product: string, project: string) => JSON.stringify([product, project]);
const targetOf = ({ product, project, lineId }: WorklogTarget) => ({ product, project, lineId });

function LinkForm({ index, record, date, previous, line, onSave, onRemoved }: {
  index: WorklogIndex; record: HubItem; date: string; previous?: WorklogBinding; line: string;
  onSave: (saved: WorklogBinding) => void;
  onRemoved: (date: string, key: string) => void;
}) {
  const [choice, setChoice] = useState(previous ? valueOf(previous.product, previous.project) : "");
  const [lineId, setLineId] = useState(previous?.lineId ?? line);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const selected = index.projects.find(p => valueOf(p.product, p.project) === choice);
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      const saved = await api.bindWorklog({ ...selected, date, key: record.key, lineId: lineId || null,
        previous: previous ? targetOf(previous) : null });
      onSave(saved);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!previous || busy) return;
    setBusy(true); setError("");
    try {
      await api.unbindWorklog({ date, key: record.key, previous: targetOf(previous) });
      onRemoved(date, record.key);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  return <form className="wl-form" onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend>关联「{record.title}」</legend>
      <label>归属项目<select value={choice} required onChange={e => setChoice(e.target.value)}>
        <option value="">选择产品下的项目</option>
        {index.projects.map(p => <option key={valueOf(p.product, p.project)} value={valueOf(p.product, p.project)}>{p.product} / {p.project}</option>)}
      </select></label>
      <label>业务线（可选）<select value={lineId} onChange={e => setLineId(e.target.value)}>
        <option value="">只关联项目</option>{index.lines.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select></label>
      {index.projects.length ? <>
        <button type="submit" disabled={!choice} className="wl-primary">保存关联</button>
        {previous && <button type="button" onClick={() => void remove()}>取消关联</button>}
      </> : <p>还没有可关联的项目。<a href="#projects">打开目录登记项目 ↗</a></p>}
    </fieldset>{error && <p role="alert">{error}</p>}
  </form>;
}

export function Worklog({ nav, line = "" }: { nav: ReactNode; line?: string }) {
  const [index, setIndex] = useState<WorklogIndex>();
  const [date, setDate] = useState(() => {
    const linked = new URLSearchParams(location.hash.split("?")[1]).get("date");
    if (linked && /^\d{4}-\d{2}-\d{2}$/.test(linked)) return linked;
    const today = new Date();
    return [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
  });
  const [snapshot, setSnapshot] = useState<HubDay>();
  const [selected, setSelected] = useState(() => new URLSearchParams(location.hash.split("?")[1]).get("item") ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    api.worklog().then(data => { if (active) setIndex(data); }).catch(reason => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [reload]);
  const load = async (day: string) => {
    if (!day || loading) return;
    setDate(day); setLoading(true); setError(""); setNotice(""); setSnapshot(undefined); setSelected("");
    try { setSnapshot(await api.worklogDay(day)); } catch (reason) { setError(message(reason)); }
    finally { setLoading(false); }
  };
  useEffect(()=>{
    const linked=new URLSearchParams(location.hash.split("?")[1]).get("date");
    if(!linked || !/^\d{4}-\d{2}-\d{2}$/.test(linked)) return;
    let active=true;setLoading(true);
    api.worklogDay(linked).then(result=>{if(active)setSnapshot(result);})
      .catch(cause=>{if(active)setError(message(cause));}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);
  const hubOrigin = index?.hubOrigin || defaultHubOrigin;
  const lineName = index?.lines.find(l => l.id === line)?.name;
  const bindings = index?.bindings.filter(b => !line || b.lineId === line) ?? [];
  const record = snapshot?.records.find(r => r.key === selected);
  const binding = (key: string) => index?.bindings.find(b => b.key === key && b.date === snapshot?.date);
  const saved = (entry: WorklogBinding) => {
    setIndex(idx => idx && { ...idx, bindings: [entry, ...idx.bindings.filter(b => b.date !== entry.date || b.key !== entry.key)] });
    setSelected(""); setNotice("已关联到 " + entry.product + " / " + entry.project);
  };
  const removed = (day: string, key: string) => {
    setIndex(idx => idx && { ...idx, bindings: idx.bindings.filter(b => b.date !== day || b.key !== key) });
    setSelected(""); setNotice("已取消工作投入关联");
  };
  return <section className="zo-product wl-page">
    <header className="zo-product-head">{nav}<div><a href={line ? "#business-lines?line=" + encodeURIComponent(line) : "#overview"}>{lineName || "全局看板"} ↗</a><h1>工作投入</h1></div></header>
    <div className="wl-body">
      <section><h2>Agent Hub 日报</h2><p>选一天查看个人看板上的公开工作摘要，再把具体事项关联到项目。</p>
        <form className="wl-read" onSubmit={e => { e.preventDefault(); void load(date); }}>
          <label>日报日期<input type="date" value={date} required disabled={loading} onChange={e => {
            setDate(e.target.value); setSelected(""); setSnapshot(undefined); setError(""); setNotice("");
          }} /></label>
          <button type="submit" className="wl-primary" disabled={!index || loading}>{loading ? "读取中…" : "读取当日日报"}</button>
          {date && <a href={hubUrl(date, hubOrigin)} target="_blank" rel="noreferrer">在 Agent Hub 查看原日期 ↗</a>}
        </form>
        {error && <p role="alert">{error} {!index && <button onClick={() => { setError(""); setReload(v => v + 1); }}>重试</button>}</p>}
        {notice && <p role="status">{notice}</p>}
        {snapshot && <DelegateWork key={snapshot.date} label="委派核对当日投入" operation={{key:"worklog:"+snapshot.date,title:"核对工作投入 · "+snapshot.date,href:"#worklog?"+new URLSearchParams({date:snapshot.date,...(line?{line}:{})}),detail:"根据 Agent Hub 的公开日报，梳理项目投入与待跟进项。原始日期 "+hubUrl(snapshot.date, hubOrigin)}}/>}
        {snapshot && <><h3>{snapshot.date} · {snapshot.records.length} 条工作</h3>
          {snapshot.records.length ? <ul className="wl-rows">{snapshot.records.map(r => <li key={r.key}>
            <div><small>{r.mainline} · {states[r.state]}{r.projectHint && " · " + r.projectHint}</small><strong>{r.title}</strong>
              {binding(r.key) && <span>{binding(r.key)!.product} / {binding(r.key)!.project}</span>}</div>
            <button type="button" aria-expanded={selected === r.key} onClick={() => setSelected(k => k === r.key ? "" : r.key)}>
              {selected === r.key ? "收起" : binding(r.key) ? "修改关联" : "关联项目"}</button></li>)}</ul> : <p>当天公开看板尚无工作事项。</p>}
        </>}
        {record && snapshot && index && <>
          <DelegateWork key={snapshot.date + record.key} label="委派跟进这项工作" operation={{key:"worklog:"+snapshot.date+":"+record.key,title:"跟进日报事项 · "+record.title,href:"#worklog?"+new URLSearchParams({date:snapshot.date,item:record.key,...(line?{line}:{})}),detail:[hubUrl(snapshot.date, hubOrigin),record.title,record.mainline,record.projectHint,states[record.state]].filter(Boolean).join("\n")}}/>
          <LinkForm key={snapshot.date + record.key} index={index} date={snapshot.date} record={record} line={line}
          previous={binding(record.key)} onSave={saved} onRemoved={removed} /></>}
      </section>
      <section><h2>{lineName ? lineName + "的投入记录" : "已关联的投入"}</h2>
        {!index ? <p>正在读取项目目录…</p> : bindings.length ? <ul className="wl-rows">{bindings.map(b => <li key={b.date + b.key}>
          <div><small>{b.date} · {b.mainline}</small><strong>{b.title}</strong><span>{b.product} / {b.project}
            {b.lineId && <> · <a href={"#business-lines?line=" + encodeURIComponent(b.lineId)}>{index.lines.find(l => l.id === b.lineId)?.name}</a></>}</span></div>
          <a href={hubUrl(b.date, hubOrigin)} target="_blank" rel="noreferrer">原日期 ↗</a></li>)}</ul> : <p>尚未关联工作。读取日报后，选择一条事项即可登记。</p>}
      </section>
    </div>
  </section>;
}
