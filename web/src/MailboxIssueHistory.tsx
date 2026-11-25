import type { ExecutiveReceiptTrace } from "../../src/executive-bots-types";
import type { MailboxIssue, MailboxRecord } from "../../src/executive-mailbox-issues";
import { receiptPreview, receiptTitle } from "./ExecutiveReceipt";
import { messageText } from "./zoom-view";

const decisionLabels: Record<string, string> = {
  pending: "待拍板", approved: "已批准", rejected: "已驳回", snoozed: "已暂缓",
  changes_requested: "要求修改", superseded: "已被替代",
};

export function issueTaskTitle(issue: MailboxIssue, sourceTraces?: Record<string, ExecutiveReceiptTrace>) {
  const traces = [
    ...issue.receipts.map(item => item.trace),
    ...issue.messages.map(item => sourceTraces?.[item.id]),
  ];
  const tasks = traces.find(trace => trace?.origin?.patrolRunId && trace.affectedTasks.length)?.affectedTasks;
  if (!tasks?.length) return undefined;
  return tasks.length === 1 ? `${tasks[0].project} · ${tasks[0].title}` : `任务巡检 · ${tasks.length} 项任务异常`;
}

function recordInfo(record: MailboxRecord) {
  if (record.kind === "decision") {
    const packet = record.item;
    const label = packet.options.find(option => option.id === packet.chosenOptionId)?.label;
    const status = packet.status === "pending" && !record.pending ? "已失效 / 范围待核对" : decisionLabels[packet.status] || packet.status;
    return { kind: "审批", status, title: packet.title, text: label || packet.whyRecommended || packet.backgroundSummary };
  }
  if (record.kind === "executive") {
    const item = record.item;
    const status = { working: "执行中", completed: "已回执", failed: "执行异常", cancelled: "已取消", sent: "已送达" }[item.status];
    return { kind: item.direction === "outbound" ? "派单" : "Bot 回执", status: item.historical ? `${status} · 本地历史` : status, title: item.senderName + " · " + receiptTitle(item), text: receiptPreview(item) };
  }
  const item = record.item;
  const kind = item.kind === "reply" ? "原事项答复" : item.kind === "decision" ? "工作流审批"
    : item.source.includes("后台巡检卫士") ? "巡检告警" : item.kind === "completed" ? "任务完成" : "原事项";
  const info = messageText(item);
  return { kind, status: record.pending ? "待处理" : item.failureNotice ? (item.failureNotice.handledAt ? "已关闭" : "异常") : "已记录", title: info.title, text: info.body };
}

export function MailboxIssueHistory({ issue, selectedId, sourceTraces, onSelect }: {
  issue: MailboxIssue;
  selectedId: string;
  sourceTraces?: Record<string, ExecutiveReceiptTrace>;
  onSelect: (id: string) => void;
}) {
  if (issue.records.length < 2) return null;
  const records = [...issue.records].sort((a, b) => b.at.localeCompare(a.at));
  const taskTitle = issueTaskTitle(issue, sourceTraces);
  const label = issue.state === "pending" ? "待我拍板" : issue.state === "working" ? "处理中" : "已归档";
  return <section className="mb-issue-history" aria-label="同一事项的完整记录">
    <div className="mb-issue-heading">
      <div>
        <small>同一事项 · {issue.records.length} 条记录</small>
        {taskTitle && <h3>{taskTitle}</h3>}
      </div>
      <span className="mb-tag" data-tone={issue.pending ? "warn" : issue.state === "working" ? "info" : "good"}>{label}</span>
    </div>
    <details open={issue.state !== "pending"}>
      <summary>
        处理时间线
        <span>{[
          issue.messages.length ? `${issue.messages.length} 条原事项` : "",
          issue.receipts.length ? `${issue.receipts.length} 条 Bot 往来` : "",
          issue.decisions.length ? `${issue.decisions.length} 条审批记录` : "",
        ].filter(Boolean).join(" · ")} · 最新在前</span>
      </summary>
      <ol className="mb-issue-events">
        {records.map(record => {
          const info = recordInfo(record);
          return <li key={record.id}>
            <time>{new Date(record.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
            <button type="button" aria-current={selectedId === record.id ? "true" : undefined} onClick={() => onSelect(record.id)}>
              <span><b>{info.kind}</b><small>{info.status}</small></span>
              <strong>{info.title}</strong>
              {info.text && <span className="mb-issue-event-preview">{info.text}</span>}
            </button>
          </li>;
        })}
      </ol>
    </details>
    {issue.pending && !records.find(record => record.id === selectedId)?.pending && <p className="mb-issue-current">
      当前查看的是历史记录。<button type="button" onClick={() => onSelect(issue.primaryId)}>返回需要拍板的记录</button>
    </p>}
  </section>;
}
