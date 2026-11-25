import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ActivityIndex, IndexedAgent, IndexedRepo, RepoContent } from "./activity-index-types.ts";
import { joinActivity } from "./server/company-activity-index.ts";
import { repoContent } from "./server/company-repo-content.ts";
import { createApp } from "./server/http.ts";
import { openStore } from "./server/logic.ts";

const exec = promisify(execFile);
const base = "/api/opc/activity-index";
const src = { name: "fixture", status: "ok" as const, asOf: null, detail: "" };
const repo = (fullName: string, paths: string[]): IndexedRepo => ({
  fullName,
  paths,
  url: fullName.startsWith("/") ? "" : "https://github.com/" + fullName,
  relations: [],
  managed: [],
  visibility: "unknown",
  pushedAt: null,
  language: null,
  description: "",
  defaultBranch: null,
});
const agent = (workspace: string | null, repository: string | null = null): IndexedAgent => ({
  id: "session",
  provider: "codex",
  workspace,
  repository,
  state: "recent",
  label: "fixture",
  sources: [],
  updatedAt: null,
  title: null,
  what: null,
  taskWhat: null,
});

test("索引按最长仓库根目录归属会话，保留已确认来源并区分相似目录名", () => {
  const result = joinActivity(
    {
      agents: [
        agent("/repos/app/modules/tool/src"),
        agent("/repos/application"),
        agent("/repos/app/build", "other/managed"),
        agent(null),
      ],
      sources: [src],
    },
    { repositories: [repo("a/root", ["/repos/app"]), repo("a/nested", ["/repos/app/modules/tool"])], sources: [] },
    src,
  );
  assert.deepEqual(
    result.agents.map((a) => a.repository),
    ["a/nested", null, "other/managed", null],
  );
});

test("正式入口收录授权仓，匿名及仅带 agent 凭据不能读索引、搜索或刷新；本地 HEAD 与远端文件证据可查", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "opc-index-http-")));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const root = join(dir, "projects"),
    workspace = join(root, "Notebook"),
    bin = join(dir, "bin");
  await mkdir(bin);
  await mkdir(root);
  await exec("git", ["init", "-q", workspace]);
  await exec("git", ["-C", workspace, "remote", "add", "origin", "https://github.com/Fixture/Notebook.git"]);
  await writeFile(join(workspace, "README.md"), "# 已提交的说明\n");
  await writeFile(join(workspace, "design #1.txt"), "abc literal-needle abc\n");
  await exec("git", ["-C", workspace, "add", "."]);
  await exec("git", [
    "-C",
    workspace,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const head = (await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim();
  const outside = join(dir, "outside"),
    paneCwd = join(dir, "pane-cwd");
  await exec("git", ["clone", "-q", workspace, outside]);
  await exec("git", ["-C", outside, "remote", "set-url", "origin", "git@github.com:Fixture/OnlyInPane.git"]);
  await mkdir(join(outside, "subdir"));
  await symlink(join(outside, "subdir"), paneCwd);
  const other = join(dir, "same-parent-but-no-local-session");
  await exec("git", ["init", "-q", other]);
  await writeFile(join(workspace, "README.md"), "未提交的本机内容");
  await writeFile(join(workspace, "untracked.txt"), "literal-needle");
  const fingerprint = "1".repeat(40),
    blob = "2".repeat(40);
  const ghScript = `const a=process.argv.slice(2), q=a.find(s=>s.startsWith("query="))||"";
const print=x=>process.stdout.write(typeof x==="string"?x:JSON.stringify(x));
if(a[0]==="config")print("fixture");
else if(q.includes("ownerAffiliations")||q.includes("repositoriesContributedTo")){
 const nodes=q.includes("[OWNER]")?["Notebook","Cloud"].map(name=>({nameWithOwner:"Fixture/"+name,url:"https://github.com/Fixture/"+name,visibility:"PRIVATE",description:"fixture",defaultBranchRef:{name:"main"},pushedAt:null,primaryLanguage:null})):[];
 print([{data:{viewer:{login:"fixture",repos:{nodes,pageInfo:{hasNextPage:false}}}}}]);
}else if(q.includes("defaultBranchRef")&&a.includes("name=Cloud"))
 print({data:{repository:{defaultBranchRef:{target:{oid:"${fingerprint}",tree:{entries:[{name:"README.md",type:"blob",oid:"${blob}"}]}}}}}});
else if(a.includes("repos/Fixture/Cloud/git/blobs/${blob}"))print({encoding:"base64",content:"Y2xvdWQgcmVhZG1l"});
else if(a[0]==="search")print([{path:"README.md",url:"https://github.com/Fixture/Cloud/blob/${fingerprint}/README.md"},{path:"other",url:"https://github.com/Other/Repository/blob/${fingerprint}/other"}]);
else process.exitCode=1;`;
  await writeFile(join(bin, "gh"), "#!" + process.execPath + "\n" + ghScript, { mode: 0o755 });
  const pane = { agent: "grok", state: "live", status: "working" };
  async function setTerminals(terminals: { address: string; cwd: string }[]) {
    const data = JSON.stringify({ terminals: terminals.map((row) => ({ ...pane, ...row })) });
    await writeFile(
      join(bin, "hc"),
      "#!" + process.execPath + "\nprocess.stdout.write(" + JSON.stringify(data) + ")",
      { mode: 0o755 },
    );
  }
  await setTerminals([
    { address: "p1", cwd: paneCwd },
    { address: "p2", cwd: workspace },
    { address: "remote/p3", cwd: other },
  ]);
  await writeFile(join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const overrides: Record<string, string> = {
    OPC_REPO_ROOTS: root,
    OPC_AGENT_HUB_DIR: join(dir, "hub"),
    OPC_HUB_URL: "http://127.0.0.1:1",
    HC_BIN: join(bin, "hc"),
    PATH: bin + ":" + process.env.PATH,
    WORKFLOW_SUBMIT_TOKEN: "this-local-test-token-is-not-a-user-cookie",
  };
  for (const [key, value] of Object.entries(overrides)) {
    const initial = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (initial === undefined) delete process.env[key];
      else process.env[key] = initial;
    });
  }
  const store = openStore(join(dir, "fixture.db"));
  t.after(() => store.db.close());
  const { app } = createApp(store, { activityIndexEnabled: true });
  const operator = store.localUser();
  const roomId = store.localRoom();
  const enrollment = store.enroll(store.createJoinCode(operator, roomId).code, "fixture", "cli", "review", 1);
  assert.equal(store.agentByToken(enrollment.token)?.type, "agent");
  const credentials: Record<string, string>[] = [
    {},
    { authorization: "Bearer " + overrides.WORKFLOW_SUBMIT_TOKEN },
    { authorization: "Bearer " + enrollment.token },
  ];
  for (const headers of credentials) {
    for (const [route, method] of [
      ["", "GET"],
      ["/content?repo=Fixture%2FNotebook", "GET"],
      ["/search?repo=Fixture%2FNotebook&q=test", "GET"],
      ["/refresh", "POST"],
    ]) {
      assert.equal((await app.request(base + route, { method, headers })).status, 401);
    }
  }
  const cookie = (await app.request("/api/me")).headers.get("set-cookie")!.split(";")[0];
  const get = (path: string) => app.request(base + path, { headers: { cookie } });
  const direct = "/content?repo=" + encodeURIComponent("Fixture/OnlyInPane");
  const outsideContent = (await (await get(direct)).json()) as RepoContent;
  assert.equal(outsideContent.readme!.text, "# 已提交的说明\n");
  assert.equal(outsideContent.ref, head);
  const response = await get("");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const index = (await response.json()) as ActivityIndex;
  assert.deepEqual(index.repositories.map((r) => r.fullName).sort(), [
    "Fixture/Cloud",
    "Fixture/Notebook",
    "Fixture/OnlyInPane",
  ]);
  assert.equal(index.agents.find((a) => a.workspace === paneCwd)?.repository, "Fixture/OnlyInPane");
  assert.deepEqual(index.repositories.find((r) => r.fullName === "Fixture/Notebook")!.paths, [workspace]);
  assert.equal((await get("/content?repo=" + encodeURIComponent(other))).status, 404);
  const outsideSearch = await (await get("/search?repo=Fixture%2FOnlyInPane&q=literal-needle")).json();
  assert.deepEqual(
    outsideSearch.items.map((i: { path: string }) => i.path),
    ["design #1.txt"],
  );
  assert.equal((await get("/content?repo=not-in-index")).status, 404);
  assert.equal((await get("/search?repo=Fixture%2FNotebook&q=")).status, 400);
  const local = (await (await get("/content?repo=Fixture%2FNotebook")).json()) as RepoContent;
  assert.equal(local.source, "本地已提交版本");
  assert.equal(local.ref, head);
  assert.equal(local.readme!.text, "# 已提交的说明\n");
  assert.ok(local.files.find((f) => f.name === "design #1.txt")!.url.endsWith("/design%20%231.txt"));
  assert.ok(!local.files.some((f) => f.name === "untracked.txt"));
  const search = await (await get("/search?repo=Fixture%2FNotebook&q=literal-needle")).json();
  assert.deepEqual(
    search.items.map((i: { path: string }) => i.path),
    ["design #1.txt"],
  );
  const cloud = (await (await get("/content?repo=Fixture%2FCloud")).json()) as RepoContent;
  assert.equal(cloud.source, "GitHub 默认分支");
  assert.equal(cloud.ref, fingerprint);
  assert.equal(cloud.readme!.text, "cloud readme");
  const cloudSearch = await (await get("/search?repo=Fixture%2FCloud&q=readme")).json();
  assert.deepEqual(
    cloudSearch.items.map((i: { path: string }) => i.path),
    ["README.md"],
  );
  const oldPath = join(workspace, "moved-project");
  await mkdir(oldPath);
  await assert.rejects(repoContent(repo("Fixture/Notebook", [oldPath])), /暂时无法读取/);
  await assert.rejects(repoContent(repo("Other/Name", [workspace])), /暂时无法读取/);
  await setTerminals([]);
  assert.equal((await get(direct)).status, 200);
  assert.equal((await app.request(base + "/refresh", { method: "POST", headers: { cookie } })).status, 200);
  assert.equal((await get(direct)).status, 404);
});
