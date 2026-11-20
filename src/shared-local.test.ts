import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { addWorkflowBoardRoutes } from "./server/workflow/board.ts";
import { openDatabase } from "./server/db.ts";
import { Store } from "./server/logic.ts";
import { channelMessages } from "./server/zoom-channel.ts";

function historicalDatabase() {
  const db = openDatabase(":memory:");
  const stamp = "2026-01-01T00:00:00.000Z";
  for (const scope of ["east", "west"]) {
    db.prepare("INSERT INTO users VALUES (?,?,?,?)").run(scope, scope, scope, stamp);
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("legacy-" + scope, scope, stamp);
    db.prepare("INSERT INTO orgs VALUES (?,?,?)").run(scope, "工作室", stamp);
    db.prepare("INSERT INTO org_members VALUES (?,?,'owner')").run(scope, scope);
    db.prepare("INSERT INTO rooms(id,org_id,name,general,created_by,created_at) VALUES (?,?,?,1,?,?)").run(scope, scope, "大厅", scope, stamp);
    db.prepare("INSERT INTO room_members(room_id,principal_type,principal_id,joined_at) VALUES (?,'user',?,?)").run(scope, scope, stamp);
    db.prepare("INSERT INTO messages(id,room_id,seq,author_type,author_id,kind,body,created_at) VALUES (?,?,1,'user',?,'chat',?,?)").run("history-" + scope,scope,scope,scope + " 的历史",stamp);
  }
  const agent = (scope: string, handle: string, demo = false) => {
    const id = scope + "-" + handle;
    db.prepare("INSERT INTO agents(id,org_id,owner_user_id,handle,runtime,token_hash,created_at,demo,tags) VALUES (?,?,?,?,'codex',?,?,?,'build')")
      .run(id,scope,scope,handle,createHash("sha256").update(id).digest("hex"),stamp,Number(demo));
    db.prepare("INSERT INTO room_members(room_id,principal_type,principal_id,joined_at) VALUES (?,'agent',?,?)").run(scope,id,stamp);
    return id;
  };
  agent("east","coder");
  agent("west","coder");
  return { db, agent };
}

test("all local browsers use the same channels across old profiles, without recreating clients or rewriting history", () => {
  const { db } = historicalDatabase();
  const store = new Store(db);
  const user = store.localUser();
  assert.deepEqual(store.userBySession("legacy-west"), user);
  const west = store.agentByToken("west-coder");
  const east = store.agentByToken("east-coder");
  assert.ok(west?.type === "agent" && east?.type === "agent");
  assert.notEqual(west.id, east.id);
  assert.deepEqual(store.me(user).rooms.map(room => room.id).sort(), ["east","west"]);
  assert.deepEqual(store.me(user).agents.map(agent => agent.id).sort(), [east.id,west.id]);
  assert.equal(store.localRoom(), "east");
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 2);
  assert.equal(store.session("another name").user.id, user.id);
  assert.equal(store.session("").roomId, "east");
  assert.equal(db.prepare("SELECT count(*) AS n FROM orgs").get()?.n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM rooms").get()?.n, 2);
  assert.equal(store.readMessages(user,"west",0)[0].authorId, "west");
  assert.throws(() => store.readMessages(east, "west", 0), /不在这个频道/);
  const question = store.postMessage(west,"west",{kind:"question",body:"何时复测？"});
  assert.ok(channelMessages(store,user).some(item => item.id === "channel:" + question.message.id && item.pending));
  store.postMessage(user,"west",{body:"明天",replyTo:String(question.message.id)});
  assert.ok(store.inboxAfter(west.id,0).some(item => item.summary === "明天"));
  assert.equal(store.inboxAfter(east.id,0).length,0);
  assert.equal(store.setPaused(user,west.id,true).paused,true);
  store.setPaused(user,west.id,false);
  const room = store.createRoom(user,"新项目","");
  assert.throws(() => store.placeExisting(user,room.id,"coder"), /同名客户端/);
  assert.equal(store.placeExisting(user,room.id,"coder",west.id).id,west.id);
  assert.throws(() => store.placeExisting(user,room.id,"coder",east.id), /同名/);
  const task = store.postMessage(user,room.id,{kind:"instruction", body:"@coder 在新频道复测"}).task!;
  store.claim(west,task.id,"implementer");
  const until = new Date(Date.now()+60000).toISOString();
  db.prepare("INSERT INTO file_locks(org_id,path,agent_id,lease_until) VALUES ('east','shared.ts',?,?),('west','shared.ts',?,?)")
    .run(east.id,until,west.id,until);
  assert.throws(() => store.lockFile(west,"shared.ts",task.id), /锁在/);
  assert.equal(store.unlockFile(east,"shared.ts").released,true);
  store.lockFile(west,"shared.ts",task.id);
  assert.throws(() => store.lockFile(east,"shared.ts"), /锁在/);
  assert.equal(store.unlockFile(west,"shared.ts").released,true);
  const restored = new Store(db);
  assert.deepEqual(restored.localUser(), user);
  assert.equal(restored.localRoom(), store.localRoom());
  assert.equal(restored.snapshot(user,room.id,new Set()).tasks[0].claims[0].agentId,west.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents").get()?.n,2);
  db.close();
});

test("the explicit legacy owner repair retains old IDs, credentials and active claims", () => {
  const { db, agent } = historicalDatabase();
  const inactive = agent("west","claude");
  agent("west","maker",true);
  const displaced = agent("east","coder-old");
  const store = new Store(db);
  const east = store.agentByToken("east-coder");
  assert.ok(east?.type === "agent");
  const task = store.postMessage(store.localUser(),"east",{kind:"instruction",body:"@coder 修复当前任务"}).task!;
  store.claim(east,task.id,"implementer");
  const options = {from:"west",to:"east"};
  const step = (result: ReturnType<Store["reassignAgents"]>, handle: string) => result.steps.find(row => row.handle === handle)?.action;
  assert.equal(step(store.reassignAgents(options),"coder"),"skip");
  assert.equal(step(store.reassignAgents(options),"claude"),"move");
  assert.equal(store.credentialOwner(inactive)?.ownerId,"west");
  assert.equal(step(store.reassignAgents({...options,displace:true,apply:true}),"coder"),"skip");
  store.release(east,task.id,"implementer");
  assert.equal(step(store.reassignAgents({...options,displace:true,apply:true}),"coder"),"move_displacing");
  assert.equal(store.credentialOwner("west-coder")?.ownerId,"east");
  assert.equal(store.credentialOwner(inactive)?.ownerName,"east");
  assert.equal(db.prepare("SELECT handle FROM agents WHERE id=?").get(east.id)?.handle,"coder-old-2");
  assert.equal(db.prepare("SELECT handle FROM agents WHERE id=?").get(displaced)?.handle,"coder-old");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE demo=1 AND owner_user_id='west'").get()?.n,1);
  db.close();
});

test("old board marks converge into one shared record and re-opening the service preserves subsequent decisions about filing", async () => {
  const db = openDatabase(":memory:");
  db.exec(`CREATE TABLE workflow_board_marks(actor TEXT,run_id TEXT,seen_through INTEGER,archived_through INTEGER,PRIMARY KEY(actor,run_id))`);
  for (const id of ["visible","archived"]) {
    db.prepare("INSERT INTO workflow_runs(id,request_id,created_at,snapshot) VALUES (?,?,?,?)")
      .run(id,id,new Date().toISOString(),JSON.stringify({events: [1,2,3]}));
  }
  db.exec(`INSERT INTO workflow_board_marks VALUES ('one','visible',1,1),('two','visible',2,NULL),
    ('one','archived',1,2),('two','archived',2,3)`);
  const app = new Hono();
  addWorkflowBoardRoutes(app,db,c=>String(c.req.header("x-example-browser")));
  const marks = async (client: Hono) => (await (await client.request("/api/workflows/board/marks")).json()).marks;
  const initial = await marks(app);
  assert.deepEqual(initial.find((value: {id:string})=>value.id==="visible"), {id:"visible",seenThrough:2,archivedThrough:null});
  assert.deepEqual(initial.find((value: {id:string})=>value.id==="archived"), {id:"archived",seenThrough:2,archivedThrough:2});
  const post = (action:string,through:number) => app.request("/api/workflows/visible/mark",{
    method:"POST",headers:{"content-type":"application/json","x-example-browser":"another"},body:JSON.stringify({action,through})});
  assert.equal((await post("read",3)).status,200);
  assert.equal((await post("archive",3)).status,200);
  const restarted = new Hono();
  addWorkflowBoardRoutes(restarted,db,()=>"local");
  const found = (await marks(restarted)).find((value: {id:string})=>value.id==="visible");
  assert.deepEqual(found,{id:"visible",seenThrough:3,archivedThrough:3});
  assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_board_marks").get()?.n,4);
  db.close();
});
