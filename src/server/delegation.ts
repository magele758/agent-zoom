import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DelegateMethod, DelegatePreference, Delegation } from "../delegation-types.ts";
import type { ProductStageId } from "../product-stages.ts";
import { zoomFolder } from "./zoom-folder.ts";
import type { WorkflowRun } from "../workflow-types.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import type { StageWorkStore } from "./stage-work.ts";
import { formatStageHomeBrief, homeBriefLimit, type StageHomeService } from "./stage-home.ts";
import type { HomeRoomBridge } from "./home-room.ts";
import { ApiError, type Store, type Principal } from "./logic.ts";
import { requiresHumanApproval } from "../approval-question.ts";
import { ZoomStore } from "./zoom.ts";

type User = Extract<Principal, { type: "user" }>;
const methodSchema = z.strictObject({
  via: z.enum(["coding-agent", "agent-home"]),
  target: z.string().trim().min(1).max(128),
  instructions: z.string().trim().max(4000),
});
const preferenceSchema = methodSchema.extend({ automatic: z.boolean() });
const ref = z.string().trim().min(1).max(1024);
const operation = z.strictObject({
  key: ref,
  title: z.string().trim().min(1).max(1000),
  href: z
    .string()
    .regex(/^#[^\x00-\x20]*$/)
    .max(2200),
  detail: z.string().trim().max(12000),
  requiresApproval: z.boolean().optional(),
});
const requestSchema = z.union([
  z.strictObject({ messageId: ref, method: methodSchema }),
  z.strictObject({ operation, method: methodSchema }),
]);
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, "delegation_input", "请选择执行者，检查原事项和补充说明。");
  return result.data;
}
type Source = {
  id: string;
  title: string;
  href: string;
  detail: string;
  kind: "message" | "operation";
  pending?: boolean;
  taskId?: string;
  folder?: string;
  stage?: ProductStageId;
  opportunityId?: string;
  mode: "answer" | "recommend" | "work";
};
type Row = {
  id: string;
  user_id: string;
  source_id: string;
  source: string;
  method: string;
  work_id: string;
  status: Delegation["status"];
  result: string;
  evidence: string;
  settled: number;
  created_at: string;
};
const failure = (reason: string) => new ApiError(409, "delegation_conflict", reason);
const briefText = (text: string, limit: number) => (text.length <= limit ? text : text.slice(0, limit - 1) + "…");
function mode(message: ZoomMessage): Source["mode"] {
  if (!message.pending) return "work";
  if (
    requiresHumanApproval(message) ||
    message.readOnly ||
    message.capabilityRequest ||
    message.businessTrial ||
    message.choices?.length ||
    message.kind === "decision" ||
    message.kind === "recovery" ||
    (message.pending && message.origin === "workflow")
  )
    return "recommend";
  if (
    message.pending &&
    message.kind === "question" &&
    (message.action?.kind === "reply" || message.action?.kind === "channel-reply")
  )
    return "answer";
  return message.pending ? "recommend" : "work";
}
function workflowMaterials(store: Store, m: ZoomMessage): string[] {
  if (m.origin !== "workflow") return [];
  const path = "/api/workflows/" + encodeURIComponent(m.taskId);
  const retrieval = /^[a-f0-9-]{36}$/i.test(m.taskId) ? "npm run workflow -- status " + m.taskId : "GET " + path;
  const record = store.db.prepare("SELECT snapshot FROM workflow_runs WHERE id=?").get(m.taskId);
  if (!record) return [retrieval];
  const run = JSON.parse(String(record.snapshot)) as WorkflowRun;
  const rev = run.revisions.find((r) => r.number === m.revision);
  if (!rev) return [retrieval];
  const active = new Set(rev.plan.nodes.map((n) => n.id));
  const evidence = run.attempts.filter((a) => a.revision <= rev.number && active.has(a.nodeId) && a.evidence);
  return [
    retrieval,
    "绑定计划 r" + rev.number + " · " + rev.reason,
    "验收节点 " + rev.plan.acceptance.join("、"),
    ...evidence.map(
      (a) =>
        a.nodeId +
        " / " +
        a.id +
        " r" +
        a.revision +
        " · " +
        a.evidence!.outcome +
        " · " +
        briefText(a.evidence!.summary, 320) +
        " · " +
        a.evidence!.checks.map((c) => c.name + " exit=" + c.exitCode).join("、"),
    ),
    ...rev.plan.nodes.map(
      (n) =>
        n.id +
        " [" +
        n.kind +
        "] " +
        n.title +
        (n.dependsOn.length ? " ← " + n.dependsOn.join("、") : "") +
        " · " +
        briefText(n.instruction, 500),
    ),
    ...(run.request.constraints ?? []).map((c) => "约束 " + c),
  ];
}
function messageSource(store: Store, m: ZoomMessage): Source {
  const href = "#inbox?" + new URLSearchParams({ message: m.id });
  return {
    id: m.id,
    kind: "message",
    pending: m.pending,
    taskId: m.taskId,
    folder: m.folder,
    stage: m.stage,
    href,
    title: m.taskTitle,
    mode: mode(m),
    detail: [
      "原任务 " + m.taskId + " · 原消息 " + m.id,
      m.revision !== undefined && "版本 r" + m.revision,
      m.action?.kind === "decision" && "决策卡 " + m.action.cardId,
      (m.action?.kind === "retry" || m.action?.kind === "recover") && "执行尝试 " + m.action.attemptId,
      m.action?.kind === "channel-reply" && "频道 " + m.action.roomId + " · 帖子 " + m.action.messageId,
      m.roomBinding && "Agent Home 房间绑定 " + m.roomBinding + " · 原帖 " + m.id,
      m.capabilityRequest &&
        "原仓需求 " +
          m.capabilityRequest.id +
          (m.capabilityRequest.revision ? " · 修订 " + m.capabilityRequest.revision : ""),
      m.businessTrial && "业务线 " + m.businessTrial.lineId + " · 实验 " + m.businessTrial.trialId,
      m.body,
      ...workflowMaterials(store, m),
      m.folder,
      m.source,
      m.context,
      ...(m.choices ?? []),
      ...(m.evidence ?? []),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
function view(row: Row, workMessageId?: string): Delegation {
  const source = JSON.parse(row.source) as Source;
  return {
    id: row.id,
    workId: row.work_id,
    ...(workMessageId ? { workMessageId } : {}),
    sourceId: row.source_id,
    title: source.title,
    sourceHref: source.href,
    method: JSON.parse(row.method),
    status: row.status,
    result: row.result,
    evidence: JSON.parse(row.evidence),
    requiresApproval: source.mode === "recommend",
  };
}

const homeInstructionsLimit = 1500;

export class DelegationService {
  private zoom: ZoomStore;
  private ticking: Promise<void> | undefined;
  private busy = new Set<string>();
  constructor(
    private store: Store,
    private work: StageWorkStore,
    private home: Pick<StageHomeService, "send" | "reconcile" | "cached">,
    private rawMessages: (user: User) => ZoomMessage[],
    private rooms?: HomeRoomBridge,
  ) {
    this.zoom = new ZoomStore(store.db);
    store.db.exec(`CREATE TABLE IF NOT EXISTS opc_delegations (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_id TEXT NOT NULL,source TEXT NOT NULL,method TEXT NOT NULL,
      work_id TEXT NOT NULL UNIQUE REFERENCES stage_work(task_id),status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '[]',settled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL, UNIQUE(user_id,source_id));
      CREATE TABLE IF NOT EXISTS opc_delegate_preferences(user_id TEXT PRIMARY KEY, preference TEXT NOT NULL, since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opc_delegate_baseline(user_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(user_id,source_id));`);
  }
  private rows(user: User, active = false): Row[] {
    return this.store.db
      .prepare(
        "SELECT * FROM opc_delegations WHERE user_id=?" +
          (active ? " AND settled=0" : "") +
          " ORDER BY created_at DESC,id",
      )
      .all(user.id) as Row[];
  }
  private preference(user: User) {
    const row = this.store.db
      .prepare("SELECT preference,since FROM opc_delegate_preferences WHERE user_id=?")
      .get(user.id);
    return row
      ? { method: JSON.parse(String(row.preference)) as DelegatePreference, since: String(row.since) }
      : null;
  }
  private workMessageIds(workIds: string[]) {
    const map = new Map<string, string>();
    if (!workIds.length) return map;
    const placeholders = workIds.map(() => "?").join(",");
    const rows = this.store.db
      .prepare(
        `SELECT m.task_id, m.id,
          (m.kind='question' AND NOT EXISTS(SELECT 1 FROM zoom_messages r WHERE r.reply_to=m.id)) AS pending_q
         FROM zoom_messages m WHERE m.task_id IN (${placeholders})
         ORDER BY m.task_id, pending_q DESC, m.seq DESC`,
      )
      .all(...workIds) as Array<{ task_id: string; id: string }>;
    for (const row of rows) if (!map.has(row.task_id)) map.set(row.task_id, row.id);
    return map;
  }
  list(user: User) {
    const rows = this.rows(user);
    const projected = rows.some((r) => this.awaitingOriginal(r))
      ? this.projectResolved(rows, this.rawMessages(user))
      : rows;
    const workMessages = this.workMessageIds(projected.map((r) => r.work_id));
    return {
      items: projected.map((row) => view(row, workMessages.get(row.work_id))),
      preference: this.preference(user)?.method ?? null,
    };
  }
  private atomic<T>(f: () => T): T {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.store.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
  }
  setPreference(user: User, raw: unknown) {
    const method = parse(preferenceSchema, raw);
    if (method.via === "agent-home" && method.instructions.length > homeInstructionsLimit)
      throw new ApiError(400, "delegation_input", `处理说明超过 Agent Home 简报的 ${homeInstructionsLimit} 字符上限。`);
    return this.atomic(() => {
      const previous = this.preference(user);
      let since = previous?.since ?? new Date().toISOString();
      if (method.automatic && !previous?.method.automatic) {
        since = new Date().toISOString();
        this.store.db.prepare("DELETE FROM opc_delegate_baseline WHERE user_id=?").run(user.id);
        const baseline = this.store.db.prepare("INSERT OR IGNORE INTO opc_delegate_baseline VALUES(?,?)");
        for (const m of this.rawMessages(user)) if (m.pending) baseline.run(user.id, m.id);
      }
      this.store.db
        .prepare(
          `INSERT INTO opc_delegate_preferences VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET preference=excluded.preference,since=excluded.since`,
        )
        .run(user.id, JSON.stringify(method), since);
      return method;
    });
  }
  private owned(user: User, sourceId: string) {
    return this.store.db
      .prepare("SELECT * FROM opc_delegations WHERE user_id=? AND source_id=?")
      .get(user.id, sourceId) as Row | undefined;
  }
  private child(taskId: string) {
    return Boolean(this.store.db.prepare("SELECT 1 FROM opc_delegations WHERE work_id=?").get(taskId));
  }
  private table(name: string) {
    return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }
  private scope(source: Source) {
    const value = source.folder ?? "";
    const parts = value.split("/");
    const bound =
      parts.length >= 2 &&
      this.table("company_projects") &&
      this.store.db.prepare("SELECT 1 FROM company_projects WHERE product=? AND name=?").get(parts[0], parts[1]);
    return {
      folder: (source.stage || bound) && zoomFolder.safeParse(value).success ? value : "公司/委派",
      stage: source.stage ?? null,
      product: bound ? parts[0] : "",
      ...(bound && { project: parts[1] }),
    };
  }
  private ensure(user: User, source: Source, method: DelegateMethod): Row {
    const serialized = JSON.stringify(method);
    return this.atomic(() => {
      const old = this.owned(user, source.id);
      if (old) {
        if (old.method !== serialized || (JSON.parse(old.source) as Source).kind !== source.kind)
          throw failure("这个事项已委派，请查看原工单。");
        return old;
      }
      if (source.kind === "operation" && source.id.includes("/next/")) {
        const suffix = /^(.*)\/next\/([a-f0-9-]{36})$/.exec(source.id);
        if (suffix) {
          const parent = this.store.db
            .prepare("SELECT * FROM opc_delegations WHERE user_id=? AND id=?")
            .get(user.id, suffix[2]) as Row | undefined;
          const base = parent?.source_id.replace(/\/next\/[a-f0-9-]{36}$/, "");
          const previous: Source | undefined = parent && JSON.parse(parent.source);
          if (
            !parent ||
            base !== suffix[1] ||
            previous?.kind !== "operation" ||
            previous.mode !== "work" ||
            parent.status !== "completed" ||
            !parent.settled
          )
            throw failure("上一轮工作尚未交付，或属于另一事项。");
        }
      }
      const id = randomUUID();
      const isHome = method.via === "agent-home";
      if (isHome && method.instructions.length > homeInstructionsLimit)
        throw new ApiError(400, "delegation_input", `处理说明超过 Agent Home 简报的 ${homeInstructionsLimit} 字符上限。`);
      const instructions = method.instructions || "根据原事项准备可核对的处理结果。";
      const scope = this.scope(source);
      const rule =
        source.mode === "recommend"
          ? "仅提交供负责人审批的建议、理由和证据。审批、选择、恢复和经营决策须由负责人在原事项确认。"
          : source.mode === "answer"
            ? "提交可以原样回复原问题的答复正文，另附核对证据。"
            : "按说明处理原事项，提交结果及证据。涉及审批或外部发布时，提交负责人确认。";
      const acceptance = "附原任务、可核对依据或产物。把结果作为本工单的完成回执。";
      const title = "委派 · " + briefText(source.title, isHome ? 160 : 900);
      const inputs = source.href + "\n" + source.detail;
      const limit = isHome
        ? homeBriefLimit -
          formatStageHomeBrief({
            ...scope,
            id,
            title,
            goal: instructions,
            inputs: " ",
            deliverable: rule,
            acceptance,
          }).length +
          1
        : 11500;
      if (isHome && limit < 1)
        throw new ApiError(400, "delegation_input", "办理方式或原事项过长，超出 Agent Home 简报 3500 字符上限。");
      const created = this.work.create(
        {
          requestId: "inbox-delegation/" + id,
          product: "",
          stage: "research",
          templateId: "inbox-delegation",
          title,
          goal: instructions,
          inputs: briefText(inputs, isHome ? limit : Math.max(source.href.length, limit)),
          deliverable: rule,
          acceptance,
          target: method.via,
          ...(method.via === "coding-agent" && { requestedAgent: method.target }),
        },
        scope,
      );
      this.store.db
        .prepare(
          "INSERT INTO opc_delegations(id,user_id,source_id,source,method,work_id,status,created_at) VALUES(?,?,?,?,?,?,'queued',?)",
        )
        .run(
          id,
          user.id,
          source.id,
          JSON.stringify(source),
          serialized,
          created.work.id,
          new Date().toISOString(),
        );
      return this.owned(user, source.id)!;
    });
  }
  async submit(user: User, raw: unknown) {
    const input = parse(requestSchema, raw);
    const messages = this.rawMessages(user);
    let source: Source;
    if ("messageId" in input) {
      const m = messages.find((m) => m.id === input.messageId);
      if (!m) throw new ApiError(404, "delegation_source", "原消息已不可见。");
      if (this.child(m.taskId)) throw failure("请在当前委派里补充材料或核对回执。");
      source = messageSource(this.store, m);
    } else {
      const op = input.operation;
      const opportunity =
        op.requiresApproval && op.key.startsWith("opportunity:") && this.table("opc_opportunities")
          ? this.store.db
              .prepare("SELECT id,state FROM opc_opportunities WHERE id=?")
              .get(op.key.slice("opportunity:".length))
          : undefined;
      const query = new URLSearchParams(op.href.split("?")[1]);
      const folder = [query.get("product"), query.get("project")].filter(Boolean).join("/");
      source = {
        id: op.key,
        kind: "operation",
        title: op.title,
        href: op.href,
        detail: op.detail,
        folder,
        ...(opportunity && { opportunityId: String(opportunity.id) }),
        mode: opportunity ? "recommend" : "work",
      };
    }
    const row = this.ensure(user, source, input.method);
    await this.update(user, row, messages, true);
    const saved = this.owned(user, source.id)!;
    return view(saved, this.workMessageIds([saved.work_id]).get(saved.work_id));
  }
  private save(row: Row, status: Delegation["status"], result: string, evidence: string[] = [], settled = false) {
    this.store.db
      .prepare("UPDATE opc_delegations SET status=?,result=?,evidence=?,settled=? WHERE id=? AND settled=0")
      .run(status, result, JSON.stringify(evidence), Number(settled), row.id);
  }
  private awaitingOriginal(row: Row) {
    const source: Source = JSON.parse(row.source);
    return Boolean(row.settled && row.status === "approval" && (source.pending || source.opportunityId));
  }
  private projectResolved(rows: Row[], messages: ZoomMessage[]) {
    const byId = new Map(messages.map((m) => [m.id, m]));
    const oppIds = [
      ...new Set(
        rows
          .filter((row) => this.awaitingOriginal(row))
          .map((row) => (JSON.parse(row.source) as Source).opportunityId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const oppStates = new Map<string, string>();
    if (oppIds.length && this.table("opc_opportunities")) {
      const placeholders = oppIds.map(() => "?").join(",");
      for (const row of this.store.db
        .prepare(`SELECT id,state FROM opc_opportunities WHERE id IN (${placeholders})`)
        .all(...oppIds)) {
        oppStates.set(String(row.id), String(row.state));
      }
    }
    return rows.map((row) => {
      if (!this.awaitingOriginal(row)) return row;
      const source: Source = JSON.parse(row.source);
      if (source.opportunityId) {
        const state = oppStates.get(source.opportunityId);
        if (!state || state === "queued") return row;
      } else if (byId.get(row.source_id)?.pending !== false) return row;
      return { ...row, status: "completed" as const };
    });
  }
  decorate(messages: ZoomMessage[], user = this.store.localUser()): ZoomMessage[] {
    const rows = this.projectResolved(this.rows(user), messages);
    const workMessages = this.workMessageIds(rows.map((r) => r.work_id));
    const bySource = new Map(rows.map((row) => [row.source_id, row]));
    const byWork = new Map(rows.map((row) => [row.work_id, row]));
    const childrenWithQuestion = new Set(
      messages.filter((m) => m.pending && byWork.has(m.taskId)).map((m) => m.taskId),
    );
    const needsPerson = (row: Row) =>
      (row.status === "approval" || row.status === "reconcile") && !childrenWithQuestion.has(row.work_id);
    const projected = messages.map((m) => {
      const row = bySource.get(m.id);
      if (row) return { ...m, pending: m.pending && needsPerson(row), delegation: view(row, workMessages.get(row.work_id)) };
      const parent = byWork.get(m.taskId);
      return parent ? { ...m, delegation: view(parent, workMessages.get(parent.work_id)) } : m;
    });
    const pendingSourceIds = new Set(messages.filter((m) => m.pending).map((m) => m.id));
    for (const row of rows) {
      if (!needsPerson(row) || pendingSourceIds.has(row.source_id)) continue;
      const d = view(row, workMessages.get(row.work_id));
      projected.push({
        id: "delegation:" + row.id,
        taskId: row.work_id,
        origin: "external",
        kind: "question",
        source: d.method.target,
        taskTitle: d.title,
        folder: "公司/委派",
        body: d.result,
        at: row.created_at,
        pending: true,
        evidence: d.evidence,
        delegation: d,
      });
    }
    return projected;
  }
  private async update(user: User, row: Row, messages: ZoomMessage[], explicit = false) {
    if (row.settled || this.busy.has(row.id)) return;
    this.busy.add(row.id);
    try {
      const method: DelegateMethod = JSON.parse(row.method);
      let work = this.work.get(row.work_id);
      if (method.via === "agent-home" && work.status !== "completed") {
        const cached = this.home.cached(work.id);
        // The Home adapter records a dispatch intent before contacting its remote. After that, only read the original job.
        const receipt = cached
          ? await this.home.reconcile(work.id)
          : explicit || row.status !== "reconcile"
            ? await this.home.send(work.id, method.target)
            : null;
        if (!receipt) return;
        if (receipt.status !== "completed") {
          const status =
            receipt.status === "queued"
              ? "queued"
              : receipt.status === "running"
                ? "working"
                : receipt.status === "waiting_approval"
                  ? "approval"
                  : "reconcile";
          this.save(
            row,
            status,
            receipt.detail,
            receipt.evidence,
            ["failed", "cancelled"].includes(receipt.status),
          );
          return;
        }
        work = this.work.get(work.id);
      }
      if (work.status === "completed") {
        const receipt = this.work.detail(work.id).messages.find((m) => m.kind === "completed");
        if (!receipt?.evidence?.length) {
          this.save(row, "reconcile", "执行方已结束，等待核对交付证据。");
          return;
        }
        await this.finish(user, row, receipt, messages, work.owner ?? method.target);
      } else if (work.status === "reconcile")
        this.save(row, "reconcile", "认领已超时，请核对原执行现场。", work.evidence);
      else if (work.status === "open") {
        if (method.via === "coding-agent") this.store.notifyStageOffer(work.id, method.target);
        this.save(row, "queued", "等待 " + method.target + " 认领。", work.evidence);
      } else if (work.status === "waiting")
        this.save(row, "approval", "执行者需要补充信息，请打开阶段工单答复。", work.evidence);
      else this.save(row, "working", (work.owner ?? method.target) + " 已接手。", work.evidence);
    } catch (e) {
      const previous = view(row);
      this.save(row, "reconcile", e instanceof Error ? e.message : "待核对执行回执。", previous.evidence);
    } finally {
      this.busy.delete(row.id);
    }
  }
  private async finish(user: User, row: Row, receipt: ZoomMessage, messages: ZoomMessage[], actor: string) {
    const source: Source = JSON.parse(row.source);
    const evidence = receipt.evidence!;
    if (source.mode !== "answer") {
      this.save(row, source.mode === "recommend" ? "approval" : "completed", receipt.body, evidence, true);
      return;
    }
    const m = messages.find((item) => item.id === source.id);
    if (!m || !m.pending) {
      this.save(row, "completed", "原问题已关闭或不再待答。执行结果：" + receipt.body, evidence, true);
      return;
    }
    if (mode(m) !== "answer") {
      this.save(row, "approval", receipt.body, evidence, true);
      return;
    }
    if (m.roomBinding) {
      if (!this.rooms) {
        this.save(row, "approval", receipt.body, evidence, true);
        return;
      }
      // A persisted outgoing answer with the original question as parent is already a send intent.
      // Reconcile in the Room bridge and never resubmit a retryable/unknown outgoing message.
      const parent = m.id.slice("home-room:".length);
      const existing = this.rooms
        .posts(user, m.roomBinding)
        .find((p) => p.direction === "out" && p.parent === parent);
      if (existing && existing.body !== receipt.body) {
        this.save(row, "approval", "原问题已有另一份答复。委派结果：" + receipt.body, evidence, true);
        return;
      }
      const post =
        existing ?? (await this.rooms.replyZoom(user, m.taskId, { questionId: m.id, body: receipt.body }));
      if (post.state !== "received") {
        this.save(row, "reconcile", "已有答复，等待 Agent Home 核对送达。", evidence);
        return;
      }
    } else if (m.action?.kind === "channel-reply") {
      const body = "由 " + actor + " 代答\n" + receipt.body;
      if (body.length > 8000) {
        this.save(row, "approval", receipt.body, evidence, true);
        return;
      }
      this.store.postMessage(user, m.action.roomId, {
        kind: "chat",
        replyTo: m.action.messageId,
        taskId: m.action.taskId,
        body,
      });
    } else this.zoom.reply(m.taskId, { questionId: m.id, body: receipt.body }, actor, evidence);
    this.save(row, "completed", receipt.body, evidence, true);
  }
  tick(user = this.store.localUser()): Promise<void> {
    if (!this.ticking)
      this.ticking = this.run(user).finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }
  private async run(user: User) {
    const preference = this.preference(user);
    const all = this.rows(user);
    let rows = all.filter((r) => !r.settled);
    if (!preference?.method.automatic && !rows.length && !all.some((r) => this.awaitingOriginal(r))) return;
    const messages = this.rawMessages(user);
    const resolved = this.projectResolved(all, messages);
    for (let i = 0; i < all.length; i++)
      if (resolved[i] !== all[i]) {
        this.store.db
          .prepare("UPDATE opc_delegations SET status='completed' WHERE id=? AND status='approval' AND settled=1")
          .run(all[i].id);
      }
    if (preference?.method.automatic) {
      const { automatic: _, ...method } = preference.method;
      const existing = new Set(this.rows(user).map((r) => r.source_id));
      const baseline = new Set(
        this.store.db
          .prepare("SELECT source_id FROM opc_delegate_baseline WHERE user_id=?")
          .all(user.id)
          .map((r) => r.source_id),
      );
      for (const m of messages) {
        if (
          !m.pending ||
          Date.parse(m.at) < Date.parse(preference.since) ||
          !Number.isFinite(Date.parse(m.at)) ||
          baseline.has(m.id) ||
          existing.has(m.id) ||
          this.child(m.taskId)
        )
          continue;
        this.ensure(user, messageSource(this.store, m), method);
      }
      rows = this.rows(user, true);
    }
    for (const row of rows) await this.update(user, row, messages);
  }
}

export function addDelegationRoutes(
  app: Hono,
  store: Store,
  work: StageWorkStore,
  home: StageHomeService,
  user: (c: Context) => User,
  rawMessages: (user: User) => ZoomMessage[],
  rooms?: HomeRoomBridge,
) {
  const service = new DelegationService(store, work, home, rawMessages, rooms);
  const base = "/api/opc/delegations";
  app.get(base, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(service.list(user(c)));
  });
  app.put(base + "/preference", async (c) => c.json(service.setPreference(user(c), await c.req.json())));
  app.post(base, async (c) => c.json(await service.submit(user(c), await c.req.json())));
  return service;
}
