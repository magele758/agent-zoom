import { createHash } from "node:crypto";
import { existsSync, openSync, closeSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import type {
  CliCategoryBreakdown,
  CliLedgerOverview,
  CliLedgerPromoteResult,
  CliProgressStage,
  CliProjectBreakdown,
  CliProviderBreakdown,
  CliProviderId,
  CliSessionDetail,
  CliSessionStatus,
  CliSessionSummary,
  CliToolCount,
  CliTurnItem,
} from "../cli-ledger-types.ts";
import {
  WORKSPACE_CATEGORIES,
  WORKSPACE_CATEGORY_LABELS,
  type WorkOriginDetail,
  type WorkOriginTrack,
  type WorkspaceCategory,
  type WorkspaceClassification,
} from "../workspace-classification-types.ts";
import { ApiError } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";
import {
  clearWorkspaceGitCache,
  detectWorkOrigin,
  resolveCanonicalWorkspace,
} from "./workspace-classifier.ts";

export interface LiveSessionInput {
  provider: string;
  workspace: string | null;
  canonicalWorkspace?: string | null;
  state: string;
  updatedAt: string | null;
  address?: string | null;
  title?: string | null;
  spaceName?: string | null;
  parent?: string | null;
  name?: string | null;
  labels?: Record<string, string>;
  originTrack?: WorkOriginTrack;
  originDetail?: WorkOriginDetail;
}

export interface CliLedgerHooks {
  promoteToTask?: (input: {
    title: string;
    description: string;
    project: string;
    sourceRef: string;
    tags: string[];
    session?: CliSessionSummary;
  }) => { id: string; project: string; title: string; alreadyLinked?: boolean };
  bindToTask?: (
    taskId: string,
    session: CliSessionSummary,
  ) => { id: string; project: string; title: string };
  findLinkedTask?: (input: {
    sessionId: string;
    herdrAddress?: string | null;
  }) => { id: string; title: string; status: string; project: string } | null;
  classifyWorkspace?: (input: {
    workspace?: string | null;
    repository?: string | null;
    projectHint?: string | null;
    spaceName?: string | null;
  }) => WorkspaceClassification;
  getLiveSessions?: () => LiveSessionInput[];
}

export interface CliLedgerOptions {
  homeDir?: string;
  hubDbPath?: string;
  hooks?: CliLedgerHooks;
  now?: () => number;
}

export interface RegisterCliLedgerOptions extends CliLedgerOptions {
  submitToken?: string;
}

export interface CliLedgerQuery {
  days?: number;
  provider?: string;
  project?: string;
  category?: string;
  origin?: string;
  status?: string;
  q?: string;
  limit?: number;
  refresh?: boolean;
}

type SourceScanStatus = CliLedgerOverview["sources"][number];

interface HubEnrichment {
  cwd: string | null;
  project: string | null;
  tokens: number;
  summary: string | null;
}

interface RawTurnBuilder {
  at: string | null;
  userInstruction: string;
  thinkingParts: string[];
  toolCounts: Map<string, number>;
  filesTouched: Set<string>;
  filesModified: Set<string>;
  rawAbsPaths: Set<string>;
  commandsRun: number;
  hasWriteTool: boolean;
  hasVerifyCommand: boolean;
  outcomeParts: string[];
  aborted: boolean;
  lastStepError: boolean;
}

interface ParsedSessionDraft {
  rawSessionId: string;
  providerId: CliProviderId;
  titleHint: string | null;
  summaryHint: string | null;
  workspace: string | null;
  encodedWorkspace?: string | null;
  projectHint: string | null;
  repository: string | null;
  branch: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  tokensTotal: number;
  summaryFilesHint: number;
  turns: RawTurnBuilder[];
  extraAbsPaths: Set<string>;
  sourcePath: string;
  lookupIds: string[];
}

const MS_PER_DAY = 86_400_000;
const LIVE_RECENT_MS = 4 * 60 * 1000;
const RUNNING_NO_REPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 12_000;
const DETAIL_CACHE_MAX = 200;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const HEAD_SLICE_BYTES = 1 * 1024 * 1024;
const TAIL_SLICE_BYTES = 3 * 1024 * 1024;

const PROVIDER_LABELS: Record<CliProviderId, string> = {
  antigravity: "Antigravity CLI",
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok CLI",
  cursor: "Cursor Agent",
  opencode: "OpenCode",
  other: "Coding CLI",
};

const ALL_PROVIDER_IDS: CliProviderId[] = [
  "antigravity",
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
];

const COMMAND_TOOL_RE =
  /^(?:run_command|bash|shell|exec_command|shell_command|terminal|execute_command|run_terminal_cmd|exec|command|sh|run_shell_command)$/i;

const WRITE_TOOL_RE =
  /(?:edit|write|replace|patch|apply_patch|create_file|delete_file|update_file|insert_text|notebook_?edit|str_replace|multiedit)/i;

const VERIFY_CMD_RE =
  /\b(?:test|vitest|jest|pytest|typecheck|tsc|build|lint|eslint|check|cargo\s+test|go\s+test|npm\s+run\s+(?:test|build|typecheck|lint)|pnpm\s+(?:test|build|typecheck|lint)|tsx\s+--test)\b/i;

const WAITING_PROMPT_RE =
  /(?:请确认|请你确认|是否需要|是否继续|请选择|需要你|你希望|请问|你觉得|要不要|确认一下|等待你的|回复我|please confirm|would you like|do you want|which option|let me know|awaiting your|should i proceed|need your approval)/i;

const BLOCKED_OUTCOME_RE =
  /(?:无法继续|已被阻塞|阻塞了|执行失败|报错无法|blocked by|cannot proceed|fatal error|failed to complete|unrecoverable error)/i;

const RESOLVED_OUTCOME_RE = /(?:已修复|已解决|通过验证|全部通过|fixed|resolved|passed|completed)/i;

const GENERIC_TITLES = new Set([
  "new chat",
  "new session",
  "untitled",
  "untitled session",
  "chat",
  "session",
  "conversation",
]);

/** Redact API keys, JWTs, Bearer tokens, credentials and Feishu webhooks across all text fields. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  // Feishu / Lark bot webhook URLs
  out = out.replace(
    /https?:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[^\s"'`<>)\]]+/gi,
    "[REDACTED]",
  );
  out = out.replace(
    /open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[^\s"'`<>)\]]+/gi,
    "[REDACTED]",
  );
  // Bearer tokens
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
  // JWT tokens
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]");
  // Provider API keys & cloud tokens
  out = out.replace(/(?<![A-Za-z0-9_])(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
  out = out.replace(/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{16,})/g, "[REDACTED]");
  out = out.replace(/(?<![A-Za-z0-9_])xox[a-zA-Z]-[A-Za-z0-9-]{8,}/g, "[REDACTED]");
  out = out.replace(/(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}/g, "[REDACTED]");
  // Key-value secret assignments (token=..., password=..., api_key=..., secret=...)
  out = out.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd)\s*([:=])\s*(?!\[REDACTED\])("[^"\n]*"|'[^'\n]*'|[^\s,;)'"`<>]+)/gi,
    "$1$2[REDACTED]",
  );
  return out;
}

function normalizeProviderId(raw: string | null | undefined): CliProviderId | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key || key === "all") return null;
  if (key === "antigravity" || key === "antigravity-cli" || key === "antigravity cli" || key === "agy") {
    return "antigravity";
  }
  if (key === "codex" || key === "codex-cli" || key === "codex cli") return "codex";
  if (key === "claude" || key === "claude-code" || key === "claude code" || key === "claude-desktop") {
    return "claude";
  }
  if (key === "grok" || key === "grok-cli" || key === "grok cli" || key === "grok-build") return "grok";
  if (key === "cursor" || key === "cursor-agent" || key === "cursor agent" || key === "cursor-cloud") {
    return "cursor";
  }
  if (key === "opencode" || key === "open-code") return "opencode";
  if (key === "other") return "other";
  return null;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Distinguish epoch seconds vs epoch milliseconds
    if (value < 1e12 && value > 1e8) return Math.trunc(value * 1000);
    if (value >= 1e12 && value < 1e16) return Math.trunc(value);
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{10,16}$/.test(trimmed)) return normalizeTimestampMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizeTimestamp(value: unknown): string | null {
  const ms = normalizeTimestampMs(value);
  return ms !== null ? new Date(ms).toISOString() : null;
}

function normalizeWorkspace(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\x00-\x1f]/.test(trimmed) || !isAbsolute(trimmed)) return null;
  const norm = normalize(trimmed).replace(/\/+$/, "");
  return norm || "/";
}

function cleanText(raw: string, maxLen?: number): string {
  const redacted = redactSecrets(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!maxLen || redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function truncateOneLine(raw: string, maxLen: number): string {
  const collapsed = redactSecrets(raw).replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function makeSessionId(providerId: CliProviderId, rawSessionId: string, sourcePath: string): string {
  const cleanRaw = rawSessionId.trim();
  if (/^[A-Za-z0-9._-]{1,64}$/.test(cleanRaw)) {
    return `${providerId}__${cleanRaw}`;
  }
  const digest = createHash("sha256").update(`${providerId}:${cleanRaw}:${sourcePath}`).digest("hex").slice(0, 16);
  return `${providerId}__${digest}`;
}

function readTextBounded(filePath: string, maxBytes = MAX_TRANSCRIPT_BYTES): string {
  const st = statSync(filePath);
  if (st.size <= maxBytes) {
    return readFileSync(filePath, "utf8");
  }
  const fd = openSync(filePath, "r");
  try {
    const headLen = Math.min(HEAD_SLICE_BYTES, st.size);
    const tailLen = Math.min(TAIL_SLICE_BYTES, Math.max(0, st.size - headLen));
    const headBuf = Buffer.allocUnsafe(headLen);
    const headRead = readSync(fd, headBuf, 0, headLen, 0);
    const headStr = headBuf.subarray(0, headRead).toString("utf8");
    const lastHeadNl = headStr.lastIndexOf("\n");
    const cleanHead = lastHeadNl >= 0 ? headStr.slice(0, lastHeadNl) : headStr;

    if (tailLen <= 0) return cleanHead;
    const tailBuf = Buffer.allocUnsafe(tailLen);
    const tailRead = readSync(fd, tailBuf, 0, tailLen, st.size - tailLen);
    const tailStr = tailBuf.subarray(0, tailRead).toString("utf8");
    const firstTailNl = tailStr.indexOf("\n");
    const cleanTail = firstTailNl >= 0 ? tailStr.slice(firstTailNl + 1) : tailStr;
    return `${cleanHead}\n${cleanTail}`;
  } finally {
    closeSync(fd);
  }
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName));
  } catch {
    return false;
  }
}

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    return new Set(rows.map((r) => String(r.name ?? "")));
  } catch {
    return new Set();
  }
}

function createTurnBuilder(userInstruction: string, at: string | null): RawTurnBuilder {
  return {
    at,
    userInstruction,
    thinkingParts: [],
    toolCounts: new Map<string, number>(),
    filesTouched: new Set<string>(),
    filesModified: new Set<string>(),
    rawAbsPaths: new Set<string>(),
    commandsRun: 0,
    hasWriteTool: false,
    hasVerifyCommand: false,
    outcomeParts: [],
    aborted: false,
    lastStepError: false,
  };
}

function isIgnoredPath(candidate: string): boolean {
  if (!candidate || candidate.length < 2 || candidate.length > 320) return true;
  if (/^(?:https?|wss?|mailto):/i.test(candidate)) return true;
  if (/^\/(?:dev|proc|sys|bin|sbin|usr\/bin|usr\/sbin|System|Library)\b/.test(candidate)) return true;
  if (candidate.includes("/.system_generated/") || candidate.includes("/node_modules/")) return true;
  if (candidate.includes("open.feishu.cn/open-apis/")) return true;
  return false;
}

function cleanExtractedPath(raw: string): string | null {
  let p = raw.trim().replace(/^file:\/\//i, "");
  p = p.replace(/^[("'\[`<]+/, "").replace(/[)"'\]`>,;:.!?]+$/, "");
  // Strip line/column suffixes like foo.ts:12:4 or foo.ts#L10-L20
  p = p.replace(/#L\d+(?:-L\d+)?$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (isIgnoredPath(p)) return null;
  if (isAbsolute(p)) {
    const parts = p.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    return normalize(p);
  }
  if (/^(?:src|web|scripts|tests?|lib|app|packages|docs|server|client|api|components|pages|config)\/[A-Za-z0-9._/@-]+$/.test(p)) {
    return p;
  }
  return null;
}

function extractFilePathsFromText(
  text: string,
): { touched: string[]; modified: string[]; absPaths: string[] } {
  const touched = new Set<string>();
  const modified = new Set<string>();
  const absPaths = new Set<string>();
  if (!text) return { touched: [], modified: [], absPaths: [] };
  const sample = text.length > 8192 ? `${text.slice(0, 4096)}\n${text.slice(-4096)}` : text;

  const add = (raw: string, isMod: boolean) => {
    const cleaned = cleanExtractedPath(raw);
    if (!cleaned) return;
    touched.add(cleaned);
    if (isMod) modified.add(cleaned);
    if (isAbsolute(cleaned)) absPaths.add(cleaned);
  };

  // Explicit modification announcements (Antigravity GENERIC outputs, Codex apply_patch, etc.)
  const modPatterns = [
    /Made\s+\d+\s+replacements?\s+in\s+([^\s"'`<>]+)/gi,
    /(?:Created|Updated|Wrote|Edited|Modified|Deleted)\s+(?:file\s+)?([^\s"'`<>]+)/gi,
    /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+([^\n\r]+)/g,
  ];
  for (const re of modPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sample)) !== null) {
      if (m[1]) add(m[1], true);
    }
  }

  // Absolute file paths (macOS / Linux common roots)
  const absRe = /(?:^|[\s"'`(=:,])((?:\/(?:Users|home|var|tmp|opt|workspace|srv|mnt|private\/tmp)\/[^\s"'`<>()[\]{},;]+))/g;
  let absMatch: RegExpExecArray | null;
  while ((absMatch = absRe.exec(sample)) !== null) {
    if (absMatch[1]) add(absMatch[1], false);
  }

  // Relative project source paths
  const relRe =
    /(?:^|[\s"'`(=:,])((?:src|web|scripts|tests?|lib|app|packages|docs|server|client|api|components|pages|config)\/[A-Za-z0-9._/@-]+\.[A-Za-z0-9]{1,8})\b/g;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relRe.exec(sample)) !== null) {
    if (relMatch[1]) add(relMatch[1], false);
  }

  return {
    touched: [...touched],
    modified: [...modified],
    absPaths: [...absPaths],
  };
}

function recordToolInvocation(
  turn: RawTurnBuilder,
  toolNameRaw: string,
  inputVal: unknown,
  extraText?: string,
) {
  const toolName = (toolNameRaw || "tool").trim().slice(0, 80) || "tool";
  turn.toolCounts.set(toolName, (turn.toolCounts.get(toolName) ?? 0) + 1);

  const isCmd = COMMAND_TOOL_RE.test(toolName);
  const isWrite = WRITE_TOOL_RE.test(toolName);
  if (isCmd) turn.commandsRun += 1;
  if (isWrite) turn.hasWriteTool = true;

  const inspectValue = (val: unknown, depth: number) => {
    if (depth > 2 || val === null || val === undefined) return;
    if (typeof val === "string") {
      if (isCmd && VERIFY_CMD_RE.test(val)) turn.hasVerifyCommand = true;
      const trimmed = val.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          inspectValue(JSON.parse(trimmed), depth + 1);
          return;
        } catch {
          // Fall through to text scanning
        }
      }
      const extracted = extractFilePathsFromText(val);
      for (const p of extracted.touched) turn.filesTouched.add(p);
      for (const p of extracted.modified) turn.filesModified.add(p);
      for (const p of extracted.absPaths) turn.rawAbsPaths.add(p);
      if (isWrite) {
        const direct = cleanExtractedPath(val);
        if (direct) {
          turn.filesTouched.add(direct);
          turn.filesModified.add(direct);
          if (isAbsolute(direct)) turn.rawAbsPaths.add(direct);
        }
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val.slice(0, 20)) inspectValue(item, depth + 1);
      return;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const pathKeys = ["file_path", "path", "Path", "TargetFile", "file", "filename", "target", "AbsolutePath"];
      for (const k of pathKeys) {
        if (typeof obj[k] === "string") {
          const cleaned = cleanExtractedPath(obj[k] as string);
          if (cleaned) {
            turn.filesTouched.add(cleaned);
            if (isWrite) turn.filesModified.add(cleaned);
            if (isAbsolute(cleaned)) turn.rawAbsPaths.add(cleaned);
          }
        }
      }
      const cmdKeys = ["command", "cmd", "CommandLine", "script"];
      for (const k of cmdKeys) {
        if (typeof obj[k] === "string") {
          if (VERIFY_CMD_RE.test(obj[k] as string)) turn.hasVerifyCommand = true;
          const extracted = extractFilePathsFromText(obj[k] as string);
          for (const p of extracted.touched) turn.filesTouched.add(p);
          for (const p of extracted.modified) turn.filesModified.add(p);
          for (const p of extracted.absPaths) turn.rawAbsPaths.add(p);
        }
      }
      const nestedKeys = ["patch", "input", "arguments", "args", "files", "edits"];
      for (const k of nestedKeys) {
        if (obj[k] !== undefined) inspectValue(obj[k], depth + 1);
      }
    }
  };

  inspectValue(inputVal, 0);
  if (extraText) {
    if (isCmd && VERIFY_CMD_RE.test(extraText)) turn.hasVerifyCommand = true;
    const extracted = extractFilePathsFromText(extraText);
    for (const p of extracted.touched) turn.filesTouched.add(p);
    for (const p of extracted.modified) turn.filesModified.add(p);
    for (const p of extracted.absPaths) turn.rawAbsPaths.add(p);
    if (isWrite) {
      for (const p of extracted.touched) turn.filesModified.add(p);
    }
  }
}

function inferWorkspaceFromPaths(absPaths: Iterable<string>, fileExists: (path: string) => boolean): string | null {
  const votes = new Map<string, number>();
  const addVote = (root: string, weight = 1) => {
    const norm = normalizeWorkspace(root);
    if (!norm) return;
    // Reject overly shallow system roots
    const depth = norm.split("/").filter(Boolean).length;
    if (depth < 3) return;
    votes.set(norm, (votes.get(norm) ?? 0) + weight);
  };

  for (const raw of absPaths) {
    const p = normalizeWorkspace(raw);
    if (!p) continue;
    // Skip CLI/agent internal config & cache directories so they never masquerade as project workspaces
    if (/\/(?:\.gemini|\.claude|\.codex|\.grok|\.cursor|\.omp|\.agent-hub|\.local\/share|\.cache|Library\/Caches)(?:\/|$)/i.test(p)) {
      continue;
    }
    // Pattern 1: /Users/<user>/developer/<group>/<repo>
    const devMatch = /^(\/(?:Users|home)\/[^/]+\/(?:developer|dev|work|code)\/[^/]+\/[^/]+)(?:\/|$)/i.exec(p);
    if (devMatch) {
      addVote(devMatch[1], 3);
      continue;
    }
    // Pattern 2: /Users/<user>/(projects|workspace|repos|src)/<repo>
    const projMatch = /^(\/(?:Users|home)\/[^/]+\/(?:projects|workspace|repos|src)\/[^/]+)(?:\/|$)/i.exec(p);
    if (projMatch) {
      addVote(projMatch[1], 3);
      continue;
    }
    // Pattern 3: Walk up on disk looking for .git or package.json (for real local paths & temp fixtures)
    let cur = dirname(p);
    let foundRepoRoot = false;
    // Shared prefixes often describe remote machines. A missing ancestor rules out all deeper repo markers.
    const prefix = /^\/[^/]+\/[^/]+/.exec(cur)?.[0];
    for (let i = 0; i < 6 && prefix && fileExists(prefix); i++) {
      if (!cur || cur === "/" || cur.split("/").filter(Boolean).length < 2) break;
      try {
        if (fileExists(join(cur, ".git")) || fileExists(join(cur, "package.json"))) {
          addVote(cur, 4);
          foundRepoRoot = true;
          break;
        }
      } catch {
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (foundRepoRoot) continue;

    // Pattern 4: Strip common source dir tail (/src/..., /web/..., /scripts/..., /tests/...)
    const srcSplit = /^(.*)\/(?:src|web|scripts|tests?|lib|app|packages|docs|server|client)\b/.exec(p);
    if (srcSplit && srcSplit[1]) {
      addVote(srcSplit[1], 2);
    }
  }

  let best: string | null = null;
  let bestScore = 0;
  for (const [root, score] of votes) {
    if (score > bestScore || (score === bestScore && best && root.length < best.length)) {
      best = root;
      bestScore = score;
    }
  }
  return best;
}

function displayFilePath(filePath: string, workspace: string | null): string {
  if (workspace && isAbsolute(filePath)) {
    const rel = relative(workspace, filePath);
    if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
      return rel.split(sep).join("/");
    }
  }
  return filePath;
}

function extractRepoFromGitRemotes(remotes: unknown): string | null {
  const candidates: string[] = [];
  if (typeof remotes === "string") {
    candidates.push(remotes);
  } else if (Array.isArray(remotes)) {
    for (const item of remotes) {
      if (typeof item === "string") candidates.push(item);
      else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (typeof rec.url === "string") candidates.push(rec.url);
        if (typeof rec.fetch === "string") candidates.push(rec.fetch);
      }
    }
  } else if (remotes && typeof remotes === "object") {
    for (const v of Object.values(remotes as Record<string, unknown>)) {
      if (typeof v === "string") candidates.push(v);
      else if (v && typeof v === "object" && typeof (v as Record<string, unknown>).url === "string") {
        candidates.push((v as Record<string, unknown>).url as string);
      }
    }
  }
  for (const raw of candidates) {
    const m = /(?:github\.com|gitlab\.com)[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$|\s)/i.exec(raw);
    if (m && m[1]) return m[1];
  }
  return null;
}

function decodeClaudeEncodedDir(encoded: string): string | null {
  if (!encoded || !encoded.startsWith("-")) return null;
  // Decode leading '-' to '/' and remaining '-' to '/'
  const decoded = `/${encoded.slice(1).replace(/-/g, "/")}`;
  return normalizeWorkspace(decoded);
}

function isWaitingForUser(outcome: string): boolean {
  if (!outcome) return false;
  // Strip fenced code blocks so '?' inside code doesn't falsely trigger waiting_user
  const stripped = outcome.replace(/```[\s\S]*?```/g, " ").trim();
  if (!stripped) return false;
  const tail = stripped.slice(-260).trim();
  if (/[？?]\s*$/.test(tail)) return true;
  if (WAITING_PROMPT_RE.test(tail)) return true;
  return false;
}

function hasUnresolvedFailureText(outcome: string): boolean {
  if (!outcome) return false;
  const tail = outcome.slice(-400);
  if (!BLOCKED_OUTCOME_RE.test(tail)) return false;
  if (RESOLVED_OUTCOME_RE.test(tail)) return false;
  return true;
}

function extractAntigravityUserText(rawContent: string): string {
  let text = rawContent;
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
  text = text.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "");
  const reqMatches: string[] = [];
  const reqRe = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi;
  let m: RegExpExecArray | null;
  while ((m = reqRe.exec(text)) !== null) {
    if (m[1]?.trim()) reqMatches.push(m[1].trim());
  }
  if (reqMatches.length > 0) {
    return reqMatches.join("\n").trim();
  }
  return text.trim();
}

function isCodexBoilerplate(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("# AGENTS.md")) return true;
  if (/^<(?:environment_context|INSTRUCTIONS|permissions\b|turn_aborted|user_instructions)/i.test(t)) {
    return true;
  }
  return false;
}

function extractContentTextBlocks(content: unknown, skipToolResults = false): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item.trim()) parts.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const bType = typeof block.type === "string" ? block.type : "";
    if (skipToolResults && bType === "tool_result") continue;
    if (bType === "text" || bType === "input_text" || bType === "output_text" || (!bType && typeof block.text === "string")) {
      if (typeof block.text === "string" && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function normalizeForDedupe(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function loadHubEnrichment(hubDbPath: string, cutoffMs: number): Map<string, HubEnrichment> {
  const map = new Map<string, HubEnrichment>();
  if (!existsSync(hubDbPath)) return map;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(hubDbPath, { readOnly: true });
  } catch {
    return map;
  }
  try {
    if (!hasTable(db, "sessions")) return map;
    const cols = tableColumns(db, "sessions");
    if (!cols.has("session_id")) return map;
    const selectCols = [
      "session_id",
      cols.has("cwd") ? "cwd" : "NULL AS cwd",
      cols.has("project") ? "project" : "NULL AS project",
      cols.has("tokens") ? "tokens" : "0 AS tokens",
      cols.has("summary") ? "summary" : "NULL AS summary",
      cols.has("day") ? "day" : "NULL AS day",
    ];
    const cutoffDay = new Date(cutoffMs - 7 * MS_PER_DAY).toISOString().slice(0, 10);
    const sql = cols.has("day")
      ? `SELECT ${selectCols.join(", ")} FROM sessions WHERE day >= ? ORDER BY day DESC LIMIT 3000`
      : `SELECT ${selectCols.join(", ")} FROM sessions LIMIT 3000`;
    const rows = (cols.has("day") ? db.prepare(sql).all(cutoffDay) : db.prepare(sql).all()) as Array<{
      session_id?: unknown;
      cwd?: unknown;
      project?: unknown;
      tokens?: unknown;
      summary?: unknown;
    }>;
    for (const row of rows) {
      const sid = typeof row.session_id === "string" ? row.session_id.trim() : "";
      if (!sid) continue;
      const cwd = typeof row.cwd === "string" ? normalizeWorkspace(row.cwd) : null;
      const project =
        typeof row.project === "string" && row.project.trim() && !["unknown", "default", "."].includes(row.project.trim().toLowerCase())
          ? row.project.trim()
          : null;
      const tokens = typeof row.tokens === "number" && Number.isFinite(row.tokens) ? Math.max(0, Math.trunc(row.tokens)) : 0;
      const summary = typeof row.summary === "string" && row.summary.trim() ? row.summary.trim() : null;
      const existing = map.get(sid);
      if (!existing) {
        map.set(sid, { cwd, project, tokens, summary });
      } else {
        existing.cwd = existing.cwd ?? cwd;
        existing.project = existing.project ?? project;
        existing.summary = existing.summary ?? summary;
        existing.tokens += tokens;
      }
    }
  } catch {
    // Gracefully skip hub enrichment if schema differs
  } finally {
    db.close();
  }
  return map;
}

// ---------------------------------------------------------------------------
// Parser 1: Antigravity CLI
// ---------------------------------------------------------------------------
function scanAntigravity(homeDir: string, cutoffMs: number, windowDays: number): { drafts: ParsedSessionDraft[]; source: SourceScanStatus } {
  const root = join(homeDir, ".gemini", "antigravity-cli", "brain");
  if (!existsSync(root)) {
    return {
      drafts: [],
      source: {
        providerId: "antigravity",
        provider: PROVIDER_LABELS.antigravity,
        status: "unavailable",
        scanned: 0,
        detail: "未检测到本机 Antigravity CLI 会话目录",
      },
    };
  }

  const candidates: Array<{ convId: string; transcriptPath: string; mtimeMs: number }> = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const transcriptPath = join(root, entry.name, ".system_generated", "logs", "transcript.jsonl");
      try {
        const st = statSync(transcriptPath);
        if (st.isFile() && st.mtimeMs >= cutoffMs) {
          candidates.push({ convId: entry.name, transcriptPath, mtimeMs: st.mtimeMs });
        }
      } catch {
        // Missing transcript in this brain folder
      }
    }
  } catch {
    return {
      drafts: [],
      source: {
        providerId: "antigravity",
        provider: PROVIDER_LABELS.antigravity,
        status: "unavailable",
        scanned: 0,
        detail: "无法读取 Antigravity CLI 会话目录",
      },
    };
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = candidates.slice(0, 60);
  const drafts: ParsedSessionDraft[] = [];

  for (const item of picked) {
    try {
      const content = readTextBounded(item.transcriptPath);
      const turns: RawTurnBuilder[] = [];
      let currentTurn: RawTurnBuilder | null = null;
      let startedAt: string | null = null;
      let updatedAt: string | null = null;
      let model: string | null = null;
      let tokensTotal = 0;
      const extraAbsPaths = new Set<string>();

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        const ts = normalizeTimestamp(obj.created_at ?? obj.timestamp);
        if (ts) {
          if (!startedAt) startedAt = ts;
          updatedAt = ts;
        }

        const type = typeof obj.type === "string" ? obj.type : "";
        const source = typeof obj.source === "string" ? obj.source : "";

        if (source === "USER_EXPLICIT" && type === "USER_INPUT") {
          const rawText = typeof obj.content === "string" ? obj.content : extractContentTextBlocks(obj.content);
          const cleaned = extractAntigravityUserText(rawText);
          if (!cleaned) continue;
          currentTurn = createTurnBuilder(cleaned, ts);
          turns.push(currentTurn);
          const fromUser = extractFilePathsFromText(cleaned);
          for (const p of fromUser.absPaths) {
            currentTurn.rawAbsPaths.add(p);
            extraAbsPaths.add(p);
          }
          continue;
        }

        if (type === "PLANNER_RESPONSE") {
          if (typeof obj.model === "string" && obj.model.trim()) model = obj.model.trim();
          const inTok = typeof obj.input_tokens === "number" ? obj.input_tokens : 0;
          const outTok = typeof obj.output_tokens === "number" ? obj.output_tokens : 0;
          tokensTotal += Math.max(0, inTok) + Math.max(0, outTok);

          if (!currentTurn) continue;
          currentTurn.lastStepError = false;
          if (typeof obj.thinking === "string" && obj.thinking.trim()) {
            currentTurn.thinkingParts.push(obj.thinking.trim());
          }
          if (typeof obj.content === "string" && obj.content.trim()) {
            currentTurn.outcomeParts.push(obj.content.trim());
            const extracted = extractFilePathsFromText(obj.content);
            for (const p of extracted.touched) currentTurn.filesTouched.add(p);
            for (const p of extracted.modified) currentTurn.filesModified.add(p);
            for (const p of extracted.absPaths) {
              currentTurn.rawAbsPaths.add(p);
              extraAbsPaths.add(p);
            }
          }
          if (Array.isArray(obj.tool_calls)) {
            for (const tc of obj.tool_calls) {
              if (typeof tc === "string") {
                recordToolInvocation(currentTurn, tc, undefined, tc);
              } else if (tc && typeof tc === "object") {
                const tcObj = tc as Record<string, unknown>;
                const fn = tcObj.function && typeof tcObj.function === "object" ? (tcObj.function as Record<string, unknown>) : null;
                const tcName = String(tcObj.name ?? fn?.name ?? "tool");
                const tcArgs = tcObj.args ?? tcObj.arguments ?? fn?.arguments ?? tcObj.input;
                recordToolInvocation(currentTurn, tcName, tcArgs);
              }
            }
            for (const p of currentTurn.rawAbsPaths) extraAbsPaths.add(p);
          }
          continue;
        }

        if (type === "GENERIC" || type === "TOOL_RESULT" || type === "ERROR") {
          const text = typeof obj.content === "string" ? obj.content : "";
          const extracted = extractFilePathsFromText(text);
          for (const p of extracted.absPaths) extraAbsPaths.add(p);
          if (currentTurn) {
            for (const p of extracted.touched) currentTurn.filesTouched.add(p);
            for (const p of extracted.modified) {
              currentTurn.filesModified.add(p);
              currentTurn.hasWriteTool = true;
            }
            for (const p of extracted.absPaths) currentTurn.rawAbsPaths.add(p);
            const statusStr = typeof obj.status === "string" ? obj.status.toUpperCase() : "";
            if (obj.error || statusStr === "ERROR" || statusStr === "ABORTED" || statusStr === "CANCELLED") {
              currentTurn.lastStepError = true;
              if (statusStr === "ABORTED" || statusStr === "CANCELLED") {
                currentTurn.aborted = true;
              }
            }
          }
        }
      }

      if (turns.length === 0) continue;
      const lastTurn = turns[turns.length - 1];
      if (lastTurn.lastStepError && lastTurn.outcomeParts.length === 0) {
        lastTurn.aborted = true;
      }

      const fallbackTs = new Date(item.mtimeMs).toISOString();
      drafts.push({
        rawSessionId: item.convId,
        providerId: "antigravity",
        titleHint: null,
        summaryHint: null,
        workspace: null,
        projectHint: null,
        repository: null,
        branch: null,
        model,
        startedAt: startedAt ?? fallbackTs,
        updatedAt: updatedAt ?? fallbackTs,
        tokensTotal,
        summaryFilesHint: 0,
        turns,
        extraAbsPaths,
        sourcePath: item.transcriptPath,
        lookupIds: [item.convId],
      });
    } catch {
      // Skip unreadable transcript safely
    }
  }

  return {
    drafts,
    source: {
      providerId: "antigravity",
      provider: PROVIDER_LABELS.antigravity,
      status: drafts.length > 0 ? "ok" : "empty",
      scanned: drafts.length,
      detail: drafts.length > 0 ? `已扫描 ${drafts.length} 条最近 ${windowDays} 天会话` : `目录存在，最近 ${windowDays} 天暂无有效会话`,
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 2: Codex CLI
// ---------------------------------------------------------------------------
function scanCodex(homeDir: string, cutoffMs: number, windowDays: number): { drafts: ParsedSessionDraft[]; source: SourceScanStatus } {
  const root = join(homeDir, ".codex", "sessions");
  if (!existsSync(root)) {
    return {
      drafts: [],
      source: {
        providerId: "codex",
        provider: PROVIDER_LABELS.codex,
        status: "unavailable",
        scanned: 0,
        detail: "未检测到本机 Codex 会话目录",
      },
    };
  }

  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl")) {
        try {
          const st = statSync(full);
          if (st.mtimeMs >= cutoffMs) {
            candidates.push({ filePath: full, mtimeMs: st.mtimeMs });
          }
        } catch {
          // ignore
        }
      }
    }
  };
  walk(root, 0);

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = candidates.slice(0, 60);
  const drafts: ParsedSessionDraft[] = [];

  for (const item of picked) {
    try {
      const content = readTextBounded(item.filePath);
      const turns: RawTurnBuilder[] = [];
      let rawSessionId = basename(item.filePath, ".jsonl");
      let workspace: string | null = null;
      let branch: string | null = null;
      let model: string | null = null;
      let startedAt: string | null = null;
      let updatedAt: string | null = null;
      let tokensTotal = 0;
      const extraAbsPaths = new Set<string>();

      const getCurrentTurn = (): RawTurnBuilder | null => (turns.length > 0 ? turns[turns.length - 1] : null);

      const pushUserTurn = (msg: string, ts: string | null) => {
        const cleaned = msg.trim();
        if (!cleaned || isCodexBoilerplate(cleaned)) return;
        const norm = normalizeForDedupe(cleaned);
        const cur = getCurrentTurn();
        if (
          cur &&
          normalizeForDedupe(cur.userInstruction) === norm &&
          cur.outcomeParts.length === 0 &&
          cur.toolCounts.size === 0
        ) {
          return;
        }
        turns.push(createTurnBuilder(cleaned, ts));
      };

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes('"type":"world_state"') || trimmed.includes('"type": "world_state"')) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        const ts = normalizeTimestamp(obj.timestamp);
        if (ts) {
          if (!startedAt) startedAt = ts;
          updatedAt = ts;
        }

        const type = typeof obj.type === "string" ? obj.type : "";
        const payload = obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : null;
        if (!payload) continue;

        if (!workspace && typeof payload.cwd === "string") {
          workspace = normalizeWorkspace(payload.cwd);
        }

        if (type === "session_meta") {
          const sid = payload.session_id ?? payload.id;
          if (typeof sid === "string" && sid.trim()) rawSessionId = sid.trim();
          if (typeof payload.cwd === "string") workspace = normalizeWorkspace(payload.cwd) ?? workspace;
          const git = payload.git && typeof payload.git === "object" ? (payload.git as Record<string, unknown>) : null;
          if (git && typeof git.branch === "string" && git.branch.trim()) branch = git.branch.trim();
          const metaTs = normalizeTimestamp(payload.timestamp);
          if (metaTs && !startedAt) startedAt = metaTs;
          continue;
        }

        if (type === "turn_context") {
          if (typeof payload.cwd === "string") workspace = normalizeWorkspace(payload.cwd) ?? workspace;
          if (typeof payload.model === "string" && payload.model.trim()) model = payload.model.trim();
          continue;
        }

        if (type === "token_usage_record") {
          const threadUsage =
            payload.thread_token_usage && typeof payload.thread_token_usage === "object"
              ? (payload.thread_token_usage as Record<string, unknown>)
              : null;
          const usage =
            payload.usage && typeof payload.usage === "object" ? (payload.usage as Record<string, unknown>) : null;
          const total =
            typeof threadUsage?.total_tokens === "number"
              ? threadUsage.total_tokens
              : typeof usage?.total_tokens === "number"
                ? usage.total_tokens
                : (typeof usage?.input_tokens === "number" ? usage.input_tokens : 0) +
                  (typeof usage?.output_tokens === "number" ? usage.output_tokens : 0);
          if (total > tokensTotal) tokensTotal = Math.trunc(total);
          continue;
        }

        const curTurn = getCurrentTurn();

        if (type === "event_msg") {
          const pType = typeof payload.type === "string" ? payload.type : "";
          if (pType === "user_message" && typeof payload.message === "string") {
            pushUserTurn(payload.message, ts);
          } else if (pType === "agent_message" && typeof payload.message === "string" && curTurn) {
            const msg = payload.message.trim();
            if (msg && !curTurn.outcomeParts.includes(msg)) {
              curTurn.outcomeParts.push(msg);
            }
          } else if (pType === "task_complete" && typeof payload.last_agent_message === "string" && curTurn) {
            const msg = payload.last_agent_message.trim();
            if (msg && curTurn.outcomeParts.length === 0) {
              curTurn.outcomeParts.push(msg);
            }
          } else if (pType === "turn_aborted" && curTurn) {
            curTurn.aborted = true;
          } else if (pType === "token_count") {
            const info = payload.info && typeof payload.info === "object" ? (payload.info as Record<string, unknown>) : null;
            const totalUsage =
              info?.total_token_usage && typeof info.total_token_usage === "object"
                ? (info.total_token_usage as Record<string, unknown>)
                : null;
            if (typeof totalUsage?.total_tokens === "number" && totalUsage.total_tokens > tokensTotal) {
              tokensTotal = Math.trunc(totalUsage.total_tokens);
            }
          }
          continue;
        }

        if (type === "response_item") {
          const role = typeof payload.role === "string" ? payload.role : "";
          const pType = typeof payload.type === "string" ? payload.type : "";

          if (role === "user") {
            const text = extractContentTextBlocks(payload.content);
            pushUserTurn(text, ts);
          } else if (role === "assistant" && curTurn) {
            const text = extractContentTextBlocks(payload.content);
            if (text && !curTurn.outcomeParts.includes(text)) {
              curTurn.outcomeParts.push(text);
              const extracted = extractFilePathsFromText(text);
              for (const p of extracted.touched) curTurn.filesTouched.add(p);
              for (const p of extracted.modified) curTurn.filesModified.add(p);
              for (const p of extracted.absPaths) {
                curTurn.rawAbsPaths.add(p);
                extraAbsPaths.add(p);
              }
            }
          } else if (pType === "reasoning" && curTurn) {
            const summary = extractContentTextBlocks(payload.summary);
            if (summary) curTurn.thinkingParts.push(summary);
          } else if ((pType === "function_call" || pType === "custom_tool_call") && curTurn) {
            const toolName = typeof payload.name === "string" ? payload.name : "tool";
            const rawArgs = payload.arguments ?? payload.input;
            recordToolInvocation(curTurn, toolName, rawArgs);
            for (const p of curTurn.rawAbsPaths) extraAbsPaths.add(p);
          }
        }
      }

      if (turns.length === 0) continue;
      const fallbackTs = new Date(item.mtimeMs).toISOString();
      drafts.push({
        rawSessionId,
        providerId: "codex",
        titleHint: null,
        summaryHint: null,
        workspace,
        projectHint: null,
        repository: null,
        branch,
        model,
        startedAt: startedAt ?? fallbackTs,
        updatedAt: updatedAt ?? fallbackTs,
        tokensTotal,
        summaryFilesHint: 0,
        turns,
        extraAbsPaths,
        sourcePath: item.filePath,
        lookupIds: [rawSessionId, basename(item.filePath, ".jsonl")],
      });
    } catch {
      // Skip unreadable file
    }
  }

  return {
    drafts,
    source: {
      providerId: "codex",
      provider: PROVIDER_LABELS.codex,
      status: drafts.length > 0 ? "ok" : "empty",
      scanned: drafts.length,
      detail: drafts.length > 0 ? `已扫描 ${drafts.length} 条最近 ${windowDays} 天会话` : `目录存在，最近 ${windowDays} 天暂无有效会话`,
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 3: Claude Code
// ---------------------------------------------------------------------------
function scanClaude(homeDir: string, cutoffMs: number, windowDays: number): { drafts: ParsedSessionDraft[]; source: SourceScanStatus } {
  const root = join(homeDir, ".claude", "projects");
  if (!existsSync(root)) {
    return {
      drafts: [],
      source: {
        providerId: "claude",
        provider: PROVIDER_LABELS.claude,
        status: "unavailable",
        scanned: 0,
        detail: "未检测到本机 Claude Code 会话目录",
      },
    };
  }

  const candidates: Array<{ filePath: string; encodedDir: string; mtimeMs: number }> = [];
  try {
    for (const dirEnt of readdirSync(root, { withFileTypes: true })) {
      if (!dirEnt.isDirectory()) continue;
      const projDir = join(root, dirEnt.name);
      try {
        for (const fEnt of readdirSync(projDir, { withFileTypes: true })) {
          if (!fEnt.isFile() || !fEnt.name.endsWith(".jsonl")) continue;
          const filePath = join(projDir, fEnt.name);
          try {
            const st = statSync(filePath);
            if (st.mtimeMs >= cutoffMs) {
              candidates.push({ filePath, encodedDir: dirEnt.name, mtimeMs: st.mtimeMs });
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    return {
      drafts: [],
      source: {
        providerId: "claude",
        provider: PROVIDER_LABELS.claude,
        status: "unavailable",
        scanned: 0,
        detail: "无法读取 Claude Code 会话目录",
      },
    };
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = candidates.slice(0, 60);
  const drafts: ParsedSessionDraft[] = [];

  for (const item of picked) {
    try {
      const content = readTextBounded(item.filePath);
      const turns: RawTurnBuilder[] = [];
      let currentTurn: RawTurnBuilder | null = null;
      let rawSessionId = basename(item.filePath, ".jsonl");
      let workspace: string | null = null;
      let branch: string | null = null;
      let model: string | null = null;
      let startedAt: string | null = null;
      let updatedAt: string | null = null;
      let tokensTotal = 0;
      const extraAbsPaths = new Set<string>();

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        const ts = normalizeTimestamp(obj.timestamp);
        if (ts) {
          if (!startedAt) startedAt = ts;
          updatedAt = ts;
        }
        if (typeof obj.sessionId === "string" && obj.sessionId.trim()) {
          rawSessionId = obj.sessionId.trim();
        }
        if (!workspace) {
          if (typeof obj.cwd === "string") {
            workspace = normalizeWorkspace(obj.cwd);
          } else if (obj.attachment && typeof obj.attachment === "object") {
            const att = obj.attachment as Record<string, unknown>;
            const snap = att.snapshot && typeof att.snapshot === "object" ? (att.snapshot as Record<string, unknown>) : null;
            if (snap && typeof snap.workingDirectory === "string") {
              workspace = normalizeWorkspace(snap.workingDirectory);
            }
          }
        }
        if (!branch && typeof obj.gitBranch === "string" && obj.gitBranch.trim()) {
          branch = obj.gitBranch.trim();
        }

        const type = typeof obj.type === "string" ? obj.type : "";
        const message = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : null;

        if (type === "user" && !obj.isMeta && message) {
          const text = extractContentTextBlocks(message.content, true);
          if (!text) continue;
          currentTurn = createTurnBuilder(text, ts);
          turns.push(currentTurn);
          continue;
        }

        if (type === "assistant" && message) {
          if (typeof message.model === "string" && message.model.trim()) model = message.model.trim();
          const usage = message.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : null;
          if (usage) {
            tokensTotal +=
              (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
              (typeof usage.output_tokens === "number" ? usage.output_tokens : 0) +
              (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0) +
              (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0);
          }

          if (!currentTurn) continue;
          const msgContent = message.content;
          if (typeof msgContent === "string" && msgContent.trim()) {
            currentTurn.outcomeParts.push(msgContent.trim());
            const extracted = extractFilePathsFromText(msgContent);
            for (const p of extracted.touched) currentTurn.filesTouched.add(p);
            for (const p of extracted.modified) currentTurn.filesModified.add(p);
            for (const p of extracted.absPaths) {
              currentTurn.rawAbsPaths.add(p);
              extraAbsPaths.add(p);
            }
          } else if (Array.isArray(msgContent)) {
            for (const rawBlock of msgContent) {
              if (!rawBlock || typeof rawBlock !== "object") continue;
              const block = rawBlock as Record<string, unknown>;
              const bType = typeof block.type === "string" ? block.type : "";
              if (bType === "text" && typeof block.text === "string" && block.text.trim()) {
                currentTurn.outcomeParts.push(block.text.trim());
                const extracted = extractFilePathsFromText(block.text);
                for (const p of extracted.touched) currentTurn.filesTouched.add(p);
                for (const p of extracted.modified) currentTurn.filesModified.add(p);
                for (const p of extracted.absPaths) {
                  currentTurn.rawAbsPaths.add(p);
                  extraAbsPaths.add(p);
                }
              } else if (bType === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
                currentTurn.thinkingParts.push(block.thinking.trim());
              } else if (bType === "tool_use") {
                const name = typeof block.name === "string" ? block.name : "tool";
                recordToolInvocation(currentTurn, name, block.input);
                for (const p of currentTurn.rawAbsPaths) extraAbsPaths.add(p);
              }
            }
          }
          continue;
        }

        if (type === "cost-state" && obj.modelUsage && typeof obj.modelUsage === "object" && tokensTotal === 0) {
          for (const [mName, val] of Object.entries(obj.modelUsage as Record<string, unknown>)) {
            if (!model && mName) model = mName;
            if (val && typeof val === "object") {
              const mv = val as Record<string, unknown>;
              tokensTotal +=
                (typeof mv.inputTokens === "number" ? mv.inputTokens : 0) +
                (typeof mv.outputTokens === "number" ? mv.outputTokens : 0);
            }
          }
        }
      }

      if (turns.length === 0) continue;
      const fallbackTs = new Date(item.mtimeMs).toISOString();
      drafts.push({
        rawSessionId,
        providerId: "claude",
        titleHint: null,
        summaryHint: null,
        workspace,
        encodedWorkspace: decodeClaudeEncodedDir(item.encodedDir),
        projectHint: null,
        repository: null,
        branch,
        model,
        startedAt: startedAt ?? fallbackTs,
        updatedAt: updatedAt ?? fallbackTs,
        tokensTotal,
        summaryFilesHint: 0,
        turns,
        extraAbsPaths,
        sourcePath: item.filePath,
        lookupIds: [rawSessionId, basename(item.filePath, ".jsonl")],
      });
    } catch {
      // Skip unreadable file
    }
  }

  return {
    drafts,
    source: {
      providerId: "claude",
      provider: PROVIDER_LABELS.claude,
      status: drafts.length > 0 ? "ok" : "empty",
      scanned: drafts.length,
      detail: drafts.length > 0 ? `已扫描 ${drafts.length} 条最近 ${windowDays} 天会话` : `目录存在，最近 ${windowDays} 天暂无有效会话`,
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 4: Grok CLI
// ---------------------------------------------------------------------------
function scanGrok(homeDir: string, cutoffMs: number, windowDays: number): { drafts: ParsedSessionDraft[]; source: SourceScanStatus } {
  const root = join(homeDir, ".grok", "sessions");
  if (!existsSync(root)) {
    return {
      drafts: [],
      source: {
        providerId: "grok",
        provider: PROVIDER_LABELS.grok,
        status: "unavailable",
        scanned: 0,
        detail: "未检测到本机 Grok CLI 会话目录",
      },
    };
  }

  const candidates: Array<{
    sessionDir: string;
    sessionId: string;
    summaryPath: string;
    updatesPath: string;
    mtimeMs: number;
  }> = [];

  try {
    for (const cwdEnt of readdirSync(root, { withFileTypes: true })) {
      if (!cwdEnt.isDirectory()) continue;
      const cwdDir = join(root, cwdEnt.name);
      try {
        for (const sessEnt of readdirSync(cwdDir, { withFileTypes: true })) {
          if (!sessEnt.isDirectory()) continue;
          const sessionDir = join(cwdDir, sessEnt.name);
          const summaryPath = join(sessionDir, "summary.json");
          const updatesPath = join(sessionDir, "updates.jsonl");
          let mtimeMs = 0;
          try {
            const stS = statSync(summaryPath);
            if (stS.isFile()) mtimeMs = Math.max(mtimeMs, stS.mtimeMs);
          } catch {
            // summary.json optional if updates.jsonl exists
          }
          try {
            const stU = statSync(updatesPath);
            if (stU.isFile()) mtimeMs = Math.max(mtimeMs, stU.mtimeMs);
          } catch {
            // updates.jsonl optional if summary.json exists
          }
          if (mtimeMs >= cutoffMs) {
            candidates.push({ sessionDir, sessionId: sessEnt.name, summaryPath, updatesPath, mtimeMs });
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    return {
      drafts: [],
      source: {
        providerId: "grok",
        provider: PROVIDER_LABELS.grok,
        status: "unavailable",
        scanned: 0,
        detail: "无法读取 Grok CLI 会话目录",
      },
    };
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = candidates.slice(0, 60);
  const drafts: ParsedSessionDraft[] = [];

  for (const item of picked) {
    try {
      let rawSessionId = item.sessionId;
      let workspace: string | null = null;
      let branch: string | null = null;
      let repository: string | null = null;
      let model: string | null = null;
      let titleHint: string | null = null;
      let summaryHint: string | null = null;
      let startedAt: string | null = null;
      let updatedAt: string | null = null;
      let tokensTotal = 0;
      const extraAbsPaths = new Set<string>();

      if (existsSync(item.summaryPath)) {
        try {
          const sj = JSON.parse(readFileSync(item.summaryPath, "utf8")) as Record<string, unknown>;
          const info = sj.info && typeof sj.info === "object" ? (sj.info as Record<string, unknown>) : null;
          if (info && typeof info.id === "string" && info.id.trim()) rawSessionId = info.id.trim();
          if (info && typeof info.cwd === "string") workspace = normalizeWorkspace(info.cwd);
          if (!workspace && typeof sj.git_root_dir === "string") workspace = normalizeWorkspace(sj.git_root_dir);
          if (typeof sj.head_branch === "string" && sj.head_branch.trim()) branch = sj.head_branch.trim();
          repository = extractRepoFromGitRemotes(sj.git_remotes);
          if (typeof sj.current_model_id === "string" && sj.current_model_id.trim()) {
            model = sj.current_model_id.trim();
          }
          if (typeof sj.generated_title === "string" && sj.generated_title.trim()) {
            titleHint = sj.generated_title.trim();
          }
          if (typeof sj.session_summary === "string" && sj.session_summary.trim()) {
            summaryHint = sj.session_summary.trim();
          } else if (typeof sj.last_turn_summary === "string" && sj.last_turn_summary.trim()) {
            summaryHint = sj.last_turn_summary.trim();
          }
          startedAt = normalizeTimestamp(sj.created_at);
          updatedAt = normalizeTimestamp(sj.updated_at ?? sj.last_active_at);
        } catch {
          // Malformed summary.json: continue with updates.jsonl
        }
      }

      const turns: RawTurnBuilder[] = [];
      let currentTurn: RawTurnBuilder | null = null;
      let inUserChunks = false;
      let currentAgentChunkBuf = "";
      let currentThoughtChunkBuf = "";

      const flushAgentBuffers = () => {
        if (!currentTurn) return;
        if (currentThoughtChunkBuf.trim()) {
          currentTurn.thinkingParts.push(currentThoughtChunkBuf.trim());
          currentThoughtChunkBuf = "";
        }
        if (currentAgentChunkBuf.trim()) {
          const text = currentAgentChunkBuf.trim();
          currentTurn.outcomeParts.push(text);
          const extracted = extractFilePathsFromText(text);
          for (const p of extracted.touched) currentTurn.filesTouched.add(p);
          for (const p of extracted.modified) currentTurn.filesModified.add(p);
          for (const p of extracted.absPaths) {
            currentTurn.rawAbsPaths.add(p);
            extraAbsPaths.add(p);
          }
          currentAgentChunkBuf = "";
        }
      };

      if (existsSync(item.updatesPath)) {
        const raw = readTextBounded(item.updatesPath);
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.includes('"hook_execution"')) continue;
          if (trimmed.length > 32768 && trimmed.includes('"tool_call_update"')) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          const ts = normalizeTimestamp(obj.timestamp);
          if (ts) {
            if (!startedAt) startedAt = ts;
            updatedAt = ts;
          }
          const params = obj.params && typeof obj.params === "object" ? (obj.params as Record<string, unknown>) : null;
          const u =
            params?.update && typeof params.update === "object"
              ? (params.update as Record<string, unknown>)
              : obj.update && typeof obj.update === "object"
                ? (obj.update as Record<string, unknown>)
                : null;
          if (!u) continue;

          const kind = typeof u.sessionUpdate === "string" ? u.sessionUpdate : "";
          const extractChunk = (c: unknown): string => {
            if (typeof c === "string") return c;
            if (c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string") {
              return (c as Record<string, unknown>).text as string;
            }
            return "";
          };

          if (kind === "user_message_chunk") {
            const chunk = extractChunk(u.content);
            if (!chunk) continue;
            if (!inUserChunks) {
              flushAgentBuffers();
              currentTurn = createTurnBuilder(chunk, ts);
              turns.push(currentTurn);
              inUserChunks = true;
            } else if (currentTurn) {
              currentTurn.userInstruction += chunk;
            }
          } else if (kind === "agent_thought_chunk") {
            inUserChunks = false;
            const chunk = extractChunk(u.content);
            if (chunk && currentTurn) currentThoughtChunkBuf += chunk;
          } else if (kind === "agent_message_chunk") {
            inUserChunks = false;
            const chunk = extractChunk(u.content);
            if (chunk && currentTurn) currentAgentChunkBuf += chunk;
          } else if (kind === "tool_call") {
            inUserChunks = false;
            if (currentTurn) {
              const tTitle = typeof u.title === "string" ? u.title : "";
              const tKind = typeof u.kind === "string" ? u.kind : "";
              const tName =
                typeof u.name === "string" && u.name.trim()
                  ? u.name.trim()
                  : tKind || (tTitle ? tTitle.split(/\s+/)[0] : "tool");
              const effectiveName = tKind === "execute" ? "shell" : tName;
              recordToolInvocation(currentTurn, effectiveName, u.rawInput ?? u.input ?? u.args, tTitle);
              if (tKind === "edit" || tKind === "write") {
                currentTurn.hasWriteTool = true;
                for (const p of extractFilePathsFromText(tTitle).touched) currentTurn.filesModified.add(p);
              }
              for (const p of currentTurn.rawAbsPaths) extraAbsPaths.add(p);
            }
          } else if (kind === "tool_call_update") {
            inUserChunks = false;
            if (currentTurn) {
              const outStr = typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput ?? "");
              const extracted = extractFilePathsFromText(`${typeof u.title === "string" ? u.title : ""} ${outStr}`);
              for (const p of extracted.touched) currentTurn.filesTouched.add(p);
              for (const p of extracted.modified) currentTurn.filesModified.add(p);
              for (const p of extracted.absPaths) {
                currentTurn.rawAbsPaths.add(p);
                extraAbsPaths.add(p);
              }
            }
          } else if (kind === "turn_completed") {
            inUserChunks = false;
            flushAgentBuffers();
            if (currentTurn) {
              const stopReason = typeof u.stop_reason === "string" ? u.stop_reason.toLowerCase() : "";
              if (["cancelled", "canceled", "aborted", "error", "failed"].includes(stopReason)) {
                currentTurn.aborted = true;
              }
            }
            const usage = u.usage && typeof u.usage === "object" ? (u.usage as Record<string, unknown>) : null;
            if (usage) {
              const tot =
                typeof usage.total_tokens === "number"
                  ? usage.total_tokens
                  : (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
                    (typeof usage.output_tokens === "number" ? usage.output_tokens : 0);
              tokensTotal += Math.max(0, Math.trunc(tot));
            }
          }
        }
        flushAgentBuffers();
      }

      // Trim concatenated user chunks
      for (const t of turns) t.userInstruction = t.userInstruction.trim();
      const nonEmptyTurns = turns.filter((t) => t.userInstruction.length > 0);
      if (nonEmptyTurns.length === 0 && !titleHint && !summaryHint) continue;

      const fallbackTs = new Date(item.mtimeMs).toISOString();
      drafts.push({
        rawSessionId,
        providerId: "grok",
        titleHint,
        summaryHint,
        workspace,
        projectHint: null,
        repository,
        branch,
        model,
        startedAt: startedAt ?? fallbackTs,
        updatedAt: updatedAt ?? fallbackTs,
        tokensTotal,
        summaryFilesHint: 0,
        turns: nonEmptyTurns,
        extraAbsPaths,
        sourcePath: existsSync(item.updatesPath) ? item.updatesPath : item.summaryPath,
        lookupIds: [rawSessionId, item.sessionId],
      });
    } catch {
      // Skip unreadable grok session
    }
  }

  return {
    drafts,
    source: {
      providerId: "grok",
      provider: PROVIDER_LABELS.grok,
      status: drafts.length > 0 ? "ok" : "empty",
      scanned: drafts.length,
      detail: drafts.length > 0 ? `已扫描 ${drafts.length} 条最近 ${windowDays} 天会话` : `目录存在，最近 ${windowDays} 天暂无有效会话`,
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 5: Cursor Agent
// ---------------------------------------------------------------------------
function decodeCursorMetaValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, "hex").toString("utf8");
      if (decoded.trim().startsWith("{") || decoded.trim().startsWith("[")) {
        return decoded;
      }
    } catch {
      // Keep original string
    }
  }
  return trimmed;
}

function tryDecodeJsonBlob(data: unknown): unknown | null {
  let str: string | null = null;
  if (typeof data === "string") {
    str = data;
  } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    if (data.byteLength === 0 || data.byteLength > 512 * 1024) return null;
    // Quick check for binary/NUL bytes in leading header
    const probeLen = Math.min(64, data.byteLength);
    let firstNonWs = -1;
    for (let i = 0; i < probeLen; i++) {
      const b = data[i];
      if (b === 0) return null;
      if (firstNonWs === -1 && b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
        firstNonWs = b;
      }
    }
    if (firstNonWs !== 0x7b /* { */ && firstNonWs !== 0x5b /* [ */) return null;
    str = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (!str) return null;
  const trimmed = str.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function scanCursor(homeDir: string, cutoffMs: number, windowDays: number): { drafts: ParsedSessionDraft[]; source: SourceScanStatus } {
  const root = join(homeDir, ".cursor", "chats");
  if (!existsSync(root)) {
    return {
      drafts: [],
      source: {
        providerId: "cursor",
        provider: PROVIDER_LABELS.cursor,
        status: "unavailable",
        scanned: 0,
        detail: "未检测到本机 Cursor Agent 会话目录",
      },
    };
  }

  const wsDirs: Array<{ dirPath: string; mtimeMs: number }> = [];
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dirPath = join(root, ent.name);
      try {
        const st = statSync(dirPath);
        wsDirs.push({ dirPath, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
  } catch {
    return {
      drafts: [],
      source: {
        providerId: "cursor",
        provider: PROVIDER_LABELS.cursor,
        status: "unavailable",
        scanned: 0,
        detail: "无法读取 Cursor Agent 会话目录",
      },
    };
  }

  // Sort workspace directories by mtime desc and inspect the most active ones to stay fast on large folders
  wsDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const inspectedWs = wsDirs.slice(0, 160);
  const dbCandidates: Array<{ chatId: string; dbPath: string; mtimeMs: number }> = [];

  for (const ws of inspectedWs) {
    try {
      for (const chatEnt of readdirSync(ws.dirPath, { withFileTypes: true })) {
        if (!chatEnt.isDirectory()) continue;
        const dbPath = join(ws.dirPath, chatEnt.name, "store.db");
        try {
          const st = statSync(dbPath);
          if (st.isFile() && st.mtimeMs >= cutoffMs) {
            dbCandidates.push({ chatId: chatEnt.name, dbPath, mtimeMs: st.mtimeMs });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  dbCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = dbCandidates.slice(0, 40);
  const drafts: ParsedSessionDraft[] = [];

  for (const item of picked) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(item.dbPath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      let name: string | null = null;
      let agentId: string | null = null;
      let createdAt: string | null = null;
      let model: string | null = null;
      let workspace: string | null = null;

      if (hasTable(db, "meta")) {
        const metaRows = db.prepare("SELECT key, value FROM meta LIMIT 50").all() as Array<{
          key?: unknown;
          value?: unknown;
        }>;
        for (const row of metaRows) {
          const k = typeof row.key === "string" ? row.key : "";
          const rawVal = typeof row.value === "string" ? row.value : "";
          if (!rawVal) continue;
          const decoded = decodeCursorMetaValue(rawVal);
          if (decoded.startsWith("{")) {
            try {
              const obj = JSON.parse(decoded) as Record<string, unknown>;
              if (typeof obj.name === "string" && obj.name.trim()) name = obj.name.trim();
              if (typeof obj.agentId === "string" && obj.agentId.trim()) agentId = obj.agentId.trim();
              if (obj.createdAt !== undefined) createdAt = normalizeTimestamp(obj.createdAt) ?? createdAt;
              if (typeof obj.lastUsedModel === "string" && obj.lastUsedModel.trim()) {
                model = obj.lastUsedModel.trim();
              } else if (typeof obj.model === "string" && obj.model.trim()) {
                model = obj.model.trim();
              }
              const wsCand = obj.workspace ?? obj.cwd ?? obj.workspacePath ?? obj.rootPath;
              if (typeof wsCand === "string") workspace = normalizeWorkspace(wsCand) ?? workspace;
            } catch {
              // ignore non-JSON
            }
          } else {
            if (k === "name" && decoded) name = decoded;
            else if (k === "agentId" && decoded) agentId = decoded;
            else if (k === "createdAt") createdAt = normalizeTimestamp(decoded) ?? createdAt;
            else if ((k === "lastUsedModel" || k === "model") && decoded) model = decoded;
            else if ((k === "workspace" || k === "cwd") && decoded) workspace = normalizeWorkspace(decoded) ?? workspace;
          }
        }
      }

      const turns: RawTurnBuilder[] = [];
      let currentTurn: RawTurnBuilder | null = null;
      const extraAbsPaths = new Set<string>();

      const ingestMessageObj = (msg: Record<string, unknown>) => {
        const role = typeof msg.role === "string" ? msg.role.toLowerCase() : "";
        const ts = normalizeTimestamp(msg.createdAt ?? msg.timestamp);
        if (role === "user") {
          const text = extractContentTextBlocks(msg.content ?? msg.text, true);
          if (!text) return;
          currentTurn = createTurnBuilder(text, ts);
          turns.push(currentTurn);
        } else if (role === "assistant") {
          if (!currentTurn) {
            currentTurn = createTurnBuilder(name || "Cursor Agent 会话", ts ?? createdAt);
            turns.push(currentTurn);
          }
          const text = extractContentTextBlocks(msg.content ?? msg.text);
          if (text) {
            currentTurn.outcomeParts.push(text);
            const extracted = extractFilePathsFromText(text);
            for (const p of extracted.touched) currentTurn.filesTouched.add(p);
            for (const p of extracted.modified) currentTurn.filesModified.add(p);
            for (const p of extracted.absPaths) {
              currentTurn.rawAbsPaths.add(p);
              extraAbsPaths.add(p);
            }
          }
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (!block || typeof block !== "object") continue;
              const b = block as Record<string, unknown>;
              if (b.type === "tool_use" || b.type === "tool-call") {
                const tName = String(b.name ?? b.toolName ?? "tool");
                recordToolInvocation(currentTurn, tName, b.input ?? b.args);
                for (const p of currentTurn.rawAbsPaths) extraAbsPaths.add(p);
              }
            }
          }
          if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              if (!tc || typeof tc !== "object") continue;
              const tcObj = tc as Record<string, unknown>;
              const fn = tcObj.function && typeof tcObj.function === "object" ? (tcObj.function as Record<string, unknown>) : null;
              recordToolInvocation(currentTurn, String(tcObj.name ?? fn?.name ?? "tool"), tcObj.args ?? fn?.arguments);
            }
            for (const p of currentTurn.rawAbsPaths) extraAbsPaths.add(p);
          }
        }
      };

      if (hasTable(db, "blobs")) {
        const blobRows = db.prepare("SELECT id, data FROM blobs LIMIT 40").all() as Array<{
          id?: unknown;
          data?: unknown;
        }>;
        for (const row of blobRows) {
          const parsed = tryDecodeJsonBlob(row.data);
          if (!parsed) continue;
          if (Array.isArray(parsed)) {
            for (const el of parsed) {
              if (el && typeof el === "object") ingestMessageObj(el as Record<string, unknown>);
            }
          } else if (typeof parsed === "object") {
            const rec = parsed as Record<string, unknown>;
            if (Array.isArray(rec.messages)) {
              for (const el of rec.messages) {
                if (el && typeof el === "object") ingestMessageObj(el as Record<string, unknown>);
              }
            } else if (typeof rec.role === "string") {
              ingestMessageObj(rec);
            }
          }
        }
      }

      if (turns.length === 0 && !name) continue;
      const rawSessionId = agentId || item.chatId;
      const fallbackTs = new Date(item.mtimeMs).toISOString();
      drafts.push({
        rawSessionId,
        providerId: "cursor",
        titleHint: name,
        summaryHint: null,
        workspace,
        projectHint: null,
        repository: null,
        branch: null,
        model,
        startedAt: createdAt ?? fallbackTs,
        updatedAt: fallbackTs,
        tokensTotal: 0,
        summaryFilesHint: 0,
        turns,
        extraAbsPaths,
        sourcePath: item.dbPath,
        lookupIds: [rawSessionId, item.chatId, ...(agentId ? [agentId] : [])],
      });
    } catch {
      // Skip corrupted store.db
    } finally {
      db.close();
    }
  }

  return {
    drafts,
    source: {
      providerId: "cursor",
      provider: PROVIDER_LABELS.cursor,
      status: drafts.length > 0 ? "ok" : "empty",
      scanned: drafts.length,
      detail: drafts.length > 0 ? `已扫描 ${drafts.length} 条最近 ${windowDays} 天会话` : `目录存在，最近 ${windowDays} 天暂无有效会话`,
    },
  };
}

// ---------------------------------------------------------------------------
// Parser 6: OpenCode
// ---------------------------------------------------------------------------
function scanOpenCode(homeDir: string, cutoffMs: number, windowDays: number): { drafts: ParsedSessionDraft[]; source: SourceScanStatus } {
  const dbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    return {
      drafts: [],
      source: {
        providerId: "opencode",
        provider: PROVIDER_LABELS.opencode,
        status: "unavailable",
        scanned: 0,
        detail: "未检测到本机 OpenCode 数据库",
      },
    };
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return {
      drafts: [],
      source: {
        providerId: "opencode",
        provider: PROVIDER_LABELS.opencode,
        status: "unavailable",
        scanned: 0,
        detail: "无法以只读模式打开 OpenCode 数据库",
      },
    };
  }

  const drafts: ParsedSessionDraft[] = [];
  try {
    if (!hasTable(db, "session")) {
      return {
        drafts: [],
        source: {
          providerId: "opencode",
          provider: PROVIDER_LABELS.opencode,
          status: "empty",
          scanned: 0,
          detail: "OpenCode 数据库中缺少 session 表",
        },
      };
    }

    const sCols = tableColumns(db, "session");
    const selectFields = [
      "id",
      sCols.has("title") ? "title" : "NULL AS title",
      sCols.has("directory") ? "directory" : "NULL AS directory",
      sCols.has("time_created") ? "time_created" : "NULL AS time_created",
      sCols.has("time_updated") ? "time_updated" : "NULL AS time_updated",
      sCols.has("model") ? "model" : "NULL AS model",
      sCols.has("tokens_input") ? "tokens_input" : "0 AS tokens_input",
      sCols.has("tokens_output") ? "tokens_output" : "0 AS tokens_output",
      sCols.has("tokens_reasoning") ? "tokens_reasoning" : "0 AS tokens_reasoning",
      sCols.has("summary_files") ? "summary_files" : "0 AS summary_files",
    ];
    const orderCol = sCols.has("time_updated") ? "time_updated" : sCols.has("time_created") ? "time_created" : "rowid";
    const sessionRows = db
      .prepare(`SELECT ${selectFields.join(", ")} FROM session ORDER BY ${orderCol} DESC LIMIT 100`)
      .all() as Array<Record<string, unknown>>;

    const hasMsg = hasTable(db, "message");
    const hasPart = hasTable(db, "part");
    const msgCols = hasMsg ? tableColumns(db, "message") : new Set<string>();
    const partCols = hasPart ? tableColumns(db, "part") : new Set<string>();

    const msgStmt = hasMsg
      ? db.prepare(
          `SELECT id, ${msgCols.has("time_created") ? "time_created" : "NULL AS time_created"}, ${
            msgCols.has("data") ? "data" : "NULL AS data"
          }${msgCols.has("role") ? ", role" : ""}${msgCols.has("content") ? ", content" : ""} FROM message WHERE session_id = ? ORDER BY ${
            msgCols.has("time_created") ? "time_created" : "rowid"
          } ASC LIMIT 200`,
        )
      : null;

    const partStmt =
      hasPart && partCols.has("session_id")
        ? db.prepare(
            `SELECT id, ${partCols.has("message_id") ? "message_id" : "NULL AS message_id"}, ${
              partCols.has("time_created") ? "time_created" : "NULL AS time_created"
            }, ${partCols.has("data") ? "data" : "NULL AS data"} FROM part WHERE session_id = ? ORDER BY ${
              partCols.has("time_created") ? "time_created" : "rowid"
            } ASC LIMIT 400`,
          )
        : null;

    for (const row of sessionRows) {
      if (drafts.length >= 60) break;
      const rawSessionId = typeof row.id === "string" ? row.id.trim() : "";
      if (!rawSessionId) continue;

      const updatedMs = normalizeTimestampMs(row.time_updated) ?? normalizeTimestampMs(row.time_created);
      if (updatedMs !== null && updatedMs < cutoffMs) continue;

      const startedAt = normalizeTimestamp(row.time_created);
      const updatedAt = normalizeTimestamp(row.time_updated) ?? startedAt;
      const workspace = typeof row.directory === "string" ? normalizeWorkspace(row.directory) : null;
      const titleHint = typeof row.title === "string" && row.title.trim() ? row.title.trim() : null;
      let model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : null;
      let tokensTotal =
        (typeof row.tokens_input === "number" ? Math.max(0, row.tokens_input) : 0) +
        (typeof row.tokens_output === "number" ? Math.max(0, row.tokens_output) : 0) +
        (typeof row.tokens_reasoning === "number" ? Math.max(0, row.tokens_reasoning) : 0);
      const summaryFilesHint = typeof row.summary_files === "number" ? Math.max(0, Math.trunc(row.summary_files)) : 0;

      const turns: RawTurnBuilder[] = [];
      let currentTurn: RawTurnBuilder | null = null;
      const extraAbsPaths = new Set<string>();

      const partsByMsg = new Map<string, Array<Record<string, unknown>>>();
      if (partStmt) {
        try {
          const pRows = partStmt.all(rawSessionId) as Array<Record<string, unknown>>;
          for (const pr of pRows) {
            const mid = typeof pr.message_id === "string" ? pr.message_id : "";
            if (!mid) continue;
            let pData: Record<string, unknown> | null = null;
            if (typeof pr.data === "string") {
              try {
                pData = JSON.parse(pr.data) as Record<string, unknown>;
              } catch {
                pData = null;
              }
            }
            if (!pData) continue;
            const list = partsByMsg.get(mid) ?? [];
            list.push(pData);
            partsByMsg.set(mid, list);
          }
        } catch {
          // ignore part read errors
        }
      }

      if (msgStmt) {
        try {
          const mRows = msgStmt.all(rawSessionId) as Array<Record<string, unknown>>;
          for (const mr of mRows) {
            const mid = typeof mr.id === "string" ? mr.id : "";
            const mTs = normalizeTimestamp(mr.time_created);
            let mData: Record<string, unknown> = {};
            if (typeof mr.data === "string") {
              try {
                const parsed = JSON.parse(mr.data);
                if (parsed && typeof parsed === "object") mData = parsed as Record<string, unknown>;
              } catch {
                // ignore malformed json
              }
            }
            const role = String(mData.role ?? mr.role ?? "").toLowerCase();
            const parts = partsByMsg.get(mid) ?? [];

            if (role === "user") {
              const partTexts = parts
                .filter((p) => p.type === "text" && typeof p.text === "string")
                .map((p) => String(p.text).trim())
                .filter(Boolean);
              const fallbackText =
                typeof mData.text === "string"
                  ? mData.text
                  : typeof mData.content === "string"
                    ? mData.content
                    : typeof mr.content === "string"
                      ? mr.content
                      : "";
              const instruction = (partTexts.join("\n") || fallbackText).trim();
              if (!instruction) continue;
              currentTurn = createTurnBuilder(instruction, mTs);
              turns.push(currentTurn);
            } else if (role === "assistant") {
              if (!model) {
                const mObj = mData.model && typeof mData.model === "object" ? (mData.model as Record<string, unknown>) : null;
                const cand = mData.modelID ?? mObj?.modelID ?? mData.model;
                if (typeof cand === "string" && cand.trim()) model = cand.trim();
              }
              if (tokensTotal === 0 && mData.tokens && typeof mData.tokens === "object") {
                const tk = mData.tokens as Record<string, unknown>;
                tokensTotal +=
                  (typeof tk.input === "number" ? tk.input : 0) +
                  (typeof tk.output === "number" ? tk.output : 0) +
                  (typeof tk.reasoning === "number" ? tk.reasoning : 0);
              }
              if (!currentTurn) continue;

              for (const p of parts) {
                if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
                  currentTurn.outcomeParts.push(p.text.trim());
                  const extracted = extractFilePathsFromText(p.text);
                  for (const fp of extracted.touched) currentTurn.filesTouched.add(fp);
                  for (const fp of extracted.modified) currentTurn.filesModified.add(fp);
                  for (const fp of extracted.absPaths) {
                    currentTurn.rawAbsPaths.add(fp);
                    extraAbsPaths.add(fp);
                  }
                } else if (p.type === "reasoning" && typeof p.text === "string" && p.text.trim()) {
                  currentTurn.thinkingParts.push(p.text.trim());
                } else if (p.type === "tool") {
                  const tName = typeof p.tool === "string" ? p.tool : typeof p.name === "string" ? p.name : "tool";
                  const state = p.state && typeof p.state === "object" ? (p.state as Record<string, unknown>) : null;
                  const outStr = typeof state?.output === "string" ? state.output : undefined;
                  recordToolInvocation(currentTurn, tName, state?.input ?? p.input, outStr);
                  for (const fp of currentTurn.rawAbsPaths) extraAbsPaths.add(fp);
                }
              }

              if (parts.length === 0) {
                const fallbackOutcome =
                  typeof mData.text === "string"
                    ? mData.text
                    : typeof mData.content === "string"
                      ? mData.content
                      : typeof mr.content === "string"
                        ? mr.content
                        : "";
                if (fallbackOutcome.trim()) currentTurn.outcomeParts.push(fallbackOutcome.trim());
              }

              if (mData.error || mData.finish === "error" || mData.finish === "aborted") {
                currentTurn.aborted = true;
              }
            }
          }
        } catch {
          // ignore message query failures
        }
      }

      if (turns.length === 0 && !titleHint) continue;
      drafts.push({
        rawSessionId,
        providerId: "opencode",
        titleHint,
        summaryHint: null,
        workspace,
        projectHint: null,
        repository: null,
        branch: null,
        model,
        startedAt,
        updatedAt,
        tokensTotal,
        summaryFilesHint,
        turns,
        extraAbsPaths,
        sourcePath: `${dbPath}#session/${rawSessionId}`,
        lookupIds: [rawSessionId],
      });
    }
  } catch {
    return {
      drafts: [],
      source: {
        providerId: "opencode",
        provider: PROVIDER_LABELS.opencode,
        status: "unavailable",
        scanned: 0,
        detail: "读取 OpenCode 数据库失败",
      },
    };
  } finally {
    db.close();
  }

  return {
    drafts,
    source: {
      providerId: "opencode",
      provider: PROVIDER_LABELS.opencode,
      status: drafts.length > 0 ? "ok" : "empty",
      scanned: drafts.length,
      detail: drafts.length > 0 ? `已扫描 ${drafts.length} 条最近 ${windowDays} 天会话` : `数据库存在，最近 ${windowDays} 天暂无会话`,
    },
  };
}

// ---------------------------------------------------------------------------
// Finalization: enrich, infer progress/status, build handoffMarkdown
// ---------------------------------------------------------------------------
function buildHandoffMarkdown(session: Omit<CliSessionDetail, "handoffMarkdown">): string {
  const lines: string[] = [
    `# 跨 CLI 交接上下文：${session.title}`,
    "",
    `- **项目**：${session.project}`,
    `- **工作目录**：${session.workspace ?? "未知"}`,
    `- **来源 CLI**：${session.provider}${session.model ? ` (${session.model})` : ""}`,
    `- **分支 / 仓库**：${session.branch ?? "-"} / ${session.repository ?? "-"}`,
    `- **当前状态**：${session.status}（${session.progressStage} · ${session.progressPct}%）— ${session.statusReason}`,
    `- **最近更新**：${session.updatedAt ?? "未知"}`,
    "",
    "## 原始指令与追问脉络",
  ];

  if (session.turns.length === 0) {
    lines.push(`1. [会话主题] ${session.firstInstruction}`);
  } else {
    const selected =
      session.turns.length <= 10
        ? session.turns
        : [session.turns[0], ...session.turns.slice(-9)];
    for (const turn of selected) {
      const tag = turn.index === 1 ? "首条指令" : `追问 #${turn.index}`;
      lines.push(`${turn.index}. [${tag}] ${truncateOneLine(turn.userInstruction, 260)}`);
    }
  }

  lines.push("");
  lines.push(`## 已改动/涉及文件（共 ${session.stats.filesTouched.length} 个）`);
  if (session.stats.filesTouched.length === 0) {
    lines.push("- 暂无明确记录的文件改动");
  } else {
    for (const f of session.stats.filesTouched.slice(0, 25)) {
      lines.push(`- \`${f}\``);
    }
  }

  lines.push("");
  lines.push("## 最近进展摘要");
  lines.push(session.latestProgress || "暂无明确进展摘要");

  let nextStepGuidance: string;
  switch (session.status) {
    case "blocked":
      nextStepGuidance = "优先排查并解决上一轮中断/报错原因，再恢复实现与验证；";
      break;
    case "waiting_user":
      nextStepGuidance = "先回应/确认上一轮待决策问题，再继续执行剩余改动；";
      break;
    case "running":
      nextStepGuidance = "核对当前正在推进的改动是否完整，补齐缺失实现与单测；";
      break;
    case "completed":
      nextStepGuidance = "在此交付基础上继续迭代，或运行完整回归测试并准备提交；";
      break;
    default:
      nextStepGuidance = "回顾初始需求并确认是否仍需继续推进。";
      break;
  }

  lines.push("");
  lines.push("## 接力下一步建议（可直接粘贴到任意 CLI）");
  lines.push(`请基于以上上下文继续推进项目 \`${session.project}\`（目录：\`${session.workspace ?? "."}\`）：`);
  lines.push("1. 先核对上述涉及文件与当前 git diff / 工作区状态；");
  lines.push(`2. ${nextStepGuidance}`);
  lines.push("3. 完成后汇报改动清单、验证结果与待确认事项。");

  return redactSecrets(lines.join("\n"));
}

interface NormalizedLiveSession {
  providerId: CliProviderId | null;
  workspace: string | null;
  canonicalWorkspace: string | null;
  state: string;
  updatedMs: number | null;
  address: string | null;
  title: string | null;
  cleanTitle: string;
  spaceName: string | null;
  parent: string | null;
  name: string | null;
  labels: Record<string, string>;
  originTrack?: WorkOriginTrack;
  originDetail?: WorkOriginDetail;
}

const LIVE_HERDR_MAX_AGE_MS = 90 * 60 * 1000;

function stripHerdrTitlePrefix(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏π📜\s]+/u, "")
    .replace(/^(?:-\s*)?(?:Thinking|Compacting|Waiting|Writing[^-]*|Reading[^-]*|Running[^-]*|Wait[^-]*)\s*-\s*/i, "")
    .replace(/[…\.]+$/g, "")
    .trim()
    .toLowerCase();
}

function matchLiveHerdrTerminals(
  drafts: Array<{ draft: ParsedSessionDraft; rawWs: string | null; canonicalWs: string | null; updatedMs: number }>,
  liveSessions: NormalizedLiveSession[],
  nowMs: number,
): Map<ParsedSessionDraft, NormalizedLiveSession> {
  const matched = new Map<ParsedSessionDraft, NormalizedLiveSession>();
  const usedDrafts = new Set<ParsedSessionDraft>();
  const herdrLives = liveSessions.filter((l) => Boolean(l.address));
  if (!herdrLives.length || !drafts.length) return matched;

  // Score all (live, draft) pairs and greedily assign 1-to-1 highest-confidence pairs first
  const pairs: Array<{ live: NormalizedLiveSession; draft: ParsedSessionDraft; score: number }> = [];
  for (const live of herdrLives) {
    if (!live.providerId) continue;
    const isActiveHerdr = ["working", "running", "waiting", "blocked"].includes(live.state.toLowerCase());
    for (const item of drafts) {
      if (item.draft.providerId !== live.providerId) continue;
      const ageMs = Math.max(0, nowMs - item.updatedMs);
      if (ageMs > (isActiveHerdr ? 12 * 60 * 60 * 1000 : LIVE_HERDR_MAX_AGE_MS)) continue;

      let score = 0;
      const draftTitle = (
        item.draft.titleHint ||
        item.draft.turns[0]?.userInstruction.split("\n")[0] ||
        item.draft.summaryHint ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

      if (live.cleanTitle.length >= 6 && draftTitle.length >= 4) {
        const probe = live.cleanTitle.slice(0, 28);
        if (draftTitle.includes(probe) || live.cleanTitle.includes(draftTitle.slice(0, 22))) {
          score += 120;
        }
      }

      if (live.workspace && item.rawWs && live.workspace === item.rawWs) {
        score += 60;
      } else if (
        live.canonicalWorkspace &&
        item.canonicalWs &&
        live.canonicalWorkspace === item.canonicalWs
      ) {
        score += 45;
      } else if (
        live.spaceName &&
        item.canonicalWs &&
        basename(item.canonicalWs).toLowerCase() === live.spaceName.toLowerCase()
      ) {
        score += 25;
      }

      if (score === 0) continue;
      // Require strong title overlap if cwd is different/home, or recent mtime for same-workspace match
      if (score < 45 && ageMs > LIVE_HERDR_MAX_AGE_MS) continue;
      // Recency tiebreaker (up to +20 for sessions updated within the last few minutes)
      const recencyBonus = Math.max(0, 20 - Math.floor(ageMs / (3 * 60 * 1000)));
      pairs.push({ live, draft: item.draft, score: score + recencyBonus });
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  const usedLives = new Set<NormalizedLiveSession>();
  for (const pair of pairs) {
    if (usedLives.has(pair.live) || usedDrafts.has(pair.draft)) continue;
    usedLives.add(pair.live);
    usedDrafts.add(pair.draft);
    matched.set(pair.draft, pair.live);
  }
  return matched;
}

function finalizeDraft(
  draft: ParsedSessionDraft,
  hubMap: Map<string, HubEnrichment>,
  liveSessions: NormalizedLiveSession[],
  matchedHerdr: NormalizedLiveSession | null,
  nowMs: number,
  homeDir: string,
  fileExists: (path: string) => boolean,
  hooks: CliLedgerHooks,
): CliSessionDetail {
  // 1. Optional enrichment from hub.db
  let hubInfo: HubEnrichment | undefined;
  for (const lid of draft.lookupIds) {
    const found = hubMap.get(lid);
    if (found) {
      hubInfo = found;
      break;
    }
  }

  const rawWorkspaceCandidate =
    draft.workspace ??
    inferWorkspaceFromPaths(draft.extraAbsPaths, fileExists) ??
    draft.encodedWorkspace ??
    hubInfo?.cwd ??
    null;

  const wsResolved = resolveCanonicalWorkspace(rawWorkspaceCandidate, { homeDir });
  // If raw cwd is home or probe temp dir, fall back to paths actually touched inside the session
  const fallbackFromPaths =
    wsResolved.isHomeDir || wsResolved.isTempDir
      ? inferWorkspaceFromPaths(draft.extraAbsPaths, fileExists)
      : null;
  const effectiveWsResolved = fallbackFromPaths
    ? resolveCanonicalWorkspace(fallbackFromPaths, { homeDir })
    : wsResolved;

  const workspace = effectiveWsResolved.canonicalWorkspace ?? (effectiveWsResolved.isHomeDir || effectiveWsResolved.isTempDir ? null : rawWorkspaceCandidate);
  const effectiveRepo = draft.repository ?? effectiveWsResolved.repository ?? null;
  const workspaceName = workspace ? basename(workspace) : null;
  const repoLeaf = effectiveRepo ? effectiveRepo.split("/").pop() || null : null;
  const isBadHint = (val: string | null | undefined) => {
    if (!val) return true;
    const low = val.trim().toLowerCase();
    return (
      !low ||
      ["未归类项目", "default", "cwd", ".", "~", "unknown", "home"].includes(low) ||
      low === basename(homeDir).toLowerCase() ||
      /^wt-[a-z0-9_-]+$/i.test(low) ||
      /^run_[a-f0-9]{8,}$/i.test(low)
    );
  };
  const projectHintRaw =
    (!isBadHint(draft.projectHint) ? draft.projectHint : null) ||
    effectiveWsResolved.worktreeProjectHint ||
    workspaceName ||
    matchedHerdr?.spaceName ||
    (!isBadHint(hubInfo?.project) ? hubInfo?.project : null) ||
    repoLeaf ||
    "未归类项目";

  const classification = hooks.classifyWorkspace?.({
    workspace,
    repository: effectiveRepo,
    projectHint: projectHintRaw,
    spaceName: matchedHerdr?.spaceName ?? null,
  });

  const projectRaw =
    classification && classification.canonicalProject !== "个人工作区"
      ? classification.canonicalProject
      : projectHintRaw;
  const project = redactSecrets(projectRaw.trim() || "未归类项目");
  const tokensTotal = Math.max(draft.tokensTotal, hubInfo?.tokens ?? 0);
  const summaryHint = draft.summaryHint ?? hubInfo?.summary ?? null;

  // 2. Finalize turn items
  const allModified = new Set<string>();
  const allTouchedOrdered: string[] = [];
  const allTouchedSeen = new Set<string>();
  let totalToolCalls = 0;
  let totalCommandsRun = 0;
  let anyWriteTool = false;
  let anyVerifyCommand = false;

  const turns: CliTurnItem[] = draft.turns.map((tb, idx) => {
    const isLast = idx === draft.turns.length - 1;
    const userInstruction = cleanText(tb.userInstruction, 800);
    const thinkingRaw = tb.thinkingParts.join(" ").trim();
    const thinkingSummary = thinkingRaw ? cleanText(thinkingRaw, 220) : null;
    const outcomeRaw = tb.outcomeParts.join("\n\n").trim();
    const agentOutcome = outcomeRaw ? cleanText(outcomeRaw, 1200) : null;

    const toolsUsed: CliToolCount[] = [...tb.toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    for (const tc of toolsUsed) totalToolCalls += tc.count;
    totalCommandsRun += tb.commandsRun;
    if (tb.hasWriteTool || tb.filesModified.size > 0) anyWriteTool = true;
    if (tb.hasVerifyCommand) anyVerifyCommand = true;

    const turnModDisplay: string[] = [];
    for (const f of tb.filesModified) {
      const disp = redactSecrets(displayFilePath(f, workspace));
      allModified.add(disp);
      turnModDisplay.push(disp);
    }
    const turnTouchedSet = new Set<string>(turnModDisplay);
    for (const f of tb.filesTouched) {
      turnTouchedSet.add(redactSecrets(displayFilePath(f, workspace)));
    }
    const turnFilesTouched = [...turnTouchedSet].slice(0, 40);
    for (const disp of turnFilesTouched) {
      if (!allTouchedSeen.has(disp)) {
        allTouchedSeen.add(disp);
        allTouchedOrdered.push(disp);
      }
    }

    let outcomeStatus: CliTurnItem["outcomeStatus"];
    if (tb.aborted || (agentOutcome && hasUnresolvedFailureText(agentOutcome))) {
      outcomeStatus = "aborted";
    } else if (!agentOutcome) {
      outcomeStatus = isLast ? "in_progress" : toolsUsed.length > 0 ? "done" : "in_progress";
    } else if (isWaitingForUser(agentOutcome)) {
      outcomeStatus = "waiting";
    } else {
      outcomeStatus = "done";
    }

    return {
      index: idx + 1,
      at: tb.at,
      userInstruction,
      thinkingSummary,
      toolsUsed,
      filesTouched: turnFilesTouched,
      commandsRun: tb.commandsRun,
      agentOutcome,
      outcomeStatus,
    };
  });

  // Order modified files first in session-level filesTouched
  const filesTouched = [
    ...allModified,
    ...allTouchedOrdered.filter((f) => !allModified.has(f)),
  ].slice(0, 60);
  const filesModifiedCount = Math.max(allModified.size, draft.summaryFilesHint);

  // 3. Timestamps & duration
  const startedMs = normalizeTimestampMs(draft.startedAt);
  const updatedMs = normalizeTimestampMs(draft.updatedAt) ?? startedMs ?? nowMs;
  const startedAt = startedMs !== null ? new Date(startedMs).toISOString() : null;
  const updatedAt = new Date(updatedMs).toISOString();
  const durationMins =
    startedMs !== null && updatedMs >= startedMs ? Math.max(0, Math.round((updatedMs - startedMs) / 60_000)) : 0;

  // 4. Live process / Herdr matching
  const ageMs = Math.max(0, nowMs - updatedMs);
  const isVeryRecent = ageMs <= LIVE_RECENT_MS;
  let isLiveActive = false;
  let isLiveWaiting = false;
  let matchedByHerdrLive = false;

  if (matchedHerdr) {
    const st = matchedHerdr.state.toLowerCase();
    if (st === "working" || st === "running") {
      isLiveActive = true;
      matchedByHerdrLive = true;
    } else if (st === "waiting" || st === "blocked") {
      isLiveWaiting = true;
      matchedByHerdrLive = true;
    }
  } else {
    for (const live of liveSessions) {
      if (live.address) continue; // Herdr terminals are matched 1-to-1 above
      if (live.providerId !== draft.providerId) continue;
      const wsMatches =
        Boolean(workspace && live.workspace && workspace === live.workspace) ||
        (!live.workspace && isVeryRecent);
      if (!wsMatches) continue;
      const liveFresh = isVeryRecent || (live.updatedMs !== null && Math.max(0, nowMs - live.updatedMs) <= LIVE_RECENT_MS);
      if (!liveFresh) continue;
      const st = live.state.toLowerCase();
      if (st === "working" || st === "running") isLiveActive = true;
      else if (st === "waiting") isLiveWaiting = true;
    }
  }

  // 5. Status & Progress inference
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const lastRawTurn = draft.turns.length > 0 ? draft.turns[draft.turns.length - 1] : null;

  let status: CliSessionStatus;
  let progressStage: CliProgressStage;
  let progressPct: number;
  let statusReason: string;

  if (lastTurn && lastTurn.outcomeStatus === "aborted" && !matchedByHerdrLive) {
    status = "blocked";
    progressStage = "blocked";
    progressPct = lastTurn.filesTouched.length > 0 || totalToolCalls > 0 ? 60 : 25;
    statusReason = "最近一轮执行被中断或出现未解决错误";
  } else if (
    (lastTurn && !lastTurn.agentOutcome && ageMs <= RUNNING_NO_REPLY_MAX_AGE_MS) ||
    (isLiveActive && (isVeryRecent || matchedByHerdrLive))
  ) {
    status = "running";
    if (lastRawTurn?.hasVerifyCommand) {
      progressStage = "verifying";
      progressPct = 80;
      statusReason = matchedByHerdrLive
        ? `Herdr (${matchedHerdr!.address}) 正在运行构建或测试验证`
        : "正在运行构建或测试验证";
    } else if (lastRawTurn && (lastRawTurn.hasWriteTool || lastRawTurn.filesModified.size > 0)) {
      progressStage = "implementing";
      progressPct = 65;
      statusReason = matchedByHerdrLive
        ? `Herdr (${matchedHerdr!.address}) 正在修改代码并推进实现`
        : "正在修改代码并推进实现";
    } else if (lastTurn && lastTurn.toolsUsed.length > 0) {
      progressStage = "exploring";
      progressPct = 40;
      statusReason = matchedByHerdrLive
        ? `Herdr (${matchedHerdr!.address}) 正在检索代码与分析上下文`
        : "正在检索代码与分析上下文";
    } else {
      progressStage = "received";
      progressPct = 15;
      statusReason = matchedByHerdrLive
        ? `Herdr (${matchedHerdr!.address}) 活跃终端正在处理最新指令`
        : isLiveActive
          ? "活跃 CLI 进程正在处理最新指令"
          : "已收到用户指令，等待模型产出回复";
    }
  } else if (
    (lastTurn && lastTurn.outcomeStatus === "waiting") ||
    (isLiveWaiting && (isVeryRecent || matchedByHerdrLive))
  ) {
    status = "waiting_user";
    progressStage = "waiting";
    progressPct = anyWriteTool || anyVerifyCommand || filesModifiedCount > 0 ? 85 : 55;
    statusReason = matchedByHerdrLive
      ? `Herdr (${matchedHerdr!.address}) 等待你的确认或补充信息`
      : "模型已回复并提出待确认问题，等待你的决定或补充信息";
  } else if (lastTurn && lastTurn.agentOutcome && lastTurn.agentOutcome.length >= 6) {
    status = "completed";
    progressStage = "delivered";
    progressPct = 100;
    if (anyVerifyCommand && (anyWriteTool || filesModifiedCount > 0)) {
      statusReason = "已完成代码改动并执行验证，已交付回复";
    } else if (anyWriteTool || filesModifiedCount > 0) {
      statusReason = "已完成文件修改并交付结果";
    } else if (totalToolCalls > 0) {
      statusReason = "已完成代码调研/工具调用并给出结论";
    } else {
      statusReason = "已完成本轮回复";
    }
  } else {
    status = "idle";
    progressStage = "received";
    progressPct = 20;
    statusReason = "历史会话已静默，暂无明确的进行中或交付记录";
  }

  // 6. Title, instructions & latestProgress
  const firstTurn = turns[0] ?? null;
  const cleanTitleHint =
    draft.titleHint && !GENERIC_TITLES.has(draft.titleHint.trim().toLowerCase()) ? draft.titleHint.trim() : null;
  const titleSource =
    cleanTitleHint ??
    firstTurn?.userInstruction.split("\n")[0] ??
    summaryHint ??
    `${PROVIDER_LABELS[draft.providerId]} 会话 ${draft.rawSessionId.slice(0, 8)}`;
  const title = truncateOneLine(titleSource, 80);

  const firstInstruction = firstTurn
    ? truncateOneLine(firstTurn.userInstruction, 240)
    : truncateOneLine(cleanTitleHint ?? summaryHint ?? title, 240);
  const latestInstruction = lastTurn ? truncateOneLine(lastTurn.userInstruction, 240) : firstInstruction;

  let latestProgressSource: string;
  if (lastTurn?.agentOutcome) {
    latestProgressSource = lastTurn.agentOutcome;
  } else if (lastTurn?.thinkingSummary) {
    latestProgressSource = `思考中：${lastTurn.thinkingSummary}`;
  } else if (lastTurn && lastTurn.toolsUsed.length > 0) {
    latestProgressSource = `最近调用工具：${lastTurn.toolsUsed
      .slice(0, 4)
      .map((t) => `${t.name}×${t.count}`)
      .join("、")}`;
  } else if (summaryHint) {
    latestProgressSource = summaryHint;
  } else {
    latestProgressSource = statusReason;
  }
  const latestProgress = truncateOneLine(latestProgressSource, 280);

  const recentTurnsPreview = turns.slice(-3).map((t) => ({
    index: t.index,
    at: t.at,
    instruction: truncateOneLine(t.userInstruction, 120),
    outcome: t.agentOutcome ? truncateOneLine(t.agentOutcome, 140) : null,
    outcomeStatus: t.outcomeStatus,
  }));

  const id = makeSessionId(draft.providerId, draft.rawSessionId, draft.sourcePath);
  const origin = matchedHerdr?.originTrack === "opc_dispatched"
    ? { originTrack: matchedHerdr.originTrack, originDetail: matchedHerdr.originDetail }
    : detectWorkOrigin({
        labels: matchedHerdr?.labels,
        rawWorkspace: rawWorkspaceCandidate,
        firstInstruction,
        hasHerdrAddress: Boolean(matchedHerdr?.address),
      });

  const linkedTask = hooks.findLinkedTask?.({
    sessionId: id,
    herdrAddress: matchedHerdr?.address ?? null,
  });

  const baseDetail: Omit<CliSessionDetail, "handoffMarkdown"> = {
    id,
    rawSessionId: draft.rawSessionId,
    providerId: draft.providerId,
    provider: PROVIDER_LABELS[draft.providerId],
    title,
    workspace,
    rawWorkspace: rawWorkspaceCandidate,
    project,
    repository: effectiveRepo,
    branch: draft.branch,
    model: draft.model,
    startedAt,
    updatedAt,
    durationMins,
    status,
    progressStage,
    progressPct,
    statusReason: redactSecrets(statusReason),
    firstInstruction,
    latestInstruction,
    latestProgress,
    stats: {
      totalTurns: turns.length,
      instructionCount: turns.length,
      totalToolCalls,
      filesModifiedCount,
      filesTouched,
      commandsRun: totalCommandsRun,
      tokensTotal,
    },
    recentTurnsPreview,
    sourcePath: draft.sourcePath,
    originTrack: origin.originTrack,
    originDetail: origin.originDetail,
    ...(classification ? { classification } : {}),
    herdrAddress: matchedHerdr?.address ?? null,
    herdrSpace: matchedHerdr?.spaceName ?? null,
    herdrParent: matchedHerdr?.parent ?? null,
    herdrName: matchedHerdr?.name ?? null,
    herdrState: matchedHerdr?.state ?? null,
    linkedTaskId: linkedTask?.id ?? null,
    linkedTaskTitle: linkedTask?.title ?? null,
    linkedTaskStatus: linkedTask?.status ?? null,
    turns,
  };

  return {
    ...baseDetail,
    handoffMarkdown: buildHandoffMarkdown(baseDetail),
  };
}

function toSummary(detail: CliSessionDetail): CliSessionSummary {
  const { turns: _turns, handoffMarkdown: _handoff, ...summary } = detail;
  return summary;
}

// ---------------------------------------------------------------------------
// CliLedgerService
// ---------------------------------------------------------------------------
export class CliLedgerService {
  private readonly homeDir: string;
  private readonly hubDbPath: string;
  private readonly hooks: CliLedgerHooks;
  private readonly now: () => number;

  private readonly windowCache = new Map<
    number,
    { at: number; details: CliSessionDetail[]; sources: SourceScanStatus[] }
  >();
  private readonly detailCache = new Map<string, CliSessionDetail>();

  constructor(options: CliLedgerOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.hubDbPath = options.hubDbPath ?? join(this.homeDir, ".agent-hub", "hub.db");
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  private rememberDetail(detail: CliSessionDetail) {
    if (this.detailCache.has(detail.id)) {
      this.detailCache.delete(detail.id);
    }
    this.detailCache.set(detail.id, detail);
    while (this.detailCache.size > DETAIL_CACHE_MAX) {
      const oldestKey = this.detailCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.detailCache.delete(oldestKey);
    }
  }

  invalidateCache(): void {
    this.windowCache.clear();
  }

  getCachedSummaries(windowDays = 3): CliSessionSummary[] {
    const { details } = this.scanWindow(windowDays, false);
    return details.map(toSummary);
  }

  private scanWindow(windowDays: number, forceRefresh = false): {
    details: CliSessionDetail[];
    sources: SourceScanStatus[];
  } {
    const nowMs = this.now();
    if (forceRefresh) {
      clearWorkspaceGitCache();
    } else {
      const cached = this.windowCache.get(windowDays);
      if (cached && nowMs - cached.at < CACHE_TTL_MS) {
        return { details: cached.details, sources: cached.sources };
      }
    }

    const cutoffMs = nowMs - windowDays * MS_PER_DAY;
    const hubMap = loadHubEnrichment(this.hubDbPath, cutoffMs);

    const rawLive = (() => {
      try {
        return this.hooks.getLiveSessions?.() ?? [];
      } catch {
        return [];
      }
    })();
    const liveSessions: NormalizedLiveSession[] = rawLive.map((s) => {
      const normWs = normalizeWorkspace(s.workspace);
      const canonWs =
        normalizeWorkspace(s.canonicalWorkspace) ??
        resolveCanonicalWorkspace(normWs, { homeDir: this.homeDir }).canonicalWorkspace;
      return {
        providerId: normalizeProviderId(s.provider),
        workspace: normWs,
        canonicalWorkspace: canonWs,
        state: String(s.state ?? ""),
        updatedMs: normalizeTimestampMs(s.updatedAt),
        address: s.address?.trim() || null,
        title: s.title?.trim() || null,
        cleanTitle: stripHerdrTitlePrefix(s.title),
        spaceName: s.spaceName?.trim() || null,
        parent: s.parent?.trim() || null,
        name: s.name?.trim() || null,
        labels: s.labels && typeof s.labels === "object" ? s.labels : {},
        originTrack: s.originTrack,
        originDetail: s.originDetail,
      };
    });

    const scanResults = [
      scanAntigravity(this.homeDir, cutoffMs, windowDays),
      scanCodex(this.homeDir, cutoffMs, windowDays),
      scanClaude(this.homeDir, cutoffMs, windowDays),
      scanGrok(this.homeDir, cutoffMs, windowDays),
      scanCursor(this.homeDir, cutoffMs, windowDays),
      scanOpenCode(this.homeDir, cutoffMs, windowDays),
    ];

    const deduped = new Map<string, CliSessionDetail>();
    const sources: SourceScanStatus[] = [];

    const pathChecks = new Map<string, boolean>();
    const fileExists = (path: string) => {
      const cached = pathChecks.get(path);
      if (cached !== undefined) return cached;
      const exists = existsSync(path);
      pathChecks.set(path, exists);
      return exists;
    };

    const allDrafts: ParsedSessionDraft[] = [];
    for (const res of scanResults) {
      sources.push(res.source);
      allDrafts.push(...res.drafts);
    }

    // Pre-compute canonical workspaces for accurate 1-to-1 live Herdr matching
    const draftHints = allDrafts.map((draft) => {
      const rawWs =
        draft.workspace ??
        inferWorkspaceFromPaths(draft.extraAbsPaths, fileExists) ??
        draft.encodedWorkspace ??
        null;
      const resolved = resolveCanonicalWorkspace(rawWs, { homeDir: this.homeDir });
      const updatedMs =
        normalizeTimestampMs(draft.updatedAt) ?? normalizeTimestampMs(draft.startedAt) ?? nowMs;
      return {
        draft,
        rawWs,
        canonicalWs: resolved.canonicalWorkspace,
        updatedMs,
      };
    });

    const herdrMatches = matchLiveHerdrTerminals(draftHints, liveSessions, nowMs);

    for (const draft of allDrafts) {
      const detail = finalizeDraft(
        draft,
        hubMap,
        liveSessions,
        herdrMatches.get(draft) ?? null,
        nowMs,
        this.homeDir,
        fileExists,
        this.hooks,
      );
      const existing = deduped.get(detail.id);
      if (!existing || (detail.updatedAt ?? "") > (existing.updatedAt ?? "")) {
        deduped.set(detail.id, detail);
      }
    }

    const details = [...deduped.values()].sort(
      (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id),
    );

    for (const detail of details) {
      this.rememberDetail(detail);
    }

    this.windowCache.set(windowDays, { at: nowMs, details, sources });
    return { details, sources };
  }

  getOverview(query: CliLedgerQuery = {}): CliLedgerOverview {
    const windowDays = clampInt(query.days, 7, 1, 90);
    const limit = clampInt(query.limit, 100, 1, 500);
    const providerFilter = normalizeProviderId(query.provider);
    const projectFilter =
      query.project && query.project.trim() && query.project.trim().toLowerCase() !== "all"
        ? query.project.trim().toLowerCase()
        : null;
    const categoryFilter =
      query.category &&
      WORKSPACE_CATEGORIES.includes(query.category.trim().toLowerCase() as WorkspaceCategory)
        ? (query.category.trim().toLowerCase() as WorkspaceCategory)
        : null;
    const originFilter =
      query.origin && ["opc_dispatched", "founder_managed"].includes(query.origin.trim().toLowerCase())
        ? (query.origin.trim().toLowerCase() as WorkOriginTrack)
        : null;
    const statusFilter =
      query.status && query.status.trim() && query.status.trim().toLowerCase() !== "all"
        ? (query.status.trim().toLowerCase() as CliSessionStatus)
        : null;
    const qFilter = query.q && query.q.trim() ? query.q.trim().toLowerCase() : null;

    const { details, sources } = this.scanWindow(windowDays, Boolean(query.refresh));

    const matched = details.filter((item) => {
      if (providerFilter && item.providerId !== providerFilter) return false;
      if (projectFilter && item.project.toLowerCase() !== projectFilter) return false;
      if (categoryFilter && (item.classification?.category ?? "personal") !== categoryFilter) return false;
      if (originFilter && (item.originTrack ?? "founder_managed") !== originFilter) return false;
      if (statusFilter && item.status !== statusFilter) return false;
      if (qFilter) {
        const haystack = [
          item.title,
          item.project,
          item.classification?.group ?? "",
          item.classification?.categoryLabel ?? "",
          item.herdrAddress ?? "",
          item.herdrSpace ?? "",
          item.workspace ?? "",
          item.repository ?? "",
          item.branch ?? "",
          item.model ?? "",
          item.provider,
          item.rawSessionId,
          item.firstInstruction,
          item.latestInstruction,
          item.latestProgress,
          ...item.stats.filesTouched,
          ...item.turns.map((t) => `${t.userInstruction} ${t.agentOutcome ?? ""}`),
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(qFilter)) return false;
      }
      return true;
    });

    const totals: CliLedgerOverview["totals"] = {
      sessions: 0,
      instructions: 0,
      running: 0,
      waitingUser: 0,
      completed: 0,
      blocked: 0,
      idle: 0,
      toolCalls: 0,
      filesModified: 0,
    };

    const providerMap = new Map<CliProviderId, CliProviderBreakdown>();
    const categoryMap = new Map<WorkspaceCategory, CliCategoryBreakdown>(
      WORKSPACE_CATEGORIES.map((cat) => [
        cat,
        {
          category: cat,
          categoryLabel: WORKSPACE_CATEGORY_LABELS[cat],
          sessions: 0,
          running: 0,
          waitingUser: 0,
          opcDispatched: 0,
          founderManaged: 0,
        },
      ]),
    );
    const byOrigin = { opcDispatched: 0, founderManaged: 0 };
    const projectMap = new Map<
      string,
      {
        project: string;
        workspace: string | null;
        sessions: number;
        instructions: number;
        providers: Set<string>;
        running: number;
        waitingUser: number;
        completed: number;
        latestUpdatedAt: string | null;
        category: WorkspaceCategory;
        categoryLabel: string;
        group: string;
        classificationKey?: string;
        opcDispatched: number;
        founderManaged: number;
      }
    >();

    for (const s of matched) {
      totals.sessions += 1;
      totals.instructions += s.stats.instructionCount;
      totals.toolCalls += s.stats.totalToolCalls;
      totals.filesModified += s.stats.filesModifiedCount;
      if (s.status === "running") totals.running += 1;
      else if (s.status === "waiting_user") totals.waitingUser += 1;
      else if (s.status === "completed") totals.completed += 1;
      else if (s.status === "blocked") totals.blocked += 1;
      else totals.idle += 1;

      const isOpc = s.originTrack === "opc_dispatched";
      if (isOpc) byOrigin.opcDispatched += 1;
      else byOrigin.founderManaged += 1;

      const cat: WorkspaceCategory = s.classification?.category ?? "personal";
      const cb = categoryMap.get(cat)!;
      cb.sessions += 1;
      if (s.status === "running") cb.running += 1;
      else if (s.status === "waiting_user") cb.waitingUser += 1;
      if (isOpc) cb.opcDispatched += 1;
      else cb.founderManaged += 1;

      let pb = providerMap.get(s.providerId);
      if (!pb) {
        pb = {
          providerId: s.providerId,
          provider: s.provider,
          sessions: 0,
          instructions: 0,
          running: 0,
          waitingUser: 0,
          completed: 0,
          blocked: 0,
          toolCalls: 0,
          filesModified: 0,
        };
        providerMap.set(s.providerId, pb);
      }
      pb.sessions += 1;
      pb.instructions += s.stats.instructionCount;
      pb.toolCalls += s.stats.totalToolCalls;
      pb.filesModified += s.stats.filesModifiedCount;
      if (s.status === "running") pb.running += 1;
      else if (s.status === "waiting_user") pb.waitingUser += 1;
      else if (s.status === "completed") pb.completed += 1;
      else if (s.status === "blocked") pb.blocked += 1;

      let proj = projectMap.get(s.project);
      if (!proj) {
        proj = {
          project: s.project,
          workspace: s.workspace,
          sessions: 0,
          instructions: 0,
          providers: new Set<string>(),
          running: 0,
          waitingUser: 0,
          completed: 0,
          latestUpdatedAt: s.updatedAt,
          category: cat,
          categoryLabel: s.classification?.categoryLabel ?? WORKSPACE_CATEGORY_LABELS[cat],
          group: s.classification?.group ?? WORKSPACE_CATEGORY_LABELS[cat],
          classificationKey: s.classification?.key,
          opcDispatched: 0,
          founderManaged: 0,
        };
        projectMap.set(s.project, proj);
      }
      proj.sessions += 1;
      proj.instructions += s.stats.instructionCount;
      proj.providers.add(s.provider);
      if (!proj.workspace && s.workspace) proj.workspace = s.workspace;
      if (!proj.classificationKey && s.classification?.key) proj.classificationKey = s.classification.key;
      if (s.status === "running") proj.running += 1;
      else if (s.status === "waiting_user") proj.waitingUser += 1;
      else if (s.status === "completed") proj.completed += 1;
      if (isOpc) proj.opcDispatched += 1;
      else proj.founderManaged += 1;
      if (s.updatedAt && (!proj.latestUpdatedAt || s.updatedAt > proj.latestUpdatedAt)) {
        proj.latestUpdatedAt = s.updatedAt;
      }
    }

    const byProvider = [...providerMap.values()].sort(
      (a, b) => b.sessions - a.sessions || a.provider.localeCompare(b.provider),
    );

    const byProject: CliProjectBreakdown[] = [...projectMap.values()]
      .map((p) => ({
        project: p.project,
        workspace: p.workspace,
        sessions: p.sessions,
        instructions: p.instructions,
        providers: [...p.providers].sort(),
        running: p.running,
        waitingUser: p.waitingUser,
        completed: p.completed,
        latestUpdatedAt: p.latestUpdatedAt,
        category: p.category,
        categoryLabel: p.categoryLabel,
        group: p.group,
        classificationKey: p.classificationKey,
        opcDispatched: p.opcDispatched,
        founderManaged: p.founderManaged,
      }))
      .sort(
        (a, b) =>
          b.sessions - a.sessions ||
          b.instructions - a.instructions ||
          (b.latestUpdatedAt ?? "").localeCompare(a.latestUpdatedAt ?? "") ||
          a.project.localeCompare(b.project),
      );

    return {
      generatedAt: new Date(this.now()).toISOString(),
      windowDays,
      totals,
      byProvider,
      byProject,
      byCategory: [...categoryMap.values()],
      byOrigin,
      sessions: matched.slice(0, limit).map(toSummary),
      sources,
    };
  }

  getSession(id: string): CliSessionDetail {
    const cached = this.detailCache.get(id);
    if (cached) {
      this.rememberDetail(cached);
      return cached;
    }
    // Cold lookup fallback: scan a wider 30-day window once
    this.scanWindow(30, false);
    const afterScan = this.detailCache.get(id);
    if (afterScan) {
      this.rememberDetail(afterScan);
      return afterScan;
    }
    throw new ApiError(404, "cli_session_not_found", "未找到对应的 CLI 会话记录。");
  }

  promoteToTask(
    id: string,
    input: { title?: string; project?: string; note?: string; tags?: string[] } = {},
  ): CliLedgerPromoteResult {
    const session = this.getSession(id);
    if (!this.hooks.promoteToTask) {
      throw new ApiError(501, "promote_unavailable", "当前未配置任务看板提升钩子。");
    }
    const customTitle = typeof input.title === "string" && input.title.trim() ? input.title.trim() : null;
    const title = truncateOneLine(customTitle ?? `[${session.provider}] ${session.title}`, 140);
    const project =
      typeof input.project === "string" && input.project.trim()
        ? redactSecrets(input.project.trim())
        : session.project;
    const note = typeof input.note === "string" && input.note.trim() ? `${cleanText(input.note, 600)}\n\n` : "";
    const description = redactSecrets(`${note}${session.handoffMarkdown}`);
    const extraTags = Array.isArray(input.tags)
      ? input.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
      : [];
    const tags = [...new Set(["cli-ledger", session.providerId, ...extraTags])];

    const created = this.hooks.promoteToTask({
      title,
      description,
      project,
      sourceRef: `cli-ledger:${session.id}`,
      tags,
      session: toSummary(session),
    });
    this.invalidateCache();

    return {
      sessionId: session.id,
      taskId: created.id,
      title: created.title,
      project: created.project,
      href: `#planning?task=${encodeURIComponent(created.id)}`,
      alreadyLinked: created.alreadyLinked,
    };
  }

  bindToTask(id: string, taskId: string): CliLedgerPromoteResult {
    const session = this.getSession(id);
    if (!this.hooks.bindToTask) {
      throw new ApiError(501, "bind_unavailable", "当前未配置任务绑定钩子。");
    }
    const cleanTaskId = taskId.trim();
    if (!cleanTaskId) {
      throw new ApiError(400, "invalid_task_id", "请提供目标任务 ID。");
    }
    const bound = this.hooks.bindToTask(cleanTaskId, toSummary(session));
    this.invalidateCache();
    return {
      sessionId: session.id,
      taskId: bound.id,
      title: bound.title,
      project: bound.project,
      href: `#planning?task=${encodeURIComponent(bound.id)}`,
      alreadyLinked: true,
    };
  }
}

async function readOptionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new ApiError(400, "bad_json", "请求体必须是 JSON 对象");
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
  }
}

export function registerCliLedgerRoutes(
  app: Hono,
  user: (c: Context) => unknown,
  options?: RegisterCliLedgerOptions,
): CliLedgerService {
  const service = new CliLedgerService(options);
  const { permits } = submitAuth(options?.submitToken);
  const base = "/api/opc/cli-ledger" as const;

  const guard = async (c: Context, next: () => Promise<void>) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  };

  app.use(base, guard);
  app.use(`${base}/*`, guard);

  app.get(base, (c) => {
    const daysParam = c.req.query("days");
    const limitParam = c.req.query("limit");
    const refreshParam = c.req.query("refresh");
    const overview = service.getOverview({
      days: daysParam !== undefined ? Number(daysParam) : undefined,
      provider: c.req.query("provider") ?? undefined,
      project: c.req.query("project") ?? undefined,
      category: c.req.query("category") ?? undefined,
      origin: c.req.query("origin") ?? undefined,
      status: c.req.query("status") ?? undefined,
      q: c.req.query("q") ?? undefined,
      limit: limitParam !== undefined ? Number(limitParam) : undefined,
      refresh: refreshParam === "1" || refreshParam === "true",
    });
    return c.json(overview);
  });

  app.get(`${base}/:id`, (c) => {
    return c.json(service.getSession(c.req.param("id")));
  });

  app.post(`${base}/:id/promote-task`, async (c) => {
    const body = await readOptionalJsonBody(c);
    const result = service.promoteToTask(c.req.param("id"), {
      title: typeof body.title === "string" ? body.title : undefined,
      project: typeof body.project === "string" ? body.project : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    });
    return c.json(result, 201);
  });

  app.post(`${base}/:id/bind-task`, async (c) => {
    const body = await readOptionalJsonBody(c);
    const result = service.bindToTask(c.req.param("id"), String(body.taskId ?? ""));
    return c.json(result, 200);
  });

  return service;
}

export { ALL_PROVIDER_IDS };
