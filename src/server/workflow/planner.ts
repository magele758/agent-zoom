import { z } from "zod";
import type { WorkflowPlan, WorkflowRequest } from "../../workflow-types.ts";
import { localCoordinatorModel, openCoordinatorProposal, type CoordinatorTrace } from "../coordinator.ts";
import { ApiError } from "../logic.ts";
import { parse, planSchema, validatePlan } from "./contract.ts";

export async function draftWorkflowPlan(request: WorkflowRequest, capabilities: Record<string, string[]>,
  connect = localCoordinatorModel) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let session: Awaited<ReturnType<typeof openCoordinatorProposal>> | undefined;
  let model: ReturnType<typeof connect> | undefined;
  try {
    model = connect();
    let plan: WorkflowPlan | undefined;
    const trace: CoordinatorTrace = [];
    session = await openCoordinatorProposal({
      title: "工作流计划", prompt: JSON.stringify({ goal: request.goal, constraints: request.constraints,
        context: request.context, capabilities: Object.keys(capabilities) }),
      instructions: "你是OPC OS规划协调器。依据目标、上下文和约束设计可执行的有向无环图。每个实现节点说明具体交付和测试，互不依赖的节点可以并行。需要用户决策时加入 gate。capability 只给实现节点且必须在可用能力表内。每个验收路径必须经过独立 review。仅调用 propose_workflow 提交计划草案，等待人审批。",
      model, controller, trace, tools: [{
        name: "propose_workflow", description: "保存待确认的工作流草案",
        inputSchema: z.toJSONSchema(planSchema, { io: "input" }), approvalMode: "never", sideEffectLevel: "none",
        execute: async (_ctx, args) => {
          const proposal = parse(planSchema, args);
          validatePlan(proposal, new Set(), capabilities);
          plan = proposal;
          return { ok: true, content: "草案已校验，等待人工确认。" };
        },
      }],
    });
    const result = await session.run();
    if (result.status === "failed" || controller.signal.aborted || !plan) {
      throw new Error(trace.findLast(entry => entry.error)?.error ?? "协调器未提交有效草案");
    }
    return { plan, reason: `OPC OS协调器生成 · ${model.model}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(503, "workflow_planner", model?.redact?.(message) ?? message);
  } finally {
    clearTimeout(timer);
    await session?.close();
  }
}
