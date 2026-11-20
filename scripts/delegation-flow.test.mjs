import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("全站委派通过真实 CLI 认领，重启后普通答复回原任务，带证据的审批建议回到本人待办", {timeout:45_000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),"opc-delegation-cli-"));
  const socket = createServer().listen(0,"127.0.0.1");
  await once(socket,"listening");
  const port = socket.address().port;
  await new Promise(r=>socket.close(r));
  const origin = "http://127.0.0.1:"+port;
  const env = {...process.env, PORT:String(port), KUNLUN_URL:origin, WORKFLOW_SUBMIT_TOKEN:randomUUID(),
    DATA_PATH:join(dir,"opc.db"), OPC_ACTIVITY_INDEX:"0", DEMO_MODE:"0", KUNLUN_PREVIEW:"0", XDG_CONFIG_HOME:dir };
  for (const key of ["WORKFLOW_CONFIG","OPC_WORKFLOW_CONFIG","HFLOW_WORKER","KUNLUN_WORKFLOW_WORKER"]) delete env[key];
  let server, closed, cookie, errors="";
  const stop = async () => { if (server && server.exitCode === null && !server.signalCode) server.kill(); await closed; };
  t.after(async()=>{await stop(); await rm(dir,{recursive:true,force:true});});
  async function start() {
    server = spawn(process.execPath,["--import","tsx","src/server/index.ts"],{cwd:root,env,stdio:["ignore","ignore","pipe"]});
    closed = once(server,"exit");
    server.stderr.on("data", s=>{errors+=s;});
    for (let i=0;i<80;i++) {
      if(server.exitCode!==null) assert.fail(errors);
      const r=await fetch(origin+"/api/me").catch(()=>null);
      if(r?.ok){cookie=r.headers.get("set-cookie").split(";")[0];return;}
      await delay(90);
    }
    assert.fail("服务启动超时 "+errors);
  }
  const cli = async (...args)=>JSON.parse((await exec(process.execPath,[join(root,"scripts/zoom.mjs"),...args],{env,cwd:dir})).stdout);
  async function human(path,method="GET",body) {
    const res=await fetch(origin+path,{method,headers:{cookie,"content-type":"application/json"},...(body && {body:JSON.stringify(body)})});
    assert.ok(res.ok,path+" "+res.status+" "+(!res.ok?await res.text():""));
    return res.json();
  }
  const list="/api/opc/delegations", feed="/api/zoom/messages";
  async function until(fn) {
    for(let i=0;i<100;i++){ const state=await fn(); if(state)return state; await delay(120); }
    assert.fail("等待委派状态超时 "+errors);
  }
  await start();
  const method={via:"coding-agent",target:"trace-worker",instructions:"核对原始记录，提供依据。"};
  assert.equal((await human(list)).preference,null);
  const source=await cli("start","确定版本","--task","stable-source","--source","requester");
  const question=await cli("ask",source.id,"这次使用哪个版本？","--id","q1");
  const first=await human(list,"POST",{messageId:question.id,method});
  assert.equal((await human(list,"POST",{messageId:question.id,method})).workId,first.workId);
  assert.equal((await human(feed)).messages.find(m=>m.id===question.id).pending,false);
  const offer=await cli("stage","list","--agent","trace-worker","--wait","--timeout","1");
  assert.deepEqual(offer.items.map(w=>w.id),[first.workId]);
  const {claimId}=await cli("stage","claim",first.workId,"--agent","trace-worker","--session","source-1");
  await stop();
  await start();
  assert.equal((await cli("stage","claim",first.workId,"--agent","trace-worker","--session","source-1")).claimId,claimId);
  await cli("done",first.workId,"使用 r3","--claim",claimId,"--id","answer","--evidence","fixture/revision-3");
  await until(async()=>(await cli("replies",source.id)).events.some(e=>e.body==="使用 r3"));
  assert.deepEqual((await cli("replies",source.id)).events[0].evidence,["fixture/revision-3"]);
  assert.equal((await human(list)).items.length,1);
  assert.equal((await human(list)).items[0].status,"completed");
  assert.deepEqual((await human(list)).items[0].evidence,["fixture/revision-3"]);
  const old=await cli("ask",source.id,"需要补什么材料？","--id","old");
  await human(list+"/preference","PUT",{...method,automatic:true});
  const approval=await cli("ask",source.id,"确认本版预算","--id","budget-1","--approval");
  const second=await until(async()=>(await human(list)).items.find(i=>i.sourceId===approval.id));
  assert.ok(second.requiresApproval);
  assert.ok(!(await human(list)).items.some(i=>i.sourceId===old.id));
  const worker=await cli("stage","claim",second.workId,"--agent","trace-worker","--session","source-2");
  await cli("done",second.workId,"建议批准预算，请本人确认。","--id","recommend","--claim",worker.claimId,"--evidence","fixture/budget");
  await until(async()=>(await human(feed)).messages.find(m=>m.id===approval.id && m.pending && m.delegation?.status==="approval"));
  assert.ok(!(await cli("replies",source.id)).events.some(e=>e.questionId===approval.id));
  await human("/api/zoom/tasks/"+source.id+"/replies","POST",{questionId:approval.id,body:"预算暂缓"});
  await until(async()=>(await human(list)).items.find(i=>i.id===second.id)?.status==="completed");
});
