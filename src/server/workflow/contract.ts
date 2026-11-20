import { z } from "zod";
import { zoomFolder } from "../zoom-folder.ts";
import { productStageIds } from "../../product-stages.ts";
import type { WorkflowNode, WorkflowPlan, WorkflowRequest, WorkflowRun } from "../../workflow-types.ts";
import { ApiError } from "../logic.ts";

const label = z.string().trim().min(1).max(120);
const prose = z.string().trim().min(1).max(4000);
const nodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const node = z.strictObject({
  id: nodeId,
  kind: z.enum(["implement", "review", "gate"]),
  title: label,
  instruction: prose,
  capability: nodeId.optional(),
  dependsOn: z.array(nodeId).max(12).default([]).transform(ids => [...ids].sort()),
});
export const planSchema = z.strictObject({
  nodes: z.array(node).min(2).max(12),
  acceptance: z.array(nodeId).min(1).max(12),
});

export const opportunitySubmission = z.strictObject({ opportunityId: z.uuid() });
export const requestSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  source: label,
  context: prose,
  projectKey: z.string().trim().min(1).max(256).optional(),
  capabilityRefs: z.array(z.string().trim().min(1).max(450)).min(1).max(12).optional(),
  folder: zoomFolder.optional(),
  stage: z.enum(productStageIds).optional(),
  goal: prose,
  constraints: z.array(prose).max(12).default([]),
  plan: planSchema.optional(),
});
export const revisionSchema = z.strictObject({ baseRevision: z.int().positive(), reason: prose, plan: planSchema });
export const runnerSchema = z.strictObject({ baseRevision: z.int().positive(), cardId: z.uuid(), nodeId, capability: nodeId.nullable() });
export const decisionSchema = z.strictObject({
  revision: z.int().positive(),
  cardId: z.uuid(),
  action: z.enum(["approve", "changes", "reject"]),
  note: z.string().trim().max(4000).default(""),
  cleanup: z.boolean().optional(),
}).refine(decision => decision.action === "approve" || Boolean(decision.note), "请填写反馈");
export const recoverySchema = z.strictObject({ revision: z.int().positive(), attemptId: z.uuid(), note: prose });

const check = z.strictObject({ name: label, exitCode: z.int().min(0).max(255), output: z.string().max(16000) });
const artifact = z.strictObject({ name: label, content: z.string().max(16000) });
export const evidenceSchema = z.strictObject({
  runId: z.uuid(),
  nodeId,
  attemptId: z.uuid(),
  revision: z.int().positive(),
  outcome: z.enum(["succeeded", "failed"]),
  summary: prose,
  checks: z.array(check).max(12),
  artifacts: z.array(artifact).max(12),
  patch: z.string().max(256_000),
}).refine(evidence => evidence.outcome === "failed" ||
  (evidence.checks.length > 0 && evidence.checks.every(check => check.exitCode === 0)),
"成功回执需要通过的检查");

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "workflow_input", result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(" / "));
  }
  return result.data;
}

export function conflict(message: string): never {
  throw new ApiError(409, "workflow_conflict", message);
}

export function activeNodes(plan: WorkflowPlan, roots = plan.acceptance): Set<string> {
  const seen = new Set<string>();
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
  };
  for (const id of roots) visit(id);
  return seen;
}

export function validatePlan(plan: WorkflowPlan, historical = new Set<string>(), capabilities: Record<string, string[]> = {}) {
  const invalid = (message: string): never => { throw new ApiError(400, "workflow_plan", message); };
  const ids = new Map(plan.nodes.map(node => [node.id, node]));
  if (ids.size !== plan.nodes.length) invalid("节点 ID 必须唯一");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: WorkflowNode) => {
    if (visiting.has(node.id)) invalid("依赖图必须无环");
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    if (new Set(node.dependsOn).size !== node.dependsOn.length) invalid(`${node.id} 有重复依赖`);
    for (const id of node.dependsOn) visit(ids.get(id) ?? invalid(`未知依赖 ${id}`));
    visiting.delete(node.id);
    visited.add(node.id);
  };
  for (const node of plan.nodes) visit(node);
  if (new Set(plan.acceptance).size !== plan.acceptance.length) invalid("验收 review 必须唯一");
  for (const id of plan.acceptance) {
    if (ids.get(id)?.kind !== "review") invalid("验收只能引用 review 节点");
  }
  const active = activeNodes(plan);
  for (const node of plan.nodes) {
    if (node.capability && (node.kind !== "implement" || !Object.hasOwn(capabilities, node.capability))) {
      invalid(`节点 ${node.id} 的执行能力未配置或不适用于该角色`);
    }
    if (!active.has(node.id) && !historical.has(node.id)) invalid(`${node.id} 不在验收依赖中`);
    if (node.kind === "review" && ![...activeNodes(plan, [node.id])].some(id => ids.get(id)?.kind === "implement")) {
      invalid(`${node.id} 缺少实现证据依赖`);
    }
    if (active.has(node.id) && node.kind === "implement" &&
        !plan.nodes.some(review => review.kind === "review" && active.has(review.id) && activeNodes(plan, [review.id]).has(node.id))) {
      invalid(`${node.id} 缺少独立 review`);
    }
  }
}

export function planGoal(request: WorkflowRequest): WorkflowPlan {
  const target = request.goal.slice(0, 2800);
  const constraints = request.constraints.length ? `验收时逐条核对原请求中的 ${request.constraints.length} 项约束。` : "";
  return {
    nodes: [
      { id: "implement", kind: "implement", title: "实现与自检", instruction: `实现目标「${target}」，遵守原请求中的约束，记录改动和测试结果。`, dependsOn: [] },
      { id: "review", kind: "review", title: "独立评审", instruction: `审查上游实现是否满足「${target}」。${constraints}在独立工作区验证差异并重跑测试。`, dependsOn: ["implement"] },
    ],
    acceptance: ["review"],
  };
}

export function currentRevision(run: WorkflowRun) { return run.revisions[run.revisions.length - 1]; }
export function latestAttempt(run: WorkflowRun, nodeId: string) {
  return run.attempts.findLast(attempt => attempt.nodeId === nodeId);
}
export function gateDecision(run: WorkflowRun, nodeId: string) {
  return run.cards.findLast(card => card.nodeId === nodeId && (card.status === "approve" ||
    (card.revision === currentRevision(run).number && card.status !== "superseded")));
}
export function succeeded(run: WorkflowRun, nodeId: string) {
  return latestAttempt(run, nodeId)?.state === "succeeded" || gateDecision(run, nodeId)?.status === "approve";
}
