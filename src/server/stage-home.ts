import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { StageHomeReceipt } from "../stage-home-types.ts";
import { productStages } from "../product-stages.ts";
import type { StageWork } from "../stage-work-types.ts";
import { ApiError } from "./logic.ts";
import { StageHomeClient, type HomeTask } from "./stage-home-client.ts";
import type { StageWorkStore } from "./stage-work.ts";

type Binding = { work_id: string; bot_id: string; claim_id: string; connection: string; brief: string;
  receipt: string; remote_updated_at: string };
const endpoint = "/api/zoom/stage-home" as const;
const parseReceipt = (row: Binding) => JSON.parse(row.receipt) as StageHomeReceipt;
const clock = () => new Date().toISOString();
const invalid = (message: string) => new ApiError(409, "stage_home_conflict", message);
const sendInput = z.strictObject({ botId: z.string().trim().min(1).max(128) });
const labels: Record<string, string> = { queued: "任务已进入 Agent Home 队列。", running: "Agent Home 正在处理任务。",
  waiting_approval: "Agent Home 正在等候批准。请在 Agent Home 原任务处理审批后更新回执。",
  completed: "Agent Home 已交付。", failed: "Agent Home 执行失败。", cancelled: "Agent Home 已取消任务。",
  unknown: "Agent Home 正在核对原执行现场。", blocked: "Agent Home 任务受阻。" };

export const homeBriefLimit=3500;
export function formatStageHomeBrief(work: Pick<StageWork,"id"|"stage"|"product"|"project"|"companyItemId"|"title"|"goal"|"inputs"|"deliverable"|"acceptance">) {
  const stage = productStages.find(s => s.id === work.stage)?.label ?? "委派";
  const text = [`OPC OS阶段工单 ${work.id}`, work.product ? `产品：${work.product}　阶段：${stage}` : `公司事项　阶段：${stage}`,
    ...(work.project ? ["项目：" + work.project] : []), ...(work.companyItemId ? ["公司事项：" + work.companyItemId] : []),
    `任务：${work.title}`, `目标：${work.goal}`, `输入材料：${work.inputs || "见任务目标"}`,
    `交付物：${work.deliverable}`, `验收条件：${work.acceptance}`,
    "完成时在本任务提交工作结果，并附能核对的产物或执行记录。"].join("\n");
  return text;
}

export class StageHomeService {
  constructor(private db: DatabaseSync, private work: StageWorkStore, private configuredClient?: StageHomeClient) {
    db.exec(`CREATE TABLE IF NOT EXISTS stage_home_bindings(
      work_id TEXT PRIMARY KEY REFERENCES stage_work(task_id), bot_id TEXT NOT NULL, claim_id TEXT NOT NULL,
      connection TEXT NOT NULL, brief TEXT NOT NULL, receipt TEXT NOT NULL, remote_updated_at TEXT NOT NULL DEFAULT ''
    )`);
  }

  private get client() { return this.configuredClient ??= new StageHomeClient(); }

  async bots() {
    try { return { available: true, bots: await this.client.bots() }; }
    catch (error) { return { available: false, bots: [], reason: error instanceof Error ? error.message : "无法读取 Agent Home。" }; }
  }

  private lookup(id: string) {
    return this.db.prepare("SELECT * FROM stage_home_bindings WHERE work_id=?").get(id) as Binding | undefined;
  }
  private atomic<T>(fn: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  cached(id: string) {
    this.work.get(id);
    const row = this.lookup(id);
    return row ? parseReceipt(row) : null;
  }

  private save(id: string, receipt: StageHomeReceipt, observed?: string) {
    this.db.prepare("UPDATE stage_home_bindings SET receipt=?, remote_updated_at=COALESCE(?,remote_updated_at) WHERE work_id=?")
      .run(JSON.stringify(receipt), observed ?? null, id);
    return receipt;
  }

  private checkConnection(row: Binding) {
    if (row.connection !== this.client.identity) throw invalid("Agent Home 服务或访问身份已变化，请恢复原连接后核对回执。");
  }

  async send(id: string, botId: string): Promise<StageHomeReceipt> {
    const work = this.work.get(id);
    if (work.target !== "agent-home") throw invalid("这项任务由 coding agent 接手。");
    const input = formatStageHomeBrief(work);
    if(input.length>homeBriefLimit) throw new ApiError(400,"stage_home_brief","Agent Home 的任务输入上限为 3500 字符。请缩短简报或改用 Agent Home 会话的 CLI 认领。");
    const bound = this.lookup(id);
    if (bound) {
      if (bound.bot_id !== botId) throw invalid("这项任务已绑定到指定的 Agent Home Bot。");
      this.checkConnection(bound);
      // Re-submission is a read until reconciliation explicitly established that the remote
      // ledger contains no such task. A known remote ID is never replaced.
      const receipt = parseReceipt(bound);
      if (!receipt.canRetry || receipt.remoteId || receipt.status !== "unknown") return receipt;
      const checked = await this.reconcile(id);
      if (!checked?.canRetry || checked.remoteId) return checked!;
    }
    const bot = (await this.client.bots()).find(item => item.id === botId);
    if (!bot) throw invalid("请选择目前可接手任务的 Agent Home Bot。");
    const intent = this.atomic(() => {
      const row = this.lookup(id);
      if (row) {
        if (row.bot_id !== botId) throw invalid("这项任务已绑定其他 Bot。");
        const prior = parseReceipt(row);
        if (!bound || !prior.canRetry || prior.remoteId) return { receipt: prior, dispatch: false };
        this.work.renew(id, { claimId: row.claim_id });
        const receipt = { ...prior, checkedAt: clock(), canRetry: false, status: "submitting", detail: "正在向原 Bot 核验同一派工请求。" };
        return { receipt: this.save(id, receipt), dispatch: true };
      }
      const { claimId } = this.work.claim(id, { via: "agent-home", agent: bot.name.slice(0,128), session: "stage-home:" + bot.id + ":" + id });
      const receipt = { botId, botName: bot.name, status: "submitting", detail: "派工已登记，等待 Agent Home 回执。", checkedAt: clock(), evidence: [] };
      this.db.prepare("INSERT INTO stage_home_bindings(work_id,bot_id,claim_id,connection,brief,receipt) VALUES(?,?,?,?,?,?)")
        .run(id, botId, claimId, this.client.identity, input, JSON.stringify(receipt));
      return { receipt, dispatch: true };
    });
    if (!intent.dispatch) return intent.receipt;
    let remote: HomeTask;
    try { remote = await this.client.send(bot.id, input, "kunlun-stage/" + id); }
    catch (error) { return this.uncertain(id, error); }
    return this.project(id, remote);
  }

  private uncertain(id: string, error: unknown) {
    const current = parseReceipt(this.lookup(id)!);
    if (current.remoteId) return current;
    const why = error instanceof Error ? error.message : "连接中断。";
    return this.save(id, { ...current, status: "unknown", checkedAt: clock(), detail: why + " 请先对账原派工。", canRetry: false });
  }

  // Local GET is passive. Reconciliation reads the original Home task without waking a Bot.
  async reconcile(id: string): Promise<StageHomeReceipt | null> {
    this.work.get(id);
    const row = this.lookup(id);
    if (!row) return null;
    this.checkConnection(row);
    const old = parseReceipt(row);
    let found: HomeTask | null;
    try { found = old.remoteId ? await this.client.read(old.remoteId) : await this.client.locate(row.bot_id, row.brief); }
    catch (error) {
      if (!old.remoteId) return this.uncertain(id, error);
      throw error;
    }
    if (found) return this.project(id, found);
    const latest = parseReceipt(this.lookup(id)!);
    if (latest.remoteId) return latest;
    return this.save(id, { ...latest, checkedAt: clock(), status: "unknown", canRetry: true,
      detail: "已查完 Agent Home 的任务记录，暂未找到本工单。可向原 Bot 重试同一个派工请求。" });
  }

  private project(id: string, remote: HomeTask) {
    return this.atomic(() => {
      const row = this.lookup(id)!;
      const old = parseReceipt(row);
      if (remote.input !== row.brief || remote.targetBotId !== row.bot_id || (old.remoteId && old.remoteId !== remote.id)) {
        throw invalid("回执与原目标、Bot 或工单编号不一致。");
      }
      const observed = new Date(remote.updatedAt).toISOString();
      if (row.remote_updated_at > observed || old.status === "completed") return old;
      const delivery = remote.delivery;
      const validDelivery = remote.status === "completed" && delivery?.taskId === remote.id &&
        delivery.attempt === remote.attempt && delivery.executionStatus === "completed" && delivery.report.trim();
      const status = remote.status === "completed" && !validDelivery ? "needs_evidence" : remote.status;
      const evidence: string[] = [];
      let detail = labels[status] ?? "Agent Home 的执行状态为 " + status + "。";
      if (validDelivery && delivery) {
        detail = delivery.report.slice(0, 12000);
        evidence.push(this.client.origin + "/api/bot-work/tasks/" + encodeURIComponent(remote.id),
          `Agent Home 会话 ${delivery.sessionId}，交付轮次 ${delivery.attempt}`);
        for (const item of delivery.artifacts) evidence.push(`产物 ${item.id} · ${item.fileName}`);
        for (const item of delivery.receipts) evidence.push(`工具回执 ${item.id} · ${item.toolName} · ${item.state}`);
      } else if (status === "needs_evidence") {
        detail = "Agent Home 标记为完成，尚缺少与本次任务和轮次匹配的交付报告。";
      } else if (remote.failureReason) detail += " " + remote.failureReason.slice(0, 1800);
      const receipt = { botId: row.bot_id, botName: old.botName, remoteId: remote.id, status, detail,
        evidence: evidence.slice(0, 32).map(value => value.slice(0, 4000)), checkedAt: clock() };
      // Renew only the original claim. A human who reconciled a stale lease and transferred
      // ownership prevents this old task from committing a late delivery.
      this.work.renew(id, { claimId: row.claim_id });
      const kind = status === "completed" ? "completed" : "progress";
      const eventId = "home/" + createHash("sha256").update(JSON.stringify([remote.id,remote.attempt,status,detail,receipt.evidence])).digest("hex");
      this.work.report(id, { claimId: row.claim_id, eventId, kind, body: detail, ...(receipt.evidence.length && { evidence: receipt.evidence }) });
      return this.save(id, receipt, observed);
    });
  }
}

export function addStageHomeRoutes(app: Hono, db: DatabaseSync, work: StageWorkStore, user: (c: Context) => unknown) {
  const service = new StageHomeService(db, work);
  app.get(endpoint + "/bots", async c => { user(c); return c.json(await service.bots()); });
  app.get(endpoint + "/:id", c => { user(c); return c.json({ receipt: service.cached(c.req.param("id")!) }); });
  app.post(endpoint + "/:id/send", async c => {
    user(c);
    const input = sendInput.safeParse(await c.req.json());
    if (!input.success) throw new ApiError(400, "stage_home_bot", "请选择一个 Agent Home Bot。");
    return c.json({ receipt: await service.send(c.req.param("id")!, input.data.botId) });
  });
  app.post(endpoint + "/:id/reconcile", async c => {
    user(c);
    return c.json({ receipt: await service.reconcile(c.req.param("id")!) });
  });
  return service;
}
