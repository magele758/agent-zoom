import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { DelegateMethod, DelegatePreference, Delegation } from "../../src/delegation-types";
import type { ZoomMessage } from "../../src/zoom-types";
import type { StageHomeBot } from "../../src/stage-home-types";
import { request } from "./api";
import "./delegation.css";

const endpoint = "/api/opc/delegations";
const emptyMethod: DelegateMethod = { via: "coding-agent", target: "", instructions: "" };
const statusLabel = {
  queued: "待执行者接单",
  working: "在办",
  approval: "待本人决定",
  completed: "已交回结果",
  reconcile: "待对账",
};
const describe = (error: unknown) => (error instanceof Error ? error.message : "读取失败，请重试");
type Registry = { items: Delegation[]; preference: DelegatePreference | null };
type Operation = { key: string; title: string; detail: string; href: string; requiresApproval?: boolean };
type Source = { messageId: string; operation?: never } | { operation: Operation; messageId?: never };
type RegistryContext = {
  data: Registry | null;
  error: string;
  messages: ZoomMessage[];
  refresh: () => Promise<void>;
  update: () => Promise<void>;
};
const Context = createContext<RegistryContext | null>(null);

export function DelegationProvider({
  messages,
  refreshMessages,
  children,
}: {
  messages: ZoomMessage[];
  refreshMessages: () => Promise<void>;
  children: ReactNode;
}) {
  const [data, setData] = useState<Registry | null>(null),
    [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      const result = await request<Registry>(endpoint, { signal: next.signal });
      if (!next.signal.aborted) {
        setData(result);
        setError("");
      }
    } catch (cause) {
      if (!next.signal.aborted) setError(describe(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh]);
  const update = useCallback(async () => {
    await Promise.all([refresh(), refreshMessages()]);
  }, [refresh, refreshMessages]);
  return <Context.Provider value={{ data, error, messages, refresh, update }}>{children}</Context.Provider>;
}

function MethodFields({
  initial,
  savingPreference = false,
  onSubmit,
  cancel,
}: {
  initial: DelegatePreference | null;
  savingPreference?: boolean;
  onSubmit: (method: DelegatePreference) => Promise<void>;
  cancel?: () => void;
}) {
  const [method, setMethod] = useState<DelegateMethod>(initial || emptyMethod);
  const [automatic, setAutomatic] = useState(initial?.automatic ?? false);
  const [bots, setBots] = useState<StageHomeBot[]>([]),
    [botNote, setBotNote] = useState("");
  const [retry, setRetry] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const handlesId = useId();
  const [handles, setHandles] = useState<{ handle: string; runtime: string; online: boolean }[]>([]);
  const registered = handles.find((a) => a.handle.toLowerCase() === method.target.trim().toLowerCase());
  const quotedTarget = "'" + method.target.trim().replaceAll("'", "'\"'\"'") + "'";
  useEffect(() => {
    if (method.via !== "coding-agent") return;
    const controller = new AbortController();
    request<{ agents: typeof handles }>(endpoint + "/agents", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setHandles(result.agents);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [method.via]);
  useEffect(() => {
    if (method.via !== "agent-home") return;
    const controller = new AbortController();
    setBots([]);
    setBotNote("正在读取 Agent Home 的 Bot…");
    request<{ available: boolean; bots: StageHomeBot[]; reason?: string }>("/api/zoom/stage-home/bots", {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setBots(data.bots);
        setBotNote(!data.available || !data.bots.length ? data.reason || "当前没有可选 Bot。" : "");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setBotNote(describe(cause));
      });
    return () => controller.abort();
  }, [method.via, retry]);
  const valid =
    method.via === "coding-agent" ? Boolean(method.target.trim()) : bots.some((b) => b.id === method.target);
  const disableOnly =
    savingPreference &&
    initial?.automatic &&
    !automatic &&
    initial.via === method.via &&
    initial.target === method.target &&
    initial.instructions === method.instructions;
  async function save(event: FormEvent) {
    event.preventDefault();
    if ((!valid && !disableOnly) || guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        ...method,
        target: method.target.trim(),
        instructions: method.instructions.trim(),
        automatic,
      });
    } catch (cause) {
      setError(describe(cause));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="del-form" onSubmit={save}>
      <label>
        交给谁
        <select
          value={method.via}
          onChange={(e) => setMethod({ ...method, via: e.target.value as DelegateMethod["via"], target: "" })}
        >
          <option value="coding-agent">本地 coding agent</option>
          <option value="agent-home">Agent Home Bot</option>
        </select>
      </label>
      {method.via === "coding-agent" ? (
        <label>
          执行者名称
          <input
            list={handlesId}
            type="text"
            required
            maxLength={128}
            value={method.target}
            autoComplete="off"
            placeholder="例如 grok"
            onChange={(e) => setMethod({ ...method, target: e.target.value })}
          />
          <datalist id={handlesId}>
            {handles.map((a) => (
              <option key={a.handle} value={a.handle}>
                {a.runtime} · {a.online ? "在线" : "离线"}
              </option>
            ))}
          </datalist>
        </label>
      ) : (
        <label>
          Agent Home 的 Bot
          <select value={method.target} onChange={(e) => setMethod({ ...method, target: e.target.value })}>
            <option value="">选择 Bot</option>
            {bots.map((bot) => (
              <option value={bot.id} key={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {method.via === "agent-home" && botNote && (
        <p role="status">
          {botNote}{" "}
          <button type="button" onClick={() => setRetry((r) => r + 1)}>
            重读 Bot 名单
          </button>
        </p>
      )}
      <label className="del-full">
        办理方式
        <textarea
          value={method.instructions}
          maxLength={method.via === "agent-home" ? 1500 : 4000}
          rows={2}
          placeholder="例如用我的 Herdr 流程调查问题，把证据和建议回到原任务"
          onChange={(e) => setMethod({ ...method, instructions: e.target.value })}
        />
      </label>
      {savingPreference ? (
        <label className="del-auto">
          <input type="checkbox" checked={automatic} onChange={(e) => setAutomatic(e.target.checked)} />
          以此方式自动办理后续待办
        </label>
      ) : null}
      <div className="del-help del-delivery">
        {method.via === "coding-agent" ? (
          registered ? (
            <p>房间已登记 {registered.handle}。定向消息进入该 agent 的收件箱，接单后显示办理进展。</p>
          ) : (
            <>
              <p>
                {method.target.trim()
                  ? "此名称通过本机 CLI 待认领。"
                  : "输入接入房间的 agent 名称，或让自选的 CLI 认领。"}
                <a href="#channels">去频道接入 agent ↗</a>
              </p>
              {method.target.trim() && <code>opc-os stage list --agent {quotedTarget} --wait</code>}
            </>
          )
        ) : (
          <p>提交后交给所选 Bot。</p>
        )}
        <p>遇到需要本人批准的操作，回到原消息确认。</p>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="del-actions">
        <button type="submit" disabled={busy || (!valid && !disableOnly)}>
          {busy ? "正在保存…" : savingPreference ? "保存默认方式" : "确认委派"}
        </button>
        {cancel && (
          <button type="button" disabled={busy} onClick={cancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}

function Receipt({ item, source = false }: { item: Delegation; source?: boolean }) {
  const messages = useContext(Context)?.messages ?? [];
  const child = messages.filter((m) => m.taskId === item.workId);
  const question = child.find((m) => m.pending && m.kind === "question" && m.action);
  const latest =
    question ?? child.filter((m) => !m.id.startsWith("delegation:")).sort((a, b) => b.at.localeCompare(a.at))[0];
  const targetMessageId = latest?.id ?? item.workMessageId;
  return (
    <div className="del-receipt">
      <p>
        <strong>{statusLabel[item.status]}</strong> · {item.method.target} ·{" "}
        {item.method.via === "agent-home" ? "Agent Home" : "Coding agent"}
      </p>
      {item.method.instructions && (
        <details>
          <summary>办理方式</summary>
          <p>{item.method.instructions}</p>
        </details>
      )}
      {item.result && <p>{item.result}</p>}
      {item.evidence.length > 0 && (
        <ul aria-label="委派证据">
          {item.evidence.map((ev, i) => (
            <li key={i}>{ev}</li>
          ))}
        </ul>
      )}
      {targetMessageId && (
        <a href={item.sourceHref.startsWith("#") && !item.sourceHref.startsWith("#inbox") ? item.sourceHref : "#home-room"}>
          {question ? "答复执行者的问题" : "到群聊或原页查看"} ↗
        </a>
      )}{" "}
      {source && item.sourceHref.startsWith("#") && !item.sourceHref.startsWith("#inbox") && <a href={item.sourceHref}>回原事项 ↗</a>}
    </div>
  );
}

export function DelegateWork(props: Source & { personal?: boolean; label?: string }) {
  const registry = useContext(Context);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Delegation | null>(null);
  const [followup, setFollowup] = useState("");
  if (!registry) return null;
  const { messageId, operation, label } = props;
  const personal = props.personal || operation?.requiresApproval;
  const lookup = (key: string) =>
    registry.data?.items.find((i) => i.sourceId === key) ?? (submitted?.sourceId === key ? submitted : null);
  const sourceKey = operation?.key ?? messageId!;
  let item = messageId
    ? (registry.messages.find((m) => m.id === messageId)?.delegation ?? lookup(messageId))
    : lookup(sourceKey);
  let nextKey = sourceKey;
  // Each round points to its immediate predecessor. Both browser tabs derive the same next key.
  if (operation && !personal) {
    while (item?.status === "completed" && !item.requiresApproval) {
      nextKey = sourceKey + "/next/" + item.id;
      const next = lookup(nextKey);
      if (!next) break;
      item = next;
    }
  }
  const repeat = Boolean(item?.status === "completed" && !item.requiresApproval && operation && !personal);
  const open = openFor === nextKey;
  const name = repeat ? "再委派一项" : label || (personal ? "委派核对与建议" : "委派给 agent");
  return (
    <section className="del-inline" aria-label={item ? "委派进展" : "委派办理"}>
      {item && <Receipt item={item} source={Boolean(messageId && messageId !== item.sourceId)} />}
      {(!item || repeat) &&
        (!open ? (
          <button
            type="button"
            className="del-trigger"
            onClick={() => {
              setFollowup("");
              setOpenFor(nextKey);
              void registry.refresh();
            }}
          >
            {name}
          </button>
        ) : (
          <>
            <h4>{name}</h4>
            {personal && <p className="del-help">执行者准备依据，最终决定由你在原事项提交。</p>}
            {repeat && (
              <label className="del-next-task">
                这次要办什么
                <input
                  type="text"
                  value={followup}
                  maxLength={750}
                  onChange={(e) => setFollowup(e.target.value)}
                />
              </label>
            )}
            {registry.error && (
              <p role="alert">
                {registry.error}{" "}
                <button type="button" onClick={() => void registry.refresh()}>
                  重试
                </button>
              </p>
            )}
            {registry.data ? (
              <MethodFields
                initial={registry.data.preference}
                cancel={() => setOpenFor(null)}
                onSubmit={async (value) => {
                  const { automatic: _automatic, ...method } = value;
                  if (repeat && !followup.trim()) throw new Error("请写下这次要办的事。");
                  const payload = operation
                    ? {
                        operation: {
                          ...operation,
                          key: nextKey,
                          title: (repeat ? followup.trim() : operation.title).slice(0, 1000),
                          detail: (repeat ? followup.trim() + "\n" + operation.detail : operation.detail).slice(
                            0,
                            12000,
                          ),
                        },
                        method,
                      }
                    : { messageId, method };
                  const result = await request<Delegation>(endpoint, {
                    method: "POST",
                    body: JSON.stringify(payload),
                  });
                  setSubmitted(result);
                  setOpenFor(null);
                  await registry.update();
                }}
              />
            ) : (
              !registry.error && <p role="status">正在读取委派方式…</p>
            )}
          </>
        ))}
    </section>
  );
}

export function MessageDelegate({
  messageId,
  cardId,
  attemptId,
  personal = false,
}: {
  messageId?: string;
  cardId?: string;
  attemptId?: string;
  personal?: boolean;
}) {
  const registry = useContext(Context);
  const original = registry?.messages.find((m) =>
    messageId
      ? m.id === messageId
      : cardId
        ? m.action?.kind === "decision" && m.action.cardId === cardId
        : Boolean(
            attemptId && m.attemptId === attemptId && (m.action?.kind === "recover" || m.action?.kind === "retry"),
          ),
  );
  const parent = original && registry?.data?.items.find((i) => i.workId === original.taskId);
  if (parent)
    return (
      <section className="del-inline" aria-label="所属委派">
        <Receipt item={parent} source />
      </section>
    );
  if (
    !original ||
    original.readOnly ||
    (!original.pending && !original.delegation && !registry?.data?.items.some((i) => i.sourceId === original.id))
  )
    return null;
  return (
    <DelegateWork
      key={original.id}
      messageId={original.id}
      personal={
        personal ||
        original.kind === "decision" ||
        Boolean(
          original.capabilityRequest ||
            original.businessTrial ||
            original.kind === "recovery" ||
            original.choices?.length ||
            original.origin === "workflow",
        )
      }
    />
  );
}

type DeskFilter = "all" | "attention" | "active" | "completed";
const deskFilters: Array<{ id: DeskFilter; label: string; match: (item: Delegation) => boolean }> = [
  { id: "all", label: "全部", match: () => true },
  { id: "attention", label: "待本人决定 / 对账", match: (item) => item.status === "approval" || item.status === "reconcile" },
  { id: "active", label: "待认领 / 在办", match: (item) => item.status === "queued" || item.status === "working" },
  { id: "completed", label: "已交回", match: (item) => item.status === "completed" },
];

export function DelegationDesk({ nav }: { nav: ReactNode }) {
  const registry = useContext(Context);
  const [editing, setEditing] = useState(false),
    [success, setSuccess] = useState(""),
    [filter, setFilter] = useState<DeskFilter>("all");
  useEffect(() => {
    if (registry) void registry.refresh();
  }, [registry?.refresh]);
  if (!registry) return null;
  const { data, error, refresh } = registry;
  const currentFilter = deskFilters.find((f) => f.id === filter) ?? deskFilters[0];
  const visible = data ? data.items.filter(currentFilter.match) : [];
  return (
    <section className="zo-product del-page" aria-label="委派台">
      <header>
        {nav}
        <h1>委派台</h1>
        <div className="del-head-actions">
          <button type="button" onClick={() => void registry.update()}>
            刷新进展
          </button>
          <a href="#home-room">打开 Agent Home 群聊 ↗</a>
          <a href="#resource-department">查看执行者套餐额度 ↗</a>
        </div>
      </header>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => void refresh()}>
            重试
          </button>
        </p>
      )}
      {!data && !error && <p role="status">正在读取委派记录…</p>}
      {data && (
        <>
          <section className="del-settings">
            <header>
              <h2>默认办理方式</h2>
              {!editing && (
                <button
                  type="button"
                  onClick={() => {
                    setSuccess("");
                    setEditing(true);
                  }}
                >
                  {data.preference ? "编辑方式" : "设置默认方式"}
                </button>
              )}
            </header>
            {!editing &&
              (data.preference ? (
                <>
                  <p>
                    {data.preference.target} ·{" "}
                    {data.preference.via === "agent-home" ? "Agent Home Bot" : "本地 coding agent"} ·{" "}
                    {data.preference.automatic ? "自动办理后续待办" : "按条委派"}
                  </p>
                  {data.preference.instructions && <p>{data.preference.instructions}</p>}
                </>
              ) : (
                <p>按条选择执行者。你可以保存常用的 agent 和办理方式。</p>
              ))}
            {editing && (
              <MethodFields
                initial={data.preference}
                savingPreference
                cancel={() => setEditing(false)}
                onSubmit={async (value) => {
                  await request(endpoint + "/preference", { method: "PUT", body: JSON.stringify(value) });
                  await registry.update();
                  setEditing(false);
                  setSuccess("已保存默认办理方式。");
                }}
              />
            )}
            {success && <p role="status">{success}</p>}
          </section>
          <section className="del-ledger">
            <h2>
              委派记录 <small>{data.items.length}</small>
            </h2>
            {data.items.length > 0 && (
              <nav className="del-filters" aria-label="按委派状态筛选">
                {deskFilters.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={filter === item.id}
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label} <small>{data.items.filter(item.match).length}</small>
                  </button>
                ))}
              </nav>
            )}
            {visible.length ? (
              <ul>
                {visible.map((item) => (
                  <li key={item.id}>
                    <h3>{item.title}</h3>
                    <Receipt item={item} source />
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {data.items.length
                  ? "当前筛选下没有委派记录。"
                  : "暂无记录。可以从消息、想法、研发选题或经营实验委派一件事。"}
              </p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
