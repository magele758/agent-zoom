import { MessageDelegate } from "./Delegation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CompanyIndex } from "../../src/company-types";
import type { HomeRoomBinding, HomeRoomPost } from "../../src/home-room-types";
import { productStages, type ProductStageId } from "../../src/product-stages";
import { stageGuides, type StageDraft } from "../../src/stage-guides";
import type { StageHomeBot, StageHomeReceipt } from "../../src/stage-home-types";
import type { StageWork, StageWorkTarget } from "../../src/stage-work-types";
import { request } from "./api";
import { StageGuide } from "./StageGuide";
import { inboxLink } from "./zoom-routes";
import "./stage-guide.css";

const endpoint = "/api/zoom/stage-work";
const home = "/api/zoom/stage-home";
const stages = {
  open: "等待认领",
  active: "执行中",
  waiting: "等待答复",
  reconcile: "等待对账",
  completed: "已有交付",
};
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const post = (data: unknown) => ({ method: "POST", body: JSON.stringify(data) });

function HomeDispatch({ id, changed }: { id: string; changed: () => void }) {
  const [receipt, setReceipt] = useState<StageHomeReceipt | null>(null);
  const [bots, setBots] = useState<StageHomeBot[]>([]);
  const [chosen, setChosen] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    const options = { signal: control.signal };
    async function lookup() {
      const saved = await request<{ receipt: StageHomeReceipt | null }>(home + "/" + id, options);
      if (control.signal.aborted) return;
      setReceipt(saved.receipt);
      if (!saved.receipt) {
        const roster = await request<{ available: boolean; reason?: string; bots: StageHomeBot[] }>(
          home + "/bots",
          options,
        );
        if (control.signal.aborted) return;
        setBots(roster.bots);
        if (!roster.available) setError(roster.reason || "当前无法读取 Bot 名录");
      }
      setReady(true);
    }
    lookup().catch((e) => {
      if (!control.signal.aborted) setError(describe(e));
    });
    return () => control.abort();
  }, [id]);
  async function act(action: "send" | "reconcile") {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ receipt: StageHomeReceipt | null }>(
        home + "/" + id + "/" + action,
        post(action === "send" ? { botId: receipt?.botId || chosen } : {}),
      );
      setReceipt(result.receipt);
      changed();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sd-dispatch">
      {error && <p role="alert">{error}</p>}
      {receipt ? (
        <>
          <p>
            <b>{receipt.botName}</b> · {receipt.detail}
          </p>
          {receipt.status !== "completed" && (
            <button disabled={busy} onClick={() => void act("reconcile")}>
              核对原派工
            </button>
          )}
          {receipt.canRetry && (
            <button disabled={busy} onClick={() => void act("send")}>
              重试已核对的派工
            </button>
          )}
        </>
      ) : (
        ready && (
          <>
            <label>
              执行 Bot{" "}
              <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                <option value="">选择具名 Bot</option>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy || !chosen} onClick={() => void act("send")}>
              将这份工作单发给 Bot
            </button>
          </>
        )
      )}
    </div>
  );
}

function ReopenWork({ work, changed }: { work: StageWork; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (work.status !== "reconcile" || !work.leaseUntil) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim() || busy || !work.leaseUntil) return;
    setBusy(true);
    setError("");
    try {
      await request(endpoint + "/" + encodeURIComponent(work.id) + "/reopen", post({
        expectedLeaseUntil: work.leaseUntil,
        reason: reason.trim(),
      }));
      setReason("");
      setOpen(false);
      changed();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sd-reopen">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          核对后重新开放认领
        </button>
      ) : (
        <form onSubmit={submit}>
          <label>
            核对说明
            <input
              required
              maxLength={2000}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：已确认原执行会话停止，保留既有产出"
            />
          </label>
          <button type="submit" disabled={busy || !reason.trim()}>
            {busy ? "正在开放…" : "确认重新开放"}
          </button>
          <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>
            取消
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}

export function StageDesk({
  nav,
  step,
  product,
  initialItem = "",
  initialProject = "",
  refBinding = "",
  refPost = "",
}: {
  nav: ReactNode;
  step: ProductStageId;
  product: string;
  initialItem?: string;
  initialProject?: string;
  refBinding?: string;
  refPost?: string;
}) {
  const companyStage = step === "research" || step === "idea";
  const [company, setCompany] = useState<CompanyIndex | null>(null);
  const [roomRef, setRoomRef] = useState<{ binding: HomeRoomBinding; post: HomeRoomPost } | null>(null);
  const [productName, setProductName] = useState(product);
  const [project, setProject] = useState(initialProject);
  const [item, setItem] = useState(initialItem);
  const [target, setTarget] = useState<StageWorkTarget>("coding-agent");
  const [agent, setAgent] = useState("");
  const [items, setItems] = useState<StageWork[]>([]);
  const [active, setActive] = useState("");
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submission, setSubmission] = useState({ key: "", id: "" });
  const reload = () => setVersion((v) => v + 1);
  const scopeProduct = companyStage ? "" : productName;
  const scopeProject = companyStage ? "" : project;
  const scopeItem = companyStage ? item : "";
  useEffect(() => {
    if (!refBinding || !refPost) {
      setRoomRef(null);
      return;
    }
    const control = new AbortController();
    request<{ binding: HomeRoomBinding; post: HomeRoomPost }>(
      "/api/opc/home-rooms/" + encodeURIComponent(refBinding) + "/messages/" + encodeURIComponent(refPost),
      { signal: control.signal },
    )
      .then((result) => {
        if (!control.signal.aborted) setRoomRef(result);
      })
      .catch(() => {
        if (!control.signal.aborted) setRoomRef(null);
      });
    return () => control.abort();
  }, [refBinding, refPost]);
  useEffect(() => {
    const control = new AbortController();
    request<CompanyIndex>("/api/zoom/company", { signal: control.signal })
      .then((c) => setCompany(c))
      .catch((e) => {
        if (!control.signal.aborted) setError(describe(e));
      });
    return () => control.abort();
  }, [version]);
  useEffect(() => {
    const control = new AbortController();
    setItems([]);
    setError("");
    if (!companyStage && (!scopeProduct || !scopeProject)) return;
    const query = new URLSearchParams({ stage: step, product: scopeProduct });
    if (scopeProject) query.set("project", scopeProject);
    if (scopeItem) query.set("companyItemId", scopeItem);
    request<{ items: StageWork[] }>(endpoint + "?" + query, { signal: control.signal })
      .then((r) => setItems(r.items))
      .catch((e) => {
        if (!control.signal.aborted) setError(describe(e));
      });
    return () => control.abort();
  }, [step, scopeProduct, scopeProject, scopeItem, companyStage, version]);
  const notes = step === "idea" ? company?.ideas : company?.information;
  const projectInfo = company?.projects.find((p) => p.product === productName && p.name === project);
  const sources = companyStage
    ? (notes ?? [])
        .filter((n) => !item || n.id === item)
        .map((n) => ({ label: n.title, reference: n.reference || n.title }))
    : (projectInfo?.repos ?? []).map((repo) => ({ label: repo, reference: "https://github.com/" + repo }));
  const title = productStages.find((s) => s.id === step)!.label;
  async function submit(draft: StageDraft) {
    const payload = {
      ...draft,
      stage: step,
      product: scopeProduct,
      ...(scopeProject && { project: scopeProject }),
      ...(scopeItem && { companyItemId: scopeItem }),
      target,
      ...(target === "coding-agent" && agent.trim() && { requestedAgent: agent.trim() }),
    };
    const key = JSON.stringify(payload);
    const id = submission.key === key ? submission.id : crypto.randomUUID();
    setSubmission({ key, id });
    setError("");
    setBusy(true);
    try {
      const result = await request<{ work: StageWork }>(endpoint, post({ ...payload, requestId: id }));
      setActive(result.work.id);
      reload();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="zo-product sd-page">
      <header className="sd-header">
        {nav}
        <a href="#product">产品进程</a>
        <h1>{title}</h1>
        <p>{stageGuides[step].purpose}</p>
      </header>
      <div className="sd-scope">
        {companyStage ? (
          <label>
            公司事项
            <select value={item} onChange={(e) => setItem(e.target.value)}>
              <option value="">公司整体</option>
              {notes?.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label>
              产品
              <select
                value={productName}
                onChange={(e) => {
                  setProductName(e.target.value);
                  setProject("");
                }}
              >
                <option value="">选择产品</option>
                {company?.products.map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
            <label>
              所属项目
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">选择项目</option>
                {company?.projects
                  .filter((p) => p.product === productName)
                  .map((p) => <option key={p.name}>{p.name}</option>)}
              </select>
            </label>
            <a href={"#projects?product=" + encodeURIComponent(productName)}>管理目录 ↗</a>
          </>
        )}
        <a
          data-testid="stage-open-messages"
          href={inboxLink({ folder: [scopeProduct, scopeProject].filter(Boolean).join("/"), stage: step })}
        >
          查看阶段消息 ↗
        </a>
      </div>
      {error && (
        <p role="alert">
          {error} <button onClick={reload}>刷新</button>
        </p>
      )}
      {roomRef && (
        <p className="sd-room-ref">
          来自项目讨论：{roomRef.binding.project} / {roomRef.binding.roomTitle} ·{" "}
          <a href={"#home-room?" + new URLSearchParams({ binding: roomRef.binding.id, post: roomRef.post.id })}>
            打开原讨论 ↗
          </a>
        </p>
      )}
      <StageGuide
        stage={step}
        product={[scopeProduct, scopeProject, scopeItem].join("/")}
        initialInputs={
          roomRef
            ? `原讨论 #home-room?binding=${roomRef.binding.id}&post=${roomRef.post.id}\n${roomRef.post.body.slice(0, 1000)}`
            : ""
        }
        sources={sources}
        renderHandoff={(draft) => (
          <div className="sd-handoff">
            <label>
              交给谁
              <select value={target} onChange={(e) => setTarget(e.target.value as StageWorkTarget)}>
                <option value="coding-agent">本地 coding agent 认领</option>
                <option value="agent-home">Agent Home Bot</option>
              </select>
            </label>
            {target === "coding-agent" && (
              <label>
                指定 agent（可选）
                <input
                  value={agent}
                  maxLength={120}
                  onChange={(e) => setAgent(e.target.value)}
                  placeholder="例如 grok"
                />
              </label>
            )}
            <button disabled={busy || (!companyStage && !project)} onClick={() => void submit(draft)}>
              登记阶段任务
            </button>
          </div>
        )}
      />
      <section className="sd-work">
        <header>
          <h2>本阶段工作单</h2>
          <button onClick={reload}>刷新进展</button>
        </header>
        {!items.length && (
          <p>{!companyStage && !project ? "选择所属项目后可以查看和发起工作。" : "还没有阶段工作单。"}</p>
        )}
        {items.map((work) => (
          <article key={work.id}>
            <h3>{work.title}</h3>
            <p>
              {stages[work.status]} ·{" "}
              {work.owner ||
                work.requestedAgent ||
                (work.target === "agent-home" ? "Agent Home" : "本地 coding agent")}
            </p>
            <MessageDelegate messageId={work.messageId}/>
            <ReopenWork work={work} changed={reload} />
            <a href={inboxLink({ message: work.messageId })}>原任务与反馈 ↗</a>{" "}
            <button
              aria-expanded={active === work.id}
              onClick={() => setActive(active === work.id ? "" : work.id)}
            >
              执行与回执
            </button>
            {active === work.id &&
              (work.target === "agent-home" ? (
                <HomeDispatch id={work.id} changed={reload} />
              ) : (
                <p>
                  在执行者的会话中认领本单{" "}
                  <code>opc-os stage claim {work.id} --agent 执行者 --session 会话标识</code>
                </p>
              ))}
            {work.evidence.length > 0 && (
              <ul>
                {work.evidence.map((ref) => (
                  <li key={ref}>{ref}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </section>
    </section>
  );
}
