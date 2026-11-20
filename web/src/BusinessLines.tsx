import { DelegateWork, MessageDelegate } from "./Delegation";
import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import type {
  BusinessAsset,
  BusinessLine,
  BusinessMode,
  BusinessPortfolio,
  BusinessTrial,
  LineSpec,
  ObservationKind,
  TrialEvidence,
} from "../../src/business-types";
import { request } from "./api";
import type { CapabilityIndex, RepoCapability } from "../../src/repo-capabilities-types";
import { inboxLink } from "./zoom-routes";
import "./business-lines.css";

const root = "/api/opc/business";
const kinds = { observation: "观察", receipt: "收款", refund: "退款", expense: "费用" } as const;
const assetKinds = { product: "产品", project: "项目", plugin: "Chrome 插件", method: "方法" } as const;
const baseSpec: LineSpec = {
  name: "",
  goal: "",
  mode: "experiment",
  steps: ["提出假设", "验证", "复盘"],
  assets: [],
};
const lineFromHash = () => new URLSearchParams(location.hash.split("?")[1]).get("line") || "";
const value = (data: FormData, name: string) => String(data.get(name) ?? "").trim();
const decimalPlaces = (currency: string) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
const displayMoney = (minor: number, currency: string) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency, currencyDisplay: "code" }).format(
    minor / 10 ** decimalPlaces(currency),
  );

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="bl-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
const versionLink = (id: string) => "#capabilities?capability=" + encodeURIComponent(id);
function AssetReference({ asset }: { asset: BusinessAsset }) {
  if (/^#capabilities\?capability=[a-f0-9-]{36}$/i.test(asset.reference))
    return <a href={asset.reference}>{asset.name} ↗</a>;
  if (/^https?:\/\//i.test(asset.reference))
    return (
      <a href={asset.reference} target="_blank" rel="noreferrer">
        {asset.name} ↗
      </a>
    );
  return (
    <>
      {asset.name}
      {asset.reference && <small> · {asset.reference}</small>}
    </>
  );
}
type Save = (path: string, body: unknown, method?: string) => Promise<boolean>;
function LineForm({ line, save, close }: { line?: BusinessLine; save: Save; close: () => void }) {
  const spec = line ?? baseSpec;
  const [assets, setAssets] = useState<BusinessAsset[]>(spec.assets);
  const [versions, setVersions] = useState<RepoCapability[]>([]);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    let active = true;
    request<Pick<CapabilityIndex, "capabilities">>("/api/opc/capabilities/versions").then(
      (result) => {
        if (active) setVersions(result.capabilities);
      },
      (error) => {
        if (active) setCatalogError(error instanceof Error ? error.message : "暂时无法读取能力目录");
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const addVersion = (id: string) => {
    const cap = versions.find((v) => v.id === id);
    if (!cap) return;
    const reference = versionLink(id);
    const name = cap.name.slice(0, 95) + " · " + cap.version.slice(0, 20);
    setAssets((items) =>
      items.some((a) => a.reference === reference) ? items : [...items, { kind: "project", name, reference }],
    );
  };
  const changeAsset = (i: number, patch: Partial<BusinessAsset>) =>
    setAssets((a) => a.map((item, n) => (n === i ? { ...item, ...patch } : item)));
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const payload = {
      name: value(data, "name"),
      goal: value(data, "goal"),
      mode: value(data, "mode") as BusinessMode,
      steps: value(data, "steps")
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      assets,
      ...(line && { revision: line.revision }),
    };
    if (await save(line ? "/lines/" + line.id : "/lines", payload, line ? "PUT" : "POST")) close();
  };
  return (
    <form onSubmit={submit} className="bl-form">
      <Field label="业务线名称">
        <input required name="name" maxLength={120} defaultValue={spec.name} />
      </Field>
      <Field label="目标">
        <input required name="goal" defaultValue={spec.goal} maxLength={2000} />
      </Field>
      <Field label="工作方式">
        <select name="mode" defaultValue={spec.mode}>
          <option value="experiment">经营实验</option>
          <option value="development">技术研发</option>
        </select>
      </Field>
      <Field label="流程步骤（每行一步）">
        <textarea required name="steps" rows={4} defaultValue={spec.steps.join("\n")} />
      </Field>
      <div className="bl-assets">
        <h4>可共用的产品与能力</h4>
        {versions.length > 0 && (
          <Field label="选用已登记的开源能力">
            <select value="" onChange={(event) => addVersion(event.target.value)}>
              <option value="">选择仓库与版本</option>
              {versions.map((cap) => (
                <option
                  key={cap.id}
                  value={cap.id}
                  disabled={assets.some((a) => a.reference === versionLink(cap.id))}
                >
                  {cap.name} · {cap.repo} @ {cap.version}
                </option>
              ))}
            </select>
          </Field>
        )}
        {catalogError && <p role="alert">{catalogError}</p>}
        {assets.map((a, i) => (
          <div className="bl-asset-row" key={i}>
            <select
              aria-label={"资产类型 " + (i + 1)}
              value={a.kind}
              onChange={(e) => changeAsset(i, { kind: e.target.value as BusinessAsset["kind"] })}
            >
              {Object.entries(assetKinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <input
              aria-label={"资产名称 " + (i + 1)}
              placeholder="名称"
              required
              value={a.name}
              maxLength={120}
              onChange={(e) => changeAsset(i, { name: e.target.value })}
            />
            <input
              aria-label={"资产出处 " + (i + 1)}
              placeholder="仓库、版本或出处"
              value={a.reference}
              maxLength={1000}
              onChange={(e) => changeAsset(i, { reference: e.target.value })}
            />
            <button type="button" onClick={() => setAssets((items) => items.filter((_, n) => n !== i))}>
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setAssets((a) => [...a, { name: "", kind: "plugin", reference: "" }])}
        >
          添加资产
        </button>
      </div>
      <div className="bl-actions">
        <button className="bl-primary" type="submit">
          保存业务线
        </button>
        <button type="button" onClick={close}>
          取消
        </button>
      </div>
    </form>
  );
}

function TrialForm({ line, save, close }: { line: BusinessLine; save: Save; close: () => void }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (
      await save("/lines/" + line.id + "/trials", {
        requestId,
        title: value(data, "title"),
        hypothesis: value(data, "hypothesis"),
        metric: value(data, "metric"),
        scope: value(data, "scope"),
      })
    )
      close();
  };
  return (
    <form className="bl-form" onSubmit={submit}>
      <Field label="实验名称">
        <input required name="title" maxLength={120} placeholder="例如，商品草稿字段检查" />
      </Field>
      <Field label="这次要验证什么">
        <textarea required name="hypothesis" placeholder="哪类用户或操作会得到改善？" />
      </Field>
      <Field label="怎样判断有效">
        <input required name="metric" placeholder="例如，抽查 10 份草稿的漏填与误报" />
      </Field>
      <Field label="本轮范围与使用权限">
        <input required name="scope" placeholder="例如，只读取测试店铺的草稿" />
      </Field>
      <div className="bl-actions">
        <button className="bl-primary">登记实验</button>
        <button type="button" onClick={close}>
          取消
        </button>
      </div>
    </form>
  );
}
function EvidenceForm({ trial, save, close }: { trial: BusinessTrial; save: Save; close: () => void }) {
  const [eventId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<ObservationKind>("observation");
  const [currency, setCurrency] = useState("CNY");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const decimals = decimalPlaces(currency),
      raw = value(data, "amount"),
      [whole, fraction = ""] = raw.split(".");
    const minor = Number(whole) * 10 ** decimals + Number(fraction.padEnd(decimals, "0"));
    if (
      await save("/trials/" + trial.id + "/evidence", {
        eventId,
        kind,
        note: value(data, "note"),
        reference: value(data, "reference"),
        ...(kind !== "observation" && { currency, minor }),
      })
    )
      close();
  };
  return (
    <form className="bl-form" onSubmit={submit}>
      <Field label="记录类型">
        <select value={kind} onChange={(e) => setKind(e.target.value as ObservationKind)}>
          {Object.entries(kinds).map(([k, v]) => (
            <option value={k} key={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="观察或交易说明">
        <input required name="note" />
      </Field>
      <Field label="原始凭据">
        <input
          required
          name="reference"
          placeholder={kind === "observation" ? "复测记录、文件或原帖" : "渠道／店铺／交易流水号"}
        />
      </Field>
      {kind !== "observation" && (
        <div className="bl-money-input">
          <Field label="币种">
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {["CNY", "USD", "EUR", "MXN", "JPY", "GBP", "HKD"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="实际金额">
            <input
              name="amount"
              inputMode="decimal"
              required
              pattern={
                decimalPlaces(currency) === 0 ? "[0-9]+" : "[0-9]+([.][0-9]{1," + decimalPlaces(currency) + "})?"
              }
              placeholder={decimalPlaces(currency) ? "0.00" : "0"}
            />
          </Field>
        </div>
      )}
      <div className="bl-actions">
        <button className="bl-primary">保存凭据</button>
        <button type="button" onClick={close}>
          取消
        </button>
      </div>
    </form>
  );
}
function Totals({ records }: { records: TrialEvidence[] }) {
  const totals = new Map<string, { receipt: number; refund: number; expense: number }>();
  for (const item of records) {
    if (item.kind === "observation" || !item.currency || item.minor === undefined) continue;
    const v = totals.get(item.currency) ?? { receipt: 0, refund: 0, expense: 0 };
    v[item.kind] += item.minor;
    totals.set(item.currency, v);
  }
  if (!totals.size) return <p className="bl-muted">尚未登记收款、退款或费用凭据。</p>;
  return (
    <table className="bl-money">
      <caption>已登记现金记录</caption>
      <thead>
        <tr>
          {["币种", "收款", "退款", "费用", "净流入"].map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...totals].map(([c, t]) => (
          <tr key={c}>
            <th>{c}</th>
            {[t.receipt, t.refund, t.expense, t.receipt - t.refund - t.expense].map((n, i) => (
              <td key={i}>{displayMoney(n, c)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function TrialDetail({ trial, save }: { trial: BusinessTrial; save: Save }) {
  const [adding, setAdding] = useState(false);
  const [referring, setReferring] = useState(false);
  const refer = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (
      await save("/trials/" + trial.id + "/development", {
        project: value(data, "project"),
        evidenceId: value(data, "evidence"),
        title: value(data, "title"),
      })
    )
      setReferring(false);
  };
  const href = trial.questionId ? inboxLink({ message: trial.questionId }) : null;
  return (
    <article className="bl-trial" id={"trial-" + trial.id}>
      <header>
        <h4>{trial.title}</h4>
        <span>{trial.decision ? "已决定 · " + trial.decision : trial.questionId ? "待你复盘" : "观察中"}</span>
      </header>
      <dl>
        <dt>假设</dt>
        <dd>{trial.hypothesis}</dd>
        <dt>判断依据</dt>
        <dd>{trial.metric}</dd>
        <dt>本轮范围</dt>
        <dd>{trial.scope}</dd>
        {trial.recipe.assets.length > 0 && (
          <>
            <dt>本轮资产</dt>
            <dd>
              {trial.recipe.assets.map((asset, i) => (
                <span key={i}>
                  {i > 0 && " / "}
                  <AssetReference asset={asset} />
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
      {trial.questionId ? <MessageDelegate messageId={trial.questionId} personal/> : <DelegateWork key={trial.id} label="委派跟进经营实验" operation={{key:"trial:"+trial.id,title:"跟进实验 · "+trial.title,href:"#business-lines?"+new URLSearchParams({line:trial.lineId,trial:trial.id}),detail:[trial.hypothesis,trial.metric,trial.scope].filter(Boolean).join("\n")}}/>}
      {trial.evidence.length > 0 && (
        <ul>
          {trial.evidence.map((item) => (
            <li key={item.id}>
              <b>{kinds[item.kind]}</b> {item.note}
              {item.currency && item.minor !== undefined ? " · " + displayMoney(item.minor, item.currency) : ""}
              <small>{item.reference}</small>
            </li>
          ))}
        </ul>
      )}
      {href ? (
        <a href={href}>{trial.decision ? "查看原决定" : "到 Zoom 处理复盘"} ↗</a>
      ) : adding ? (
        <EvidenceForm trial={trial} save={save} close={() => setAdding(false)} />
      ) : (
        <div className="bl-actions">
          <button onClick={() => setAdding(true)}>登记证据</button>
          <button
            disabled={!trial.evidence.length}
            onClick={() => void save("/trials/" + trial.id + "/review", {})}
          >
            提交复盘
          </button>
        </div>
      )}
      {trial.evidence.length > 0 && (
        <div className="bl-referral">
          {trial.referrals.map((ref) => (
            <p key={ref.opportunityId}>
              <a
                href={
                  ref.runId
                    ? "#workflows/" + ref.runId
                    : "#opportunities?project=" + encodeURIComponent(ref.project) + "&item=" + ref.opportunityId
                }
              >
                {ref.project} · {ref.title} ↗
              </a>
            </p>
          ))}
          {referring ? (
            <form onSubmit={refer} className="bl-form">
              <Field label="目标研发项目">
                <input required name="project" maxLength={256} />
              </Field>
              <Field label="提议开发的特性">
                <input required name="title" maxLength={120} />
              </Field>
              <Field label="依据哪一条记录">
                <select name="evidence">
                  {trial.evidence.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.note}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="bl-actions">
                <button className="bl-primary">加入研发候选</button>
                <button type="button" onClick={() => setReferring(false)}>
                  取消
                </button>
              </div>
            </form>
          ) : (
            <button onClick={() => setReferring(true)}>从观察提出研发特性</button>
          )}
        </div>
      )}
    </article>
  );
}
export function BusinessLines({ nav }: { nav: ReactNode }) {
  const [data, setData] = useState<BusinessPortfolio | null>(null),
    [selected, setSelected] = useState(lineFromHash);
  const [form, setForm] = useState<"new" | "edit" | "trial" | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => setData(await request<BusinessPortfolio>(root + "/lines"));
  useEffect(() => {
    let active = true;
    const read = () =>
      request<BusinessPortfolio>(root + "/lines")
        .then((d) => {
          if (active) {
            setData(d);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void read();
    const onVisible = () => {
      if (!document.hidden) void read();
    };
    const timer = window.setInterval(onVisible, 5000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  useEffect(() => {
    const change = () => {
      setSelected(lineFromHash());
      setForm(null);
      setError("");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const line = data?.lines.find((item) => item.id === selected) ?? data?.lines[0],
    trials = data?.trials.filter((t) => t.lineId === line?.id) ?? [];
  useEffect(() => {
    const id = new URLSearchParams(location.hash.split("?")[1]).get("trial");
    if (id && data) document.getElementById("trial-" + id)?.scrollIntoView({ block: "nearest" });
  }, [data, selected]);
  const save: Save = async (path, body, method = "POST") => {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ id: string }>(root + path, { method, body: JSON.stringify(body) });
      await load();
      if (path === "/lines") location.hash = "business-lines?line=" + encodeURIComponent(result.id);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="zo-product bl-page" aria-label="公司业务线">
      <header className="bl-head">
        <div>
          {nav}
          <h1>公司业务线</h1>
        </div>
        <div className="bl-actions">
          <a href="#commercial">套用打法模板与商业总览 ↗</a>
          <button onClick={() => setForm("new")}>新建业务线</button>
        </div>
      </header>
      {error && (
        <p role="alert" className="bl-error">
          {error}{" "}
          <button
            onClick={() => {
              void load()
                .then(() => setError(""))
                .catch((e) => setError(e.message));
            }}
          >
            重新读取
          </button>
        </p>
      )}
      {!data && !error && <p role="status">正在读取业务线…</p>}
      {data && (
        <nav className="bl-nav" aria-label="选择业务线">
          {data.lines.map((l) => (
            <a
              href={"#business-lines?line=" + encodeURIComponent(l.id)}
              key={l.id}
              aria-current={l.id === line?.id ? "page" : undefined}
            >
              {l.name}
            </a>
          ))}
        </nav>
      )}
      <fieldset disabled={busy} className="bl-body">
        {form === "new" ? (
          <LineForm key="new" save={save} close={() => setForm(null)} />
        ) : (
          line && (
            <>
              {form === "edit" ? (
                <LineForm key={line.id + "edit"} line={line} save={save} close={() => setForm(null)} />
              ) : (
                <>
                  <header className="bl-linehead">
                    <div>
                      <h2>{line.name}</h2>
                      <p>{line.goal}</p>
                    </div>
                    <button onClick={() => setForm("edit")}>编辑业务线</button>
                  </header>
                  <ol className="bl-steps">
                    {line.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                  {line.assets.length > 0 && (
                    <ul className="bl-links">
                      {line.assets.map((a, i) => (
                        <li key={i}>
                          <b>{assetKinds[a.kind]}</b> <AssetReference asset={a} />
                        </li>
                      ))}
                    </ul>
                  )}
                  <p>
                    <a href={"#worklog?line=" + encodeURIComponent(line.id)}>查看这条线的工作投入 ↗</a>
                  </p>
                  {line.mode === "development" && (
                    <p>
                      <a href="#opportunities">打开研发选题与计划 ↗</a>
                    </p>
                  )}
                  <hr />
                  <div className="bl-section">
                    <h3>经营实验</h3>
                    <button onClick={() => setForm("trial")}>新建实验</button>
                  </div>
                  {form === "trial" && (
                    <TrialForm key={line.id} line={line} save={save} close={() => setForm(null)} />
                  )}
                  {trials.length === 0 && !form && (
                    <p className="bl-muted">从一个想验证的问题开始，记下本轮范围和判断标准。</p>
                  )}
                  {trials.map((trial) => (
                    <TrialDetail key={trial.id} trial={trial} save={save} />
                  ))}
                  <hr />
                  <h3>经营凭据</h3>
                  <Totals records={trials.flatMap((t) => t.evidence)} />
                </>
              )}
            </>
          )
        )}
      </fieldset>
    </section>
  );
}
