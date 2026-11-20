import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ProjectRef } from "../../src/project-profile-types";
import {
  securityStatus, securityStatusLabels, type SecurityDecision, type SecurityDepartmentIndex, type SecurityReview,
} from "../../src/security-department-types";
import { request } from "./api";
import { DelegateWork } from "./Delegation";
import "./security-department.css";

const path = "/api/opc/departments/security";
const projectKey = ({ product, project }: ProjectRef) => new URLSearchParams({ product, project }).toString();
const describe = (cause: unknown) => cause instanceof Error ? cause.message : "保存失败，请重试。";
const format = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
type Save = (review: SecurityReview) => void;

function NewReview({ projects, current, save }: { projects: ProjectRef[]; current: string; save: Save }) {
  const [selected, setSelected] = useState(current || (projects.length === 1 ? projectKey(projects[0]) : ""));
  const [scope, setScope] = useState("");
  const [id, setId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ref = projects.find(item => projectKey(item) === selected);
    if (!ref || !scope.trim() || busy) return;
    setBusy(true); setError("");
    try {
      save(await request<SecurityReview>(path + "/reviews", {
        method: "POST", body: JSON.stringify({ id, ...ref, scope }),
      }));
      setScope("");
      setId(crypto.randomUUID());
    } catch (cause) { setError(describe(cause)); }
    finally { setBusy(false); }
  }
  return <section>
    <h2>登记安全审查</h2>
    {projects.length ? <form onSubmit={submit} className="security-form">
      <label>归属项目<select required value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">请选择项目</option>
        {projects.map(ref => <option key={projectKey(ref)} value={projectKey(ref)}>{ref.product} / {ref.project}</option>)}
      </select></label>
      <label>审查范围<textarea required maxLength={2000} rows={2} value={scope} onChange={e => setScope(e.target.value)}
        placeholder="例如，复核本次发布中成员权限的变更，可附 PR 或提交号" /></label>
      <button className="security-primary" disabled={busy || !selected || !scope.trim()}>登记审查</button>
      {error && <p role="alert">{error}</p>}
    </form> : <p>请先到<a href="#projects">项目目录</a>登记产品下的项目，再发起审查。</p>}
  </section>;
}

function DecisionForm({ review, save }: { review: SecurityReview; save: Save }) {
  const repairing = securityStatus(review) === "changes";
  const [outcome, setOutcome] = useState<SecurityDecision | "">(repairing ? "recheck" : "");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!note.trim() || !outcome || busy) return;
    setBusy(true); setError("");
    try {
      save(await request<SecurityReview>(path + "/reviews/" + review.id + "/decisions", {
        method: "POST", body: JSON.stringify({ revision: review.history.length, outcome, note, evidence }),
      }));
    } catch (cause) { setError(describe(cause)); }
    finally { setBusy(false); }
  }
  return <form className="security-form" onSubmit={submit}>
    {!repairing && <label>审查结论<select required value={outcome} onChange={e => setOutcome(e.target.value as SecurityDecision)}>
      <option value="">请选择结论</option><option value="changes">需要整改</option><option value="passed">审查通过</option>
    </select></label>}
    <label>{repairing ? "整改说明" : "发现与结论说明"}<textarea required rows={2} maxLength={4000} value={note}
      onChange={e => setNote(e.target.value)} /></label>
    <label>证据（选填）<input maxLength={2000} value={evidence} onChange={e => setEvidence(e.target.value)}
      placeholder="PR、提交号、测试或审查报告" /></label>
    <button className="security-primary" disabled={busy || !outcome || !note.trim()}>{repairing ? "提交复核" : "保存结论"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function ReviewItem({ review, selected, save }: { review: SecurityReview; selected: boolean; save: Save }) {
  const status = securityStatus(review);
  const last = review.history.at(-1);
  const operation = status === "changes" ? "跟进整改" : status === "recheck" ? "复核整改" : "安全审查";
  return <details className="security-review" open={selected || undefined}>
    <summary><strong>{review.scope}</strong><span data-status={status}>{securityStatusLabels[status]}</span>
      <small>{review.product} / {review.project}</small></summary>
    <div className="security-detail">
      <p><a href={"#projects?" + projectKey(review)}>查看项目档案 ↗</a> · 登记于 {format.format(new Date(review.createdAt))}</p>
      {review.history.length > 0 && <ol aria-label="审查与整改记录">
        {review.history.map((record, idx) => <li key={idx}>
          <header><b>{securityStatusLabels[record.outcome]}</b><time dateTime={record.recordedAt}>{format.format(new Date(record.recordedAt))}</time></header>
          <p>{record.note}</p>{record.evidence && <p>证据 · {record.evidence}</p>}
        </li>)}
      </ol>}
      {status !== "passed" && <>
        <DelegateWork label={"委派" + operation} operation={{
          key: "security/" + review.id + "/" + review.history.length, title: operation + " · " + review.project,
          href: "#security-department?" + new URLSearchParams({ product: review.product, project: review.project, review: review.id }),
          detail: [review.product + " / " + review.project, "审查范围：" + review.scope,
            last && "最近记录：" + last.note, last?.evidence && "证据：" + last.evidence,
            "请提交本次" + operation + "的结果与证据。"].filter(Boolean).join("\n"),
        }}/>
        <DecisionForm key={review.history.length} review={review} save={save}/>
      </>}
    </div>
  </details>;
}

export function SecurityDepartment({ nav }: { nav: ReactNode }) {
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const product = params.get("product"), project = params.get("project"), selected = params.get("review");
  const current = product && project ? projectKey({ product, project }) : "";
  const [data, setData] = useState<SecurityDepartmentIndex | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<SecurityDepartmentIndex>(path, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setData(result); setError(""); } })
      .catch(cause => { if (!controller.signal.aborted) setError(describe(cause)); });
    return () => controller.abort();
  }, [refresh]);
  const save: Save = saved => {
    setData(index => index && { ...index, reviews: [saved, ...index.reviews.filter(r => r.id !== saved.id)] });
    setNotice("审查记录已保存 · " + securityStatusLabels[securityStatus(saved)]);
  };
  const reviews = data?.reviews.filter(review => (!current || projectKey(review) === current) && (!selected || review.id === selected)) ?? [];
  const visibleProjects = data?.projects.filter(ref => !current || projectKey(ref) === current) ?? [];
  return <section className="zo-product security-page">
    <header className="zo-product-head">{nav}<h1>安全部门</h1></header>
    <div className="security-body">
      <p className="security-intro">跟进开发项目的安全审查、问题整改和复核结论。</p>
      {error && <p role="alert">{error} <button onClick={() => setRefresh(n => n + 1)}>重试</button></p>}
      {!data && !error && <p role="status">正在读取安全审查…</p>}
      {data && <>
        {!selected && <NewReview key={current} current={current} projects={visibleProjects} save={save}/>}
        <section><header className="security-list-head">
          <h2>审查记录 <small>{reviews.length}</small></h2>
          {selected ? <a href="#security-department">查看全部审查 ↗</a> :
            <label>筛选项目<select value={current} onChange={e => { location.hash = "#security-department" + (e.target.value ? "?" + e.target.value : ""); }}>
              <option value="">全部项目</option>{data.projects.map(ref => <option key={projectKey(ref)} value={projectKey(ref)}>{ref.product} / {ref.project}</option>)}
            </select></label>}
          <button onClick={() => setRefresh(n => n + 1)}>刷新</button>
        </header>
        {notice && <p role="status">{notice}</p>}
        {reviews.length ? reviews.map(review => <ReviewItem key={review.id} review={review} selected={review.id === selected} save={save}/>)
          : <p>{selected ? "找不到这项安全审查。" : "当前还没有安全审查记录。"}</p>}
        </section>
      </>}
    </div>
  </section>;
}
