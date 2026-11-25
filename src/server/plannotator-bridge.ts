import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DecisionOption, DecisionPacket } from "../kernel/types.ts";
import type { WorkflowCard, WorkflowRun } from "../workflow-types.ts";
import { ApiError } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";

const execFileAsync = promisify(execFile);

export const PLANNOTATOR_ENTITY_KINDS = [
  "triage_digest",
  "decision",
  "workflow",
  "arbitrator_digest",
] as const;

export type PlannotatorEntityKind = (typeof PLANNOTATOR_ENTITY_KINDS)[number];

export type PlannotatorLinkStatus =
  | "open"
  | "synced"
  | "superseded"
  | "resolved"
  | "stale_closed";

export type StaleReasonCode =
  | "plannotator_thread_resolved"
  | "plannotator_thread_superseded"
  | "workflow_stale_timeout"
  | "workspace_commit_superseded"
  | "referenced_task_closed"
  | "release_already_terminal"
  | "branch_already_merged";

export interface PlannotatorHealth {
  available: boolean;
  running: boolean;
  state: string;
  url: string | null;
  port: number | null;
  version: string | null;
  cliPath: string | null;
  reason?: string | null;
}

export interface PlannotatorQuestionChoice {
  id?: string;
  label: string;
  description?: string;
  value?: string;
}

export interface PlannotatorQuestionSpec {
  prompt: string;
  context?: string;
  kind?: "single" | "multi" | "text";
  choices?: PlannotatorQuestionChoice[];
  recommendedLabel?: string | null;
  why?: string;
  stakes?: string;
  stopped?: string;
  holdsUp?: string[];
  replaces?: string;
}

export interface PlannotatorQuestionAnswer {
  selected?: string[];
  other?: string;
  text?: string;
  note?: string;
  skipped?: boolean;
}

export interface PlannotatorQuestionRef {
  key: string;
  q?: number;
  state?: string;
  kind?: string;
  prompt?: string;
  choices?: string[];
  supersededBy?: string | null;
  answer?: PlannotatorQuestionAnswer | null;
}

export interface PlannotatorSendMessageInput {
  body: string;
  subject?: string;
  thread?: string;
  replyTo?: string;
  supersedes?: string[];
  priority?: boolean;
  idempotencyKey?: string;
  projectPath?: string;
  agentName?: string;
  attachments?: string[];
  pulls?: string[];
}

export interface PlannotatorSendMessageResult {
  messageId: string;
  threadId: string;
  newThread: boolean;
  cursor?: number | string | null;
  url?: string | null;
  questions?: PlannotatorQuestionRef[];
}

export interface PlannotatorThreadMessage {
  id: string;
  authorKind: "agent" | "person" | "system";
  authorName?: string | null;
  createdAt: string;
  replyTo?: string | null;
  body: string;
  questions?: PlannotatorQuestionRef[];
}

export interface PlannotatorThreadDetail {
  threadId: string;
  subject: string;
  threadName?: string | null;
  resolvedAt: string | null;
  messageCount: number;
  openQuestions: Array<PlannotatorQuestionRef & { messageId: string }>;
  messages: PlannotatorThreadMessage[];
  earlier?: PlannotatorThreadMessage[];
  cursor?: number | string | null;
  url?: string | null;
}

export interface PlannotatorThreadSummary {
  threadId: string;
  subject: string;
  threadName?: string | null;
  section?: string | null;
  messageCount: number;
  openQuestions: number;
  lastAuthor: string | null;
  lastAt: string | null;
  lastPersonAt: string | null;
  lastPersonMessageId: string | null;
  unread: boolean;
  resolvedAt: string | null;
}

export interface PlannotatorReadThreadInput {
  threadId: string;
  after?: string | number;
  limit?: number;
  format?: "full";
  expand?: string[];
  projectPath?: string;
}

export interface PlannotatorListThreadsInput {
  askedBy?: "me" | "anyone";
  includeResolved?: boolean;
  limit?: number;
  projectPath?: string;
}

export interface PlannotatorResolveMessageInput {
  messageId: string;
  resolved?: boolean;
  projectPath?: string;
}

export interface PlannotatorTransport {
  healthCheck(): Promise<PlannotatorHealth>;
  sendMessage(input: PlannotatorSendMessageInput): Promise<PlannotatorSendMessageResult>;
  readThread(input: PlannotatorReadThreadInput): Promise<PlannotatorThreadDetail | null>;
  listThreads(input?: PlannotatorListThreadsInput): Promise<PlannotatorThreadSummary[]>;
  resolveMessage(input: PlannotatorResolveMessageInput): Promise<{ resolved: boolean; threadId?: string }>;
}

export interface PlannotatorBridgeConfig {
  enabled: boolean;
  baseUrl: string;
  defaultThreadName: string;
  projectPath: string;
  pushEscalatedDecisions: boolean;
  pushBotSummaries: boolean;
  syncIntervalSecs: number;
  staleWorkflowHours: number;
  autoReconcileStale: boolean;
  updatedAt: string;
}

export type PlannotatorBridgeConfigPatch = Partial<Omit<PlannotatorBridgeConfig, "updatedAt">>;

export interface PushDigestEntityRef {
  kind: PlannotatorEntityKind | "task" | "release";
  id: string;
  label?: string;
  revision?: number;
}

export interface PlannotatorLinkMeta {
  revision?: number;
  entityRefs?: PushDigestEntityRef[];
  lastCursor?: number | string | null;
  lastSyncedReplyId?: string | null;
  url?: string | null;
  sharedThread?: boolean;
  subject?: string;
}

export interface PlannotatorLinkRecord {
  id: string;
  entityKind: PlannotatorEntityKind;
  entityId: string;
  threadId: string;
  threadName: string;
  lastMessageId: string;
  questionKey: string | null;
  choices: PlannotatorQuestionChoice[];
  meta: PlannotatorLinkMeta;
  status: PlannotatorLinkStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlannotatorSyncLogRecord {
  id: string;
  direction: "outbound" | "inbound" | "reconcile";
  action: string;
  entityKind: string | null;
  entityId: string | null;
  threadId: string | null;
  messageId: string | null;
  status: "ok" | "skipped" | "offline" | "error";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface PushDigestInput {
  kind: PlannotatorEntityKind;
  entityId?: string;
  title: string;
  body: string;
  threadName?: string;
  question?: PlannotatorQuestionSpec | null;
  entityRefs?: PushDigestEntityRef[];
  revision?: number;
  priority?: boolean;
  supersedePrevious?: boolean;
  idempotencyKey?: string;
  attachments?: string[];
  pulls?: string[];
}

export interface PushDigestResult {
  ok: boolean;
  available: boolean;
  skipped: boolean;
  reason?: string;
  link: PlannotatorLinkRecord | null;
  threadId: string | null;
  messageId: string | null;
  newThread: boolean;
  supersededPrevious: boolean;
  url: string | null;
}

export interface BotSummaryItem {
  id?: string;
  targetKind?: string;
  targetId?: string;
  title?: string;
  actor?: string;
  verdict: string;
  executed?: boolean;
  reason?: string;
  nextStep?: string;
  createdAt?: string;
}

export interface ParsedPlannotatorAnswer {
  kind: "answered" | "superseded";
  replyMessageId: string | null;
  repliedAt: string | null;
  selectedLabels: string[];
  matchedOptionId: string | null;
  matchedChoiceLabel: string | null;
  matchedChoiceValue: string | null;
  otherText: string | null;
  freeText: string | null;
  note: string | null;
  skipped: boolean;
  rawBody: string;
  supersededBy?: string | null;
}

export interface PlannotatorAnswerEvent {
  link: PlannotatorLinkRecord;
  entityKind: PlannotatorEntityKind;
  entityId: string;
  threadId: string;
  replyMessageId: string;
  repliedAt: string;
  selectedLabels: string[];
  matchedOptionId: string | null;
  matchedChoiceLabel: string | null;
  matchedChoiceValue: string | null;
  otherText: string | null;
  freeText: string | null;
  note: string | null;
  skipped: boolean;
  rawBody: string;
  entityRefs: PushDigestEntityRef[];
}

export interface SyncReplyOutcome {
  linkId: string;
  entityKind: PlannotatorEntityKind;
  entityId: string;
  threadId: string;
  outcome: "synced" | "superseded" | "resolved" | "pending" | "error";
  matchedOptionId?: string | null;
  matchedChoiceLabel?: string | null;
  replyMessageId?: string | null;
  error?: string;
}

export interface SyncRepliesResult {
  ok: boolean;
  available: boolean;
  checked: number;
  synced: number;
  superseded: number;
  resolved: number;
  errors: string[];
  items: SyncReplyOutcome[];
}

export interface GitStaleChecker {
  isCommitSuperseded?(params: {
    workspace: string;
    baseCommit: string;
    runId: string;
  }): Promise<{ superseded: boolean; reason?: string; currentHead?: string } | boolean>;
  isBranchMerged?(params: {
    repoPath: string;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<{ merged: boolean; reason?: string } | boolean>;
}

export interface StaleWorkflowCloseParams {
  runId: string;
  cardId: string;
  cardKind: WorkflowCard["kind"];
  revision: number;
  goal: string;
  reason: string;
  reasonCode: StaleReasonCode;
  actor: string;
}

export interface StaleDecisionSupersedeParams {
  decisionId: string;
  title: string;
  kind: string;
  reason: string;
  reasonCode: StaleReasonCode;
  actor: string;
}

export interface ReconcileStaleItem {
  entityKind: "workflow" | "decision";
  entityId: string;
  cardId?: string;
  title: string;
  reasonCode: StaleReasonCode;
  reason: string;
  applied: boolean;
  error?: string;
}

export interface ReconcileStaleResult {
  dryRun: boolean;
  staleHours: number;
  plannotatorAvailable: boolean;
  inspectedWorkflows: number;
  inspectedDecisions: number;
  closedWorkflows: number;
  supersededDecisions: number;
  items: ReconcileStaleItem[];
}

export interface PlannotatorBridgeStatus {
  available: boolean;
  health: PlannotatorHealth;
  config: PlannotatorBridgeConfig;
  counts: {
    openLinks: number;
    syncedLinks: number;
    staleClosedLinks: number;
    totalLinks: number;
  };
  links: PlannotatorLinkRecord[];
  recentLogs: PlannotatorSyncLogRecord[];
}

export interface PlannotatorBridgeHooks {
  onDecisionAnswer?: (
    event: PlannotatorAnswerEvent,
  ) => Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  onWorkflowAnswer?: (
    event: PlannotatorAnswerEvent,
  ) => Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  onTriageDigestAnswer?: (
    event: PlannotatorAnswerEvent,
  ) => Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  onArbitratorDigestAnswer?: (
    event: PlannotatorAnswerEvent,
  ) => Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  closeStaleWorkflow?: (
    params: StaleWorkflowCloseParams,
  ) => Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  supersedeDecision?: (
    params: StaleDecisionSupersedeParams,
  ) => Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  gitChecker?: GitStaleChecker;
}

export interface PlannotatorBridgeDeps extends PlannotatorBridgeHooks {
  transport?: PlannotatorTransport;
  projectPath?: string;
  cliBin?: string;
  sessionId?: string;
  autoStartIfStopped?: boolean;
  now?: () => Date;
}

export interface RegisterPlannotatorBridgeDeps extends PlannotatorBridgeDeps {
  user?: (c: Context) => unknown;
  submitToken?: string;
  service?: PlannotatorBridgeService;
}

export interface OpcRefAnchor {
  kind: PlannotatorEntityKind;
  id: string;
  revision?: number;
  refs?: Array<{ kind: string; id: string }>;
}

const DEFAULT_THREAD_NAME = "OPC 每日任务审查与拍板汇总";
const DEFAULT_BASE_URL = "http://localhost:53798/";
const DEFAULT_STALE_HOURS = 72;
const DEFAULT_SYNC_INTERVAL_SECS = 120;
const PLANNOTATOR_LEFT_OUT_MARKER = "[Answers to your questions: left out here";
const PLANNOTATOR_THREAD_ID_RE = /\bmsg_[0-9A-Z]{20,}\b/g;

export class PlannotatorUnavailableError extends Error {
  readonly code = "plannotator_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "PlannotatorUnavailableError";
  }
}

export class PlannotatorCommandError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "PlannotatorCommandError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function singleLine(value: string, maxLen = 180): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/**
 * Strips any accidental "(recommended)" / "（推荐）" tag from a choice label so
 * Plannotator's rule ("never write '(recommended)' in a choice label") is always enforced.
 */
export function sanitizeChoiceLabel(label: string): string {
  return singleLine(
    label
      .replace(/\s*[(\[（【]\s*(?:recommended|推荐|建议)\s*[)\]）】]\s*$/i, "")
      .replace(/\s*\(your recommendation\)\s*$/i, ""),
    220,
  );
}

function isNegativeStopValue(value: string | undefined): boolean {
  if (!value) return true;
  const norm = value.trim().toLowerCase();
  return !norm || norm === "no" || norm === "none" || norm === "n/a" || norm === "-";
}

/**
 * Formats a Plannotator `:::question` block following official Inbox rules:
 * - Natural choice order (never moves recommended choice first)
 * - No "(recommended)" inside choice labels
 * - `Recommended: <label>` on its own line after choices
 */
export function formatPlannotatorQuestion(spec: PlannotatorQuestionSpec): string {
  const prompt = singleLine(spec.prompt, 300);
  const rawChoices = spec.choices ?? [];
  const cleanChoices = rawChoices
    .map((c) => ({
      ...c,
      cleanLabel: sanitizeChoiceLabel(c.label),
      cleanDescription: c.description ? singleLine(c.description, 260) : "",
    }))
    .filter((c) => c.cleanLabel.length > 0);

  const kind =
    spec.kind === "multi"
      ? "question-multi"
      : spec.kind === "text" || cleanChoices.length === 0
        ? "question-text"
        : "question";

  const lines: string[] = [`:::${kind}`, prompt];

  if (spec.context && spec.context.trim()) {
    lines.push("", spec.context.trim());
  }

  const metaLines: string[] = [];
  if (spec.stakes && spec.stakes.trim()) {
    metaLines.push(`Stakes: ${singleLine(spec.stakes, 260)}`);
  }
  if (!isNegativeStopValue(spec.stopped)) {
    metaLines.push(`Stopped: ${singleLine(spec.stopped!, 220)}`);
  }
  const holdsUp = (spec.holdsUp ?? []).map((item) => singleLine(item, 120)).filter(Boolean);
  if (holdsUp.length > 0) {
    metaLines.push(`Holds up: ${holdsUp.join("; ")}`);
  }
  if (spec.replaces && spec.replaces.trim()) {
    metaLines.push(`Replaces: ${singleLine(spec.replaces, 160)}`);
  }
  if (metaLines.length > 0) {
    lines.push("", ...metaLines);
  }

  if (cleanChoices.length > 0) {
    lines.push("");
    for (const c of cleanChoices) {
      lines.push(c.cleanDescription ? `- [ ] ${c.cleanLabel} — ${c.cleanDescription}` : `- [ ] ${c.cleanLabel}`);
    }
  }

  if (spec.recommendedLabel && spec.recommendedLabel.trim()) {
    const rawRec = spec.recommendedLabel.trim();
    const matched = cleanChoices.find(
      (c) =>
        (c.id && c.id === rawRec) ||
        normalizeKey(c.label) === normalizeKey(rawRec) ||
        normalizeKey(c.cleanLabel) === normalizeKey(sanitizeChoiceLabel(rawRec)),
    );
    const resolvedRec = matched ? matched.cleanLabel : sanitizeChoiceLabel(rawRec);
    if (resolvedRec) {
      lines.push("", `Recommended: ${resolvedRec}`);
    }
  }

  if (spec.why && spec.why.trim()) {
    lines.push("", `Why: ${singleLine(spec.why, 280)}`);
  }

  lines.push(":::");
  return lines.join("\n");
}

export function formatOpcRefAnchor(anchor: OpcRefAnchor): string {
  return `<!-- opc-ref: ${JSON.stringify(anchor)} -->`;
}

export function parseOpcRefAnchor(body: string): OpcRefAnchor | null {
  const match = /<!--\s*opc-ref:\s*(\{[\s\S]*?\})\s*-->/.exec(body);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<OpcRefAnchor>;
    if (!parsed.kind || !parsed.id) return null;
    return {
      kind: parsed.kind,
      id: String(parsed.id),
      revision: typeof parsed.revision === "number" ? parsed.revision : undefined,
      refs: Array.isArray(parsed.refs) ? parsed.refs : undefined,
    };
  } catch {
    return null;
  }
}

function stripChoiceSuffix(text: string): string {
  return sanitizeChoiceLabel(text.replace(/\s+[—–-]\s+.*$/, ""));
}

function matchChoice(
  candidates: string[],
  choices: PlannotatorQuestionChoice[],
): PlannotatorQuestionChoice | null {
  if (!choices.length || !candidates.length) return null;

  const normalizedChoices = choices.map((choice) => ({
    choice,
    idNorm: choice.id ? normalizeKey(choice.id) : "",
    labelNorm: normalizeKey(sanitizeChoiceLabel(choice.label)),
    shortNorm: normalizeKey(stripChoiceSuffix(choice.label)),
    valueNorm: choice.value ? normalizeKey(choice.value) : "",
  }));

  // Pass 1: exact match on cleaned label, short label, or choice id
  for (const raw of candidates) {
    const cleaned = normalizeKey(sanitizeChoiceLabel(raw));
    const stripped = normalizeKey(stripChoiceSuffix(raw));
    if (!cleaned) continue;
    for (const item of normalizedChoices) {
      if (
        item.labelNorm === cleaned ||
        item.shortNorm === cleaned ||
        item.labelNorm === stripped ||
        item.shortNorm === stripped ||
        (item.idNorm && item.idNorm === cleaned)
      ) {
        return item.choice;
      }
    }
  }

  // Pass 2: unique prefix or substring match
  for (const raw of candidates) {
    const cleaned = normalizeKey(sanitizeChoiceLabel(raw));
    if (cleaned.length < 2) continue;
    const hits = normalizedChoices.filter(
      (item) =>
        (item.labelNorm.length >= 2 && (cleaned.includes(item.labelNorm) || item.labelNorm.includes(cleaned))) ||
        (item.shortNorm.length >= 2 && (cleaned.includes(item.shortNorm) || item.shortNorm.includes(cleaned))),
    );
    if (hits.length === 1) {
      return hits[0].choice;
    }
  }

  return null;
}

interface ParsedMarkdownAnswerBlock {
  selectedLabels: string[];
  otherText: string | null;
  freeText: string | null;
  note: string | null;
  skipped: boolean;
}

function parseAnswersMarkdownSection(body: string): ParsedMarkdownAnswerBlock | null {
  const hasAnswersHeading =
    /(?:^|\n)#{1,3}\s*Answers to your questions\b/i.test(body) ||
    /(?:^|\n)###\s*Q\d+\./i.test(body) ||
    /(?:^|\n)(?:Answer|Other):\s+/i.test(body);
  if (!hasAnswersHeading) return null;

  const selectedLabels: string[] = [];
  let otherText: string | null = null;
  let note: string | null = null;
  let skipped = false;
  const quoteLines: string[] = [];

  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const answerMatch = /^Answer:\s*(.+)$/i.exec(trimmed);
    if (answerMatch) {
      const value = sanitizeChoiceLabel(answerMatch[1]);
      if (value) {
        // Multi-choice answers may be comma/newline or semicolon separated when not matching single choice
        selectedLabels.push(value);
      }
      continue;
    }
    const otherMatch = /^Other:\s*(.+)$/i.exec(trimmed);
    if (otherMatch) {
      otherText = otherMatch[1].trim();
      continue;
    }
    const noteMatch = /^Note:\s*(.+)$/i.exec(trimmed);
    if (noteMatch) {
      note = note ? `${note}\n${noteMatch[1].trim()}` : noteMatch[1].trim();
      continue;
    }
    if (/^Skipped$/i.test(trimmed)) {
      skipped = true;
      continue;
    }
    const quoteMatch = /^>\s*(.+)$/.exec(trimmed);
    if (quoteMatch) {
      quoteLines.push(quoteMatch[1].trim());
    }
  }

  const freeText = quoteLines.length > 0 ? quoteLines.join("\n") : null;
  if (!selectedLabels.length && !otherText && !freeText && !note && !skipped) {
    return null;
  }
  return { selectedLabels, otherText, freeText, note, skipped };
}

/**
 * Parses a Plannotator thread detail to extract the user's answer (if any) for a linked OPC OS entity.
 * Handles both Plannotator's structured `questions[].answer` metadata and markdown/free-text replies.
 */
export function parsePlannotatorReply(input: {
  thread: PlannotatorThreadDetail;
  link: PlannotatorLinkRecord;
}): ParsedPlannotatorAnswer | null {
  const { thread, link } = input;
  const allMessages: PlannotatorThreadMessage[] = [
    ...(thread.earlier ?? []),
    ...(thread.messages ?? []),
  ];

  // Deduplicate messages preserving chronological order
  const seenMsgIds = new Set<string>();
  const orderedMessages: PlannotatorThreadMessage[] = [];
  for (const m of allMessages) {
    if (!m.id || seenMsgIds.has(m.id)) continue;
    seenMsgIds.add(m.id);
    orderedMessages.push(m);
  }
  orderedMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const linkedAgentMsg = orderedMessages.find((m) => m.id === link.lastMessageId) ?? null;

  // Locate person replies targeting our linked message (or arriving after it in the thread)
  const linkedIndex = linkedAgentMsg ? orderedMessages.findIndex((m) => m.id === linkedAgentMsg.id) : -1;
  const candidatePersonReplies = orderedMessages.filter((m, idx) => {
    if (m.authorKind !== "person") return false;
    if (m.replyTo === link.lastMessageId) return true;
    // If replyTo explicitly targets another message, only allow thread-root replies on dedicated (non-shared) threads
    if (m.replyTo) {
      if (link.meta.sharedThread || m.replyTo !== link.threadId) {
        return false;
      }
    }
    if (linkedIndex >= 0) {
      return idx > linkedIndex;
    }
    // Incremental `after` read where linkedAgentMsg is older than the returned window
    return Date.parse(m.createdAt) >= Date.parse(link.createdAt);
  });

  // 1. Check structured question answer/superseded state directly on linked agent message
  if (linkedAgentMsg?.questions?.length) {
    const q =
      (link.questionKey
        ? linkedAgentMsg.questions.find((item) => item.key === link.questionKey)
        : null) ?? linkedAgentMsg.questions[0];

    if (q) {
      if (q.state === "superseded") {
        return {
          kind: "superseded",
          replyMessageId: null,
          repliedAt: null,
          selectedLabels: [],
          matchedOptionId: null,
          matchedChoiceLabel: null,
          matchedChoiceValue: null,
          otherText: null,
          freeText: null,
          note: null,
          skipped: false,
          rawBody: "",
          supersededBy: q.supersededBy ?? null,
        };
      }

      if (q.state === "sent" || q.state === "skipped" || q.answer) {
        const selectedLabels = (q.answer?.selected ?? []).map(sanitizeChoiceLabel).filter(Boolean);
        const otherText = q.answer?.other?.trim() || null;
        const freeText = q.answer?.text?.trim() || null;
        const note = q.answer?.note?.trim() || null;
        const skipped = q.state === "skipped" || Boolean(q.answer?.skipped);
        const directReply =
          candidatePersonReplies.find((m) => m.replyTo === link.lastMessageId) ??
          candidatePersonReplies[candidatePersonReplies.length - 1] ??
          null;

        const candidates = [...selectedLabels, ...(otherText ? [otherText] : []), ...(freeText ? [freeText] : [])];
        const matched = matchChoice(candidates, link.choices);

        return {
          kind: "answered",
          replyMessageId: directReply?.id ?? `${link.lastMessageId}:answered`,
          repliedAt: directReply?.createdAt ?? new Date().toISOString(),
          selectedLabels,
          matchedOptionId: matched?.id ?? null,
          matchedChoiceLabel: matched ? sanitizeChoiceLabel(matched.label) : selectedLabels[0] ?? null,
          matchedChoiceValue: matched?.value ?? null,
          otherText,
          freeText,
          note,
          skipped,
          rawBody: directReply?.body ?? "",
        };
      }
    }
  }

  // 2. Parse person reply messages (newest direct reply first, then subsequent replies)
  const directReplies = candidatePersonReplies.filter((m) => m.replyTo === link.lastMessageId);
  const repliesToInspect = directReplies.length > 0 ? [...directReplies].reverse() : [...candidatePersonReplies].reverse();

  for (const reply of repliesToInspect) {
    const body = (reply.body ?? "").trim();
    if (!body) continue;
    // Skip Plannotator's compressed placeholder when structured question wasn't in this window
    if (body.includes(PLANNOTATOR_LEFT_OUT_MARKER)) {
      continue;
    }

    const parsedSection = parseAnswersMarkdownSection(body);
    if (parsedSection) {
      const candidates = [
        ...parsedSection.selectedLabels,
        ...(parsedSection.otherText ? [parsedSection.otherText] : []),
        ...(parsedSection.freeText ? [parsedSection.freeText] : []),
      ];
      const matched = matchChoice(candidates, link.choices);
      return {
        kind: "answered",
        replyMessageId: reply.id,
        repliedAt: reply.createdAt,
        selectedLabels: parsedSection.selectedLabels,
        matchedOptionId: matched?.id ?? null,
        matchedChoiceLabel: matched ? sanitizeChoiceLabel(matched.label) : parsedSection.selectedLabels[0] ?? null,
        matchedChoiceValue: matched?.value ?? null,
        otherText: parsedSection.otherText,
        freeText: parsedSection.freeText,
        note: parsedSection.note,
        skipped: parsedSection.skipped,
        rawBody: body,
      };
    }

    // Explicit free-text reply matching a choice label (or direct reply to our linked message)
    const matched = matchChoice([body], link.choices);
    if (matched || reply.replyTo === link.lastMessageId || !link.meta.sharedThread) {
      return {
        kind: "answered",
        replyMessageId: reply.id,
        repliedAt: reply.createdAt,
        selectedLabels: matched ? [sanitizeChoiceLabel(matched.label)] : [],
        matchedOptionId: matched?.id ?? null,
        matchedChoiceLabel: matched ? sanitizeChoiceLabel(matched.label) : null,
        matchedChoiceValue: matched?.value ?? null,
        otherText: null,
        freeText: body,
        note: matched && normalizeKey(body) !== normalizeKey(sanitizeChoiceLabel(matched.label)) ? body : null,
        skipped: false,
        rawBody: body,
      };
    }
  }

  return null;
}

function resolveDefaultPlannotatorBin(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const envBin = process.env.PLANNOTATOR_BIN?.trim();
  if (envBin) return envBin;
  const localBin = join(homedir(), ".local", "bin", "plannotator");
  if (existsSync(localBin)) return localBin;
  return "plannotator";
}

function mapRawQuestion(raw: Record<string, unknown>): PlannotatorQuestionRef {
  const rawAnswer =
    raw.answer && typeof raw.answer === "object" && !Array.isArray(raw.answer)
      ? (raw.answer as Record<string, unknown>)
      : null;

  return {
    key: String(raw.key ?? ""),
    q: typeof raw.q === "number" ? raw.q : undefined,
    state: typeof raw.state === "string" ? raw.state : undefined,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    choices: Array.isArray(raw.choices) ? raw.choices.map((c) => String(c)) : undefined,
    supersededBy: typeof raw.superseded_by === "string" ? raw.superseded_by : null,
    answer: rawAnswer
      ? {
          selected: Array.isArray(rawAnswer.selected) ? rawAnswer.selected.map((s) => String(s)) : undefined,
          other: typeof rawAnswer.other === "string" ? rawAnswer.other : undefined,
          text: typeof rawAnswer.text === "string" ? rawAnswer.text : undefined,
          note: typeof rawAnswer.note === "string" ? rawAnswer.note : undefined,
          skipped: Boolean(rawAnswer.skipped),
        }
      : null,
  };
}

function mapRawThreadMessage(raw: Record<string, unknown>): PlannotatorThreadMessage {
  const authorObj =
    raw.author && typeof raw.author === "object" && !Array.isArray(raw.author)
      ? (raw.author as Record<string, unknown>)
      : {};
  const rawKind = String(authorObj.kind ?? "system");
  const authorKind: PlannotatorThreadMessage["authorKind"] =
    rawKind === "person" ? "person" : rawKind === "agent" ? "agent" : "system";
  const body =
    typeof raw.body === "string"
      ? raw.body
      : typeof raw.words === "string"
        ? raw.words
        : "";

  return {
    id: String(raw.id ?? ""),
    authorKind,
    authorName: typeof authorObj.name === "string" ? authorObj.name : null,
    createdAt: String(raw.created_at ?? ""),
    replyTo: typeof raw.reply_to === "string" ? raw.reply_to : null,
    body,
    questions: Array.isArray(raw.questions)
      ? raw.questions
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map(mapRawQuestion)
      : undefined,
  };
}

export function mapRawReadThreadResponse(
  raw: Record<string, unknown>,
  fallbackThreadId: string,
): PlannotatorThreadDetail {
  const threadMeta =
    raw.thread && typeof raw.thread === "object" && !Array.isArray(raw.thread)
      ? (raw.thread as Record<string, unknown>)
      : {};

  const rawOpenQuestions = Array.isArray(threadMeta.open_questions)
    ? threadMeta.open_questions
    : Array.isArray(raw.open_questions)
      ? raw.open_questions
      : [];
  const rawMessages = Array.isArray(threadMeta.messages)
    ? threadMeta.messages
    : Array.isArray(raw.messages)
      ? raw.messages
      : [];
  const rawEarlier = Array.isArray(threadMeta.earlier)
    ? threadMeta.earlier
    : Array.isArray(raw.earlier)
      ? raw.earlier
      : undefined;

  const openQuestions = rawOpenQuestions
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      ...mapRawQuestion(item),
      messageId: String(item.message_id ?? ""),
    }));

  const messages = rawMessages
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map(mapRawThreadMessage);

  const earlier = rawEarlier
    ? rawEarlier
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map(mapRawThreadMessage)
    : undefined;

  return {
    threadId: String(threadMeta.thread_id ?? fallbackThreadId),
    subject: String(threadMeta.subject ?? ""),
    threadName: typeof threadMeta.thread_name === "string" ? threadMeta.thread_name : null,
    resolvedAt: typeof threadMeta.resolved_at === "string" ? threadMeta.resolved_at : null,
    messageCount: Number(threadMeta.message_count ?? messages.length),
    openQuestions,
    messages,
    earlier,
    cursor:
      typeof raw.cursor === "number" || typeof raw.cursor === "string" ? raw.cursor : null,
    url: typeof raw.url === "string" ? raw.url : null,
  };
}

export interface CliPlannotatorTransportOptions {
  cliBin?: string;
  projectPath?: string;
  sessionId?: string;
  autoStartIfStopped?: boolean;
  timeoutMs?: number;
}

/**
 * Sanctioned local Plannotator transport backed by `plannotator inbox status --json`
 * and `plannotator inbox call <action> -`.
 */
export class CliPlannotatorTransport implements PlannotatorTransport {
  private readonly cliBin: string;
  private readonly projectPath: string;
  private readonly sessionId?: string;
  private readonly autoStartIfStopped: boolean;
  private readonly timeoutMs: number;

  constructor(options: CliPlannotatorTransportOptions = {}) {
    this.cliBin = resolveDefaultPlannotatorBin(options.cliBin);
    this.projectPath = options.projectPath || process.cwd();
    this.sessionId = options.sessionId;
    this.autoStartIfStopped = Boolean(options.autoStartIfStopped);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async healthCheck(): Promise<PlannotatorHealth> {
    try {
      const { stdout } = await execFileAsync(this.cliBin, ["inbox", "status", "--json"], {
        timeout: Math.min(this.timeoutMs, 5_000),
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      const running = Boolean(parsed.running);
      return {
        available: running,
        running,
        state: String(parsed.state ?? (running ? "running" : "stopped")),
        url: typeof parsed.url === "string" ? parsed.url : null,
        port: typeof parsed.port === "number" ? parsed.port : null,
        version: typeof parsed.version === "string" ? parsed.version : null,
        cliPath: this.cliBin,
        reason: typeof parsed.reason === "string" ? parsed.reason : running ? null : "inbox_stopped",
      };
    } catch (err) {
      const e = err as { code?: string | number; stdout?: string; stderr?: string; message?: string };
      // `plannotator inbox status --json` may exit non-zero while still writing JSON on stdout
      if (typeof e.stdout === "string" && e.stdout.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(e.stdout.trim()) as Record<string, unknown>;
          const running = Boolean(parsed.running);
          return {
            available: running,
            running,
            state: String(parsed.state ?? "stopped"),
            url: typeof parsed.url === "string" ? parsed.url : null,
            port: typeof parsed.port === "number" ? parsed.port : null,
            version: typeof parsed.version === "string" ? parsed.version : null,
            cliPath: this.cliBin,
            reason: typeof parsed.reason === "string" ? parsed.reason : "inbox_stopped",
          };
        } catch {
          // fall through to unavailable
        }
      }
      const reason =
        e.code === "ENOENT"
          ? "plannotator_cli_not_found"
          : (e.stderr?.trim() || e.message || "plannotator_status_failed").slice(0, 240);
      return {
        available: false,
        running: false,
        state: "unavailable",
        url: null,
        port: null,
        version: null,
        cliPath: this.cliBin,
        reason,
      };
    }
  }

  private async runCall<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.autoStartIfStopped) {
      const health = await this.healthCheck();
      if (!health.available) {
        throw new PlannotatorUnavailableError(
          `Plannotator Inbox 当前未运行或不可达 (${health.reason ?? health.state})`,
        );
      }
    }

    const args = ["inbox", "call"];
    if (this.sessionId) {
      args.push("--session", this.sessionId);
    }
    args.push(action, "-");

    const stdinJson = JSON.stringify(payload);
    const { exitCode, stdout, stderr } = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(this.cliBin, args, {
          cwd: this.projectPath,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        rejectPromise(err);
        return;
      }

      let out = "";
      let errOut = "";
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        rejectPromise(new PlannotatorUnavailableError(`plannotator inbox call ${action} 超时 (${this.timeoutMs}ms)`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errOut += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        rejectPromise(new PlannotatorUnavailableError(err.message));
      });
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolvePromise({ exitCode: code ?? 1, stdout: out.trim(), stderr: errOut.trim() });
      });

      child.stdin.write(stdinJson);
      child.stdin.end();
    });

    if (exitCode !== 0) {
      const codeMatch = /^([a-z0-9_]+):\s*(.*)$/i.exec(stderr);
      const errCode = codeMatch ? codeMatch[1] : "plannotator_call_failed";
      const errMsg = codeMatch ? codeMatch[2] || stderr : stderr || `exit ${exitCode}`;
      if (errCode === "no_inbox" || errCode === "connection_refused") {
        throw new PlannotatorUnavailableError(errMsg);
      }
      throw new PlannotatorCommandError(errCode, errMsg, exitCode);
    }

    if (!stdout) {
      return {} as T;
    }
    return JSON.parse(stdout) as T;
  }

  async sendMessage(input: PlannotatorSendMessageInput): Promise<PlannotatorSendMessageResult> {
    const payload: Record<string, unknown> = {
      body: input.body,
      project_path: input.projectPath || this.projectPath,
      agent_name: input.agentName || "OPC OS",
    };

    if (input.replyTo) {
      payload.reply_to = input.replyTo;
    } else {
      if (input.thread) payload.thread = singleLine(input.thread, 120);
      if (input.subject) payload.subject = singleLine(input.subject, 160);
    }
    if (input.supersedes?.length) payload.supersedes = input.supersedes;
    if (typeof input.priority === "boolean") payload.priority = input.priority;
    if (input.idempotencyKey) payload.idempotency_key = input.idempotencyKey;
    if (input.attachments?.length) payload.attachments = input.attachments;
    if (input.pulls?.length) payload.pulls = input.pulls;

    const raw = await this.runCall<Record<string, unknown>>("send_message", payload);
    const questions = Array.isArray(raw.questions)
      ? raw.questions
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map(mapRawQuestion)
      : undefined;

    return {
      messageId: String(raw.message_id ?? ""),
      threadId: String(raw.thread_id ?? input.replyTo ?? ""),
      newThread: Boolean(raw.new_thread),
      cursor:
        typeof raw.cursor === "number" || typeof raw.cursor === "string" ? raw.cursor : null,
      url: typeof raw.url === "string" ? raw.url : null,
      questions,
    };
  }

  async readThread(input: PlannotatorReadThreadInput): Promise<PlannotatorThreadDetail | null> {
    const payload: Record<string, unknown> = {
      thread_id: input.threadId,
      project_path: input.projectPath || this.projectPath,
    };
    if (input.after !== undefined && input.after !== null) payload.after = input.after;
    if (input.limit !== undefined) payload.limit = input.limit;
    if (input.format) payload.format = input.format;
    if (input.expand?.length) payload.expand = input.expand;

    try {
      const raw = await this.runCall<Record<string, unknown>>("read_thread", payload);
      return mapRawReadThreadResponse(raw, input.threadId);
    } catch (err) {
      if (err instanceof PlannotatorCommandError && err.code === "not_found") {
        return null;
      }
      throw err;
    }
  }

  async listThreads(input: PlannotatorListThreadsInput = {}): Promise<PlannotatorThreadSummary[]> {
    const payload: Record<string, unknown> = {
      asked_by: input.askedBy ?? "anyone",
      include_resolved: Boolean(input.includeResolved),
      limit: input.limit ?? 20,
      project_path: input.projectPath || this.projectPath,
    };
    const raw = await this.runCall<Record<string, unknown>>("read_thread", payload);
    const list = Array.isArray(raw.threads) ? raw.threads : [];
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => {
        const q =
          item.questions && typeof item.questions === "object" && !Array.isArray(item.questions)
            ? (item.questions as Record<string, unknown>)
            : {};
        return {
          threadId: String(item.thread_id ?? ""),
          subject: String(item.subject ?? ""),
          threadName: typeof item.thread_name === "string" ? item.thread_name : null,
          section: typeof item.section === "string" ? item.section : null,
          messageCount: Number(item.message_count ?? 0),
          openQuestions: Number(q.open ?? 0),
          lastAuthor: typeof item.last_author === "string" ? item.last_author : null,
          lastAt: typeof item.last_at === "string" ? item.last_at : null,
          lastPersonAt: typeof item.last_person_at === "string" ? item.last_person_at : null,
          lastPersonMessageId:
            typeof item.last_person_message_id === "string" ? item.last_person_message_id : null,
          unread: Boolean(item.unread),
          resolvedAt: typeof item.resolved_at === "string" ? item.resolved_at : null,
        };
      });
  }

  async resolveMessage(
    input: PlannotatorResolveMessageInput,
  ): Promise<{ resolved: boolean; threadId?: string }> {
    const payload: Record<string, unknown> = {
      message_id: input.messageId,
      resolved: input.resolved ?? true,
      project_path: input.projectPath || this.projectPath,
    };
    const raw = await this.runCall<Record<string, unknown>>("resolve_message", payload);
    return {
      resolved: raw.resolved !== undefined ? Boolean(raw.resolved) : input.resolved ?? true,
      threadId: typeof raw.thread_id === "string" ? raw.thread_id : undefined,
    };
  }
}

async function defaultIsBranchMerged(params: {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<{ merged: boolean; reason?: string }> {
  const { repoPath, sourceBranch, targetBranch } = params;
  if (!repoPath || !sourceBranch || !existsSync(repoPath)) {
    return { merged: false };
  }
  const target = targetBranch || "main";
  try {
    // Verify both branch refs exist before running merge-base
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${sourceBranch}`], {
      cwd: repoPath,
      timeout: 3_000,
    });
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${target}`], {
      cwd: repoPath,
      timeout: 3_000,
    });
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", `refs/heads/${sourceBranch}`, `refs/heads/${target}`],
      {
        cwd: repoPath,
        timeout: 3_000,
      },
    );
    return { merged: true, reason: `分支 ${sourceBranch} 已合入 ${target}` };
  } catch {
    return { merged: false };
  }
}

const configPatchSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().trim().min(1).max(300).optional(),
  defaultThreadName: z.string().trim().min(1).max(120).optional(),
  projectPath: z.string().trim().max(500).optional(),
  pushEscalatedDecisions: z.boolean().optional(),
  pushBotSummaries: z.boolean().optional(),
  syncIntervalSecs: z.number().int().min(15).max(86_400).optional(),
  staleWorkflowHours: z.number().min(1).max(720).optional(),
  autoReconcileStale: z.boolean().optional(),
});

const questionChoiceSchema = z.object({
  id: z.string().trim().max(120).optional(),
  label: z.string().trim().min(1).max(240),
  description: z.string().trim().max(400).optional(),
  value: z.string().trim().max(160).optional(),
});

const questionSpecSchema = z.object({
  prompt: z.string().trim().min(1).max(400),
  context: z.string().max(4000).optional(),
  kind: z.enum(["single", "multi", "text"]).optional(),
  choices: z.array(questionChoiceSchema).max(20).optional(),
  recommendedLabel: z.string().trim().max(240).nullable().optional(),
  why: z.string().max(600).optional(),
  stakes: z.string().max(400).optional(),
  stopped: z.string().max(300).optional(),
  holdsUp: z.array(z.string().trim().max(160)).max(10).optional(),
  replaces: z.string().trim().max(180).optional(),
});

const pushDigestBodySchema = z.object({
  kind: z.enum(PLANNOTATOR_ENTITY_KINDS).optional(),
  entityId: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(30_000).optional(),
  threadName: z.string().trim().min(1).max(120).optional(),
  question: questionSpecSchema.nullable().optional(),
  entityRefs: z
    .array(
      z.object({
        kind: z.enum([...PLANNOTATOR_ENTITY_KINDS, "task", "release"]),
        id: z.string().trim().min(1).max(160),
        label: z.string().trim().max(200).optional(),
        revision: z.number().int().nonnegative().optional(),
      }),
    )
    .max(50)
    .optional(),
  revision: z.number().int().nonnegative().optional(),
  priority: z.boolean().optional(),
  supersedePrevious: z.boolean().optional(),
  idempotencyKey: z.string().trim().max(160).optional(),
  attachments: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  pulls: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
});

const syncBodySchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
  })
  .optional();

const reconcileBodySchema = z
  .object({
    staleHours: z.number().min(0.01).max(8760).optional(),
    dryRun: z.boolean().optional(),
  })
  .optional();

function isSkippedHookResult(result: unknown): result is { skipped: true; reason?: unknown } {
  return Boolean(result && typeof result === "object" && (result as { skipped?: unknown }).skipped === true);
}

export class PlannotatorBridgeService {
  private readonly db: DatabaseSync;
  private readonly transport: PlannotatorTransport;
  private readonly now: () => Date;
  private hooks: PlannotatorBridgeHooks;

  constructor(db: DatabaseSync, deps: PlannotatorBridgeDeps = {}) {
    this.db = db;
    this.now = deps.now ?? (() => new Date());
    this.hooks = {
      onDecisionAnswer: deps.onDecisionAnswer,
      onWorkflowAnswer: deps.onWorkflowAnswer,
      onTriageDigestAnswer: deps.onTriageDigestAnswer,
      onArbitratorDigestAnswer: deps.onArbitratorDigestAnswer,
      closeStaleWorkflow: deps.closeStaleWorkflow,
      supersedeDecision: deps.supersedeDecision,
      gitChecker: deps.gitChecker,
    };

    const initialProjectPath = deps.projectPath || process.cwd();
    this.transport =
      deps.transport ??
      new CliPlannotatorTransport({
        cliBin: deps.cliBin,
        projectPath: initialProjectPath,
        sessionId: deps.sessionId,
        autoStartIfStopped: deps.autoStartIfStopped,
      });

    this.ensureSchema(initialProjectPath);
  }

  setHooks(patch: Partial<PlannotatorBridgeHooks>): void {
    this.hooks = { ...this.hooks, ...patch };
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private ensureSchema(defaultProjectPath: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_plannotator_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        base_url TEXT NOT NULL DEFAULT 'http://localhost:53798/',
        default_thread_name TEXT NOT NULL DEFAULT 'OPC 每日任务审查与拍板汇总',
        project_path TEXT NOT NULL DEFAULT '',
        push_escalated_decisions INTEGER NOT NULL DEFAULT 1,
        push_bot_summaries INTEGER NOT NULL DEFAULT 1,
        sync_interval_secs INTEGER NOT NULL DEFAULT 120,
        stale_workflow_hours REAL NOT NULL DEFAULT 72,
        auto_reconcile_stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_plannotator_links (
        id TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        thread_name TEXT NOT NULL DEFAULT '',
        last_message_id TEXT NOT NULL,
        question_key TEXT,
        choices_json TEXT NOT NULL DEFAULT '[]',
        meta_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (entity_kind, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plannotator_links_status ON opc_plannotator_links(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plannotator_links_thread ON opc_plannotator_links(thread_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS opc_plannotator_sync_log (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_kind TEXT,
        entity_id TEXT,
        thread_id TEXT,
        message_id TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plannotator_sync_log_created ON opc_plannotator_sync_log(created_at DESC);
    `);

    const existing = this.db
      .prepare("SELECT 1 FROM opc_plannotator_config WHERE singleton = 1")
      .get();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO opc_plannotator_config (
            singleton, enabled, base_url, default_thread_name, project_path,
            push_escalated_decisions, push_bot_summaries, sync_interval_secs,
            stale_workflow_hours, auto_reconcile_stale, updated_at
          ) VALUES (1, 0, ?, ?, ?, 1, 1, ?, ?, 0, ?)`,
        )
        .run(
          DEFAULT_BASE_URL,
          DEFAULT_THREAD_NAME,
          defaultProjectPath,
          DEFAULT_SYNC_INTERVAL_SECS,
          DEFAULT_STALE_HOURS,
          this.nowIso(),
        );
    }
  }

  private tableExists(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    return Boolean(row);
  }

  getConfig(): PlannotatorBridgeConfig {
    const row = this.db
      .prepare("SELECT * FROM opc_plannotator_config WHERE singleton = 1")
      .get() as Record<string, unknown>;
    return {
      enabled: Boolean(row.enabled),
      baseUrl: String(row.base_url || DEFAULT_BASE_URL),
      defaultThreadName: String(row.default_thread_name || DEFAULT_THREAD_NAME),
      projectPath: String(row.project_path ?? ""),
      pushEscalatedDecisions: Boolean(row.push_escalated_decisions),
      pushBotSummaries: Boolean(row.push_bot_summaries),
      syncIntervalSecs: Number(row.sync_interval_secs ?? DEFAULT_SYNC_INTERVAL_SECS),
      staleWorkflowHours: Number(row.stale_workflow_hours ?? DEFAULT_STALE_HOURS),
      autoReconcileStale: Boolean(row.auto_reconcile_stale),
      updatedAt: String(row.updated_at),
    };
  }

  updateConfig(patch: PlannotatorBridgeConfigPatch): PlannotatorBridgeConfig {
    const parsed = configPatchSchema.safeParse(patch);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ");
      throw new ApiError(400, "invalid_plannotator_config", msg);
    }
    const cur = this.getConfig();
    const next: PlannotatorBridgeConfig = {
      enabled: parsed.data.enabled ?? cur.enabled,
      baseUrl: parsed.data.baseUrl ?? cur.baseUrl,
      defaultThreadName: parsed.data.defaultThreadName ?? cur.defaultThreadName,
      projectPath: parsed.data.projectPath ?? cur.projectPath,
      pushEscalatedDecisions: parsed.data.pushEscalatedDecisions ?? cur.pushEscalatedDecisions,
      pushBotSummaries: parsed.data.pushBotSummaries ?? cur.pushBotSummaries,
      syncIntervalSecs: parsed.data.syncIntervalSecs ?? cur.syncIntervalSecs,
      staleWorkflowHours: parsed.data.staleWorkflowHours ?? cur.staleWorkflowHours,
      autoReconcileStale: parsed.data.autoReconcileStale ?? cur.autoReconcileStale,
      updatedAt: this.nowIso(),
    };

    this.db
      .prepare(
        `UPDATE opc_plannotator_config
         SET enabled = ?, base_url = ?, default_thread_name = ?, project_path = ?,
             push_escalated_decisions = ?, push_bot_summaries = ?, sync_interval_secs = ?,
             stale_workflow_hours = ?, auto_reconcile_stale = ?, updated_at = ?
         WHERE singleton = 1`,
      )
      .run(
        next.enabled ? 1 : 0,
        next.baseUrl,
        next.defaultThreadName,
        next.projectPath,
        next.pushEscalatedDecisions ? 1 : 0,
        next.pushBotSummaries ? 1 : 0,
        next.syncIntervalSecs,
        next.staleWorkflowHours,
        next.autoReconcileStale ? 1 : 0,
        next.updatedAt,
      );

    return this.getConfig();
  }

  private mapLinkRow(row: Record<string, unknown>): PlannotatorLinkRecord {
    return {
      id: String(row.id),
      entityKind: String(row.entity_kind) as PlannotatorEntityKind,
      entityId: String(row.entity_id),
      threadId: String(row.thread_id),
      threadName: String(row.thread_name ?? ""),
      lastMessageId: String(row.last_message_id),
      questionKey: row.question_key ? String(row.question_key) : null,
      choices: safeJson<PlannotatorQuestionChoice[]>(row.choices_json, []),
      meta: safeJson<PlannotatorLinkMeta>(row.meta_json, {}),
      status: String(row.status) as PlannotatorLinkStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getLink(entityKind: PlannotatorEntityKind, entityId: string): PlannotatorLinkRecord | null {
    const row = this.db
      .prepare("SELECT * FROM opc_plannotator_links WHERE entity_kind = ? AND entity_id = ?")
      .get(entityKind, entityId) as Record<string, unknown> | undefined;
    return row ? this.mapLinkRow(row) : null;
  }

  listLinks(options: { status?: PlannotatorLinkStatus | "all"; limit?: number } = {}): PlannotatorLinkRecord[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const rows =
      options.status && options.status !== "all"
        ? (this.db
            .prepare("SELECT * FROM opc_plannotator_links WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
            .all(options.status, limit) as Array<Record<string, unknown>>)
        : (this.db
            .prepare("SELECT * FROM opc_plannotator_links ORDER BY updated_at DESC LIMIT ?")
            .all(limit) as Array<Record<string, unknown>>);
    return rows.map((row) => this.mapLinkRow(row));
  }

  listLogs(limit = 30): PlannotatorSyncLogRecord[] {
    const clamped = Math.max(1, Math.min(200, limit));
    const rows = this.db
      .prepare("SELECT * FROM opc_plannotator_sync_log ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(clamped) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      direction: String(row.direction) as PlannotatorSyncLogRecord["direction"],
      action: String(row.action),
      entityKind: row.entity_kind ? String(row.entity_kind) : null,
      entityId: row.entity_id ? String(row.entity_id) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      messageId: row.message_id ? String(row.message_id) : null,
      status: String(row.status) as PlannotatorSyncLogRecord["status"],
      summary: String(row.summary ?? ""),
      details: safeJson<Record<string, unknown>>(row.details_json, {}),
      createdAt: String(row.created_at),
    }));
  }

  private logSync(entry: {
    direction: "outbound" | "inbound" | "reconcile";
    action: string;
    entityKind?: string | null;
    entityId?: string | null;
    threadId?: string | null;
    messageId?: string | null;
    status: "ok" | "skipped" | "offline" | "error";
    summary: string;
    details?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO opc_plannotator_sync_log (
          id, direction, action, entity_kind, entity_id, thread_id, message_id,
          status, summary, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `plog_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
        entry.direction,
        entry.action,
        entry.entityKind ?? null,
        entry.entityId ?? null,
        entry.threadId ?? null,
        entry.messageId ?? null,
        entry.status,
        entry.summary.slice(0, 500),
        JSON.stringify(entry.details ?? {}),
        this.nowIso(),
      );
  }

  async healthCheck(): Promise<PlannotatorHealth> {
    try {
      return await this.transport.healthCheck();
    } catch (err) {
      return {
        available: false,
        running: false,
        state: "unavailable",
        url: null,
        port: null,
        version: null,
        cliPath: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getStatus(): Promise<PlannotatorBridgeStatus> {
    const [health, config] = await Promise.all([this.healthCheck(), Promise.resolve(this.getConfig())]);
    const openLinks = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM opc_plannotator_links WHERE status = 'open'")
          .get() as { n?: number } | undefined
      )?.n ?? 0,
    );
    const syncedLinks = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM opc_plannotator_links WHERE status = 'synced'")
          .get() as { n?: number } | undefined
      )?.n ?? 0,
    );
    const staleClosedLinks = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM opc_plannotator_links WHERE status = 'stale_closed'")
          .get() as { n?: number } | undefined
      )?.n ?? 0,
    );
    const totalLinks = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM opc_plannotator_links").get() as { n?: number } | undefined
      )?.n ?? 0,
    );

    return {
      available: health.available,
      health,
      config,
      counts: { openLinks, syncedLinks, staleClosedLinks, totalLinks },
      links: this.listLinks({ limit: 30 }),
      recentLogs: this.listLogs(25),
    };
  }

  private findLatestLinkByThreadName(threadName: string): PlannotatorLinkRecord | null {
    const targetNorm = normalizeKey(threadName);
    if (!targetNorm) return null;
    const rows = this.db
      .prepare(
        `SELECT * FROM opc_plannotator_links
         WHERE status IN ('open', 'synced')
         ORDER BY updated_at DESC
         LIMIT 100`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (normalizeKey(String(row.thread_name ?? "")) === targetNorm) {
        return this.mapLinkRow(row);
      }
    }
    return null;
  }

  private upsertLink(params: {
    entityKind: PlannotatorEntityKind;
    entityId: string;
    threadId: string;
    threadName: string;
    lastMessageId: string;
    questionKey: string | null;
    choices: PlannotatorQuestionChoice[];
    meta: PlannotatorLinkMeta;
    status: PlannotatorLinkStatus;
  }): PlannotatorLinkRecord {
    const existing = this.getLink(params.entityKind, params.entityId);
    const now = this.nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE opc_plannotator_links
           SET thread_id = ?, thread_name = ?, last_message_id = ?, question_key = ?,
               choices_json = ?, meta_json = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          params.threadId,
          params.threadName,
          params.lastMessageId,
          params.questionKey,
          JSON.stringify(params.choices),
          JSON.stringify(params.meta),
          params.status,
          now,
          existing.id,
        );
      return this.getLink(params.entityKind, params.entityId)!;
    }

    const id = `plink_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    this.db
      .prepare(
        `INSERT INTO opc_plannotator_links (
          id, entity_kind, entity_id, thread_id, thread_name, last_message_id,
          question_key, choices_json, meta_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.entityKind,
        params.entityId,
        params.threadId,
        params.threadName,
        params.lastMessageId,
        params.questionKey,
        JSON.stringify(params.choices),
        JSON.stringify(params.meta),
        params.status,
        now,
        now,
      );
    return this.getLink(params.entityKind, params.entityId)!;
  }

  private updateLinkStatus(
    linkId: string,
    status: PlannotatorLinkStatus,
    metaPatch?: Partial<PlannotatorLinkMeta>,
  ): void {
    const row = this.db
      .prepare("SELECT meta_json FROM opc_plannotator_links WHERE id = ?")
      .get(linkId) as { meta_json?: string } | undefined;
    if (!row) return;
    const mergedMeta = {
      ...safeJson<PlannotatorLinkMeta>(row.meta_json, {}),
      ...(metaPatch ?? {}),
    };
    this.db
      .prepare("UPDATE opc_plannotator_links SET status = ?, meta_json = ?, updated_at = ? WHERE id = ?")
      .run(status, JSON.stringify(mergedMeta), this.nowIso(), linkId);
  }

  /**
   * Outbound bridge: pushes a structured digest or decision card to Plannotator Inbox,
   * grouping by workstream thread and superseding prior open questions on newer revisions.
   */
  async pushDigest(input: PushDigestInput): Promise<PushDigestResult> {
    const config = this.getConfig();
    const entityId =
      input.entityId?.trim() || `${input.kind}:${this.nowIso().slice(0, 10)}`;
    const threadName = singleLine(input.threadName || config.defaultThreadName, 120);

    if (!config.enabled) {
      this.logSync({
        direction: "outbound",
        action: "push_digest",
        entityKind: input.kind,
        entityId,
        status: "skipped",
        summary: "Plannotator Bridge 已关闭，跳过推送",
      });
      return {
        ok: false,
        available: false,
        skipped: true,
        reason: "bridge_disabled",
        link: null,
        threadId: null,
        messageId: null,
        newThread: false,
        supersededPrevious: false,
        url: null,
      };
    }

    const health = await this.healthCheck();
    if (!health.available) {
      this.logSync({
        direction: "outbound",
        action: "push_digest",
        entityKind: input.kind,
        entityId,
        status: "offline",
        summary: `Plannotator Inbox 离线，降级跳过推送 (${health.reason ?? health.state})`,
      });
      return {
        ok: false,
        available: false,
        skipped: false,
        reason: health.reason ?? "plannotator_offline",
        link: null,
        threadId: null,
        messageId: null,
        newThread: false,
        supersededPrevious: false,
        url: null,
      };
    }

    const existingEntityLink = this.getLink(input.kind, entityId);
    const sameThreadLink = existingEntityLink ? null : this.findLatestLinkByThreadName(threadName);

    let replyTo: string | undefined;
    let sharedThread = false;
    let supersedes: string[] | undefined;

    if (existingEntityLink) {
      replyTo = existingEntityLink.lastMessageId || existingEntityLink.threadId;
      sharedThread = Boolean(existingEntityLink.meta.sharedThread);
      const shouldSupersede = input.supersedePrevious !== false;
      if (
        shouldSupersede &&
        existingEntityLink.status === "open" &&
        existingEntityLink.lastMessageId &&
        (existingEntityLink.questionKey || existingEntityLink.choices.length > 0)
      ) {
        supersedes = [
          existingEntityLink.questionKey
            ? `${existingEntityLink.lastMessageId}/${existingEntityLink.questionKey}`
            : existingEntityLink.lastMessageId,
        ];
      }
    } else if (sameThreadLink) {
      replyTo = sameThreadLink.lastMessageId || sameThreadLink.threadId;
      sharedThread = true;
    } else {
      // Check Plannotator's open threads to avoid spawning duplicates across restarts
      try {
        const remoteThreads = await this.transport.listThreads({
          askedBy: "anyone",
          includeResolved: false,
          limit: 30,
          projectPath: config.projectPath || undefined,
        });
        const targetNorm = normalizeKey(threadName);
        const matchedRemote = remoteThreads.find(
          (t) =>
            !t.resolvedAt &&
            ((t.threadName && normalizeKey(t.threadName) === targetNorm) ||
              normalizeKey(t.subject) === targetNorm),
        );
        if (matchedRemote) {
          replyTo = matchedRemote.threadId;
          sharedThread = true;
        }
      } catch {
        // Non-fatal: fall back to Plannotator's native thread-name matching
      }
    }

    const anchor: OpcRefAnchor = {
      kind: input.kind,
      id: entityId,
      ...(typeof input.revision === "number" ? { revision: input.revision } : {}),
      ...(input.entityRefs?.length
        ? { refs: input.entityRefs.map((r) => ({ kind: r.kind, id: r.id })) }
        : {}),
    };

    const bodyParts: string[] = [];
    const trimmedTitle = input.title.trim();
    const trimmedBody = input.body.trim();
    if (trimmedTitle && !trimmedBody.startsWith("#")) {
      bodyParts.push(`## ${singleLine(trimmedTitle, 180)}`);
    }
    if (trimmedBody) {
      bodyParts.push(trimmedBody);
    }
    if (input.question) {
      bodyParts.push(formatPlannotatorQuestion(input.question));
    }
    bodyParts.push(formatOpcRefAnchor(anchor));
    const fullBody = bodyParts.join("\n\n");

    const sendPayload: PlannotatorSendMessageInput = {
      body: fullBody,
      subject: replyTo ? undefined : singleLine(trimmedTitle || threadName, 160),
      thread: replyTo ? undefined : threadName,
      replyTo,
      supersedes,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
      projectPath: config.projectPath || undefined,
      agentName: "OPC OS",
      attachments: input.attachments,
      pulls: input.pulls,
    };

    let sent: PlannotatorSendMessageResult;
    let didSupersede = Boolean(supersedes?.length);
    try {
      sent = await this.transport.sendMessage(sendPayload);
    } catch (err) {
      // If an earlier open question was already closed/answered before our send, retry cleanly without supersedes
      if (
        supersedes?.length &&
        err instanceof PlannotatorCommandError &&
        err.code === "invalid_supersedes"
      ) {
        didSupersede = false;
        sent = await this.transport.sendMessage({
          ...sendPayload,
          supersedes: undefined,
        });
      } else if (err instanceof PlannotatorUnavailableError) {
        this.logSync({
          direction: "outbound",
          action: "push_digest",
          entityKind: input.kind,
          entityId,
          status: "offline",
          summary: err.message,
        });
        return {
          ok: false,
          available: false,
          skipped: false,
          reason: err.message,
          link: null,
          threadId: null,
          messageId: null,
          newThread: false,
          supersededPrevious: false,
          url: null,
        };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.logSync({
          direction: "outbound",
          action: "push_digest",
          entityKind: input.kind,
          entityId,
          status: "error",
          summary: `推送至 Plannotator 失败: ${message}`,
        });
        return {
          ok: false,
          available: true,
          skipped: false,
          reason: message,
          link: null,
          threadId: null,
          messageId: null,
          newThread: false,
          supersededPrevious: false,
          url: null,
        };
      }
    }

    const cleanChoices: PlannotatorQuestionChoice[] = (input.question?.choices ?? []).map((c) => ({
      ...c,
      label: sanitizeChoiceLabel(c.label),
    }));
    const linkStatus: PlannotatorLinkStatus = input.question ? "open" : "synced";
    const link = this.upsertLink({
      entityKind: input.kind,
      entityId,
      threadId: sent.threadId,
      threadName,
      lastMessageId: sent.messageId,
      questionKey: sent.questions?.[0]?.key ?? null,
      choices: cleanChoices,
      meta: {
        revision: input.revision ?? (existingEntityLink?.meta.revision ?? 0) + 1,
        entityRefs: input.entityRefs ?? existingEntityLink?.meta.entityRefs ?? [],
        lastCursor: sent.cursor ?? null,
        lastSyncedReplyId: existingEntityLink?.meta.lastSyncedReplyId ?? null,
        url: sent.url ?? null,
        sharedThread: sharedThread || !sent.newThread,
        subject: singleLine(trimmedTitle || threadName, 160),
      },
      status: linkStatus,
    });

    this.logSync({
      direction: "outbound",
      action: "push_digest",
      entityKind: input.kind,
      entityId,
      threadId: sent.threadId,
      messageId: sent.messageId,
      status: "ok",
      summary: `已推送至 Plannotator 线程「${threadName}」${didSupersede ? "（已替换上一轮待答问题）" : ""}`,
      details: {
        newThread: sent.newThread,
        supersededPrevious: didSupersede,
        hasQuestion: Boolean(input.question),
      },
    });

    return {
      ok: true,
      available: true,
      skipped: false,
      link,
      threadId: sent.threadId,
      messageId: sent.messageId,
      newThread: sent.newThread,
      supersededPrevious: didSupersede,
      url: sent.url ?? null,
    };
  }

  /**
   * Pushes an escalated DecisionPacket (one Bot Arbitrator could not auto-decide) to Plannotator Inbox.
   */
  async pushEscalatedDecision(
    packet: DecisionPacket,
    options: {
      threadName?: string;
      escalationReason?: string;
      priority?: boolean;
      force?: boolean;
    } = {},
  ): Promise<PushDigestResult> {
    const config = this.getConfig();
    if (!options.force && !config.pushEscalatedDecisions) {
      return {
        ok: false,
        available: true,
        skipped: true,
        reason: "push_escalated_decisions_disabled",
        link: null,
        threadId: null,
        messageId: null,
        newThread: false,
        supersededPrevious: false,
        url: null,
      };
    }

    const projectLabel =
      packet.targetSummary?.assetName ||
      packet.targetSummary?.productName ||
      packet.targetSummary?.mainlineName ||
      "";
    const threadName =
      options.threadName ||
      (projectLabel ? `OPC 拍板 · ${projectLabel}` : config.defaultThreadName);

    const recommendedOption: DecisionOption | undefined =
      packet.options.find((o) => o.id === packet.recommendedOptionId) ?? undefined;

    const lines: string[] = [];
    if (options.escalationReason) {
      lines.push(`> **转交人工原因**：${options.escalationReason}`);
    }
    lines.push(
      `- **事项编号**：\`${packet.id}\` · **类型**：\`${packet.kind}\` · **风险等级**：\`${packet.riskLevel}\``,
    );
    if (projectLabel) {
      lines.push(`- **归属目标**：${projectLabel}`);
    }
    if (packet.costEstimateUsd !== null && packet.costEstimateUsd > 0) {
      lines.push(`- **预估成本**：$${packet.costEstimateUsd.toFixed(2)}`);
    }
    if (packet.backgroundSummary) {
      lines.push("", packet.backgroundSummary.trim());
    }
    if (packet.diffOrEvidence) {
      lines.push("", "### 证据与变更摘要", packet.diffOrEvidence.trim().slice(0, 2200));
    }
    if (packet.rollbackPlan) {
      lines.push("", "### 回滚方案", packet.rollbackPlan.trim().slice(0, 800));
    }

    const question: PlannotatorQuestionSpec = {
      prompt: `请拍板：${singleLine(packet.title, 180)}`,
      context: packet.admissionWarning || undefined,
      kind: "single",
      choices: packet.options.map((opt) => ({
        id: opt.id,
        label: sanitizeChoiceLabel(opt.label),
        description: opt.description,
        value: opt.outcome,
      })),
      recommendedLabel: recommendedOption ? sanitizeChoiceLabel(recommendedOption.label) : null,
      why: packet.whyRecommended || undefined,
      stakes: packet.targetSummary?.isRedline ? "高风险红线审批，需创始人明确拍板" : undefined,
    };

    return this.pushDigest({
      kind: "decision",
      entityId: packet.id,
      title: packet.title,
      body: lines.join("\n"),
      threadName,
      question,
      entityRefs: [{ kind: "decision", id: packet.id, label: packet.title }],
      priority: options.priority ?? (packet.riskLevel === "critical" || packet.riskLevel === "high"),
    });
  }

  /**
   * Pushes a concise 1-screen digest of what Bot Arbitrator already handled.
   */
  async pushBotSummary(
    logs: BotSummaryItem[],
    options: {
      threadName?: string;
      title?: string;
      periodLabel?: string;
      force?: boolean;
    } = {},
  ): Promise<PushDigestResult> {
    const config = this.getConfig();
    if (!options.force && !config.pushBotSummaries) {
      return {
        ok: false,
        available: true,
        skipped: true,
        reason: "push_bot_summaries_disabled",
        link: null,
        threadId: null,
        messageId: null,
        newThread: false,
        supersededPrevious: false,
        url: null,
      };
    }

    if (!logs.length) {
      return {
        ok: false,
        available: true,
        skipped: true,
        reason: "empty_bot_logs",
        link: null,
        threadId: null,
        messageId: null,
        newThread: false,
        supersededPrevious: false,
        url: null,
      };
    }

    const counts: Record<string, number> = {};
    for (const item of logs) {
      const key = item.verdict || "other";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const statParts = Object.entries(counts)
      .map(([verdict, n]) => `${verdict}: ${n}`)
      .join(" · ");

    const dayKey = this.nowIso().slice(0, 10);
    const periodLabel = options.periodLabel || dayKey;
    const title = options.title || `Bot 代理拍板汇总（${periodLabel} · 共 ${logs.length} 项）`;

    const bulletLines = logs.slice(0, 15).map((item) => {
      const label = item.title || item.targetId || "未命名事项";
      const actor = item.actor ? `[${item.actor}] ` : "";
      const execMark = item.executed === false ? "（仅建议/待人工）" : "";
      const reason = item.reason ? ` — ${singleLine(item.reason, 120)}` : "";
      return `- ${actor}**${item.verdict}**${execMark} · ${singleLine(label, 100)}${reason}`;
    });

    if (logs.length > 15) {
      bulletLines.push(`- … 其余 ${logs.length - 15} 项请见 OPC OS 仲裁日志`);
    }

    const body = [
      `本轮 Bot 自动仲裁共处理 **${logs.length}** 项（${statParts}）：`,
      "",
      ...bulletLines,
    ].join("\n");

    return this.pushDigest({
      kind: "arbitrator_digest",
      entityId: `bot-summary:${periodLabel}`,
      title,
      body,
      threadName: options.threadName || config.defaultThreadName,
      question: null,
      entityRefs: logs
        .filter((l) => Boolean(l.targetId))
        .slice(0, 20)
        .map((l) => ({
          kind: l.targetKind === "workflow" ? "workflow" : "decision",
          id: String(l.targetId),
          label: l.title,
        })),
    });
  }

  /**
   * Builds a concise default digest from current open OPC OS decisions & workflows
   * when `/api/opc/plannotator/push-digest` is triggered without custom body content.
   */
  buildDefaultPendingDigest(): PushDigestInput {
    const day = this.nowIso().slice(0, 10);
    const lines: string[] = [];
    const entityRefs: PushDigestEntityRef[] = [];

    if (this.tableExists("opc_decision_packets")) {
      const pendingDecisions = this.db
        .prepare(
          "SELECT id, kind, risk_level, title FROM opc_decision_packets WHERE status = 'pending' ORDER BY updated_at DESC LIMIT 12",
        )
        .all() as Array<{ id: string; kind: string; risk_level: string; title: string }>;
      if (pendingDecisions.length > 0) {
        lines.push(`### 待拍板审批单 (${pendingDecisions.length})`);
        for (const d of pendingDecisions) {
          lines.push(`- [\`${d.risk_level}\` · ${d.kind}] ${singleLine(d.title, 120)} (\`${d.id}\`)`);
          entityRefs.push({ kind: "decision", id: d.id, label: d.title });
        }
      }
    }

    if (this.tableExists("workflow_runs")) {
      const wfRows = this.db
        .prepare("SELECT id, snapshot FROM workflow_runs ORDER BY created_at DESC LIMIT 30")
        .all() as Array<{ id: string; snapshot: string }>;
      const openWfs: Array<{ id: string; goal: string; cardKind: string; revision: number }> = [];
      for (const row of wfRows) {
        const run = safeJson<WorkflowRun | null>(row.snapshot, null);
        if (!run || run.cleanedAt) continue;
        const openCard = (run.cards ?? []).find((c) => c.status === "open");
        if (!openCard) continue;
        openWfs.push({
          id: run.id,
          goal: run.request?.goal || run.id,
          cardKind: openCard.kind,
          revision: openCard.revision,
        });
      }
      if (openWfs.length > 0) {
        lines.push("", `### 待确认工作流卡片 (${openWfs.length})`);
        for (const w of openWfs.slice(0, 10)) {
          lines.push(`- [${w.cardKind} r${w.revision}] ${singleLine(w.goal, 120)} (\`${w.id.slice(0, 8)}\`)`);
          entityRefs.push({ kind: "workflow", id: w.id, label: w.goal, revision: w.revision });
        }
      }
    }

    if (lines.length === 0) {
      lines.push("当前 OPC OS 待拍板队列已清空，暂无需要人工介入的审批事项。");
    }

    return {
      kind: "triage_digest",
      entityId: `daily-digest:${day}`,
      title: `OPC 每日待拍板与任务审查汇总（${day}）`,
      body: lines.join("\n"),
      entityRefs,
    };
  }

  /**
   * Inbound sync: inspects open links in `opc_plannotator_links`, reads replies from Plannotator,
   * parses answers, executes injected callbacks, and marks links `synced`.
   */
  async syncReplies(options: { limit?: number } = {}): Promise<SyncRepliesResult> {
    const config = this.getConfig();
    if (!config.enabled) {
      return {
        ok: false,
        available: false,
        checked: 0,
        synced: 0,
        superseded: 0,
        resolved: 0,
        errors: ["bridge_disabled"],
        items: [],
      };
    }

    const health = await this.healthCheck();
    if (!health.available) {
      this.logSync({
        direction: "inbound",
        action: "sync_replies",
        status: "offline",
        summary: `Plannotator Inbox 离线，跳过回执同步 (${health.reason ?? health.state})`,
      });
      return {
        ok: false,
        available: false,
        checked: 0,
        synced: 0,
        superseded: 0,
        resolved: 0,
        errors: [health.reason ?? "plannotator_offline"],
        items: [],
      };
    }

    const openLinks = this.listLinks({ status: "open", limit: options.limit ?? 50 });
    const threadCache = new Map<string, PlannotatorThreadDetail | null>();
    const fullThreadCache = new Map<string, PlannotatorThreadDetail | null>();

    const fetchThread = async (
      threadId: string,
      after?: string | number | null,
    ): Promise<PlannotatorThreadDetail | null> => {
      const cacheKey = `${threadId}::${after ?? ""}`;
      if (threadCache.has(cacheKey)) return threadCache.get(cacheKey)!;
      const detail = await this.transport.readThread({
        threadId,
        ...(after !== undefined && after !== null ? { after } : {}),
        limit: 12,
        projectPath: config.projectPath || undefined,
      });
      threadCache.set(cacheKey, detail);
      if (after === undefined || after === null) {
        fullThreadCache.set(threadId, detail);
      }
      return detail;
    };

    const fetchFullThread = async (threadId: string): Promise<PlannotatorThreadDetail | null> => {
      if (fullThreadCache.has(threadId)) return fullThreadCache.get(threadId)!;
      const detail = await this.transport.readThread({
        threadId,
        limit: 20,
        projectPath: config.projectPath || undefined,
      });
      fullThreadCache.set(threadId, detail);
      return detail;
    };

    let synced = 0;
    let superseded = 0;
    let resolved = 0;
    const errors: string[] = [];
    const items: SyncReplyOutcome[] = [];

    for (const link of openLinks) {
      try {
        let thread = await fetchThread(link.threadId, link.meta.lastCursor);
        if (!thread) {
          items.push({
            linkId: link.id,
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            outcome: "pending",
          });
          continue;
        }

        // If incremental read saw a truncated Plannotator placeholder, fetch full thread for structured answers
        const hasCompressedPlaceholder = thread.messages.some(
          (m) => m.authorKind === "person" && m.body.includes(PLANNOTATOR_LEFT_OUT_MARKER),
        );
        if (hasCompressedPlaceholder) {
          const full = await fetchFullThread(link.threadId);
          if (full) thread = full;
        }

        let parsed = parsePlannotatorReply({ thread, link });

        // If incremental read returned nothing and we used an `after` cursor, check full thread once when cursor moved or thread resolved
        if (!parsed && link.meta.lastCursor !== undefined && link.meta.lastCursor !== null && thread.resolvedAt) {
          const full = await fetchFullThread(link.threadId);
          if (full) {
            thread = full;
            parsed = parsePlannotatorReply({ thread, link });
          }
        }

        if (parsed?.kind === "superseded") {
          this.updateLinkStatus(link.id, "superseded", {
            lastCursor: thread.cursor ?? link.meta.lastCursor ?? null,
          });
          superseded++;
          this.logSync({
            direction: "inbound",
            action: "sync_reply",
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            messageId: link.lastMessageId,
            status: "ok",
            summary: `关联问题已在 Plannotator 中被后续轮次替换 (${parsed.supersededBy ?? "superseded"})`,
          });
          items.push({
            linkId: link.id,
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            outcome: "superseded",
          });
          continue;
        }

        if (
          parsed?.kind === "answered" &&
          parsed.replyMessageId &&
          parsed.replyMessageId !== link.meta.lastSyncedReplyId
        ) {
          const event: PlannotatorAnswerEvent = {
            link,
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            replyMessageId: parsed.replyMessageId,
            repliedAt: parsed.repliedAt || this.nowIso(),
            selectedLabels: parsed.selectedLabels,
            matchedOptionId: parsed.matchedOptionId,
            matchedChoiceLabel: parsed.matchedChoiceLabel,
            matchedChoiceValue: parsed.matchedChoiceValue,
            otherText: parsed.otherText,
            freeText: parsed.freeText,
            note: parsed.note,
            skipped: parsed.skipped,
            rawBody: parsed.rawBody,
            entityRefs: link.meta.entityRefs ?? [],
          };

          let hookResult: unknown;
          if (link.entityKind === "decision") {
            hookResult = await this.hooks.onDecisionAnswer?.(event);
          } else if (link.entityKind === "workflow") {
            hookResult = await this.hooks.onWorkflowAnswer?.(event);
          } else if (link.entityKind === "triage_digest") {
            hookResult = await this.hooks.onTriageDigestAnswer?.(event);
          } else if (link.entityKind === "arbitrator_digest") {
            hookResult = await this.hooks.onArbitratorDigestAnswer?.(event);
          }

          if (isSkippedHookResult(hookResult)) {
            const reason = typeof hookResult.reason === "string" ? hookResult.reason : "";
            this.logSync({
              direction: "inbound",
              action: "sync_reply",
              entityKind: link.entityKind,
              entityId: link.entityId,
              threadId: link.threadId,
              messageId: parsed.replyMessageId,
              status: "skipped",
              summary: reason
                ? `Plannotator 回复未回写，链接保持打开：${reason}`
                : "Plannotator 回复未回写，链接保持打开",
              details: {
                matchedOptionId: parsed.matchedOptionId,
                matchedChoiceLabel: parsed.matchedChoiceLabel,
                skipped: true,
                reason,
              },
            });
            items.push({
              linkId: link.id,
              entityKind: link.entityKind,
              entityId: link.entityId,
              threadId: link.threadId,
              outcome: "pending",
              matchedOptionId: parsed.matchedOptionId,
              matchedChoiceLabel: parsed.matchedChoiceLabel,
              replyMessageId: parsed.replyMessageId,
            });
            continue;
          }

          this.updateLinkStatus(link.id, "synced", {
            lastCursor: thread.cursor ?? link.meta.lastCursor ?? null,
            lastSyncedReplyId: parsed.replyMessageId,
          });
          synced++;
          this.logSync({
            direction: "inbound",
            action: "sync_reply",
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            messageId: parsed.replyMessageId,
            status: "ok",
            summary: `已回写 Plannotator 批示：${parsed.matchedChoiceLabel || parsed.otherText || parsed.freeText || (parsed.skipped ? "已跳过" : "已回复")}`,
            details: {
              matchedOptionId: parsed.matchedOptionId,
              matchedChoiceLabel: parsed.matchedChoiceLabel,
              skipped: parsed.skipped,
            },
          });
          items.push({
            linkId: link.id,
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            outcome: "synced",
            matchedOptionId: parsed.matchedOptionId,
            matchedChoiceLabel: parsed.matchedChoiceLabel,
            replyMessageId: parsed.replyMessageId,
          });
          continue;
        }

        if (thread.resolvedAt) {
          this.updateLinkStatus(link.id, "resolved", {
            lastCursor: thread.cursor ?? link.meta.lastCursor ?? null,
          });
          resolved++;
          this.logSync({
            direction: "inbound",
            action: "sync_reply",
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            status: "ok",
            summary: `Plannotator 线程已归档 (${thread.resolvedAt})`,
          });
          items.push({
            linkId: link.id,
            entityKind: link.entityKind,
            entityId: link.entityId,
            threadId: link.threadId,
            outcome: "resolved",
          });
          continue;
        }

        // Update cursor without closing link so next poll stays incremental
        if (thread.cursor !== undefined && thread.cursor !== null && thread.cursor !== link.meta.lastCursor) {
          this.updateLinkStatus(link.id, "open", { lastCursor: thread.cursor });
        }

        items.push({
          linkId: link.id,
          entityKind: link.entityKind,
          entityId: link.entityId,
          threadId: link.threadId,
          outcome: "pending",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${link.entityKind}:${link.entityId}: ${message}`);
        this.logSync({
          direction: "inbound",
          action: "sync_reply",
          entityKind: link.entityKind,
          entityId: link.entityId,
          threadId: link.threadId,
          status: "error",
          summary: `同步回复失败: ${message}`,
        });
        items.push({
          linkId: link.id,
          entityKind: link.entityKind,
          entityId: link.entityId,
          threadId: link.threadId,
          outcome: "error",
          error: message,
        });
      }
    }

    return {
      ok: errors.length === 0,
      available: true,
      checked: openLinks.length,
      synced,
      superseded,
      resolved,
      errors,
      items,
    };
  }

  private defaultCloseStaleWorkflow(params: StaleWorkflowCloseParams): void {
    const row = this.db
      .prepare("SELECT snapshot FROM workflow_runs WHERE id = ?")
      .get(params.runId) as { snapshot?: string } | undefined;
    if (!row?.snapshot) return;
    const run = safeJson<WorkflowRun | null>(row.snapshot, null);
    if (!run) return;
    const card = (run.cards ?? []).find(
      (c) => c.id === params.cardId && c.status === "open",
    );
    if (!card) return;

    card.status = "reject";
    card.note = params.reason;
    card.actor = params.actor;
    if (card.kind === "plan") {
      run.released = [];
    }
    for (const other of run.cards) {
      if (other.id !== card.id && other.status === "open" && other.revision === card.revision) {
        other.status = "superseded";
      }
    }
    run.events.push({
      at: this.nowIso(),
      kind: "decision_reject",
      revision: card.revision,
      note: params.reason,
      cardId: card.id,
      nodeId: card.nodeId,
      actor: params.actor,
    });
    this.db
      .prepare("UPDATE workflow_runs SET snapshot = ? WHERE id = ?")
      .run(JSON.stringify(run), params.runId);
  }

  private defaultSupersedeDecision(params: StaleDecisionSupersedeParams): void {
    const now = this.nowIso();
    this.db
      .prepare(
        `UPDATE opc_decision_packets
         SET status = 'superseded', decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(params.reason, params.actor, now, now, params.decisionId);
  }

  private extractThreadIdsFromWorkflow(run: WorkflowRun): string[] {
    const found = new Set<string>();
    const scan = (text: string | undefined) => {
      if (!text) return;
      for (const match of text.matchAll(PLANNOTATOR_THREAD_ID_RE)) {
        found.add(match[0]);
      }
    };
    scan(run.request?.context);
    scan(run.request?.goal);
    for (const ev of run.events ?? []) {
      scan(ev.note);
    }
    return [...found];
  }

  private checkThreadSuperseding(params: {
    thread: PlannotatorThreadDetail;
    link: PlannotatorLinkRecord | null;
    cardOpenedAtMs: number;
  }): { stale: boolean; reasonCode?: StaleReasonCode; reason?: string } {
    const { thread, link, cardOpenedAtMs } = params;

    if (thread.resolvedAt) {
      return {
        stale: true,
        reasonCode: "plannotator_thread_resolved",
        reason: `已由 Plannotator 线程（${thread.threadId}）完结归档，自动收敛`,
      };
    }

    const allMessages = [...(thread.earlier ?? []), ...(thread.messages ?? [])];

    // If explicitly linked to a message/question, check if that question is superseded or closed
    if (link) {
      const linkedMsg = allMessages.find((m) => m.id === link.lastMessageId);
      if (linkedMsg?.questions?.length) {
        const q =
          (link.questionKey
            ? linkedMsg.questions.find((item) => item.key === link.questionKey)
            : null) ?? linkedMsg.questions[0];
        if (q && (q.state === "superseded" || q.state === "closed")) {
          return {
            stale: true,
            reasonCode: "plannotator_thread_superseded",
            reason: `已由 Plannotator 后续轮次覆盖（${q.supersededBy ?? thread.threadId}）`,
          };
        }
      }

      // If this thread is dedicated to this entity (not a shared daily digest thread),
      // newer messages arriving after our link's lastMessageId with a newer question supersede it.
      if (!link.meta.sharedThread) {
        const linkIdx = allMessages.findIndex((m) => m.id === link.lastMessageId);
        const newerAfterLink =
          linkIdx >= 0
            ? allMessages.slice(linkIdx + 1)
            : allMessages.filter((m) => Date.parse(m.createdAt) > Date.parse(link.updatedAt));
        const hasNewerAgentRound = newerAfterLink.some(
          (m) => m.authorKind === "agent" && (m.questions?.length ?? 0) > 0,
        );
        if (hasNewerAgentRound) {
          return {
            stale: true,
            reasonCode: "plannotator_thread_superseded",
            reason: `已由 Plannotator 线程（${thread.threadId}）后续轮次覆盖`,
          };
        }
      }
      return { stale: false };
    }

    // Referenced indirectly via workflow context/events: check if newer settled rounds happened after card opened
    const newerSettledRound = allMessages.some((m) => {
      const msgTs = Date.parse(m.createdAt);
      if (!Number.isFinite(msgTs) || msgTs <= cardOpenedAtMs) return false;
      return (m.questions ?? []).some(
        (q) => q.state === "sent" || q.state === "superseded" || q.state === "closed",
      );
    });
    if (newerSettledRound) {
      return {
        stale: true,
        reasonCode: "plannotator_thread_superseded",
        reason: `已由 Plannotator 线程（${thread.threadId}）后续轮次推进并覆盖`,
      };
    }

    return { stale: false };
  }

  private extractDecisionTaskIds(packet: {
    dedupeKey: string;
    options: DecisionOption[];
    releaseTaskId?: string | null;
  }): string[] {
    const ids = new Set<string>();
    if (packet.releaseTaskId) ids.add(packet.releaseTaskId);
    for (const opt of packet.options) {
      const payload = opt.payload;
      if (!payload) continue;
      if (typeof payload.taskId === "string" && payload.taskId.trim()) {
        ids.add(payload.taskId.trim());
      }
      if (Array.isArray(payload.taskIds)) {
        for (const item of payload.taskIds) {
          const s = String(item ?? "").trim();
          if (s) ids.add(s);
        }
      }
    }
    return [...ids];
  }

  private extractDecisionReleaseRef(packet: {
    dedupeKey: string;
    options: DecisionOption[];
  }): {
    releaseId: string | null;
    repoPath: string | null;
    sourceBranch: string | null;
    targetBranch: string | null;
  } {
    let releaseId: string | null = null;
    let repoPath: string | null = null;
    let sourceBranch: string | null = null;
    let targetBranch: string | null = null;

    const dedupeMatch = /^factory:production_release:(.+)$/.exec(packet.dedupeKey);
    if (dedupeMatch) {
      releaseId = dedupeMatch[1].trim();
    }

    for (const opt of packet.options) {
      const payload = opt.payload;
      if (!payload) continue;
      if (!releaseId && typeof payload.releaseId === "string" && payload.releaseId.trim()) {
        releaseId = payload.releaseId.trim();
      }
      if (!repoPath && typeof payload.repoPath === "string" && payload.repoPath.trim()) {
        repoPath = payload.repoPath.trim();
      }
      if (!sourceBranch && typeof payload.sourceBranch === "string" && payload.sourceBranch.trim()) {
        sourceBranch = payload.sourceBranch.trim();
      }
      if (!targetBranch && typeof payload.targetBranch === "string" && payload.targetBranch.trim()) {
        targetBranch = payload.targetBranch.trim();
      }
    }

    return { releaseId, repoPath, sourceBranch, targetBranch };
  }

  /**
   * Stale Auto-Reconciler: detects expired or superseded open workflow_runs cards and
   * pending opc_decision_packets, closing/superseding them cleanly with audit notes.
   */
  async reconcileStaleItems(
    options: { staleHours?: number; dryRun?: boolean } = {},
  ): Promise<ReconcileStaleResult> {
    const config = this.getConfig();
    const staleHours =
      typeof options.staleHours === "number" && Number.isFinite(options.staleHours) && options.staleHours > 0
        ? options.staleHours
        : config.staleWorkflowHours || DEFAULT_STALE_HOURS;
    const dryRun = Boolean(options.dryRun);
    const nowMs = this.now().getTime();
    const staleThresholdMs = staleHours * 3_600_000;
    const actor = "plannotator-reconciler";

    const health = await this.healthCheck();
    const plannotatorAvailable = health.available;
    const threadCache = new Map<string, PlannotatorThreadDetail | null>();

    const readThreadSafe = async (threadId: string): Promise<PlannotatorThreadDetail | null> => {
      if (!plannotatorAvailable) return null;
      if (threadCache.has(threadId)) return threadCache.get(threadId)!;
      try {
        const detail = await this.transport.readThread({
          threadId,
          limit: 20,
          projectPath: config.projectPath || undefined,
        });
        threadCache.set(threadId, detail);
        return detail;
      } catch {
        threadCache.set(threadId, null);
        return null;
      }
    };

    const items: ReconcileStaleItem[] = [];
    let inspectedWorkflows = 0;
    let inspectedDecisions = 0;
    let closedWorkflows = 0;
    let supersededDecisions = 0;

    // 1. Inspect open workflow_runs cards
    if (this.tableExists("workflow_runs")) {
      const wfRows = this.db
        .prepare("SELECT id, created_at, snapshot FROM workflow_runs ORDER BY created_at DESC")
        .all() as Array<{ id: string; created_at: string; snapshot: string }>;

      for (const row of wfRows) {
        const run = safeJson<WorkflowRun | null>(row.snapshot, null);
        if (!run || run.cleanedAt) continue;
        const openCards = (run.cards ?? []).filter((c) => c.status === "open");
        if (openCards.length === 0) continue;

        inspectedWorkflows++;
        const primaryCard = openCards[openCards.length - 1];
        const goal = run.request?.goal || run.id;

        const timestamps = [Date.parse(run.createdAt || row.created_at)].filter((t) =>
          Number.isFinite(t),
        );
        for (const ev of run.events ?? []) {
          const ts = Date.parse(ev.at);
          if (Number.isFinite(ts)) timestamps.push(ts);
        }
        const lastActivityMs = timestamps.length > 0 ? Math.max(...timestamps) : nowMs;

        const reasons: Array<{ code: StaleReasonCode; text: string }> = [];

        // (a) Check linked Plannotator thread (explicit link or thread ID embedded in workflow context)
        const link =
          this.getLink("workflow", run.id) ?? this.getLink("workflow", primaryCard.id);
        const candidateThreadIds = new Set<string>();
        if (link?.threadId) candidateThreadIds.add(link.threadId);
        for (const tid of this.extractThreadIdsFromWorkflow(run)) {
          candidateThreadIds.add(tid);
        }

        for (const tid of candidateThreadIds) {
          const thread = await readThreadSafe(tid);
          if (!thread) continue;
          const check = this.checkThreadSuperseding({
            thread,
            link: link?.threadId === tid ? link : null,
            cardOpenedAtMs: lastActivityMs,
          });
          if (check.stale && check.reasonCode && check.reason) {
            reasons.push({ code: check.reasonCode, text: check.reason });
            break;
          }
        }

        // (b) Check age > staleHours
        if (nowMs - lastActivityMs >= staleThresholdMs) {
          const ageHours = Math.round(((nowMs - lastActivityMs) / 3_600_000) * 10) / 10;
          reasons.push({
            code: "workflow_stale_timeout",
            text: `超过 ${staleHours}h 无推进（已滞留 ${ageHours}h）自动收敛`,
          });
        }

        // (c) Optional injected git workspace/base commit checker
        if (this.hooks.gitChecker?.isCommitSuperseded && run.workspace && run.base) {
          try {
            const gitVerdict = await this.hooks.gitChecker.isCommitSuperseded({
              workspace: run.workspace,
              baseCommit: run.base,
              runId: run.id,
            });
            const superseded = typeof gitVerdict === "boolean" ? gitVerdict : Boolean(gitVerdict?.superseded);
            if (superseded) {
              const detail =
                typeof gitVerdict === "object" && gitVerdict?.reason
                  ? gitVerdict.reason
                  : `工作区基线提交 ${run.base.slice(0, 8)} 已被新提交覆盖`;
              reasons.push({
                code: "workspace_commit_superseded",
                text: detail,
              });
            }
          } catch {
            // Non-fatal git check failure
          }
        }

        if (reasons.length === 0) continue;

        const combinedReason = reasons.map((r) => r.text).join(" / ");
        const primaryCode = reasons[0].code;

        let applied = false;
        let error: string | undefined;
        if (!dryRun) {
          try {
            const closeParams: StaleWorkflowCloseParams = {
              runId: run.id,
              cardId: primaryCard.id,
              cardKind: primaryCard.kind,
              revision: primaryCard.revision,
              goal,
              reason: combinedReason,
              reasonCode: primaryCode,
              actor,
            };
            if (this.hooks.closeStaleWorkflow) {
              await this.hooks.closeStaleWorkflow(closeParams);
            } else {
              this.defaultCloseStaleWorkflow(closeParams);
            }
            if (link && link.status === "open") {
              this.updateLinkStatus(link.id, "stale_closed");
            }
            closedWorkflows++;
            applied = true;
            this.logSync({
              direction: "reconcile",
              action: "reconcile_stale_workflow",
              entityKind: "workflow",
              entityId: run.id,
              threadId: link?.threadId ?? null,
              status: "ok",
              summary: combinedReason,
              details: { cardId: primaryCard.id, reasonCode: primaryCode },
            });
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            this.logSync({
              direction: "reconcile",
              action: "reconcile_stale_workflow",
              entityKind: "workflow",
              entityId: run.id,
              status: "error",
              summary: `关闭过期工作流失败: ${error}`,
            });
          }
        }

        items.push({
          entityKind: "workflow",
          entityId: run.id,
          cardId: primaryCard.id,
          title: goal,
          reasonCode: primaryCode,
          reason: combinedReason,
          applied,
          ...(error ? { error } : {}),
        });
      }
    }

    // 2. Inspect pending opc_decision_packets
    if (this.tableExists("opc_decision_packets")) {
      const hasPlanningTasks = this.tableExists("opc_planning_tasks");
      const hasReleases = this.tableExists("opc_releases");
      const pendingRows = this.db
        .prepare(
          `SELECT id, dedupe_key, kind, title, options_json, created_at, updated_at
           FROM opc_decision_packets
           WHERE status = 'pending'
           ORDER BY updated_at DESC`,
        )
        .all() as Array<{
        id: string;
        dedupe_key: string;
        kind: string;
        title: string;
        options_json: string;
        created_at: string;
        updated_at: string;
      }>;

      for (const row of pendingRows) {
        inspectedDecisions++;
        const optionsList = safeJson<DecisionOption[]>(row.options_json, []);
        const reasons: Array<{ code: StaleReasonCode; text: string }> = [];

        // (a) Check linked Plannotator thread resolved/superseded
        const link = this.getLink("decision", row.id);
        if (link) {
          const thread = await readThreadSafe(link.threadId);
          if (thread) {
            const check = this.checkThreadSuperseding({
              thread,
              link,
              cardOpenedAtMs: Date.parse(row.updated_at || row.created_at) || nowMs,
            });
            if (check.stale && check.reasonCode && check.reason) {
              reasons.push({ code: check.reasonCode, text: check.reason });
            }
          }
        }

        // (b) Check referenced release / merged branch
        const releaseRef = this.extractDecisionReleaseRef({
          dedupeKey: row.dedupe_key,
          options: optionsList,
        });
        let releaseTaskId: string | null = null;
        let repoPath = releaseRef.repoPath;
        let sourceBranch = releaseRef.sourceBranch;
        let targetBranch = releaseRef.targetBranch || "main";

        if (releaseRef.releaseId && hasReleases) {
          const relRow = this.db
            .prepare(
              `SELECT id, task_id, repo_path, source_branch, target_branch, status
               FROM opc_releases WHERE id = ?`,
            )
            .get(releaseRef.releaseId) as
            | {
                id: string;
                task_id: string | null;
                repo_path: string;
                source_branch: string;
                target_branch: string;
                status: string;
              }
            | undefined;
          if (relRow) {
            releaseTaskId = relRow.task_id ?? null;
            repoPath = repoPath || relRow.repo_path || null;
            sourceBranch = sourceBranch || relRow.source_branch || null;
            targetBranch = relRow.target_branch || targetBranch;

            if (["succeeded", "rejected", "rolled_back"].includes(relRow.status)) {
              reasons.push({
                code: "release_already_terminal",
                text: `关联发布单 ${relRow.id} 已处于终态（${relRow.status}），审批单自动收敛`,
              });
            }
          }
        }

        if (repoPath && sourceBranch && !reasons.some((r) => r.code === "release_already_terminal")) {
          try {
            const mergedVerdict = this.hooks.gitChecker?.isBranchMerged
              ? await this.hooks.gitChecker.isBranchMerged({
                  repoPath,
                  sourceBranch,
                  targetBranch,
                })
              : await defaultIsBranchMerged({ repoPath, sourceBranch, targetBranch });
            const isMerged =
              typeof mergedVerdict === "boolean" ? mergedVerdict : Boolean(mergedVerdict?.merged);
            if (isMerged) {
              const detail =
                typeof mergedVerdict === "object" && mergedVerdict?.reason
                  ? mergedVerdict.reason
                  : `分支 ${sourceBranch} 已合入 ${targetBranch}，审批单自动收敛`;
              reasons.push({
                code: "branch_already_merged",
                text: detail,
              });
            }
          } catch {
            // Non-fatal git check error
          }
        }

        // (c) Check referenced planning tasks already archived/done/published
        if (hasPlanningTasks) {
          const taskIds = this.extractDecisionTaskIds({
            dedupeKey: row.dedupe_key,
            options: optionsList,
            releaseTaskId,
          });
          if (taskIds.length > 0) {
            const placeholders = taskIds.map(() => "?").join(", ");
            const taskRows = this.db
              .prepare(`SELECT id, status FROM opc_planning_tasks WHERE id IN (${placeholders})`)
              .all(...taskIds) as Array<{ id: string; status: string }>;
            if (
              taskRows.length > 0 &&
              taskRows.every((t) => ["done", "published", "archived"].includes(t.status))
            ) {
              const summary = taskRows.map((t) => `${t.id}(${t.status})`).join("、");
              reasons.push({
                code: "referenced_task_closed",
                text: `关联任务已全部完结/归档（${summary}），审批单自动收敛`,
              });
            }
          }
        }

        if (reasons.length === 0) continue;

        const combinedReason = reasons.map((r) => r.text).join(" / ");
        const primaryCode = reasons[0].code;

        let applied = false;
        let error: string | undefined;
        if (!dryRun) {
          try {
            const supersedeParams: StaleDecisionSupersedeParams = {
              decisionId: row.id,
              title: row.title,
              kind: row.kind,
              reason: combinedReason,
              reasonCode: primaryCode,
              actor,
            };
            if (this.hooks.supersedeDecision) {
              await this.hooks.supersedeDecision(supersedeParams);
            } else {
              this.defaultSupersedeDecision(supersedeParams);
            }
            if (link && link.status === "open") {
              this.updateLinkStatus(link.id, "stale_closed");
            }
            supersededDecisions++;
            applied = true;
            this.logSync({
              direction: "reconcile",
              action: "reconcile_stale_decision",
              entityKind: "decision",
              entityId: row.id,
              threadId: link?.threadId ?? null,
              status: "ok",
              summary: combinedReason,
              details: { reasonCode: primaryCode },
            });
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            this.logSync({
              direction: "reconcile",
              action: "reconcile_stale_decision",
              entityKind: "decision",
              entityId: row.id,
              status: "error",
              summary: `收敛过期审批单失败: ${error}`,
            });
          }
        }

        items.push({
          entityKind: "decision",
          entityId: row.id,
          title: row.title,
          reasonCode: primaryCode,
          reason: combinedReason,
          applied,
          ...(error ? { error } : {}),
        });
      }
    }

    return {
      dryRun,
      staleHours,
      plannotatorAvailable,
      inspectedWorkflows,
      inspectedDecisions,
      closedWorkflows,
      supersededDecisions,
      items,
    };
  }
}

async function readOptionalJson(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "invalid_json_object", "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "bad_json", "请求体不是合法 JSON");
  }
}

export function registerPlannotatorBridgeRoutes(
  app: Hono,
  db: DatabaseSync,
  deps: RegisterPlannotatorBridgeDeps = {},
): PlannotatorBridgeService {
  const service = deps.service ?? new PlannotatorBridgeService(db, deps);
  const { permits } = submitAuth(deps.submitToken);
  const base = "/api/opc/plannotator" as const;

  const guard = async (c: Context, next: () => Promise<void>) => {
    if (!permits(c)) deps.user?.(c);
    c.header("Cache-Control", "no-store");
    await next();
  };

  app.use(base, guard);
  app.use(`${base}/*`, guard);

  app.get(`${base}/status`, async (c) => {
    return c.json(await service.getStatus());
  });

  app.patch(`${base}/config`, async (c) => {
    const body = await readOptionalJson(c);
    const config = service.updateConfig(body as PlannotatorBridgeConfigPatch);
    return c.json({ config });
  });

  app.post(`${base}/sync`, async (c) => {
    const body = await readOptionalJson(c);
    const parsed = syncBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_sync_input", "sync 参数格式无效");
    }
    return c.json(await service.syncReplies(parsed.data ?? {}));
  });

  app.post(`${base}/push-digest`, async (c) => {
    const body = await readOptionalJson(c);
    const parsed = pushDigestBodySchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ");
      throw new ApiError(400, "invalid_push_digest_input", msg);
    }
    const data = parsed.data;
    const input: PushDigestInput =
      data.body !== undefined && data.title !== undefined
        ? {
            kind: data.kind ?? "triage_digest",
            entityId: data.entityId,
            title: data.title,
            body: data.body,
            threadName: data.threadName,
            question: data.question,
            entityRefs: data.entityRefs,
            revision: data.revision,
            priority: data.priority,
            supersedePrevious: data.supersedePrevious,
            idempotencyKey: data.idempotencyKey,
            attachments: data.attachments,
            pulls: data.pulls,
          }
        : {
            ...service.buildDefaultPendingDigest(),
            ...(data.kind ? { kind: data.kind } : {}),
            ...(data.entityId ? { entityId: data.entityId } : {}),
            ...(data.title ? { title: data.title } : {}),
            ...(data.body ? { body: data.body } : {}),
            ...(data.threadName ? { threadName: data.threadName } : {}),
            ...(data.question !== undefined ? { question: data.question } : {}),
            ...(data.entityRefs ? { entityRefs: data.entityRefs } : {}),
            ...(data.revision !== undefined ? { revision: data.revision } : {}),
            ...(data.priority !== undefined ? { priority: data.priority } : {}),
          };

    return c.json(await service.pushDigest(input));
  });

  app.post(`${base}/reconcile-stale`, async (c) => {
    const body = await readOptionalJson(c);
    const parsed = reconcileBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_reconcile_input", "reconcile-stale 参数格式无效");
    }
    return c.json(await service.reconcileStaleItems(parsed.data ?? {}));
  });

  return service;
}
