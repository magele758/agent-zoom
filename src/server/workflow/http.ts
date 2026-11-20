import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../logic.ts";
import { HerdrExecutor, LocalDemoExecutor } from "./executor.ts";
import { WorkflowService } from "./service.ts";
import { addWorkflowBoardRoutes } from "./board.ts";

const argv = z.array(z.string().min(1)).min(1).max(30);
const configuration = z.strictObject({
  workspace: z.string().min(1),
  projectWorkspaces: z.record(z.string().trim().min(1).max(256), z.string().min(1)).optional(),
  attemptRoot: z.string().min(1).optional(),
  boardUrl: z.url().optional(),
  backend: z.enum(["herdr", "local-demo"]).default("herdr"),
  hc: z.string().min(1).default("hc"),
  space: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  planner: z.enum(["local", "coordinator"]).default("local"),
  implement: argv.optional(),
  review: argv.optional(),
  capabilities: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), argv).optional(),
});

function hash(value: string) { return createHash("sha256").update(value).digest(); }

export function submitAuth(token: string | undefined) {
  const expected = token && token.length >= 24 ? hash(token) : undefined;
  const permits = (c: Context) => {
    const supplied = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    return Boolean(expected && supplied && timingSafeEqual(hash(supplied), expected));
  };
  const requireSubmit = (c: Context) => {
    if (!expected) throw new ApiError(503, "submit_unconfigured", "服务尚未配置 WORKFLOW_SUBMIT_TOKEN");
    if (!permits(c)) throw new ApiError(401, "workflow_auth", "工作流发起凭据无效");
  };
  return { permits, requireSubmit };
}

export function configureWorkflow(db: DatabaseSync, dataPath: string, port: number) {
  if (!process.env.WORKFLOW_CONFIG) return undefined;
  const raw = configuration.parse(JSON.parse(readFileSync(process.env.WORKFLOW_CONFIG, "utf8")));
  const submitToken = process.env.WORKFLOW_SUBMIT_TOKEN;
  if (!submitToken || submitToken.length < 24) throw new Error("WORKFLOW_SUBMIT_TOKEN 需要至少 24 个字符");
  const workspace = realpathSync(raw.workspace);
  const projectWorkspaces = Object.fromEntries(Object.entries(raw.projectWorkspaces ?? {})
    .map(([project, path]) => [project, realpathSync(path)]));
  const attemptRoot = resolve(raw.attemptRoot ?? `${dataPath}.workflows`);
  const url = new URL(raw.boardUrl ?? `http://127.0.0.1:${port}`);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("boardUrl 需要本机 HTTP origin");
  const demo = raw.backend === "local-demo";
  const implement = demo ? [process.execPath, resolve("scripts/workflow-demo-implement.mjs")] : raw.implement;
  const review = demo ? [process.execPath, resolve("scripts/workflow-demo-review.mjs")] : raw.review;
  if (demo && raw.capabilities) throw new Error("自定义能力执行器需要 Herdr 宿主");
  if (!implement || !review || [implement, ...Object.values(raw.capabilities ?? {})].some(command => JSON.stringify(command) === JSON.stringify(review))) {
    throw new Error("配置独立的 implement 和 review 执行器 argv");
  }
  const backendKey = hash(JSON.stringify([raw.backend, attemptRoot, raw.hc, raw.space, process.env.HC_SOCKET,
    process.env.XDG_STATE_HOME, implement, review, Object.entries(raw.capabilities ?? {}).sort(([a], [b]) => a.localeCompare(b))])).toString("hex");
  const hostKey = hash(JSON.stringify([raw.backend, attemptRoot, raw.hc, process.env.HC_SOCKET, process.env.XDG_STATE_HOME])).toString("hex");
  const executor = demo ? new LocalDemoExecutor(attemptRoot) : new HerdrExecutor(raw.hc, raw.space);
  const service = new WorkflowService(db, { workspace, projectWorkspaces, attemptRoot, backendKey, hostKey, boardUrl: url.origin,
    implement, review, planner: raw.planner, capabilities: raw.capabilities }, executor);
  return { service, submitToken, db };
}

export function addWorkflowRoutes(app: Hono, config: ReturnType<typeof configureWorkflow>, userName: (c: Context) => string) {
  app.get("/api/workflows/enabled", c => c.json({ enabled: Boolean(config) }));
  if (!config) return;
  const { service, submitToken } = config;
  const { permits, requireSubmit } = submitAuth(submitToken);
  const requireRead = (c: Context) => {
    if (!permits(c)) userName(c);
    c.header("Cache-Control", "no-store");
  };
  addWorkflowBoardRoutes(app, config.db, userName);
  app.get("/api/workflows", c => {
    requireRead(c);
    return c.json({ runs: service.list() });
  });
  app.get("/api/workflows/:id", c => {
    requireRead(c);
    return c.json(service.get(c.req.param("id")));
  });
  app.get("/api/workflows/:id/feedback", c => {
    requireRead(c);
    const run = service.get(c.req.param("id"));
    const cursor = Number(c.req.query("after") ?? "0");
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > run.events.length) {
      throw new ApiError(400, "workflow_cursor", "反馈游标无效");
    }
    const events = run.events.slice(cursor).map((event, index) => ({ ...event, seq: cursor + index + 1 }))
      .filter(event => event.kind.startsWith("decision_") || ["retry", "fenced", "revised", "receipt"].includes(event.kind));
    return c.json({ runId: run.id, requestId: run.request.requestId, source: run.request.source, context: run.request.context,
      revision: run.summary.revision, phase: run.summary.phase, turn: run.summary.turn, cursor: run.events.length, events });
  });
  app.post("/api/workflows", async c => {
    requireSubmit(c);
    if (c.req.header("x-kunlun-workflow-worker") === "1") {
      throw new ApiError(403, "workflow_worker", "执行节点不能发起递归工作流");
    }
    return c.json(await service.submitPlanned(await c.req.json()), 202);
  });
  app.post("/api/workflows/:id/revisions", async c => {
    requireSubmit(c);
    return c.json(service.revise(c.req.param("id"), await c.req.json()));
  });
  app.post("/api/workflows/:id/decisions", async c => {
    const actor = userName(c);
    const body = await c.req.json();
    const detail = service.decide(c.req.param("id"), body, actor);
    if (body && typeof body === "object" && body.cleanup === true &&
        (detail.summary.phase === "complete" || body.action === "reject") &&
        !detail.attempts.some(attempt => ["dispatching", "running", "unknown"].includes(attempt.state))) {
      try {
        return c.json(await service.cleanupRun(detail.id, actor));
      } catch {
        return c.json(detail);
      }
    }
    return c.json(detail);
  });
  app.post("/api/workflows/:id/cleanup", async c => {
    if (c.req.header("x-kunlun-workflow-worker") === "1") {
      throw new ApiError(403, "workflow_worker", "执行节点不能清理工作流现场");
    }
    const actor = permits(c) ? "cli" : userName(c);
    return c.json(await service.cleanupRun(c.req.param("id"), actor));
  });
  app.post("/api/workflows/:id/runners", async c => {
    const actor = userName(c);
    return c.json(service.selectRunner(c.req.param("id"), await c.req.json(), actor));
  });
  app.post("/api/workflows/:id/retry", async c => {
    const actor = userName(c);
    return c.json(service.retry(c.req.param("id"), await c.req.json(), actor));
  });
  app.post("/api/workflows/:id/recover", async c => {
    const actor = userName(c);
    return c.json(await service.recover(c.req.param("id"), await c.req.json(), actor));
  });
}
