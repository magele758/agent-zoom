import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { openDatabase } from "./server/db.ts";
import { ProjectStore } from "./server/projects.ts";
import { CompanyStore } from "./server/company.ts";
import { ApiError } from "./server/logic.ts";
import { OperationsDepartmentStore, registerOperationsDepartmentRoutes } from "./server/operations-department.ts";

test("运维记录按项目归属，区分健康、更新计划、回退与已验证版本", t => {
  const db = openDatabase(":memory:"); t.after(() => db.close());
  new ProjectStore(db).create({ name: "产品甲" });
  new CompanyStore(db).createProject({ product: "产品甲", name: "网关" });
  const ops = new OperationsDepartmentStore(db);
  const registration = { id: randomUUID(), name: "消息服务", scope: "产品甲/网关", version: "1.0" };
  assert.throws(() => ops.create({ ...registration, scope: "产品乙/网关" }), /从目录/);
  let service = ops.create(registration);
  assert.deepEqual(ops.create(registration), service);
  assert.throws(() => ops.create({ ...registration, id: randomUUID() }), /已存在/);
  const observation = { id: randomUUID(), revision: 0, event: { kind: "observation", health: "degraded", source: "11:00 网关日志", note: "请求延迟增加" } };
  service = ops.append(service.id, observation);
  assert.deepEqual(ops.append(service.id, observation), service);
  assert.throws(() => ops.append(service.id, { ...observation, event: { ...observation.event, health: "healthy" } }), /已使用/);
  const plan = { id: randomUUID(), revision: 1, event: { kind: "plan", target: "2.0", note: "小范围更新" } };
  assert.throws(() => ops.append(service.id, { ...plan, revision: 0 }), /已有更新/);
  service = ops.append(service.id, plan);
  assert.equal(service.version, "1.0");
  assert.throws(() => ops.append(service.id, { ...plan, revision: 2, id: randomUUID() }), /当前更新的结果/);
  const result = { id: randomUUID(), revision: 2, event: { kind: "result", planId: plan.id, outcome: "rolled_back", note: "验证失败，已回退至 1.0" } };
  assert.throws(() => ops.append(service.id, { ...result, event: { ...result.event, planId: randomUUID() } }), /不属于/);
  assert.equal(ops.append(service.id, result).version, "1.0");
  const nextPlan = { ...plan, id: randomUUID(), revision: 3 };
  service = ops.append(service.id, nextPlan);
  service = ops.append(service.id, { id: randomUUID(), revision: 4, event: { kind: "result", planId: nextPlan.id, outcome: "applied", note: "版本检查和请求均通过" } });
  assert.equal(service.version, "2.0");
  assert.equal(service.observations[0].health, "degraded");
  assert.deepEqual(new OperationsDepartmentStore(db).index(), { scopes: ["产品甲", "产品甲/网关"], services: [service] });
});

test("读取服务台账和健康检查都需要本机身份，检查只返回可用性与延迟", async t => {
  const db = openDatabase(":memory:"); t.after(() => db.close()); new ProjectStore(db);
  const app = new Hono();
  const url = "/api/opc/departments/operations";
  let checks = 0;
  app.onError((error,c) => c.json({ message: error.message }, error instanceof ApiError ? error.status as 401 : 500));
  registerOperationsDepartmentRoutes(app, db, c => {
    if (!c.req.header("x-test-user")) throw new ApiError(401, "auth", "请先登录");
  }, async () => { checks++; return [{ id: "opc", name: "OPC", healthy: false, latencyMs: 52, body: "不公开的诊断" }]; });
  assert.equal((await app.request(url)).status, 401);
  assert.equal((await app.request(url + "/health")).status, 401);
  assert.equal((await app.request(url + "/services", { method: "POST" })).status, 401);
  assert.equal(checks, 0);
  const opts = { headers: { "x-test-user": "1" } };
  assert.deepEqual(await (await app.request(url, opts)).json(), { scopes: [], services: [] });
  const result = await app.request(url + "/health", opts);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const body = await result.json();
  assert.deepEqual(body.services, [{ id: "opc", name: "OPC", healthy: false, latencyMs: 52 }]);
  assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
  assert.equal(checks, 1);
});

test("运维拓扑聚合 Tailscale 机器状态、SSH 别名、远端 tmux 与服务部署归属，并支持修改部署信息", async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "opc-ops-fleet-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sshConfig = join(dir, "ssh_config");
  writeFileSync(sshConfig, "Host gpu-node\n  HostName 100.64.0.20\nHost worker-1\n  HostName 100.64.0.21\n");

  const hubDbPath = join(dir, "hub.db");
  const hubDb = new DatabaseSync(hubDbPath);
  hubDb.exec("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)");
  hubDb.prepare("INSERT INTO meta VALUES('machines_latest', ?)").run(JSON.stringify({
    ts: Math.floor(Date.now() / 1000),
    machines: [
      { id: "mac", label: "本机 Mac", online: true, load: [1.5], ncpu: 10, mem_free_mb: 8192, mem_total_mb: 32768, tmux: [] },
      { id: "gpu-node", label: "GPU Box", online: true, load: [0.4], ncpu: 24, mem_free_mb: 16384, mem_total_mb: 32768,
        gpu: [{ name: "RTX Demo", util: 12, mem_used_mb: 4096, mem_total_mb: 24576 }], tmux: ["render-worker"], claude: [{ pid: 1 }] },
      { id: "worker-1", label: "worker-1", online: true, load: [0.2], ncpu: 8, mem_free_mb: 4096, mem_total_mb: 16384, tmux: ["reader-svc"] },
    ],
  }));
  hubDb.close();

  const db = openDatabase(":memory:");
  t.after(() => db.close());
  new ProjectStore(db).create({ name: "OPC 商业套件" });
  new CompanyStore(db).createProject({ product: "OPC 商业套件", name: "opc-commerce-kit" });

  const app = new Hono();
  const base = "/api/opc/departments/operations";
  app.onError((error, c) => c.json({ message: error.message }, error instanceof ApiError ? error.status as 400 : 500));
  registerOperationsDepartmentRoutes(
    app,
    db,
    c => { if (!c.req.header("x-test-user")) throw new ApiError(401, "auth", "请先登录"); },
    async () => [
      { id: "commerce", name: "OPC Commerce Kit（收银）", repo: "opc-commerce-kit", origin: "http://127.0.0.1:52331", healthy: true, latencyMs: 14, summary: "2 笔订单" },
    ],
    {
      sshConfigPath: sshConfig,
      hubDbPath,
      selfPort: 52328,
      tailscaleStatus: {
        Self: { HostName: "dev-mac", DNSName: "dev-mac.tail.ts.net.", OS: "macOS", TailscaleIPs: ["100.64.0.10"], Online: true },
        Peer: {
          p1: { HostName: "WIN-GPU", DNSName: "win-gpu.tail.ts.net.", OS: "windows", TailscaleIPs: ["100.64.0.20"], Online: true, CurAddr: "1.2.3.4:1234" },
          p2: { HostName: "linux-box", DNSName: "linux-box.tail.ts.net.", OS: "linux", TailscaleIPs: ["100.64.0.21"], Online: true, Relay: "derp1" },
        },
      },
      tailscaleServe: {
        Web: { "dev-mac.tail.ts.net:28443": { Handlers: { "/": { Proxy: "http://127.0.0.1:28790" } } } },
      },
      probeFn: async () => ({ healthy: true, latencyMs: 9 }),
    },
  );

  const opts = { headers: { "x-test-user": "1", "content-type": "application/json" } };
  const svcId = randomUUID();
  const created = await (await app.request(base + "/services", {
    ...opts, method: "POST",
    body: JSON.stringify({ id: svcId, name: "OPC Commerce Kit", scope: "OPC 商业套件/opc-commerce-kit", version: "0.1.0" }),
  })).json();
  assert.equal(created.name, "OPC Commerce Kit");

  const topo = await (await app.request(base + "/topology", { headers: { "x-test-user": "1" } })).json();
  assert.equal(topo.tailscaleAvailable, true);
  assert.equal(topo.machines.length, 3);
  assert.equal(topo.machines[0].self, true);
  const gpuMachine = topo.machines.find((m: { name: string }) => m.name === "gpu-node");
  assert.equal(gpuMachine.connection, "direct");
  assert.equal(gpuMachine.gpus[0].name, "RTX Demo");
  assert.deepEqual(gpuMachine.tmuxSessions, ["render-worker"]);
  assert.equal(gpuMachine.activeAgents, 1);

  const commerceDeploy = topo.deployments.find((d: { managedServiceId: string | null }) => d.managedServiceId === svcId);
  assert.equal(commerceDeploy.healthy, true);
  assert.equal(commerceDeploy.latencyMs, 14);
  assert.equal(commerceDeploy.summary, "2 笔订单");
  assert.ok(topo.deployments.some((d: { name: string; machineName: string }) => d.name === "render-worker" && d.machineName === "gpu-node"));
  assert.ok(topo.deployments.some((d: { source: string }) => d.source === "tailscale_serve"));

  const patched = await (await app.request(`${base}/services/${svcId}/deployment`, {
    ...opts, method: "PATCH",
    body: JSON.stringify({ host: "gpu-node", endpoint: "http://100.64.0.20:8188" }),
  })).json();
  assert.equal(patched.host, "gpu-node");
  assert.equal(patched.endpoint, "http://100.64.0.20:8188");
});
