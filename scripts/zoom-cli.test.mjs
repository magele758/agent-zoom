import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readGithubRepository } from "./zoom-github.mjs";

const exec = promisify(execFile);
const zoom = fileURLToPath(new URL("./zoom.mjs", import.meta.url));

test("the persistent agent entry works from another cwd and waits only for its own question", async t => {
  const root = await mkdtemp(join(tmpdir(), "kunlun-zoom-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = "test-submit-credential-for-localhost";
  const growth = new Map();
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    let response;
    if (req.url === "/api/zoom/stage-work?status=open&target=coding-agent&requestedAgent=My-Agent") response = {items:[{id:"requested-only"}]};
    else if (req.url === "/api/zoom/tasks") response = { id: "native-1", ...input };
    else if (req.url === "/api/zoom/projects") {
      response = req.method === "POST" ? { project: { ...input, repositories: [] }, created: true } : { projects: [] };
    }
    else if (req.url === "/api/zoom/tasks/native-1/messages") response = { id: "question-2", ...input };
    else if (req.url === "/api/zoom/tasks/native-1/feedback?after=0") {
      response = { cursor: 1, events: [{ seq: 1, questionId: "other", body: "an unrelated reply" }] };
    } else if (req.url === "/api/zoom/tasks/native-1/feedback?after=1") {
      response = { cursor: 2, events: [{ seq: 2, questionId: "question-2", body: "use option B", choice: "B" }] };
    } else if (req.url === "/api/zoom/tasks/native-1/feedback?after=2") {
      response = { cursor: 2, completed: true, events: [] };
    } else if (req.url === "/api/zoom/growth/events") {
      assert.equal(req.method, "POST");
      if (!input.reference) {
        res.statusCode = 400;
        response = { message: "来源不能为空" };
      } else {
        response = { event: input, created: !growth.has(input.eventId) };
        growth.set(input.eventId, input);
      }
    } else if (req.url === "/api/zoom/growth?" + new URLSearchParams({ product: "OPC OS & Sandbox" })) {
      assert.equal(req.method, "GET");
      response = { product: "OPC OS & Sandbox", eventCount: growth.size };
    } else if (req.url === "/api/opc/opportunities" && req.method === "POST") {
      response = {id:"from-cli", ...input};
    } else if (req.url === "/api/opc/opportunities?" + new URLSearchParams({project:"Tools/Parser"})) {
      assert.equal(req.method,"GET");
      response = {opportunities:[{id:"from-cli"}]};
    } else if (req.url === "/api/opc/business/trials/fixture/evidence") {
      assert.equal(req.method, "POST");
      response = input;
    } else if (req.url === "/api/workflows") response = input;
    else throw new Error("Unexpected API route: " + req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const origin = "http://127.0.0.1:" + server.address().port;
  const project = join(root, "other-project");
  const credentials = join(root, "submit.env");
  await mkdir(project);
  await writeFile(credentials, `KUNLUN_URL=${origin}\nWORKFLOW_SUBMIT_TOKEN=${token}\n`, { mode: 0o600 });
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config") };
  for (const key of ["KUNLUN_URL", "WORKFLOW_SUBMIT_TOKEN", "HFLOW_WORKER", "KUNLUN_WORKFLOW_WORKER"]) delete env[key];
  async function call(...args) {
    const { stdout } = await exec(process.execPath, [zoom, ...args], { cwd: project, env, timeout: 6000 });
    return JSON.parse(stdout);
  }
  await call("connect", credentials);
  assert.equal((await call("stage","list","--agent","My-Agent","--via","coding-agent","--status","open")).items[0].id,"requested-only");
  assert.deepEqual(await call("project", "add", "新产品"), { project: { name: "新产品", repositories: [] }, created: true });
  assert.deepEqual(await call("project", "list"), { projects: [] });
  assert.equal((await call("inbox")).url, origin + "/#inbox");
  const config = join(env.XDG_CONFIG_HOME, "kunlun", "zoom.json");
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  assert.equal((await readFile(config, "utf8")).includes(token), false);
  const task = await call("start", "Fix retries", "--source", "agent-a", "--task", "thread-42", "--stage", "design");
  assert.equal(task.folder, "other-project");
  assert.equal(task.stage, "design");
  const asked = await call("ask", task.id, "Which?", "--id", "round-1", "--choice", "A", "--choice", "B", "--wait");
  assert.deepEqual(asked.message.choices, ["A", "B"]);
  assert.equal(asked.message.requiresApproval, undefined);
  const approval = await call("ask", task.id, "确认此版本？", "--id", "signoff-r2", "--approval", "--claim", "stage-claim");
  assert.equal(approval.requiresApproval, true);
  assert.equal(approval.claimId, "stage-claim");
  assert.equal(asked.feedback.cursor, 2);
  assert.deepEqual(asked.feedback.events.map(event => event.questionId), ["question-2"]);
  const previous = await call("replies", task.id, "--question", "question-2");
  assert.equal(previous.events[0].body, "use option B");
  const closed = await call("replies", task.id, "--question", "missing", "--wait", "--timeout", "60");
  assert.equal(closed.completed, true);
  assert.deepEqual(closed.events, []);
  const first = await call("update", task.id, "tests passed");
  assert.equal((await call("update", task.id, "tests passed")).eventId, first.eventId);
  assert.equal((await call("done", task.id, "accepted")).kind, "completed");
  const goal = await call("goal", "Delegate", "--request-id", "delegated-1", "--folder", "A/B", "--stage", "testing");
  assert.equal(goal.folder, "A/B");
  assert.equal(goal.stage, "testing");
  assert.equal(goal.goal, "Delegate");
  const mapped = await call("goal","Bound task","--request-id","map-1","--project","Tools/Parser");
  assert.equal(mapped.projectKey,"Tools/Parser");
  assert.equal(mapped.folder,"Tools/Parser");
  const candidate = {project:"Tools/Parser",sourceId:"thread/reuse-1",capabilityRefs:["fixture-cap"]};
  const submitted = exec(process.execPath, [zoom, "opportunity", "add", "-"], {cwd:project,env,timeout:6000});
  submitted.child.stdin.end(JSON.stringify(candidate));
  assert.deepEqual(JSON.parse((await submitted).stdout), {id:"from-cli",...candidate});
  assert.equal((await call("opportunity","list","--project","Tools/Parser")).opportunities[0].id,"from-cli");
  const observation = {eventId:"draft-1",kind:"observation",note:"field missing",reference:"draft fixture"};
  const report = exec(process.execPath,[zoom,"business","evidence","fixture","-"],{cwd:project,env,timeout:6000});
  report.child.stdin.end(JSON.stringify(observation));
  assert.deepEqual(JSON.parse((await report).stdout), observation);

  const event = { product: "OPC OS & Sandbox", customerId: "A", kind: "acquired", eventId: "from-form",
    at: "2026-01-03T09:30:00Z", reference: "signup-2", channel: "社区" };
  const eventFile = join(project, "signup.json");
  await writeFile(eventFile, JSON.stringify(event));
  assert.deepEqual(await call("growth", "record", eventFile), { event, created: true });
  const fromStdin = exec(process.execPath, [zoom, "growth", "record", "-"], { cwd: project, env, timeout: 6000 });
  fromStdin.child.stdin.end(JSON.stringify([event, { ...event, eventId: "rejected", reference: "" }, { ...event, eventId: "later" }]));
  await assert.rejects(fromStdin, error => {
    const batch = JSON.parse(error.stdout);
    assert.deepEqual(batch.results, [{ product: event.product, eventId: event.eventId, created: false }]);
    assert.deepEqual(batch.failed, { index: 1, eventId: "rejected", message: "来源不能为空" });
    assert.equal(batch.remaining, 1);
    return error.code === 1;
  });
  assert.equal((await call("growth", "report", event.product)).eventCount, 1);
});

test("sync reads only the selected public repository, with separate open counts and recent records", async () => {
  const url = "https://github.com/Acme/Test";
  const repo = { nameWithOwner: "Acme/Test", owner: { login: "Acme" }, url, visibility: "PUBLIC",
    isFork: true, description: "An upstream fork" };
  const at = "2026-03-07T12:00:00Z";
  const queries = [];
  const read = async (query, owner, name) => {
    assert.equal(owner, "acme");
    assert.equal(name, "test");
    assert.match(query, /^query\(/);
    queries.push(query);
    return { ...repo, latestRelease: { tagName: "v4", url: url + "/releases/tag/v4", publishedAt: at },
      issues: { totalCount: 50, nodes: [{ number: 2, title: "Issue", url: url + "/issues/2", updatedAt: at }] },
      pullRequests: { totalCount: 3, nodes: [{ number: 6, title: "PR", url: url + "/pull/6", updatedAt: at }] } };
  };
  const result = await readGithubRepository("acme/test", read);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0], /issues\(|pullRequests\(/);
  assert.match(queries[1], /issues\([^)]*states:OPEN/);
  assert.match(queries[1], /pullRequests\([^)]*states:OPEN/);
  assert.deepEqual([result.openIssues, result.openPullRequests, result.fork], [50, 3, true]);
  assert.deepEqual(result.items.map(item => [item.kind, item.url]), [["pull", url + "/pull/6"], ["issue", url + "/issues/2"]]);
  assert.equal(result.latestRelease.tag, "v4");
  const unreleased = await readGithubRepository("acme/test", async (...args) => ({ ...await read(...args), latestRelease: null }));
  assert.equal(unreleased.latestRelease, null);
  for (const invalid of [{ ...repo, visibility: "PRIVATE" }, { ...repo, owner: { login: "someone" } }]) {
    let reads = 0;
    await assert.rejects(readGithubRepository("acme/test", async () => { reads++; return invalid; }));
    assert.equal(reads, 1);
  }
  await assert.rejects(readGithubRepository("acme/../other", () => assert.fail("invalid repository made a request")), /owner\/repo/);
});

test("opc-os start accepts --project alias and OPC_URL while rejecting conflicting folder flags", async t => {
  const dir = await mkdtemp(join(tmpdir(), "zoom-cli-alias-"));
  const token = "test-submit-credential-for-alias";
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "alias-task-1", ...input }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    return rm(dir, { recursive: true, force: true });
  });
  const env = { ...process.env, OPC_URL: origin, WORKFLOW_SUBMIT_TOKEN: token, XDG_CONFIG_HOME: dir };
  delete env.KUNLUN_URL;
  const run = args => exec(process.execPath, [zoom, ...args], { cwd: dir, env });
  const started = JSON.parse((await run(["start", "验证项目别名", "--source", "grok", "--task", "alias-1", "--project", "电商/库存"])).stdout);
  assert.equal(started.folder, "电商/库存");
  await assert.rejects(
    run(["start", "冲突目录", "--source", "grok", "--task", "alias-2", "--folder", "甲", "--project", "乙"]),
    /不能指定不同目录/,
  );
});
