import { DelegateWork } from "./Delegation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { GrowthCounts, GrowthEvent, GrowthReport as Report } from "../../src/growth-types";
import { api } from "./api";
import "./growth.css";

const steps = [
  { id: "acquired", label: "获客" },
  { id: "activated", label: "激活" },
  { id: "firstOrder", label: "首单" },
  { id: "repeatOrder", label: "复购" },
] as const;
type Step = (typeof steps)[number]["id"];
type Selection = { channel: string | null; step?: Step } | "excluded";
type Evidence = { event: GrowthEvent; label: string };
const reasons = {
  missing_acquisition: "缺少获客记录",
  activation_before_acquisition: "激活早于首次获客",
  missing_activation: "缺少有效激活",
  order_before_activation: "订单早于激活",
};
const eventLabels = { acquired: "获客", activated: "激活", order: "下单" };
const numbers = new Intl.NumberFormat("zh-CN");
const percentages = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

function supportingEvents(report: Report, selection: Selection): Evidence[] {
  if (selection === "excluded") {
    return report.excluded.map(({ event, reason }) => ({ event, label: eventLabels[event.kind] + " · " + reasons[reason] }));
  }
  return report.customers.flatMap(customer => {
    if (selection.channel !== null && selection.channel !== customer.channel) return [];
    return steps.flatMap(({ id, label }) => {
      const event = customer[id];
      return event && (!selection.step || selection.step === id) ? [{ event, label }] : [];
    });
  });
}

function Source({ reference }: { reference: string }) {
  if (!reference) return <>—</>;
  if (/^https?:\/\//i.test(reference)) {
    try {
      const url = new URL(reference);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return <a href={url.href} target="_blank" rel="noreferrer">{reference}</a>;
      }
    } catch { /* Keep incomplete source addresses readable. */ }
  }
  return <>{reference}</>;
}

function EvidenceList({ records }: { records: Evidence[] }) {
  return <ol className="growth-events">
    {records.map(({ event, label }) => <li key={event.eventId}>
      <div className="growth-event-title"><strong>{label}</strong><span>客户代号</span> {event.customerId}</div>
      <dl>
        <div><dt>事件时间</dt><dd><time dateTime={event.at}>{event.at}</time></dd></div>
        <div><dt>事件编号</dt><dd>{event.eventId}</dd></div>
        {event.orderId && <div><dt>订单号</dt><dd>{event.orderId}</dd></div>}
        <div><dt>来源</dt><dd><Source reference={event.reference} /></dd></div>
      </dl>
    </li>)}
  </ol>;
}

function FunnelRow({ channel, counts, selection, onSelect }: {
  channel: string | null; counts: GrowthCounts; selection: Selection | null; onSelect: (value: Selection) => void;
}) {
  const label = channel ?? "合计";
  const rowId = useId();
  const selected = selection && selection !== "excluded" && selection.channel === channel ? selection : null;
  return <tr>
    <th scope="row"><button type="button" aria-pressed={!!selected && !selected.step}
      onClick={() => onSelect({ channel })}>{label}</button></th>
    {steps.map((step, index) => {
      const count = counts[step.id];
      const previous = index > 0 ? counts[steps[index - 1].id] : 0;
      return <td key={step.id}><button type="button"
        aria-label={label + " " + step.label + " " + count + "人"} aria-pressed={selected?.step === step.id}
        aria-describedby={index > 0 ? rowId + step.id : undefined}
        onClick={() => onSelect({ channel, step: step.id })}>
        <strong>{numbers.format(count)}</strong>
        {index > 0 && <span id={rowId + step.id}>{previous ? percentages.format(count / previous) : "—"}</span>}
      </button></td>;
    })}
  </tr>;
}

function Funnel({ report }: { report: Report }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const detail = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selection && detail.current) {
      detail.current.focus({ preventScroll: true });
      detail.current.scrollIntoView({ block: "nearest" });
    }
  }, [selection]);
  const records = useMemo(() => selection ? supportingEvents(report, selection)
    .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at) || a.event.eventId.localeCompare(b.event.eventId)) : [], [report, selection]);
  const title = selection === "excluded" ? "未计入漏斗" : selection
    ? (selection.channel ?? "所有渠道") + " · " + (steps.find(s => s.id === selection.step)?.label ?? "全部阶段") : "";

  return <>
    <section aria-label="渠道转化" className="growth-funnel">
      <div className="growth-section-head"><h2>渠道转化</h2><span>累计去重人数</span></div>
      <table className="growth-table" aria-label="各渠道转化人数与转化率">
        <thead><tr><th scope="col">首次渠道</th>{steps.map(step => <th key={step.id} scope="col">{step.label}</th>)}</tr></thead>
        <tbody>{report.channels.map(counts => <FunnelRow key={counts.channel} channel={counts.channel} counts={counts}
          selection={selection} onSelect={setSelection} />)}</tbody>
        <tfoot><FunnelRow channel={null} counts={report.total} selection={selection} onSelect={setSelection} /></tfoot>
      </table>
      <p className="growth-method">每位客户归入首次获客渠道。首单取激活后的第一个订单，复购取第二个不同订单。百分比为该阶段人数占上一阶段人数的比例，分母为零时显示 —。</p>
      {report.excluded.length > 0 && <button className="growth-excluded" type="button" aria-pressed={selection === "excluded"}
        onClick={() => setSelection("excluded")}>未计入漏斗 · {numbers.format(report.excluded.length)} 条记录 ↗</button>}
    </section>
    {selection && <section className="growth-evidence" aria-label="原始记录" ref={detail} tabIndex={-1}>
      <div className="growth-section-head"><h2>{title}</h2><span>{numbers.format(records.length)} 条原始记录</span></div>
      {records.length ? <EvidenceList records={records} /> : <p className="growth-status">该项暂无原始记录。</p>}
    </section>}
  </>;
}

type Result = { requested: string; attempt: number } & ({ report: Report } | { error: string });

export function GrowthReport({ nav, product, onProduct, products }: {
  nav: ReactNode; product: string; onProduct: (p: string) => void; products: string[];
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [eventProducts, setEventProducts] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api.growthReport(product, controller.signal).then(report => {
      if (controller.signal.aborted) return;
      setEventProducts(report.products);
      setResult({ requested: product, attempt, report });
    }).catch(reason => {
      if (!controller.signal.aborted) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        setResult({ requested: product, attempt, error: detail });
      }
    });
    return () => controller.abort();
  }, [product, attempt]);

  const current = result?.requested === product && result.attempt === attempt ? result : null;
  const report = current && "report" in current ? current.report : null;
  const options = [...new Set([...eventProducts, ...products, ...(product ? [product] : [])])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const selectedProduct = product || report?.product || "";
  const refresh = () => setAttempt(value => value + 1);
  return <section className="zo-product growth-page" aria-label="增长报告">
    <header className="zo-product-head growth-head">{nav}<h1>增长报告</h1>
      <select aria-label="选择增长报告产品" value={selectedProduct}
        onChange={event => onProduct(event.target.value)} disabled={!options.length}>
        {!selectedProduct && <option value="">选择产品</option>}{options.map(name => <option key={name}>{name}</option>)}
      </select>
    </header>
    <div className="growth-body">
      {selectedProduct && report && <DelegateWork key={selectedProduct} label="委派分析渠道转化" operation={{key:"growth:"+selectedProduct,title:"分析渠道转化 · "+selectedProduct,href:"#growth?"+new URLSearchParams({product:selectedProduct}),detail:"从 "+selectedProduct+" 的获客渠道、激活、首单与复购记录核对转化差异和下一步实验。"}}/>}
      <div className="growth-ledger"><span>全部历史{report && <> · {numbers.format(report.eventCount)} 条事件{report.preview && " · 演示数据"}</>}</span>
        <button type="button" onClick={refresh} disabled={!current}>刷新</button></div>
      {!current && <p className="growth-status" role="status">正在读取增长记录…</p>}
      {current && "error" in current && <p className="growth-status" role="alert">
        读取增长记录失败。{current.error} <button type="button" onClick={refresh}>重试</button></p>}
      {report && (report.eventCount ? <Funnel key={report.product} report={report} /> :
        <div className="growth-empty"><h2>暂无增长事件</h2>
          <p>{selectedProduct ? selectedProduct + " 尚未登记获客、激活或订单记录。" : "登记首个产品的获客、激活或订单事件后，即可在此查看转化。"}</p></div>)}
    </div>
  </section>;
}
