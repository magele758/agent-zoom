import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ExecutiveReceiptTrace } from "../executive-bots-types.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import { ZoomStore } from "./zoom.ts";

export type TraceTask = {
  id: string; input: string; status: string; targetBotId: string; createdAt?: string; updatedAt: string;
  result?: string; failureReason?: string;
  deliveryUnavailable?: boolean;
  attempt?: number;
  delivery?: { taskId?: string; attempt?: number; report?: string;
    artifacts?: { id: string; fileName?: string }[]; receipts?: { id: string; toolName?: string; state?: string }[] };
};
type RoomMessage = { id: string; roomId?: string; text: string; createdAt: string; sender: { type: string }; turnId?: string };
type RoomTurn = { id: string; roomId?: string; messageId?: string };
const stringList = z.array(z.string());
const alertList = z.array(z.object({ taskId: z.string().min(1), title: z.string(), status: z.string(), project: z.string(), updatedAt: z.string().optional() })).min(1);
const packetOptions = z.array(z.object({
  id: z.string(), label: z.string(), handlerKey: z.enum(["product.patrol_requeue", "product.patrol_snooze", "product.patrol_archive"]),
  payload: z.object({ taskIds: stringList, patrolRunId: z.string().optional() }),
})).min(1);
const delegateSource = z.object({ id: z.string(), kind: z.enum(["message", "operation"]), title: z.string(), taskId: z.string().optional() });
const stageBrief = z.object({ title: z.string(), goal: z.string(), deliverable: z.string().optional(), product: z.string().optional(), project: z.string().optional() });
const workflowSnapshot = z.object({ cards: z.array(z.object({ id: z.string(), status: z.string(), revision: z.number() })) });
function parsed<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  if (typeof raw !== "string") return;
  try { return schema.safeParse(JSON.parse(raw)).data; } catch { return; }
}

const inbox = (id: string) => "#inbox?" + new URLSearchParams({ message: id });
const ownsScope = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && a.every(id => b.includes(id));

export class ExecutiveReceiptTracer {
  private tables: Set<string>;
  private messages?: Map<string, ZoomMessage>;
  constructor(private db: DatabaseSync, private connection: string, private userId: string, private rawMessages?: () => ZoomMessage[]) {
    this.tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name)));
  }

  private source(id: string, taskId?: string) {
    if (this.rawMessages) {
      this.messages ??= new Map(this.rawMessages().map(m => [m.id, m]));
      const msg = this.messages.get(id);
      return msg && (!taskId || msg.taskId === taskId) ? msg : undefined;
    }
    if (this.tables.has("zoom_messages") && this.tables.has("zoom_tasks")) {
      const parent = this.db.prepare("SELECT task_id FROM zoom_messages WHERE id=?").get(id);
      if (parent && (!taskId || parent.task_id === taskId)) return new ZoomStore(this.db).thread(String(parent.task_id)).find(m => m.id === id);
    }
  }

  private addPatrol(trace: ExecutiveReceiptTrace, question: ZoomMessage): boolean {
    if (!this.tables.has("zoom_messages") || !this.tables.has("zoom_tasks")) return false;
    const origin = this.db.prepare(`SELECT t.external_id,m.event_key FROM zoom_tasks t JOIN zoom_messages m ON t.id=m.task_id
      WHERE t.id=? AND m.id=? AND t.source='OPC OS · 后台巡检卫士' AND t.folder='公司/巡检告警' AND m.kind='question'`).get(question.taskId, question.id);
    if (!origin) return false;
    // A patrol notification has navigation/acknowledgement choices, not authority to run the kernel's action.
    if (!this.tables.has("opc_patrol_runs")) return true;
    const event = /^patrol-report-(\d{4}-\d{2}-\d{2})-(ptr_[a-z\d]+|\d+)$/.exec(String(origin.event_key));
    if (!event || origin.external_id !== "patrol-" + event[1]) return true;
    const day = event[1];
    const audits = this.db.prepare("SELECT id,alerts_json,created_at,notified_zoom FROM opc_patrol_runs WHERE substr(created_at,1,10)=?").all(day);
    const exactEvent = event[2].startsWith("ptr_");
    const audit = exactEvent ? audits.find(a => a.id === event[2]) : audits.length === 1 ? audits[0] : undefined;
    if (!audit || !audit.notified_zoom) return true;
    if (!exactEvent) {
      if (question.at.slice(0, 10) !== day) return true;
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM zoom_messages WHERE task_id=? AND kind='question' AND event_key LIKE ?")
        .get(question.taskId, "patrol-report-" + day + "-%");
      if (Number(count?.n) !== 1) return true;
    }
    const alerts = parsed(alertList, audit.alerts_json);
    if (!alerts || new Set(alerts.map(a => a.taskId)).size !== alerts.length || !this.tables.has("opc_planning_tasks")) return true;
    const taskIds = alerts.map(a => a.taskId);
    const rows = this.db.prepare("SELECT title,project,status,updated_at,latest_run_id FROM opc_planning_tasks WHERE id=?");
    let scopeUnchanged = true;
    const runs = this.tables.has("opc_agent_runs")
      ? this.db.prepare("SELECT status,error_summary,completed_at FROM opc_agent_runs WHERE id=? AND task_id=?") : undefined;
    trace.affectedTasks = alerts.map(a => {
      const task = rows.get(a.taskId);
      if (!task || !a.updatedAt || task.updated_at !== a.updatedAt || task.status !== a.status || task.project !== a.project) {
        scopeUnchanged = false;
      }
      const run = task?.latest_run_id ? runs?.get(task.latest_run_id, a.taskId) : undefined;
      return { id: a.taskId, title: String(task?.title ?? a.title), project: String(task?.project ?? a.project), observedStatus: a.status,
        status: task ? String(task.status) : "missing", latestRunId: task?.latest_run_id ? String(task.latest_run_id) : null,
        ...(run && { latestRun: { status: String(run.status), errorSummary: String(run.error_summary ?? "").slice(0, 240),
          completedAt: run.completed_at ? String(run.completed_at) : null } }) };
    });
    if (trace.origin) {
      trace.origin.patrolRunId = String(audit.id);
      trace.origin.href = "#planning?tab=patrol";
      if (new Set(alerts.map(a => a.project)).size === 1) trace.origin.project = alerts[0].project;
    }
    trace.createdAt = String(audit.created_at);
    if (!this.tables.has("opc_decision_packets")) return true;
    const packets = this.db.prepare(`SELECT id,status,options_json,background_summary FROM opc_decision_packets
      WHERE kind='patrol_alert' AND domain='product' AND dedupe_key=?`).all("product:patrol:" + day);
    const matches = packets.flatMap(packet => {
      const options = parsed(packetOptions, packet.options_json);
      if (!options || !options.every(o => ownsScope(o.payload.taskIds, taskIds))) return [];
      const exact = options.every(o => o.payload.patrolRunId === audit.id);
      const historical = !exactEvent && options.every(o => o.payload.patrolRunId === undefined) && audits.length === 1 && packets.length === 1;
      return exact || historical ? [{ packet, options }] : [];
    });
    if (matches.length !== 1) return true;
    const { packet, options } = matches[0];
    const id = String(packet.id);
    trace.decisionId = id;
    trace.decision = { kind: "kernel", id, status: String(packet.status), href: "#mailbox?" + new URLSearchParams({ decision: id }),
      actionable: packet.status === "pending" && scopeUnchanged,
      options: options.map(({ id, label }) => ({ id, label })) };
    trace.background = String(packet.background_summary || trace.background);
    return true;
  }

  private attachSourceMetadata(trace: ExecutiveReceiptTrace, m: ZoomMessage) {
    const href = m.origin === "workflow" ? "#workflows/" + encodeURIComponent(m.taskId) : inbox(m.id);
    trace.origin = { ...trace.origin, kind: m.origin === "workflow" ? "workflow" : "zoom", title: m.taskTitle, href, messageId: m.id, taskId: m.taskId };
    trace.createdAt = m.at;
    trace.background = m.context || m.body;
    trace.request = m.body;
    return href;
  }

  private attachSource(trace: ExecutiveReceiptTrace, m: ZoomMessage) {
    const href = this.attachSourceMetadata(trace, m);
    if (this.addPatrol(trace, m)) return;
    if (m.origin === "workflow" && m.kind === "decision" && this.tables.has("workflow_runs")) {
      const runRow = this.db.prepare("SELECT snapshot FROM workflow_runs WHERE id=?").get(m.taskId);
      if (!runRow) return;
      const run = parsed(workflowSnapshot, runRow.snapshot);
      const card = run?.cards.find(c => "workflow:card:" + c.id === m.id);
      if (!card) return;
      trace.decision = { kind: "workflow", id: card.id, status: card.status, href,
        actionable: card.status === "open" && m.pending && !m.readOnly && m.action?.kind === "decision" && m.action.cardId === card.id && m.action.revision === card.revision,
        options: [{ id: "approve", label: "批准" }, { id: "changes", label: "要求修改" }, { id: "reject", label: "拒绝" }] };
    } else if (m.kind === "question" && (m.requiresApproval || m.choices?.length)) {
      trace.decision = { kind: "zoom", id: m.id, href, status: m.pending ? "pending" : "handled",
        actionable: m.pending && !m.readOnly && (m.action?.kind === "reply" || m.action?.kind === "channel-reply"),
        options: (m.choices ?? []).map(label => ({ id: label, label })) };
    }
  }

  /** An alert's verified task scope is useful even before a department receives the work. */
  sourceTraces(): Record<string, ExecutiveReceiptTrace> {
    if (!this.rawMessages) return {};
    this.messages ??= new Map(this.rawMessages().map(m => [m.id, m]));
    const traces: Record<string, ExecutiveReceiptTrace> = Object.create(null);
    for (const message of this.messages.values()) {
      if (message.origin !== "external" || message.kind !== "question" ||
          message.source !== "OPC OS · 后台巡检卫士" || message.folder !== "公司/巡检告警") continue;
      const trace: ExecutiveReceiptTrace = {
        request: "", background: "", purpose: "", result: "", evidence: [], affectedTasks: [], status: "reported",
      };
      this.attachSourceMetadata(trace, message);
      if (this.addPatrol(trace, message)) traces[message.id] = trace;
    }
    return traces;
  }

  task(task: TraceTask): ExecutiveReceiptTrace {
    const d = task.delivery;
    const delivery = d && (!d.taskId || d.taskId === task.id) && (task.attempt === undefined || d.attempt === undefined || d.attempt === task.attempt) ? d : undefined;
    const result = (delivery?.report || task.result || "").trim();
    const evidence = [
      ...(delivery?.artifacts ?? []).map(a => [a.fileName, a.id].filter(Boolean).join(" · ")),
      ...(delivery?.receipts ?? []).map(r => [r.toolName, r.state, r.id].filter(Boolean).join(" · ")),
    ];
    const trace: ExecutiveReceiptTrace = { status: task.status, request: task.input, purpose: "", background: "", result,
      evidence, affectedTasks: [], createdAt: task.createdAt, requestedAt: task.createdAt,
      ...(task.deliveryUnavailable && { deliveryUnavailable: true }),
      returnedAt: result || task.failureReason || ["completed","failed","cancelled"].includes(task.status) ? task.updatedAt : undefined,
      failureReason: task.failureReason };
    if (!this.tables.has("stage_home_bindings") || !this.tables.has("stage_work") || !this.tables.has("opc_delegations")) return trace;
    const matches = this.db.prepare(`SELECT d.id,d.source_id,d.source,d.evidence,d.created_at,b.work_id,w.brief AS work_brief
      FROM stage_home_bindings b JOIN stage_work w ON w.task_id=b.work_id
      JOIN opc_delegations d ON d.work_id=b.work_id WHERE d.user_id=? AND b.connection=? AND b.bot_id=? AND b.brief=?
      AND json_extract(CASE WHEN json_valid(b.receipt) THEN b.receipt END,'$.remoteId')=?`)
      .all(this.userId, this.connection, task.targetBotId, task.input, task.id);
    if (matches.length !== 1) return trace;
    const row = matches[0];
    const brief = parsed(stageBrief, row.work_brief);
    const source = parsed(delegateSource, row.source);
    trace.requestedAt ??= String(row.created_at);
    trace.purpose = [brief?.goal, brief?.deliverable].filter(Boolean).join("\n");
    trace.request = brief?.title || trace.request;
    trace.evidence = [...new Set([...evidence, ...(parsed(stringList, row.evidence) ?? [])])];
    trace.origin = { kind: "delegation", workId: String(row.work_id), delegationId: String(row.id), title: brief?.title || "委派工单",
      href: "#delegations", project: brief?.project || brief?.product || undefined };
    if (source?.kind === "message" && source.id === row.source_id && source.taskId) {
      const message = this.source(source.id, source.taskId);
      if (message) this.attachSource(trace, message);
    }
    return trace;
  }

  room(roomId: string, message: RoomMessage, messages: RoomMessage[], turns: RoomTurn[]): ExecutiveReceiptTrace | undefined {
    if (!this.tables.has("opc_home_chat_notices") || (message.roomId && message.roomId !== roomId)) return;
    const turn = message.turnId ? turns.find(t => t.id === message.turnId && (!t.roomId || t.roomId === roomId)) : undefined;
    const originalId = turn?.messageId || message.id;
    const links = this.db.prepare("SELECT notice_key FROM opc_home_chat_notices WHERE connection=? AND remote_room=? AND remote_message_id=?")
      .all(this.connection, roomId, originalId);
    if (links.length !== 1) return;
    const m = this.source(String(links[0].notice_key));
    if (!m) return;
    const trace: ExecutiveReceiptTrace = { request: "", background: "", purpose: "", result: message.sender.type === "bot" ? message.text : "",
      evidence: [], status: "sent", affectedTasks: [], requestedAt: messages.find(x => x.id === originalId)?.createdAt, returnedAt: message.createdAt };
    this.attachSource(trace, m);
    return trace;
  }
}
