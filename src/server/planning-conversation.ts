import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { PlanningChatProposal, PlanningChatTurn, PlanningChatView } from "../planning-chat-types.ts";
import { ApiError } from "./logic.ts";
import { StageHomeClient, type HomeTask } from "./stage-home-client.ts";
import type { TaskPlanningStore } from "./task-planning.ts";

const scopeSchema = z.string().trim().max(120);
const sendSchema = z.strictObject({ project: scopeSchema, id: z.uuid(), text: z.string().trim().min(1).max(2000) });
const confirmSchema = z.strictObject({ project: scopeSchema, turnId: z.uuid(), dispatch: z.boolean() });
const proposalSchema = z.object({
  project: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(5000),
  agentId: z.string().trim().min(1).max(120).nullable().optional(),
});
const answerSchema = z.object({ reply: z.string().trim().min(1), proposal: proposalSchema.nullish() });
type Row = {
  id: string; text: string; reply: string; status: PlanningChatTurn["status"]; error: string;
  bot_name: string; bot_id: string; brief: string; remote_id: string | null;
  proposal: string | null; task_id: string | null; run_id: string | null;
};
function projectTurn(row: Row): PlanningChatTurn {
  return { id: row.id, text: row.text, reply: row.reply, status: row.status, error: row.error,
    botName: row.bot_name, proposal: row.proposal ? JSON.parse(row.proposal) : null, taskId: row.task_id, runId: row.run_id };
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "planning_chat_input", "请核对看板项目及消息内容。每条消息最多 2000 个字符。");
  return parsed.data;
}
const conflict = (message: string) => new ApiError(409, "planning_chat_conflict", message);
const messageOf = (error: unknown) => error instanceof Error ? error.message : "暂时无法联系 Agent Home。";

export class PlanningConversation {
  constructor(private db: DatabaseSync, private board: TaskPlanningStore, private home = new StageHomeClient()) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_planning_chat_turns(
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL, connection TEXT NOT NULL,
      text TEXT NOT NULL, brief TEXT NOT NULL, bot_id TEXT NOT NULL, bot_name TEXT NOT NULL, remote_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', reply TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      proposal TEXT, task_id TEXT, run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS opc_planning_chat_by_scope ON opc_planning_chat_turns(owner_id,scope,connection);
    CREATE UNIQUE INDEX IF NOT EXISTS opc_planning_chat_pending ON opc_planning_chat_turns(owner_id,scope,connection) WHERE status='pending';`);
  }

  private rows(owner: string, scope: string) {
    return this.db.prepare("SELECT * FROM opc_planning_chat_turns WHERE owner_id=? AND scope=? AND connection=? ORDER BY rowid")
      .all(owner, scope, this.home.identity) as Row[];
  }

  private projects() {
    const catalog = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()
      ? this.db.prepare("SELECT name FROM projects ORDER BY name").all().map(row => String(row.name)) : [];
    return [...new Set(["default", ...this.board.listProjects(), ...catalog])];
  }

  private brief(scope: string, turns: Row[], text: string) {
    const projects = scope || this.projects().join("、").slice(0, 320);
    const runners = this.board.listAgents().filter(agent => agent.status !== "disabled")
      .map(agent => agent.id + "=" + agent.name).join("、").slice(0, 480);
    const header = [
      "你是 OPC 任务看板的规划 Bot。只讨论和整理任务，不调用工具、不执行、不派工。用用户语言回复，缺少目标或项目时先追问，结合之前的对话修改方案。",
      '完成本轮请报告 JSON：{"reply":"给创始人的自然语言答复","proposal":null}；范围清楚时把 proposal 替换为 {"project":"项目名","title":"标题","description":"范围、交付与验收","agentId":null}。有合适的可用执行者时填其准确 ID，最终由用户点击确认。',
      (scope ? "当前项目：" : "候选项目（通用任务可用 default）：") + projects,
      "可用执行者（ID=名称）：" + (runners || "无"),
    ].join("\n");
    const past = turns.map(t => {
      const proposal = t.proposal ? JSON.parse(t.proposal) as PlanningChatProposal : null;
      return "用户：" + t.text + "\nBot：" + t.reply + (proposal ? "\n草案：" + JSON.stringify(proposal) : "");
    }).join("\n");
    const ending = "\n本轮用户：" + text;
    const room = 3500 - header.length - ending.length - 8;
    return header + "\n对话历史：" + (room > 0 ? past.slice(-room) : "") + ending;
  }

  private record(row: Row, remote: HomeTask, scope: string) {
    if (remote.targetBotId !== row.bot_id || remote.input !== row.brief || (row.remote_id && remote.id !== row.remote_id))
      throw conflict("Agent Home 回执与这轮对话不匹配。");
    let status: PlanningChatTurn["status"] = "pending", reply = "", error = "";
    let proposal: PlanningChatProposal | null = null;
    if (remote.status === "completed") {
      const delivery = remote.delivery;
      const valid = !delivery || (delivery.taskId === remote.id && delivery.attempt === remote.attempt && delivery.executionStatus === "completed");
      reply = valid ? (delivery?.report || remote.result || "").trim() : "";
      if (reply) {
        status = "answered";
        const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        let raw: unknown;
        try { raw = JSON.parse(fenced?.[1] ?? reply); } catch { /* Plain conversational replies are also valid. */ }
        const answer = answerSchema.safeParse(raw);
        if (answer.success) {
          reply = answer.data.reply;
          const p = answer.data.proposal;
          if (p && (scope ? p.project === scope : this.projects().includes(p.project))) {
            const agent = this.board.listAgents().find(a => a.id === p.agentId && a.status !== "disabled");
            proposal = { ...p, agentId: agent?.id ?? null };
          } else if (p) reply += "\n请确认这项任务所属的看板项目。";
        }
      } else {
        status = "failed"; error = "Bot 已结束本轮，未返回可核对的答复。";
      }
    } else if (["failed", "cancelled", "canceled", "expired", "rejected"].includes(remote.status)) {
      status = "failed"; error = remote.failureReason || "Agent Home 未能完成本轮讨论。";
    } else if (remote.status === "waiting_approval" || remote.status === "blocked") {
      error = remote.status === "waiting_approval" ? "Agent Home 正在等候批准。" : "Agent Home 已暂停本轮，请核对原任务。";
    }
    this.db.prepare(`UPDATE opc_planning_chat_turns SET remote_id=?,status=?,reply=?,error=?,proposal=?
       WHERE id=? AND (status='pending' OR (status='failed' AND remote_id IS NULL))`)
      .run(remote.id, status, reply, error, proposal && JSON.stringify(proposal), row.id);
  }

  private async deliver(row: Row, project: string) {
    try { this.record(row, await this.home.send(row.bot_id, row.brief, "opc-planning/" + row.id), project); }
    catch (err) {
      this.db.prepare("UPDATE opc_planning_chat_turns SET status='failed',error=? WHERE id=? AND remote_id IS NULL")
        .run(messageOf(err), row.id);
    }
  }

  async view(owner: string, rawScope: string, localOnly = false): Promise<PlanningChatView> {
    const project = input(scopeSchema, rawScope);
    const pending = this.rows(owner, project).find(row => row.status === "pending");
    if (pending && !localOnly) {
      try {
        if (pending.remote_id) this.record(pending, await this.home.read(pending.remote_id), project);
        else await this.deliver(pending, project);
      }
      catch (reason) {
        this.db.prepare("UPDATE opc_planning_chat_turns SET error=? WHERE id=? AND status='pending'").run(messageOf(reason), pending.id);
      }
    }
    return { project, turns: this.rows(owner, project).map(projectTurn) };
  }

  async send(owner: string, raw: unknown): Promise<PlanningChatView> {
    const { project, id, text } = input(sendSchema, raw);
    const existing = this.rows(owner, project);
    let turn = existing.find(t => t.id === id);
    if (turn && turn.text !== text) throw conflict("这条消息编号已用于其他内容。");
    if (turn?.remote_id) return this.view(owner, project);
    const bot = existing[0] ? { id: existing[0].bot_id, name: existing[0].bot_name }
      : (await this.home.call("/api/bot-work/default", z.object({ bot: z.object({ id: z.string().min(1), name: z.string().min(1) }) }))).bot;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.rows(owner, project);
      const last = rows.at(-1);
      turn = rows.find(t => t.id === id);
      if ((last?.status === "pending" && last.id !== id) || (turn && turn.id !== last?.id)) throw conflict("请先等待当前轮次完成。");
      if (turn && turn.text !== text) throw conflict("这条消息编号已用于其他内容。");
      if (!turn) {
        if (this.db.prepare("SELECT id FROM opc_planning_chat_turns WHERE id=?").get(id)) throw conflict("消息编号已使用。");
        this.db.prepare(`INSERT INTO opc_planning_chat_turns(id,owner_id,scope,connection,text,brief,bot_id,bot_name)
          VALUES(?,?,?,?,?,?,?,?)`).run(id, owner, project, this.home.identity, text, this.brief(project, rows, text),
            rows[0]?.bot_id ?? bot.id, rows[0]?.bot_name ?? bot.name);
      } else if (!turn.remote_id) {
        this.db.prepare("UPDATE opc_planning_chat_turns SET status='pending',error='' WHERE id=?").run(id);
      }
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
    turn = this.rows(owner, project).find(t => t.id === id)!;
    if (!turn.remote_id) await this.deliver(turn, project);
    return this.view(owner, project);
  }

  async confirm(owner: string, raw: unknown): Promise<PlanningChatView> {
    const { project, turnId, dispatch } = input(confirmSchema, raw);
    let taskId: string, proposal: PlanningChatProposal;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.rows(owner, project).at(-1);
      if (row?.id !== turnId || !row.proposal || row.status !== "answered") throw conflict("请确认最新一轮 Bot 草案。");
      proposal = JSON.parse(row.proposal);
      if (dispatch && !proposal.agentId) throw conflict("这份草案还未指定执行者，请继续讨论或只创建任务。");
      taskId = row.task_id ?? this.board.createTask({
        project: proposal.project, title: proposal.title, description: proposal.description, sourceRef: "planning-chat:" + turnId,
      }).id;
      this.db.prepare("UPDATE opc_planning_chat_turns SET task_id=? WHERE id=?").run(taskId, turnId);
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
    if (dispatch && proposal.agentId) {
      try {
        const task = this.board.getTask(taskId);
        if (task.project !== proposal.project || task.title !== proposal.title || task.description !== proposal.description)
          throw conflict("任务内容已有修改，请在看板核对后派发。");
        const runId = task.latestRunId ?? (await this.board.dispatchTask(taskId, { agentId: proposal.agentId, autoCreatePr: false }, turnId)).runId;
        this.db.prepare("UPDATE opc_planning_chat_turns SET run_id=?,error='' WHERE id=?").run(runId, turnId);
      } catch (err) {
        this.db.prepare("UPDATE opc_planning_chat_turns SET error=? WHERE id=? AND run_id IS NULL")
          .run("任务卡已创建，派发未完成：" + messageOf(err), turnId);
      }
    }
    return this.view(owner, project);
  }
}

export function registerPlanningConversation(app: Hono, db: DatabaseSync, board: TaskPlanningStore, user: (c: Context) => unknown) {
  const service = new PlanningConversation(db, board);
  const owner = (c: Context) => {
    const principal = z.object({ id: z.string().min(1) }).safeParse(user(c));
    if (!principal.success) throw new ApiError(401, "planning_chat_owner", "请打开本机用户会话。");
    return principal.data.id;
  };
  const base = "/api/opc/planning/conversation";
  const preview = process.env.KUNLUN_PREVIEW === "1" || process.env.DEMO_MODE === "1";
  const writableOwner = (c: Context) => {
    const id = owner(c);
    if (preview) throw new ApiError(403, "planning_chat_preview", "请从正式本机服务与 Bot 讨论或确认派发。");
    return id;
  };
  app.get(base, async c => c.json(await service.view(owner(c), c.req.query("project") ?? "", preview)));
  app.post(base + "/messages", async c => c.json(await service.send(writableOwner(c), await c.req.json())));
  app.post(base + "/confirm", async c => c.json(await service.confirm(writableOwner(c), await c.req.json())));
}
