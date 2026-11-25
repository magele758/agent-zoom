import { execFile } from "node:child_process";
import { basename, normalize } from "node:path";
import { promisify } from "node:util";
import { resolveCanonicalWorkspace } from "./workspace-classifier.ts";

const exec = promisify(execFile);

export interface HerdrSpaceSummary {
  id: string;
  name: string;
  folder: string | null;
}

export interface ResolvedHerdrSpace {
  spaceId: string;
  spaceName: string;
  reused: boolean;
}

function normDir(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return normalize(trimmed).replace(/\/+$/, "") || "/";
}

function slugSpaceId(seed: string): string {
  const clean = seed.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  return `spopc${clean || "default"}`;
}

export async function listHerdrSpaces(
  herdrApp = process.env.HERDR_APP_BIN ?? "herdr-app",
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrSpaceSummary[]> {
  try {
    const { stdout } = await exec(herdrApp, ["ls"], { timeout: 1500, maxBuffer: 1024 * 1024, env });
    const parsed = JSON.parse(stdout) as {
      spaces?: Array<{ id?: unknown; name?: unknown; folder?: unknown }>;
    };
    if (!Array.isArray(parsed.spaces)) return [];
    return parsed.spaces
      .filter((s): s is { id: string; name?: unknown; folder?: unknown } => typeof s?.id === "string" && s.id.length > 0)
      .map((s) => ({
        id: s.id,
        name: typeof s.name === "string" ? s.name : "",
        folder: typeof s.folder === "string" ? normDir(s.folder) : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Resolves a project-scoped Herdr Space so OPC OS dispatched tasks (Workflow & Dark Factory)
 * mount into the user's existing project Space (as a dedicated Tab) instead of spawning
 * throwaway `OPC OS · <hex>` Spaces on every run.
 */
export async function resolveProjectHerdrSpace(input: {
  workspace?: string | null;
  project?: string | null;
  fallbackSpaceId: string;
  fallbackSpaceName: string;
  herdrApp?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedHerdrSpace> {
  const canonical = resolveCanonicalWorkspace(input.workspace);
  const targetDir = normDir(canonical.canonicalWorkspace ?? input.workspace);
  const projectLeaf = input.project
    ? input.project.split("/").filter(Boolean).at(-1)?.trim() || input.project.trim()
    : null;
  const dirLeaf = targetDir ? basename(targetDir) : null;
  const candidateNames = new Set(
    [projectLeaf, dirLeaf, canonical.worktreeProjectHint]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase()),
  );

  const spaces = await listHerdrSpaces(input.herdrApp, input.env);

  // 1. Exact folder match with an existing non-disposable project Space
  if (targetDir) {
    const byFolder = spaces.find(
      (s) =>
        s.folder &&
        s.folder === targetDir &&
        !/^(?:OPC OS|昆仑)\s*·\s*[a-f0-9]{6,}/i.test(s.name),
    );
    if (byFolder) {
      return { spaceId: byFolder.id, spaceName: byFolder.name || dirLeaf || projectLeaf || byFolder.id, reused: true };
    }
  }

  // 2. Name match with an existing project Space (e.g., Space "chrome-plugin-gemini" whose folder is ~)
  if (candidateNames.size > 0) {
    const byName = spaces.find(
      (s) =>
        s.name &&
        candidateNames.has(s.name.trim().toLowerCase()),
    );
    if (byName) {
      return { spaceId: byName.id, spaceName: byName.name, reused: true };
    }
  }

  // 3. Reuse an existing stable `OPC OS · <project>` Space if already open
  const cleanProjLabel = projectLeaf || dirLeaf || canonical.worktreeProjectHint;
  if (cleanProjLabel) {
    const expectedName = `OPC OS · ${cleanProjLabel}`;
    const byOpcProj = spaces.find((s) => s.name.trim().toLowerCase() === expectedName.toLowerCase());
    if (byOpcProj) {
      return { spaceId: byOpcProj.id, spaceName: byOpcProj.name, reused: true };
    }
    return {
      spaceId: slugSpaceId(cleanProjLabel),
      spaceName: expectedName,
      reused: false,
    };
  }

  return {
    spaceId: input.fallbackSpaceId,
    spaceName: input.fallbackSpaceName,
    reused: false,
  };
}
