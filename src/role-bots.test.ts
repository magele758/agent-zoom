import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { OpportunityStore } from "./server/autonomy.ts";
import { CompanyStore } from "./server/company.ts";
import { openDatabase } from "./server/db.ts";
import { OPC_GROUP_NAME, OPC_ROOM_TITLE } from "./server/executive-bots.ts";
import { ProjectStore } from "./server/projects.ts";
import { RepoCapabilities } from "./server/repo-capabilities.ts";
import { registerRoleBotRoutes, RoleBotService } from "./server/role-bots.ts";
import { StageHomeClient } from "./server/stage-home-client.ts";
import { LocalDemoExecutor } from "./server/workflow/executor.ts";
import { WorkflowService } from "./server/workflow/service.ts";

function startFakeAgentHome() {
  const bots = [
    { id: "research-bot", name: "Research Bot", title: "Researcher" },
    { id: "team-reviewer", name: "Team Reviewer", title: "Reviewer" },
    { id: "bot-stability-20261109-run-1", name: "召回稳定性 PM Bot", title: "Test" },
  ];
  const groups = [{ id: "grp-1", name: OPC_GROUP_NAME, botIds: ["research-bot"], roomIds: [] }];
  const rooms = [{ id: "room-1", title: OPC_ROOM_TITLE, status: "active", botIds: ["super-bot"] }];
  const tasks: Array<{ id: string; targetBotId: string; input: string }> = [];
  const roomMessages: Array<{ roomId: string; content: string }> = [];
  let createdCount = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = bodyText ? JSON.parse(bodyText) : {};
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (data: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET" && url.pathname === "/api/bots") return json({ bots });
      if (req.method === "GET" && url.pathname === "/api/bot-work/status") {
        return json({ bots: bots.map(b => ({ bot: b, status: "idle", activeWorkCount: 0 })) });
      }
      if (req.method === "GET" && url.pathname === "/api/bot-functional-groups") return json({ groups });
      if (req.method === "GET" && url.pathname === "/api/bot-rooms") return json({ rooms });
      if (req.method === "POST" && url.pathname === "/api/bots") {
        createdCount++;
        const bot = { id: `bot-created-${createdCount}`, name: body.name, title: body.title, description: body.description };
        bots.push(bot);
        return json({ bot }, 201);
      }
      if (req.method === "PATCH" && url.pathname === "/api/bot-functional-groups/grp-1") {
        groups[0].botIds = body.botIds;
        return json({ group: groups[0] });
      }
      if (req.method === "POST" && url.pathname === "/api/bot-rooms/room-1/bots") {
        if (!rooms[0].botIds.includes(body.botId)) rooms[0].botIds.push(body.botId);
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/bot-work/tasks") {
        const task = { id: `task-${tasks.length + 1}`, targetBotId: body.targetBotId, input: body.input };
        tasks.push(task);
        return json({ task }, 201);
      }
      if (req.method === "POST" && url.pathname === "/api/bot-rooms/room-1/messages") {
        roomMessages.push({ roomId: "room-1", content: body.content });
        return json({ ok: true }, 201);
      }
      return json({ error: "not_found" }, 404);
    });
  });

  return new Promise<{
    origin: string;
    close: () => Promise<void>;
    state: () => { createdCount: number; bots: typeof bots; groups: typeof groups; rooms: typeof rooms; tasks: typeof tasks; roomMessages: typeof roomMessages };
  }>(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(done => server.close(() => done())),
        state: () => ({ createdCount, bots, groups, rooms, tasks, roomMessages }),
      });
    });
  });
}

test("RoleBotService reuses existing role bots, ignores test bots, and auto-creates missing PM Bot once", async () => {
  const home = await startFakeAgentHome();
  const db = new DatabaseSync(":memory:");
  try {
    const client = new StageHomeClient({ PPENG_BASE_URL: home.origin });
    const service = new RoleBotService(db, client, "http://127.0.0.1:52328");

    const initial = await service.status();
    assert.equal(initial.agentHomeReachable, true);
    const byId = Object.fromEntries(initial.roles.map(r => [r.id, r]));
    assert.equal(byId.research.resolution, "reused");
    assert.equal(byId.research.botId, "research-bot");
    assert.equal(byId.qa.resolution, "reused");
    assert.equal(byId.qa.botId, "team-reviewer");
    // Must ignore ephemeral stability test bot even though its name contains "PM Bot"
    assert.equal(byId.pm.resolution, "on_demand");
    assert.equal(byId.pm.botId, null);

    // Ensure research reuses existing bot with zero creation
    const resReuse = await service.ensure("research");
    assert.equal(resReuse.action, "reused");
    assert.equal(resReuse.botId, "research-bot");
    assert.equal(home.state().createdCount, 0);

    // Ensure pm creates OPC 产品经理 Bot once, joins OPC group & executive room
    const pmFirst = await service.ensure("pm");
    assert.equal(pmFirst.action, "created");
    assert.equal(pmFirst.botName, "OPC 产品经理 Bot");
    assert.equal(pmFirst.inGroup, true);
    assert.equal(pmFirst.inRoom, true);
    assert.equal(home.state().createdCount, 1);

    // Second ensure("pm") reuses without creating a duplicate
    const pmSecond = await service.ensure("pm");
    assert.equal(pmSecond.action, "reused");
    assert.equal(pmSecond.botId, pmFirst.botId);
    assert.equal(home.state().createdCount, 1);

    // Coordinate dispatches Bot Work task & posts @mention to executive room
    const coord = await service.coordinate("pm", {
      title: "tool_call 参数审计门禁",
      stage: "PRD 拍板 · r1",
      workflowId: "wf-demo-1",
      summary: "Coding Agent 已产出调研报告与 PRD 草案，请汇总取舍并提醒创始人拍板。",
    });
    assert.equal(coord.action, "reused");
    assert.equal(coord.taskId, "task-1");
    assert.equal(coord.roomPosted, true);
    assert.equal(home.state().tasks.length, 1);
    assert.match(home.state().roomMessages[0].content, /@OPC 产品经理 Bot/);

    // Verify HTTP routes register cleanly
    const app = new Hono();
    registerRoleBotRoutes(app, db, () => ({ id: "u1", name: "founder" }), { client, opcOrigin: "http://127.0.0.1:52328" });
    const res = await app.request("/api/opc/role-bots");
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.roles.length, 4);
  } finally {
    db.close();
    await home.close();
  }
});

test("CompanyStore dispatch supports full-product 7-node DAG (research -> prd -> prd_gate -> design -> design_gate -> implement -> review)", () => {
  const dir = mkdtempSync("/tmp/opc-full-dag-test-");
  const repo = join(dir, "repo");
  const db = openDatabase(":memory:");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "# test\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init"], { cwd: repo });

    const workflow = new WorkflowService(
      db,
      {
        workspace: repo,
        projectWorkspaces: { "OPC/demo-app": repo },
        attemptRoot: join(dir, "attempts"),
        backendKey: "test-key",
        boardUrl: "http://127.0.0.1:52328",
        implement: [process.execPath, "scripts/workflow-demo-implement.mjs"],
        review: [process.execPath, "scripts/workflow-demo-review.mjs"],
      },
      new LocalDemoExecutor(join(dir, "attempts")),
    );
    const projects = new ProjectStore(db);
    const opportunities = new OpportunityStore(db, workflow);
    new RepoCapabilities(db, opportunities);
    const company = new CompanyStore(db);

    projects.create({ name: "OPC" });
    company.createProject({ product: "OPC", name: "demo-app", repos: [] });

    const ideaId = "11111111-1111-4111-8111-111111111111";
    company.addNote("idea", { id: ideaId, body: "支持全流程产研交付与设计稿内联预览", products: ["OPC"] });

    const dispatched = company.dispatch(ideaId, { product: "OPC", name: "demo-app", pipeline: "full-product" }, opportunities);
    assert.equal(dispatched.status, "plan");
    assert.ok(dispatched.runId);

    const run = workflow.get(dispatched.runId!);
    const nodeIds = run.revisions[0].plan.nodes.map(n => n.id);
    assert.deepEqual(nodeIds, ["research", "prd", "prd_gate", "design", "design_gate", "implement", "review"]);
    assert.equal(run.revisions[0].plan.nodes.find(n => n.id === "prd_gate")?.kind, "gate");
    assert.equal(run.revisions[0].plan.nodes.find(n => n.id === "design_gate")?.kind, "gate");
    assert.deepEqual(run.revisions[0].plan.acceptance, ["review"]);
    assert.equal(run.request.stage, "prd");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
