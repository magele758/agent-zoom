import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorService, validateCoordination } from "./server/coordinator.ts";
import { openStore, type Principal } from "./server/logic.ts";
import type { ModelAdapter, ModelTurnInput } from "@ppeng/agent-loop";
function fixture() {
  const store=openStore(":memory:");const session=store.session("协调测试");const user=store.userBySession(session.token) as Principal & {type:"user"};const roomId=store.listRooms(user.id)[0].id;
  const join=(handle:string,tags:string)=>store.enroll(store.createJoinCode(user,roomId).code,handle,"real-test-client",tags,3);
  const worker=join("sdk-worker","build");join("sdk-review","review,test");store.agentByToken(worker.token);
  return {store,user,roomId,worker};
}
const plan={summary:"准备派发",mode:"task",handle:"sdk-worker",body:"执行明确的任务",acceptance:"提供独立可验证的结果",warnings:[]};
function model(value:unknown=plan):ModelAdapter {
  let turn=0;return {name:"sdk-fixture",summarizeMessages:async()=>"",runTurn:async()=>{
    turn++;return turn===1?{stopReason:"tool_use",assistantParts:[{type:"tool_call",toolCallId:"read",name:"read_current_channel",input:{}}]}:turn===2?{stopReason:"tool_use",assistantParts:[{type:"tool_call",toolCallId:"plan",name:"prepare_dispatch",input:value as Record<string,unknown>}]}:{stopReason:"end",assistantParts:[{type:"text",text:"等待确认"}]};
  }};
}
async function settle(svc:CoordinatorService,user:Principal & {type:"user"},id:string) { for(let i=0;i<600;i++){const r=svc.get(user,id);if(r.status!=="running")return r;await new Promise(r=>setTimeout(r,10));}throw Error("协调未结束"); }
test("real SDK executes channel read and plan tools without dispatch, then applies once",async()=>{
  const f=fixture();const svc=new CoordinatorService(f.store,{model:()=>({adapter:model(),model:"test-model",source:"fixture"})});const run=svc.start(f.user,f.roomId,"请安排工作");
  const ready=await settle(svc,f.user,run.id);assert.equal(ready.status,"ready");assert.equal(f.store.snapshot(f.user,f.roomId,new Set()).tasks.length,0);assert.ok(ready.trace.some(t=>t.tool==="read_current_channel"));
  const first=svc.apply(f.user,run.id);const second=svc.apply(f.user,run.id);assert.equal(first.task!.id,second.task!.id);assert.equal(f.store.snapshot(f.user,f.roomId,new Set()).tasks.length,1);assert.equal(first.task!.status,"open");
});
test("role changes invalidate a saved plan and other users cannot read or apply it",async()=>{
  const f=fixture();const svc=new CoordinatorService(f.store,{model:()=>({adapter:model(),model:"test",source:"fixture"})});const run=svc.start(f.user,f.roomId,"做计划");await settle(svc,f.user,run.id);
  const other=f.store.userBySession(f.store.session("另一用户").token) as Principal & {type:"user"};assert.throws(()=>svc.get(other,run.id),/没有这条/);assert.throws(()=>svc.apply(other,run.id),/没有这条/);
  const agent=f.store.agentByToken(f.worker.token)!;f.store.setGroup(f.user,agent.id,"review");assert.throws(()=>svc.apply(f.user,run.id),/重新分析/);assert.equal(f.store.snapshot(f.user,f.roomId,new Set()).tasks.length,0);
});
test("plan validation rejects fake clients, wrong roles, busy agents and self checks",()=>{
  const f=fixture();const snap=f.store.snapshot(f.user,f.roomId,new Set());assert.throws(()=>validateCoordination({...plan,handle:"made-up"},snap),/真实客户端/);assert.throws(()=>validateCoordination({...plan,handle:"sdk-review"},snap),/没有配置/);
  assert.throws(()=>validateCoordination({...plan,body:"执行任务并叫 @sdk-review 一起实现"},snap),/不能额外/);
  const normalized=validateCoordination({...plan,warnings:Array.from({length:12},(_,i)=>`建议 ${i}`)},snap);assert.doesNotThrow(()=>validateCoordination(normalized,snap));
  f.store.setGroup(f.user,f.store.agentByToken(f.worker.token)!.id,"build,review,test");assert.throws(()=>validateCoordination({...plan,mode:"pipeline",steps:[{role:"build",handle:"sdk-worker"},{role:"qa",handle:"sdk-worker"}]},f.store.snapshot(f.user,f.roomId,new Set())),/不能评审或测试/);
  const task=f.store.postMessage(f.user,f.roomId,{kind:"instruction",body:"@sdk-worker 实际任务"}).task!;f.store.claim(f.store.agentByToken(f.worker.token) as Principal & {type:"agent"},task.id,"implementer");assert.throws(()=>validateCoordination(plan,f.store.snapshot(f.user,f.roomId,new Set())),/正在执行/);
});
test("cancel aborts an actual SDK model call, never creates a plan or task",async()=>{
  const f=fixture();let aborted=false;let began=false;const adapter:ModelAdapter={name:"blocked-test",summarizeMessages:async()=>"",runTurn:async(input:ModelTurnInput)=>{began=true;return new Promise((_resolve,reject)=>{input.signal?.addEventListener("abort",()=>{aborted=true;reject(Error("aborted"))},{once:true});});}};
  const svc=new CoordinatorService(f.store,{model:()=>({adapter,model:"test",source:"fixture"})});const run=svc.start(f.user,f.roomId,"可取消的协调");for(let i=0;!began&&i<600;i++)await new Promise(r=>setTimeout(r,10));await svc.stop(f.user,run.id);assert.ok(aborted);assert.equal(svc.get(f.user,run.id).status,"canceled");assert.equal(f.store.snapshot(f.user,f.roomId,new Set()).tasks.length,0);
});
test("SDK model errors remain failed without fabricated recommendations",async()=>{
  const f=fixture();const adapter:ModelAdapter={name:"failed-test",summarizeMessages:async()=>"",runTurn:async()=>{throw Error("provider unavailable");}};const svc=new CoordinatorService(f.store,{model:()=>({adapter,model:"test",source:"fixture"})});const run=svc.start(f.user,f.roomId,"不要假回复");assert.equal((await settle(svc,f.user,run.id)).status,"failed");assert.equal(f.store.snapshot(f.user,f.roomId,new Set()).tasks.length,0);
});

test("an agent working in another room is not scheduled and private task contents stay out of context",async()=>{
  const f=fixture();const other=f.store.createRoom(f.user,"另一项目","private-project");f.store.placeExisting(f.user,other.id,"sdk-worker");const task=f.store.postMessage(f.user,other.id,{kind:"instruction",body:"@sdk-worker OTHER_ROOM_SECRET_BODY"}).task!;f.store.claim(f.store.agentByToken(f.worker.token) as Principal & {type:"agent"},task.id,"implementer");
  const svc=new CoordinatorService(f.store,{model:()=>({adapter:model(),model:"test",source:"fixture"})});const run=svc.start(f.user,f.roomId,"安排工作");assert.equal((await settle(svc,f.user,run.id)).status,"failed");
  const row=f.store.db.prepare("SELECT transcript_json FROM coordinator_runs WHERE id=?").get(run.id) as {transcript_json:string};assert.ok(!row.transcript_json.includes("OTHER_ROOM_SECRET_BODY"));assert.equal(f.store.snapshot(f.user,f.roomId,new Set()).tasks.length,0);
});

test("ordinary lease heartbeat does not invalidate another agent's plan",async()=>{
  const f=fixture();const joined=f.store.enroll(f.store.createJoinCode(f.user,f.roomId).code,"heartbeat-worker","test-client","build",3);const actor=f.store.agentByToken(joined.token) as Principal & {type:"agent"};const task=f.store.postMessage(f.user,f.roomId,{kind:"instruction",body:"@heartbeat-worker 已存在的任务"}).task!;f.store.claim(actor,task.id,"implementer");
  const svc=new CoordinatorService(f.store,{model:()=>({adapter:model(),model:"test",source:"fixture"})});const run=svc.start(f.user,f.roomId,"安排另一个客户端");await settle(svc,f.user,run.id);f.store.heartbeat(actor,task.id);assert.equal(svc.apply(f.user,run.id).run.status,"applied");
});
