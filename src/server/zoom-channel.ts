import type { ZoomMessage } from "../zoom-types.ts";
import type { Principal, Store } from "./logic.ts";

// Direct rooms shared by two agents are visible to their owners for observation.
// Only an undirected question for a person should enter their decision queue.
export const humanChannelQuestion = `m.author_type = 'agent' AND m.kind IN ('question','blocked') AND m.addressed_json = '[]'
  AND (r.direct = 0 OR (SELECT count(*) FROM room_members peers WHERE peers.room_id = r.id AND peers.principal_type = 'agent') = 1)`;

type ChannelRow = {
  id: string; room_id: string; room_name: string; project: string; direct: number;
  task_id: string | null; title: string | null; source: string; actor: string | null;
  body: string; kind: string; at: string; question_id: string | null; question_body: string | null;
  status: string | null; updated_at: string | null;
  human_question: number; answered: number;
};

export function channelMessages(store: Store, user: Extract<Principal, { type: "user" }>): ZoomMessage[] {
  const rows = store.db.prepare(`SELECT m.id, m.room_id, r.name AS room_name, r.project, r.direct,
    m.task_id, t.title, t.status, t.updated_at, COALESCE(original_agent.handle, a.handle, u.name, r.name) AS source, u.name AS actor,
    m.body, m.kind, m.created_at AS at, answered.question_id, original.body AS question_body,
    (${humanChannelQuestion}) AS human_question, (receipt.reply_id IS NOT NULL) AS answered
    FROM room_members membership JOIN rooms r ON r.id = membership.room_id
    JOIN messages m ON m.room_id = r.id LEFT JOIN tasks t ON t.id = m.task_id
    LEFT JOIN agents a ON m.author_type = 'agent' AND a.id = m.author_id
    LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
    LEFT JOIN channel_question_replies receipt ON receipt.question_id = m.id
    LEFT JOIN channel_question_replies answered ON answered.reply_id = m.id
    LEFT JOIN messages original ON original.id = answered.question_id
    LEFT JOIN agents original_agent ON original_agent.id = original.author_id
    WHERE membership.principal_type = 'user' AND membership.principal_id = ? AND membership.hidden = 0 AND r.archived = 0
    AND (m.kind = 'instruction' OR answered.question_id IS NOT NULL OR
      (m.author_type = 'agent' AND m.kind IN ('question','blocked','progress','direction','decision','deliverable','review','test_result')))
    ORDER BY m.created_at DESC, m.seq DESC`).all(user.id) as ChannelRow[];
  const messages: ZoomMessage[] = [];
  for (const row of rows) {
    const closed = ["done", "failed", "canceled"].includes(row.status ?? "");
    const pending = Boolean(row.human_question && !row.answered && !closed);
    const kind = row.question_id ? "reply" : row.human_question ? "question" : row.kind === "instruction" ? "task" : "progress";
    // Scope unthreaded questions to their original message, including the answer.
    const taskKey = row.task_id ?? row.question_id ?? row.id;
    const message: ZoomMessage = {
      id: `channel:${row.id}`, taskId: `channel:${taskKey}`, taskTitle: row.title ?? (row.question_body ?? row.body).split("\n")[0].slice(0, 100),
      origin: "channel", kind, source: row.source, body: row.body, at: row.at, pending,
      folder: row.project ? `${row.project}/${row.room_name}` : `${row.direct ? "私聊" : "频道"}/${row.room_name}`,
      ...(pending ? { action: { kind: "channel-reply" as const, roomId: row.room_id, messageId: row.id, ...(row.task_id ? {taskId: row.task_id} : {}) } } : {}),
      ...(row.question_id ? { replyTo: `channel:${row.question_id}`, actor: row.actor ?? undefined } : {}),
    };
    messages.push(message);
    if (row.kind === "instruction" && closed && row.updated_at) {
      messages.push({ ...message, id: `channel:status:${row.task_id}`, kind: row.status === "done" ? "completed" : "progress",
        at: row.updated_at, body: row.status === "done" ? "频道任务已完成" : row.status === "failed" ? "频道任务执行失败" : "频道任务已取消" });
    }
  }
  return messages;
}
