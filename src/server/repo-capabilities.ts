import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  CapabilityIndex,
  CapabilityRequest,
  CapabilityRevision,
  RepoCapability,
} from "../repo-capabilities-types.ts";
import type { ProjectProfile } from "../project-profile-types.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import type { OpportunityStore } from "./autonomy.ts";
import { ApiError } from "./logic.ts";
import { sameCapabilityFamily } from "./capability-identity.ts";
import { ProjectProfiles } from "./project-profiles.ts";
import { parse } from "./workflow/contract.ts";
import { submitAuth } from "./workflow/http.ts";
import { ZoomStore } from "./zoom.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const target = z.strictObject({ product: text(160), project: text(160) });
const content = { title: text(180), detail: text(3000) };
const capabilityInput = target.extend({
  repo: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .max(160),
  name: text(140),
  version: text(120),
  interfaceRef: text(420),
  evidence: text(1200),
});
const createInput = target.extend({
  requestId: text(120),
  capabilityId: z.uuid(),
  sourceOpportunityId: z.uuid().optional(),
  satisfiesRequestId: z.uuid().optional(),
  deliveryEvidence: text(1200).optional(),
  mode: z.enum(["reuse", "gap"]),
  ...content,
});
const revisionInput = z.strictObject({ baseRevision: z.int().positive(), ...content });
const decisionInput = z
  .strictObject({
    revision: z.int().positive(),
    questionId: z.uuid(),
    action: z.enum(["approve", "changes", "reject"]),
    note: z.string().trim().max(3000).default(""),
  })
  .refine((data) => data.action === "approve" || data.note.length > 0, "要求修改或拒绝时请填写反馈");
const choices = { approve: "批准", changes: "要求修改", reject: "拒绝" } as const;
const statuses = { approve: "approved", changes: "changes", reject: "rejected" } as const;
const conflict = (message: string): never => {
  throw new ApiError(409, "capability_conflict", message);
};
const notFound = (message: string): never => {
  throw new ApiError(404, "capability_missing", message);
};
const columns = "id,product,project,repo,name,version,interface_ref AS interfaceRef,evidence";

function verifyReference(repo: string, version: string, evidence: string) {
  // A tag supplied by the owner or a specific commit identifies the interface being adopted.
  let url: URL;
  try {
    url = new URL(evidence);
  } catch {
    return conflict("凭据需要是原仓库的 GitHub 链接");
  }
  const prefix = "/" + repo.toLowerCase() + "/";
  if (
    url.protocol !== "https:" ||
    url.host !== "github.com" ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(prefix)
  )
    return conflict("凭据需要指向该公开仓库里的接口文档或具体版本");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return conflict("仓库凭据中的路径编码无效");
  }
  const hash = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/i;
  const release = path === "releases/tag/" + version;
  const tag = /^(?:v?\d+(?:[.-]\d+)*(?:[-+][\w.-]+)?|release[/-]v?\d+[\w.+-]*)$/i.test(version);
  if ((!hash.test(version) && !tag && !release) || /^(?:latest|current|head|main|master|trunk)$/i.test(version))
    return conflict("请填写具体的发布标签或提交号");
  const isCommit = hash.test(version);
  const pinnedByTag =
    !isCommit &&
    (release ||
      ["blob/", "tree/"].some((kind) => path === kind + version || path.startsWith(kind + version + "/")));
  const documentedCommit = /^(?:blob|tree|commit)\/([0-9a-f]{7,40}|[0-9a-f]{64})(?:\/|$)/i
    .exec(path)?.[1]
    ?.toLowerCase();
  const sha = version.toLowerCase();
  const pinnedByCommit =
    isCommit && !!documentedCommit && (sha.startsWith(documentedCommit) || documentedCommit.startsWith(sha));
  if (!pinnedByTag && !pinnedByCommit)
    return conflict("标签请引用该标签的 Release 或接口文档；提交号请引用对应提交或其接口文档");
}

export class RepoCapabilities {
  private zoom: ZoomStore;
  private profiles: ProjectProfiles;

  constructor(
    private db: DatabaseSync,
    private opportunities: OpportunityStore,
  ) {
    this.zoom = new ZoomStore(db);
    this.profiles = new ProjectProfiles(db);
    db.exec(`CREATE TABLE IF NOT EXISTS opc_repo_capabilities(
      id TEXT PRIMARY KEY, product TEXT NOT NULL,project TEXT NOT NULL,repo TEXT NOT NULL COLLATE NOCASE,
      name TEXT NOT NULL,version TEXT NOT NULL,interface_ref TEXT NOT NULL,evidence TEXT NOT NULL,
      UNIQUE(repo,name,version),FOREIGN KEY(product,project,repo) REFERENCES company_project_repos(product,name,repo));
      CREATE TABLE IF NOT EXISTS opc_capability_requests(
        id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,product TEXT NOT NULL,project TEXT NOT NULL,
        capability_id TEXT NOT NULL REFERENCES opc_repo_capabilities(id),
        source_opportunity_id TEXT REFERENCES opc_opportunities(id),
        mode TEXT NOT NULL CHECK(mode IN ('reuse','gap')),revision INTEGER NOT NULL,task_id TEXT UNIQUE REFERENCES zoom_tasks(id),
        opportunity_id TEXT UNIQUE REFERENCES opc_opportunities(id), initial_input TEXT NOT NULL, intent_key TEXT NOT NULL,
        FOREIGN KEY(product,project) REFERENCES company_projects(product,name));
      CREATE TABLE IF NOT EXISTS opc_capability_satisfaction(
        adoption_id TEXT PRIMARY KEY REFERENCES opc_capability_requests(id),request_id TEXT NOT NULL REFERENCES opc_capability_requests(id),
        evidence TEXT NOT NULL,delivery_ref TEXT NOT NULL,actor TEXT NOT NULL,confirmed_at TEXT NOT NULL,
        CHECK(adoption_id<>request_id));
      CREATE TABLE IF NOT EXISTS opc_capability_plan_problems(request_id TEXT PRIMARY KEY REFERENCES opc_capability_requests(id),problem TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opc_capability_aliases(request_key TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES opc_capability_requests(id),intent_key TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opc_capability_alias_intent ON opc_capability_aliases(intent_key);
      CREATE TABLE IF NOT EXISTS opc_capability_revisions(
        request_id TEXT NOT NULL REFERENCES opc_capability_requests(id), revision INTEGER NOT NULL,title TEXT NOT NULL,
        detail TEXT NOT NULL,status TEXT NOT NULL,question_id TEXT UNIQUE REFERENCES zoom_messages(id),
        feedback TEXT NOT NULL DEFAULT '',actor TEXT,PRIMARY KEY(request_id,revision));
      CREATE UNIQUE INDEX IF NOT EXISTS opc_capability_project_choice ON opc_capability_requests(source_opportunity_id,capability_id)
        WHERE source_opportunity_id IS NOT NULL;`);
    this.atomic(() => {
      const current = db.prepare("PRAGMA table_info(opc_capability_requests)").all();
      if (!current.some((column) => column.name === "intent_key")) {
        db.exec("ALTER TABLE opc_capability_requests ADD COLUMN intent_key TEXT");
        const rows = db
          .prepare("SELECT id,request_key,initial_input FROM opc_capability_requests ORDER BY rowid")
          .all();
        const seen = new Set<string>();
        for (const row of rows) {
          const { requestId, ...intent } = JSON.parse(String(row.initial_input));
          const fingerprint = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
          const canonical = seen.has(fingerprint) ? fingerprint + "/" + row.id : fingerprint;
          db.prepare("UPDATE opc_capability_requests SET intent_key=? WHERE id=?").run(canonical, row.id);
          db.prepare("INSERT OR IGNORE INTO opc_capability_aliases VALUES(?,?,?)").run(
            row.request_key,
            row.id,
            fingerprint,
          );
          seen.add(fingerprint);
        }
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS opc_capability_intent ON opc_capability_requests(intent_key)");
    });
  }

  private atomic<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private capability(id: string): RepoCapability {
    const row = this.db.prepare("SELECT " + columns + " FROM opc_repo_capabilities WHERE id=?").get(id);
    if (!row) return notFound("找不到该版本的仓库能力");
    return row as RepoCapability;
  }

  request(id: string): CapabilityRequest {
    const row = this.db
      .prepare(
        `SELECT r.id,r.product,r.project,r.mode,r.capability_id AS capabilityId,r.source_opportunity_id AS sourceOpportunityId,
          r.revision,r.task_id AS taskId,r.opportunity_id AS opportunityId,o.run_id AS runId,o.state AS opportunityState,src.state AS sourceOpportunityState,p.problem AS planProblem,
          s.request_id AS satisfiesRequestId,s.evidence AS satisfactionEvidence,s.delivery_ref AS satisfactionReference,s.actor AS satisfactionActor,s.confirmed_at AS satisfactionAt
          FROM opc_capability_requests r LEFT JOIN opc_opportunities o ON o.id=r.opportunity_id
          LEFT JOIN opc_opportunities src ON src.id=r.source_opportunity_id
          LEFT JOIN opc_capability_satisfaction s ON s.adoption_id=r.id
          LEFT JOIN opc_capability_plan_problems p ON p.request_id=r.id WHERE r.id=?`,
      )
      .get(id);
    if (!row) return notFound("找不到采用记录或原仓需求");
    const revisions = this.db
      .prepare(
        `SELECT v.revision,v.title,v.detail,v.status,v.question_id AS questionId,v.feedback,v.actor,
           q.created_at AS openedAt,a.created_at AS decidedAt FROM opc_capability_revisions v
           LEFT JOIN zoom_messages q ON q.id=v.question_id LEFT JOIN zoom_messages a ON a.reply_to=q.id
           WHERE v.request_id=? ORDER BY v.revision`,
      )
      .all(id) as CapabilityRevision[];
    return {
      ...row,
      ...revisions.at(-1),
      capability: this.capability(String(row.capabilityId)),
      planProblem: row.runId ? null : row.planProblem,
      revisions,
    } as CapabilityRequest;
  }

  versions(): RepoCapability[] {
    return this.db
      .prepare("SELECT " + columns + " FROM opc_repo_capabilities ORDER BY name,repo,rowid DESC")
      .all() as RepoCapability[];
  }

  index(): CapabilityIndex {
    const projects = this.db
      .prepare("SELECT product,name AS project FROM company_projects ORDER BY product,name")
      .all();
    const repos = this.db
      .prepare("SELECT product,name AS project,repo FROM company_project_repos ORDER BY repo")
      .all();
    return {
      projects: projects.map((row) => ({
        product: String(row.product),
        project: String(row.project),
        repos: repos
          .filter((r) => r.product === row.product && r.project === row.project)
          .map((r) => String(r.repo)),
      })),
      capabilities: this.versions(),
      requests: this.db
        .prepare("SELECT id FROM opc_capability_requests ORDER BY rowid DESC")
        .all()
        .map((row) => this.request(String(row.id))),
    };
  }

  register(raw: unknown) {
    const c = parse(capabilityInput, raw);
    return this.atomic(() => {
      const owner = this.db
        .prepare(
          `SELECT pr.full_name,pr.snapshot FROM company_project_repos ref JOIN project_repositories pr ON pr.full_name=ref.repo
        WHERE ref.product=? AND ref.name=? AND ref.repo=? COLLATE NOCASE`,
        )
        .get(c.product, c.project, c.repo);
      if (!owner || JSON.parse(String(owner.snapshot)).visibility !== "public")
        return conflict("请选择已登记并归属该项目的公开仓库");
      const repo = String(owner.full_name);
      const previous = this.db
        .prepare("SELECT id FROM opc_repo_capabilities WHERE repo=? AND name=? AND version=?")
        .get(repo, c.name, c.version);
      if (previous) {
        const old = this.capability(String(previous.id));
        if (
          old.product !== c.product ||
          old.project !== c.project ||
          old.interfaceRef !== c.interfaceRef ||
          old.evidence !== c.evidence
        ) {
          return conflict("这个版本已有不同的维护项目、接口或凭据，请使用新的具体版本");
        }
        return old;
      }
      verifyReference(repo, c.version, c.evidence);
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO opc_repo_capabilities VALUES(?,?,?,?,?,?,?,?)")
        .run(id, c.product, c.project, repo, c.name, c.version, c.interfaceRef, c.evidence);
      return this.capability(id);
    });
  }

  create(raw: unknown, actor?: string) {
    const draft = parse(createInput, raw);
    if (draft.deliveryEvidence && !draft.satisfiesRequestId)
      return conflict("请明确选择这份交付凭据对应的已批缺口");
    if (draft.satisfiesRequestId) {
      if (!actor) throw new ApiError(401, "capability_confirmation", "请在本机使用人会话确认这项验收");
      if (draft.mode !== "reuse" || !draft.sourceOpportunityId)
        return conflict("请选择原消费候选、明确采用的版本及其解决的已批需求");
    }
    return this.atomic(() => {
      const { requestId, ...intent } = draft;
      const encoded = JSON.stringify(intent);
      const fingerprint = createHash("sha256").update(encoded).digest("hex");
      const known = this.db
        .prepare("SELECT request_id,intent_key FROM opc_capability_aliases WHERE request_key=?")
        .get(requestId);
      if (known) {
        if (known.intent_key !== fingerprint) return conflict("请求标识已绑定原采用项目、能力版本和需求");
        return this.request(String(known.request_id));
      }
      const alias = this.db
        .prepare("SELECT request_id AS id FROM opc_capability_aliases WHERE intent_key=? LIMIT 1")
        .get(fingerprint);
      if (alias) {
        this.db
          .prepare("INSERT INTO opc_capability_aliases VALUES(?,?,?)")
          .run(requestId, alias.id, fingerprint);
        return this.request(String(alias.id));
      }
      const cap = this.capability(draft.capabilityId);
      const consumer = this.profiles
        .all()
        .find((p) => p.product === draft.product && p.project === draft.project);
      if (!consumer) return notFound("请先登记采用该能力的项目");
      if (draft.sourceOpportunityId) {
        const source = this.db
          .prepare("SELECT project,state FROM opc_opportunities WHERE id=?")
          .get(draft.sourceOpportunityId);
        const owners = source
          ? this.db
              .prepare("SELECT product,name FROM company_project_repos WHERE repo=? COLLATE NOCASE")
              .all(source.project)
          : [];
        const repoOwned =
          owners.length === 1 && owners[0].product === draft.product && owners[0].name === draft.project;
        if (
          !source ||
          source.state !== "queued" ||
          (owners.length ? !repoOwned : source.project !== draft.product + "/" + draft.project)
        )
          return conflict("候选不属于该采用项目，或已经进入计划");
      }
      let gap: CapabilityRequest | undefined;
      if (draft.satisfiesRequestId) {
        gap = this.request(draft.satisfiesRequestId);
        if (
          gap.mode !== "gap" ||
          gap.status !== "approved" ||
          !gap.opportunityId ||
          gap.sourceOpportunityId !== draft.sourceOpportunityId ||
          gap.product !== consumer.product ||
          gap.project !== consumer.project
        )
          return conflict("只能确认同一采用项目和消费候选已经批准的原仓缺口");
        if (gap.capabilityId === cap.id || !sameCapabilityFamily(gap.capability, cap))
          return conflict("交付必须是同一维护项目、原仓和能力的另一个固定版本");
        verifyReference(cap.repo, cap.version, draft.deliveryEvidence ?? cap.evidence);
      }
      const previous =
        draft.sourceOpportunityId &&
        this.db
          .prepare("SELECT id FROM opc_capability_requests WHERE source_opportunity_id=? AND capability_id=?")
          .get(draft.sourceOpportunityId, draft.capabilityId);
      if (previous) {
        const adopted = this.request(String(previous.id));
        if (!gap || !actor || adopted.status !== "reused")
          return conflict("这个候选对该能力版本已有采用决定，请回到原记录查看或修订");
        this.confirmDelivery(adopted.id, gap.id, draft.detail, draft.deliveryEvidence ?? cap.evidence, actor);
        this.db
          .prepare("INSERT INTO opc_capability_aliases VALUES(?,?,?)")
          .run(requestId, adopted.id, fingerprint);
        return this.request(adopted.id);
      }
      const id = randomUUID();
      const task =
        draft.mode === "gap"
          ? this.zoom.register({
              source: "OPC OS · 原仓需求",
              externalId: id,
              title: draft.title,
              folder: cap.product + "/" + cap.project,
              stage: "prd",
              context: `采用项目 ${draft.product}/${draft.project}；维护仓库 ${cap.repo}；${cap.name} @ ${cap.version}`,
            })
          : null;
      this.db
        .prepare(
          `INSERT INTO opc_capability_requests(id,request_key,product,project,capability_id,source_opportunity_id,mode,revision,task_id,initial_input,intent_key)
        VALUES(?,?,?,?,?,?,?,1,?,?,?)`,
        )
        .run(
          id,
          draft.requestId,
          draft.product,
          draft.project,
          cap.id,
          draft.sourceOpportunityId ?? null,
          draft.mode,
          task?.id ?? null,
          encoded,
          fingerprint,
        );
      this.db.prepare("INSERT INTO opc_capability_aliases VALUES(?,?,?)").run(requestId, id, fingerprint);
      if (task) this.ask(id, task.id, 1, draft.title, draft.detail, cap);
      else {
        this.recordUse(id, 1, draft.title, draft.detail, consumer, cap);
        if (gap && actor)
          this.confirmDelivery(id, gap.id, draft.detail, draft.deliveryEvidence ?? cap.evidence, actor);
      }
      return this.request(id);
    });
  }

  private confirmDelivery(
    adoptionId: string,
    requestId: string,
    evidence: string,
    reference: string,
    actor: string,
  ) {
    const prior = this.db
      .prepare(
        "SELECT request_id,evidence,delivery_ref,actor FROM opc_capability_satisfaction WHERE adoption_id=?",
      )
      .get(adoptionId);
    if (prior) {
      if (
        prior.request_id !== requestId ||
        prior.evidence !== evidence ||
        prior.delivery_ref !== reference ||
        prior.actor !== actor
      )
        return conflict("这个版本的采用记录已确认另一份缺口或验收依据，请查看原决定");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO opc_capability_satisfaction(adoption_id,request_id,evidence,delivery_ref,actor,confirmed_at) VALUES(?,?,?,?,?,?)",
      )
      .run(adoptionId, requestId, evidence, reference, actor, new Date().toISOString());
  }

  private recordUse(
    id: string,
    revision: number,
    title: string,
    detail: string,
    consumer: ProjectProfile,
    cap: RepoCapability,
  ) {
    this.db
      .prepare(
        "INSERT INTO opc_capability_revisions(request_id,revision,title,detail,status) VALUES(?,?,?,?,'reused')",
      )
      .run(id, revision, title, detail);
    if (cap.product === consumer.product && cap.project === consumer.project) return;
    const reference = cap.repo + " @ " + cap.version + " · " + cap.name;
    const use = { product: cap.product, project: cap.project, reference, purpose: detail.slice(0, 1000) };
    if (
      !consumer.uses.some(
        (p) =>
          p.product === use.product &&
          p.project === use.project &&
          p.reference === reference &&
          p.purpose === use.purpose,
      )
    )
      this.profiles.save({ ...consumer, uses: [...consumer.uses, use] });
  }

  private ask(
    id: string,
    taskId: string,
    revision: number,
    title: string,
    detail: string,
    cap: RepoCapability,
  ) {
    const message = this.zoom.report(taskId, {
      eventId: "requirements/r" + revision,
      kind: "question",
      body: `原仓需求 r${revision} · ${title}\n${detail}\n维护仓库 ${cap.repo} · ${cap.name} @ ${cap.version}\n批准后交给维护项目起草工程计划。`,
      choices: Object.values(choices),
      evidence: [cap.evidence],
    });
    this.db
      .prepare(
        "INSERT INTO opc_capability_revisions(request_id,revision,title,detail,status,question_id) VALUES(?,?,?,?,'pending',?)",
      )
      .run(id, revision, title, detail, message.id);
  }

  revise(id: string, raw: unknown, action: "revise" | "adopt" = "revise") {
    const next = parse(revisionInput, raw);
    return this.atomic(() => {
      const request = this.request(id);
      const base = request.revisions.find((row) => row.revision === next.baseRevision);
      if (!base || (base.status !== "changes" && base.status !== "rejected"))
        return conflict("请从已退回或拒绝的版本修订");
      if (request.revision !== next.baseRevision) {
        if (
          request.revision === next.baseRevision + 1 &&
          request.title === next.title &&
          request.detail === next.detail &&
          (request.status === "reused") === (action === "adopt")
        )
          return request;
        return conflict("需求已有新版本，请刷新");
      }
      if (!request.taskId) return conflict("直接复用记录无需维护需求审批");
      const revision = request.revision + 1;
      this.db.prepare("UPDATE opc_capability_requests SET revision=? WHERE id=?").run(revision, id);
      if (action === "adopt") {
        if (
          request.sourceOpportunityId &&
          !this.db
            .prepare("SELECT 1 FROM opc_opportunities WHERE id=? AND state='queued'")
            .get(request.sourceOpportunityId)
        )
          return conflict("原候选已经退出待选队列，请回到原任务查看");
        const consumer = this.profiles
          .all()
          .find((p) => p.product === request.product && p.project === request.project);
        if (!consumer) return notFound("找不到原采用项目");
        this.recordUse(id, revision, next.title, next.detail, consumer, request.capability);
        this.zoom.report(request.taskId, {
          eventId: "requirements/adopt/r" + revision,
          kind: "completed",
          body: `采用方改用现有版本 ${request.capability.name} @ ${request.capability.version}。\n${next.title}\n${next.detail}`,
          evidence: [request.capability.evidence],
        });
      } else {
        this.ask(id, request.taskId, revision, next.title, next.detail, request.capability);
      }
      return this.request(id);
    });
  }

  decide(id: string, raw: unknown, actor: string) {
    const choice = parse(decisionInput, raw);
    const decision = this.atomic(() => {
      const req = this.request(id),
        version = req.revisions.at(-1)!;
      if (req.revision !== choice.revision || !req.taskId || version.questionId !== choice.questionId)
        return conflict("这不是当前需求版本的审批");
      const next = statuses[choice.action];
      if (version.status !== "pending") {
        if (version.status === next && version.feedback === choice.note && version.actor === actor) return req;
        return conflict("这个版本已有决定");
      }
      this.zoom.reply(
        req.taskId,
        { questionId: choice.questionId, choice: choices[choice.action], body: choice.note || undefined },
        actor,
      );
      this.db
        .prepare(
          "UPDATE opc_capability_revisions SET status=?,feedback=?,actor=? WHERE request_id=? AND revision=?",
        )
        .run(next, choice.note, actor, id, choice.revision);
      if (choice.action === "approve") {
        const cap = this.capability(req.capabilityId);
        const folder = cap.product + "/" + cap.project;
        const repoKey = this.opportunities.projectInfo(cap.repo);
        const count = this.db
          .prepare("SELECT COUNT(*) AS n FROM company_project_repos WHERE product=? AND name=?")
          .get(cap.product, cap.project);
        const project =
          repoKey.workspace ||
          count?.n !== 1 ||
          folder.length > 256 ||
          !this.opportunities.projectInfo(folder).workspace
            ? cap.repo
            : folder;
        const item = this.opportunities.addFromRecord({
          project,
          kind: "feature",
          sourceId: "capability-gap/" + id + "/r" + req.revision,
          title: req.title,
          rationale: req.detail.slice(0, 1000),
          evidence: [
            "#capabilities?request=" + id,
            "维护仓库 " + cap.repo,
            (cap.name + " @ " + cap.version + " · " + cap.interfaceRef).slice(0, 360),
            cap.evidence.length <= 360 ? cap.evidence : "完整接口凭据见需求记录",
          ],
        });
        this.db.prepare("UPDATE opc_capability_requests SET opportunity_id=? WHERE id=?").run(item.id, id);
      }
      return this.request(id);
    });
    if (decision.status === "approved" && decision.opportunityId && !decision.runId) {
      try {
        this.opportunities.trySelectLinked(decision.opportunityId);
        this.db.prepare("DELETE FROM opc_capability_plan_problems WHERE request_id=?").run(id);
      } catch (error) {
        // The versioned decision and its original queue entry already committed. A retry uses the same entry.
        const problem =
          error instanceof ApiError ? error.message : "维护方计划暂未生成，原仓需求和研发候选已保留。";
        this.db
          .prepare(
            "INSERT INTO opc_capability_plan_problems VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET problem=excluded.problem",
          )
          .run(id, problem);
      }
      return this.request(id);
    }
    return decision;
  }

  task(taskId: string) {
    return this.db.prepare("SELECT id,revision FROM opc_capability_requests WHERE task_id=?").get(taskId) as
      { id: string; revision: number } | undefined;
  }

  reply(taskId: string, raw: unknown, actor: string): ZoomMessage {
    const input = parse(
      z.strictObject({
        questionId: z.uuid(),
        choice: z.enum(["批准", "要求修改", "拒绝"]),
        body: z.string().trim().max(3000).optional(),
      }),
      raw,
    );
    const task = this.task(taskId);
    if (!task) return notFound("找不到这项原仓需求");
    const action = input.choice === "批准" ? "approve" : input.choice === "要求修改" ? "changes" : "reject";
    this.decide(
      task.id,
      { revision: task.revision, questionId: input.questionId, action, note: input.body || "" },
      actor,
    );
    return this.zoom.thread(taskId).find((item) => item.replyTo === input.questionId)!;
  }
}

export function addCapabilityRoutes(
  app: Hono,
  db: DatabaseSync,
  opportunities: OpportunityStore,
  token: string | undefined,
  user: (c: Context) => { name: string },
) {
  const root = "/api/opc/capabilities",
    service = new RepoCapabilities(db, opportunities);
  const auth = submitAuth(token);
  const readOrSubmit = (c: Context) => {
    if (!auth.permits(c)) user(c);
    c.header("Cache-Control", "no-store");
  };
  app.get(root, (c) => {
    readOrSubmit(c);
    return c.json(service.index());
  });
  app.get(root + "/versions", (c) => {
    readOrSubmit(c);
    return c.json({ capabilities: service.versions() });
  });
  app.get(root + "/requests/:id", (c) => {
    readOrSubmit(c);
    return c.json(service.request(c.req.param("id")!));
  });
  app.post(root, async (c) => {
    readOrSubmit(c);
    return c.json(service.register(await c.req.json()));
  });
  app.post(root + "/requests", async (c) => {
    readOrSubmit(c);
    const raw: unknown = await c.req.json();
    const confirm = raw && typeof raw === "object" && "satisfiesRequestId" in raw;
    return c.json(service.create(raw, confirm ? user(c).name : undefined));
  });
  app.post(root + "/requests/:id/revisions", async (c) => {
    readOrSubmit(c);
    return c.json(service.revise(c.req.param("id")!, await c.req.json()));
  });
  app.post(root + "/requests/:id/adopt", async (c) => {
    readOrSubmit(c);
    return c.json(service.revise(c.req.param("id")!, await c.req.json(), "adopt"));
  });
  app.post(root + "/requests/:id/decisions", async (c) =>
    c.json(service.decide(c.req.param("id")!, await c.req.json(), user(c).name)),
  );
  return service;
}
