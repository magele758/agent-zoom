import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { serviceHealthLabels, updateOutcomeLabels, type LiveHealthCheck, type ManagedService, type OperationsIndex } from "../../src/operations-department-types";
import { request } from "./api";
import { inboxLink } from "./zoom-routes";
import "./operations-department.css";

const base = "/api/opc/departments/operations";
const stamp = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
function When({ at }: { at: string }) {
  return <time dateTime={at}>{stamp.format(new Date(at))}</time>;
}
function scopeQuery(scope: string) {
  const [product, project] = scope.split("/");
  const params = new URLSearchParams();
  if (product) params.set("product", product);
  if (project) params.set("project", project);
  return params.size ? "?" + params : "";
}

function HealthChecks({ onRegister }: { onRegister: (name: string) => void }) {
  const [checks, setChecks] = useState<LiveHealthCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError("");
    request<LiveHealthCheck>(base + "/health", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setChecks(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [revision]);
  return <section className="ops-block" aria-label="公司服务健康检查">
    <header><h2>公司服务健康检查</h2><button disabled={busy} onClick={() => setRevision(n => n + 1)}>重新检查</button></header>
    {busy && <p role="status">正在检查服务端点…</p>}
    {error && <p role="alert">{error}</p>}
    {checks && <>
      <p className="ops-meta">检查完成于 <When at={checks.checkedAt}/> · {checks.services.filter(item => item.healthy).length} / {checks.services.length} 个端点检查通过</p>
      {checks.services.length ? <ul className="ops-probes">{checks.services.map(item => <li key={item.id}>
        <span>{item.name}</span><small data-tone={item.healthy ? "good" : "warn"}>{item.healthy ? "端点可用" : "检查失败"}{item.latencyMs != null && " · " + item.latencyMs + " ms"}</small>
        <button type="button" onClick={() => onRegister(item.name)} aria-label={"登记服务 " + item.name}>登记到台账</button>
      </li>)}</ul> : <p>尚未配置可检查的服务端点。</p>}
    </>}
  </section>;
}

type EditorProps = {
  children: ReactNode;
  button: string;
  onSave: (fields: Record<string, string>, id: string) => Promise<void>;
  onCancel: () => void;
  onReload: () => void;
};
function Editor({ children, button, onSave, onCancel, onReload }: EditorProps) {
  const [id] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const fields = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true); setError("");
    try { await onSave(fields, id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <form className="ops-form" onSubmit={submit}><fieldset disabled={busy}>
    {children}
    <div className="ops-actions"><button type="submit">{button}</button><button type="button" onClick={onCancel}>取消</button></div>
    {error && <p role="alert">{error} <button type="button" onClick={onReload}>重新读取</button></p>}
  </fieldset></form>;
}

function ServiceCard({ service, onChange, onReload }: { service: ManagedService; onChange: (next: ManagedService) => void; onReload: () => void }) {
  const [action, setAction] = useState<"" | "observation" | "plan" | "result">("");
  const [editingPlan, setEditingPlan] = useState<{ id: string; target: string } | null>(null);
  const latest = service.observations[0];
  const plan = service.updates[0]?.result === null ? service.updates[0] : null;
  const save = async (fields: Record<string,string>, id: string) => {
    const event = { ...fields, kind: action, ...(action === "result" && editingPlan ? { planId: editingPlan.id } : {}) };
    const next = await request<ManagedService>(base + "/services/" + service.id + "/events", {
      method: "POST", body: JSON.stringify({ id, revision: service.revision, event }),
    });
    onChange(next); setAction("");
  };
  return <article className="ops-service">
    <header><h3>{service.name}</h3>
      <small data-tone={!latest ? "" : latest.health === "healthy" ? "good" : "warn"}>
        {latest ? serviceHealthLabels[latest.health] : "待巡检"}</small></header>
    <div className="ops-meta">
      {service.scope ? <a href={"#projects" + scopeQuery(service.scope)}>{service.scope} ↗</a> : "公司共用"}
      {" · 最近确认版本 "}{service.version || "待确认"}
      {latest && <> · 巡检登记于 <When at={latest.at}/></>}
    </div>
    {latest && <p>{latest.note} <small>依据 · {latest.source}</small></p>}
    {plan && <p>计划更新至 <strong>{plan.target}</strong> · {plan.note}</p>}
    {!action && <div className="ops-actions">
      <button onClick={() => setAction("observation")}>记录巡检</button>
      <button onClick={() => { setEditingPlan(plan); setAction(plan ? "result" : "plan"); }}>{plan ? "登记更新结果" : "计划更新"}</button>
      {service.scope && <a href={inboxLink({ folder: service.scope, stage: "operations" })}>查看运维事项 ↗</a>}
    </div>}
    {action && <Editor key={action} onSave={save} onReload={onReload} onCancel={() => setAction("")}
      button={action === "observation" ? "保存巡检" : action === "plan" ? "保存计划" : "保存结果"}>
      {action === "observation" && <>
        <label>运行状态<select name="health" required defaultValue=""><option disabled value="">选择状态</option>{Object.entries(serviceHealthLabels).map(([key,text]) => <option value={key} key={key}>{text}</option>)}</select></label>
        <label>检查依据<input required name="source" maxLength={1000} placeholder="监控面板、日志位置或检查记录"/></label>
        <label>巡检结论<textarea name="note" required maxLength={2000}/></label>
      </>}
      {action === "plan" && <>
        <label>目标版本<input name="target" required maxLength={160}/></label>
        <label>更新说明<textarea name="note" required maxLength={2000} placeholder="更新范围、验证方法或回退安排"/></label>
      </>}
      {action === "result" && <>
        <p>目标版本 · {editingPlan?.target}</p>
        <label>更新结果<select name="outcome" required defaultValue=""><option disabled value="">选择结果</option>{Object.entries(updateOutcomeLabels).map(([key,text]) => <option value={key} key={key}>{text}</option>)}</select></label>
        <label>验证或处置记录<textarea name="note" required maxLength={2000}/></label>
      </>}
    </Editor>}
    {service.revision > 0 && <details><summary>巡检与更新记录</summary>
      {service.observations.length > 0 && <><h4>巡检记录</h4><ul>{service.observations.map(observation => <li key={observation.id}>
        <When at={observation.at}/> · {serviceHealthLabels[observation.health]} · {observation.note}<small>依据 · {observation.source}</small>
      </li>)}</ul></>}
      {service.updates.length > 0 && <><h4>版本更新</h4><ul>{service.updates.map(update => <li key={update.id}>
        <When at={update.at}/> · {update.from || "原版本待确认"} → {update.target} · {update.note}
        <small>{update.result ? <><When at={update.result.at}/> · {updateOutcomeLabels[update.result.outcome]} · {update.result.note}</> : "待登记结果"}</small>
      </li>)}</ul></>}
    </details>}
  </article>;
}

export function OperationsDepartment({ nav }: { nav: ReactNode }) {
  const [data, setData] = useState<OperationsIndex | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const reload = () => setRevision(n => n + 1);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    request<OperationsIndex>(base, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [revision]);
  const query = new URLSearchParams(location.hash.split("?")[1]);
  const scope = [query.get("product"), query.get("project")].filter(Boolean).join("/");
  const services = data?.services.filter(s => !scope || s.scope === scope || s.scope.startsWith(scope + "/")) ?? [];
  const update = (next: ManagedService) => setData(old => old && ({
    ...old, services: [...old.services.filter(s => s.id !== next.id), next].sort((a,b) => a.name.localeCompare(b.name, "zh-CN")),
  }));
  const openDraft = (name: string) => {
    setDraft(name);
    requestAnimationFrame(() => document.getElementById("ops-register-name")?.focus());
  };
  return <section className="zo-product ops-dept" aria-label="运维部门">
    <header className="zo-product-head">{nav}<h1>运维部门</h1></header>
    <div className="ops-main">
      <HealthChecks onRegister={openDraft}/>
      <section className="ops-block" aria-label="服务台账"><header><h2>服务台账</h2>
        {data && <button onClick={() => openDraft("")}>登记服务</button>}</header>
        {error && <p role="alert">{error} <button onClick={reload}>重新读取</button></p>}
        {!data && !error && <p role="status">正在读取服务台账…</p>}
        {data && <>
          <label className="ops-filter">归属范围<select value={scope}
            onChange={e => { setDraft(null); location.hash = "#operations-department" + scopeQuery(e.target.value); }}>
            <option value="">全部服务</option>
            {scope && !data.scopes.includes(scope) && <option>{scope}</option>}
            {data.scopes.map(item => <option key={item}>{item}</option>)}
          </select></label>
          {draft !== null && <Editor key={JSON.stringify([scope, draft])} button="保存服务" onReload={reload} onCancel={() => setDraft(null)} onSave={async (fields, id) => {
            const next = await request<ManagedService>(base + "/services", {method:"POST", body: JSON.stringify({ ...fields, id })});
            update(next); setDraft(null);
            if (scope && next.scope !== scope && !next.scope.startsWith(scope + "/")) {
              location.hash = "#operations-department" + scopeQuery(next.scope);
            }
          }}>
            <label>服务名称<input id="ops-register-name" name="name" defaultValue={draft} required maxLength={160}/></label>
            <label>所属产品或项目<select name="scope" defaultValue={data.scopes.includes(scope) ? scope : ""}>
              <option value="">公司共用</option>{data.scopes.map(item => <option key={item}>{item}</option>)}</select></label>
            <label>当前版本（可选）<input name="version" maxLength={160}/></label>
          </Editor>}
          {services.length === 0 ? <p>当前范围还没有登记服务。</p> :
            <div className="ops-services">{services.map(service => <ServiceCard key={service.id} service={service} onChange={update} onReload={reload}/>)}</div>}
        </>}
      </section>
    </div>
  </section>;
}
