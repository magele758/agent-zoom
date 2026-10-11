import { roleLabel } from "../../src/server/pipeline.ts";

export type ViewTask = {
  id: string;
  status: string;
  mode?: string;
  pipelineId?: string | null;
  stepIndex?: number | null;
  stepRole?: string | null;
  assigneeHandle?: string;
  handles?: string[];
  conclusions?: Array<{ handle: string; verdict: string }>;
  claims: Array<{ role: string; state?: string; handle: string }>;
};

export type Slot = { label: string; value: string; held: boolean };

export const PIPELINE_STATUS: Record<string, string> = {
  blocked: "等待",
  open: "待认领",
  claimed: "已认领",
  working: "进行中",
  changes: "需修改",
  done: "完成",
  failed: "失败",
  canceled: "取消",
};

const VERDICT_TEXT: Record<string, string> = { pass: "通过", changes: "要改" };

export function isPipelineParent(task: ViewTask) {
  return task.mode === "pipeline" && !task.pipelineId;
}

export function isPipelineStep(task: ViewTask) {
  return Boolean(task.pipelineId && task.stepRole);
}

export function stepsOf<T extends ViewTask>(parentId: string, tasks: readonly T[]) {
  return tasks.filter((task) => task.pipelineId === parentId).sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
}

function holders(task: ViewTask) {
  return task.claims.filter((claim) => claim.role === "implementer" && (!claim.state || claim.state === "active")).map((claim) => claim.handle);
}

function finisher(task: ViewTask) {
  const done = task.claims.filter((claim) => claim.role === "implementer").map((claim) => claim.handle);
  return done.length > 0 ? done : task.assigneeHandle ? [task.assigneeHandle] : (task.handles ?? []);
}

function reviewers(task: ViewTask) {
  const notes = task.conclusions ?? [];
  const handles = [...(task.handles ?? [])];
  for (const note of notes) if (!handles.includes(note.handle)) handles.push(note.handle);
  const closed = task.status === "done" || task.status === "canceled" || task.status === "failed";
  return handles.map((handle) => {
    const note = notes.find((item) => item.handle === handle);
    if (note) return `${handle} ${VERDICT_TEXT[note.verdict] ?? note.verdict}`;
    return `${handle} ${closed ? "未接入" : "待交"}`;
  });
}

export function stepStatus(task: ViewTask) {
  if (task.stepRole === "review" && task.status === "open") return "复核中";
  return PIPELINE_STATUS[task.status] ?? task.status;
}

export function stepOwner(task: ViewTask, withWait = true) {
  if (task.stepRole === "review") return reviewers(task).join("、") || "空";
  const active = holders(task);
  if (active.length > 0) return active.join("、");
  if (task.status === "done") return finisher(task).join("、");
  const wanted = task.assigneeHandle ? [task.assigneeHandle] : (task.handles ?? []);
  if (wanted.length === 0) return "空";
  if (task.status === "blocked") return withWait ? `${wanted.join("、")}（等上一步）` : wanted.join("、");
  if (task.status === "open") return `${wanted.join("、")}（待认领）`;
  return wanted.join("、");
}

/** 流水线步骤卡的槽位：当前步、负责人，而不是实现/评审/测试。 */
export function stepSlots(task: ViewTask, steps: readonly ViewTask[]): Slot[] {
  const total = steps.length;
  const index = (task.stepIndex ?? steps.findIndex((item) => item.id === task.id)) + 1;
  const position = total > 0 ? `${roleLabel(task.stepRole ?? "")} · 第 ${index}/${total} 步` : roleLabel(task.stepRole ?? "");
  const owner = stepOwner(task);
  return [
    { label: "步骤", value: position, held: true },
    {
      label: task.stepRole === "review" ? "复核人" : "负责人",
      value: owner,
      held: owner !== "空" && !owner.endsWith("）"),
    },
  ];
}

export type OverviewRow = { id: string; role: string; label: string; owner: string; status: string; state: "done" | "now" | "" };

/** 流水线总卡：当前步和各步负责人。 */
export function pipelineOverview(parent: ViewTask, steps: readonly ViewTask[]) {
  const current = parent.status === "done" ? null : (steps.find((step) => !["done", "canceled", "failed"].includes(step.status)) ?? null);
  const rows: OverviewRow[] = steps.map((step) => ({
    id: step.id,
    role: step.stepRole ?? "",
    label: roleLabel(step.stepRole ?? ""),
    owner: stepOwner(step, false),
    status: stepStatus(step),
    state: step.status === "done" ? "done" : step.id === current?.id ? "now" : "",
  }));
  const where = parent.status === "done" ? "已做完" : current ? `当前：${roleLabel(current.stepRole ?? "")}` : "等待开始";
  return { where, rows };
}

export const FOLD_LINES = 3;
export const FOLD_CHARS = 160;

/** 长内容默认只露出开头几行。 */
export function foldBody(body: string, maxLines = FOLD_LINES, maxChars = FOLD_CHARS) {
  const lines = body.split("\n");
  let head = lines.slice(0, maxLines).join("\n");
  let long = lines.length > maxLines;
  if (head.length > maxChars) {
    head = head.slice(0, maxChars);
    long = true;
  }
  return { head: long ? `${head.trimEnd()}…` : head, long, hidden: Math.max(0, body.length - head.length) };
}

export function shouldFold(authorType: string, kind: string, body: string) {
  if (authorType === "user" || kind === "instruction") return false;
  return foldBody(body).long;
}

export type ComposerKind = "chat" | "question" | "instruction";

export function composerPlaceholder(kind: ComposerKind, direct: boolean) {
  if (direct) return "只有这段私聊里的人能看到。输入 @ 会列出可以叫醒的 agent。";
  if (kind === "instruction") return "写下要做完的需求。不点名时，频道里的 agent 都会收到这句。输入 @ 只叫醒那一个。";
  if (kind === "question") return "写下要问的问题。点名的 agent 会回答；不点名时，频道里的 agent 都会看到。";
  return "写给房间，不派活。不点名时，频道里的 agent 都能看到。输入 @ 只叫醒那一个。";
}

export function defaultKind(direct: boolean): ComposerKind {
  return direct ? "question" : "chat";
}
