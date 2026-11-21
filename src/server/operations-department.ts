import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ManagedService, OperationsIndex, RichServiceProbe } from "../operations-department-types.ts";
import { ApiError } from "./logic.ts";
import { buildOperationsTopology, type FleetReaderOptions } from "./ops-fleet.ts";

const label = z.string().trim().min(1).max(160);
const note = z.string().trim().min(1).max(2000);
const register = z.strictObject({
  id: z.uuid(),
  name: label,
  scope: z.string().trim().max(321).default(""),
  version: z.string().trim().max(160).default(""),
  host: z.string().trim().max(160).optional().default(""),
  endpoint: z.string().trim().max(500).optional().default(""),
});
const deploymentPatch = z.strictObject({
  host: z.string().trim().max(160).default(""),
  endpoint: z.string().trim().max(500).default(""),
});
const event = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("observation"), health: z.enum(["healthy", "degraded", "outage"]), source: z.string().trim().min(1).max(1000), note }),
  z.strictObject({ kind: z.literal("plan"), target: label, note }),
  z.strictObject({ kind: z.literal("result"), planId: z.uuid(), outcome: z.enum(["applied", "failed", "rolled_back", "cancelled"]), note }),
]);
const submit = z.strictObject({ id: z.uuid(), revision: z.int().nonnegative(), event });
type ServiceEvent = z.infer<typeof event>;

function read<T>(schema: z.ZodType<T>, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "operations_input", "请核对运维记录中的必填内容、字段长度和选项。");
  return parsed.data;
}

const conflict = (message: string) => new ApiError(409, "operations_conflict", message);

type ServiceRow = { id: string; name: string; scope: string; version: string; host?: string; endpoint?: string };
type EventRow = { service: string; id: string; sequence: number; payload: string; at: string };

function serviceView(row: ServiceRow): ManagedService {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    version: row.version,
    ...(row.host ? { host: row.host } : {}),
    ...(row.endpoint ? { endpoint: row.endpoint } : {}),
    revision: 0,
    observations: [],
    updates: [],
  };
}

function apply(service: ManagedService, id: string, data: ServiceEvent, at: string) {
  switch (data.kind) {
    case "observation":
      service.observations.unshift({ id, at, health: data.health, source: data.source, note: data.note });
      break;
    case "plan":
      if (service.updates[0]?.result === null) throw conflict("请先登记当前更新的结果。");
      service.updates.unshift({ id, at, from: service.version, target: data.target, note: data.note, result: null });
      break;
    case "result": {
      const plan = service.updates[0];
      if (!plan || plan.id !== data.planId || plan.result) throw conflict("这项更新已经结束或不属于当前服务。");
      plan.result = { outcome: data.outcome, note: data.note, at };
      if (data.outcome === "applied") service.version = plan.target;
      break;
    }
  }
  service.revision += 1;
}

export class OperationsDepartmentStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_ops_services(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, version TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT '', endpoint TEXT NOT NULL DEFAULT '', UNIQUE(scope,name)
    );
    CREATE TABLE IF NOT EXISTS opc_ops_events(
      service TEXT NOT NULL REFERENCES opc_ops_services(id), id TEXT NOT NULL, sequence INTEGER NOT NULL,
      payload TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(service,id), UNIQUE(service,sequence)
    );`);
    const cols = new Set(db.prepare("PRAGMA table_info(opc_ops_services)").all().map(c => String(c.name)));
    if (!cols.has("host")) db.exec("ALTER TABLE opc_ops_services ADD COLUMN host TEXT NOT NULL DEFAULT ''");
    if (!cols.has("endpoint")) db.exec("ALTER TABLE opc_ops_services ADD COLUMN endpoint TEXT NOT NULL DEFAULT ''");
  }

  private scopes(): string[] {
    return this.db.prepare(`SELECT name AS scope FROM projects UNION
      SELECT product || '/' || name AS scope FROM company_projects ORDER BY scope`).all().map(row => String(row.scope));
  }

  index(): OperationsIndex {
    const rows = this.db.prepare("SELECT * FROM opc_ops_services ORDER BY scope,name").all() as ServiceRow[];
    const services = new Map(rows.map(row => [row.id, serviceView(row)]));
    for (const e of this.db.prepare("SELECT * FROM opc_ops_events ORDER BY service,sequence").all() as EventRow[]) {
      const service = services.get(e.service);
      if (service) apply(service, e.id, JSON.parse(e.payload), e.at);
    }
    return { scopes: this.scopes(), services: [...services.values()] };
  }

  private service(id: string): ManagedService {
    const row = this.db.prepare("SELECT * FROM opc_ops_services WHERE id=?").get(id) as ServiceRow | undefined;
    if (!row) throw new ApiError(404, "operations_service_missing", "找不到这项服务。");
    const service = serviceView(row);
    for (const e of this.db.prepare("SELECT * FROM opc_ops_events WHERE service=? ORDER BY sequence").all(id) as EventRow[]) {
      apply(service, e.id, JSON.parse(e.payload), e.at);
    }
    return service;
  }

  create(input: unknown) {
    const data = read(register, input);
    if (data.scope && !this.scopes().includes(data.scope)) throw new ApiError(400, "operations_scope", "请从目录选择所属产品或项目。");
    this.db.prepare("INSERT INTO opc_ops_services(id,name,scope,version,host,endpoint) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(data.id, data.name, data.scope, data.version, data.host, data.endpoint);
    const saved = this.db.prepare("SELECT * FROM opc_ops_services WHERE id=?").get(data.id) as ServiceRow | undefined;
    if (!saved || saved.name !== data.name || saved.scope !== data.scope || saved.version !== data.version ||
        (saved.host ?? "") !== data.host || (saved.endpoint ?? "") !== data.endpoint) {
      throw conflict("该范围内的服务或这条登记记录已存在，请核对后重试。");
    }
    return this.service(data.id);
  }

  updateDeployment(id: string, input: unknown) {
    const data = read(deploymentPatch, input);
    const updated = this.db.prepare("UPDATE opc_ops_services SET host=?, endpoint=? WHERE id=?").run(data.host, data.endpoint, id);
    if (!updated.changes) throw new ApiError(404, "operations_service_missing", "找不到这项服务。");
    return this.service(id);
  }

  append(id: string, input: unknown) {
    const data = read(submit, input);
    const payload = JSON.stringify(data.event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const service = this.service(id);
      const prior = this.db.prepare("SELECT payload FROM opc_ops_events WHERE service=? AND id=?").get(id, data.id);
      if (prior && prior.payload !== payload) throw conflict("这条记录已使用，请刷新后重新填写。");
      if (!prior) {
        if (service.revision !== data.revision) throw conflict("服务记录已有更新，请重新读取后再提交。");
        const at = new Date().toISOString();
        apply(service, data.id, data.event, at);
        this.db.prepare("INSERT INTO opc_ops_events(service,id,sequence,payload,at) VALUES(?,?,?,?,?)")
          .run(id, data.id, service.revision, payload, at);
      }
      this.db.exec("COMMIT");
      return service;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function registerOperationsDepartmentRoutes(
  app: Hono, db: DatabaseSync, user: (c: Context) => unknown,
  readHealth: () => Promise<RichServiceProbe[]> = async () => [],
  fleetOptions: FleetReaderOptions = {},
) {
  const store = new OperationsDepartmentStore(db);
  const path = "/api/opc/departments/operations";
  const preview = process.env.KUNLUN_PREVIEW === "1" || process.env.DEMO_MODE === "1";
  app.use(path + "/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    user(c);
    await next();
  });
  app.get(path, c => c.json(store.index()));
  app.get(path + "/health", async c => {
    const services = (await readHealth()).map(({ id, name, healthy, latencyMs }) => ({ id, name, healthy, latencyMs }));
    return c.json({ checkedAt: new Date().toISOString(), services });
  });
  app.get(path + "/topology", async c => {
    const probes = await readHealth();
    const topology = await buildOperationsTopology(store.index().services, probes, {
      selfPort: Number(process.env.PORT ?? 0) || undefined,
      disableHostProbes: preview,
      ...fleetOptions,
    });
    return c.json(topology);
  });
  app.post(path + "/services", async c => c.json(store.create(await c.req.json())));
  app.patch(`${path}/services/:id/deployment`, async c => c.json(store.updateDeployment(c.req.param("id"), await c.req.json())));
  app.post(`${path}/services/:id/events`, async c => c.json(store.append(c.req.param("id"), await c.req.json())));
}
