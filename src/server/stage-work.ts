import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { productStageIds, productStages, type ProductStageId } from "../product-stages.ts";
import type { StageWork, StageWorkInput } from "../stage-work-types.ts";
import { acquireClaim, finishClaim, renewClaim } from "./claims.ts";
import { validateStageScope } from "./company.ts";
import { ApiError } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";
import { zoomFolder } from "./zoom-folder.ts";
import { ZoomStore } from "./zoom.ts";

const short = z.string().trim().min(1).max(128);
const detail = z.string().trim().min(1).max(12000);
const pathSegment = zoomFolder.refine((value) => !value.includes("/") && value.length <= 160, "名称需要是单一目录");
const productName = z.union([z.literal(""), pathSegment]);
const stageId = z.enum(productStageIds);
const target = z.enum(["coding-agent", "agent-home"]);
const create = z
  .strictObject({
    requestId: short,
    product: productName,
    project: pathSegment.optional(),
    companyItemId: short.optional(),
    stage: stageId,
    templateId: short,
    title: z.string().trim().min(1).max(1000),
    goal: detail,
    inputs: z.string().trim().max(12000),
    deliverable: detail,
    acceptance: detail,
    target,
    requestedAgent: short.optional(),
  })
  .refine(
    (input) => !input.requestedAgent || input.target === "coding-agent",
    "指定 coding agent 时请选择 coding-agent",
  )
  .refine(
    (input) => input.product || (["research", "idea"].includes(input.stage) && !input.project),
    "公司事项可在信息收集与想法阶段发起，项目需归属产品",
  )
  .refine((input) => ["research", "idea"].includes(input.stage) || input.project, "请选定本阶段事项所属的产品与项目");
const filters = z.strictObject({
  product: productName.optional(),
  project: pathSegment.optional(),
  companyItemId: short.optional(),
  stage: stageId.optional(),
  target: target.optional(),
  requestedAgent: short.optional(),
  status: z.enum(["open", "active", "waiting", "reconcile", "completed"]).optional(),
});
const claimInput = z.strictObject({
  agent: short,
  session: z.string().trim().min(1).max(512),
  via: target.default("coding-agent"),
});
const claimRef = z.strictObject({ claimId: z.uuid() });
const releaseInput = claimRef.extend({ reason: z.string().trim().min(1).max(2000) });
const reopenInput = z.strictObject({
  expectedLeaseUntil: z.iso.datetime(),
  reason: z.string().trim().min(1).max(2000),
});
const reportInput = z.object({ claimId: z.uuid(), eventId: z.string().trim().min(1).max(512) }).passthrough();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "stage_input",
      parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join(" / "),
    );
  return parsed.data;
}
function conflict(message: string): never {
  throw new ApiError(409, "stage_conflict", message);
}

type Claim = { id: string; agent_id: string; state: string; lease_until: string };
type WorkRow = {
  task_id: string;
  brief: string;
  created_at: string;
  completed: number;
  agent_id: string | null;
  lease_until: string | null;
  pending_id: string | null;
  latest_id: string;
  evidence: string;
};
const workQuery = `SELECT w.*,t.completed,c.agent_id,c.lease_until,
  (SELECT m.id FROM zoom_messages m WHERE m.task_id=t.id AND m.kind='question' AND NOT EXISTS
    (SELECT 1 FROM zoom_messages r WHERE r.reply_to=m.id) ORDER BY seq DESC LIMIT 1) AS pending_id,
  (SELECT id FROM zoom_messages WHERE task_id=t.id ORDER BY seq DESC LIMIT 1) AS latest_id,
  (SELECT json_group_array(DISTINCT e.value) FROM zoom_messages m,json_each(m.evidence) e WHERE m.task_id=t.id) AS evidence
  FROM stage_work w JOIN zoom_tasks t ON t.id=w.task_id
  LEFT JOIN stage_claims c ON c.task_id=w.task_id AND c.state IN ('active','completed')`;
function view(row: WorkRow): StageWork {
  const expired = row.lease_until && row.lease_until <= new Date().toISOString();
  const status = row.completed
    ? "completed"
    : expired
      ? "reconcile"
      : !row.agent_id
        ? "open"
        : row.pending_id
          ? "waiting"
          : "active";
  return {
    ...(JSON.parse(row.brief) as StageWorkInput),
    id: row.task_id,
    createdAt: row.created_at,
    status,
    ...(row.agent_id && { owner: JSON.parse(row.agent_id)[0] as string }),
    ...(row.lease_until && !row.completed && { leaseUntil: row.lease_until }),
    evidence: JSON.parse(row.evidence),
    messageId: row.pending_id ?? row.latest_id,
  };
}

export class StageWorkStore {
  private zoom: ZoomStore;
  constructor(private db: DatabaseSync) {
    this.zoom = new ZoomStore(db);
  }

  private write<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string) {
    const row = this.db.prepare(workQuery + " WHERE w.task_id=?").get(id) as WorkRow | undefined;
    if (!row) throw new ApiError(404, "stage_work_missing", "找不到这项阶段任务");
    return view(row);
  }

  list(input: unknown = {}) {
    const f = parse(filters, input);
    const sql =
      workQuery +
      ` WHERE (? IS NULL OR json_extract(w.brief,'$.product')=?)
      AND (? IS NULL OR json_extract(w.brief,'$.project')=?) AND (? IS NULL OR json_extract(w.brief,'$.companyItemId')=?)
      AND (? IS NULL OR t.stage=?) AND (? IS NULL OR json_extract(w.brief,'$.target')=?)
      AND (? IS NULL OR json_extract(w.brief,'$.requestedAgent')=? COLLATE NOCASE) ORDER BY w.created_at DESC,w.task_id`;
    const rows = this.db
      .prepare(sql)
      .all(
        f.product ?? null,
        f.product ?? null,
        f.project ?? null,
        f.project ?? null,
        f.companyItemId ?? null,
        f.companyItemId ?? null,
        f.stage ?? null,
        f.stage ?? null,
        f.target ?? null,
        f.target ?? null,
        f.requestedAgent ?? null,
        f.requestedAgent ?? null,
      ) as WorkRow[];
    return { items: rows.map(view).filter((work) => !f.status || work.status === f.status) };
  }

  detail(id: string) {
    return { work: this.get(id), messages: this.zoom.thread(id) };
  }

  create(input: unknown, source?: {folder:string;stage:ProductStageId|null;product:string;project?:string}) {
    const validated = parse(create, input);
    const brief=source?{...validated, stage:source.stage,product:source.product,...(source.project && {project:source.project})}:validated;
    return this.write(() => {
      const existing = this.db
        .prepare("SELECT task_id,brief FROM stage_work WHERE request_id=?")
        .get(brief.requestId);
      if (existing) {
        if (existing.brief !== JSON.stringify(brief)) conflict("这个提交标识已绑定另一份任务简报");
        return { work: this.get(String(existing.task_id)), created: false };
      }
      if (!source) validateStageScope(this.db, validated);
      const stage = productStages.find((s) => s.id === validated.stage)!;
      const folder = source?.folder ?? (brief.product
        ? [brief.product, brief.project].filter(Boolean).join("/")
        : "公司/" + (brief.stage === "idea" ? "想法" : stage.label));
      const task = this.zoom.register({
        source: "产品进程",
        externalId: randomUUID(),
        title: brief.title,
        folder,
        context: brief.goal.slice(0, 4000),
        ...(brief.stage && {stage:brief.stage}),
      });
      this.db
        .prepare("INSERT INTO stage_work(task_id,request_id,brief,created_at) VALUES(?,?,?,?)")
        .run(task.id, brief.requestId, JSON.stringify(brief), new Date().toISOString());
      return { work: this.get(task.id), created: true };
    });
  }

  private owner(id: string, claimId: string): Claim {
    const claim = this.db.prepare("SELECT * FROM stage_claims WHERE task_id=? AND id=?").get(id, claimId) as
      | Claim
      | undefined;
    if (!claim) conflict("请先认领该任务，使用本次认领返回的 claimId");
    return claim;
  }

  private note(id: string, body: string, actor: string) {
    this.zoom.report(id, { eventId: "stage-system/" + randomUUID(), kind: "progress", body }, actor);
  }

  claim(id: string, input: unknown) {
    const request = parse(claimInput, input);
    return this.write(() => {
      const work = this.get(id);
      if (work.target !== request.via) conflict("执行入口与任务指定的执行方不一致");
      if (work.requestedAgent && work.requestedAgent.toLowerCase() !== request.agent.toLowerCase())
        conflict("该任务已指定 " + work.requestedAgent);
      const key = JSON.stringify([work.requestedAgent || request.agent, request.session]);
      const prior = this.db.prepare("SELECT id,state FROM stage_claims WHERE task_id=? AND agent_id=?").get(id, key);
      if (prior) {
        if (prior.state === "released") conflict("这个会话的认领已结束，重新开工需使用新会话标识");
        return { work, claimId: String(prior.id) };
      }
      if (work.status !== "open")
        conflict(work.status === "reconcile" ? "原认领超时，请先与执行现场核对" : "任务已被认领或已经交付");
      const claimId = randomUUID();
      acquireClaim(this.db, "stage_claims", claimId, id, "executor", key);
      this.note(id, request.agent + " 已接手这项工作。", request.agent);
      return { work: this.get(id), claimId };
    });
  }

  renew(id: string, input: unknown) {
    const { claimId } = parse(claimRef, input);
    return this.write(() => {
      const claim = this.owner(id, claimId);
      if (claim.state !== "active") conflict("这次认领已结束");
      renewClaim(this.db, "stage_claims", id, claim.agent_id);
      return this.get(id);
    });
  }

  release(id: string, input: unknown) {
    const { claimId, reason } = parse(releaseInput, input);
    return this.write(() => {
      const claim = this.owner(id, claimId);
      if (claim.state === "released") return this.get(id);
      if (claim.state !== "active") conflict("任务已经交付");
      finishClaim(this.db, "stage_claims", id, "executor", claim.agent_id, "released");
      this.note(id, "执行者已停止本次工作，重新开放认领。" + reason, JSON.parse(claim.agent_id)[0]);
      return this.get(id);
    });
  }

  reopen(id: string, input: unknown, actor: string) {
    const request = parse(reopenInput, input);
    return this.write(() => {
      const work = this.get(id);
      if (work.status !== "reconcile" || request.expectedLeaseUntil !== work.leaseUntil)
        conflict("认领状态已变化，请重新核对当前执行者");
      const active = this.db.prepare("SELECT agent_id FROM stage_claims WHERE task_id=? AND state='active'").get(id)!;
      finishClaim(this.db, "stage_claims", id, "executor", String(active.agent_id), "released");
      this.note(id, "已核对原执行现场，重新开放认领。" + request.reason, actor);
      return this.get(id);
    });
  }

  report(id: string, input: unknown) {
    const { claimId, ...event } = parse(reportInput, input);
    return this.write(() => {
      const claim = this.owner(id, claimId);
      const owner = JSON.parse(claim.agent_id)[0];
      // Scope retry keys to this attempt. A released worker can read its exact receipt but cannot append changes.
      if (event.eventId.startsWith("stage-system/"))
        throw new ApiError(400, "stage_input", "请使用执行者自己的事件标识");
      const previous = this.db
        .prepare("SELECT claim_id FROM stage_receipts WHERE task_id=? AND event_key=?")
        .get(id, event.eventId);
      if (previous) {
        if (previous.claim_id !== claimId) conflict("该事件标识已绑定另一次认领");
        return this.zoom.report(id, event, owner);
      }
      if (claim.state !== "active" || claim.lease_until <= new Date().toISOString())
        conflict("认领已结束或超时；请先续租或核对原执行现场");
      if (event.kind === "completed") {
        if (!Array.isArray(event.evidence) || !event.evidence.length)
          throw new ApiError(400, "stage_evidence", "请附上交付物或验收证据");
        if (this.get(id).status === "waiting") conflict("请先处理仍待答复的问题");
      }
      const message = this.zoom.report(id, event, owner);
      this.db
        .prepare("INSERT INTO stage_receipts(task_id,event_key,claim_id) VALUES(?,?,?)")
        .run(id, event.eventId, claimId);
      if (event.kind === "completed")
        finishClaim(this.db, "stage_claims", id, "executor", claim.agent_id, "completed");
      else renewClaim(this.db, "stage_claims", id, claim.agent_id);
      return message;
    });
  }

  has(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM stage_work WHERE task_id=?").get(id));
  }
}

export function addStageWorkRoutes(
  app: Hono,
  db: DatabaseSync,
  token: string | undefined,
  user: (c: Context) => { name: string },
) {
  const store = new StageWorkStore(db);
  const { permits, requireSubmit } = submitAuth(token);
  const endpoint = "/api/zoom/stage-work";
  app.get(endpoint, (c) => {
    if (!permits(c)) user(c);
    return c.json(store.list(c.req.query()));
  });
  app.get("/api/zoom/stage-work/:id", (c) => {
    if (!permits(c)) user(c);
    return c.json(store.detail(c.req.param("id")));
  });
  app.post(endpoint, async (c) => {
    if (!permits(c)) user(c);
    return c.json(store.create(await c.req.json()));
  });
  app.post("/api/zoom/stage-work/:id/claim", async (c) => {
    requireSubmit(c);
    return c.json(store.claim(c.req.param("id"), await c.req.json()));
  });
  app.post("/api/zoom/stage-work/:id/renew", async (c) => {
    requireSubmit(c);
    return c.json({ work: store.renew(c.req.param("id"), await c.req.json()) });
  });
  app.post("/api/zoom/stage-work/:id/release", async (c) => {
    requireSubmit(c);
    return c.json({ work: store.release(c.req.param("id"), await c.req.json()) });
  });
  app.post("/api/zoom/stage-work/:id/reopen", async (c) => {
    const actor = user(c);
    return c.json({ work: store.reopen(c.req.param("id"), await c.req.json(), actor.name) });
  });
  return store;
}
