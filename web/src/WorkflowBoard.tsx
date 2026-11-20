import { MessageDelegate } from "./Delegation";
import type { ZoomMessage } from "../../src/zoom-types";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DecisionAction, WorkflowAttempt, WorkflowCard, WorkflowDetail, WorkflowSummary } from "../../src/workflow-types";
import { api, type BoardMark, type BoardMarkAction } from "./api";
import "./workflow-paper.css";

const phases = { planning: "计划", execution: "执行", review: "评审", acceptance: "验收", complete: "完成" };
type BoardTurn = WorkflowSummary["turn"] | "requester";
const lanes: Array<{ turn: BoardTurn; title: string }> = [
  { turn: "human", title: "待人工决定" },
  { turn: "requester", title: "待发起者修订" },
  { turn: "agent", title: "执行器处理" },
  { turn: "recovery", title: "待人工恢复" },
  { turn: "done", title: "已完成" },
];
const states = { dispatching: "正在派发", running: "执行中", unknown: "等待对账", succeeded: "成功", failed: "失败" };
const cardKinds = { plan: "计划确认", gate: "人工答复", final: "最终验收" };
const actions = { approve: "批准", changes: "要求修改", reject: "拒绝" };
const nodeKinds = { implement: "实现", gate: "人工确认", review: "独立评审" };
const events: Record<string, string> = {
  submitted: "提交请求", revised: "提交新计划", dispatching: "安排执行", running: "执行已定位",
  unknown: "等待对账", failed: "执行失败", receipt: "收到回执", retry: "安排重试", fenced: "封存旧尝试",
  card_opened: "新决策卡", decision_approve: "已批准", decision_changes: "要求修改", decision_reject: "已拒绝",
  cleaned: "清理执行现场",
};

function isArchived(run: WorkflowSummary, mark?: BoardMark) {
  return mark?.archivedThrough === run.eventCount;
}

function boardTurn(run: WorkflowSummary): BoardTurn {
  return run.waitingForRevision ? "requester" : run.turn;
}

export function WorkflowBoard({ runId, id = runId ?? "", nav }: { runId?: string; id?: string; nav?: ReactNode }) {
  const [data, setData] = useState<{ runs: WorkflowSummary[]; run: WorkflowDetail | null }>({ runs: [], run: null });
  const [error, setError] = useState("");
  const [marks, setMarks] = useState<Record<string, BoardMark>>({});
  const [archive, setArchive] = useState(false);
  const [marking, setMarking] = useState(false);
  const mutation = useRef(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let current = true;
    let loading = false;
    setReady(false);
    const refresh = async () => {
      if (loading) return;
      loading = true;
      const started = mutation.current;
      try {
        const [list, run, views] = await Promise.all([api.workflows(), id ? api.workflow(id) : null, api.workflowMarks()]);
        if (current && started === mutation.current) {
          setData({ runs: list.runs, run });
          setMarks(Object.fromEntries(views.marks.map(mark => [mark.id, mark])));
          setReady(true);
          setError("");
        }
      } catch (error) {
        if (current) setError((error as Error).message);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1200);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id]);

  const updateRun = (run: WorkflowDetail) => {
    mutation.current++;
    setData(current => ({ runs: current.runs.map(item => item.id === run.id ? run.summary : item), run }));
  };
  const markRun = async (run: WorkflowSummary, action: BoardMarkAction) => {
    setMarking(true);
    setError("");
    try {
      const next = await api.markWorkflow(run.id, action, run.eventCount);
      mutation.current++;
      setMarks(current => ({ ...current, [next.id]: next }));
      if (action === "unarchive") setArchive(false);
    } catch (error) { setError((error as Error).message); }
    finally { setMarking(false); }
  };
  const archived = data.runs.filter(run => isArchived(run, marks[run.id]));
  const shown = archive ? archived : data.runs.filter(run => !isArchived(run, marks[run.id]));
  const detail = data.run?.id === id ? data.run : null;

  return <section className="zo-product workflow-board wf-paper" aria-label="工作流决策">
    <header className="wf-mast">
      {nav}
      {id ? <a href="#workflows">所有运行</a> : <h1>工作流决策</h1>}
      {id && detail && <div className="workflow-file-actions" aria-label="看板整理">
        {marks[id]?.seenThrough === detail.summary.eventCount
          ? <span>已读</span>
          : <button type="button" disabled={marking} onClick={() => void markRun(detail.summary, "read")}>标为已读</button>}
        <button type="button" disabled={marking} onClick={() => void markRun(detail.summary, isArchived(detail.summary, marks[id]) ? "unarchive" : "archive")}>
          {isArchived(detail.summary, marks[id]) ? "移回看板" : "归档此任务"}
        </button>
      </div>}
    </header>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {!ready ? <>{!error && <p role="status">正在读取工作流…</p>}</> : id ? <>
      {detail && <RunDetail key={id} run={detail} onChanged={updateRun} />}
    </> : <>
      <nav className="workflow-filters" aria-label="任务视图">
        <button type="button" aria-pressed={!archive} onClick={() => setArchive(false)}>看板 · {data.runs.length - archived.length}</button>
        <button type="button" aria-pressed={archive} onClick={() => setArchive(true)}>已归档 · {archived.length}</button>
      </nav>
      <div className="workflow-lanes">
      {lanes.map(lane => {
        const tasks = shown.filter(run => boardTurn(run) === lane.turn);
        return <section key={lane.turn} aria-label={lane.title}>
        <h2>{lane.title} <span>{tasks.length}</span></h2>
        {tasks.map(run =>
          <a className="workflow-card workflow-link" key={run.id} href={`#workflows/${run.id}`}>
            <strong>{run.goal}</strong><small>{phases[run.phase]} · r{run.revision} · {run.source}</small>
            {run.blockedReason && <span className="workflow-blocked">{run.blockedReason}</span>}
            {(marks[run.id]?.seenThrough ?? 0) < run.eventCount && <span className="workflow-unread">未读更新</span>}
          </a>)}
      </section>;
      })}
    </div></>}
  </section>;
}

type DetailProps = { run: WorkflowDetail; onChanged: (run: WorkflowDetail) => void };

function reveal(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current instanceof HTMLDetailsElement) current.open = true;
  }
  element.scrollIntoView({ block: "nearest" });
}

function runnerFor(run: WorkflowDetail, node: WorkflowDetail["revisions"][number]["plan"]["nodes"][number]) {
  if (node.kind === "gate") return "负责人确认";
  if (node.kind === "review") return run.runners?.review ?? "独立评审执行器";
  if (!node.capability) return run.runners?.implement ?? "默认实现执行器";
  const selected = run.runners?.capabilities.find(capability => capability.id === node.capability);
  return selected ? selected.label + " · " + selected.id : node.capability;
}

function RunDetail({ run, onChanged }: DetailProps) {
  const revision = run.revisions[run.revisions.length - 1];
  const decisions = run.cards.filter(card => card.status === "open" && card.revision === revision.number);
  const returned = run.cards.findLast(card => card.revision === revision.number && (card.status === "changes" || card.status === "reject"));
  const issues = run.attempts.filter(attempt =>
    run.attempts.findLast(item => item.nodeId === attempt.nodeId)?.id === attempt.id &&
    (attempt.state === "unknown" || (attempt.state === "failed" && run.released.includes(attempt.nodeId)
      && !run.events.some(event => event.kind === "retry" && event.attemptId === attempt.id))));
  const hasInFlight = run.attempts.some(attempt => ["dispatching", "running", "unknown"].includes(attempt.state));
  const canCleanup = !run.cleanedAt && !run.summary.readOnly && run.attempts.length > 0 && !hasInFlight &&
    (run.summary.phase === "complete" || returned?.status === "reject");
  const implement = [...new Set(revision.plan.nodes.filter(node => node.kind === "implement").map(node => runnerFor(run, node)))].join("、");
  return <>
    <section className="workflow-run wf-run-intro" aria-label="当前任务">
      <h1>{run.request.goal}</h1>
      <dl className="workflow-state">
        <div><dt>流程阶段</dt><dd>{phases[run.summary.phase]}</dd></div>
        <div><dt>当前责任方</dt><dd>{run.summary.waitingForRevision ? `发起者 · ${run.request.source}` : lanes.find(lane => lane.turn === run.summary.turn)?.title}</dd></div>
      </dl>
      <dl className="wf-routing">
        <div><dt>执行宿主</dt><dd>{run.backend === "herdr" ? "Herdr" : run.backend === "local-demo" ? "本地演示进程" : run.backend}</dd></div>
        {implement && <div><dt>实现</dt><dd>{implement}</dd></div>}
        <div><dt>独立评审</dt><dd>{run.runners?.review ?? "当前宿主未提供配置"}</dd></div>
      </dl>
      {run.summary.blockedReason && <p className="workflow-blocked" role="status">{run.summary.blockedReason}</p>}
    </section>
    {decisions.map(card => <div key={card.id}><Decision run={run} card={card} onChanged={onChanged}
      onInspectPlan={() => reveal("wf-plan-" + run.id)} /><MessageDelegate cardId={card.id} personal/></div>)}
    {returned && <section className="wf-next">
      <h2>{returned.status === "changes" ? "要求修改" : "已拒绝"} · r{revision.number}</h2>
      <blockquote>{returned.note}</blockquote>
      <p>等待 {run.request.source} 读取反馈，处理原任务 {run.request.context}。</p>
    </section>}
    {issues.length > 0 && <section className="wf-next" aria-label="待恢复的节点"><h2>核对与返工</h2>
      {issues.map(attempt => <div key={attempt.id}><Attempt attempt={attempt} run={run} onChanged={run.summary.readOnly ? undefined : onChanged} anchor={false} /><MessageDelegate attemptId={attempt.id}/></div>)}
    </section>}
    {!decisions.length && !returned && !issues.length && <p className="wf-next-line">
      {run.summary.phase === "complete" ? "这项任务已经验收，执行证据和决定保存在下方。" : "OPC OS 正在等待节点回执。可打开执行记录核对进展。"}
    </p>}
    {run.cleanedAt
      ? <p className="wf-cleanup-note">执行终端与临时工作树已于 <time dateTime={run.cleanedAt}>{new Date(run.cleanedAt).toLocaleString()}</time> 清理（回执与差异已保留）。</p>
      : canCleanup && <CleanupAction run={run} onChanged={onChanged} />}
    <details id={"wf-plan-" + run.id} className="wf-fold"><summary>计划与依赖 <small>r{revision.number} · {revision.plan.nodes.length} 个节点</small></summary>
      <PlanDetails run={run} />
    </details>
    {run.attempts.length > 0 && <details className="wf-fold"><summary>执行记录与证据 <small>{run.attempts.length} 次尝试</small></summary>
      {run.attempts.map(attempt => <Attempt key={attempt.id} attempt={attempt} run={run} anchor />)}
    </details>}
    <details className="wf-fold wf-history-fold"><summary>反馈与运行历史 <small>{run.events.length} 条</small></summary>
      <ol className="workflow-history">{run.events.map((event, index) => {
        const card = event.cardId && run.cards.find(card => card.id === event.cardId);
        return <li key={index}>
          <strong>{events[event.kind] ?? event.kind}</strong> · r{event.revision}
          {card && event.kind.startsWith("decision_") && <> · {cardKinds[card.kind]}</>}
          {event.actor && <> · {event.actor}</>}
          {event.nodeId && <> · {event.nodeId}</>}
          <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
          {event.note && <p>{card && event.kind === "card_opened" ? cardKinds[card.kind] : event.note}</p>}
        </li>;
      })}</ol>
    </details>
    <details className="wf-fold"><summary>原会话与反馈取回 <small>{run.request.source}</small></summary>
      <p>反馈保存到 {run.request.source} 的任务 {run.request.context}，由发起者在原会话读取。已结束的会话需要发起者重新打开。</p>
      <pre><code>opc-os feedback {run.id} 0 --wait</code></pre>
      <p>下次读取时用上次返回的 cursor 替换 0。</p><p>基线 <code>{run.base}</code></p>
    </details>
  </>;
}

function CleanupAction({ run, onChanged }: DetailProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const runCleanup = async () => {
    setBusy(true);
    setError("");
    try {
      onChanged(await api.workflowAction(run.id, "cleanup", {}));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="wf-cleanup-bar">
    <button type="button" disabled={busy} onClick={() => void runCleanup()}>
      {busy ? "正在清理…" : "清理终端与工作树"}
    </button>
    <small>会关闭本次运行的 Herdr 终端并移除临时 worktree，完整回执与差异保留在本地数据库。</small>
    {error && <p className="workflow-error" role="alert">{error}</p>}
  </div>;
}

function ScopeText({text}: {text:string}) {
  return <>{text.split(/(#capabilities\?request=[\da-f-]{36})/gi).map((part, index) =>
    part.startsWith("#capabilities?request=") ? <a key={index} href={part}>查看原记录 ↗</a> : part)}</>;
}

function PlanDetails({ run, number }: { run: WorkflowDetail; number?: number }) {
  const revision = run.revisions.find(item => item.number === number) ?? run.revisions[run.revisions.length - 1];
  const check = revision.reuseCheck;
  return <section className="workflow-card">
      <h3>计划 r{revision.number}</h3>
      <p>{revision.reason}</p>
      {run.reusePolicy && <section className="wf-scope">
        <h4>{run.reusePolicy === "upstream" ? "原仓维护范围与验收" : "采用场景与要求"}</h4>
        <p><ScopeText text={run.request.context}/></p>
      </section>}
      {run.request.constraints.length > 0 && <details className="wf-constraints">
        <summary>原请求约束与证据</summary><ul>{run.request.constraints.map((constraint, index) =>
          <li key={index}><ScopeText text={constraint}/></li>)}</ul>
      </details>}
      <ol>{revision.plan.nodes.map(node => <li key={node.id}>
        <strong>{node.title}</strong> <small>{nodeKinds[node.kind]} · <code>{node.id}</code>{node.capability && <> · {node.capability}</>}</small>
        <p>{node.instruction}</p>
        {node.dependsOn.length > 0 && <small>依赖 {node.dependsOn.join("、")}</small>}
        {revision.number === run.summary.revision && revision.gatedNodes.includes(node.id) && !run.released.includes(node.id) && <small> · 等待确认</small>}
      </li>)}</ol>
      <p>最终验收依据 {revision.plan.acceptance.join("、")}</p>
      {check && <details className="wf-reuse-check"><summary>开工前核查已有能力{check.suggestions.length > 0 && <> · {check.suggestions.length} 项可核对</>}</summary>
        <p>{check.instruction}</p>
        <a href="#capabilities">查看开源能力目录 ↗</a>　<code>{check.command}</code>
        {check.suggestions.length > 0 && <ul>{check.suggestions.slice(0,4).map(cap =>
          <li key={cap.id}><a href={"#capabilities?"+new URLSearchParams({capability:cap.id})}>{cap.name} · {cap.version}</a>　{cap.repo}</li>)}</ul>}
      </details>}
      {number === undefined && run.revisions.length > 1 && <details><summary>历史计划</summary>{run.revisions.slice(0, -1).reverse().map(item =>
        <section key={item.number}><h4>r{item.number} · {item.reason}</h4><pre>{JSON.stringify(item.plan, null, 2)}</pre></section>)}</details>}
    </section>;
}

export function WorkflowMessageContent({ run, message, onChanged }: DetailProps & { message: ZoomMessage }) {
  const action = message.pending && !run.summary.readOnly ? message.action : undefined;
  const revision = run.revisions.find(item => item.number === message.revision) ?? run.revisions[run.revisions.length - 1];
  const plan = <details className="zo-plan"><summary>查看计划 r{revision.number} · {revision.plan.nodes.length} 个节点</summary>
    <PlanDetails run={run} number={revision.number} />
  </details>;
  let content;
  if (action?.kind === "decision") {
    const card = run.cards.find(item => item.id === action.cardId && item.revision === action.revision && item.status === "open");
    content = card ? <>
      {card.kind === "plan" && plan}
      <Decision run={run} card={card} onChanged={onChanged} />
      {card.kind === "final" && <details className="zo-evidence"><summary>查看评审与测试证据</summary>
        {run.attempts.filter(item => revision.plan.acceptance.includes(item.nodeId)).map(item =>
          <Attempt key={item.id} run={run} attempt={item} anchor />)}
      </details>}
    </> : <p role="status">这项决定已更新，请查看最新消息。</p>;
  } else if (action?.kind === "retry" || action?.kind === "recover") {
    const attempt = run.attempts.find(item => item.id === action.attemptId);
    content = attempt && run.summary.revision === action.revision
      ? <Attempt run={run} attempt={attempt} onChanged={onChanged} /> : <p role="status">这次尝试已更新，请查看最新消息。</p>;
  } else {
    const receipt = run.attempts.find(item => item.id === message.attemptId);
    const others = run.attempts.filter(item => item !== receipt);
    content = <>
      {receipt && <Attempt run={run} attempt={receipt} />}
      {plan}
      {others.length > 0 && <details className="zo-evidence"><summary>执行记录与证据 · {others.length}</summary>
        {others.map(attempt => <Attempt key={attempt.id} run={run} attempt={attempt} />)}</details>}
    </>;
  }
  return <>
    <dl className="zo-workflow-state">
      <div><dt>执行宿主</dt><dd>{run.backend === "herdr" ? "Herdr" : run.backend === "local-demo" ? "本地模拟" : run.backend}</dd></div>
      {run.runners?.implement && <div><dt>默认实现</dt><dd>{run.runners.implement}</dd></div>}
      <div><dt>流程阶段</dt><dd>{phases[run.summary.phase]}</dd></div>
      <div><dt>当前责任方</dt><dd>{run.summary.waitingForRevision ? `发起者 · ${run.request.source}` : lanes.find(lane => lane.turn === run.summary.turn)?.title}</dd></div>
    </dl>
    {run.summary.blockedReason && <p className="zo-workflow-reason">{run.summary.blockedReason}</p>}
    {content}
  </>;
}

function Decision({ run, card, onChanged, onInspectPlan }: DetailProps & { card: WorkflowCard; onInspectPlan?: () => void }) {
  const [note, setNote] = useState("");
  const [cleanup, setCleanup] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = run.revisions.at(-1)!;
  const question = revision.plan.nodes.find(node => node.id === card.nodeId);
  const available = run.runners?.capabilities ?? [];
  const [choice, setChoice] = useState<{ nodeId: string; capability: string } | null>(null);
  const selectable = card.kind === "plan" && !run.summary.readOnly && available.length
    ? revision.plan.nodes.filter(node => node.kind === "implement" && !run.attempts.some(attempt => attempt.nodeId === node.id)) : [];
  const changeRunner = async () => {
    if (!choice || busy) return;
    setBusy(true); setError("");
    try {
      onChanged(await api.workflowAction(run.id, "runners", {
        cardId: card.id, baseRevision: card.revision, nodeId: choice.nodeId, capability: choice.capability || null,
      }));
      setChoice(null);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };

  const decide = async (action: DecisionAction) => {
    setError("");
    if (action !== "approve" && !note.trim()) { setError("请填写要发回原请求的反馈"); return; }
    setBusy(true);
    try {
      const payload = {
        cardId: card.id, revision: card.revision, action, note,
        ...(card.kind === "final" && action === "approve" && cleanup ? { cleanup: true } : {}),
      };
      onChanged(await api.workflowAction(run.id, "decisions", payload));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };

  return <section className="workflow-card workflow-decision" data-kind={card.kind}>
    <h3>{cardKinds[card.kind]} · r{card.revision}</h3>
    {onInspectPlan && card.kind === "plan" && <button type="button" className="wf-plan-link" onClick={onInspectPlan}>查看当前版本的计划与依赖</button>}
    {selectable.length > 0 && <details className="wf-runner-choice"><summary>选择实现节点的执行器</summary>
      {selectable.map(node => <label key={node.id}>{node.title}<select disabled={busy} aria-label={node.title + "的执行器"}
        value={choice?.nodeId === node.id ? choice.capability : node.capability ?? ""}
        onChange={event => setChoice(event.target.value === (node.capability ?? "") ? null : { nodeId: node.id, capability: event.target.value })}>
        <option value="">默认 · {run.runners?.implement}</option>
        {available.map(runner => <option key={runner.id} value={runner.id}>{runner.label} · {runner.id}</option>)}
      </select></label>)}
      <button type="button" disabled={busy || !choice} onClick={() => void changeRunner()}>保存执行器并生成新版</button>
    </details>}
    {question && <p>{question.instruction}</p>}
    {card.kind === "final" && <ul>{run.revisions.at(-1)?.plan.acceptance.map(nodeId => {
      const review = run.attempts.findLast(attempt => attempt.nodeId === nodeId);
      return <li key={nodeId}><button type="button" onClick={() => {
        const attempt = document.getElementById(`attempt-${review?.id}`);
        const group = attempt?.closest("details");
        if (group) group.open = true;
        attempt?.scrollIntoView({ block: "nearest" });
      }}>{nodeId}</button> · {review?.evidence?.summary}</li>;
    })}</ul>}
    <label>发回原请求的反馈<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={4000} rows={3} /></label>
    {card.kind === "final" && <label className="wf-cleanup-opt">
      <input type="checkbox" checked={cleanup} disabled={busy} onChange={event => setCleanup(event.target.checked)} />
      批准后清理 Herdr 终端与临时工作树（保留回执与差异）
    </label>}
    <p className="zo-delivery">决定与反馈写入本次任务。发起者可以取回反馈，提交后续版本。</p>
    <div className="workflow-actions">{(Object.keys(actions) as DecisionAction[]).map(action =>
      <button type="button" key={action} disabled={busy || Boolean(choice)} onClick={() => void decide(action)}>{actions[action]}</button>)}</div>
    {error && <p className="workflow-error" role="alert">{error}</p>}
  </section>;
}

function Attempt({ attempt, run, onChanged, anchor = Boolean(onChanged) }: {
  attempt: WorkflowAttempt; run: WorkflowDetail; onChanged?: DetailProps["onChanged"]; anchor?: boolean;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = run.attempts.findLast(item => item.nodeId === attempt.nodeId)?.id === attempt.id;
  const retryQueued = run.events.some(event => event.kind === "retry" && event.attemptId === attempt.id);
  const action = attempt.state === "unknown" ? "recover"
    : attempt.state === "failed" && run.released.includes(attempt.nodeId) && !retryQueued ? "retry" : null;
  const recover = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || !onChanged) return;
    setBusy(true);
    setError("");
    try {
      onChanged(await api.workflowAction(run.id, action, { attemptId: attempt.id, revision: run.summary.revision, note }));
      setNote("");
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };

  return <article className="workflow-attempt" id={anchor ? `attempt-${attempt.id}` : undefined}>
    <h4>{attempt.nodeId} · {states[attempt.state]} · r{attempt.revision}</h4>
    <p><code>{attempt.id}</code>{attempt.terminal && <> · <code>{attempt.terminal}</code></>}</p>
    <p><code>{attempt.worktree}</code>{run.cleanedAt && <small> · 已清理</small>}</p>
    {run.backend === "herdr" && attempt.terminal && !run.cleanedAt && <p>查看 Herdr 终端 <code>hc read {attempt.terminal}</code></p>}
    {attempt.leaseUntil && attempt.state === "running" && <p>租约至 <time dateTime={attempt.leaseUntil}>{new Date(attempt.leaseUntil).toLocaleString()}</time></p>}
    {attempt.problem && <p>{attempt.problem}</p>}
    {attempt.evidence && <>
      <p>{attempt.evidence.summary}</p>
      <details><summary>检查、产物与差异</summary>
        {attempt.evidence.checks.map((check, index) => <div key={index}><strong>{check.name} · 退出码 {check.exitCode}</strong><pre>{check.output}</pre></div>)}
        {attempt.evidence.artifacts.map((artifact, index) => <div key={index}><strong>{artifact.name}</strong><pre>{artifact.content}</pre></div>)}
        {attempt.evidence.patch && <pre>{attempt.evidence.patch}</pre>}
      </details>
    </>}
    {current && retryQueued && <p>已排队重试</p>}
    {onChanged && current && action && <form onSubmit={recover}>
      <label>{action === "retry" ? "交给重试执行器的反馈" : "对账说明"}
        <input value={note} onChange={event => setNote(event.target.value)} maxLength={4000} required />
      </label>
      <button type="submit" disabled={busy}>{action === "retry" ? "重试" : "对账并封存未领取尝试"}</button>
      {error && <p className="workflow-error" role="alert">{error}</p>}
    </form>}
  </article>;
}
