import { basename } from "node:path";
import type { WorkflowRun } from "../workflow-types.ts";
import type { ZoomAction, ZoomMessage } from "../zoom-types.ts";

const decisions: Record<string, string> = { decision_approve: "已批准", decision_changes: "要求修改", decision_reject: "已拒绝" };
const cardLabels = { plan: "确认计划", final: "最终验收", gate: "节点确认" };
const staleClosePattern = /已过期|自动收敛|已被.*覆盖|superseded/i;

function formatDecisionLabel(cardKind: "plan" | "final" | "gate", eventKind: string, actor?: string, note?: string): string {
  const isBot = Boolean(actor && actor.startsWith("bot:"));
  const isStale = staleClosePattern.test(note ?? "");
  if (isBot && isStale) {
    return `${cardLabels[cardKind]} · Bot 已代拍板 · 已过期自动收敛`;
  }
  if (isBot) {
    return `${cardLabels[cardKind]} · Bot 已代拍板 · ${decisions[eventKind]}`;
  }
  if (isStale && eventKind === "decision_reject") {
    return `${cardLabels[cardKind]} · 已过期自动收敛`;
  }
  return `${cardLabels[cardKind]} · ${decisions[eventKind]}`;
}

export function workflowMessages(run: WorkflowRun, execution?: { sameHost: boolean; sameBackend: boolean; blockedReason?: string }): ZoomMessage[] {
  const messages: ZoomMessage[] = [];
  const revision = run.revisions[run.revisions.length - 1];
  const lastAttempt = new Map(run.attempts.map(attempt => [attempt.nodeId, attempt.id]));
  const attempts = new Map(run.attempts.map(attempt => [attempt.id, attempt]));
  const cards = new Map(run.cards.map(card => [card.id, card]));
  const retryQueued = new Set(run.events.filter(event => event.kind === "retry").map(event => event.attemptId));
  const latestProblem = new Map<string, number>();
  run.events.forEach((event, index) => {
    if (event.attemptId && ["unknown", "failed", "receipt", "fenced"].includes(event.kind)) latestProblem.set(event.attemptId, index);
  });

  run.events.forEach((event, index) => {
    const card = event.cardId && cards.get(event.cardId);
    const attempt = event.attemptId && attempts.get(event.attemptId);
    const node = run.revisions[event.revision - 1]?.plan.nodes.find(item => item.id === event.nodeId);
    let id = `workflow:${run.id}:${index}`;
    let kind: ZoomMessage["kind"] = "progress";
    let body = event.note;
    let action: ZoomAction | undefined;
    let replyTo: string | undefined;
    if (event.kind === "card_opened" && card) {
      id = `workflow:card:${card.id}`;
      kind = "decision";
      const base = card.kind === "gate" && node ? node.instruction : `${cardLabels[card.kind]} · r${card.revision}`;
      body = card.status === "superseded" ? `${base} · 已覆盖` : base;
      if (card.status === "open" && card.revision === revision.number) {
        action = { kind: "decision", cardId: card.id, revision: card.revision };
      }
    } else if (decisions[event.kind] && card) {
      kind = card.kind === "final" && event.kind === "decision_approve" ? "completed" : "reply";
      body = [formatDecisionLabel(card.kind, event.kind, event.actor, event.note), event.note].filter(Boolean).join(" — ");
      replyTo = `workflow:card:${card.id}`;
    } else if (event.kind === "submitted") {
      kind = "task";
      body = run.request.goal;
    } else if (event.kind === "running" && attempt) {
      body = `开始${node?.kind === "review" ? "独立评审" : "执行"} · ${node?.title ?? attempt.nodeId}`;
    } else if (["unknown", "failed", "receipt", "fenced"].includes(event.kind) && attempt) {
      const issue = event.kind !== "receipt" || attempt.evidence?.outcome === "failed";
      kind = issue ? "recovery" : "progress";
      body = [node?.title, event.note || attempt.problem].filter(Boolean).join(" — ");
      if (latestProblem.get(attempt.id) === index && lastAttempt.get(attempt.nodeId) === attempt.id) {
        if (attempt.state === "unknown" && execution?.sameHost !== false) action = { kind: "recover", attemptId: attempt.id, revision: revision.number };
        if (attempt.state === "failed" && execution?.sameBackend !== false && run.released.includes(attempt.nodeId) && !retryQueued.has(attempt.id)) {
          action = { kind: "retry", attemptId: attempt.id, revision: revision.number };
        }
      }
    } else if (event.kind === "retry") {
      body = "已安排返工 — " + event.note;
    } else if (event.kind === "revised") {
      body = `计划修订为 r${event.revision} — ${event.note}`;
    } else return;
    messages.push({ id, kind, body, origin: "workflow", taskId: run.id, taskTitle: run.request.goal, source: run.request.source,
      folder: run.request.folder || basename(run.workspace) || "未归类", at: event.at, actor: event.actor,
      revision: event.revision, attemptId: event.attemptId, stage: run.request.stage,
      ...(kind === "recovery" && { recoveryAction: event.kind === "unknown" ? "recover" as const : "retry" as const }),
      pending: Boolean(action), action: execution ? action : undefined, replyTo, context: run.request.context,
      ...(!execution && { readOnly: true }) });
  });
  if (execution?.blockedReason) {
    messages.push({ id: `workflow:${run.id}:configuration`, taskId: run.id, taskTitle: run.request.goal, origin: "workflow",
      kind: "recovery", source: run.request.source, folder: run.request.folder || basename(run.workspace) || "未归类",
      context: run.request.context, stage: run.request.stage, body: execution.blockedReason, at: run.events.at(-1)?.at ?? run.createdAt, pending: false });
  }
  return messages;
}
