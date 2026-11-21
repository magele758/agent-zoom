import { useEffect, useMemo, useState, type ReactNode } from "react";
import { productStages, type ProductStageId } from "../../src/product-stages";
import type { ZoomMessage } from "../../src/zoom-types";
import type { BusinessLineSummary } from "../../src/business-types";
import { request } from "./api";
import { messageText, taskKey } from "./zoom-view";
import { companyDepartments, inboxLink } from "./zoom-routes";
import { ActivitySummary, type useActivityIndex } from "./ActivityIndex";
import "./overview.css";

type Tally = Map<ProductStageId, Set<string>>;
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
const groups = [{ label: "产品定义", size: 4 }, { label: "交付与运行", size: 5 }, { label: "市场与财务", size: 4 }];

export function Overview({ activityIndex, nav, products, messages, pending, ready, error, onRetry }: {
  activityIndex: ReturnType<typeof useActivityIndex>; nav: ReactNode; products: string[]; messages: ZoomMessage[]; pending: ZoomMessage[]; ready: boolean; error: string; onRetry: () => void;
}) {
  const selection = new URLSearchParams(location.hash.split("?")[1]).get("product") ?? "";
  const current = products.includes(selection) ? selection : "";
  const [lines, setLines] = useState<BusinessLineSummary[]>([]);
  const [lineError, setLineError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request<{lines:BusinessLineSummary[]}>("/api/opc/business/catalog", { signal: controller.signal })
      .then(result => setLines(result.lines))
      .catch(error => { if (!controller.signal.aborted) setLineError(error.message); });
    return () => controller.abort();
  }, []);
  const maintenance = messages.filter(item => item.repository);
  const unfiled = new Set(messages.filter(item => !item.stage).map(taskKey)).size;
  const counts = useMemo(() => {
    const byProduct = new Map<string, Tally>();
    for (const item of messages) {
      if (!item.stage) continue;
      for (const name of ["", item.folder.split("/")[0]]) {
        const stages = byProduct.get(name) ?? new Map<ProductStageId, Set<string>>();
        const tasks = stages.get(item.stage) ?? new Set<string>();
        tasks.add(taskKey(item)); stages.set(item.stage, tasks); byProduct.set(name, stages);
      }
    }
    return byProduct;
  }, [messages]);
  const count = (product: string, id: ProductStageId) => counts.get(product)?.get(id)?.size ?? 0;
  return <section className="zo-product overview" aria-label="全局看板">
    <header className="overview-head">{nav}<h1>全局看板</h1><time>{dateFormat.format(new Date())}</time></header>
    <ActivitySummary index={activityIndex}/>
    <section className="overview-lines" aria-label="公司业务线入口">
      <header><h2>公司业务线</h2><a href="#business-lines">管理业务线 ↗</a></header>
      <div>
        {lines.map(line => <a key={line.id} href={"#business-lines?line=" + encodeURIComponent(line.id)}>
          <strong>{line.name} <span aria-hidden="true">↗</span></strong><span>{line.goal}</span>
          {!!line.trials && <small>{line.trials} 轮实验{line.pendingReviews > 0 && " · " + line.pendingReviews + " 轮待复盘"}{line.transactions > 0 && " · " + line.transactions + " 笔收支凭据"}</small>}
        </a>)}
      </div>
      {lineError && <p role="alert">{lineError}</p>}
    </section>
    <section className="overview-lines overview-departments" aria-label="公司部门">
      <header><h2>公司部门</h2></header>
      <div>{companyDepartments.map(department =>
        <a key={department.page} href={"#" + department.page}>
          <strong>{department.name} <span aria-hidden="true">↗</span></strong>
          <span>{department.description}</span>
        </a>
      )}</div>
    </section>
    <nav className="overview-journal" aria-label="快捷入口"><a href="#digital-twin">组织数字孪生 ↗</a><a href="#delegations">委派台与默认办理方式 ↗</a><a href="#ideas">从信息到想法 ↗</a><a href="#capabilities">开源能力 ↗</a><a href="#worklog">查看个人工作投入 ↗</a><a href="#home-room">项目讨论室 ↗</a></nav>
    {error && <p role="alert" className="overview-warning">{error} <button onClick={onRetry}>重试</button></p>}
    {!ready && !error && <p role="status">正在读取项目和消息…</p>}
    {ready && <>
      <section className="overview-decisions" aria-label="等待你决定的事项">
        <header><h2>待我处理 <small>{pending.length}</small></h2><a href={inboxLink({ filter: "pending" })}>打开待办 ↗</a></header>
        {pending.length ? <ul>{pending.slice(0, 3).map(item => <li key={item.id}>
          <a href={inboxLink({ message: item.id })}><span>{item.folder.split("/")[0]}</span><strong>{messageText(item).title}</strong><small>{item.source} ↗</small></a>
        </li>)}</ul> : <p>当前没有需要你答复或审批的事项。</p>}
      </section>
      <section aria-label="产品与阶段" className="overview-matrix">
        <header><h2>产品与阶段</h2><a href="#projects">打开项目目录 ↗</a></header>
        <div className="overview-wide">
          <table aria-label="各产品十三个阶段的任务数">
            <thead><tr><th rowSpan={2} scope="col">产品</th>{groups.map(group => <th scope="colgroup" key={group.label} colSpan={group.size}>{group.label}</th>)}</tr>
              <tr>{productStages.map(stage => <th key={stage.id} scope="col"><a href={inboxLink({ stage: stage.id })}>{stage.label}</a></th>)}</tr></thead>
            <tbody>{["", ...products].map(name => <tr key={name}><th scope="row"><a href={inboxLink({ folder: name })}>{name || "全公司"}</a></th>
              {productStages.map(stage => { const n = count(name, stage.id); return <td key={stage.id}>
                <a data-active={n > 0} aria-label={`${name || "全公司"} · ${stage.label} · ${n} 项任务`} href={inboxLink({ folder: name, stage: stage.id })}>{n || "—"}</a>
              </td>; })}</tr>)}</tbody>
          </table>
        </div>
        <div className="overview-narrow">
          <select aria-label="看板产品" value={current} onChange={event => {
            location.hash = event.target.value ? "#overview?" + new URLSearchParams({ product: event.target.value }) : "#overview";
          }}>
            <option value="">全公司</option>{products.map(name => <option key={name}>{name}</option>)}
          </select>
          <ol>{productStages.map(stage => <li key={stage.id}><a href={inboxLink({ folder: current, stage: stage.id })}>
            <span>{stage.label}</span><b>{count(current, stage.id)}</b></a></li>)}</ol>
        </div>
        <footer>数字为各阶段的任务数。{unfiled > 0 && <a href={inboxLink({ stage: "unfiled" })}>另有 {unfiled} 项未标注阶段 ↗</a>}</footer>
      </section>
      {maintenance.length > 0 && <section className="overview-maintenance" aria-label="最近仓库维护">
        <header><h2>最近仓库维护</h2><a href={inboxLink({ stage: "operations" })}>查看运维 ↗</a></header>
        <ul>{maintenance.slice(0, 4).map(item => <li key={item.id}><a href={inboxLink({ folder: item.folder, message: item.id })}>
          <span>{item.folder.split("/")[0]}</span><strong>{item.repository!.fullName}</strong>
          <small>{item.repository!.openIssues} Issue · {item.repository!.openPullRequests} PR · 快照 {new Date(item.repository!.syncedAt).toLocaleDateString("zh-CN")} ↗</small>
        </a></li>)}</ul>
      </section>}
    </>}
  </section>;
}
