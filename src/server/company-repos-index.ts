import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { IndexedRepo, IndexSource, RepoIndex } from "../activity-index-types.ts";

const execute = promisify(execFile);
export const REPO_INDEX_INTERVAL_MS = 15 * 60 * 1000;
const localScript = fileURLToPath(new URL("../../scripts/company-repos-index.py", import.meta.url));
const ghRepoName = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
export function isGitHubRepoName(name: string) {
  return ghRepoName.test(name) && ![".", ".."].includes(name.split("/")[1]!);
}
type LocalResult = { rows: { fullName: string; paths: string[] }[]; roots: string[]; notes: string[] };
type WorkspaceResult = LocalResult & { workspaceRoots: Record<string, string> };
type GithubResult = { login: string; rows: IndexedRepo[] };
type Snapshot<T> = { at: string; value: T };
type InventoryReaders = {
  identity: () => Promise<string>;
  local: () => Promise<LocalResult>;
  github: () => Promise<GithubResult>;
  now: () => number;
};

async function accountKey() {
  // The offline key identifies the active gh context. A supplied token takes precedence over gh config.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) return "env-" + createHash("sha256").update(token).digest("hex");
  try {
    const { stdout } = await execute("gh", ["config", "get", "user", "--host", "github.com"], { timeout: 2500 });
    return stdout.trim() ? "github.com/" + stdout.trim().toLowerCase() : "";
  } catch {
    return "";
  }
}
function emptyRepo(fullName: string): IndexedRepo {
  return {
    fullName,
    url: isGitHubRepoName(fullName) ? "https://github.com/" + fullName : "",
    description: "",
    visibility: "unknown",
    relations: [],
    paths: [],
    language: null,
    pushedAt: null,
    defaultBranch: null,
    managed: [],
  };
}
type GhNode = {
  nameWithOwner: string;
  url: string;
  visibility: string;
  description: string | null;
  pushedAt: string | null;
  defaultBranchRef: { name: string } | null;
  primaryLanguage: { name: string } | null;
};
type GhPage = {
  data?: { viewer?: { login: string; repos: { nodes: GhNode[]; pageInfo: { hasNextPage: boolean } } } };
  errors?: unknown[];
};
const ghSources = [
  ["我的", "repositories", "ownerAffiliations:[OWNER]"],
  ["协作", "repositories", "ownerAffiliations:[COLLABORATOR]"],
  ["组织", "repositories", "ownerAffiliations:[ORGANIZATION_MEMBER]"],
  ["近期贡献", "repositoriesContributedTo", "includeUserRepositories:false"],
] as const;
async function github() {
  const pages = await Promise.all(
    ghSources.map(async ([relation, connection, filter]) => {
      const query = `query($endCursor:String){viewer{login repos:${connection}(first:100,after:$endCursor,${filter}){
      pageInfo{hasNextPage endCursor} nodes{nameWithOwner url visibility description pushedAt defaultBranchRef{name} primaryLanguage{name}}}}}`;
      const { stdout } = await execute(
        "gh",
        ["api", "--hostname", "github.com", "graphql", "--paginate", "--slurp", "-f", "query=" + query],
        { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      );
      const result: GhPage[] = JSON.parse(stdout);
      if (
        !Array.isArray(result) ||
        !result.length ||
        result.at(-1)?.data?.viewer?.repos.pageInfo.hasNextPage !== false
      )
        throw new Error("incomplete GitHub pagination");
      return result.map((page) => {
        const v = page.data?.viewer;
        if (page.errors?.length || !v?.login || !Array.isArray(v.repos.nodes))
          throw new Error("incomplete GitHub result");
        return { login: v.login, relation, nodes: v.repos.nodes };
      });
    }),
  );
  const all = pages.flat();
  const login = all[0]!.login;
  const records = new Map<string, IndexedRepo>();
  for (const page of all) {
    if (page.login !== login) throw new Error("GitHub account changed");
    for (const repo of page.nodes) {
      if (
        !repo ||
        !isGitHubRepoName(repo.nameWithOwner) ||
        repo.url.toLowerCase() !== ("https://github.com/" + repo.nameWithOwner).toLowerCase() ||
        !["PUBLIC", "PRIVATE", "INTERNAL"].includes(repo.visibility)
      )
        throw new Error("invalid GitHub repository");
      if (page.relation === "近期贡献" && repo.visibility !== "PUBLIC") continue;
      const key = repo.nameWithOwner.toLowerCase();
      const saved = records.get(key) ?? {
        ...emptyRepo(repo.nameWithOwner),
        description: repo.description ?? "",
        visibility: repo.visibility.toLowerCase() as IndexedRepo["visibility"],
        language: repo.primaryLanguage?.name ?? null,
        pushedAt: repo.pushedAt,
        defaultBranch: repo.defaultBranchRef?.name ?? null,
      };
      if (!saved.relations.includes(page.relation)) saved.relations.push(page.relation);
      records.set(key, saved);
    }
  }
  return { login, rows: [...records.values()] };
}

async function local(workspaces?: string[]): Promise<WorkspaceResult> {
  if (workspaces?.length === 0) return { rows: [], roots: [], notes: [], workspaceRoots: {} };
  const args = ["-IB", localScript, ...(workspaces ? ["--workspaces"] : [])];
  const result = execute("python3", args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (workspaces) result.child.stdin?.end(JSON.stringify(workspaces));
  const parsed: WorkspaceResult = JSON.parse((await result).stdout);
  if (
    !Array.isArray(parsed.rows) ||
    !Array.isArray(parsed.roots) ||
    !Array.isArray(parsed.notes) ||
    !parsed.workspaceRoots ||
    typeof parsed.workspaceRoots !== "object"
  )
    throw new Error("invalid local catalog");
  return parsed;
}

export async function readWorkspaceCheckouts(workspaces: string[]) {
  const now = new Date().toISOString();
  try {
    const { rows, notes, workspaceRoots } = await local(workspaces);
    const count = Object.keys(workspaceRoots).length;
    const source: IndexSource = {
      name: "会话工作目录",
      status: notes.length ? "partial" : "ok",
      asOf: now,
      detail:
        `每 15 秒根据本机 Herdr 和 CLI 的工作目录补充检出，本次 ${count} 个目录可关联 Git。` + notes.join("。"),
    };
    return { rows, workspaceRoots, source };
  } catch {
    const source: IndexSource = {
      name: "会话工作目录",
      status: "unavailable",
      asOf: null,
      detail: "暂时无法从当前会话目录核对 Git 检出。",
    };
    return { rows: [], workspaceRoots: {}, source };
  }
}

export function addLocalCheckouts(repositories: IndexedRepo[], checkouts: LocalResult["rows"]) {
  const byName = new Map(repositories.map((row) => [row.url ? row.fullName.toLowerCase() : row.fullName, row]));
  for (const entry of checkouts) {
    const key = isAbsolute(entry.fullName) ? entry.fullName : entry.fullName.toLowerCase();
    const repo = byName.get(key) ?? emptyRepo(entry.fullName);
    byName.set(key, {
      ...repo,
      paths: [...new Set([...repo.paths, ...entry.paths.filter((path) => isAbsolute(path))])],
      relations: [...new Set([...repo.relations, "本地检出"])],
    });
  }
  return [...byName.values()];
}
function managedRows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT c.product,c.name AS project,c.repo,r.snapshot FROM company_project_repos c
    JOIN project_repositories r ON r.full_name=c.repo COLLATE NOCASE ORDER BY c.repo,c.product,c.name`,
    )
    .all() as { product: string; project: string; repo: string; snapshot: string }[];
}
function combine(db: DatabaseSync, result: RepoIndex): RepoIndex {
  const byKey = new Map(
    result.repositories.map((row) => [
      row.url ? row.fullName.toLowerCase() : row.fullName,
      { ...row, managed: [...row.managed], relations: [...row.relations] },
    ]),
  );
  for (const ref of managedRows(db)) {
    const key = ref.repo.toLowerCase(),
      row = byKey.get(key) ?? emptyRepo(ref.repo);
    if (!byKey.has(key) || row.visibility === "unknown") {
      const stored = JSON.parse(ref.snapshot);
      row.description ||= stored.description ?? "";
      if (stored.visibility === "public") row.visibility = "public";
    }
    row.managed.push({ product: ref.product, project: ref.project });
    if (!row.relations.includes("已纳管")) row.relations.push("已纳管");
    byKey.set(key, row);
  }
  const repositories = [...byKey.values()].sort(
    (a, b) =>
      Number(b.managed.length > 0) - Number(a.managed.length > 0) ||
      Number(b.relations.includes("我的")) - Number(a.relations.includes("我的")) ||
      (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") ||
      a.fullName.localeCompare(b.fullName),
  );
  return { repositories, sources: result.sources };
}
export function createRepoIndex(
  db: DatabaseSync,
  readers: InventoryReaders = { identity: accountKey, local, github, now: Date.now },
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS opc_repo_inventory_snapshots (source TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL)",
  );
  function read<T>(key: string): Snapshot<T> | undefined {
    const cached = db.prepare("SELECT at,payload FROM opc_repo_inventory_snapshots WHERE source=?").get(key);
    if (!cached) return;
    try {
      return { at: String(cached.at), value: JSON.parse(String(cached.payload)) };
    } catch {
      return;
    }
  }
  function write(key: string, at: string, value: unknown) {
    db.prepare(
      `INSERT INTO opc_repo_inventory_snapshots VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET at=excluded.at,payload=excluded.payload`,
    ).run(key, at, JSON.stringify(value));
  }
  let memory: { key: string; at: number; data: RepoIndex } | undefined;
  let inFlight: { key: string; promise: Promise<RepoIndex> } | undefined;

  async function collect(key: string): Promise<RepoIndex> {
    const sources: IndexSource[] = [];
    const now = new Date(readers.now()).toISOString();
    const [remote, checkouts] = await Promise.allSettled([readers.github(), readers.local()]);
    const cacheKey = "github:" + key;
    let ghRows: IndexedRepo[] = [];
    if (
      remote.status === "fulfilled" &&
      (!key.startsWith("github.com/") || key.slice(11) === remote.value.login.toLowerCase())
    ) {
      const { login, rows } = remote.value;
      ghRows = rows;
      if (key) write(cacheKey, now, { login, rows: rows.filter((r) => r.visibility === "public") });
      sources.push({
        name: "GitHub",
        status: "ok",
        asOf: now,
        detail:
          login +
          " · 自有、协作、组织及 GitHub 列出的近期公开贡献，共 " +
          rows.length +
          " 个仓库；每 15 分钟更新。",
      });
    } else {
      const old = key ? read<GithubResult>(cacheKey) : undefined;
      ghRows = old?.value.rows ?? [];
      sources.push({
        name: "GitHub",
        status: old ? "partial" : "unavailable",
        asOf: old?.at ?? null,
        detail: old
          ? "本次未能完整核对 GitHub。保留此账号上次的公开索引；私有与内部仓库待重新验证。"
          : "未能完整读取当前账号的 GitHub 仓库。请核对本机 gh 登录或网络。",
      });
    }
    const snapshot =
      checkouts.status === "fulfilled" ? { at: now, value: checkouts.value } : read<LocalResult>("local");
    if (checkouts.status === "fulfilled") write("local", now, checkouts.value);
    const repositories = addLocalCheckouts(ghRows, snapshot?.value.rows ?? []);
    const info = snapshot?.value;
    sources.push({
      name: "本地 Git",
      status:
        checkouts.status === "rejected"
          ? snapshot
            ? "partial"
            : "unavailable"
          : info?.notes.length
            ? "partial"
            : "ok",
      asOf: snapshot?.at ?? null,
      detail: [
        checkouts.status === "rejected" ? "本次扫描失败。" : "",
        info
          ? "扫描 " + info.roots.join("、") + "（四层），补入 Agent Hub 已知工作目录和 Git 登记的现存 worktree。"
          : "请检查本机 Git、Python 和仓库目录。",
        ...(info?.notes ?? []),
      ]
        .filter(Boolean)
        .join(" "),
    });
    return { repositories, sources };
  }
  return async (force = false): Promise<RepoIndex> => {
    const key = await readers.identity();
    if (inFlight?.key === key) return combine(db, await inFlight.promise);
    if (
      !force &&
      memory?.key === key &&
      (key || memory.data.sources[0]?.status !== "ok") &&
      readers.now() - memory.at < REPO_INDEX_INTERVAL_MS
    )
      return combine(db, memory.data);
    const entry = { key, promise: collect(key) };
    inFlight = entry;
    try {
      const data = await entry.promise;
      if (inFlight === entry) memory = { key, at: readers.now(), data };
      return combine(db, data);
    } finally {
      if (inFlight === entry) inFlight = undefined;
    }
  };
}
