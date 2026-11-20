import type { Context, Hono } from "hono";
import type { WorkflowRun } from "../workflow-types.ts";
import type { Principal, Store } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";
import { readPausedWorkflow, type WorkflowService } from "./workflow/service.ts";
import { channelMessages } from "./zoom-channel.ts";
import { workflowMessages } from "./zoom-workflow.ts";
import type { ZoomMessage } from "../zoom-types.ts";
import { addDelegationRoutes } from "./delegation.ts";
import { ZoomStore } from "./zoom.ts";
import type { HomeRoomBridge } from "./home-room.ts";
import type { OpportunityStore } from "./autonomy.ts";
import { addBusinessRoutes } from "./business.ts";
import { addGrowthRoutes } from "./growth.ts";
import { addProjectProfileRoutes } from "./project-profiles.ts";
import { addCommercialRoutes } from "./commercial.ts";
import { registerOperationsDepartmentRoutes } from "./operations-department.ts";
import { registerResourceDepartmentRoutes } from "./resource-department.ts";
import { registerSecurityDepartmentRoutes } from "./security-department.ts";
import { addProjectRoutes } from "./projects.ts";
import { projectMessages } from "./project-mail.ts";
import { addWorklogRoutes } from "./worklog.ts";
import { addCapabilityRoutes } from "./repo-capabilities.ts";
import { ApiError, PRESENCE_MS } from "./logic.ts";
import { addCompanyLearnRoutes } from "./company-learn.ts";
import { addCompanyRoutes } from "./company.ts";
import { addStageWorkRoutes } from "./stage-work.ts";
import { addStageHomeRoutes } from "./stage-home.ts";

export function addZoomRoutes(app: Hono, store: Store, options: {
  submitToken?: string;
  opportunities: OpportunityStore;
  homeRooms: HomeRoomBridge;
  workflow?: WorkflowService;
  user: (c: Context) => Extract<Principal, { type: "user" }>;
}) {
  const zoom = new ZoomStore(store.db);
  const { requireSubmit } = submitAuth(options.submitToken);
  if (!options.workflow) {
    app.get("/api/workflows/:id", c => {
      options.user(c);
      c.header("Cache-Control", "no-store");
      return c.json(readPausedWorkflow(store.db, c.req.param("id")));
    });
  }
  app.use("/api/zoom/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  addBusinessRoutes(app, store.db, options.submitToken, options.user, options.opportunities);
  addGrowthRoutes(app, store.db, options.submitToken, options.user);
  const projects = addProjectRoutes(app, store.db, options.submitToken, options.user);
  addCompanyLearnRoutes(app, options.user);
  addCompanyRoutes(app, store.db, options.submitToken, options.user, options.opportunities);
  addProjectProfileRoutes(app, store.db, options.submitToken, options.user);
  registerSecurityDepartmentRoutes(app, store.db, options.user);
  registerResourceDepartmentRoutes(app, store.db, options.user);
  const commercial = addCommercialRoutes(app, store.db, options.opportunities, options.submitToken, options.user);
  registerOperationsDepartmentRoutes(app, store.db, options.user, async () => {
    return (await commercial.checkServices()).services;
  });
  const capabilities = addCapabilityRoutes(app,store.db,options.opportunities,options.submitToken,options.user);
  addWorklogRoutes(app, store.db, options.user);
  const work = addStageWorkRoutes(app, store.db, options.submitToken, options.user);
  const home = addStageHomeRoutes(app, store.db, work, options.user);
  function rawMessages(user: Extract<Principal, { type: "user" }>): ZoomMessage[] {
    const workflow = options.workflow?.messages() ?? store.db.prepare("SELECT snapshot FROM workflow_runs ORDER BY created_at DESC").all()
      .flatMap(row => workflowMessages(JSON.parse(String(row.snapshot)) as WorkflowRun));
    const trials = new Map(store.db.prepare("SELECT task_id,id,line_id FROM opc_trials").all()
      .map(row => [String(row.task_id), {lineId:String(row.line_id),trialId:String(row.id)}]));
    const capabilityTasks = new Map(store.db.prepare("SELECT id,task_id FROM opc_capability_requests WHERE task_id IS NOT NULL").all()
      .map(row => [String(row.task_id),String(row.id)]));
    const requirementVersions = new Map(store.db.prepare("SELECT question_id,revision FROM opc_capability_revisions WHERE question_id IS NOT NULL").all()
      .map(row => [String(row.question_id),Number(row.revision)]));
    const native = zoom.messages().map(message => {
      const id = capabilityTasks.get(message.taskId);
      if (id) return {...message,capabilityRequest:{id,revision:requirementVersions.get(message.replyTo??message.id)}};
      return trials.has(message.taskId) ? {...message,businessTrial:trials.get(message.taskId)} : message;
    });
    return [...native, ...workflow, ...options.homeRooms.zoomMessages(user), ...channelMessages(store, user), ...projectMessages(store.db)];
  }
  app.get("/api/opc/delegations/agents", c => {
    const user = options.user(c);
    c.header("Cache-Control", "no-store");
    const rows = store.db.prepare(`SELECT DISTINCT a.handle,a.runtime,a.last_seen_at FROM agents a
      JOIN local_console l ON l.singleton=1 JOIN rooms lobby ON lobby.id=l.room_id AND lobby.org_id=a.org_id
      JOIN room_members m ON m.principal_type='agent' AND m.principal_id=a.id
      JOIN rooms r ON r.id=m.room_id AND r.archived=0
      JOIN room_members u ON u.room_id=m.room_id AND u.principal_type='user' AND u.principal_id=? AND u.hidden=0
      WHERE a.paused=0 AND a.demo=0 ORDER BY a.handle`).all(user.id);
    return c.json({ agents: rows.map(a => ({handle:String(a.handle),runtime:String(a.runtime),
      online: !!a.last_seen_at && Date.parse(String(a.last_seen_at)) > Date.now()-PRESENCE_MS})) });
  });
  const delegations = addDelegationRoutes(app, store, work, home, options.user, rawMessages, options.homeRooms);
  app.get("/api/zoom/messages", c => {
    const messages = delegations.decorate(rawMessages(options.user(c)))
      .sort((a, b) => Number(b.pending) - Number(a.pending) || b.at.localeCompare(a.at));
    const projectFolders = store.db.prepare("SELECT product, name FROM company_projects ORDER BY product,name").all()
      .map(row => row.product + "/" + row.name);
    return c.json({ messages, products: projects.names(), projectFolders });
  });
  app.post("/api/zoom/tasks", async c => {
    requireSubmit(c);
    return c.json(zoom.register(await c.req.json()));
  });
  app.post("/api/zoom/tasks/:id/messages", async c => {
    requireSubmit(c);
    const id = c.req.param("id");
    if (capabilities.task(id)) throw new ApiError(409,"capability_task","请通过原仓需求的修订或审批入口更新本任务");
    const event = await c.req.json();
    return c.json(work.has(id) ? work.report(id,event) : zoom.report(id,event));
  });
  app.get("/api/zoom/tasks/:id/feedback", c => {
    requireSubmit(c);
    return c.json(zoom.feedback(c.req.param("id"), Number(c.req.query("after") ?? "0")));
  });
  app.post("/api/zoom/tasks/:id/replies", async c => {
    const user = options.user(c);
    const id = c.req.param("id");
    const input = await c.req.json();
    if (id.startsWith("home-room:")) return c.json(await options.homeRooms.replyZoom(user, id, input), 202);
    if (capabilities.task(id)) return c.json(capabilities.reply(id, input, user.name));
    return c.json(zoom.reply(id, input, user.name));
  });
  return delegations;
}
