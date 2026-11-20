import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ProjectProfile } from "../project-profile-types.ts";
import { ApiError } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";

const name = z.string().trim().min(1).max(160);
const ref = z.strictObject({ product: name, project: name });
const edit = ref.extend({
  layer: z.string().trim().max(100),
  domain: z.string().trim().max(100),
  revision: z.int().nonnegative(),
  uses: z
    .array(
      ref.extend({ reference: z.string().trim().min(1).max(1200), purpose: z.string().trim().min(1).max(1000) }),
    )
    .max(64),
});
const rows = `SELECT p.product,p.name AS project,COALESCE(s.layer,'') AS layer,COALESCE(s.domain,'') AS domain,
  COALESCE(s.revision,0) AS revision,COALESCE(s.uses_json,'[]') AS uses_json FROM company_projects p
  LEFT JOIN opc_project_profiles s ON s.product=p.product AND s.project=p.name`;

export class ProjectProfiles {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_project_profiles (product TEXT NOT NULL,project TEXT NOT NULL,
      layer TEXT NOT NULL,domain TEXT NOT NULL,revision INTEGER NOT NULL,uses_json TEXT NOT NULL,
      PRIMARY KEY(product,project),FOREIGN KEY(product,project) REFERENCES company_projects(product,name))`);
  }
  all(): ProjectProfile[] {
    return this.db
      .prepare(rows + " ORDER BY p.product,p.name")
      .all()
      .map((row) => ({
        product: String(row.product),
        project: String(row.project),
        layer: String(row.layer),
        domain: String(row.domain),
        revision: Number(row.revision),
        uses: JSON.parse(String(row.uses_json)),
      }));
  }
  save(input: unknown) {
    const parsed = edit.safeParse(input);
    if (!parsed.success)
      throw new ApiError(400, "project_profile_input", "请填写项目归属，为每项复用补充版本或凭据和用途");
    const { product, project, layer, domain, revision, uses } = parsed.data;
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(rows + " WHERE p.product=? AND p.name=?").get(product, project);
      if (!current) throw new ApiError(404, "project_missing", "请先登记该产品下的项目");
      const check = this.db.prepare("SELECT 1 FROM company_projects WHERE product=? AND name=?");
      for (const source of uses) {
        if (product === source.product && project === source.project)
          throw new ApiError(400, "project_self", "请选择提供成果的另一个项目");
        if (!check.get(source.product, source.project))
          throw new ApiError(409, "project_source", "所选来源项目已经变化，请核对目录");
      }
      const serialized = JSON.stringify(uses);
      if (current.domain !== domain || current.layer !== layer || current.uses_json !== serialized) {
        if (current.revision !== revision)
          throw new ApiError(409, "project_profile_revision", "项目档案已经更新，请重新读取");
        this.db
          .prepare(
            `INSERT INTO opc_project_profiles VALUES(?,?,?,?,?,?)
          ON CONFLICT(product,project) DO UPDATE SET layer=excluded.layer,domain=excluded.domain,revision=excluded.revision,uses_json=excluded.uses_json`,
          )
          .run(product, project, layer, domain, revision + 1, serialized);
      }
      if (ownTransaction) this.db.exec("COMMIT");
    } catch (e) {
      if (ownTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    return this.all().find((item) => item.product === product && item.project === project)!;
  }
}

export function addProjectProfileRoutes(
  app: Hono,
  db: DatabaseSync,
  token: string | undefined,
  user: (c: Context) => unknown,
) {
  const profiles = new ProjectProfiles(db),
    auth = submitAuth(token);
  const path = "/api/opc/projects/profiles";
  app.use(path, async (c, next) => {
    if (!auth.permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get(path, (c) => c.json({ profiles: profiles.all() }));
  app.put(path, async (c) => c.json(profiles.save(await c.req.json())));
}
