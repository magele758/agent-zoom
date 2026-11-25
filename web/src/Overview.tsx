import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { productStages, type ProductStageId } from "../../src/product-stages";
import type { ZoomMessage } from "../../src/zoom-types";
import type { BusinessLineSummary } from "../../src/business-types";
import type { WorkstreamAttentionItem, WorkstreamsOverview } from "../../src/workstreams-types";
import { request } from "./api";
import { messageText, taskKey } from "./zoom-view";
import { chatRoomLink, companyDepartments, decisionTarget, stageLink } from "./zoom-routes";
import { ActivitySummary, type useActivityIndex } from "./ActivityIndex";
import { ClassificationBadge, HerdrBadge, OriginTrackBadge } from "./ClassificationBadge";
import { HerdrActions } from "./HerdrActions";
import { OpcStoryFlow } from "./OpcStoryFlow";
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
  const [attentionItems, setAttentionItems] = useState<WorkstreamAttentionItem[]>([]);

  const loadAttention = useCallback(async (signal?: AbortSignal) => {
    try {
      const ws = await request<WorkstreamsOverview>("/api/opc/workstreams", { signal });
      if (!signal?.aborted) setAttentionItems(ws.attentionItems ?? []);
    } catch {
      /* Workstream attention is additive; ignore transient errors */
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request<{lines:BusinessLineSummary[]}>("/api/opc/business/catalog", { signal: controller.signal })
      .then(result => setLines(result.lines))
      .catch(error => { if (!controller.signal.aborted) setLineError(error.message); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadAttention(controller.signal);
    return () => controller.abort();
  }, [activityIndex.data, loadAttention]);
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
    <OpcStoryFlow mode="compact" />
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
    <nav className="overview-journal" aria-label="快捷入口"><a href="#cli-ledger">CLI 指令与进度台账 ↗</a><a href="#company-architecture?tab=story">OPC OS 来龙去脉全景 ↗</a><a href="#mailbox">总裁信箱 ↗</a><a href="#executive">总裁办 · Bot 架构 ↗</a><a href="#digital-twin">组织数字孪生 ↗</a><a href="#canvas">无界知识画布 ↗</a><a href="#metabolism">信息代谢 · PM 自动立项 ↗</a><a href="#planning">人机看板 · 番茄 · ROI ↗</a><a href="#dark-factory">Agent 暗工厂 ↗</a><a href="#home-room">Agent Home 群聊与 Bot ↗</a><a href="#delegations">委派台与默认办理方式 ↗</a><a href="#ideas">从信息到想法 ↗</a><a href="#capabilities">开源能力 ↗</a><a href="#worklog">查看个人工作投入 ↗</a></nav>
    {error && <p role="alert" className="overview-warning">{error} <button onClick={onRetry}>重试</button></p>}
    {!ready && !error && <p role="status">正在读取项目与待办…</p>}
    {ready && <>
      <section className="overview-decisions" aria-label="等待你决定的事项">
        <header>
          <h2>待我处理 <small>{pending.length + attentionItems.length}</small></h2>
          <a href="#mailbox">打开总裁信箱 ↗</a>
        </header>
        {pending.length > 0 && <>
          <p>数字员工遇到需你拍板的计划、实验复盘或异常卡点时会汇总在此——点击条目即可进入对应页面批准、打回修改或一键关闭。</p>
          <ul>{pending.slice(0, 5).map(item => <li key={item.id}>
            <a href={decisionTarget(item)}><span>{item.folder.split("/")[0]}</span><strong>{messageText(item).title}</strong><small>{item.source} · 去处理 ↗</small></a>
          </li>)}</ul>
        </>}
        {attentionItems.length > 0 && (
          <div className="dt-attention-block" aria-label="Herdr 与 CLI 现场待确认和阻塞项">
            <h3>
              <span>⚡ Herdr & CLI 现场卡点 / 等你确认（{attentionItems.length}）</span>
              <a href="#activity-index" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 500 }}>查看完整工作现场 ↗</a>
            </h3>
            <ul className="dt-attention-list">
              {attentionItems.slice(0, 6).map((item) => (
                <li key={item.id} className={`dt-attention-item${item.severity === "blocked" ? " is-blocked" : ""}`}>
                  <div className="dt-attention-top">
                    <span className={`dt-attention-sev is-${item.severity}`}>
                      {item.severity === "blocked" ? "⛔ 阻塞需确认" : "💬 等你回复"}
                    </span>
                    <OriginTrackBadge track={item.originTrack} />
                    <ClassificationBadge classification={item.classification} />
                    {item.machine && <span className="dt-pill dt-machine-pill">🖥 {item.machine}</span>}
                    <HerdrBadge address={item.herdrAddress} spaceName={item.herdrSpace} />
                    <span style={{ fontSize: 11.5, color: "#526258" }}>
                      {item.project} · {item.provider}
                    </span>
                  </div>
                  <div className="dt-attention-title">{item.title}</div>
                  {item.snippet && <div className="dt-attention-snippet">{item.snippet}</div>}
                  <div className="dt-row-badges">
                    <HerdrActions
                      address={item.herdrAddress}
                      isBlocked={item.isBlockedPermission}
                      compact
                      onSent={() => {
                        void loadAttention();
                        void activityIndex.load(true);
                      }}
                    />
                    {item.sessionId && (
                      <a
                        className="dt-mini-btn"
                        href={`#cli-ledger?session=${encodeURIComponent(item.sessionId)}`}
                        style={{ textDecoration: "none" }}
                      >
                        查看台账详情 ↗
                      </a>
                    )}
                    {item.linkedTaskId && (
                      <a
                        className="dt-pill dt-linked-task"
                        href={`#planning?task=${encodeURIComponent(item.linkedTaskId)}`}
                      >
                        ✓ 关联看板任务 ↗
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {pending.length === 0 && attentionItems.length === 0 && (
          <p>当前没有需要你答复或审批的事项（数字员工推进任务或 Herdr 终端遇到阻塞/需拍板时会自动汇总到这里）。</p>
        )}
      </section>
      <section aria-label="产品与阶段" className="overview-matrix">
        <header><h2>产品与阶段</h2><a href="#projects">打开项目目录 ↗</a></header>
        <div className="overview-wide">
          <table aria-label="各产品十三个阶段的任务数">
            <thead><tr><th rowSpan={2} scope="col">产品</th>{groups.map(group => <th scope="colgroup" key={group.label} colSpan={group.size}>{group.label}</th>)}</tr>
              <tr>{productStages.map(stage => <th key={stage.id} scope="col"><a href={stageLink(stage.id)}>{stage.label}</a></th>)}</tr></thead>
            <tbody>{["", ...products].map(name => <tr key={name}><th scope="row"><a href={name ? "#projects?" + new URLSearchParams({ product: name }) : "#projects"}>{name || "全公司"}</a></th>
              {productStages.map(stage => { const n = count(name, stage.id); return <td key={stage.id}>
                <a data-active={n > 0} aria-label={`${name || "全公司"} · ${stage.label} · ${n} 项任务`} href={stageLink(stage.id, name)}>{n || "—"}</a>
              </td>; })}</tr>)}</tbody>
          </table>
        </div>
        <div className="overview-narrow">
          <select aria-label="看板产品" value={current} onChange={event => {
            location.hash = event.target.value ? "#overview?" + new URLSearchParams({ product: event.target.value }) : "#overview";
          }}>
            <option value="">全公司</option>{products.map(name => <option key={name}>{name}</option>)}
          </select>
          <ol>{productStages.map(stage => <li key={stage.id}><a href={stageLink(stage.id, current)}>
            <span>{stage.label}</span><b>{count(current, stage.id)}</b></a></li>)}</ol>
        </div>
        <footer>数字为各阶段的任务数。{unfiled > 0 && <a href={chatRoomLink()}>另有 {unfiled} 项未标注阶段（在群聊讨论） ↗</a>}</footer>
      </section>
      {maintenance.length > 0 && <section className="overview-maintenance" aria-label="最近仓库维护">
        <header><h2>最近仓库维护</h2><a href="#operations-department">查看运维部门 ↗</a></header>
        <ul>{maintenance.slice(0, 4).map(item => <li key={item.id}><a href={"#activity-index?" + new URLSearchParams({ view: "repos", repo: item.repository!.fullName })}>
          <span>{item.folder.split("/")[0]}</span><strong>{item.repository!.fullName}</strong>
          <small>{item.repository!.openIssues} Issue · {item.repository!.openPullRequests} PR · 快照 {new Date(item.repository!.syncedAt).toLocaleDateString("zh-CN")} ↗</small>
        </a></li>)}</ul>
      </section>}
    </>}
  </section>;
}
