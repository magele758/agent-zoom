import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative } from "node:path";
import { promisify } from "node:util";
import type { RepoContent } from "../activity-index-types.ts";
import {
  REPO_CODE_LAYER_LABELS,
  type RepoCodeExportSymbol,
  type RepoCodeLayer,
  type RepoCodeMap,
  type RepoCodeMapBrief,
  type RepoCodeMapCycle,
  type RepoCodeMapEdge,
  type RepoCodeMapFileNode,
  type RepoCodeMapHotspot,
  type RepoCodeMapKeyInterface,
  type RepoCodeMapLayerSummary,
  type RepoCodeMapSource,
  type RepoCodeSymbolKind,
  type RepoEvidenceLink,
  type RepoEvolutionNode,
  type RepoModuleAnalysisItem,
  type RepoModuleEffort,
  type RepoModuleRisk,
  type RepoRelationType,
} from "../repo-evolution-types.ts";

const exec = promisify(execFile);

export interface RemoteTreeEntry {
  path: string;
  size: number;
  sha?: string;
}

export interface RemoteRepoTreeSnapshot {
  commitSha: string;
  defaultBranch: string | null;
  truncated: boolean;
  entries: RemoteTreeEntry[];
}

export interface CodeMapRemoteFetcher {
  resolveHeadCommit(
    owner: string,
    name: string,
    defaultBranch?: string | null,
  ): Promise<{ commitSha: string; defaultBranch: string | null }>;
  fetchRecursiveTree(
    owner: string,
    name: string,
    ref: string,
  ): Promise<RemoteRepoTreeSnapshot>;
  fetchBlobsBatch(
    owner: string,
    name: string,
    ref: string,
    paths: string[],
  ): Promise<Map<string, string>>;
}

export interface LocalRepoSnapshot {
  commitSha: string;
  defaultBranch: string | null;
  entries: RemoteTreeEntry[];
  readFile: (relPath: string) => string | null;
}

export interface BuildCodeMapOptions {
  nodeId: string;
  repoFullName: string;
  repoUrl: string;
  commitSha: string;
  defaultBranch: string | null;
  source: RepoCodeMapSource;
  treeEntries: RemoteTreeEntry[];
  blobs: Map<string, string>;
  focusPaths?: string[];
  fetchDurationMs?: number;
  nowIso?: string;
}

// ---- Language & Noise Filtering ----

const SOURCE_EXTENSIONS: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".swift": "Swift",
};

const IGNORED_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "dist3",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  "vendor",
  "third_party",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".git",
  ".github",
  ".gitlab",
  ".vscode",
  ".idea",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
  "storybook-static",
  "Pods",
  ".build",
  "generated",
  "fixtures",
  "__fixtures__",
  "__snapshots__",
  "testdata",
  "migrations",
]);

const IGNORED_FILE_PATTERNS: RegExp[] = [
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/i,
  /\.min\.(?:js|mjs|cjs|css)$/i,
  /\.bundle\.(?:js|mjs|cjs)$/i,
  /\.d\.ts$/i,
  /\.map$/i,
  /\.(?:png|jpe?g|gif|webp|ico|svg|bmp|tiff|pdf|mp4|mov|webm|mp3|wav|ogg|woff2?|ttf|eot|wasm|zip|tar|gz|dmg|exe|dll|so|dylib|traineddata|sqlite|db|parquet|bin|onnx|pt|safetensors)$/i,
];

const MAX_SOURCE_FILE_BYTES = 260 * 1024;
const DEFAULT_MAX_ANALYZED_FILES = 36;
const MAX_ANALYZED_FILES_CAP = 48;
const MIN_ANALYZED_FILES = 6;

export function detectSourceLanguage(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return SOURCE_EXTENSIONS[ext] ?? null;
}

export function isNoiseTreePath(path: string, size = 0): boolean {
  const clean = path.replace(/^\/+/, "");
  if (!clean) return true;
  if (size > MAX_SOURCE_FILE_BYTES) return true;
  const segments = clean.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (IGNORED_DIR_SEGMENTS.has(seg)) return true;
    if (seg.startsWith(".") && seg !== ".claude") return true;
  }
  const base = segments[segments.length - 1] ?? "";
  if (base.startsWith(".")) return true;
  for (const re of IGNORED_FILE_PATTERNS) {
    if (re.test(clean)) return true;
  }
  return false;
}

export function classifyFileLayer(path: string, content = ""): RepoCodeLayer {
  const lower = path.toLowerCase();
  const base = posix.basename(lower);
  const ext = extname(lower);
  const depth = lower.split("/").length;

  // 1. Tests
  if (
    /(?:^|\/)(?:__tests__|tests?|specs?|e2e|benchmarks?)\//.test(lower) ||
    /\.(?:test|spec)\.[a-z]+$/.test(base) ||
    /_test\.go$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    base.endsWith("_tests.rs")
  ) {
    return "test";
  }

  // 2. Config / build / manifest
  if (
    /(?:^|\/)(?:config|configs|settings)\//.test(lower) ||
    /(?:config|settings|constants|env|schema\.config)\.[a-z]+$/.test(base) ||
    /^(?:vite|webpack|rollup|esbuild|tsup|jest|vitest|babel|eslint|prettier|tailwind|postcss|next|nuxt|build)\./.test(
      base,
    ) ||
    base === "build.rs" ||
    base === "setup.py" ||
    base === "conftest.py"
  ) {
    return "config";
  }

  // 3. Entrypoints
  if (
    /(?:^|\/)(?:cmd|bin|cli|entrypoints?)\//.test(lower) ||
    /^(?:main|cli|server|app|entrypoint|bootstrap|background|service[-_]worker|extension)\.[a-z]+$/.test(base) ||
    (depth <= 3 && /^(?:index|mod|lib|__init__|__main__)\.[a-z]+$/.test(base))
  ) {
    return "entry";
  }

  // 4. Protocol / API / Gateway / Bridge / Types
  if (
    /(?:^|\/)(?:protocol|protocols|types|schema|schemas|contracts?|api|routes?|router|rpc|mcp|a2a|acp|cdp|gateway|bridge|transport|events?|messages?|ipc|ws|websocket|sse|sdk|clients?|adapters?|webhooks?)\//.test(
      lower,
    ) ||
    /(?:protocol|types|schema|contract|router|routes|http|rpc|mcp|cdp|gateway|bridge|transport|socket|ipc|client|adapter|event|message|webhook|api)\.[a-z]+$/.test(
      base,
    )
  ) {
    return "protocol";
  }

  // 5. Storage / State / Memory / DB
  if (
    /(?:^|\/)(?:db|database|store|stores|storage|cache|memory|vector|pg|postgres|sqlite|redis|state|session|sessions|checkpoint|snapshot|persist|ledger|repository|repositories|index|kv)\//.test(
      lower,
    ) ||
    /(?:db|database|store|storage|cache|memory|vector|postgres|pg|sqlite|state|session|checkpoint|snapshot|persist|ledger|repo)\.[a-z]+$/.test(
      base,
    )
  ) {
    return "storage";
  }

  // 6. Infrastructure / Sandbox / VM / Security / OS / Process
  if (
    /(?:^|\/)(?:infra|sandbox|microvm|vm|firecracker|vmm|jailer|hypervisor|container|docker|k8s|kube|runtime|process|pty|shell|worker|workers|queue|scheduler|cron|auth|security|crypto|vault|secret|network|proxy|telemetry|metrics|tracing|logging|logger|native|os|fs)\//.test(
      lower,
    ) ||
    /(?:sandbox|microvm|vm|vmm|firecracker|jailer|hypervisor|container|docker|worker|queue|scheduler|cron|auth|security|crypto|vault|proxy|telemetry|logger|tracer|pty|shell|process)\.[a-z]+$/.test(
      base,
    )
  ) {
    return "infra";
  }

  // 7. UI / Frontend / Extension Panels
  if (
    ext === ".tsx" ||
    ext === ".jsx" ||
    ext === ".vue" ||
    ext === ".svelte" ||
    /(?:^|\/)(?:ui|web|frontend|components?|pages?|views?|sidepanel|popup|panel|panels|canvas|editor|widgets?|screens?|hooks|styles?|themes?)\//.test(
      lower,
    )
  ) {
    return "ui";
  }

  // 8. Core / Engine / Agent / Orchestration / Domain logic
  if (
    /(?:^|\/)(?:core|kernel|engine|agent|agents|loop|orchestrat\w*|planner|executor|runner|workflow|graph|pipeline|dom|browser|actions?|controller|service|services|manager|dispatcher|logic|domain|domains|brain|strategy|analyzer|parser|compiler|distill|tools?|skills?|plugins?|modules?)\//.test(
      lower,
    ) ||
    /(?:core|kernel|engine|agent|loop|orchestrator|planner|executor|runner|workflow|graph|pipeline|dom|browser|action|controller|service|manager|dispatcher|logic|analyzer|parser|tool|registry|prompt|model)\.[a-z]+$/.test(
      base,
    )
  ) {
    return "core";
  }

  // Content heuristic fallback
  if (content) {
    if (/\b(?:createServer|Hono|express\(\)|FastAPI|http\.ListenAndServe|axum::Router)\b/.test(content)) {
      return "protocol";
    }
    if (/\b(?:CREATE TABLE|pg\.Pool|DatabaseSync|sqlite|vector_cosine_ops)\b/i.test(content)) {
      return "storage";
    }
    if (/\b(?:React\.FC|useState|useEffect|defineComponent)\b/.test(content)) {
      return "ui";
    }
    if (/(?:^|\/)src\//.test(lower)) {
      return "core";
    }
  }

  return "other";
}

function scoreCandidateForSelection(entry: RemoteTreeEntry, focusPaths: string[]): number {
  const path = entry.path;
  const lower = path.toLowerCase();
  const base = posix.basename(lower);
  const depth = lower.split("/").length;

  let score = 10;

  // Explicit focusPaths always win
  for (const fp of focusPaths) {
    const cleanFp = fp.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!cleanFp) continue;
    if (lower === cleanFp) score += 200;
    else if (lower.startsWith(cleanFp + "/") || lower.includes(cleanFp)) score += 95;
  }

  const layer = classifyFileLayer(path);
  const layerWeight: Record<RepoCodeLayer, number> = {
    core: 36,
    protocol: 33,
    entry: 34,
    infra: 30,
    storage: 28,
    ui: 16,
    config: 8,
    other: 12,
    test: -28,
  };
  score += layerWeight[layer];

  // Penalize examples/demos/docs/scripts/storybook & boilerplate/legacy/codemod files
  if (/(?:^|\/)(?:examples?|demos?|samples?|playground|docs?|stories|storybook|scripts|evals?|codemod|telemetry)\//.test(lower)) {
    score -= 22;
  }
  if (/^(?:legacy|deprecated|utils?|helpers?|exceptions?|errors?|compat|logger|logging)\.[a-z]+$/.test(base)) {
    score -= 18;
  }

  // Prefer primary source trees
  if (/^(?:src|packages|crates|pkg|internal|cmd|core|server|lib|app|extension|agent|browser_use)\//.test(lower)) {
    score += 12;
  }

  // Prefer moderate depth (2..5)
  if (depth >= 2 && depth <= 4) score += 8;
  else if (depth > 6) score -= (depth - 6) * 4;

  // Prefer real implementation files over tiny stubs or giant dumps
  if (entry.size >= 600 && entry.size <= 65_000) score += 10;
  else if (entry.size > 0 && entry.size < 250) {
    // Still keep root/package entry barrel files because they expose import topology
    if (/^(?:index|mod|lib|__init__)\.[a-z]+$/.test(base) && depth <= 3) score += 4;
    else score -= 8;
  } else if (entry.size > 120_000) {
    score -= 6;
  }

  // Bonus for architecture-defining filenames
  if (
    /^(?:service|engine|runtime|kernel|orchestrator|controller|manager|dispatcher|session|gateway|protocol|types|schema|client|server|loop|agent|browser|dom|sandbox|vm|vmm|microvm|router|store|index|main|lib|mod|app|background|content)\.[a-z]+$/.test(
      base,
    )
  ) {
    score += 14;
  }

  return score;
}

export function selectCandidateSourceFiles(
  entries: RemoteTreeEntry[],
  options: { maxFiles?: number; focusPaths?: string[] } = {},
): {
  candidateEntries: RemoteTreeEntry[];
  selectedEntries: RemoteTreeEntry[];
} {
  const maxFiles = Math.max(
    MIN_ANALYZED_FILES,
    Math.min(MAX_ANALYZED_FILES_CAP, Math.floor(options.maxFiles ?? DEFAULT_MAX_ANALYZED_FILES)),
  );
  const focusPaths = options.focusPaths ?? [];

  const candidateEntries = entries.filter(
    (e) => !isNoiseTreePath(e.path, e.size) && detectSourceLanguage(e.path) !== null,
  );

  const scored = candidateEntries
    .map((entry) => ({
      entry,
      score: scoreCandidateForSelection(entry, focusPaths),
      layer: classifyFileLayer(entry.path),
      bucket: entry.path.split("/").slice(0, 2).join("/"),
    }))
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));

  // Diversity-aware greedy selection: cap any single directory bucket so monorepos show all subsystems
  const selected: RemoteTreeEntry[] = [];
  const selectedSet = new Set<string>();
  const bucketCounts = new Map<string, number>();
  let testCount = 0;
  const maxPerBucket = Math.max(6, Math.ceil(maxFiles * 0.35));

  for (const item of scored) {
    if (selected.length >= maxFiles) break;
    if (item.layer === "test" && testCount >= 2 && item.score < 80) continue;
    const bc = bucketCounts.get(item.bucket) ?? 0;
    if (bc >= maxPerBucket && item.score < 120) continue;
    selected.push(item.entry);
    selectedSet.add(item.entry.path);
    bucketCounts.set(item.bucket, bc + 1);
    if (item.layer === "test") testCount++;
  }

  // Fill remaining slots if bucket caps left room
  if (selected.length < maxFiles) {
    for (const item of scored) {
      if (selected.length >= maxFiles) break;
      if (selectedSet.has(item.entry.path)) continue;
      selected.push(item.entry);
      selectedSet.add(item.entry.path);
    }
  }

  return { candidateEntries, selectedEntries: selected };
}

// ---- Multi-Language Zero-LLM Static Parser (TS/JS/Vue, Python, Go, Rust) ----

interface ParsedImport {
  specifier: string;
  symbols: string[];
  kind: "relative" | "module" | "mod_decl";
}

interface ParsedFileResult {
  imports: ParsedImport[];
  exportedSymbols: RepoCodeExportSymbol[];
}

function stripJsComments(source: string): string {
  // Replace comments with spaces/newlines while preserving line numbers and strings
  return source.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, str) => {
      if (str) return str;
      return match.replace(/[^\n]/g, " ");
    },
  );
}

function extractVueScript(source: string): string {
  const blocks: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    blocks.push(m[1] ?? "");
  }
  return blocks.join("\n");
}

function cleanSignature(line: string, maxLen = 140): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/\s*\{[\s\S]*$/, "")
    .replace(/;\s*$/, "")
    .trim()
    .slice(0, maxLen);
}

function parseTsJsFile(rawSource: string, isVueOrSvelte = false): ParsedFileResult {
  const code = isVueOrSvelte ? extractVueScript(rawSource) : rawSource;
  if (!code.trim()) return { imports: [], exportedSymbols: [] };
  const stripped = stripJsComments(code);

  const imports: ParsedImport[] = [];
  const seenSpec = new Set<string>();

  const addImport = (specifier: string, symbols: string[] = []) => {
    const spec = specifier.trim();
    if (!spec) return;
    const key = `${spec}:${symbols.join(",")}`;
    if (seenSpec.has(key)) return;
    seenSpec.add(key);
    imports.push({
      specifier: spec,
      symbols: symbols.filter(Boolean).slice(0, 12),
      kind: spec.startsWith(".") ? "relative" : "module",
    });
  };

  // 1. import ... from "..." / export ... from "..."
  const esmFromRe =
    /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?([\s\S]{0,600}?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = esmFromRe.exec(stripped)) !== null) {
    const clause = m[1] ?? "";
    const spec = m[2] ?? "";
    const symbols: string[] = [];
    const namedMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (namedMatch) {
      for (const part of namedMatch[1].split(",")) {
        const cleaned = part
          .replace(/\btype\b/g, "")
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (cleaned && /^[A-Za-z_$][\w$]*$/.test(cleaned)) symbols.push(cleaned);
      }
    }
    const defaultMatch = /^([A-Za-z_$][\w$]*)/.exec(clause.trim());
    if (defaultMatch && defaultMatch[1] !== "type") {
      symbols.unshift(defaultMatch[1]);
    }
    addImport(spec, symbols);
  }

  // 2. Side-effect import "..."
  const sideEffectRe = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g;
  while ((m = sideEffectRe.exec(stripped)) !== null) {
    addImport(m[1] ?? "");
  }

  // 3. Dynamic import("...") & require("...")
  const reqRe = /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = reqRe.exec(stripped)) !== null) {
    addImport(m[1] ?? "");
  }

  // Exported symbols
  const exportedSymbols: RepoCodeExportSymbol[] = [];
  const seenSym = new Set<string>();
  const lines = stripped.split(/\r?\n/);

  const pushSym = (name: string, kind: RepoCodeSymbolKind, lineNo: number, rawLine: string) => {
    if (!name || seenSym.has(name) || exportedSymbols.length >= 28) return;
    seenSym.add(name);
    exportedSymbols.push({
      name,
      kind,
      signature: cleanSignature(rawLine),
      line: lineNo,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    let sm: RegExpExecArray | null;
    if ((sm = /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed))) {
      pushSym(sm[1], "class", i + 1, trimmed);
    } else if ((sm = /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(trimmed))) {
      pushSym(sm[1], "function", i + 1, trimmed);
    } else if ((sm = /^export\s+interface\s+([A-Za-z_$][\w$]*)/.exec(trimmed))) {
      pushSym(sm[1], "interface", i + 1, trimmed);
    } else if ((sm = /^export\s+type\s+([A-Za-z_$][\w$]*)\s*(?:<|=)/.exec(trimmed))) {
      pushSym(sm[1], "type", i + 1, trimmed);
    } else if ((sm = /^export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(trimmed))) {
      pushSym(sm[1], "enum", i + 1, trimmed);
    } else if ((sm = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(trimmed))) {
      pushSym(sm[1], "function", i + 1, trimmed);
    } else if ((sm = /^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\b/.exec(trimmed))) {
      pushSym(sm[1], "const", i + 1, trimmed);
    } else if ((sm = /^exports\.([A-Za-z_$][\w$]*)\s*=/.exec(trimmed))) {
      pushSym(sm[1], "const", i + 1, trimmed);
    } else if ((sm = /^module\.exports\s*=\s*\{\s*([^}]{1,200})\}/.exec(trimmed))) {
      for (const tok of sm[1].split(",")) {
        const n = tok.trim().split(/[:\s]/)[0]?.trim();
        if (n && /^[A-Za-z_$][\w$]*$/.test(n)) pushSym(n, "const", i + 1, `module.exports.${n}`);
      }
    }
  }

  return { imports, exportedSymbols };
}

function parsePythonFile(source: string): ParsedFileResult {
  const imports: ParsedImport[] = [];
  const exportedSymbols: RepoCodeExportSymbol[] = [];
  const seenSym = new Set<string>();
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Imports
    let m: RegExpExecArray | null;
    if ((m = /^from\s+(\.{1,4}[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(trimmed))) {
      const mod = m[1];
      const namesRaw = m[2].replace(/[()#].*$/, "");
      const symbols = namesRaw
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
        .filter((s) => s && s !== "*" && /^[A-Za-z_]\w*$/.test(s))
        .slice(0, 12);
      imports.push({
        specifier: mod,
        symbols,
        kind: mod.startsWith(".") ? "relative" : "module",
      });
    } else if ((m = /^import\s+([A-Za-z_][A-Za-z0-9_.,\s]*)$/.exec(trimmed))) {
      for (const part of m[1].split(",")) {
        const mod = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (mod) imports.push({ specifier: mod, symbols: [], kind: "module" });
      }
    }

    // Top-level classes & functions (indent === 0)
    if (!/^\s/.test(raw)) {
      if ((m = /^class\s+([A-Za-z][A-Za-z0-9_]*)\b(.*)$/.exec(raw))) {
        const name = m[1];
        if (!seenSym.has(name) && exportedSymbols.length < 28) {
          seenSym.add(name);
          const isProto = /\b(?:Protocol|TypedDict|BaseModel|ABC)\b/.test(m[2]);
          exportedSymbols.push({
            name,
            kind: isProto ? "interface" : "class",
            signature: cleanSignature(raw.replace(/:\s*$/, "")),
            line: i + 1,
          });
        }
      } else if ((m = /^(?:async\s+)?def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/.exec(raw))) {
        const name = m[1];
        if (!name.startsWith("_") && !seenSym.has(name) && exportedSymbols.length < 28) {
          seenSym.add(name);
          exportedSymbols.push({
            name,
            kind: "function",
            signature: cleanSignature(raw.replace(/:\s*$/, "")),
            line: i + 1,
          });
        }
      }
    }
  }

  return { imports, exportedSymbols };
}

function parseGoFile(source: string): ParsedFileResult {
  const imports: ParsedImport[] = [];
  const exportedSymbols: RepoCodeExportSymbol[] = [];
  const seenSym = new Set<string>();
  const stripped = stripJsComments(source);

  // Single import
  const singleRe = /(?:^|\n)\s*import\s+(?:[A-Za-z_.\w]*\s+)?"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(stripped)) !== null) {
    imports.push({ specifier: m[1], symbols: [], kind: "module" });
  }

  // Grouped import ( ... )
  const groupRe = /(?:^|\n)\s*import\s*\(([\s\S]*?)\)/g;
  while ((m = groupRe.exec(stripped)) !== null) {
    const inner = m[1] ?? "";
    const lineRe = /"([^"]+)"/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(inner)) !== null) {
      imports.push({ specifier: lm[1], symbols: [], kind: "module" });
    }
  }

  const lines = stripped.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;
    let sm: RegExpExecArray | null;
    if ((sm = /^type\s+([A-Z][\w]*)\s+interface\b/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "interface", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((sm = /^type\s+([A-Z][\w]*)\s+struct\b/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "struct", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((sm = /^type\s+([A-Z][\w]*)\b/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "type", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((sm = /^func\s+(?:\([^)]+\)\s+)?([A-Z][\w]*)\s*\(/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "function", signature: cleanSignature(raw), line: i + 1 });
      }
    }
  }

  return { imports, exportedSymbols };
}

function parseRustFile(source: string): ParsedFileResult {
  const imports: ParsedImport[] = [];
  const exportedSymbols: RepoCodeExportSymbol[] = [];
  const seenSym = new Set<string>();
  const stripped = stripJsComments(source);
  const lines = stripped.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;

    let m: RegExpExecArray | null;
    if ((m = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-zA-Z_][\w]*)\s*;/.exec(raw))) {
      imports.push({ specifier: m[1], symbols: [m[1]], kind: "mod_decl" });
    } else if ((m = /^(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/.exec(raw))) {
      const spec = m[1].trim();
      const braceMatch = /\{([^}]+)\}/.exec(spec);
      const symbols = braceMatch
        ? braceMatch[1]
            .split(",")
            .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
            .filter((s) => s && s !== "self" && s !== "*")
            .slice(0, 10)
        : [spec.split("::").pop()?.replace(/\s+as\s+.*$/, "").trim() ?? ""].filter(Boolean);
      imports.push({
        specifier: spec,
        symbols,
        kind: spec.startsWith("crate::") || spec.startsWith("super::") || spec.startsWith("self::")
          ? "relative"
          : "module",
      });
    }

    let sm: RegExpExecArray | null;
    if ((sm = /^pub(?:\(crate\))?\s+struct\s+([A-Za-z_][\w]*)/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "struct", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((sm = /^pub(?:\(crate\))?\s+trait\s+([A-Za-z_][\w]*)/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "trait", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((sm = /^pub(?:\(crate\))?\s+enum\s+([A-Za-z_][\w]*)/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "enum", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((sm = /^pub(?:\(crate\))?\s+(?:async\s+)?fn\s+([a-zA-Z_][\w]*)/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "function", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((sm = /^pub(?:\(crate\))?\s+type\s+([A-Za-z_][\w]*)/.exec(raw))) {
      if (!seenSym.has(sm[1]) && exportedSymbols.length < 28) {
        seenSym.add(sm[1]);
        exportedSymbols.push({ name: sm[1], kind: "type", signature: cleanSignature(raw), line: i + 1 });
      }
    }
  }

  return { imports, exportedSymbols };
}

function parseSwiftFile(source: string): ParsedFileResult {
  const imports: ParsedImport[] = [];
  const exportedSymbols: RepoCodeExportSymbol[] = [];
  const seenSym = new Set<string>();
  const lines = stripJsComments(source).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;
    let m: RegExpExecArray | null;
    if ((m = /^import\s+([A-Za-z_][\w.]*)/.exec(raw))) {
      imports.push({ specifier: m[1], symbols: [], kind: "module" });
    } else if ((m = /^(?:public\s+|open\s+)?(?:final\s+)?(class|struct|protocol|enum|actor)\s+([A-Za-z_][\w]*)/.exec(raw))) {
      const kindMap: Record<string, RepoCodeSymbolKind> = {
        class: "class",
        struct: "struct",
        protocol: "interface",
        enum: "enum",
        actor: "class",
      };
      if (!seenSym.has(m[2]) && exportedSymbols.length < 28) {
        seenSym.add(m[2]);
        exportedSymbols.push({ name: m[2], kind: kindMap[m[1]] ?? "class", signature: cleanSignature(raw), line: i + 1 });
      }
    } else if ((m = /^(?:public\s+|open\s+)?func\s+([A-Za-z_][\w]*)/.exec(raw))) {
      if (!seenSym.has(m[1]) && exportedSymbols.length < 28) {
        seenSym.add(m[1]);
        exportedSymbols.push({ name: m[1], kind: "function", signature: cleanSignature(raw), line: i + 1 });
      }
    }
  }
  return { imports, exportedSymbols };
}

export function parseSourceFileStatic(path: string, content: string): ParsedFileResult {
  const lang = detectSourceLanguage(path);
  if (!lang) return { imports: [], exportedSymbols: [] };
  if (lang === "TypeScript" || lang === "JavaScript") return parseTsJsFile(content, false);
  if (lang === "Vue" || lang === "Svelte") return parseTsJsFile(content, true);
  if (lang === "Python") return parsePythonFile(content);
  if (lang === "Go") return parseGoFile(content);
  if (lang === "Rust") return parseRustFile(content);
  if (lang === "Swift") return parseSwiftFile(content);
  return { imports: [], exportedSymbols: [] };
}

// ---- Internal Import Path Resolver ----

const TS_JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];

function normalizeExternalPackageName(specifier: string, language: string): string | null {
  const s = specifier.trim();
  if (!s || s.startsWith(".") || s.startsWith("/")) return null;
  if (s.startsWith("node:")) return s;
  if (language === "TypeScript" || language === "JavaScript" || language === "Vue" || language === "Svelte") {
    if (s.startsWith("@")) {
      const parts = s.split("/");
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
    }
    return s.split("/")[0] ?? null;
  }
  if (language === "Python") {
    const root = s.split(".")[0];
    if (!root || /^(?:os|sys|re|json|typing|pathlib|asyncio|logging|time|datetime|collections|functools|itertools|dataclasses|enum|abc|uuid|hashlib|math|random|inspect|contextlib|subprocess|tempfile|shutil|io|copy|warnings|urllib|http|socket|threading|multiprocessing|concurrent|unittest|__future__)$/.test(root)) {
      return null;
    }
    return root;
  }
  if (language === "Go") {
    if (!s.includes(".")) return null; // Go stdlib has no dot in first segment
    const parts = s.split("/");
    return parts.length >= 3 ? parts.slice(0, 3).join("/") : s;
  }
  if (language === "Rust") {
    const root = s.split("::")[0]?.trim();
    if (!root || /^(?:std|core|alloc|crate|self|super)$/.test(root)) return null;
    return root;
  }
  return s.split(/[/.:]/)[0] ?? null;
}

function buildImportResolver(allTreePaths: string[], repoFullName: string) {
  const pathSet = new Set(allTreePaths);
  const filesByDir = new Map<string, string[]>();
  const topSegments = new Set<string>();
  const rustCrateRoots = new Map<string, string>(); // crateName -> srcDir

  for (const p of allTreePaths) {
    const dir = posix.dirname(p);
    const list = filesByDir.get(dir) ?? [];
    list.push(p);
    filesByDir.set(dir, list);
    const first = p.split("/")[0];
    if (first) topSegments.add(first);

    // Detect Rust crates (crates/<name>/src/... or src/lib.rs)
    const crateMatch = /^(?:crates|packages)\/([^/]+)\/src\//.exec(p);
    if (crateMatch) {
      rustCrateRoots.set(crateMatch[1].replace(/-/g, "_"), `${p.split("/").slice(0, 3).join("/")}`);
    }
  }

  const repoLower = repoFullName.toLowerCase();
  const repoShort = repoFullName.split("/")[1]?.toLowerCase() ?? "";

  const tryTsPath = (baseCandidate: string): string | null => {
    const norm = posix.normalize(baseCandidate).replace(/^\.\//, "");
    if (pathSet.has(norm)) return norm;

    // ESM TypeScript often writes `./foo.js` for `./foo.ts`
    const withoutJs = norm.replace(/\.(?:m|c)?jsx?$/, "");
    for (const ext of TS_JS_EXTS) {
      if (pathSet.has(withoutJs + ext)) return withoutJs + ext;
      if (pathSet.has(norm + ext)) return norm + ext;
    }
    for (const idx of ["index.ts", "index.tsx", "index.mts", "index.js", "index.jsx", "index.mjs"]) {
      const idxPath = `${norm}/${idx}`;
      if (pathSet.has(idxPath)) return idxPath;
    }
    return null;
  };

  const resolveImport = (fromPath: string, imp: ParsedImport, language: string): string | null => {
    const fromDir = posix.dirname(fromPath);
    const spec = imp.specifier;

    if (language === "TypeScript" || language === "JavaScript" || language === "Vue" || language === "Svelte") {
      if (spec.startsWith(".")) {
        return tryTsPath(posix.join(fromDir, spec));
      }
      if (spec.startsWith("@/") || spec.startsWith("~/")) {
        const sub = spec.slice(2);
        const candidates = [
          `src/${sub}`,
          `web/src/${sub}`,
          `app/${sub}`,
          sub,
        ];
        // Also try nearest package's src/
        const pkgPrefixMatch = /^(packages\/[^/]+|apps\/[^/]+|src\/[^/]+)\//.exec(fromPath);
        if (pkgPrefixMatch) {
          candidates.unshift(`${pkgPrefixMatch[1]}/src/${sub}`, `${pkgPrefixMatch[1]}/${sub}`);
        }
        for (const cand of candidates) {
          const hit = tryTsPath(cand);
          if (hit) return hit;
        }
      }
      // Monorepo internal workspace import like `@org/pkg` or `@org/pkg/sub`
      if (spec.startsWith("@") && spec.includes("/")) {
        const parts = spec.split("/");
        const pkgName = parts[1];
        const rest = parts.slice(2).join("/");
        const bases = [
          `packages/${pkgName}/src/${rest || "index"}`,
          `packages/${pkgName}/${rest || "index"}`,
          `src/${pkgName}/${rest || "index"}`,
        ];
        for (const b of bases) {
          const hit = tryTsPath(b);
          if (hit) return hit;
        }
      }
      return null;
    }

    if (language === "Python") {
      if (spec.startsWith(".")) {
        const dots = /^(\.+)/.exec(spec)?.[1].length ?? 1;
        const rest = spec.slice(dots);
        let cur = fromDir;
        for (let d = 1; d < dots; d++) cur = posix.dirname(cur);
        const relMod = rest ? rest.replace(/\./g, "/") : "";
        const base = relMod ? posix.join(cur, relMod) : cur;
        for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
          const norm = posix.normalize(cand).replace(/^\.\//, "");
          if (pathSet.has(norm)) return norm;
        }
        // Check if first imported symbol is a submodule
        if (imp.symbols[0]) {
          const sub = posix.join(base, imp.symbols[0]);
          for (const cand of [`${sub}.py`, `${sub}/__init__.py`]) {
            const norm = posix.normalize(cand).replace(/^\.\//, "");
            if (pathSet.has(norm)) return norm;
          }
        }
        return null;
      }
      const modPath = spec.replace(/\./g, "/");
      const firstSeg = modPath.split("/")[0];
      if (!topSegments.has(firstSeg) && !pathSet.has(`src/${modPath}.py`) && !pathSet.has(`src/${modPath}/__init__.py`)) {
        return null;
      }
      for (const prefix of ["", "src/"]) {
        for (const cand of [`${prefix}${modPath}.py`, `${prefix}${modPath}/__init__.py`]) {
          if (pathSet.has(cand)) return cand;
        }
        if (imp.symbols[0]) {
          for (const cand of [
            `${prefix}${modPath}/${imp.symbols[0]}.py`,
            `${prefix}${modPath}/${imp.symbols[0]}/__init__.py`,
          ]) {
            if (pathSet.has(cand)) return cand;
          }
        }
      }
      return null;
    }

    if (language === "Go") {
      const lowerSpec = spec.toLowerCase();
      let subDir: string | null = null;
      const ghIdx = lowerSpec.indexOf(`github.com/${repoLower}/`);
      if (ghIdx !== -1) {
        subDir = spec.slice(ghIdx + `github.com/${repoLower}/`.length);
      } else if (repoShort) {
        const marker = `/${repoShort}/`;
        const idx = lowerSpec.indexOf(marker);
        if (idx !== -1) subDir = spec.slice(idx + marker.length);
      }
      if (!subDir) return null;
      const dirFiles = (filesByDir.get(subDir) ?? []).filter(
        (f) => f.endsWith(".go") && !f.endsWith("_test.go"),
      );
      if (dirFiles.length === 0) return null;
      // Prefer file named after the directory or first non-test .go file
      const dirBase = posix.basename(subDir);
      return (
        dirFiles.find((f) => posix.basename(f, ".go") === dirBase) ??
        dirFiles.find((f) => /main|server|client|manager|types|api/.test(posix.basename(f))) ??
        dirFiles[0]
      );
    }

    if (language === "Rust") {
      if (imp.kind === "mod_decl") {
        const modName = spec;
        const cands = [
          posix.join(fromDir, `${modName}.rs`),
          posix.join(fromDir, modName, "mod.rs"),
        ];
        for (const c of cands) {
          const norm = posix.normalize(c).replace(/^\.\//, "");
          if (pathSet.has(norm)) return norm;
        }
        return null;
      }
      // Find current crate src root
      const srcIdx = fromPath.indexOf("/src/");
      const crateSrcRoot = srcIdx !== -1 ? fromPath.slice(0, srcIdx + 4) : "src";
      const cleanSpec = spec.replace(/::\{[\s\S]*\}$/, "").replace(/::\*$/, "");
      const parts = cleanSpec.split("::").filter(Boolean);
      if (parts.length < 2) return null;

      let baseRoot: string | null = null;
      let restParts: string[] = [];
      if (parts[0] === "crate") {
        baseRoot = crateSrcRoot;
        restParts = parts.slice(1);
      } else if (parts[0] === "super") {
        baseRoot = posix.dirname(fromDir);
        restParts = parts.slice(1);
      } else if (parts[0] === "self") {
        baseRoot = fromDir;
        restParts = parts.slice(1);
      } else if (rustCrateRoots.has(parts[0])) {
        baseRoot = rustCrateRoots.get(parts[0])!;
        restParts = parts.slice(1);
      }

      if (!baseRoot) return null;
      for (let len = Math.min(restParts.length, 4); len >= 1; len--) {
        const sub = restParts.slice(0, len).join("/");
        for (const cand of [posix.join(baseRoot, `${sub}.rs`), posix.join(baseRoot, sub, "mod.rs")]) {
          const norm = posix.normalize(cand).replace(/^\.\//, "");
          if (pathSet.has(norm)) return norm;
        }
      }
      return null;
    }

    return null;
  };

  return { resolveImport };
}

// ---- Cycle Detection (Bounded DFS, deduplicated canonical cycles) ----

function detectImportCycles(edges: RepoCodeMapEdge[], maxCycles = 12): RepoCodeMapCycle[] {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    nodes.add(e.from);
    nodes.add(e.to);
    const arr = adj.get(e.from) ?? [];
    if (!arr.includes(e.to)) arr.push(e.to);
    adj.set(e.from, arr);
  }

  const cycles: RepoCodeMapCycle[] = [];
  const seenKeys = new Set<string>();
  const visitedGlobal = new Set<string>();
  const stack: string[] = [];
  const inStack = new Map<string, number>();

  const dfs = (u: string) => {
    if (cycles.length >= maxCycles) return;
    visitedGlobal.add(u);
    inStack.set(u, stack.length);
    stack.push(u);

    for (const v of adj.get(u) ?? []) {
      if (cycles.length >= maxCycles) break;
      const idx = inStack.get(v);
      if (idx !== undefined) {
        const rawLoop = stack.slice(idx);
        if (rawLoop.length >= 2 && rawLoop.length <= 6) {
          // Canonicalize rotation by lexicographically smallest path
          let minIdx = 0;
          for (let i = 1; i < rawLoop.length; i++) {
            if (rawLoop[i] < rawLoop[minIdx]) minIdx = i;
          }
          const rotated = [...rawLoop.slice(minIdx), ...rawLoop.slice(0, minIdx)];
          const key = rotated.join("->");
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            cycles.push({ paths: [...rotated, rotated[0]] });
          }
        }
      } else if (!visitedGlobal.has(v)) {
        dfs(v);
      }
    }

    stack.pop();
    inStack.delete(u);
  };

  for (const n of nodes) {
    if (!visitedGlobal.has(n)) dfs(n);
    if (cycles.length >= maxCycles) break;
  }

  return cycles;
}

// ---- Build Complete Code Map from In-Memory Tree & Blobs ----

export function buildBlobUrl(repoUrl: string, commitSha: string, path: string): string {
  const cleanUrl = repoUrl.replace(/\/+$/, "");
  if (!cleanUrl.startsWith("https://github.com/")) return "";
  if (cleanUrl.startsWith("https://github.com/local/")) return "";
  const ref = commitSha && commitSha !== "local-workspace" ? commitSha : "HEAD";
  const cleanPath = path.replace(/^\/+/, "");
  return `${cleanUrl}/blob/${encodeURIComponent(ref)}/${cleanPath.split("/").map(encodeURIComponent).join("/")}`;
}

export function buildCodeMapFromMemory(options: BuildCodeMapOptions): RepoCodeMap {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const allTreePaths = options.treeEntries.map((e) => e.path);
  const candidateEntries = options.treeEntries.filter(
    (e) => !isNoiseTreePath(e.path, e.size) && detectSourceLanguage(e.path) !== null,
  );
  const sizeByPath = new Map(options.treeEntries.map((e) => [e.path, e.size]));

  // Layer distribution across ALL candidate source files in the tree
  const layerTreeCounts = new Map<RepoCodeLayer, { fileCount: number; analyzedCount: number; samplePaths: string[] }>();
  const langCounts = new Map<string, number>();

  for (const entry of candidateEntries) {
    const lang = detectSourceLanguage(entry.path);
    if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    const layer = classifyFileLayer(entry.path);
    const cur = layerTreeCounts.get(layer) ?? { fileCount: 0, analyzedCount: 0, samplePaths: [] };
    cur.fileCount++;
    if (cur.samplePaths.length < 4) cur.samplePaths.push(entry.path);
    layerTreeCounts.set(layer, cur);
  }

  const { resolveImport } = buildImportResolver(allTreePaths, options.repoFullName);

  const fileNodesMap = new Map<string, RepoCodeMapFileNode>();
  const edges: RepoCodeMapEdge[] = [];
  const edgeKeys = new Set<string>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const extDepCounts = new Map<string, number>();

  for (const [path, content] of options.blobs.entries()) {
    const lang = detectSourceLanguage(path) ?? "Unknown";
    const layer = classifyFileLayer(path, content);
    const parsed = parseSourceFileStatic(path, content);

    const extImportsSet = new Set<string>();
    for (const imp of parsed.imports) {
      const target = resolveImport(path, imp, lang);
      if (target && target !== path) {
        const ek = `${path}->${target}`;
        if (!edgeKeys.has(ek)) {
          edgeKeys.add(ek);
          edges.push({
            from: path,
            to: target,
            specifier: imp.specifier,
            ...(imp.symbols.length ? { symbols: imp.symbols } : {}),
          });
          outDegree.set(path, (outDegree.get(path) ?? 0) + 1);
          inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
        }
      } else {
        const extPkg = normalizeExternalPackageName(imp.specifier, lang);
        if (extPkg) {
          extImportsSet.add(extPkg);
          extDepCounts.set(extPkg, (extDepCounts.get(extPkg) ?? 0) + 1);
        }
      }
    }

    const lineCount = content ? content.split(/\r?\n/).length : 0;
    const sizeBytes = sizeByPath.get(path) ?? Buffer.byteLength(content, "utf8");
    const layerStat = layerTreeCounts.get(layer) ?? { fileCount: 1, analyzedCount: 0, samplePaths: [] };
    layerStat.analyzedCount++;
    if (!layerStat.samplePaths.includes(path) && layerStat.samplePaths.length < 4) {
      layerStat.samplePaths.push(path);
    }
    layerTreeCounts.set(layer, layerStat);

    fileNodesMap.set(path, {
      path,
      layer,
      language: lang,
      sizeBytes,
      lineCount,
      importsCount: 0,
      importedByCount: 0,
      externalImports: [...extImportsSet].slice(0, 12),
      exportedSymbols: parsed.exportedSymbols,
      url: buildBlobUrl(options.repoUrl, options.commitSha, path),
    });
  }

  // Attach degree counts to every analyzed file node
  const files: RepoCodeMapFileNode[] = [...fileNodesMap.values()].map((f) => ({
    ...f,
    importsCount: outDegree.get(f.path) ?? 0,
    importedByCount: inDegree.get(f.path) ?? 0,
  }));

  // Also include un-fetched high-in-degree files referenced by multiple analyzed files as virtual hotspots if needed
  const hotspotCandidates: Array<{
    path: string;
    layer: RepoCodeLayer;
    language: string;
    importedByCount: number;
    importsCount: number;
    lineCount: number;
    exportedSymbols: RepoCodeExportSymbol[];
    url: string;
    score: number;
  }> = [];

  const layerHotspotBonus: Record<RepoCodeLayer, number> = {
    core: 3.4,
    protocol: 3.1,
    entry: 2.3,
    infra: 2.6,
    storage: 2.3,
    ui: 1.1,
    other: 0.6,
    config: 0.3,
    test: -2.0,
  };

  const isUtilityBoilerplate = (p: string): boolean => {
    const low = p.toLowerCase();
    const b = posix.basename(low);
    return (
      /^(?:legacy|deprecated|utils?|helpers?|exceptions?|errors?|compat|logger|logging|constants?)\.[a-z]+$/.test(b) ||
      /(?:^|\/)(?:logger|logging|telemetry|codemod|legacy)\//.test(low)
    );
  };

  for (const f of files) {
    if (f.layer === "test" && files.length > 6) continue;
    const utilDamp = isUtilityBoilerplate(f.path) ? 0.38 : 1;
    const symScore = Math.min(f.exportedSymbols.length, 14) * 1.25 * utilDamp;
    const inScore = f.importedByCount * 4.5 * utilDamp;
    const outScore = Math.min(f.importsCount, 12) * 0.55;
    const lineBonus = f.lineCount >= 40 && f.lineCount <= 1200 ? 1.2 : f.lineCount > 1200 ? 0.8 : 0.2;
    const utilPenalty = utilDamp < 1 ? -4.5 : 0;
    const score = Math.round((inScore + symScore + outScore + layerHotspotBonus[f.layer] + lineBonus + utilPenalty) * 100) / 100;
    hotspotCandidates.push({
      path: f.path,
      layer: f.layer,
      language: f.language,
      importedByCount: f.importedByCount,
      importsCount: f.importsCount,
      lineCount: f.lineCount,
      exportedSymbols: f.exportedSymbols,
      url: f.url,
      score,
    });
  }

  // Add un-fetched targets with >= 2 incoming edges (preferring non-utility architectural files)
  for (const [targetPath, deg] of inDegree.entries()) {
    if (fileNodesMap.has(targetPath) || deg < 2) continue;
    const lang = detectSourceLanguage(targetPath) ?? "Unknown";
    const layer = classifyFileLayer(targetPath);
    if (layer === "test") continue;
    const utilDamp = isUtilityBoilerplate(targetPath) ? 0.38 : 1;
    const score = Math.round((deg * 3.6 * utilDamp + layerHotspotBonus[layer] + (utilDamp < 1 ? -4 : 0)) * 100) / 100;
    hotspotCandidates.push({
      path: targetPath,
      layer,
      language: lang,
      importedByCount: deg,
      importsCount: 0,
      lineCount: 0,
      exportedSymbols: [],
      url: buildBlobUrl(options.repoUrl, options.commitSha, targetPath),
      score,
    });
  }

  hotspotCandidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.importedByCount - a.importedByCount ||
      b.exportedSymbols.length - a.exportedSymbols.length ||
      a.path.localeCompare(b.path),
  );

  const hotspots: RepoCodeMapHotspot[] = hotspotCandidates.slice(0, 12).map((h) => {
    const layerLabel = REPO_CODE_LAYER_LABELS[h.layer];
    const parts: string[] = [];
    if (h.importedByCount > 0) {
      parts.push(`被 ${h.importedByCount} 个文件引用`);
    } else if (h.importsCount > 0) {
      parts.push(`编排引用 ${h.importsCount} 个内部模块`);
    }
    parts.push(`${layerLabel}枢纽`);
    if (h.exportedSymbols.length > 0) {
      const topNames = h.exportedSymbols.slice(0, 3).map((s) => s.name).join(" / ");
      parts.push(`导出 ${topNames}${h.exportedSymbols.length > 3 ? ` 等 ${h.exportedSymbols.length} 个符号` : ""}`);
    }
    return {
      path: h.path,
      layer: h.layer,
      language: h.language,
      score: h.score,
      importedByCount: h.importedByCount,
      importsCount: h.importsCount,
      lineCount: h.lineCount,
      exportedSymbols: h.exportedSymbols.slice(0, 14),
      startReadingReason: parts.join(" · "),
      url: h.url,
    };
  });

  // Key Interfaces from top hotspots & protocol/core files
  const keyInterfaces: RepoCodeMapKeyInterface[] = [];
  const seenIface = new Set<string>();
  const interfaceRank: Record<RepoCodeSymbolKind, number> = {
    interface: 5,
    trait: 5,
    class: 4,
    struct: 4,
    type: 3,
    enum: 3,
    function: 2,
    const: 1,
    module: 1,
  };

  for (const h of hotspots) {
    const rankedSyms = [...h.exportedSymbols].sort(
      (a, b) => (interfaceRank[b.kind] ?? 0) - (interfaceRank[a.kind] ?? 0),
    );
    for (const sym of rankedSyms.slice(0, 4)) {
      if (keyInterfaces.length >= 24) break;
      const k = `${h.path}:${sym.name}`;
      if (seenIface.has(k)) continue;
      seenIface.add(k);
      keyInterfaces.push({
        path: h.path,
        layer: h.layer,
        name: sym.name,
        kind: sym.kind,
        signature: sym.signature || `${sym.kind} ${sym.name}`,
        url: h.url,
      });
    }
    if (keyInterfaces.length >= 24) break;
  }

  const cycles = detectImportCycles(edges, 12);

  const totalCandidateCount = Math.max(1, candidateEntries.length);
  const layerOrder: RepoCodeLayer[] = [
    "entry",
    "core",
    "protocol",
    "storage",
    "infra",
    "ui",
    "config",
    "test",
    "other",
  ];
  const layers: RepoCodeMapLayerSummary[] = layerOrder
    .map((layer) => {
      const stat = layerTreeCounts.get(layer);
      if (!stat || (stat.fileCount === 0 && stat.analyzedCount === 0)) return null;
      return {
        layer,
        label: REPO_CODE_LAYER_LABELS[layer],
        fileCount: stat.fileCount,
        analyzedCount: stat.analyzedCount,
        share: Math.round((stat.fileCount / totalCandidateCount) * 1000) / 1000,
        samplePaths: stat.samplePaths,
      };
    })
    .filter((x): x is RepoCodeMapLayerSummary => x !== null);

  const primaryLanguages = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([language, count]) => ({ language, count }));

  const topExternalDeps = [...extDepCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([name, count]) => ({ name, count }));

  const idHash = createHash("sha256")
    .update(`${options.nodeId}:${options.commitSha}`)
    .digest("hex")
    .slice(0, 16);

  return {
    id: `cmap_${idHash}`,
    nodeId: options.nodeId,
    repoFullName: options.repoFullName,
    commitSha: options.commitSha,
    defaultBranch: options.defaultBranch,
    source: options.source,
    zeroLocalClone: true,
    diskBytesCloned: 0,
    totalTreeFiles: options.treeEntries.length,
    candidateSourceFiles: candidateEntries.length,
    analyzedFileCount: files.length,
    edgeCount: edges.length,
    cycleCount: cycles.length,
    primaryLanguages,
    layers,
    hotspots,
    files: files.sort((a, b) => b.importedByCount - a.importedByCount || b.exportedSymbols.length - a.exportedSymbols.length),
    edges: edges.slice(0, 240),
    cycles,
    keyInterfaces,
    topExternalDeps,
    focusPaths: options.focusPaths ?? [],
    cached: false,
    fetchDurationMs: options.fetchDurationMs ?? 0,
    generatedAt: nowIso,
    updatedAt: nowIso,
  };
}

export function findUnfetchedHotspotTargets(
  treeEntries: RemoteTreeEntry[],
  blobs: Map<string, string>,
  repoFullName: string,
  maxExtra = 10,
): string[] {
  const allPaths = treeEntries.map((e) => e.path);
  const sizeByPath = new Map(treeEntries.map((e) => [e.path, e.size]));
  const { resolveImport } = buildImportResolver(allPaths, repoFullName);
  const inDegree = new Map<string, number>();

  for (const [path, content] of blobs.entries()) {
    const lang = detectSourceLanguage(path);
    if (!lang) continue;
    const parsed = parseSourceFileStatic(path, content);
    const seenTargets = new Set<string>();
    for (const imp of parsed.imports) {
      const target = resolveImport(path, imp, lang);
      if (target && target !== path && !seenTargets.has(target)) {
        seenTargets.add(target);
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }
  }

  return [...inDegree.entries()]
    .filter(([p, deg]) => {
      if (blobs.has(p) || deg < 2) return false;
      const sz = sizeByPath.get(p) ?? 0;
      if (isNoiseTreePath(p, sz) || !detectSourceLanguage(p)) return false;
      if (classifyFileLayer(p) === "test") return false;
      return true;
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxExtra)
    .map(([p]) => p);
}

export function summarizeCodeMapBrief(codeMap: RepoCodeMap): RepoCodeMapBrief {
  return {
    id: codeMap.id,
    nodeId: codeMap.nodeId,
    repoFullName: codeMap.repoFullName,
    commitSha: codeMap.commitSha,
    source: codeMap.source,
    zeroLocalClone: true,
    diskBytesCloned: 0,
    totalTreeFiles: codeMap.totalTreeFiles,
    analyzedFileCount: codeMap.analyzedFileCount,
    edgeCount: codeMap.edgeCount,
    cycleCount: codeMap.cycleCount,
    hotspotCount: codeMap.hotspots.length,
    cached: codeMap.cached,
    generatedAt: codeMap.generatedAt,
  };
}

// ---- Zero-Clone Remote GitHub Fetcher (Trees REST + GraphQL Batch Blobs, ZERO local disk clone) ----

function isTransientGhErr(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const stderr =
    err && typeof err === "object" && "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
  return /HTTP\s+50[234]|502\s+Bad\s+Gateway|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|timed?\s*out/i.test(
    `${msg}\n${stderr}`,
  );
}

async function execGhApi(args: string[]): Promise<string> {
  const backoffs = [1200, 3000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const { stdout } = await exec("gh", ["api", "--hostname", "github.com", ...args], {
        timeout: 45_000,
        maxBuffer: 48 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      });
      return stdout;
    } catch (err) {
      lastErr = err;
      if (attempt < backoffs.length && isTransientGhErr(err)) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function createGhCodeMapFetcher(): CodeMapRemoteFetcher {
  return {
    async resolveHeadCommit(owner: string, name: string, defaultBranch?: string | null) {
      const query = `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            name
            target { oid }
          }
        }
      }`;
      const raw = await execGhApi([
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
      ]);
      const parsed = JSON.parse(raw) as {
        data?: {
          repository?: {
            defaultBranchRef?: { name?: string; target?: { oid?: string } } | null;
          } | null;
        };
        errors?: Array<{ message?: string }>;
      };
      if (parsed.errors?.length && !parsed.data?.repository) {
        throw new Error(parsed.errors.map((e) => e.message).join("; "));
      }
      const ref = parsed.data?.repository?.defaultBranchRef;
      const commitSha = String(ref?.target?.oid ?? "").trim();
      const branch = String(ref?.name ?? defaultBranch ?? "main").trim();
      if (!commitSha) {
        throw new Error(`仓库 ${owner}/${name} 尚无默认分支提交`);
      }
      return { commitSha, defaultBranch: branch };
    },

    async fetchRecursiveTree(owner: string, name: string, ref: string): Promise<RemoteRepoTreeSnapshot> {
      const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
      const raw = await execGhApi([endpoint]);
      const parsed = JSON.parse(raw) as {
        sha?: string;
        truncated?: boolean;
        tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
      };
      const entries: RemoteTreeEntry[] = [];
      for (const item of parsed.tree ?? []) {
        if (item.type !== "blob" || !item.path) continue;
        entries.push({
          path: item.path,
          size: Number(item.size ?? 0),
          sha: item.sha,
        });
      }
      return {
        commitSha: ref.length >= 40 ? ref : String(parsed.sha ?? ref),
        defaultBranch: ref.length >= 40 ? null : ref,
        truncated: Boolean(parsed.truncated),
        entries,
      };
    },

    async fetchBlobsBatch(
      owner: string,
      name: string,
      ref: string,
      paths: string[],
    ): Promise<Map<string, string>> {
      const result = new Map<string, string>();
      if (paths.length === 0) return result;

      // Batch in chunks of 20 aliases per GraphQL request (pure RAM, 0 bytes on disk)
      const chunkSize = 20;
      for (let offset = 0; offset < paths.length; offset += chunkSize) {
        const chunk = paths.slice(offset, offset + chunkSize);
        const fields = chunk
          .map((p, idx) => {
            const expr = JSON.stringify(`${ref}:${p}`);
            return `f${idx}: object(expression: ${expr}) { ... on Blob { text byteSize isBinary } }`;
          })
          .join("\n    ");
        const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
        const raw = await execGhApi([
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
        ]);
        const parsed = JSON.parse(raw) as {
          data?: {
            repository?: Record<string, { text?: string | null; isBinary?: boolean; byteSize?: number } | null>;
          };
        };
        const repoObj = parsed.data?.repository ?? {};
        for (let idx = 0; idx < chunk.length; idx++) {
          const blob = repoObj[`f${idx}`];
          if (blob && !blob.isBinary && typeof blob.text === "string") {
            result.set(chunk[idx], blob.text);
          }
        }
      }
      return result;
    },
  };
}

// ---- Read-Only Local Memory Scanner for local/* Repos (Zero Clone, Zero Write) ----

export async function scanLocalRepoReadOnly(localDir: string): Promise<LocalRepoSnapshot> {
  if (!localDir || !existsSync(localDir)) {
    throw new Error(`本地只读路径不存在：${localDir}`);
  }

  let commitSha = "local-workspace";
  let defaultBranch: string | null = null;
  try {
    const { stdout } = await exec("git", ["-C", localDir, "rev-parse", "--verify", "HEAD^{commit}"], {
      timeout: 5000,
    });
    const sha = stdout.trim();
    if (/^[a-f0-9]{40,64}$/i.test(sha)) commitSha = sha;
  } catch {
    // non-git local directory fallback
  }
  try {
    const { stdout } = await exec("git", ["-C", localDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 5000,
    });
    const b = stdout.trim();
    if (b && b !== "HEAD") defaultBranch = b;
  } catch {
    // ignore
  }

  const entries: RemoteTreeEntry[] = [];
  const maxWalkFiles = 8000;

  const walk = (dir: string, depth: number) => {
    if (depth > 9 || entries.length >= maxWalkFiles) return;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= maxWalkFiles) break;
      const fullPath = join(dir, item.name);
      const rel = relative(localDir, fullPath).split("\\").join("/");
      if (item.isDirectory()) {
        if (IGNORED_DIR_SEGMENTS.has(item.name) || item.name.startsWith(".")) continue;
        walk(fullPath, depth + 1);
      } else if (item.isFile()) {
        let size = 0;
        try {
          size = statSync(fullPath).size;
        } catch {
          continue;
        }
        entries.push({ path: rel, size });
      }
    }
  };

  walk(localDir, 0);

  return {
    commitSha,
    defaultBranch,
    entries,
    readFile: (relPath: string): string | null => {
      const fullPath = join(localDir, relPath);
      try {
        const st = statSync(fullPath);
        if (!st.isFile() || st.size > MAX_SOURCE_FILE_BYTES) return null;
        return readFileSync(fullPath, "utf8");
      } catch {
        return null;
      }
    },
  };
}

// ---- Code-Map-Grounded Link Module Analysis (Zero-Clone Source-Level Comparison) ----

function layerAffinity(src: RepoCodeLayer, tgt: RepoCodeLayer): number {
  if (src === tgt) return 10;
  const pairs: Record<string, number> = {
    "core:entry": 7,
    "entry:core": 7,
    "protocol:core": 8,
    "core:protocol": 8,
    "infra:core": 7,
    "core:infra": 7,
    "storage:core": 7,
    "core:storage": 7,
    "protocol:entry": 6,
    "ui:entry": 6,
    "ui:protocol": 5,
  };
  return pairs[`${src}:${tgt}`] ?? 2;
}

function tokenOverlap(a: string, b: string): number {
  const toksA = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  const toksB = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  let hit = 0;
  for (const t of toksA) if (toksB.has(t)) hit++;
  return hit;
}

export function buildCodeMapGroundedModuleAnalysis(input: {
  source: RepoEvolutionNode;
  target: RepoEvolutionNode;
  relationType: RepoRelationType;
  sourceCodeMap: RepoCodeMap | null;
  targetCodeMap: RepoCodeMap | null;
  sourceContent: RepoContent | null;
  targetContent: RepoContent | null;
}): { rationale: string; items: RepoModuleAnalysisItem[] } {
  const { source, target, relationType, sourceCodeMap, targetCodeMap, sourceContent, targetContent } = input;
  const srcHotspots = sourceCodeMap?.hotspots ?? [];
  const tgtHotspots = targetCodeMap?.hotspots ?? [];

  if (srcHotspots.length === 0) {
    return { rationale: "", items: [] };
  }

  const srcRef = sourceCodeMap?.commitSha || sourceContent?.ref || source.defaultBranch || "main";
  const tgtRef = targetCodeMap?.commitSha || targetContent?.ref || target.defaultBranch || "main";

  const selectedSourceHotspots = srcHotspots.slice(0, 3);
  const usedTargetPaths = new Set<string>();
  const items: RepoModuleAnalysisItem[] = [];

  for (let idx = 0; idx < selectedSourceHotspots.length; idx++) {
    const sh = selectedSourceHotspots[idx];
    const srcSymNames = sh.exportedSymbols.slice(0, 5).map((s) => s.name);
    const srcSigPreview = sh.exportedSymbols
      .slice(0, 2)
      .map((s) => s.signature || `${s.kind} ${s.name}`)
      .join("；");

    // Pick best matching target hotspot (preferring un-used hotspot with high layer + token affinity)
    let bestTarget: RepoCodeMapHotspot | null = null;
    let bestScore = -1;
    const srcText = `${sh.path} ${srcSymNames.join(" ")}`;
    for (const th of tgtHotspots) {
      const tgtText = `${th.path} ${th.exportedSymbols.map((s) => s.name).join(" ")}`;
      const score =
        layerAffinity(sh.layer, th.layer) +
        tokenOverlap(srcText, tgtText) * 4 +
        (usedTargetPaths.has(th.path) ? -3.5 : 2) +
        Math.min(th.importedByCount, 6) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = th;
      }
    }
    if (bestTarget) usedTargetPaths.add(bestTarget.path);

    const tgtPath = bestTarget?.path ?? (target.readmeDigest?.keyModules?.[0] || "src/");
    const tgtSymNames = bestTarget?.exportedSymbols.slice(0, 5).map((s) => s.name) ?? [];
    const tgtLayer = bestTarget?.layer ?? sh.layer;

    const srcLayerLabel = REPO_CODE_LAYER_LABELS[sh.layer];
    const tgtLayerLabel = REPO_CODE_LAYER_LABELS[tgtLayer];
    const crossLanguage = Boolean(
      sh.language &&
        bestTarget?.language &&
        sh.language !== bestTarget.language &&
        !(
          (sh.language === "TypeScript" && bestTarget.language === "JavaScript") ||
          (sh.language === "JavaScript" && bestTarget.language === "TypeScript")
        ),
    );

    const srcSymDesc = srcSymNames.length
      ? `核心导出符号 \`${srcSymNames.join("`, `")}\``
      : `核心模块逻辑（被 ${sh.importedByCount} 个内部文件依赖）`;
    const tgtSymDesc = tgtSymNames.length
      ? `现有承载符号 \`${tgtSymNames.join("`, `")}\``
      : `${tgtLayerLabel}承载目录 \`${tgtPath}\``;

    const absorbableMechanism =
      `【${srcLayerLabel}热点 · 入度 ${sh.importedByCount}】${source.name} 在 \`${sh.path}\` 中通过 ${srcSymDesc} 统一封装关键能力` +
      (srcSigPreview ? `（接口形态：${srcSigPreview}）` : "") +
      `。该模块处于 ${source.name} 的 ${sh.layer} 关键路径（${sh.lineCount > 0 ? `${sh.lineCount} 行` : "高频被引用"}），可提取其契约边界与状态编排范式用于 ${relationType}。`;

    const srcOnlyDeps = (sourceCodeMap?.topExternalDeps ?? [])
      .map((d) => d.name)
      .filter((d) => !(targetCodeMap?.topExternalDeps ?? []).some((td) => td.name === d))
      .slice(0, 3);

    const currentGap =
      `${target.name} 当前在 \`${tgtPath}\`（${tgtSymDesc}，入度 ${bestTarget?.importedByCount ?? 0}）尚未形成同等粒度的 ${srcLayerLabel} 边界抽象` +
      (crossLanguage ? `，且源仓为 ${sh.language}、目标仓为 ${bestTarget?.language ?? target.primaryLanguage}，需做跨语言协议转译` : "") +
      (srcOnlyDeps.length ? `；源仓依赖栈包含 ${srcOnlyDeps.join(" / ")} 支撑该机制，目标仓需评估零依赖自研或轻量替代。` : "。");

    const steps = [
      `精读源仓热点 \`${sh.path}\`（重点对照 ${srcSymNames.slice(0, 3).join(" / ") || "核心导出入口"}），抽出不依赖宿主框架的纯协议/状态机契约。`,
      `在 ${target.name} 的 \`${tgtPath}\` 旁新增可插拔适配层，保留 ${tgtSymNames[0] ? `\`${tgtSymNames[0]}\`` : "现有主流程"} 向后兼容签名，以特性开关灰度切换。`,
      `补充确定性单测与边界回归用例（覆盖异常重试、超时中断与并发竞争），确认无新增循环依赖（源仓 cycles=${sourceCodeMap?.cycleCount ?? 0}，目标仓 cycles=${targetCodeMap?.cycleCount ?? 0}）。`,
    ];

    const acceptanceCriteria = [
      `\`${tgtPath}\` 对应能力接口可通过静态类型检查与自动化单测，关键路径零回归`,
      `新引入抽象不增加模块循环依赖，且可在关闭特性开关时 1 步回滚至原实现`,
      `与源仓 \`${sh.path}\` 核心契约能力对齐度经样本用例验证通过`,
    ];

    const adaptationPlan = steps.map((s, i) => `${i + 1}) ${s}`).join(" ");

    const effort: RepoModuleEffort = crossLanguage
      ? "L"
      : sh.importedByCount >= 6 || sh.lineCount >= 450
        ? "M"
        : "S";
    const risk: RepoModuleRisk =
      crossLanguage || (bestTarget?.importedByCount ?? 0) >= 6
        ? "high"
        : sh.layer === "core" || sh.layer === "protocol" || sh.layer === "infra"
          ? "medium"
          : "low";

    const evidenceLinks: RepoEvidenceLink[] = [];
    const srcUrl = sh.url || buildBlobUrl(source.url, srcRef, sh.path);
    if (srcUrl) {
      evidenceLinks.push({
        label: `${source.fullName}:${sh.path}`,
        url: srcUrl,
        path: sh.path,
      });
    }
    const tgtUrl = bestTarget?.url || buildBlobUrl(target.url, tgtRef, tgtPath);
    if (tgtUrl) {
      evidenceLinks.push({
        label: `${target.fullName}:${tgtPath}`,
        url: tgtUrl,
        path: tgtPath,
      });
    }

    items.push({
      id: `mod_${randomUUID().slice(0, 8)}`,
      sourceModulePath: sh.path,
      targetModulePath: tgtPath,
      absorbableMechanism,
      currentGap,
      adaptationPlan,
      effort,
      risk,
      evidenceLinks,
      sourceSymbols: srcSymNames,
      targetSymbols: tgtSymNames,
      sourceLayer: sh.layer,
      targetLayer: tgtLayer,
      steps,
      acceptanceCriteria,
      groundedByCodeMap: true,
    });
  }

  const topSrcPaths = items.map((i) => `\`${i.sourceModulePath}\``).join("、");
  const topTgtPaths = [...new Set(items.map((i) => `\`${i.targetModulePath}\``))].join("、");
  const rationale =
    `基于零克隆 Code Map 实测（源仓解析 ${sourceCodeMap?.analyzedFileCount ?? 0} 个文件/${sourceCodeMap?.edgeCount ?? 0} 条依赖边，目标仓解析 ${targetCodeMap?.analyzedFileCount ?? 0} 个文件/${targetCodeMap?.edgeCount ?? 0} 条依赖边），锁定 ${source.fullName} 热点 ${topSrcPaths} 到 ${target.fullName} 落点 ${topTgtPaths} 的 ${items.length} 项源码级吸收改造方案。`;

  return { rationale, items };
}

export function buildCodeMapLinkLlmPrompt(input: {
  source: RepoEvolutionNode;
  target: RepoEvolutionNode;
  sourceCodeMap: RepoCodeMap | null;
  targetCodeMap: RepoCodeMap | null;
  sourceContent: RepoContent | null;
  targetContent: RepoContent | null;
}): string {
  const { source, target, sourceCodeMap, targetCodeMap, sourceContent, targetContent } = input;
  const formatMapBlock = (label: string, node: RepoEvolutionNode, cm: RepoCodeMap | null, content: RepoContent | null) => {
    const lines = [
      `【${label}】${node.fullName} (★${node.starsCount}, lang=${node.primaryLanguage ?? "unknown"}, topics=${node.topics.join(",")})`,
      `简介：${node.description || "(无)"}`,
    ];
    if (cm && cm.hotspots.length > 0) {
      lines.push(
        `零克隆 Code Map（commit=${cm.commitSha.slice(0, 8)}，解析 ${cm.analyzedFileCount}/${cm.candidateSourceFiles} 文件，${cm.edgeCount} 条 import 边，${cm.cycleCount} 个循环依赖）：`,
      );
      lines.push(
        `分层分布：${cm.layers.map((l) => `${l.layer}=${l.fileCount}`).join(", ")}`,
      );
      lines.push("核心热点文件（Hotspots）：");
      for (const h of cm.hotspots.slice(0, 7)) {
        const syms = h.exportedSymbols.slice(0, 6).map((s) => `${s.kind}:${s.name}`).join(", ");
        lines.push(`  - ${h.path} [${h.layer}, in=${h.importedByCount}, out=${h.importsCount}, lines=${h.lineCount}] 符号: ${syms || "(internal)"}`);
      }
      if (cm.keyInterfaces.length > 0) {
        lines.push("关键导出签名：");
        for (const ki of cm.keyInterfaces.slice(0, 8)) {
          lines.push(`  - ${ki.path} :: ${ki.signature}`);
        }
      }
      if (cm.topExternalDeps.length > 0) {
        lines.push(`主要外部依赖：${cm.topExternalDeps.slice(0, 8).map((d) => d.name).join(", ")}`);
      }
    } else if (content) {
      const files = content.files.slice(0, 25).map((f) => (f.directory ? `${f.name}/` : f.name));
      lines.push(`根目录：${files.join(", ")}`);
      lines.push(`README 摘录：${(content.readme?.text ?? "").slice(0, 1200)}`);
    }
    return lines.join("\n");
  };

  return [
    `请基于以下两个仓库的真实零克隆 Code Map（精确文件路径、入度热点、导出符号与接口签名），产出 2~4 条源码级可落地的吸收提升方案。`,
    `严禁泛泛而谈或编造文件路径！每一条方案必须精确引用下面列出的真实文件路径与真实导出符号，并给出清晰差距、分步改造建议与可验证的验收标准。`,
    "",
    formatMapBlock("源参考 Star 仓库", source, sourceCodeMap, sourceContent),
    "",
    formatMapBlock("目标自有仓库", target, targetCodeMap, targetContent),
    "",
    `严格输出 JSON 对象：{"rationale":"一句话核心价值总结","modules":[{"sourceModulePath":"真实源仓文件路径","targetModulePath":"真实目标仓文件路径","sourceSymbols":["真实符号1"],"targetSymbols":["真实目标符号1"],"absorbableMechanism":"...","currentGap":"...","adaptationPlan":"...","steps":["步骤1","步骤2","步骤3"],"acceptanceCriteria":["验收标准1","验收标准2"],"effort":"S|M|L","risk":"low|medium|high","evidenceLinks":[{"label":"...","url":"https://github.com/...","path":"..."}]}]}`,
  ].join("\n");
}
