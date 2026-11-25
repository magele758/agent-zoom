import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { ApiError } from "../server/logic.ts";
import { DecisionGateway } from "./decisions.ts";
import { DomainEventBus } from "./events.ts";
import { AssetRegistry } from "./registry.ts";
import {
  COMPANY_DEPARTMENTS,
  type CompanyArchitectureSnapshot,
  type CompanyDepartmentId,
  type DecisionBatchAction,
  type DecisionStatus,
  type DepartmentHealth,
  type DepartmentModule,
} from "./types.ts";

export * from "./types.ts";
export { AssetRegistry } from "./registry.ts";
export { DomainEventBus } from "./events.ts";
export { DecisionGateway } from "./decisions.ts";

export class OpcKernel {
  readonly db: DatabaseSync;
  readonly events: DomainEventBus;
  readonly registry: AssetRegistry;
  readonly decisions: DecisionGateway;
  private modules = new Map<CompanyDepartmentId, DepartmentModule>();
  private started = false;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.events = new DomainEventBus(db);
    this.registry = new AssetRegistry(db, this.events);
    this.decisions = new DecisionGateway(db, this.events, this.registry);
  }

  registerDepartment(module: DepartmentModule) {
    this.modules.set(module.id, module);
  }

  startAll() {
    if (this.started) return;
    this.started = true;
    for (const mod of this.modules.values()) {
      mod.start?.();
    }
  }

  stopAll() {
    if (!this.started) return;
    this.started = false;
    for (const mod of this.modules.values()) {
      mod.stop?.();
    }
  }

  async architectureSnapshot(): Promise<CompanyArchitectureSnapshot> {
    const mainlines = this.registry.listMainlines();
    const products = this.registry.listProducts();
    const assets = this.registry.listAssets();
    const decisionCounts = this.decisions.counts();

    const departments = await Promise.all(
      COMPANY_DEPARTMENTS.map(async (desc) => {
        const mod = this.modules.get(desc.id);
        let health: DepartmentHealth = {
          healthy: Boolean(mod),
          summary: mod ? "部门模块运行中" : "部门模块未挂载",
        };
        if (mod?.health) {
          try {
            health = await mod.health();
          } catch (err) {
            health = {
              healthy: false,
              summary: err instanceof Error ? err.message : "部门健康自检异常",
            };
          }
        }
        return {
          ...desc,
          registered: Boolean(mod),
          health,
        };
      }),
    );

    return {
      kernelVersion: "1.0.0",
      departments,
      counts: {
        mainlines: mainlines.length,
        activeMainlines: mainlines.filter((m) => m.status === "active").length,
        products: products.length,
        assets: assets.length,
        pendingDecisions: decisionCounts.pending,
        autoApprovedDecisions: decisionCounts.autoApproved,
        domainEvents: this.events.totalCount(),
      },
      policy: this.decisions.getPolicy(),
    };
  }

  registerRoutes(app: Hono, requireUser: (c: Context) => { id: string; name: string }) {
    app.use("/api/opc/kernel/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });

    app.get("/api/opc/kernel/architecture", async (c) => {
      requireUser(c);
      return c.json(await this.architectureSnapshot());
    });

    app.get("/api/opc/kernel/portfolio", (c) => {
      requireUser(c);
      return c.json(this.registry.portfolio());
    });

    app.post("/api/opc/kernel/mainlines", async (c) => {
      requireUser(c);
      const body = await c.req.json();
      return c.json({ mainline: this.registry.upsertMainline(body) }, 201);
    });

    app.put("/api/opc/kernel/mainlines/:id", async (c) => {
      requireUser(c);
      const body = await c.req.json();
      return c.json({
        mainline: this.registry.upsertMainline({ ...body, id: c.req.param("id") }),
      });
    });

    app.post("/api/opc/kernel/products", async (c) => {
      requireUser(c);
      const body = await c.req.json();
      return c.json({ product: this.registry.upsertProduct(body) }, 201);
    });

    app.post("/api/opc/kernel/assets", async (c) => {
      requireUser(c);
      const body = await c.req.json();
      return c.json({ asset: this.registry.upsertAsset(body) }, 201);
    });

    app.put("/api/opc/kernel/assets/:id", async (c) => {
      requireUser(c);
      const body = await c.req.json();
      return c.json({
        asset: this.registry.upsertAsset({ ...body, id: c.req.param("id") }),
      });
    });

    app.get("/api/opc/kernel/decisions", (c) => {
      requireUser(c);
      const status = (c.req.query("status") ?? "all") as DecisionStatus | "all" | "handled";
      const domain = c.req.query("domain") as CompanyDepartmentId | undefined;
      return c.json({
        packets: this.decisions.list({ status, domain }),
        counts: this.decisions.counts(),
        policy: this.decisions.getPolicy(),
      });
    });

    app.get("/api/opc/kernel/decisions/policy", (c) => {
      requireUser(c);
      return c.json({ policy: this.decisions.getPolicy() });
    });

    app.get("/api/opc/kernel/decisions/:id", (c) => {
      requireUser(c);
      const packet = this.decisions.get(c.req.param("id"));
      if (!packet) throw new ApiError(404, "decision_not_found", "未找到该审批单");
      return c.json({ packet });
    });

    app.put("/api/opc/kernel/decisions/policy", async (c) => {
      requireUser(c);
      const body = await c.req.json();
      return c.json({ policy: this.decisions.updatePolicy(body) });
    });

    app.post("/api/opc/kernel/decisions/:id/view", (c) => {
      requireUser(c);
      return c.json({ packet: this.decisions.markViewed(c.req.param("id")) });
    });

    app.post("/api/opc/kernel/decisions/:id/resolve", async (c) => {
      const user = requireUser(c);
      const body = await c.req.json();
      const packet = await this.decisions.resolve(c.req.param("id"), {
        optionId: String(body.optionId ?? ""),
        note: typeof body.note === "string" ? body.note : "",
        expectedUpdatedAt: typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined,
        actor: user.name,
      });
      return c.json({ packet });
    });

    app.post("/api/opc/kernel/decisions/batch-resolve", async (c) => {
      const user = requireUser(c);
      const body = await c.req.json();
      const result = await this.decisions.batchResolve({
        ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
        expectedUpdatedAtById: body.expectedUpdatedAtById,
        action: String(body.action ?? "") as DecisionBatchAction,
        note: typeof body.note === "string" ? body.note : "",
        actor: user.name,
        allowRedline: body.allowRedline === true,
      });
      return c.json(result);
    });

    app.get("/api/opc/kernel/events", (c) => {
      requireUser(c);
      const topic = c.req.query("topic") ?? undefined;
      const sourceDomain = (c.req.query("domain") ?? undefined) as CompanyDepartmentId | undefined;
      const limit = Number(c.req.query("limit") ?? 50);
      return c.json({
        events: this.events.list({ topic, sourceDomain, limit }),
        total: this.events.totalCount(),
      });
    });

    for (const mod of this.modules.values()) {
      mod.registerRoutes?.(app, requireUser);
    }
  }
}
