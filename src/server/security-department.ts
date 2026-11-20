import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { securityStatus, type SecurityDepartmentIndex, type SecurityReview } from "../security-department-types.ts";
import { ApiError } from "./logic.ts";

const projectName = z.string().trim().min(1).max(160);
const registration = z.strictObject({
  id: z.uuid(),
  product: projectName,
  project: projectName,
  scope: z.string().trim().min(1).max(2000),
});
const decision = z.strictObject({
  revision: z.int().nonnegative(),
  outcome: z.enum(["changes", "recheck", "passed"]),
  note: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().max(2000).default(""),
});

type ReviewRow = Omit<SecurityReview, "history"> & { history: string };
function readReview(row: ReviewRow): SecurityReview {
  return { ...row, history: JSON.parse(row.history) };
}
const fields = "id, product, project, scope, created_at AS createdAt, history";
const conflict = () => new ApiError(409, "security_revision", "此审查已有新记录，请刷新后核对结论。");

export class SecurityReviews {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_security_reviews (
      id TEXT PRIMARY KEY, product TEXT NOT NULL, project TEXT NOT NULL, scope TEXT NOT NULL,
      created_at TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY(product, project) REFERENCES company_projects(product, name)
    )`);
  }

  private get(id: string) {
    const row = this.db.prepare("SELECT " + fields + " FROM opc_security_reviews WHERE id=?").get(id) as ReviewRow | undefined;
    if (!row) throw new ApiError(404, "security_review_missing", "找不到这项安全审查。");
    return readReview(row);
  }

  index(): SecurityDepartmentIndex {
    const rows = this.db.prepare("SELECT " + fields + " FROM opc_security_reviews ORDER BY created_at DESC, rowid DESC").all() as ReviewRow[];
    const projects = this.db.prepare("SELECT product, name AS project FROM company_projects ORDER BY product, name").all();
    return { projects: projects.map(row => ({ product: String(row.product), project: String(row.project) })), reviews: rows.map(readReview) };
  }

  create(input: unknown) {
    const parsed = registration.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "security_review_input", "请选择项目并填写本次审查范围。");
    const { id, product, project, scope } = parsed.data;
    if (!this.db.prepare("SELECT 1 FROM company_projects WHERE product=? AND name=?").get(product, project)) {
      throw new ApiError(404, "security_project_missing", "请先在项目目录登记这个项目。");
    }
    this.db.prepare(`INSERT INTO opc_security_reviews(id,product,project,scope,created_at)
      VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id, product, project, scope, new Date().toISOString());
    const saved = this.get(id);
    if (saved.product !== product || saved.project !== project || saved.scope !== scope) {
      throw new ApiError(409, "security_review_conflict", "该审查编号已登记其他内容。");
    }
    return saved;
  }

  decide(id: string, input: unknown): SecurityReview {
    const parsed = decision.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "security_decision_input", "请选择审查结论并填写具体说明。");
    const { revision, outcome, note, evidence } = parsed.data;
    const current = this.get(id);
    const previous = current.history[revision];
    if (previous?.outcome === outcome && previous.note === note && previous.evidence === evidence) return current;
    if (current.history.length !== revision) throw conflict();
    const status = securityStatus(current);
    const allowed = status === "changes" ? outcome === "recheck" : status !== "passed" && outcome !== "recheck";
    if (!allowed) {
      throw new ApiError(409, "security_review_transition", "当前状态无法提交这项操作，请核对审查进展。");
    }
    const history = [...current.history, { outcome, note, evidence, recordedAt: new Date().toISOString() }];
    const result = this.db.prepare("UPDATE opc_security_reviews SET history=? WHERE id=? AND json_array_length(history)=?")
      .run(JSON.stringify(history), id, revision);
    if (result.changes !== 1) throw conflict();
    return { ...current, history };
  }
}

export function registerSecurityDepartmentRoutes(app: Hono, db: DatabaseSync, user: (c: Context) => unknown) {
  const reviews = new SecurityReviews(db);
  const path = "/api/opc/departments/security";
  app.use(path + "/*", async (c, next) => {
    user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(path, c => c.json(reviews.index()));
  app.post(path + "/reviews", async c => c.json(reviews.create(await c.req.json())));
  app.post(`${path}/reviews/:id/decisions`, async c => c.json(reviews.decide(c.req.param("id"), await c.req.json())));
}
