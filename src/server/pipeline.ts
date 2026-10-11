export const ARTIFACT_LIMIT = 32_000;
export const SUMMARY_LIMIT = 1_000;
export const REF_LIMIT = 200;
export const DEFAULT_CLAIM_TIMEOUT_MS = 120_000;
export const MIN_CLAIM_TIMEOUT_MS = 1_000;
export const MAX_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;
export const QA_RETURN_LIMIT = 3;
export const CROSS_RETURN_LIMIT = 2;
export const OFFER_HOLD = "9999-12-31T00:00:00.000Z";

export const PIPELINE_ROLES = ["research", "review", "product", "ui", "tech", "build", "qa"] as const;
export type PipelineRole = (typeof PIPELINE_ROLES)[number];

const ROLE_LABEL: Record<PipelineRole, string> = {
  research: "研究",
  review: "复核",
  product: "产品",
  ui: "界面",
  tech: "技术",
  build: "开发",
  qa: "QA",
};

export class PipelineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineInputError";
  }
}

export type ParsedStep = {
  role: PipelineRole;
  handles: string[];
  gate: boolean;
  claimTimeoutMs: number;
};

export type ParsedPipeline = {
  gate: boolean;
  claimTimeoutMs: number;
  raw: string;
  steps: ParsedStep[];
};

const HANDLE = /^[a-z][a-z0-9-]{1,31}$/;

export function roleLabel(role: string) {
  if (isPipelineRole(role)) return ROLE_LABEL[role];
  return role;
}

export function isPipelineRole(role: string): role is PipelineRole {
  return (PIPELINE_ROLES as readonly string[]).includes(role);
}

export function parseHandlesJson(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return [];
  }
}

export function parsePipeline(input: unknown): ParsedPipeline {
  let gate = false;
  let timeout = DEFAULT_CLAIM_TIMEOUT_MS;
  let rawSteps: unknown;
  if (Array.isArray(input)) {
    rawSteps = input;
  } else {
    const record = asRecord(input);
    if (!record || !Array.isArray(record.steps)) throw new PipelineInputError("steps 要是一组步骤");
    if (record.gate !== undefined && typeof record.gate !== "boolean") {
      throw new PipelineInputError("gate 要是 true 或 false");
    }
    if (typeof record.gate === "boolean") gate = record.gate;
    if (record.claimTimeoutMs !== undefined) timeout = clampTimeout(record.claimTimeoutMs);
    rawSteps = record.steps;
  }
  const list = rawSteps as unknown[];
  if (list.length < 1 || list.length > 8) throw new PipelineInputError("流水线要有 1 到 8 步");
  const steps = list.map((item, index) => parseStep(item, index, gate, timeout));
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.role)) throw new PipelineInputError(`角色 ${step.role} 只能有一步`);
    seen.add(step.role);
  }
  return { gate, claimTimeoutMs: timeout, raw: JSON.stringify(input), steps };
}

export function clampTimeout(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new PipelineInputError("claimTimeoutMs 要是数字");
  const ms = Math.floor(n);
  if (ms < MIN_CLAIM_TIMEOUT_MS || ms > MAX_CLAIM_TIMEOUT_MS) {
    throw new PipelineInputError("认领超时要在 1 秒到 30 分钟之间");
  }
  return ms;
}

export function composeHandoff(input: {
  demand: string;
  acceptance: string;
  role: string;
  handle: string;
  ref: string;
  summary: string;
  body: string;
}) {
  const lines = [
    `原需求：${input.demand}`,
    `验收：${input.acceptance}`,
    `上一步（${roleLabel(input.role)}）${input.handle}`,
    input.ref ? `引用：${input.ref}` : "",
    input.summary ? `说明：${input.summary}` : "",
    input.body,
  ].filter(Boolean);
  return lines.join("\n").slice(0, ARTIFACT_LIMIT);
}

export function reviewPacket(
  researchBody: string,
  notes: Array<{ handle: string; verdict: string; body: string }>,
) {
  const lines = ["研究产物：", researchBody, "", "复核：", ...notes.map((note) => `${note.handle}：${note.verdict} ${note.body}`)];
  return lines.join("\n").slice(0, ARTIFACT_LIMIT);
}

export function reviewBounce(notes: Array<{ handle: string; verdict: string; body: string }>) {
  const changes = notes.filter((note) => note.verdict === "changes");
  const lines = ["复核未通过，请改研究后再交。", ...changes.map((note) => `${note.handle}：${note.body}`)];
  return lines.join("\n").slice(0, ARTIFACT_LIMIT);
}

export function normalizeShots(value: unknown) {
  if (!Array.isArray(value)) return [];
  const shots: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").replace(/[\r\n\0]/g, " ").trim().slice(0, 500);
    if (!text) continue;
    shots.push(text);
    if (shots.length >= 8) break;
  }
  return shots;
}

export function withShots(body: string, shots: string[]) {
  if (shots.length === 0) return body.slice(0, ARTIFACT_LIMIT);
  const extra = shots.map((shot) => `截图：${shot}`).join("\n");
  return `${body}\n${extra}`.slice(0, ARTIFACT_LIMIT);
}

function parseStep(input: unknown, index: number, pipelineGate: boolean, pipelineTimeout: number): ParsedStep {
  const record = asRecord(input);
  if (!record) throw new PipelineInputError(`第 ${index + 1} 步不是对象`);
  const role = String(record.role ?? "");
  if (!isPipelineRole(role)) throw new PipelineInputError(`第 ${index + 1} 步的角色不认识`);
  const handles = readHandles(record);
  if (handles.length === 0) throw new PipelineInputError(`第 ${index + 1} 步要指定句柄`);
  if (handles.length > 6) throw new PipelineInputError(`第 ${index + 1} 步最多 6 个句柄`);
  let gate = pipelineGate;
  if (record.gate !== undefined) {
    if (typeof record.gate !== "boolean") throw new PipelineInputError(`第 ${index + 1} 步的 gate 要是 true 或 false`);
    gate = record.gate;
  }
  const claimTimeoutMs = record.claimTimeoutMs === undefined ? pipelineTimeout : clampTimeout(record.claimTimeoutMs);
  return { role, handles, gate, claimTimeoutMs };
}

function readHandles(record: Record<string, unknown>) {
  const listed = Array.isArray(record.handles) ? record.handles : [];
  const single = typeof record.handle === "string" ? [record.handle] : [];
  const source = listed.length > 0 ? listed : single;
  const handles: string[] = [];
  for (const item of source) {
    const handle = String(item ?? "").trim().toLowerCase();
    if (!HANDLE.test(handle)) throw new PipelineInputError(`句柄 ${handle || "空"} 不合法`);
    if (!handles.includes(handle)) handles.push(handle);
  }
  return handles;
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
