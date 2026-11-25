import { useState } from "react";
import type { ExecutiveMailItem, ExecutiveReceiptTrace } from "../../src/executive-bots-types";
import type { DecisionOption, DecisionPacket } from "../../src/kernel/types";
import { summarizeExecutiveReceipt } from "../../src/executive-receipt-summary";
import { LinkedText } from "./InternalLinks";

const taskStatus: Record<string, string> = {
  todo: "待办", assigned: "已分配", in_progress: "执行中", pr_open: "PR 已打开",
  review: "评审中", done: "已完成", published: "已发布", failed: "失败",
  archived: "已归档", blocked: "受阻",
  missing: "任务不存在",
  completed: "已完成", cancelled: "已取消", no_output: "没有执行产物", running: "执行中",
};
export const taskStateLabel = (status: string) => taskStatus[status] || status || "未知";

const decisionStatus: Record<string, string> = {
  pending: "待拍板", approved: "已批准", rejected: "已驳回",
  snoozed: "已暂缓", changes_requested: "要求修改", superseded: "已被替代",
  open: "待拍板", approve: "已批准", reject: "已驳回", changes: "要求修改", handled: "已处理",
};

function dateLabel(value?: string) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function receiptTitle(item: ExecutiveMailItem) {
  const projects = [...new Set(item.trace?.affectedTasks.map(task => task.project) ?? [])];
  const trace = item.trace;
  const title = trace?.origin?.patrolRunId
    ? `任务巡检 · ${trace.affectedTasks.length} 项异常` : trace?.origin?.title;
  return projects.length
    ? `${projects.join("、")} · ${title || "部门回执"}`
    : title || item.subject;
}

export function receiptPreview(item: ExecutiveMailItem) {
  if (!item.trace) return item.excerpt;
  const summary = summarizeExecutiveReceipt({
    status: item.trace.status, report: item.trace.result, evidence: item.trace.evidence,
    deliveryUnavailable: item.trace.deliveryUnavailable,
  });
  return summary.conclusion || summary.gap || item.excerpt;
}

function decisionResult(packet: DecisionPacket) {
  const label = packet.options.find(option => option.id === packet.chosenOptionId)?.label;
  const outcome = decisionStatus[packet.status] ?? packet.status;
  const result = packet.handlerResult;
  if (!result) return [outcome, label].filter(Boolean).join(" · ");
  const countFields = [
    ["requeuedCount", "已重置为待办"],
    ["snoozedCount", "已暂缓"],
    ["archivedCount", "已归档"],
  ];
  const counts = countFields.flatMap(([key, explanation]) => typeof result[key] === "number"
    ? [`${explanation} ${result[key]} 项`] : []);
  return [outcome, label, ...counts, result.executed === false ? "未执行动作回调" : ""].filter(Boolean).join(" · ");
}

export function ReceiptOverview({ item, packet, onOpenDecision, onOpenMessage }: {
  item: ExecutiveMailItem; packet?: DecisionPacket; onOpenDecision?: (id: string) => void;
  onOpenMessage?: (id: string) => void;
}) {
  const trace = item.trace;
  if (!trace) return null;
  const summary = summarizeExecutiveReceipt({
    status: trace.status, report: trace.result, evidence: trace.evidence,
    deliveryUnavailable: trace.deliveryUnavailable,
  });
  const origin = trace.origin;
  const decision = trace.decision;
  const actionable = packet ? packet.status === "pending" && !packet.actionBlockReason : Boolean(decision?.actionable && decision.kind !== "kernel");
  const changedTasks = trace.affectedTasks.filter(task => task.observedStatus && task.observedStatus !== task.status);
  const decisionText = packet
    ? packet.status === "pending"
      ? actionable ? "待你选择原审批单的处理方式" : "历史审批范围已变化，已移出待我拍板"
      : decisionResult(packet)
    : decision
      ? decision.kind === "kernel" ? "当前无法核对原审批单" : `${decisionStatus[decision.status] ?? decision.status} · 原事项`
      : "暂无可直接执行的关联审批单";
  return (
    <section className="mb-receipt" aria-label="事项来龙去脉">
      <div className="mb-receipt-answer" data-actionable={actionable}>
        <span>现在轮到你做什么</span>
        <strong>{decisionText}</strong>
        {packet?.decidedAt && <small>决定时间 {dateLabel(packet.decidedAt)}</small>}
        {decision?.kind === "kernel" && onOpenDecision && <button type="button"
          onClick={() => onOpenDecision(decision.id)}>查看原审批单 ↗</button>}
        {decision && decision.kind !== "kernel" && (onOpenMessage && origin?.messageId
          ? <button type="button" onClick={() => onOpenMessage(origin.messageId!)}>查看原事项与处理选项 ↗</button>
          : <a href={decision.href}>查看原事项与处理选项 ↗</a>)}
      </div>

      <ol className="mb-receipt-path" aria-label="事项流转">
        <li><small>{dateLabel(trace.createdAt) || "来源"}</small><div>
          <strong>触发事项</strong>
          <p>{origin?.patrolRunId ? `巡检发现 ${trace.affectedTasks.length} 项需要处理的任务` : origin?.title || "部门工单"}</p>
          {origin && <a href={origin.href}>查看来源 ↗</a>}
        </div></li>
        <li><small>{dateLabel(trace.requestedAt) || "派单"}</small><div>
          <strong>交给 {item.senderName} 办理</strong>
          <p>{origin?.patrolRunId ? "核查异常任务的执行现场，提交处置建议和依据供你决定。" : trace.purpose || "查看原始派单了解处理目标。"}</p>
        </div></li>
        <li><small>{dateLabel(trace.returnedAt || item.createdAt) || "回执"}</small><div>
          <strong data-status={trace.status}>{item.source === "executive_room" && trace.status === "sent" ? "消息已送达" : summary.statusLabel}</strong>
        </div></li>
        <li><small>{packet?.decidedAt ? dateLabel(packet.decidedAt) : "审批"}</small><div>
          <strong>{packet ? (decisionStatus[packet.status] ?? packet.status) :
            decision ? (decisionStatus[decision.status] ?? decision.status) : "等待确认审批对象"}</strong>
        </div></li>
      </ol>

      <section className="mb-receipt-section" aria-label="原因及目标">
        <h3>为什么有这件事</h3>
        <p><LinkedText text={trace.background || origin?.title || "可在下方原始派单中核对具体背景。"} /></p>
        {trace.affectedTasks.length > 0 && <div className="mb-receipt-tasks">
          {trace.affectedTasks.map(task => <article key={task.id}>
            <small>{task.project}</small>
            <strong>{task.title}</strong>
            <p>巡检时 <b>{taskStatus[task.observedStatus] || task.observedStatus || "未知"}</b>
              {" → "}当前 <b>{taskStatus[task.status] || task.status || "未知"}</b></p>
            {task.latestRun && <p>最近一次执行 {taskStatus[task.latestRun.status] || task.latestRun.status}
              {task.latestRun.errorSummary && ` · ${task.latestRun.errorSummary}`}
              {task.latestRun.completedAt && ` · ${dateLabel(task.latestRun.completedAt)}`}</p>}
            {task.latestRunId && <a href={"#dark-factory?" + new URLSearchParams({ run: task.latestRunId })}>查看最近一次执行 ↗</a>}
          </article>)}
        </div>}
        {changedTasks.length > 0 && packet?.status === "pending" &&
          <p className="mb-receipt-warning">有 {changedTasks.length} 项任务的当前状态已发生变化，请核对最新状态再处理原审批。</p>}
      </section>

      <section className="mb-receipt-section" aria-label="结果及依据">
        <h3>做了什么、结果是什么</h3>
        {summary.conclusion && <p>{summary.conclusion}</p>}
        {summary.gap && <p className="mb-receipt-warning">{summary.gap}</p>}
        {trace.failureReason && <p>{trace.failureReason}</p>}
        {summary.recommendation && <div className="mb-rec-box"><strong>Bot 的建议</strong><p>{summary.recommendation}</p></div>}
        {summary.evidence.length > 0 && <div><h4>已附证据</h4><ul>{summary.evidence.map(e =>
          <li key={e}><LinkedText text={e} /></li>)}</ul></div>}
        {summary.citedEvidence.length > 0 && <div><h4>Bot 在报告中列出的依据</h4><ul>{summary.citedEvidence.map(e =>
          <li key={e}><LinkedText text={e} /></li>)}</ul></div>}
      </section>
    </section>
  );
}

export function approvalInstruction(packet: DecisionPacket, option: DecisionOption, trace?: ExecutiveReceiptTrace) {
  const ids = Array.isArray(option.payload?.taskIds) && option.payload.taskIds.every(id => typeof id === "string")
    ? option.payload.taskIds as string[] : [];
  const traceMatchesScope = trace?.affectedTasks.length && (!ids.length ||
    (trace.affectedTasks.length === ids.length && trace.affectedTasks.every(task => ids.includes(task.id))));
  const target = traceMatchesScope && trace
    ? trace.affectedTasks.map(task => `- [${task.project}] ${task.title}（${task.id}）`).join("\n")
    : [packet.targetSummary?.mainlineName, packet.targetSummary?.productName,
      packet.targetSummary?.repoFullName || packet.targetSummary?.assetName,
      ids.length ? "任务 " + ids.join("、") : null].filter(Boolean).join(" / ") || packet.backgroundSummary;
  return [
    `审批事项：${packet.title}`,
    `选择：${option.label}`,
    target ? "影响范围：\n" + target : "影响范围：以本审批单绑定的事项为准",
    option.description ? "执行效果：" + option.description : "",
    `审批单 ${packet.id} / 选项 ${option.id}`,
  ].filter(Boolean).join("\n");
}

export function ApprovalCommands({ packet, trace, note, setNote, busy, onResolve }: {
  packet: DecisionPacket;
  trace?: ExecutiveReceiptTrace;
  note: string;
  setNote: (value: string) => void;
  busy: boolean;
  onResolve: (packet: DecisionPacket, optionId: string) => void;
}) {
  const allowed = packet.status === "pending" && !packet.actionBlockReason && packet.options.length > 0;
  const [optionId, setOptionId] = useState(() => allowed ? packet.recommendedOptionId ?? "" : "");
  const chosen = packet.options.find(option => option.id === optionId);
  if (packet.status !== "pending") {
    const executed = packet.options.find(option => option.id === packet.chosenOptionId);
    return <section className="mb-receipt-section">
      <h3>已选择的审批指令</h3>
      <p>{decisionResult(packet)}</p>
      {(packet.decidedBy || packet.decidedAt || packet.decisionNote) && <p>
        {packet.autoApproved ? "策略自动批准" : packet.decidedBy ? `拍板人 ${packet.decidedBy}` : ""}
        {packet.decidedAt && ` · ${dateLabel(packet.decidedAt)}`}
        {packet.decisionNote && `\n批注：${packet.decisionNote}`}
      </p>}
      {executed && <details className="mb-command-draft">
        <summary>查看当时的审批指令</summary>
        <pre>{approvalInstruction(packet, executed, trace)}</pre>
      </details>}
    </section>;
  }
  if (!allowed) return (
    <section className="mb-reply-card mb-command" aria-label="审批指令">
      <h3>原审批范围需要核对</h3>
      <p>{packet.actionBlockReason || "关联任务的当前状态或审批范围已发生变化。请从原事项查看最新任务状态后决定下一步。"}</p>
      <p>此审批已经移出待我拍板，作为历史记录保留。</p>
      {trace?.origin && <a href={trace.origin.href}>核对原事项 ↗</a>}
    </section>
  );
  return (
    <section className="mb-reply-card mb-command" aria-label="审批指令">
      <h3>需要你审批什么</h3>
      <p>选择处理方式，系统将生成对应审批指令。</p>
      {packet.whyRecommended && <p className="mb-command-reason"><b>系统推荐理由</b>　{packet.whyRecommended}</p>}
      <div className="mb-command-options">
        {packet.options.map(option => <button type="button" key={option.id} aria-pressed={optionId === option.id}
          disabled={busy} onClick={() => setOptionId(option.id)}>
          <strong>{option.label}</strong>
          {option.id === packet.recommendedOptionId && <small className="mb-command-recommended">系统推荐</small>}
          {option.description && <span>{option.description}</span>}
        </button>)}
      </div>
      {chosen && <>
        <div className="mb-command-draft">
          <h4>已生成审批指令</h4>
          <pre>{approvalInstruction(packet, chosen, trace)}</pre>
        </div>
        <label>补充批注（选填）
          <textarea aria-label="补充批注（选填）" rows={2} value={note} disabled={busy} onChange={event => setNote(event.target.value)} />
        </label>
        <button type="button" className="mb-primary" disabled={busy} onClick={() => onResolve(packet, chosen.id)}>
          {busy ? "执行中…" : `确认执行「${chosen.label}」`}
        </button>
      </>}
    </section>
  );
}
