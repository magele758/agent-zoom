import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  BusinessLine,
  BusinessPortfolio,
  BusinessTrial,
  LineSpec,
  TrialEvidence,
} from "../business-types.ts";
import { ApiError } from "./logic.ts";
import type { OpportunityStore } from "./autonomy.ts";
import { ZoomStore } from "./zoom.ts";
import { opportunityProjectName } from "./zoom-folder.ts";
import { submitAuth } from "./workflow/http.ts";

const short = z.string().trim().min(1).max(120);
const paragraph = z.string().trim().min(1).max(2000);
const lineSpec = z.strictObject({
  name: short.refine(
    (name) => !/[\\/\u0000-\u001f]/.test(name) && name !== "." && name !== "..",
    "名称不能包含路径分隔符",
  ),
  goal: paragraph,
  mode: z.enum(["development", "experiment"]),
  steps: z.array(short).min(1).max(16),
  assets: z
    .array(
      z.strictObject({
        kind: z.enum(["product", "project", "plugin", "method"]),
        name: short,
        reference: z.string().trim().max(1000),
      }),
    )
    .max(40),
});
const trialInput = z.strictObject({
  requestId: short,
  title: short,
  hypothesis: paragraph,
  metric: paragraph,
  scope: paragraph,
});
const evidenceBase = { eventId: short, note: paragraph, reference: paragraph };
const money = {
  currency: z.string().regex(/^[A-Z]{3}$/),
  minor: z.number().int().positive().max(1_000_000_000_000),
};
const evidenceInput = z.discriminatedUnion("kind", [
  z.strictObject({ ...evidenceBase, kind: z.literal("observation") }),
  z.strictObject({ ...evidenceBase, ...money, kind: z.enum(["receipt", "refund", "expense"]) }),
]);
const initial: Record<string, LineSpec> = {
  development: {
    name: "技术研发",
    mode: "development",
    goal: "从维护问题和新特性中选出值得交付的工作，追踪发布后的采用。",
    steps: ["收集线索", "选择特性", "审批计划", "开发与评审", "验证采用"],
    assets: [],
  },
  shop: {
    name: "店铺运营",
    mode: "experiment",
    goal: "在小范围内验证 Chrome 插件能为哪一步店铺工作节省时间或带来收入。",
    steps: ["提出假设", "限定试验范围", "记录观察", "决定下一轮"],
    assets: [],
  },
};
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      "business_input",
      parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join(" / "),
    );
  return parsed.data;
}
function conflict(message: string): never {
  throw new ApiError(409, "business_conflict", message);
}

export class BusinessStore {
  private zoom: ZoomStore;
  constructor(
    private db: DatabaseSync,
    private opportunities: OpportunityStore,
  ) {
    this.zoom = new ZoomStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS opc_lines (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,spec TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opc_trials(id TEXT PRIMARY KEY,line_id TEXT NOT NULL REFERENCES opc_lines(id),request_id TEXT NOT NULL,
        input TEXT NOT NULL,recipe TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES zoom_tasks(id),created_at TEXT NOT NULL,question_id TEXT,
        UNIQUE(line_id,request_id));
      CREATE TABLE IF NOT EXISTS opc_evidence(id TEXT PRIMARY KEY,trial_id TEXT NOT NULL REFERENCES opc_trials(id),
        event_id TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,input TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(trial_id,event_id));
      CREATE TABLE IF NOT EXISTS opc_trial_referrals(trial_id TEXT NOT NULL REFERENCES opc_trials(id),opportunity_id TEXT PRIMARY KEY REFERENCES opc_opportunities(id));
      CREATE UNIQUE INDEX IF NOT EXISTS opc_money_source ON opc_evidence(kind,reference) WHERE kind!='observation';`);
    for (const [id, spec] of Object.entries(initial)) {
      db.prepare("INSERT OR IGNORE INTO opc_lines VALUES(?,?,1,?)").run(id, spec.name, JSON.stringify(spec));
    }
  }
  private atomic<T>(fn: () => T): T {
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
  private line(id: string): BusinessLine {
    const row = this.db.prepare("SELECT * FROM opc_lines WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "business_line", "找不到这条业务线");
    return { ...JSON.parse(String(row.spec)), id, revision: Number(row.revision) };
  }
  private trial(id: string): BusinessTrial {
    const row = this.db.prepare("SELECT * FROM opc_trials WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "business_trial", "找不到这次实验");
    const evidence = this.db
      .prepare("SELECT * FROM opc_evidence WHERE trial_id=? ORDER BY rowid")
      .all(id)
      .map(
        (e) => ({ ...JSON.parse(String(e.input)), id: String(e.id), at: String(e.created_at) }) as TrialEvidence,
      );
    const reply =
      row.question_id &&
      this.db.prepare("SELECT body,choice FROM zoom_messages WHERE reply_to=?").get(row.question_id);
    return {
      ...JSON.parse(String(row.input)),
      id,
      lineId: String(row.line_id),
      recipe: JSON.parse(String(row.recipe)),
      taskId: String(row.task_id),
      referrals: this.db
        .prepare(
          `SELECT o.id AS opportunityId,o.project,o.title,o.run_id AS runId
        FROM opc_trial_referrals b JOIN opc_opportunities o ON o.id=b.opportunity_id WHERE b.trial_id=? ORDER BY o.created_at`,
        )
        .all(id) as BusinessTrial["referrals"],
      createdAt: String(row.created_at),
      evidence,
      ...(row.question_id && { questionId: String(row.question_id) }),
      ...(reply && { decision: String(reply.choice || reply.body) }),
    };
  }
  lines(): BusinessLine[] {
    return this.db
      .prepare("SELECT id,revision,spec FROM opc_lines ORDER BY rowid")
      .all()
      .map((row) => ({ ...JSON.parse(String(row.spec)), id: String(row.id), revision: Number(row.revision) }));
  }
  catalog() {
    const stats = this.db
      .prepare(
        `SELECT t.line_id, count(*) AS trials,
      sum(CASE WHEN t.question_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM zoom_messages m WHERE m.reply_to=t.question_id)
          THEN 1 ELSE 0 END) AS pendingReviews
      FROM opc_trials t GROUP BY t.line_id`,
      )
      .all();
    const payments = this.db
      .prepare(
        `SELECT t.line_id, count(*) AS payments FROM opc_evidence e JOIN opc_trials t ON e.trial_id=t.id
      WHERE e.kind IN ('receipt','expense','refund') GROUP BY t.line_id`,
      )
      .all();
    const counts = new Map(stats.map((row) => [row.line_id, row]));
    const transactions = new Map(payments.map((row) => [row.line_id, Number(row.payments)]));
    return this.lines().map((line) => {
      const row = counts.get(line.id);
      return {
        ...line,
        trials: Number(row?.trials ?? 0),
        pendingReviews: Number(row?.pendingReviews ?? 0),
        transactions: transactions.get(line.id) ?? 0,
      };
    });
  }
  index(): BusinessPortfolio {
    return {
      lines: this.lines(),
      trials: this.db
        .prepare("SELECT id FROM opc_trials ORDER BY rowid DESC")
        .all()
        .map((r) => this.trial(String(r.id))),
    };
  }
  create(input: unknown) {
    const spec = parse(lineSpec, input);
    return this.atomic(() => {
      const previous = this.db.prepare("SELECT id,spec FROM opc_lines WHERE name=?").get(spec.name);
      if (previous) {
        if (previous.spec !== JSON.stringify(spec)) conflict("这条业务线已存在，请在原业务线修改");
        return this.line(String(previous.id));
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO opc_lines VALUES(?,?,1,?)").run(id, spec.name, JSON.stringify(spec));
      return this.line(id);
    });
  }
  update(id: string, input: unknown) {
    const { revision, ...spec } = parse(lineSpec.extend({ revision: z.int().positive() }), input);
    return this.atomic(() => {
      const current = this.line(id);
      if (current.revision !== revision) conflict("业务线已更新，请刷新后继续");
      if (this.db.prepare("SELECT id FROM opc_lines WHERE name=? AND id!=?").get(spec.name, id))
        conflict("已有同名业务线");
      this.db
        .prepare("UPDATE opc_lines SET spec=?,name=?,revision=revision+1 WHERE id=?")
        .run(JSON.stringify(spec), spec.name, id);
      return this.line(id);
    });
  }
  start(lineId: string, input: unknown) {
    const data = parse(trialInput, input);
    return this.atomic(() => {
      const previous = this.db
        .prepare("SELECT id,input FROM opc_trials WHERE line_id=? AND request_id=?")
        .get(lineId, data.requestId);
      if (previous) {
        if (previous.input !== JSON.stringify(data)) conflict("同一实验标识已绑定其他内容");
        return this.trial(String(previous.id));
      }
      const line = this.line(lineId),
        id = randomUUID();
      const task = this.zoom.register({
        source: "OPC OS · 经营实验",
        externalId: id,
        folder: line.name,
        title: data.title,
        context: `假设：${data.hypothesis}\n验证指标：${data.metric}\n授权范围：${data.scope}`.slice(0, 4000),
      });
      this.db
        .prepare(
          "INSERT INTO opc_trials(id,line_id,request_id,input,recipe,task_id,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          lineId,
          data.requestId,
          JSON.stringify(data),
          JSON.stringify(line),
          task.id,
          new Date().toISOString(),
        );
      return this.trial(id);
    });
  }
  record(id: string, input: unknown) {
    const data = parse(evidenceInput, input),
      payload = JSON.stringify(data);
    return this.atomic(() => {
      const trial = this.trial(id);
      const prior = this.db
        .prepare("SELECT input FROM opc_evidence WHERE trial_id=? AND event_id=?")
        .get(id, data.eventId);
      if (prior) {
        if (prior.input !== payload) conflict("原回执标识已登记不同内容");
        return trial;
      }
      if (trial.questionId) conflict("本轮证据已提交复盘，请在下一轮登记新的观察");
      if (
        data.kind !== "observation" &&
        this.db.prepare("SELECT id FROM opc_evidence WHERE kind=? AND reference=?").get(data.kind, data.reference)
      )
        conflict("这笔交易凭据已经归属其他记录，请核对原凭据");
      this.db
        .prepare("INSERT INTO opc_evidence VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), id, data.eventId, data.kind, data.reference, payload, new Date().toISOString());
      this.zoom.report(trial.taskId, {
        eventId: "evidence/" + data.eventId,
        kind: "progress",
        body: data.note,
        evidence: [data.reference],
      });
      return this.trial(id);
    });
  }
  refer(id: string, input: unknown) {
    const choice = parse(
      z.strictObject({ project: opportunityProjectName, evidenceId: z.uuid(), title: short }),
      input,
    );
    return this.atomic(() => {
      const trial = this.trial(id);
      const evidence = trial.evidence.find((item) => item.id === choice.evidenceId);
      if (!evidence) conflict("请选择这个实验已经登记的凭据");
      const sourceId = `business:${id}:${evidence.id}`;
      const prior = this.db
        .prepare(
          `SELECT o.id FROM opc_trial_referrals b JOIN opc_opportunities o ON o.id=b.opportunity_id
        WHERE b.trial_id=? AND o.project=? AND o.source_id=?`,
        )
        .get(id, choice.project, sourceId);
      if (prior) return trial;
      const reference =
        evidence.reference.length <= 360 ? evidence.reference : `凭据 ${evidence.id}，完整出处见原实验`;
      const item = this.opportunities.addFromRecord({
        project: choice.project,
        kind: "feature",
        sourceId,
        title: choice.title,
        rationale: evidence.note.slice(0, 1000),
        evidence: [reference, `#business-lines?line=${trial.lineId}&trial=${id}`],
      });
      this.db.prepare("INSERT OR IGNORE INTO opc_trial_referrals VALUES(?,?)").run(id, item.id);
      return this.trial(id);
    });
  }
  review(id: string) {
    return this.atomic(() => {
      const trial = this.trial(id);
      if (trial.questionId) return trial;
      if (!trial.evidence.length) conflict("请先登记一项可核对的观察或经营凭据");
      const last = trial.evidence.at(-1)!;
      const q = this.zoom.report(trial.taskId, {
        eventId: "review/" + id,
        kind: "question",
        body: `是否继续「${trial.title}」？\n原指标：${trial.metric}\n最近观察：${last.note}`,
        choices: ["继续", "调整", "暂停"],
        evidence: trial.evidence.slice(-10).map((e) => e.reference),
      });
      this.db.prepare("UPDATE opc_trials SET question_id=? WHERE id=?").run(q.id, id);
      return this.trial(id);
    });
  }
}
export function addBusinessRoutes(
  app: Hono,
  db: DatabaseSync,
  token: string | undefined,
  user: (c: Context) => unknown,
  opportunities: OpportunityStore,
) {
  const service = new BusinessStore(db, opportunities),
    root = "/api/opc/business";
  const auth = submitAuth(token);
  app.use(root + "/*", async (c, next) => {
    if (!auth.permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(root + "/catalog", (c) => c.json({ lines: service.catalog() }));
  app.get(root + "/lines", (c) => c.json(service.index()));
  app.post(root + "/lines", async (c) => c.json(service.create(await c.req.json())));
  app.put(root + "/lines/:line", async (c) => c.json(service.update(c.req.param("line")!, await c.req.json())));
  app.post(root + "/lines/:line/trials", async (c) =>
    c.json(service.start(c.req.param("line")!, await c.req.json())),
  );
  app.post(root + "/trials/:id/evidence", async (c) =>
    c.json(service.record(c.req.param("id")!, await c.req.json())),
  );
  app.post(root + "/trials/:id/development", async (c) =>
    c.json(service.refer(c.req.param("id")!, await c.req.json())),
  );
  app.post(root + "/trials/:id/review", (c) => c.json(service.review(c.req.param("id")!)));
}
