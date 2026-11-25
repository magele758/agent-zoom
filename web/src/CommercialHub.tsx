import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CommercialOverview, PortfolioRole } from "../../src/commercial-types";
import { request } from "./api";
import "./commercial.css";

const roleLabels: Record<PortfolioRole, string> = {
  flagship_paid: "旗舰付费",
  open_core: "Open-Core",
  lead_magnet: "流量钩子",
  internal_infra: "对内基建",
  archive_candidate: "归档收口",
};

function formatMoney(minor: number, currency: string) {
  const digits = new Intl.NumberFormat("zh-CN", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency, currencyDisplay: "code" }).format(
    minor / 10 ** digits,
  );
}

export function CommercialHub({ nav }: { nav: ReactNode }) {
  const [data, setData] = useState<CommercialOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editingPilot, setEditingPilot] = useState(false);
  const [tab, setTab] = useState<"bridge" | "layers" | "license" | "gtm" | "support">("bridge");
  const [toolOutput, setToolOutput] = useState<string>("");
  const [bridgeData, setBridgeData] = useState<{
    ledger?: {
      companionOnline: boolean;
      source: string;
      grossRevenueUsd: number;
      refundsUsd: number;
      commerceCostUsd: number;
      internalAiMonthlyUsd: number;
      factoryTokenCostUsd: number;
      netUsd: number;
      products: Array<{ product: string; ordersCount: number; activeLicenses: number; grossUsd: number; netUsd: number }>;
    };
    crm?: {
      totalCustomers: number;
      customers: Array<{
        customerId: string;
        emailMasked: string;
        channel: string;
        ordersCount: number;
        activeLicenses: number;
        openTickets: number;
        stage: string;
      }>;
    };
    crmSummary?: {
      totalCustomers: number;
      recentCustomers?: Array<{
        customerId: string;
        emailMasked: string;
        channel: string;
        ordersCount: number;
        activeLicenses: number;
        openTickets: number;
        stage: string;
      }>;
    };
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await request<CommercialOverview>("/api/opc/commercial/overview");
      setData(next);
      setError("");
      request<NonNullable<typeof bridgeData>>("/api/opc/domains/commercial/bridge")
        .then((b) => setBridgeData(b))
        .catch(() => {});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取商业与治理总览失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (label: string, path: string, body: unknown = {}, method = "POST") => {
    setBusy(true);
    setError("");
    setNotice(`正在执行：${label}…`);
    try {
      const result = await request<Record<string, unknown>>(path, {
        method,
        body: JSON.stringify(body),
      });
      await load();
      if (path.endsWith("/closed-loop")) {
        setNotice(
          `全链路闭环演练成功：订单 ${String(result.orderId)} · 离线授权验签=${result.licenseVerified ? "通过" : "异常"}`,
        );
        setToolOutput(JSON.stringify(result, null, 2));
      } else if (path.endsWith("/bootstrap")) {
        setNotice(
          `公司全景已纳管：${String(result.productsCount)} 个产品族 · ${String(result.projectsCount)} 个子项目 · ${String(result.linesConfigured)} 条核心业务线就绪`,
        );
      } else if (path.endsWith("/ensure")) {
        const started = Array.isArray(result.started) ? result.started : [];
        setNotice(started.length ? `已自动拉起并配好服务：${started.join("、")}` : "所有可管理依赖服务均已在线就绪");
      } else if (path.endsWith("/sync-analytics")) {
        setNotice(String(result.summary || "已同步至 data_analysis"));
      } else {
        setNotice(`${label}已完成`);
      }
      return result;
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : `${label}失败`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const savePilot = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const ok = await runAction(
      "更新 1 号变现试点",
      "/api/opc/commercial/pilot",
      {
        product: String(fd.get("product") ?? "").trim(),
        project: String(fd.get("project") ?? "").trim(),
        slug: String(fd.get("slug") ?? "").trim(),
        targetPrice: String(fd.get("targetPrice") ?? "").trim(),
        freezeNewInfraRepos: fd.get("freezeNewInfraRepos") === "on",
        note: String(fd.get("note") ?? "").trim(),
      },
      "PUT",
    );
    if (ok) setEditingPilot(false);
  };

  const handleIssueLicense = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const res = await runAction("签发离线 License", "/api/opc/commercial/actions/issue-license", {
      product: String(fd.get("product") ?? data?.pilot.product ?? "PageLens").trim(),
      plan: String(fd.get("plan") ?? "pro_buyout").trim(),
      customerId: String(fd.get("customerId") ?? "cust_manual_01").trim(),
      maxDevices: Number(fd.get("maxDevices") ?? 2),
      features: String(fd.get("features") ?? "pro,offline_dubbing")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    if (res) setToolOutput(JSON.stringify(res, null, 2));
  };

  const handleVerifyLicense = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const key = String(fd.get("licenseKey") ?? "").trim();
    const res = await runAction("验签离线 License", "/api/opc/commercial/actions/verify-license", {
      licenseKey: key,
      token: key,
      product: String(fd.get("product") ?? "").trim() || undefined,
    });
    if (res) setToolOutput(JSON.stringify(res, null, 2));
  };

  const handleGenerateGtm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const res = await runAction("生成门面合规与多平台 UTM 推广包", "/api/opc/commercial/actions/generate-gtm", {
      product: String(fd.get("product") ?? data?.pilot.product ?? "PageLens").trim(),
      slug: String(fd.get("slug") ?? data?.pilot.slug ?? "pagelens-interpret").trim(),
      title: String(fd.get("title") ?? "").trim(),
      summary: String(fd.get("summary") ?? "").trim(),
      highlights: String(fd.get("highlights") ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      baseUrl: String(fd.get("baseUrl") ?? "https://opc.example.com/pagelens-interpret").trim(),
      campaign: String(fd.get("campaign") ?? "launch-v1").trim(),
    });
    if (res) setToolOutput(JSON.stringify(res, null, 2));
  };

  const handleSubmitTicket = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const res = await runAction("提交客服工单自动分诊", "/api/opc/commercial/actions/submit-ticket", {
      product: String(fd.get("product") ?? data?.pilot.product ?? "PageLens").trim(),
      project: String(fd.get("project") ?? data?.pilot.project ?? "pagelens-interpret").trim(),
      channel: String(fd.get("channel") ?? "in_app").trim(),
      customerId: String(fd.get("customerId") ?? "cust_feedback_01").trim(),
      subject: String(fd.get("subject") ?? "").trim(),
      body: String(fd.get("body") ?? "").trim(),
    });
    if (res) setToolOutput(JSON.stringify(res, null, 2));
  };

  const primaryCurrency = data?.metrics.currencies[0];
  const gtmService = data?.services.find((s) => s.id === "gtm");
  const daService = data?.services.find((s) => s.id === "data_analysis");

  return (
    <section className="zo-product cm-page" aria-label="商业与公司治理">
      <header className="cm-head">
        <div>
          <div className="cm-title-row">
            {nav}
            <h1>商业闭环与公司治理</h1>
          </div>
          <p className="cm-sub">
            串联 L0–L6 七层架构：把供给侧产研工厂与 L5 收银授权、GTM 门面、客服遥测及 L4 DuckDB 经营分析合为一体。
          </p>
        </div>
        <div className="cm-toolbar">
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction("纳管公司 7 层全景与业务线", "/api/opc/commercial/bootstrap")}
          >
            1. 一键纳管公司全景
          </button>
          <button
            type="button"
            className="cm-primary"
            disabled={busy}
            onClick={() => void runAction("拉起并联动依赖服务", "/api/opc/commercial/services/ensure")}
          >
            2. 一键拉起依赖服务
          </button>
          <button
            type="button"
            className="cm-accent"
            disabled={busy}
            onClick={() => void runAction("沙盒演练首单闭环", "/api/opc/commercial/actions/closed-loop", { sandbox: true })}
          >
            3. 沙盒演练首单闭环（不污染生产）
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction("同步至 data_analysis", "/api/opc/commercial/actions/sync-analytics", {})}
          >
            同步 DuckDB 漏斗
          </button>
        </div>
      </header>

      {notice && <p role="status" className="cm-banner">{notice}</p>}
      {error && <p role="alert" className="cm-banner error">{error}</p>}
      {!data && !error && <p role="status">正在读取公司全景与服务状态…</p>}

      {data && (
        <>
          <div className="cm-kpis" aria-label="核心经营指标">
            <div className="cm-kpi">
              <span>净营收（扣除退款与算力成本）</span>
              <strong>
                {primaryCurrency
                  ? formatMoney(primaryCurrency.netMinor, primaryCurrency.currency)
                  : "$0.00"}
              </strong>
              <small>
                {primaryCurrency
                  ? `毛利率 ${primaryCurrency.grossMarginPct ?? 100}% · 总收款 ${formatMoney(primaryCurrency.grossMinor, primaryCurrency.currency)}`
                  : "等待首笔订单入账"}
              </small>
            </div>
            <div className="cm-kpi">
              <span>订单与离线 License</span>
              <strong>{data.metrics.orders} / {data.metrics.activeLicenses}</strong>
              <small>累计订单数 / 有效 Ed25519 授权数</small>
            </div>
            <div className="cm-kpi">
              <span>试点转化漏斗（获客→激活→首单）</span>
              <strong>
                {data.metrics.funnel.acquired} → {data.metrics.funnel.activated} → {data.metrics.funnel.firstOrder}
              </strong>
              <small>
                复购 {data.metrics.funnel.repeatOrder} 人 · 候补私域 {data.metrics.waitlistSubscribers} 人
              </small>
            </div>
            <div className="cm-kpi">
              <span>客户工单与线上稳定度</span>
              <strong>{data.metrics.openTickets} 待办</strong>
              <small>
                待发版回访 {data.metrics.pendingFollowups} 单 · 无崩溃率{" "}
                {data.metrics.crashFreeRate !== null ? `${(data.metrics.crashFreeRate * 100).toFixed(1)}%` : "100%"}
              </small>
            </div>
          </div>

          <section className="cm-section" aria-label="1号变现试点与聚焦铁律">
            <div className="cm-section-head">
              <h2>1 号商业试点与聚焦铁律</h2>
              <div>
                {data.pilot.freezeNewInfraRepos && (
                  <span className="cm-badge warn">聚焦铁律生效：闭环跑通前冻结新开底层基建库</span>
                )}{" "}
                <button type="button" onClick={() => setEditingPilot(!editingPilot)}>
                  {editingPilot ? "收起设置" : "切换试点产品"}
                </button>
              </div>
            </div>

            <div className="cm-pilot-box">
              <div className="cm-pilot-top">
                <div>
                  <strong>
                    当前聚焦：{data.pilot.product} / {data.pilot.project}
                  </strong>{" "}
                  <span className="cm-badge ok">{data.pilot.targetPrice}</span>
                  <p className="cm-muted" style={{ margin: "4px 0 0" }}>{data.pilot.note}</p>
                </div>
                <strong>闭环就绪度 {data.completionPct}%</strong>
              </div>
              <div className="cm-progress-track" aria-hidden="true">
                <div className="cm-progress-bar" style={{ width: `${data.completionPct}%` }} />
              </div>

              {editingPilot && (
                <form className="cm-form" onSubmit={savePilot} style={{ marginBottom: 16 }}>
                  <div className="cm-form-row">
                    <label>
                      试点产品族
                      <input name="product" required defaultValue={data.pilot.product} />
                    </label>
                    <label>
                      子项目名
                      <input name="project" required defaultValue={data.pilot.project} />
                    </label>
                    <label>
                      门面标识 (slug)
                      <input name="slug" required defaultValue={data.pilot.slug} />
                    </label>
                    <label>
                      目标定价策略
                      <input name="targetPrice" required defaultValue={data.pilot.targetPrice} />
                    </label>
                  </div>
                  <label>
                    聚焦目标说明
                    <input name="note" defaultValue={data.pilot.note} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      name="freezeNewInfraRepos"
                      defaultChecked={data.pilot.freezeNewInfraRepos}
                    />
                    启用组合聚焦铁律（未跑通首单复盘前暂停新建底层基础设施仓库）
                  </label>
                  <div>
                    <button type="submit" className="cm-primary" disabled={busy}>保存试点配置</button>
                  </div>
                </form>
              )}

              <ol className="cm-checklist">
                {data.checklist.map((step, idx) => (
                  <li key={step.id} data-done={step.done}>
                    <a href={step.href}>
                      {step.done ? "✓ " : `${idx + 1}. `}
                      {step.label}
                    </a>
                    <small>{step.detail}</small>
                  </li>
                ))}
              </ol>

              {data.analytics && (
                <div className="cm-analytics-bar">
                  <span>
                    <strong>DuckDB 经营分析快照：</strong>
                    {data.analytics.summary}
                  </span>
                  {daService?.healthy && (
                    <a className="cm-inline-link" href={`${daService.origin}/dashboard`} target="_blank" rel="noreferrer">
                      打开 data_analysis 治理大盘 ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="cm-section" aria-label="依赖服务网格状态">
            <div className="cm-section-head">
              <h2>OPC 服务联动网格（开箱即用状态）</h2>
              <button type="button" disabled={busy} onClick={() => void load()}>刷新健康检查</button>
            </div>
            <div className="cm-services">
              {data.services.map((svc) => (
                <article className="cm-service" key={svc.id}>
                  <div className="cm-service-top">
                    <strong>
                      <i className={svc.healthy ? "cm-dot on" : "cm-dot"} aria-hidden="true" />
                      {svc.name}
                    </strong>
                    <span className="cm-badge">{svc.layer}</span>
                  </div>
                  <small>{svc.summary}{svc.latencyMs !== null ? ` · ${svc.latencyMs}ms` : ""}</small>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <small>{svc.origin}</small>
                    {svc.id === "gtm" && svc.healthy && (
                      <>
                        <a href={`${svc.origin}/preview`} target="_blank" rel="noreferrer">产品矩阵门户 ↗</a>
                        <a href={`${svc.origin}/preview/${data.pilot.slug}`} target="_blank" rel="noreferrer">
                          试点着陆页预览 ↗
                        </a>
                      </>
                    )}
                    {svc.id === "data_analysis" && svc.healthy && (
                      <a href={`${svc.origin}/dashboard`} target="_blank" rel="noreferrer">分析管道看板 ↗</a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="cm-section" aria-label="标准化业务线模板">
            <div className="cm-section-head">
              <h2>公司业务线打法库（一键套用立项）</h2>
              <a className="cm-inline-link" href="#business-lines">进入业务线工作台 ↗</a>
            </div>
            <div className="cm-playbooks">
              {data.playbooks.map((pb) => (
                <article className="cm-playbook" key={pb.id}>
                  <div>
                    <div className="cm-service-top">
                      <h4>{pb.title}</h4>
                      <span className="cm-badge">{pb.badge}</span>
                    </div>
                    <p className="cm-muted" style={{ margin: "6px 0" }}>{pb.summary}</p>
                    <ol>
                      {pb.line.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="cm-primary"
                      disabled={busy}
                      onClick={async () => {
                        const applied = await runAction(
                          `套用模板「${pb.title}」`,
                          `/api/opc/commercial/playbooks/${encodeURIComponent(pb.id)}/apply`,
                          { startTrial: true },
                        );
                        const line = applied?.line as { id?: string } | undefined;
                        if (line?.id) {
                          location.hash = "business-lines?line=" + encodeURIComponent(line.id);
                        }
                      }}
                    >
                      一键套用并开启首轮实验 ↗
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="cm-section" aria-label="商业操作与七层资产地图">
            <div className="cm-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "bridge"} onClick={() => setTab("bridge")}>
                统一外部总账 & 客户 CRM 桥接
              </button>
              <button type="button" role="tab" aria-selected={tab === "layers"} onClick={() => setTab("layers")}>
                OPC 7 层全景地图（L6→L0）
              </button>
              <button type="button" role="tab" aria-selected={tab === "license"} onClick={() => setTab("license")}>
                离线 License 签发与验签
              </button>
              <button type="button" role="tab" aria-selected={tab === "gtm"} onClick={() => setTab("gtm")}>
                门面·合规·多平台 UTM 改编
              </button>
              <button type="button" role="tab" aria-selected={tab === "support"} onClick={() => setTab("support")}>
                统一客服工单分诊（联动研发/Zoom）
              </button>
            </div>

            <div className="cm-panel">
              {tab === "bridge" && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                    <div>
                      <h3 style={{ margin: 0 }}>外部商业三件套标准桥接（收银总账 · 内部算力成本同步 · 客户 CRM 底座）</h3>
                      <small className="cm-muted">
                        收支与客户档案统一归口外部 Commerce / GTM / Ops 三件套；主控自动同步 AI 月费与暗工厂 Token 成本，成单后零改造即用。
                      </small>
                    </div>
                    <button
                      type="button"
                      className="cm-primary"
                      disabled={busy}
                      onClick={() => void runAction("同步内部 AI 订阅与暗工厂成本至 Commerce", "/api/opc/domains/commercial/sync-costs", {})}
                    >
                      同步内部算力/月费至 Commerce 总账
                    </button>
                  </div>

                  {bridgeData?.ledger && (
                    <div className="cm-kpis" style={{ marginBottom: 16 }}>
                      <div className="cm-kpi">
                        <span>外部真实订单净收款 (USD)</span>
                        <strong>${bridgeData.ledger.grossRevenueUsd.toFixed(2)}</strong>
                        <small>退款冲减 ${bridgeData.ledger.refundsUsd.toFixed(2)} · 来源 {bridgeData.ledger.source}</small>
                      </div>
                      <div className="cm-kpi">
                        <span>内部 AI 套餐月费 / 暗工厂 Token</span>
                        <strong>
                          ${bridgeData.ledger.internalAiMonthlyUsd.toFixed(2)} / ${bridgeData.ledger.factoryTokenCostUsd.toFixed(4)}
                        </strong>
                        <small>已联通 ResourceDept 与 DarkFactory 真实消耗</small>
                      </div>
                      <div className="cm-kpi">
                        <span>全公司综合净损益 (Net P&L)</span>
                        <strong>${bridgeData.ledger.netUsd.toFixed(2)}</strong>
                        <small>自动排除 sandbox 沙盒演练假单</small>
                      </div>
                      <div className="cm-kpi">
                        <span>纳管真实客户档案 (CRM)</span>
                        <strong>{bridgeData.crm?.totalCustomers ?? bridgeData.crmSummary?.totalCustomers ?? 0}</strong>
                        <small>串联来源渠道 · 候补 · 购买授权 · 客服工单</small>
                      </div>
                    </div>
                  )}

                  {(() => {
                    const crmCustomers = bridgeData?.crm?.customers ?? bridgeData?.crmSummary?.recentCustomers ?? [];
                    return crmCustomers.length > 0 ? (
                      <div className="opc-table-scroll" role="region" aria-label="客户明细" tabIndex={0}>
                        <table className="cm-customer-table">
                          <thead>
                            <tr>
                              <th scope="col">客户标识</th>
                              <th scope="col">来源渠道</th>
                              <th scope="col">生命周期阶段</th>
                              <th scope="col">订单 / 有效授权 / 待办工单</th>
                            </tr>
                          </thead>
                          <tbody>
                            {crmCustomers.slice(0, 20).map((c) => (
                              <tr key={c.customerId}>
                                <td>
                                  <strong>{c.customerId}</strong> {c.emailMasked && <small>({c.emailMasked})</small>}
                                </td>
                                <td>{c.channel || "direct"}</td>
                                <td><span className="cm-badge">{c.stage}</span></td>
                                <td>{c.ordersCount} 单 · {c.activeLicenses} 授权 · {c.openTickets} 工单</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="cm-muted">
                        当前暂无真实客户入库（CRM 与统一总账桥接底座已就绪，后续产品推向市场产生候补、激活或订单后将在此自动汇聚客户全生命周期）。
                      </p>
                    );
                  })()}
                </div>
              )}

              {tab === "layers" && (
                <div className="cm-layers">
                  {data.layers.map((layer) => (
                    <div className="cm-layer" key={layer.id}>
                      <div className="cm-layer-head">
                        <strong>{layer.id} · {layer.name}</strong>
                        <span className="cm-muted">{layer.subtitle}</span>
                      </div>
                      <div className="cm-layer-assets">
                        {layer.assets.map((asset) => (
                          <div className="cm-asset-card" key={asset.repo}>
                            <div className="cm-service-top">
                              <strong>{asset.project}</strong>
                              <span className="cm-badge">{roleLabels[asset.role]}</span>
                            </div>
                            <span>{asset.summary}</span>
                            <small className="cm-muted">
                              {asset.monetization} · {asset.enrolled ? "已纳管" : "待纳管"}
                            </small>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {tab === "license" && (
                <div className="cm-form-row" style={{ alignItems: "start" }}>
                  <form className="cm-form" onSubmit={handleIssueLicense}>
                    <h3>签发 Ed25519 离线 License Key</h3>
                    <label>
                      产品名
                      <input name="product" defaultValue={data.pilot.product} required />
                    </label>
                    <label>
                      套餐标识
                      <input name="plan" defaultValue="pro_buyout" required />
                    </label>
                    <label>
                      客户标识
                      <input name="customerId" defaultValue="cust_vip_001" required />
                    </label>
                    <label>
                      最大激活设备数
                      <input name="maxDevices" type="number" min={1} max={20} defaultValue={2} required />
                    </label>
                    <label>
                      解锁特性（逗号分隔）
                      <input name="features" defaultValue="pro,offline_dubbing,batch_queue" />
                    </label>
                    <button type="submit" className="cm-primary" disabled={busy}>生成签名 License</button>
                  </form>

                  <form className="cm-form" onSubmit={handleVerifyLicense}>
                    <h3>离线签名校验测试</h3>
                    <label>
                      OPCL1 License Key
                      <textarea name="licenseKey" rows={4} required placeholder="粘贴 OPCL1.xxx.yyy 授权码…" />
                    </label>
                    <label>
                      校验目标产品（可选）
                      <input name="product" defaultValue={data.pilot.product} />
                    </label>
                    <button type="submit" disabled={busy}>验证签名与有效期</button>
                  </form>
                </div>
              )}

              {tab === "gtm" && (
                <form className="cm-form" onSubmit={handleGenerateGtm}>
                  <h3>一键生成着陆页、商店隐私声明与 5 渠道带 UTM 推广稿</h3>
                  {gtmService?.healthy && (
                    <p className="cm-muted" style={{ margin: 0 }}>
                      在线门面预览：{" "}
                      <a className="cm-inline-link" href={`${gtmService.origin}/preview/${data.pilot.slug}`} target="_blank" rel="noreferrer">
                        打开产品着陆页 ↗
                      </a>{" "}
                      ·{" "}
                      <a className="cm-inline-link" href={`${gtmService.origin}/preview/${data.pilot.slug}/privacy`} target="_blank" rel="noreferrer">
                        打开商店隐私合规页 ↗
                      </a>
                    </p>
                  )}
                  <div className="cm-form-row">
                    <label>
                      产品名
                      <input name="product" defaultValue={data.pilot.product} required />
                    </label>
                    <label>
                      清单标识 (slug)
                      <input name="slug" defaultValue={data.pilot.slug} required />
                    </label>
                    <label>
                      活动批次 (utm_campaign)
                      <input name="campaign" defaultValue="launch-2026w47" required />
                    </label>
                  </div>
                  <label>
                    发布主标题
                    <input name="title" defaultValue="PageLens 同传 Pro：看外语长视频直接听纯享中文配音" required />
                  </label>
                  <label>
                    核心价值摘要
                    <textarea
                      name="summary"
                      rows={2}
                      defaultValue="告别生硬机翻字幕闪烁，支持后台配音预处理队列、BYOK 本地隐私优先与双设备离线授权买断。"
                      required
                    />
                  </label>
                  <label>
                    亮点列表（每行一条）
                    <textarea
                      name="highlights"
                      rows={3}
                      defaultValue={"10 秒开启双语同传与纯享中文音轨\nAPI 密钥与历史留在本地浏览器\n一次买断支持 Ed25519 离线验签"}
                    />
                  </label>
                  <label>
                    落地页基准地址
                    <input name="baseUrl" defaultValue="https://opc.example.com/pagelens-interpret" required />
                  </label>
                  <div>
                    <button type="submit" className="cm-primary" disabled={busy}>
                      生成 5 渠道 UTM 文案 + cose 人工闸门发布包 + 合规文档
                    </button>
                  </div>
                </form>
              )}

              {tab === "support" && (
                <form className="cm-form" onSubmit={handleSubmitTicket}>
                  <h3>统一客服工单分诊（FAQ 秒回 / 缺陷转研发选题 / 退款进 Zoom 审批）</h3>
                  <div className="cm-form-row">
                    <label>
                      产品
                      <input name="product" defaultValue={data.pilot.product} required />
                    </label>
                    <label>
                      子项目
                      <input name="project" defaultValue={data.pilot.project} required />
                    </label>
                    <label>
                      来源渠道
                      <select name="channel" defaultValue="chrome_web_store">
                        <option value="chrome_web_store">Chrome 商店评价</option>
                        <option value="email">邮件支持</option>
                        <option value="in_app">插件内反馈</option>
                        <option value="feishu">飞书 / 社群</option>
                        <option value="github_issue">GitHub Issue</option>
                      </select>
                    </label>
                    <label>
                      客户代号
                      <input name="customerId" defaultValue="cust_user_88" required />
                    </label>
                  </div>
                  <label>
                    工单标题（含 crash/报错 自动转研发候选；含 退款/发票 自动送 Zoom 待我处理）
                    <input name="subject" defaultValue="切换到全屏播放时偶发配音队列中断报错" required />
                  </label>
                  <label>
                    反馈正文（自动执行隐私脱敏）
                    <textarea
                      name="body"
                      rows={3}
                      defaultValue="在观看 45 分钟技术演讲切换全屏后，后台预处理队列停在第 12 段并抛出异常，希望能自动恢复续播。"
                      required
                    />
                  </label>
                  <div>
                    <button type="submit" className="cm-primary" disabled={busy}>提交分诊并联动 OPC OS</button>
                  </div>
                </form>
              )}

              {toolOutput && (
                <pre className="cm-code" aria-label="操作返回详情">{toolOutput}</pre>
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
