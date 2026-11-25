import type { ZoomMessage } from "../../src/zoom-types.ts";

export const taskKey = (item: ZoomMessage) => item.origin + "/" + item.taskId;
export function messageViews(messages: ZoomMessage[]) {
  const recent = [...messages].sort((a, b) => b.at.localeCompare(a.at));
  const pending = recent.filter(item => item.pending);
  const visibleTasks = new Set(pending.map(taskKey));
  const updates: ZoomMessage[] = [];
  const handled: ZoomMessage[] = [];
  const decisions = new Set<string>();
  for (const item of recent) {
    const task = taskKey(item);
    if (!visibleTasks.has(task) || item.failureNotice?.handledAt || (!item.pending && item.action && item.delegation)) {
      updates.push(item);
      visibleTasks.add(task);
    }
    if (item.kind === "reply" || item.kind === "completed" || item.failureNotice?.handledAt) {
      const decision = item.replyTo ?? item.id;
      if (!decisions.has(decision)) {
        handled.push(item);
        decisions.add(decision);
      }
    }
  }
  return { all: [...pending, ...updates], pending, handled };
}

export function messageText(item: ZoomMessage) {
  if (item.failureNotice) return { title: item.taskTitle, body: item.body };
  if (item.kind !== "question") return { title: item.taskTitle, body: item.taskTitle === item.body ? "" : item.body };
  const text = item.body.trim();
  const sentence = text.match(/^[^。！？!?\n]*(?:[。！？!?]+|$)/u)?.[0] || text.split("\n", 1)[0];
  if (!sentence || sentence.length > 180) return { title: item.taskTitle, body: text };
  return { title: sentence, body: text.slice(sentence.length).trimStart() };
}
