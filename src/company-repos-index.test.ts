import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { IndexedRepo } from "./activity-index-types.ts";
import { createRepoIndex, REPO_INDEX_INTERVAL_MS } from "./server/company-repos-index.ts";

const exec=promisify(execFile);
const repository=(fullName:string,visibility:IndexedRepo["visibility"]="public"):IndexedRepo=>({
  fullName,visibility,url:"https://github.com/"+fullName,description:"",relations:["我的"],managed:[],paths:[],
  pushedAt:null,language:"TypeScript",defaultBranch:"main",
});
function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE company_project_repos (product,name,repo); CREATE TABLE project_repositories(full_name,snapshot)");
  let key="github.com/alice",now=1_700_000_000_000,requests=0,online=true;
  const readers={identity:async()=>key,now:()=>now,
    local:async()=>({rows:[{fullName:"Alice/Foo",paths:["/dev/foo","/trees/foo"]},{fullName:"/dev/local",paths:["/dev/local"]}],roots:["/dev"],notes:[]}),
    github:async()=>{requests++;if(!online)throw Error("offline");
      const login=key.slice(11);return {login,rows:[repository(login+"/foo"),repository(login+"/secret","private")]};}};
  return {db,readers,get:()=>requests,advance:()=>now+=REPO_INDEX_INTERVAL_MS+1,offline:()=>online=false,switch:()=>key="github.com/bob"};
}

test("仓库索引按原仓合并本地工作树、真实账号关系与维护项目；并发和普通读取共用十五分钟缓存",async()=>{
  const f=fixture();
  try{
    f.db.exec(`INSERT INTO company_project_repos VALUES('工具','解析','alice/foo');
      INSERT INTO project_repositories VALUES('alice/foo','{"visibility":"public"}')`);
    const read=createRepoIndex(f.db,f.readers);
    const [result,concurrent]=await Promise.all([read(),read(true)]);
    assert.deepEqual(concurrent,result);
    assert.equal(f.get(),1);
    assert.equal(result.repositories.length,3);
    const foo=result.repositories[0]!;
    assert.deepEqual(foo.managed,[{product:"工具",project:"解析"}]);
    assert.deepEqual(foo.paths,["/dev/foo","/trees/foo"]);
    assert.deepEqual(foo.relations,["我的","本地检出","已纳管"]);
    assert.equal(result.repositories.find(r=>r.fullName==="/dev/local")!.url,"");
    await read();assert.equal(f.get(),1);
    f.advance();await read();assert.equal(f.get(),2);
    await read(true);assert.equal(f.get(),3);
  }finally{f.db.close();}
});

test("GitHub 失败仅回放相同账号的公开快照；更换账号、重启、失去权限不会复用旧私有元数据",async()=>{
  const f=fixture();
  try{
    const read=createRepoIndex(f.db,f.readers);
    const first=await read();assert.ok(first.repositories.some(r=>r.visibility==="private"));
    const snapshots=f.db.prepare("SELECT payload FROM opc_repo_inventory_snapshots").all();
    assert.ok(!snapshots.some(row=>String(row.payload).includes("alice/secret")));
    f.offline();
    const failed=await read(true);
    assert.equal(failed.sources[0].status,"partial");
    assert.equal(failed.sources[0].asOf,first.sources[0].asOf);
    assert.ok(!failed.repositories.some(r=>r.visibility==="private"));
    const reboot=await createRepoIndex(f.db,f.readers)();
    assert.deepEqual(reboot.repositories,failed.repositories);
    f.switch();
    const switched=await read();
    assert.equal(switched.sources[0].status,"unavailable");
    assert.ok(!switched.repositories.some(r=>r.relations.includes("我的")));
    assert.ok(switched.repositories.some(r=>r.relations.includes("本地检出")));
  }finally{f.db.close();}
});

test("扫描真实 Git 根目录与外置 worktree，远端来源只保留 owner/repo；无 GitHub 的本地仓可独立识别",async()=>{
  const base=await mkdtemp(join(tmpdir(),"opc-repo-index-"));
  try{
    const root=join(base,"projects"),repo=join(root,"app"),solo=join(root,"local"),linked=join(base,"external");
    await mkdir(root);await exec("git",["init","-q",repo]);await exec("git",["init","-q",solo]);await writeFile(join(repo,"readme"),"fixture");
    await exec("git",["-C",repo,"add","readme"]);await exec("git",["-C",repo,"-c","user.name=fixture","-c","user.email=test@example.invalid","commit","-qm","fixture"]);
    await exec("git",["-C",repo,"remote","add","origin","https://test:sample-value@github.com/Example/Fixture.git"]);
    await exec("git",["-C",repo,"worktree","add","--detach","-q",linked]);
    const {stdout}=await exec("python3",["-IB",fileURLToPath(new URL("../scripts/company-repos-index.py",import.meta.url))],{
      env:{...process.env,OPC_AGENT_HUB_DIR:join(base,"missing-hub"),OPC_REPO_ROOTS:root}});
    assert.doesNotMatch(stdout,/sample-value/);
    const rows=JSON.parse(stdout).rows as {fullName:string;paths:string[]}[];
    const remote=rows.find(r=>r.fullName==="Example/Fixture")!;
    assert.equal(remote.paths.length,2);assert.ok(remote.paths.some(p=>p.endsWith("/external")));
    assert.ok(rows.some(r=>r.fullName.endsWith("/projects/local")));
  }finally{await rm(base,{recursive:true,force:true});}
});
