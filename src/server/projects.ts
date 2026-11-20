import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ProjectIndex, RepositorySnapshot, ZoomProject } from "../project-types.ts";
import { ApiError } from "./logic.ts";
import { initProjectMail, recordProjectMail } from "./project-mail.ts";
import { submitAuth } from "./workflow/http.ts";
import { zoomFolder } from "./zoom-folder.ts";
import { initCompany, linkImportedRepo } from "./company.ts";

const projectName = zoomFolder.refine(
  name => !name.includes("/") && name.length <= 160,
  "项目名称需要使用单一目录名，最多 160 个字符"
);
const createSchema = z.strictObject({ name: projectName });
const date = z.iso
  .datetime({ offset: true })
  .refine(value => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value), "时间需要带时区，精度到毫秒")
  .transform(value => new Date(value).toISOString());
const url = z.string().min(1).max(3000);
const count = z.number().int().nonnegative();
const repositorySchema = z.strictObject({
  fullName: z
    .string()
    .max(255)
    .regex(/^[a-z\d-]+\/[a-z\d._-]+$/i),
  url,
  visibility: z.literal("public"),
  owner: z.string().min(1).max(100),
  fork: z.boolean(),
  description: z.string().max(4000).optional(),
  openIssues: count,
  openPullRequests: count,
  latestRelease: z.strictObject({ tag: z.string().min(1).max(512), url, publishedAt: date }).nullable().default(null),
  syncedAt: date,
  items: z
    .array(
      z.strictObject({
        kind: z.enum(["issue", "pull"]),
        number: z.number().int().positive(),
        title: z.string().min(1).max(2000),
        url,
        updatedAt: date,
      })
    )
    .max(100),
});
const syncSchema = z.strictObject({ name: projectName, repository: repositorySchema });

function storedSnapshot(json: string): RepositorySnapshot {
  const repository = JSON.parse(json);
  return { ...repository, latestRelease: repository.latestRelease ?? null };
}

function invalid(message: string): never {
  throw new ApiError(400, "project_input", message);
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) invalid(result.error.issues.map(i => i.path.join(".") + " " + i.message).join(" / "));
  return result.data;
}

// Every clickable source must identify this public github.com repository and the asserted object.
function verifiedRepository(repository: RepositorySnapshot) {
  const [owner, slug] = repository.fullName.split("/");
  if (owner.toLowerCase() !== repository.owner.toLowerCase() || slug === "." || slug === "..") {
    invalid("仓库全名与所有者不一致");
  }
  const root = "https://github.com/" + repository.fullName;
  if (repository.url.toLowerCase() !== root.toLowerCase()) invalid("仓库链接与仓库全名不一致");
  const ids = new Set<number>();
  let issues = 0;
  for (const item of repository.items) {
    const path = (item.kind === "issue" ? "/issues/" : "/pull/") + item.number;
    if (item.url.toLowerCase() !== (root + path).toLowerCase()) invalid("维护记录的链接与仓库、类型或编号不一致");
    if (ids.has(item.number)) invalid("维护记录编号重复");
    ids.add(item.number);
    if (item.kind === "issue") issues++;
  }
  if (issues > repository.openIssues || repository.items.length - issues > repository.openPullRequests) {
    invalid("未关闭数量不能小于列出的未关闭记录数");
  }
  const release = repository.latestRelease;
  if (release) {
    const prefix = root + "/releases/tag/";
    if (!release.url.toLowerCase().startsWith(prefix.toLowerCase()) || /[?#\\]/.test(release.url)) {
      invalid("发布链接需要指向此仓库的 GitHub release");
    }
    let tag: string;
    try {
      tag = decodeURIComponent(release.url.slice(prefix.length));
    } catch {
      invalid("发布链接包含无效编码");
    }
    if (tag !== release.tag || tag.split("/").some(s => s === "." || s === ".." || !s)) {
      invalid("发布链接与版本标签不一致");
    }
  }
  repository.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
  return repository;
}

export class ProjectStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (name TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS project_repositories (
        full_name TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
        project TEXT NOT NULL REFERENCES projects(name), snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_repositories_by_project ON project_repositories(project);
    `);
    initProjectMail(db);
    initCompany(db);
  }

  names(): string[] {
    return this.db
      .prepare("SELECT name FROM projects ORDER BY name")
      .all()
      .map(row => String(row.name));
  }

  private repositories(name: string): RepositorySnapshot[] {
    return this.db
      .prepare("SELECT snapshot FROM project_repositories WHERE project=? ORDER BY full_name")
      .all(name)
      .map(row => storedSnapshot(String(row.snapshot)));
  }

  list(): ProjectIndex {
    // A single SELECT reads names and snapshots at the same SQLite revision.
    const projects = new Map<string, ZoomProject>();
    for (const row of this.db
      .prepare(
        `SELECT p.name,r.snapshot FROM projects p
      LEFT JOIN project_repositories r ON r.project=p.name ORDER BY p.name,r.full_name`
      )
      .all()) {
      const name = String(row.name);
      const project = projects.get(name) ?? { name, repositories: [] };
      if (!projects.has(name)) projects.set(name, project);
      if (row.snapshot !== null) project.repositories.push(storedSnapshot(String(row.snapshot)));
    }
    return { projects: [...projects.values()] };
  }

  create(input: unknown) {
    const { name } = parse(createSchema, input);
    const { changes } = this.db.prepare("INSERT INTO projects(name) VALUES(?) ON CONFLICT(name) DO NOTHING").run(name);
    return { project: { name, repositories: this.repositories(name) }, created: Boolean(changes) };
  }

  sync(input: unknown) {
    const row = parse(syncSchema, input);
    const name = row.name;
    const repository = verifiedRepository(row.repository);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT project,snapshot FROM project_repositories WHERE full_name=?")
        .get(repository.fullName);
      if (existing && existing.project !== name) {
        throw new ApiError(409, "project_owner", "该仓库已经归属产品 " + existing.project);
      }
      const previous = existing ? storedSnapshot(String(existing.snapshot)) : undefined;
      const changed = !previous || !isDeepStrictEqual({ ...previous, syncedAt: repository.syncedAt }, repository);
      if (previous && previous.syncedAt === repository.syncedAt && changed) {
        throw new ApiError(409, "project_snapshot", "同一同步时间对应的仓库快照内容不一致");
      }
      const newer = !previous || previous.syncedAt < repository.syncedAt;
      if (newer) {
        this.db.prepare("INSERT INTO projects(name) VALUES(?) ON CONFLICT(name) DO NOTHING").run(name);
        this.db
          .prepare(
            `INSERT INTO project_repositories(full_name,project,snapshot) VALUES(?,?,?)
          ON CONFLICT(full_name) DO UPDATE SET snapshot=excluded.snapshot`
          )
          .run(repository.fullName, name, JSON.stringify(repository));
        if (!previous) linkImportedRepo(this.db, name, repository.fullName);
        if (changed) recordProjectMail(this.db, name, repository);
      }
      const result = { project: { name, repositories: this.repositories(name) }, changed: newer && changed };
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function addProjectRoutes(
  app: Hono,
  db: DatabaseSync,
  token: string | undefined,
  user: (c: Context) => unknown
) {
  const projects = new ProjectStore(db);
  const { permits, requireSubmit } = submitAuth(token);
  app.get("/api/zoom/projects", c => {
    if (!permits(c)) user(c);
    return c.json(projects.list());
  });
  app.post("/api/zoom/projects", async c => {
    if (!permits(c)) user(c);
    return c.json(projects.create(await c.req.json()));
  });
  app.post("/api/zoom/projects/sync", async c => {
    requireSubmit(c);
    return c.json(projects.sync(await c.req.json()));
  });
  return projects;
}
