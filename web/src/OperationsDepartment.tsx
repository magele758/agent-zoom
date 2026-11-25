import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  serviceHealthLabels,
  updateOutcomeLabels,
  type DeployedServiceEntry,
  type FleetMachine,
  type ManagedService,
  type OperationsIndex,
  type OperationsTopology,
} from "../../src/operations-department-types";
import { request } from "./api";
import { chatRoomLink, stageLink } from "./zoom-routes";
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
function fmtGb(mb: number | null) {
  return mb === null ? "—" : (mb / 1024).toFixed(1) + " GB";
}

const connectionLabels: Record<FleetMachine["connection"], { label: string; tone: "good" | "relay" | "" }> = {
  local: { label: "本机在线", tone: "good" },
  direct: { label: "Tailscale 直连", tone: "good" },
  relay: { label: "Tailscale 中继", tone: "relay" },
  offline: { label: "离线", tone: "" },
};

const sourceLabels: Record<DeployedServiceEntry["source"], string> = {
  probe: "实时探针",
  registry: "台账登记",
  tmux: "远端 tmux",
  tailscale_serve: "Tailscale Serve",
};

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

function FleetSection({
  topology,
  busy,
  error,
  selectedMachine,
  onSelectMachine,
  onRefresh,
  onRegister,
}: {
  topology: OperationsTopology | null;
  busy: boolean;
  error: string;
  selectedMachine: string;
  onSelectMachine: (machineId: string) => void;
  onRefresh: () => void;
  onRegister: (draft: { name: string; host?: string; endpoint?: string }) => void;
}) {
  const [showOffline, setShowOffline] = useState(false);
  const machines = topology?.machines ?? [];
  const onlineMachines = machines.filter(m => m.online);
  const visibleMachines = showOffline ? machines : machines.filter(m => m.online || m.ncpu !== null);
  const offlineHidden = machines.length - visibleMachines.length;
  const deployments = topology?.deployments ?? [];
  const filteredDeployments = selectedMachine
    ? deployments.filter(d => d.machineId === selectedMachine)
    : deployments;
  const serviceCountByMachine = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of deployments) map.set(d.machineId, (map.get(d.machineId) ?? 0) + 1);
    return map;
  }, [deployments]);

  return <>
    <section className="ops-block" aria-label="Tailscale 机器集群">
      <header>
        <h2>Tailscale 机器集群</h2>
        <div className="ops-actions">
          {offlineHidden > 0 && (
            <button type="button" onClick={() => setShowOffline(v => !v)}>
              {showOffline ? "只看在线与主力机" : `显示离线节点（+${offlineHidden}）`}
            </button>
          )}
          {showOffline && offlineHidden === 0 && machines.some(m => !m.online && m.ncpu === null) && (
            <button type="button" onClick={() => setShowOffline(false)}>只看在线与主力机</button>
          )}
          <button type="button" disabled={busy} onClick={onRefresh}>
            {busy ? "刷新中…" : "重新检查集群与服务"}
          </button>
        </div>
      </header>
      {busy && !topology && <p role="status">正在读取 Tailscale 节点与服务运行状态…</p>}
      {error && <p role="alert">{error}</p>}
      {topology && <>
        <p className="ops-fleet-summary">
          检查完成于 <When at={topology.checkedAt}/> · 共 {machines.length} 台机器（<strong>{onlineMachines.length} 台在线</strong>，
          {onlineMachines.filter(m => m.connection === "direct" || m.connection === "local").length} 台直连/本机
          {onlineMachines.filter(m => m.connection === "relay").length > 0 ? `，${onlineMachines.filter(m => m.connection === "relay").length} 台中继` : ""}）
          · 已发现 <strong>{deployments.length}</strong> 项部署服务（{deployments.filter(d => d.healthy === true).length} 项在线）
        </p>
        <div className="ops-fleet-grid">
          {visibleMachines.map(machine => {
            const conn = connectionLabels[machine.connection];
            const count = serviceCountByMachine.get(machine.id) ?? 0;
            const selected = selectedMachine === machine.id;
            return <article key={machine.id + machine.ip} className="ops-machine" data-online={machine.online} data-selected={selected}>
              <div className="ops-machine-head">
                <h3>{machine.name}</h3>
                <span className="ops-pill" data-tone={conn.tone}>{conn.label}</span>
              </div>
              <div className="ops-machine-net">
                <span>{machine.os}</span>
                {machine.ip && <span>{machine.ip}</span>}
                {machine.dnsName && <span>{machine.dnsName}</span>}
                {machine.relay && machine.connection === "relay" && <span>DERP: {machine.relay}</span>}
              </div>
              {(machine.ncpu !== null || machine.memTotalMb !== null || machine.gpus.length > 0 || machine.tmuxSessions.length > 0 || machine.activeAgents > 0) && (
                <div className="ops-machine-metrics">
                  {machine.ncpu !== null && (
                    <span>CPU {machine.ncpu} 核 · 负载 {machine.load1 ?? "—"} · 可用内存 {fmtGb(machine.memFreeMb)} / {fmtGb(machine.memTotalMb)}</span>
                  )}
                  {machine.gpus.map((gpu, i) => (
                    <span key={i}>GPU · {gpu.name}（显存 {fmtGb(gpu.memUsedMb)} / {fmtGb(gpu.memTotalMb)}{gpu.utilPct !== null ? ` · 利用率 ${gpu.utilPct}%` : ""}）</span>
                  ))}
                  {machine.tmuxSessions.length > 0 && (
                    <div className="ops-machine-tags">
                      {machine.tmuxSessions.map(s => <code key={s}>tmux:{s}</code>)}
                    </div>
                  )}
                  {machine.activeAgents > 0 && <span>活跃编码 Agent：{machine.activeAgents}</span>}
                </div>
              )}
              {machine.serveRoutes.length > 0 && (
                <div className="ops-machine-tags">
                  {machine.serveRoutes.map(r => (
                    <span key={r.httpsPort} className="ops-pill" data-tone={r.healthy ? "good" : "warn"}>
                      HTTPS :{r.httpsPort} → {r.target.replace(/^https?:\/\/127\.0\.0\.1/, "")}
                    </span>
                  ))}
                </div>
              )}
              <div className="ops-machine-foot">
                <span>
                  {machine.online
                    ? `${count} 项服务`
                    : machine.lastSeen ? <>上次在线 <When at={machine.lastSeen}/></> : "离线"}
                </span>
                <button type="button" onClick={() => onSelectMachine(selected ? "" : machine.id)}>
                  {selected ? "查看全部机器" : `筛选本机服务（${count}）`}
                </button>
              </div>
            </article>;
          })}
        </div>
      </>}
    </section>

    <section className="ops-block" aria-label="各机器部署服务与运行情况">
      <header>
        <h2>各机器部署服务与运行情况</h2>
        {selectedMachine && <button type="button" onClick={() => onSelectMachine("")}>显示全部机器</button>}
      </header>
      {topology && <>
        <div className="ops-machine-tabs" role="group" aria-label="按机器筛选服务">
          <button type="button" aria-pressed={selectedMachine === ""} onClick={() => onSelectMachine("")}>
            全部机器 · {deployments.length}
          </button>
          {machines.filter(m => (serviceCountByMachine.get(m.id) ?? 0) > 0).map(m => (
            <button key={m.id} type="button" aria-pressed={selectedMachine === m.id} onClick={() => onSelectMachine(m.id)}>
              {m.name} · {serviceCountByMachine.get(m.id) ?? 0}
            </button>
          ))}
        </div>
        {filteredDeployments.length === 0 ? <p>该机器当前未发现已部署服务，可在下方服务台账登记。</p> : (
          <div className="ops-deploy-wrap opc-table-scroll" role="region" aria-label="已部署服务" tabIndex={0}>
            <table className="ops-deploy-table">
              <thead>
                <tr>
                  <th>服务与来源</th>
                  <th>部署机器</th>
                  <th>实时运行状态</th>
                  <th>端点 / Tailnet 入口</th>
                  <th>实时摘要</th>
                  <th>台账操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredDeployments.map(item => (
                  <tr key={item.id}>
                    <td>
                      <span className="ops-deploy-name">{item.name}</span>
                      <span className="ops-deploy-sub">{sourceLabels[item.source]} · {item.scope}{item.version ? ` · v${item.version}` : ""}</span>
                    </td>
                    <td>
                      <span className="ops-deploy-name">{item.machineName}</span>
                      {item.machineIp && <span className="ops-deploy-sub">{item.machineIp}</span>}
                    </td>
                    <td>
                      <span className="ops-pill" data-tone={item.healthy === true ? "good" : item.healthy === false ? "warn" : ""}>
                        {item.healthy === true ? `运行中${item.latencyMs !== null ? ` · ${item.latencyMs} ms` : ""}`
                          : item.healthy === false ? "不可达"
                          : "未配置探针"}
                      </span>
                    </td>
                    <td>
                      {item.endpoint && <code>{item.endpoint}</code>}
                      {item.publicUrl && <span className="ops-deploy-sub"><a href={item.publicUrl} target="_blank" rel="noreferrer">{item.publicUrl} ↗</a></span>}
                    </td>
                    <td>{item.summary}</td>
                    <td>
                      {item.managedServiceId ? (
                        <a href={`#ops-service-${item.managedServiceId}`} onClick={e => {
                          e.preventDefault();
                          document.getElementById(`ops-service-${item.managedServiceId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}>定位台账 ↓</a>
                      ) : (
                        <button type="button" onClick={() => onRegister({ name: item.name, host: item.machineName, endpoint: item.endpoint.startsWith("http") ? item.endpoint : "" })}>
                          登记到台账
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>}
    </section>
  </>;
}

function ServiceCard({
  service,
  live,
  machines,
  onChange,
  onReload,
}: {
  service: ManagedService;
  live?: DeployedServiceEntry;
  machines: FleetMachine[];
  onChange: (next: ManagedService) => void;
  onReload: () => void;
}) {
  const [action, setAction] = useState<"" | "observation" | "plan" | "result" | "deployment">("");
  const [editingPlan, setEditingPlan] = useState<{ id: string; target: string } | null>(null);
  const [syncingProbe, setSyncingProbe] = useState(false);
  const latest = service.observations[0];
  const plan = service.updates[0]?.result === null ? service.updates[0] : null;

  const save = async (fields: Record<string, string>, id: string) => {
    if (action === "deployment") {
      const next = await request<ManagedService>(base + "/services/" + service.id + "/deployment", {
        method: "PATCH",
        body: JSON.stringify({ host: fields.host ?? "", endpoint: fields.endpoint ?? "" }),
      });
      onChange(next);
      onReload();
      setAction("");
      return;
    }
    const event = { ...fields, kind: action, ...(action === "result" && editingPlan ? { planId: editingPlan.id } : {}) };
    const next = await request<ManagedService>(base + "/services/" + service.id + "/events", {
      method: "POST", body: JSON.stringify({ id, revision: service.revision, event }),
    });
    onChange(next); setAction("");
  };

  const syncLiveProbeToLog = async () => {
    if (!live || live.healthy === null || syncingProbe) return;
    setSyncingProbe(true);
    try {
      const next = await request<ManagedService>(base + "/services/" + service.id + "/events", {
        method: "POST",
        body: JSON.stringify({
          id: crypto.randomUUID(),
          revision: service.revision,
          event: {
            kind: "observation",
            health: live.healthy ? "healthy" : "outage",
            source: `实时探针 · ${live.machineName}${live.endpoint ? ` (${live.endpoint})` : ""}`,
            note: `${live.healthy ? "端点运行正常" : "端点不可达"}${live.latencyMs !== null ? `（延迟 ${live.latencyMs} ms）` : ""}${live.summary ? ` · ${live.summary}` : ""}`,
          },
        }),
      });
      onChange(next);
    } finally {
      setSyncingProbe(false);
    }
  };

  const hostLabel = service.host || live?.machineName || "";
  const endpointLabel = service.endpoint || live?.endpoint || "";

  return <article className="ops-service" id={`ops-service-${service.id}`}>
    <header>
      <h3>{service.name}</h3>
      <div className="ops-service-badges">
        {live && live.healthy !== null && (
          <span className="ops-pill" data-tone={live.healthy ? "good" : "warn"}>
            {live.healthy ? `实时在线${live.latencyMs !== null ? ` · ${live.latencyMs} ms` : ""}` : "探针不可达"}
          </span>
        )}
        <small data-tone={!latest ? "" : latest.health === "healthy" ? "good" : "warn"}>
          {latest ? `巡检：${serviceHealthLabels[latest.health]}` : live?.healthy !== null && live ? "尚未人工建档" : "待巡检"}
        </small>
      </div>
    </header>
    <div className="ops-meta">
      {service.scope ? <a href={"#projects" + scopeQuery(service.scope)}>{service.scope} ↗</a> : "公司共用"}
      {" · 最近确认版本 "}{service.version || "待确认"}
      {hostLabel && <> · 部署机器 <strong>{hostLabel}</strong>{live?.machineIp ? ` (${live.machineIp})` : ""}</>}
      {latest && <> · 巡检登记于 <When at={latest.at}/></>}
    </div>
    {(live || endpointLabel) && (
      <div className="ops-live-strip" data-tone={live?.healthy === false ? "warn" : "good"}>
        <span><strong>运行概况：</strong>{live?.summary || (endpointLabel ? "已配置端点" : "等待探针")}</span>
        {endpointLabel && <span>端点：<code>{endpointLabel}</code></span>}
        {live?.publicUrl && <a href={live.publicUrl} target="_blank" rel="noreferrer">Tailnet 入口 ↗</a>}
      </div>
    )}
    {latest && <p>{latest.note} <small>依据 · {latest.source}</small></p>}
    {plan && <p>计划更新至 <strong>{plan.target}</strong> · {plan.note}</p>}
    {!action && <div className="ops-actions">
      {live && live.healthy !== null && (
        <button type="button" disabled={syncingProbe} onClick={() => void syncLiveProbeToLog()}>
          {syncingProbe ? "写入中…" : "同步实时状态到巡检"}
        </button>
      )}
      <button type="button" onClick={() => setAction("observation")}>记录巡检</button>
      <button type="button" onClick={() => { setEditingPlan(plan); setAction(plan ? "result" : "plan"); }}>{plan ? "登记更新结果" : "计划更新"}</button>
      <button type="button" onClick={() => setAction("deployment")}>部署机器/端点</button>
      {service.scope && <a href={stageLink("operations", service.scope)}>查看运维阶段 ↗</a>}
      <a href={chatRoomLink({ project: service.scope || undefined, draft: `运维跟进「${service.name}」${service.version ? "（" + service.version + "）" : ""}：\n${latest ? "最近巡检：" + serviceHealthLabels[latest.health] + " · " + latest.note : live?.summary ? "实时状态：" + live.summary : "当前待巡检"}` })}>在群聊讨论 ↗</a>
    </div>}
    {action && <Editor key={action} onSave={save} onReload={onReload} onCancel={() => setAction("")}
      button={action === "observation" ? "保存巡检" : action === "plan" ? "保存计划" : action === "deployment" ? "保存部署信息" : "保存结果"}>
      {action === "deployment" && <>
        <label>部署机器
          <input list={`ops-hosts-${service.id}`} name="host" defaultValue={hostLabel} placeholder="选择或输入 Tailscale 机器名" maxLength={160}/>
          <datalist id={`ops-hosts-${service.id}`}>
            {machines.map(m => <option key={m.id} value={m.name}>{m.ip ? `${m.name} (${m.ip})` : m.name}</option>)}
          </datalist>
        </label>
        <label>健康检查 / 访问端点（可选，支持本机或 Tailscale 100.x IP）
          <input name="endpoint" defaultValue={endpointLabel} placeholder="例如 http://127.0.0.1:8000 或 http://100.x.x.x:8188" maxLength={500}/>
        </label>
      </>}
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
  const [topology, setTopology] = useState<OperationsTopology | null>(null);
  const [topoBusy, setTopoBusy] = useState(true);
  const [topoError, setTopoError] = useState("");
  const [selectedMachine, setSelectedMachine] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<{ name: string; host?: string; endpoint?: string } | null>(null);
  const [watchdog, setWatchdog] = useState<{
    disk?: { freeGb: number; totalGb: number; freePct: number; healthy: boolean };
    sqlite?: { quickCheck: string; journalMode: string; healthy: boolean };
    uptimes?: Array<{ targetId: string; uptimePct: number; latestHealthy: boolean; latestDetail: string }>;
    uptimeByTarget?: Array<{ targetId: string; uptimePct: number; latestHealthy: boolean; latestDetail: string }>;
    remediations?: Array<{ id: string; targetId: string; action: string; outcome: string; detail: string; createdAt: string }>;
  } | null>(null);
  const [watchdogBusy, setWatchdogBusy] = useState(false);

  const reload = () => setRevision(n => n + 1);

  useEffect(() => {
    const controller = new AbortController();
    setError(""); setTopoError(""); setTopoBusy(true);
    request<OperationsIndex>(base, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    request<OperationsTopology>(base + "/topology", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setTopology(result); })
      .catch(reason => { if (!controller.signal.aborted) setTopoError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setTopoBusy(false); });
    request<NonNullable<typeof watchdog>>("/api/opc/domains/ops/watchdog", { signal: controller.signal })
      .then(w => { if (!controller.signal.aborted) setWatchdog(w); })
      .catch(() => {});
    return () => controller.abort();
  }, [revision]);

  const runWatchdogNow = async () => {
    setWatchdogBusy(true);
    try {
      await request("/api/opc/domains/ops/watchdog/run", {
        method: "POST",
        body: JSON.stringify({ forceHeal: true }),
      });
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "执行自愈巡检失败");
    } finally {
      setWatchdogBusy(false);
    }
  };

  const liveByServiceId = useMemo(() => {
    const map = new Map<string, DeployedServiceEntry>();
    for (const d of topology?.deployments ?? []) {
      if (d.managedServiceId) map.set(d.managedServiceId, d);
    }
    return map;
  }, [topology]);

  const query = new URLSearchParams(location.hash.split("?")[1]);
  const scope = [query.get("product"), query.get("project")].filter(Boolean).join("/");
  const services = data?.services.filter(s => !scope || s.scope === scope || s.scope.startsWith(scope + "/")) ?? [];
  const update = (next: ManagedService) => setData(old => old && ({
    ...old, services: [...old.services.filter(s => s.id !== next.id), next].sort((a,b) => a.name.localeCompare(b.name, "zh-CN")),
  }));
  const openDraft = (entry: { name: string; host?: string; endpoint?: string }) => {
    setDraft(entry);
    requestAnimationFrame(() => document.getElementById("ops-register-name")?.focus());
  };

  return <section className="zo-product ops-dept" aria-label="运维部门">
    <header className="zo-product-head">{nav}<h1>05 · 稳定性与自愈运维部</h1></header>
    <div className="ops-main">
      <section className="ops-block" aria-label="常驻自愈守护">
        <header>
          <h2>常驻自愈守护 (OpsWatchdog)</h2>
          <button type="button" disabled={watchdogBusy} onClick={() => void runWatchdogNow()}>
            {watchdogBusy ? "巡检自愈中…" : "立即执行全量巡检与自愈"}
          </button>
        </header>
        <p style={{ fontSize: "0.85rem", margin: "4px 0 10px" }}>
          后台每 5 分钟自动检测本机磁盘余量、SQLite WAL 健康度、商业附属套件存活与 CLI 登录态；挂死服务自动带退避拉起，高频崩溃自动转交产品部立项修复。
        </p>
        {watchdog && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: "0.84rem", marginBottom: 8 }}>
            {watchdog.disk && (
              <span>
                <strong>本机磁盘：</strong>
                {watchdog.disk.freeGb.toFixed(1)} GB 可用 ({watchdog.disk.freePct.toFixed(1)}%) ·{" "}
                {watchdog.disk.healthy ? "健康" : "空间告急"}
              </span>
            )}
            {watchdog.sqlite && (
              <span>
                <strong>主库状态：</strong>
                {watchdog.sqlite.quickCheck} ({watchdog.sqlite.journalMode})
              </span>
            )}
            {(watchdog.uptimes ?? watchdog.uptimeByTarget ?? []).map(u => (
              <span key={u.targetId}>
                <strong>{u.targetId}：</strong>可用率 {u.uptimePct}%
              </span>
            ))}
          </div>
        )}
        {watchdog?.remediations && watchdog.remediations.length > 0 && (
          <ul style={{ fontSize: "0.82rem", margin: 0 }}>
            {watchdog.remediations.slice(0, 4).map(r => (
              <li key={r.id}>
                <code>{r.targetId}</code> · {r.action} → <strong>{r.outcome}</strong> ({r.detail})
              </li>
            ))}
          </ul>
        )}
      </section>
      <FleetSection
        topology={topology}
        busy={topoBusy}
        error={topoError}
        selectedMachine={selectedMachine}
        onSelectMachine={setSelectedMachine}
        onRefresh={reload}
        onRegister={openDraft}
      />
      <section className="ops-block" aria-label="服务台账"><header><h2>服务台账</h2>
        {data && <button type="button" onClick={() => openDraft({ name: "" })}>登记服务</button>}</header>
        {error && <p role="alert">{error} <button type="button" onClick={reload}>重新读取</button></p>}
        {!data && !error && <p role="status">正在读取服务台账…</p>}
        {data && <>
          <label className="ops-filter">归属范围<select value={scope}
            onChange={e => { setDraft(null); location.hash = "#operations-department" + scopeQuery(e.target.value); }}>
            <option value="">全部服务</option>
            {scope && !data.scopes.includes(scope) && <option>{scope}</option>}
            {data.scopes.map(item => <option key={item}>{item}</option>)}
          </select></label>
          {draft !== null && <Editor key={JSON.stringify([scope, draft])} button="保存服务" onReload={reload} onCancel={() => setDraft(null)} onSave={async (fields, id) => {
            const next = await request<ManagedService>(base + "/services", { method: "POST", body: JSON.stringify({ ...fields, id }) });
            update(next); setDraft(null); reload();
            if (scope && next.scope !== scope && !next.scope.startsWith(scope + "/")) {
              location.hash = "#operations-department" + scopeQuery(next.scope);
            }
          }}>
            <label>服务名称<input id="ops-register-name" name="name" defaultValue={draft.name} required maxLength={160}/></label>
            <label>所属产品或项目<select name="scope" defaultValue={data.scopes.includes(scope) ? scope : ""}>
              <option value="">公司共用</option>{data.scopes.map(item => <option key={item}>{item}</option>)}</select></label>
            <label>当前版本（可选）<input name="version" maxLength={160}/></label>
            <label>部署机器（可选）
              <input list="ops-register-hosts" name="host" defaultValue={draft.host ?? ""} placeholder="选择或输入 Tailscale 机器名" maxLength={160}/>
              <datalist id="ops-register-hosts">
                {(topology?.machines ?? []).map(m => <option key={m.id} value={m.name}>{m.ip ? `${m.name} (${m.ip})` : m.name}</option>)}
              </datalist>
            </label>
            <label>健康检查 / 访问端点（可选）
              <input name="endpoint" defaultValue={draft.endpoint ?? ""} placeholder="例如 http://127.0.0.1:8000 或 http://100.x.x.x:8188" maxLength={500}/>
            </label>
          </Editor>}
          {services.length === 0 ? <p>当前范围还没有登记服务。</p> :
            <div className="ops-services">{services.map(service => (
              <ServiceCard
                key={service.id}
                service={service}
                live={liveByServiceId.get(service.id)}
                machines={topology?.machines ?? []}
                onChange={update}
                onReload={reload}
              />
            ))}</div>}
        </>}
      </section>
    </div>
  </section>;
}
