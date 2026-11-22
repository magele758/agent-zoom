import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { CommercialDepartment } from "../domains/commercial/index.ts";
import { FactoryDepartment } from "../domains/factory/index.ts";
import { OpsDepartment } from "../domains/ops/index.ts";
import { ProductDepartment } from "../domains/product/index.ts";
import { ResourcesDepartment } from "../domains/resources/index.ts";
import { StrategyDepartment } from "../domains/strategy/index.ts";
import type { CommercialHubService } from "../server/commercial.ts";
import type { DarkFactoryStore } from "../server/dark-factory.ts";
import type { TaskPlanningStore } from "../server/task-planning.ts";
import { OpcKernel } from "./index.ts";

export interface BootstrapCompanyOptions {
  db: DatabaseSync;
  app: Hono;
  requireUser: (c: Context) => { id: string; name: string };
  darkFactory: DarkFactoryStore;
  taskPlanning: TaskPlanningStore;
  commercialHub: CommercialHubService;
  submitToken?: string;
  hubQuotaPath?: string;
  enableBackgroundTimers?: boolean;
}

export interface CompanyRuntime {
  kernel: OpcKernel;
  strategy: StrategyDepartment;
  product: ProductDepartment;
  factory: FactoryDepartment;
  resources: ResourcesDepartment;
  ops: OpsDepartment;
  commercial: CommercialDepartment;
}

export function bootstrapCompanyRuntime(options: BootstrapCompanyOptions): CompanyRuntime {
  const kernel = new OpcKernel(options.db);

  // 01 · Strategy & Governance Department
  const strategy = new StrategyDepartment({ kernel });

  // 02 · Intelligence & Product Department
  const product = new ProductDepartment({
    kernel,
    strategy,
    taskPlanning: options.taskPlanning,
    autoPromote: true,
    proposeDecisionIfBorderline: true,
  });

  // 03 · Engineering Dark Factory & Real Release Department
  const factory = new FactoryDepartment({
    kernel,
    darkFactory: options.darkFactory,
    submitToken: options.submitToken,
    onTaskPublished: (taskId) => {
      try {
        options.taskPlanning.updateStatus(taskId, "published");
      } catch {
        // Task may be external
      }
    },
  });

  // 04 · Resource & Quota-Aware Scheduling Department
  const resources = new ResourcesDepartment({
    kernel,
    darkFactory: options.darkFactory,
    hubQuotaPath: options.hubQuotaPath,
    listReadyTasks: () =>
      options.taskPlanning.listReadyForAutoDispatch(25).map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        project: t.project,
        priority: t.priority,
        verifyCommand: t.verifyCommand || undefined,
      })),
    onTaskDispatched: (task, run) => {
      try {
        options.taskPlanning.syncRunOutcome({
          taskId: task.id,
          runId: run.id,
          status: run.status,
          prUrl: run.prUrl,
          tokenUsed: run.tokenUsed,
          costUsd: run.costUsd,
        });
      } catch {
        // ignore if ad-hoc task
      }
    },
  });

  // 05 · SRE & Self-Healing Operations Department
  const ops = new OpsDepartment({
    kernel,
    commercialHub: options.commercialHub,
    hubQuotaPath: options.hubQuotaPath,
    autoHealEnabled: true,
    enableTimer: Boolean(options.enableBackgroundTimers),
  });

  // 06 · Commercial, Growth & Finance Bridge Department
  const commercial = new CommercialDepartment({
    kernel,
    commercialHub: options.commercialHub,
    hubQuotaPath: options.hubQuotaPath,
  });

  kernel.registerDepartment(strategy);
  kernel.registerDepartment(product);
  kernel.registerDepartment(factory);
  kernel.registerDepartment(resources);
  kernel.registerDepartment(ops);
  kernel.registerDepartment(commercial);

  kernel.registerRoutes(options.app, options.requireUser);

  return {
    kernel,
    strategy,
    product,
    factory,
    resources,
    ops,
    commercial,
  };
}
