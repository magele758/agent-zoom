import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ZoomFeedbackEvent, ZoomMessage, ZoomTask } from "../zoom-types.ts";
import { productStageIds, type ProductStageId } from "../product-stages.ts";
import { ApiError } from "./logic.ts";
import { zoomFolder } from "./zoom-folder.ts";

const label = z.string().trim().min(1).max(120);
const text = z.string().trim().min(1).max(16000);
const registerSchema = z.strictObject({
  source: label, externalId: z.string().trim().min(1).max(512), title: z.string().trim().min(1).max(4000),
  folder: zoomFolder.default("未归类"), context: z.string().trim().max(4000).default(""),
  stage: z.enum(productStageIds).optional(),
});
const messageSchema = z.strictObject({
  eventId: z.string().trim().min(1).max(512), kind: z.enum(["progress", "question", "completed"]), body: text,
  choices: z.array(label).min(1).max(12).optional(),
  requiresApproval: z.boolean().optional(),
  evidence: z.array(z.string().trim().min(1).max(4000)).min(1).max(32).optional(),
}).refine(input => !input.choices || (input.kind === "question" && new Set(input.choices).size === input.choices.length),
  "只有问题可附选项，每项必须唯一")
  .refine(input => input.requiresApproval === undefined || input.kind === "question", "只有问题可标记为需要人工审批");
const replySchema = z.strictObject({
  questionId: z.uuid(), body: z.string().trim().max(16000).optional(), choice: label.optional(),
}).refine(input => Boolean(input.body || input.choice), "请填写答复或选择一个选项");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "zoom_input", parsed.error.issues.map(i => i.path.join(".") + " " + i.message).join(" / "));
  return parsed.data;
}
function conflict(message: string): never { throw new ApiError(409, "zoom_conflict", message); }

const messageQuery = `SELECT m.id,m.seq,m.event_key AS eventKey,m.kind,m.body,m.created_at AS at,m.choices,m.evidence,m.requires_approval AS requiresApproval,
  m.reply_to AS replyTo,m.choice,m.actor,t.id AS taskId,t.title AS taskTitle,t.folder,t.source,t.context,t.stage,
  (m.kind='question' AND t.completed=0 AND NOT EXISTS(SELECT 1 FROM zoom_messages r WHERE r.reply_to=m.id)) AS pending
  FROM zoom_messages m JOIN zoom_tasks t ON t.id=m.task_id`;

type MessageRow = Pick<ZoomMessage, "id" | "kind" | "body" | "at" | "taskId" | "taskTitle" | "folder" | "source" | "context"> & {
  stage: ProductStageId | null;
  requiresApproval: number;
  seq: number; eventKey: string | null; pending: number; choices: string | null; evidence: string | null; replyTo: string | null; choice: string | null; actor: string | null;
};

function messageView(row: MessageRow): ZoomMessage {
  return {
    id: row.id, origin: "external", taskId: row.taskId, taskTitle: row.taskTitle, source: row.source,
    folder: row.folder, context: row.context, kind: row.kind, body: row.body, at: row.at, pending: Boolean(row.pending),
    ...(row.stage && { stage: row.stage }),
    ...(row.requiresApproval && { requiresApproval: true }),
    ...(row.pending && { action: { kind: "reply" as const } }),
    ...(row.choices && { choices: JSON.parse(row.choices) }), ...(row.replyTo && { replyTo: row.replyTo }),
    ...(row.choice && { choice: row.choice }), ...(row.actor && { actor: row.actor }),
    ...(row.evidence && { evidence: JSON.parse(row.evidence) }),
  };
}

export class ZoomStore {
  constructor(private db: DatabaseSync) {}

  private write<T>(operation: () => T) {
    if (this.db.isTransaction) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private task(id: string) {
    const row = this.db.prepare("SELECT id,source,external_id AS externalId,title,folder,context,completed FROM zoom_tasks WHERE id=?")
      .get(id) as (ZoomTask & { completed: number }) | undefined;
    if (!row) throw new ApiError(404, "zoom_task", "找不到这个外部任务");
    return row;
  }

  private message(id: string) {
    return messageView(this.db.prepare(messageQuery + " WHERE m.id=?").get(id) as MessageRow);
  }

  register(input: unknown): ZoomTask {
    const task = parse(registerSchema, input);
    return this.write(() => {
      const existing = this.db.prepare("SELECT id,title,folder,context,stage FROM zoom_tasks WHERE source=? AND external_id=?").get(task.source, task.externalId);
      if (existing) {
        if (existing.title !== task.title || existing.folder !== task.folder || existing.context !== task.context || existing.stage !== (task.stage ?? null)) conflict("外部任务 ID 已绑定其他内容");
        return { ...task, id: String(existing.id) };
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO zoom_tasks(id,source,external_id,title,folder,context,stage) VALUES(?,?,?,?,?,?,?)")
        .run(id, task.source, task.externalId, task.title, task.folder, task.context, task.stage ?? null);
      this.db.prepare("INSERT INTO zoom_messages(id,task_id,kind,body,created_at) VALUES(?,?,'task',?,?)")
        .run(randomUUID(), id, task.title, new Date().toISOString());
      return { ...task, id };
    });
  }

  report(id: string, input: unknown, actor?: string) {
    const data = parse(messageSchema, input);
    const choices = data.choices ? JSON.stringify(data.choices) : null;
    const evidence = data.evidence ? JSON.stringify(data.evidence) : null;
    const requiresApproval = data.requiresApproval ? 1 : 0;
    return this.write(() => {
      const task = this.task(id);
      const previous = this.db.prepare(messageQuery + " WHERE m.task_id=? AND m.event_key=?").get(id, data.eventId) as MessageRow | undefined;
      if (previous) {
        if (previous.body !== data.body || previous.kind !== data.kind || previous.choices !== choices || previous.evidence !== evidence ||
          previous.requiresApproval !== requiresApproval || previous.actor !== (actor ?? null)) conflict("消息 ID 已用于其他内容");
        return messageView(previous);
      }
      if (task.completed) conflict("任务已经完成");
      const messageId = randomUUID();
      this.db.prepare("INSERT INTO zoom_messages(id,task_id,event_key,kind,body,choices,evidence,requires_approval,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(messageId, id, data.eventId, data.kind, data.body, choices, evidence, requiresApproval, actor ?? null, new Date().toISOString());
      if (data.kind === "completed") this.db.prepare("UPDATE zoom_tasks SET completed=1 WHERE id=?").run(id);
      return this.message(messageId);
    });
  }

  reply(id: string, input: unknown, actor: string, evidence?: string[]) {
    const reply = parse(replySchema, input);
    const body = reply.body || reply.choice!;
    return this.write(() => {
      const task = this.task(id);
      const question = this.db.prepare("SELECT choices FROM zoom_messages WHERE id=? AND task_id=? AND kind='question'").get(reply.questionId, id);
      if (!question) throw new ApiError(404, "zoom_question", "原任务中找不到该问题");
      const previous = this.db.prepare(messageQuery + " WHERE m.reply_to=?").get(reply.questionId) as MessageRow | undefined;
      if (previous) {
        if (previous.body !== body || previous.choice !== (reply.choice ?? null) || previous.actor !== actor || previous.evidence !== (evidence ? JSON.stringify(evidence) : null)) conflict("这个问题已经收到答复");
        return messageView(previous);
      }
      if (task.completed) conflict("任务已结束，该问题已经关闭");
      if (reply.choice && !JSON.parse(String(question.choices ?? "[]")).includes(reply.choice)) {
        throw new ApiError(400, "zoom_choice", "请选择这个问题提供的选项");
      }
      const idReply = randomUUID();
      this.db.prepare("INSERT INTO zoom_messages(id,task_id,kind,body,reply_to,choice,actor,created_at,evidence) VALUES(?,?,'reply',?,?,?,?,?,?)")
        .run(idReply, id, body, reply.questionId, reply.choice ?? null, actor, new Date().toISOString(), evidence ? JSON.stringify(evidence) : null);
      return this.message(idReply);
    });
  }

  messages() {
    return (this.db.prepare(messageQuery + " ORDER BY m.seq DESC").all() as MessageRow[]).map(messageView);
  }

  thread(taskId: string) {
    return (this.db.prepare(messageQuery + " WHERE m.task_id=? ORDER BY m.seq").all(taskId) as MessageRow[]).map(messageView);
  }

  feedback(id: string, after: number) {
    const task = this.task(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, "zoom_cursor", "反馈游标无效");
    const events = this.db.prepare(`SELECT r.seq,q.id AS questionId,q.event_key AS questionEventId,q.body AS question,r.body,r.choice,r.actor,r.created_at AS at,r.evidence
      FROM zoom_messages r JOIN zoom_messages q ON q.id=r.reply_to
      WHERE r.task_id=? AND r.kind='reply' AND r.seq>? ORDER BY r.seq LIMIT 200`).all(id, after)
      .map(({ choice, evidence, ...row }) => ({ ...row, ...(choice && { choice }), ...(evidence && {evidence: JSON.parse(String(evidence))}) })) as ZoomFeedbackEvent[];
    return { taskId: id, source: task.source, externalId: task.externalId, context: task.context, completed: Boolean(task.completed),
      cursor: events.at(-1)?.seq ?? after, events };
  }
}
