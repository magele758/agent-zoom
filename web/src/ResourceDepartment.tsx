import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  currentReading,
  type CollectionReceipt,
  type HubQuotaTool,
  type ManualPlan,
  type ManualPlanInput,
  type QuotaReading,
  type ResourceDepartmentIndex,
} from "../../src/resource-department-types";
import { request } from "./api";
import "./resource-department.css";

const endpoint = "/api/opc/departments/resources";
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8 });
const clock = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", hour12: false });
const time = (iso: string | null) => iso ? clock.format(new Date(iso)) : "未知";
const reason = (err: unknown) => err instanceof Error ? err.message : "读取失败";

function localInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function Reading({ reading, unit, capacity, now, hub }: {
  reading: QuotaReading; unit: string; capacity?: number | null; now: number; hub?: boolean;
}) {
  const { remaining, state } = currentReading(reading, now, hub);
  return <div className="rc-reading">
    <strong>{remaining === null ? "余量未知" : number.format(remaining) + (unit === "%" ? "%" : " " + unit)}</strong>
    {state === "reset" ? <small>已到重置时间，待核对</small>
      : state === "stale" ? <small>上次读数已过期</small>
      : state === "observed" && <small>{capacity != null && unit !== "%" ? "剩余 / 共 " + number.format(capacity) + " " + unit : "剩余"}</small>}
  </div>;
}

function formatTokens(n: number) {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿 tokens";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万 tokens";
  return number.format(n) + " tokens";
}

function PlanForm({ initial, prefill, onSave, onClose }: {
  initial?: ManualPlan; prefill?: Partial<ManualPlanInput>; onSave: (plan: ManualPlan) => void; onClose: () => void;
}) {
  const seed = initial ?? prefill;
  const [id] = useState(() => initial?.id ?? crypto.randomUUID());
  const [editingReading, setEditingReading] = useState(() => !initial || currentReading(initial).state !== "reset");
  const [fee, setFee] = useState(seed?.fee != null ? String(seed.fee) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [observedAt, setObservedAt] = useState(() => initial ? initial.observedAt : new Date().toISOString());
  const [resetsAt, setResetsAt] = useState(seed?.resetsAt ?? null);
  const [remaining, setRemaining] = useState(seed?.reportedRemaining != null ? String(seed.reportedRemaining) : "");
  const instant = (date: string) => date ? new Date(date).toISOString() : null;
  function startWindow() {
    setRemaining("");
    setObservedAt(new Date().toISOString());
    setResetsAt(null);
    setEditingReading(true);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? "").trim();
    const quantity = (key: string) => value(key) === "" ? null : Number(value(key));
    setBusy(true); setError("");
    try {
      const saved = await request<ManualPlan>(endpoint + "/plans/" + id, { method: "PUT", body: JSON.stringify({
        revision: initial?.revision ?? 0, name: value("name"), window: value("window"), unit: value("unit"),
        capacity: quantity("capacity"), reportedRemaining: remaining === "" ? null : Number(remaining), resetsAt,
        renewsOn: value("renewsOn") || null, observedAt,
        fee: quantity("fee"), currency: fee ? value("currency") : null,
        billingCycle: fee ? value("billingCycle") : null,
      }) });
      onSave(saved);
    } catch (err) { setError(reason(err)); }
    finally { setBusy(false); }
  }
  return <form className="rc-form" onSubmit={submit}>
    <fieldset disabled={busy}><legend>{initial ? "更新套餐" : prefill?.name ? `校准「${prefill.name}」本期额度` : "登记套餐或订阅"}</legend>
      <div>
        <label>套餐或订阅名称<input name="name" required maxLength={120} defaultValue={seed?.name ?? ""} /></label>
        <label>额度窗口<input name="window" placeholder="如每周、每月或预付余额" maxLength={100} defaultValue={seed?.window ?? ""}/></label>
        <label>额度单位<input list="rc-units" name="unit" required maxLength={32} defaultValue={seed?.unit ?? "tokens"} /></label>
        <datalist id="rc-units">{["tokens", "%", "次", "点数", "USD", "CNY", "天"].map(unit => <option key={unit}>{unit}</option>)}</datalist>
        <label>总额度<input type="number" name="capacity" step="any" min="0" placeholder="选填" defaultValue={seed?.capacity ?? ""}/></label>
        {editingReading ? <>
          <label>剩余额度<input type="number" step="any" min="0" placeholder="如 100（未知可留空）" value={remaining}
            onChange={e => { setRemaining(e.target.value); setObservedAt(new Date().toISOString()); }}/></label>
          <label>核对时间<input type="datetime-local" value={localInput(observedAt)} onChange={e => setObservedAt(instant(e.target.value))}/></label>
          <label>下次重置<input type="datetime-local" value={localInput(resetsAt)} onChange={e => setResetsAt(instant(e.target.value))}/></label>
        </> : <button type="button" onClick={startWindow}>登记本期额度</button>}
        <label>续费日期<input type="date" name="renewsOn" defaultValue={seed?.renewsOn ?? ""}/></label>
        <label>订阅费用<input type="number" min="0" step="any" name="fee" placeholder="选填" value={fee} onChange={e => setFee(e.target.value)}/></label>
        {fee !== "" && <>
          <label>费用币种<input name="currency" required list="rc-currencies" maxLength={3} pattern="[A-Za-z]{3}" placeholder="如 USD 或 CNY" defaultValue={seed?.currency ?? ""}/></label>
          <datalist id="rc-currencies">{["USD", "CNY", "EUR", "HKD"].map(code => <option key={code}>{code}</option>)}</datalist>
          <label>计费周期<select name="billingCycle" defaultValue={seed?.billingCycle ?? "monthly"}>
            <option value="monthly">每月</option><option value="yearly">每年</option></select></label>
        </>}
      </div>
      <footer><button type="submit" className="rc-primary">{busy ? "保存中…" : "保存套餐"}</button>
        <button type="button" onClick={onClose}>取消</button></footer>
    </fieldset>{error && <p role="alert">{error}</p>}
  </form>;
}

export function ResourceDepartment({ nav }: { nav: ReactNode }) {
  const [index, setIndex] = useState<ResourceDepartmentIndex>();
  const [editing, setEditing] = useState<ManualPlan | "new" | null>(null);
  const [prefill, setPrefill] = useState<Partial<ManualPlanInput> | undefined>();
  const [calibratingTool, setCalibratingTool] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [collecting, setCollecting] = useState(false);
  const [collectionNotice, setCollectionNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    request<ResourceDepartmentIndex>(endpoint, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setIndex(data); setNow(Date.now()); } })
      .catch(err => { if (!controller.signal.aborted) setError(reason(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  async function collect() {
    if (collecting || !index?.canCollect) return;
    setCollecting(true); setError(""); setCollectionNotice("");
    try {
      const result = await request<CollectionReceipt>(endpoint + "/collect", { method: "POST", body: "{}" });
      setIndex(current => current && { ...current, hub: result.hub });
      setNow(Date.now());
      setCollectionNotice(!result.snapshotUpdated ? "采集返回后未发现新快照。"
        : result.recentReadings ? "已取得新快照，有 " + result.recentReadings + " 项额度在最近一小时内核对过。"
        : "已取得新快照，各来源暂时没有可用的近期额度读数。");
    } catch (err) { setError(reason(err)); }
    finally { setCollecting(false); }
  }
  function saved(plan: ManualPlan) {
    setIndex(current => current && { ...current, plans: [...current.plans.filter(it => it.id !== plan.id), plan]
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")) });
    setEditing(null); setPrefill(undefined); setCalibratingTool(null); setNotice("已保存「" + plan.name + "」。");
  }
  function startCalibrate(tool: HubQuotaTool, existing?: ManualPlan) {
    setNotice("");
    if (existing) {
      setEditing(existing);
      setCalibratingTool(tool.tool);
      return;
    }
    setPrefill({
      name: tool.plan ? `${tool.name}（${tool.plan}）` : tool.name,
      window: tool.tool === "cursor" ? "月度模型池" : "周额度",
      unit: "%",
      capacity: 100,
      reportedRemaining: tool.usage?.cycleCalls === 0 ? 100 : null,
      resetsAt: tool.usage?.cycleResetAt ?? null,
      fee: tool.usage?.monthlyUsd ?? null,
      currency: tool.usage?.monthlyUsd != null ? "USD" : null,
      billingCycle: tool.usage?.monthlyUsd != null ? "monthly" : null,
    });
    setEditing("new");
    setCalibratingTool(tool.tool);
  }
  const hub = index?.hub;
  const matchPlans = (tool: HubQuotaTool) => (index?.plans ?? []).filter(p => {
    const n = p.name.toLowerCase();
    return n.includes(tool.tool.toLowerCase()) || n.includes(tool.name.toLowerCase());
  });
  return <section className="zo-product rc-page">
    <header className="zo-product-head">{nav}<div><a href="#overview">全局看板 ↗</a><h1>资源成本部门</h1></div></header>
    <div className="rc-body">
      <section><header><div><h2>工具额度</h2>{hub?.generatedAt && <p>Agent Hub 快照 · {time(hub.generatedAt)}</p>}</div>
        <div className="rc-actions">
          {index?.canCollect && <button className="rc-primary" disabled={loading || collecting} onClick={() => void collect()}>
            {collecting ? "正在采集…" : "采集最新额度"}</button>}
          <button disabled={loading || collecting || !!editing} onClick={() => { setNotice(""); setCollectionNotice(""); setRefresh(v => v + 1); }}>重读快照</button>
        </div></header>
        {index && !index.canCollect && <p>此来源仅支持读取已有快照。</p>}
        {collectionNotice && <p role="status">{collectionNotice}</p>}
        {error && <p role="alert">{error}</p>}{loading && <p role="status">正在读取额度…</p>}
        {hub && !hub.tools.length && <p>Agent Hub 暂无可读取的额度快照。可在下方登记套餐。</p>}
        <div className="rc-tools">{hub?.tools.map(tool => {
          const linked = matchPlans(tool);
          const hasReadings = tool.windows.length > 0 || (tool.balances?.length ?? 0) > 0 || linked.length > 0;
          const usage = tool.usage;
          return <article key={tool.tool}>
            <div className="rc-tool-head">
              <h3>{tool.name}</h3>
              {usage?.monthlyUsd != null && usage.monthlyUsd > 0 && <span className="rc-tool-fee">USD {number.format(usage.monthlyUsd)} / 月</span>}
            </div>
            {tool.plan && <p>{tool.plan}</p>}
            {!tool.applicable && !hasReadings && <p>无订阅额度</p>}
            {tool.windows.map((w, i) => <div className="rc-window" key={w.name + i}>
              <div><b>{w.name}</b><Reading reading={w} unit="%" now={now} hub/></div>
              <small>{w.live ? "平台读数" : tool.fromHistory ? "最近有效快照" : "本机记录"} · {time(w.observedAt)}</small>
              <small>重置 · {time(w.resetsAt)}</small>
            </div>)}
            {tool.balances?.map(balance => <div className="rc-window" key={balance.name}>
              <div><b>{balance.name}</b><Reading reading={balance} unit={balance.unit} now={now} hub/></div>
              <small>上次核对 · {time(balance.observedAt)}</small>
            </div>)}
            {linked.map(plan => <div className="rc-window" key={plan.id}>
              <div><b>{plan.window || "手动校准额度"}</b><Reading reading={plan} unit={plan.unit} capacity={plan.capacity} now={now}/></div>
              <small>手动核对 · {time(plan.observedAt)}</small>
              {plan.resetsAt && <small>重置 · {time(plan.resetsAt)}</small>}
            </div>)}
            {tool.applicable && usage && (usage.cycleResetAt || usage.sessions7d > 0 || usage.calls7d > 0) && (
              <div className="rc-usage-box">
                {usage.cycleResetAt && (
                  <span>
                    本账期：{time(usage.cycleStartAt)} 起 → <strong>{time(usage.cycleResetAt)} 重置</strong>
                    {usage.cycleCalls !== null && ` · 本期本机 ${number.format(usage.cycleCalls)} 次调用`}
                  </span>
                )}
                {(usage.sessions7d > 0 || usage.calls7d > 0) && (
                  <span>
                    近 7 天本机实测：{number.format(usage.sessions7d)} 会话
                    {usage.calls7d > 0 ? ` · ${number.format(usage.calls7d)} 次调用` : ""}
                    {usage.tokens7d > 0 ? ` · ${formatTokens(usage.tokens7d)}` : ""}
                  </span>
                )}
                {usage.lastCycleUsedUsd !== null && (
                  <span>最近一次平台账单快照累计用度：USD {number.format(usage.lastCycleUsedUsd)}</span>
                )}
              </div>
            )}
            {tool.fromHistory && tool.diagnostic === "local_server_offline" && (
              <small className="rc-subtle-note">
                当前展示最近一次有效周额度快照；打开 Antigravity 桌面端后点「采集最新额度」即可同步实时 5h 与周窗口。
              </small>
            )}
            {tool.applicable && !hasReadings && (
              tool.diagnostic === "auth_expired" ? (
                <div className="rc-diag">
                  <span>
                    实时接口返回登录态过期（HTTP 401）：① 打开 {tool.name} 桌面端刷新账号登录态后再点上方「采集最新额度」即可自动恢复；② 或直接校准本期百分比。
                  </span>
                  <button type="button" disabled={!!editing} onClick={() => startCalibrate(tool, linked[0])}>
                    校准本期额度
                  </button>
                </div>
              ) : tool.diagnostic === "local_server_offline" ? (
                <div className="rc-diag">
                  <span>
                    未检测到运行中的本地语言服务：打开 {tool.name} 桌面端后点「采集最新额度」，或手动登记本期额度。
                  </span>
                  <button type="button" disabled={!!editing} onClick={() => startCalibrate(tool, linked[0])}>
                    校准本期额度
                  </button>
                </div>
              ) : (
                <p>余量未知</p>
              )
            )}
            {calibratingTool === tool.tool && editing && (
              <PlanForm
                initial={editing === "new" ? undefined : editing}
                prefill={editing === "new" ? prefill : undefined}
                onSave={saved}
                onClose={() => { setEditing(null); setPrefill(undefined); setCalibratingTool(null); }}
              />
            )}
          </article>;
        })}</div>
      </section>
      {index && <section><header><h2>手动登记的套餐</h2><button className="rc-primary" disabled={!!editing || loading}
        onClick={() => { setPrefill(undefined); setCalibratingTool(null); setEditing("new"); setNotice(""); }}>登记套餐</button></header>
        {!index.plans.length && !editing && <p>可补充其他供应商的额度、预付余额或订阅到期信息。</p>}
        {notice && <p role="status">{notice}</p>}
        {editing === "new" && !calibratingTool && <PlanForm prefill={prefill} onSave={saved} onClose={() => { setEditing(null); setPrefill(undefined); }}/>}
        {index.plans.map(plan => <article className="rc-plan" key={plan.id}><header>
          <div><h3>{plan.name}</h3>{plan.window && <small>{plan.window}</small>}</div>
          <Reading reading={plan} unit={plan.unit} capacity={plan.capacity} now={now}/>
          <button disabled={!!editing || loading} onClick={() => { setCalibratingTool(null); setEditing(plan); setNotice(""); }}>更新套餐</button></header>
          {plan.fee !== null && <p>订阅费用 · {plan.currency} {number.format(plan.fee)} / {plan.billingCycle === "yearly" ? "年" : "月"}</p>}
          <p>核对 · {time(plan.observedAt)}　重置 · {time(plan.resetsAt)}　续费 · {plan.renewsOn ?? "未知"}</p>
          {editing !== "new" && !calibratingTool && editing?.id === plan.id && <PlanForm initial={editing} onSave={saved} onClose={() => setEditing(null)}/>}
        </article>)}
      </section>}
      {hub && <details className="rc-fees"><summary>订阅月费记录{hub.fees.length > 0 && " · " + hub.fees.length + " 项"}</summary>
        <p>月费取自 Agent Hub 的套餐配置，套餐名称和核对日期沿用费用记录。</p>
        {hub.fees.length ? <ul>{hub.fees.map((fee, i) => <li key={i}>
          <div><b>{fee.plan}</b><small>{fee.tool} · 核对 {fee.checked ?? "日期未知"}
            {fee.until && " · 截至 " + fee.until}{fee.since && " · 起于 " + fee.since}</small></div>
          <span>{!fee.paid ? "未计入订阅月费" : fee.monthlyUsd === null ? "月费未知" : "USD " + number.format(fee.monthlyUsd) + " / 月"}</span>
        </li>)}</ul> : <p>{hub.feesAvailable ? "尚未登记订阅月费。" : "暂时无法读取月费记录。"}</p>}
      </details>}
    </div>
  </section>;
}
