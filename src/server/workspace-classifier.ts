import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  WORKSPACE_CATEGORIES,
  WORKSPACE_CATEGORY_LABELS,
  type WorkOriginDetail,
  type WorkOriginTrack,
  type WorkspaceCategory,
  type WorkspaceClassification,
  type WorkspaceClassificationOverride,
} from "../workspace-classification-types.ts";
import { ApiError } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";

export interface CanonicalWorkspaceResult {
  rawWorkspace: string | null;
  canonicalWorkspace: string | null;
  repository: string | null;
  worktreeProjectHint: string | null;
  isWorktree: boolean;
  isHomeDir: boolean;
  isTempDir: boolean;
}

const GITHUB_REMOTE_RE = /(?:github\.com|gitlab\.com)[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\s|$)/i;
const PROBE_TEMP_DIR_RE =
  /(?:\/\.grok-hflow-probe(?:\/|$)|\/Downloads\/\.[^/]+(?:\/|$)|^\/(?:private\/)?tmp$|^\/(?:private\/)?var\/folders$)/i;
const RD_INFRA_PRODUCTS = new Set(["opc 分析与内核", "learn-agent", "研发基建"]);
const KNOWN_DIR_ALIASES: Record<string, { canonicalProject?: string; repoFullName?: string; category?: WorkspaceCategory; group?: string }> = {
  "agent-chatroom": { canonicalProject: "agent-chatroom", repoFullName: "magele758/agent-zoom", category: "company_product", group: "OPC OS" },
  "agent-zoom": { canonicalProject: "agent-chatroom", repoFullName: "magele758/agent-zoom", category: "company_product", group: "OPC OS" },
  "opc-os": { canonicalProject: "agent-chatroom", repoFullName: "magele758/agent-zoom", category: "company_product", group: "OPC OS" },
  "ppeng-agent-core": { canonicalProject: "ppeng-agent-core", repoFullName: "magele758/ppeng-agent-bot", category: "rd_infra", group: "OPC 分析与内核" },
  "ppeng-agent-bot": { canonicalProject: "ppeng-agent-core", repoFullName: "magele758/ppeng-agent-bot", category: "rd_infra", group: "OPC 分析与内核" },
  "chrome-plugin-interpret": { canonicalProject: "pagelens-interpret", repoFullName: "magele758/pagelens-interpret", category: "company_product", group: "PageLens" },
};

const gitCommonCache = new Map<string, { at: number; root: string | null; repo: string | null; isWorktree: boolean }>();
const GIT_CACHE_TTL_MS = 60_000;

export function clearWorkspaceGitCache(): void {
  gitCommonCache.clear();
}

function normPath(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\x00-\x1f]/.test(trimmed) || !isAbsolute(trimmed)) return null;
  const normalized = normalize(trimmed).replace(/\/+$/, "");
  return normalized || "/";
}

function isUnderPath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function readOriginRemoteFromGitDir(gitDir: string): string | null {
  try {
    const cfgPath = join(gitDir, "config");
    if (!existsSync(cfgPath)) return null;
    const text = readFileSync(cfgPath, "utf8");
    const originBlock = /\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/.exec(text);
    const body = originBlock ? originBlock[1] : text;
    const urlLine = /^\s*url\s*=\s*(.+)$/m.exec(body);
    if (!urlLine?.[1]) return null;
    const m = GITHUB_REMOTE_RE.exec(urlLine[1].trim());
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fast, zero-subprocess `.git` / `commondir` inspection for local directories & git worktrees.
 * Walks up at most 4 parent levels looking for `.git` (dir or worktree gitfile).
 */
function inspectGitRoot(dirPath: string): { root: string | null; repo: string | null; isWorktree: boolean } {
  const now = Date.now();
  const cached = gitCommonCache.get(dirPath);
  if (cached && now - cached.at < GIT_CACHE_TTL_MS) {
    return { root: cached.root, repo: cached.repo, isWorktree: cached.isWorktree };
  }
  const save = (res: { root: string | null; repo: string | null; isWorktree: boolean }) => {
    if (gitCommonCache.size > 600) gitCommonCache.clear();
    gitCommonCache.set(dirPath, { at: now, ...res });
    return res;
  };
  try {
    if (!existsSync(dirPath)) return save({ root: null, repo: null, isWorktree: false });
    let cur = dirPath;
    for (let depth = 0; depth < 5; depth++) {
      const marker = join(cur, ".git");
      if (existsSync(marker)) {
        const st = statSync(marker);
        if (st.isDirectory()) {
          return save({ root: cur, repo: readOriginRemoteFromGitDir(marker), isWorktree: false });
        }
        if (st.isFile()) {
          const line = readFileSync(marker, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
          if (line.startsWith("gitdir:")) {
            const gitDir = resolve(cur, line.slice(7).trim());
            const commonFile = join(gitDir, "commondir");
            let commonDir = gitDir;
            if (existsSync(commonFile)) {
              const relCommon = readFileSync(commonFile, "utf8").trim();
              if (relCommon) commonDir = resolve(gitDir, relCommon);
            }
            const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : cur;
            return save({
              root: normPath(mainRoot) ?? cur,
              repo: readOriginRemoteFromGitDir(commonDir),
              isWorktree: true,
            });
          }
        }
      }
      const parent = dirname(cur);
      if (parent === cur || parent === "/" || parent === homedir()) break;
      cur = parent;
    }
  } catch {
    // Ignore permission/transient filesystem errors
  }
  return save({ root: null, repo: null, isWorktree: false });
}

/**
 * Resolves any raw workspace path (including Herdr split-task worktrees, Dark Factory worktrees,
 * Workflow attempt worktrees, Codex worktrees, or home/temp directories) to its canonical main workspace.
 */
export function resolveCanonicalWorkspace(
  rawInput: string | null | undefined,
  options?: { homeDir?: string; skipFs?: boolean },
): CanonicalWorkspaceResult {
  const rawWorkspace = normPath(rawInput);
  const home = normPath(options?.homeDir ?? homedir()) ?? homedir();
  if (!rawWorkspace) {
    return {
      rawWorkspace: null,
      canonicalWorkspace: null,
      repository: null,
      worktreeProjectHint: null,
      isWorktree: false,
      isHomeDir: false,
      isTempDir: false,
    };
  }
  if (rawWorkspace === home || rawWorkspace === "/") {
    return {
      rawWorkspace,
      canonicalWorkspace: null,
      repository: null,
      worktreeProjectHint: null,
      isWorktree: false,
      isHomeDir: true,
      isTempDir: false,
    };
  }
  if (PROBE_TEMP_DIR_RE.test(rawWorkspace)) {
    return {
      rawWorkspace,
      canonicalWorkspace: null,
      repository: null,
      worktreeProjectHint: null,
      isWorktree: false,
      isHomeDir: false,
      isTempDir: true,
    };
  }

  // 1. Live `.git` / `commondir` check when directory still exists on disk
  if (!options?.skipFs) {
    const git = inspectGitRoot(rawWorkspace);
    if (git.root && git.root !== home && !PROBE_TEMP_DIR_RE.test(git.root)) {
      return {
        rawWorkspace,
        canonicalWorkspace: git.root,
        repository: git.repo,
        worktreeProjectHint: git.isWorktree ? basename(git.root) : null,
        isWorktree: git.isWorktree,
        isHomeDir: false,
        isTempDir: false,
      };
    }
  }

  // 2. Pattern-based fallback (especially important for cleaned/historical worktrees in CliLedger)
  const herdrSplit = /\/\.herdr\/split-tasks\/([^/]+)\/[^/]+\/[^/]+(?:\/.*)?$/i.exec(rawWorkspace);
  if (herdrSplit?.[1]) {
    return {
      rawWorkspace,
      canonicalWorkspace: null,
      repository: null,
      worktreeProjectHint: herdrSplit[1],
      isWorktree: true,
      isHomeDir: false,
      isTempDir: false,
    };
  }

  const factoryWt = /^(.*)\/data\/factory-worktrees\/[^/]+(?:\/.*)?$/i.exec(rawWorkspace);
  if (factoryWt?.[1]) {
    const parent = normPath(factoryWt[1]);
    return {
      rawWorkspace,
      canonicalWorkspace: parent,
      repository: null,
      worktreeProjectHint: parent ? basename(parent) : null,
      isWorktree: true,
      isHomeDir: false,
      isTempDir: false,
    };
  }

  const attemptWt = /^(.*)\/data\/zoom-local\/attempts\/[^/]+\/worktree(?:\/.*)?$/i.exec(rawWorkspace);
  if (attemptWt?.[1]) {
    const parent = normPath(attemptWt[1]);
    return {
      rawWorkspace,
      canonicalWorkspace: parent,
      repository: null,
      worktreeProjectHint: parent ? basename(parent) : null,
      isWorktree: true,
      isHomeDir: false,
      isTempDir: false,
    };
  }

  const codexWt = /\/\.codex\/worktrees\/[^/]+\/([^/]+)(?:\/.*)?$/i.exec(rawWorkspace);
  if (codexWt?.[1]) {
    return {
      rawWorkspace,
      canonicalWorkspace: null,
      repository: null,
      worktreeProjectHint: codexWt[1],
      isWorktree: true,
      isHomeDir: false,
      isTempDir: false,
    };
  }

  const genericWt = /^(.*)\/(?:data\/worktrees|\.worktrees|worktrees)\/[^/]+(?:\/.*)?$/i.exec(rawWorkspace);
  if (genericWt?.[1]) {
    const parent = normPath(genericWt[1]);
    return {
      rawWorkspace,
      canonicalWorkspace: parent,
      repository: null,
      worktreeProjectHint: parent ? basename(parent) : null,
      isWorktree: true,
      isHomeDir: false,
      isTempDir: false,
    };
  }

  return {
    rawWorkspace,
    canonicalWorkspace: rawWorkspace,
    repository: null,
    worktreeProjectHint: null,
    isWorktree: false,
    isHomeDir: false,
    isTempDir: false,
  };
}

/** Parse Herdr's `where` field like `"chrome-plugin-gemini / 1"` into `{ spaceName, tabName }`. */
export function parseHerdrWhere(where: string | null | undefined): { spaceName: string | null; tabName: string | null } {
  if (!where || typeof where !== "string") return { spaceName: null, tabName: null };
  const trimmed = where.trim();
  if (!trimmed) return { spaceName: null, tabName: null };
  const idx = trimmed.lastIndexOf(" / ");
  if (idx > 0) {
    const spaceName = trimmed.slice(0, idx).trim();
    const tabName = trimmed.slice(idx + 3).trim() || null;
    return {
      spaceName: spaceName && spaceName !== "~" ? spaceName : null,
      tabName,
    };
  }
  return { spaceName: trimmed !== "~" ? trimmed : null, tabName: null };
}

export interface OriginDetectionInput {
  labels?: Record<string, string> | null;
  rawWorkspace?: string | null;
  firstInstruction?: string | null;
  sourceRef?: string | null;
  latestRunId?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  hasHerdrAddress?: boolean;
}

export function detectWorkOrigin(input: OriginDetectionInput): {
  originTrack: WorkOriginTrack;
  originDetail: WorkOriginDetail;
} {
  const labels = input.labels ?? {};
  const meta = input.metadata ?? {};

  // 1. Explicit Herdr workflow labels
  if (labels["kunlun.run"] || labels["kunlun.attempt"]) {
    return {
      originTrack: "opc_dispatched",
      originDetail: {
        kind: "workflow",
        runId: labels["kunlun.run"] ?? null,
        attemptId: labels["kunlun.attempt"] ?? null,
        nodeId: labels["kunlun.node"] ?? null,
      },
    };
  }

  // 2. Explicit OPC Dark Factory / Planning labels
  if (labels["opc.source"] === "dark-factory" || labels["opc.run"]) {
    return {
      originTrack: "opc_dispatched",
      originDetail: {
        kind: "dark_factory",
        runId: labels["opc.run"] ?? null,
        taskId: labels["opc.task"] ?? null,
      },
    };
  }
  if (labels["opc.task"]) {
    return {
      originTrack: "opc_dispatched",
      originDetail: {
        kind: "planning",
        taskId: labels["opc.task"],
      },
    };
  }

  // 3. Worktree paths exclusively created by OPC Dark Factory or Workflow
  const rawWs = input.rawWorkspace ?? "";
  const factoryMatch = /\/data\/factory-worktrees\/(run_[^/]+)/i.exec(rawWs);
  if (factoryMatch?.[1]) {
    return {
      originTrack: "opc_dispatched",
      originDetail: { kind: "dark_factory", runId: factoryMatch[1] },
    };
  }
  const attemptMatch = /\/data\/zoom-local\/attempts\/([^/]+)\/worktree/i.exec(rawWs);
  if (attemptMatch?.[1]) {
    return {
      originTrack: "opc_dispatched",
      originDetail: { kind: "workflow", attemptId: attemptMatch[1] },
    };
  }

  // 4. Dark Factory prompt template signature ("Task [tsk_...]: ...")
  const instr = input.firstInstruction ?? "";
  const dfPrompt = /^Task \[(tsk_[a-z0-9]+|TASK-[A-Z0-9-]+)\]:/i.exec(instr.trim());
  if (dfPrompt?.[1]) {
    return {
      originTrack: "opc_dispatched",
      originDetail: { kind: "dark_factory", taskId: dfPrompt[1] },
    };
  }

  // 5. Explicit task metadata / sourceRef signals
  if (meta.originTrack === "opc_dispatched") {
    return {
      originTrack: "opc_dispatched",
      originDetail: {
        kind: input.latestRunId ? "dark_factory" : "planning",
        runId: input.latestRunId ?? null,
      },
    };
  }
  if (meta.originTrack === "founder_managed") {
    return {
      originTrack: "founder_managed",
      originDetail: { kind: input.hasHerdrAddress ? "herdr_manual" : "local_cli" },
    };
  }

  const sourceRef = (input.sourceRef ?? "").trim();
  if (sourceRef.startsWith("cli-ledger:") || sourceRef.startsWith("herdr:")) {
    return {
      originTrack: "founder_managed",
      originDetail: { kind: input.hasHerdrAddress ? "herdr_manual" : "local_cli" },
    };
  }
  if (
    input.latestRunId ||
    sourceRef.startsWith("signal:") ||
    sourceRef.startsWith("eval:") ||
    sourceRef.startsWith("pilot") ||
    sourceRef.startsWith("workflow:") ||
    sourceRef.startsWith("dark-factory:")
  ) {
    return {
      originTrack: "opc_dispatched",
      originDetail: {
        kind: input.latestRunId ? "dark_factory" : "planning",
        runId: input.latestRunId ?? null,
      },
    };
  }

  return {
    originTrack: "founder_managed",
    originDetail: { kind: input.hasHerdrAddress ? "herdr_manual" : "local_cli" },
  };
}

interface CompanyRegistryEntry {
  product: string;
  project: string;
  repo: string | null;
  localPath: string | null;
  category: WorkspaceCategory;
}

const overrideInputSchema = z.object({
  key: z.string().trim().min(1, "分类键不能为空").max(300),
  category: z.enum(WORKSPACE_CATEGORIES),
  groupName: z.string().trim().max(120).optional(),
  canonicalProject: z.string().trim().max(120).nullable().optional(),
});

export class WorkspaceClassifierStore {
  private registryCache: { at: number; entries: CompanyRegistryEntry[] } | null = null;
  private overrideCache: { at: number; map: Map<string, WorkspaceClassificationOverride> } | null = null;
  private readonly homeDir: string;

  constructor(private db: DatabaseSync, options?: { homeDir?: string }) {
    this.homeDir = options?.homeDir ?? homedir();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_workspace_classifications (
        key TEXT PRIMARY KEY,
        canonical_project TEXT,
        category TEXT NOT NULL,
        group_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  invalidateCache(): void {
    this.registryCache = null;
    this.overrideCache = null;
  }

  private loadOverrides(): Map<string, WorkspaceClassificationOverride> {
    const now = Date.now();
    if (this.overrideCache && now - this.overrideCache.at < 3000) {
      return this.overrideCache.map;
    }
    const map = new Map<string, WorkspaceClassificationOverride>();
    try {
      const rows = this.db
        .prepare("SELECT key, canonical_project, category, group_name, updated_at FROM opc_workspace_classifications ORDER BY updated_at DESC")
        .all() as Array<{
          key: string;
          canonical_project: string | null;
          category: string;
          group_name: string;
          updated_at: string;
        }>;
      for (const row of rows) {
        const cat = WORKSPACE_CATEGORIES.includes(row.category as WorkspaceCategory)
          ? (row.category as WorkspaceCategory)
          : "personal";
        map.set(row.key.toLowerCase(), {
          key: row.key,
          canonicalProject: row.canonical_project,
          category: cat,
          groupName: row.group_name || WORKSPACE_CATEGORY_LABELS[cat],
          updatedAt: row.updated_at,
        });
      }
    } catch {
      // Ignore if table unavailable
    }
    this.overrideCache = { at: now, map };
    return map;
  }

  private loadCompanyRegistry(): CompanyRegistryEntry[] {
    const now = Date.now();
    if (this.registryCache && now - this.registryCache.at < 5000) {
      return this.registryCache.entries;
    }
    const entries: CompanyRegistryEntry[] = [];
    const seen = new Set<string>();
    const pushEntry = (e: CompanyRegistryEntry) => {
      const sig = `${e.product.toLowerCase()}|${e.project.toLowerCase()}|${(e.repo ?? "").toLowerCase()}|${(e.localPath ?? "").toLowerCase()}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      entries.push(e);
    };

    try {
      const productCategory = (product: string): WorkspaceCategory =>
        RD_INFRA_PRODUCTS.has(product.trim().toLowerCase()) ? "rd_infra" : "company_product";

      // 1. Kernel products + assets
      const hasAssets = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_kernel_assets'")
        .get();
      if (hasAssets) {
        const rows = this.db
          .prepare(
            `SELECT a.name AS asset_name, a.slug AS asset_slug, a.repo_full_name, a.local_repo_path,
                    p.name AS product_name
             FROM opc_kernel_assets a
             LEFT JOIN opc_kernel_products p ON p.id = a.product_id`,
          )
          .all() as Array<{
            asset_name: string;
            asset_slug: string;
            repo_full_name: string | null;
            local_repo_path: string | null;
            product_name: string | null;
          }>;
        for (const r of rows) {
          const product = (r.product_name || r.asset_name || "").trim();
          if (!product) continue;
          pushEntry({
            product,
            project: (r.asset_slug || r.asset_name || product).trim(),
            repo: r.repo_full_name?.trim() || null,
            localPath: normPath(r.local_repo_path),
            category: productCategory(product),
          });
        }
      }

      // 2. company_projects + company_project_repos
      const hasCompanyProjects = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_projects'")
        .get();
      if (hasCompanyProjects) {
        const repoMap = new Map<string, string>();
        const hasRepos = this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_project_repos'")
          .get();
        if (hasRepos) {
          const rRows = this.db
            .prepare("SELECT product, name, repo FROM company_project_repos")
            .all() as Array<{ product: string; name: string; repo: string }>;
          for (const rr of rRows) {
            repoMap.set(`${rr.product.toLowerCase()}/${rr.name.toLowerCase()}`, rr.repo);
          }
        }
        const pRows = this.db
          .prepare("SELECT product, name FROM company_projects")
          .all() as Array<{ product: string; name: string }>;
        for (const p of pRows) {
          const repo = repoMap.get(`${p.product.toLowerCase()}/${p.name.toLowerCase()}`) ?? null;
          pushEntry({
            product: p.product,
            project: p.name,
            repo,
            localPath: null,
            category: productCategory(p.product),
          });
        }
      }
    } catch {
      // Ignore missing legacy tables in minimal unit test DBs
    }

    this.registryCache = { at: now, entries };
    return entries;
  }

  listOverrides(): WorkspaceClassificationOverride[] {
    return [...this.loadOverrides().values()];
  }

  upsertOverride(raw: unknown): WorkspaceClassificationOverride {
    const parsed = overrideInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_classification", parsed.error.issues.map((i) => i.message).join(" / "));
    }
    const { key, category } = parsed.data;
    const groupName = (parsed.data.groupName ?? "").trim() || WORKSPACE_CATEGORY_LABELS[category];
    const canonicalProject = parsed.data.canonicalProject?.trim() || null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO opc_workspace_classifications (key, canonical_project, category, group_name, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           canonical_project = excluded.canonical_project,
           category = excluded.category,
           group_name = excluded.group_name,
           updated_at = excluded.updated_at`,
      )
      .run(key, canonicalProject, category, groupName, now);
    this.invalidateCache();
    return { key, canonicalProject, category, groupName, updatedAt: now };
  }

  deleteOverride(key: string): { deleted: boolean } {
    const res = this.db.prepare("DELETE FROM opc_workspace_classifications WHERE key = ? COLLATE NOCASE").run(key);
    this.invalidateCache();
    return { deleted: Number(res.changes ?? 0) > 0 };
  }

  classify(input: {
    workspace?: string | null;
    repository?: string | null;
    projectHint?: string | null;
    spaceName?: string | null;
    skipFs?: boolean;
  }): WorkspaceClassification {
    const wsInfo = resolveCanonicalWorkspace(input.workspace, { homeDir: this.homeDir, skipFs: input.skipFs });
    const repoRaw =
      (input.repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ? input.repository : null) ??
      wsInfo.repository ??
      null;
    const repoLeaf = repoRaw ? repoRaw.split("/")[1] ?? null : null;

    // Derive clean canonical project name (never wt-*, run_*, home username, or "cwd")
    const wsLeaf = wsInfo.canonicalWorkspace ? basename(wsInfo.canonicalWorkspace) : null;
    const cleanHint = (() => {
      const h = input.projectHint?.trim();
      if (!h) return null;
      const lower = h.toLowerCase();
      if (["未归类项目", "default", "cwd", ".", "~", "unknown", "home"].includes(lower)) return null;
      if (/^wt-[a-z0-9_-]+$/i.test(h) || /^run_[a-f0-9]{8,}$/i.test(h)) return null;
      if (lower === basename(this.homeDir).toLowerCase()) return null;
      return h;
    })();
    const cleanSpace = (() => {
      const s = input.spaceName?.trim();
      if (!s || s === "~" || /^OPC OS ·/i.test(s) || /^昆仑 ·/i.test(s)) return null;
      return s;
    })();

    // Prefer real workspace folder or worktree project hint; use spaceName when cwd is home/temp/missing
    let canonicalProject =
      wsLeaf || wsInfo.worktreeProjectHint || cleanHint || cleanSpace || repoLeaf || "个人工作区";

    // Handle "Product/project" format (e.g. "Password One/password-one" in opc_planning_tasks)
    const slashParts = canonicalProject.includes("/") ? canonicalProject.split("/").map((p) => p.trim()).filter(Boolean) : null;
    const projectLeaf = slashParts && slashParts.length >= 2 ? slashParts[slashParts.length - 1] : canonicalProject;
    const projectPrefix = slashParts && slashParts.length >= 2 ? slashParts[0] : null;

    const alias =
      KNOWN_DIR_ALIASES[canonicalProject.toLowerCase()] ??
      KNOWN_DIR_ALIASES[projectLeaf.toLowerCase()] ??
      (repoLeaf ? KNOWN_DIR_ALIASES[repoLeaf.toLowerCase()] : undefined);

    const effectiveRepo = repoRaw ?? alias?.repoFullName ?? null;
    if (alias?.canonicalProject) {
      canonicalProject = alias.canonicalProject;
    } else if (projectLeaf) {
      canonicalProject = projectLeaf;
    }

    const stableKey = effectiveRepo
      ? `repo:${effectiveRepo.toLowerCase()}`
      : `proj:${canonicalProject.toLowerCase()}`;

    // Candidate override keys (most specific first)
    const candidateKeys = [
      effectiveRepo ? `repo:${effectiveRepo.toLowerCase()}` : null,
      wsInfo.canonicalWorkspace ? `ws:${wsInfo.canonicalWorkspace.toLowerCase()}` : null,
      `proj:${canonicalProject.toLowerCase()}`,
      projectLeaf !== canonicalProject ? `proj:${projectLeaf.toLowerCase()}` : null,
      cleanSpace ? `proj:${cleanSpace.toLowerCase()}` : null,
    ].filter((k): k is string => Boolean(k));

    // 1. User explicit overrides
    const overrides = this.loadOverrides();
    for (const k of candidateKeys) {
      const hit = overrides.get(k);
      if (hit) {
        return {
          key: hit.key,
          canonicalProject: hit.canonicalProject || canonicalProject,
          category: hit.category,
          categoryLabel: WORKSPACE_CATEGORY_LABELS[hit.category],
          group: hit.groupName,
          canonicalWorkspace: wsInfo.canonicalWorkspace,
          repository: effectiveRepo,
          source: "override",
        };
      }
    }

    // 2. Company registry matching
    const registry = this.loadCompanyRegistry();
    let matched: CompanyRegistryEntry | undefined;
    if (effectiveRepo) {
      matched = registry.find((e) => e.repo && e.repo.toLowerCase() === effectiveRepo.toLowerCase());
    }
    if (!matched && wsInfo.canonicalWorkspace) {
      matched = registry
        .filter((e) => e.localPath && isUnderPath(wsInfo.canonicalWorkspace!, e.localPath))
        .sort((a, b) => (b.localPath?.length ?? 0) - (a.localPath?.length ?? 0))[0];
    }
    if (!matched) {
      const targetNames = new Set(
        [canonicalProject, projectLeaf, projectPrefix, repoLeaf]
          .filter((v): v is string => Boolean(v))
          .map((v) => v.toLowerCase()),
      );
      matched = registry.find(
        (e) => targetNames.has(e.project.toLowerCase()) || targetNames.has(e.product.toLowerCase()),
      );
    }

    if (matched) {
      return {
        key: stableKey,
        canonicalProject,
        category: matched.category,
        categoryLabel: WORKSPACE_CATEGORY_LABELS[matched.category],
        group: matched.product,
        canonicalWorkspace: wsInfo.canonicalWorkspace,
        repository: effectiveRepo ?? matched.repo,
        source: "company_registry",
      };
    }

    // 3. Built-in alias fallback (e.g. opc-os / ppeng-agent-core in tests or minimal DBs)
    if (alias?.category && alias.group) {
      return {
        key: stableKey,
        canonicalProject,
        category: alias.category,
        categoryLabel: WORKSPACE_CATEGORY_LABELS[alias.category],
        group: alias.group,
        canonicalWorkspace: wsInfo.canonicalWorkspace,
        repository: effectiveRepo,
        source: "inferred",
      };
    }

    // 4. Everything unclassified defaults to Personal (个人事项) as requested
    return {
      key: stableKey,
      canonicalProject,
      category: "personal",
      categoryLabel: WORKSPACE_CATEGORY_LABELS.personal,
      group: WORKSPACE_CATEGORY_LABELS.personal,
      canonicalWorkspace: wsInfo.canonicalWorkspace,
      repository: effectiveRepo,
      source: "fallback",
    };
  }

  listAvailableGroups(): Array<{ category: WorkspaceCategory; categoryLabel: string; group: string }> {
    const seen = new Set<string>();
    const out: Array<{ category: WorkspaceCategory; categoryLabel: string; group: string }> = [];
    const add = (category: WorkspaceCategory, group: string) => {
      const k = `${category}:${group.toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ category, categoryLabel: WORKSPACE_CATEGORY_LABELS[category], group });
    };
    for (const entry of this.loadCompanyRegistry()) {
      add(entry.category, entry.product);
    }
    add("company_product", "OPC OS");
    add("rd_infra", "研发基建");
    add("personal", "个人事项");
    for (const ov of this.loadOverrides().values()) {
      add(ov.category, ov.groupName);
    }
    return out;
  }
}

export function registerClassificationRoutes(
  app: Hono,
  db: DatabaseSync,
  user: (c: Context) => unknown,
  options?: { submitToken?: string; onMutated?: () => void },
): WorkspaceClassifierStore {
  const store = new WorkspaceClassifierStore(db);
  const { permits } = submitAuth(options?.submitToken);
  const base = "/api/opc/classifications" as const;

  const guard = async (c: Context, next: () => Promise<void>) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  };

  app.use(base, guard);
  app.use(`${base}/*`, guard);

  app.get(base, (c) => {
    return c.json({
      categories: WORKSPACE_CATEGORIES.map((id) => ({ id, label: WORKSPACE_CATEGORY_LABELS[id] })),
      groups: store.listAvailableGroups(),
      overrides: store.listOverrides(),
    });
  });

  app.post(base, async (c) => {
    const body = await c.req.json();
    const override = store.upsertOverride(body);
    options?.onMutated?.();
    return c.json({ override });
  });

  app.put(base, async (c) => {
    const body = await c.req.json();
    const override = store.upsertOverride(body);
    options?.onMutated?.();
    return c.json({ override });
  });

  app.delete(`${base}/:key`, (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const result = store.deleteOverride(key);
    options?.onMutated?.();
    return c.json(result);
  });

  return store;
}
