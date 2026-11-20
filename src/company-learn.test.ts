import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { addCompanyLearnRoutes } from "./server/company-learn.ts";
import { readJournalDay } from "./server/company-journal.ts";
import { ApiError } from "./server/logic.ts";

const endpoint = "/api/zoom/company/learn";
const day = "2026-11-13";
const article =
  "# 今日信息\n\n## 第一篇\n\n第一篇真实段落。\n\n### 附录\n\n保留代码。\n\n## 第二篇\n\n第二篇的正文。\n";
const writer = `
  import { readFile } from "node:fs/promises";
  export async function writeLearningClip(clip,{configPath,request}) {
    const setting=JSON.parse(await readFile(configPath,"utf8"));
    const response=await request(new URL(setting.endpoint),{method:"POST",headers:{authorization:"Bearer "+setting.token},body:JSON.stringify(clip)});
    if(!response.ok) return {ok:false,error:"无法保存剪藏。"};
    return {ok:true,...await response.json()};
  }
`;

test("学习库只向用户返回已配对资料。发送一节原文以相同回链去重，可安全返回文章位置", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "opc-learn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    journal: process.env.OPC_DAILY_REVIEW_DIR,
    origin: process.env.KUNLUN_URL,
    preview: process.env.KUNLUN_PREVIEW,
  };
  process.env.OPC_DAILY_REVIEW_DIR = dir;
  process.env.KUNLUN_URL = "http://127.0.0.1:52328";
  delete process.env.KUNLUN_PREVIEW;
  t.after(() => {
    for (const [name, value] of Object.entries({
      OPC_DAILY_REVIEW_DIR: env.journal,
      KUNLUN_URL: env.origin,
      KUNLUN_PREVIEW: env.preview,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const token = "local-transport-fixture-not-a-user-credential";
  const configPath = join(dir, "pairing.json"),
    writerPath = join(dir, "clip.mjs");
  const pairedOrigin = "http://100.108.4.25:4317";
  await writeFile(configPath, JSON.stringify({ endpoint: pairedOrigin + "/api/learn/clips", token }), {
    mode: 0o600,
  });
  await writeFile(writerPath, writer);
  await writeFile(join(dir, day + ".md"), article);
  const originals = await readJournalDay(dir, day);
  const posted = new Set<string>();
  let writes = 0,
    lastBody = "";
  const app = new Hono();
  app.onError((e, c) => c.json({ message: e.message }, e instanceof ApiError ? (e.status as 400) : 500));
  const probe = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, pairedOrigin);
    if (init?.method === "POST") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer " + token);
      assert.equal(url.pathname, "/api/learn/clips");
      const payload = JSON.parse(String(init.body));
      const body = JSON.stringify(payload);
      const id = "clip-" + createHash("sha256").update(body).digest("hex").slice(0, 24);
      const duplicate = posted.has(body);
      posted.add(body);
      lastBody = body;
      writes++;
      return Response.json({
        readerUrl: "/learn?tab=library&clip=" + id,
        reviewUrl: "/learn?tab=knowledge&clip=" + id,
        duplicate,
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    switch (url.pathname) {
      case "/api/learn/library":
        return Response.json({ documents: [{ id: "web-example", title: "材料", kind: "web" }] });
      case "/api/learn/clips":
        return Response.json({
          clips: [{ id: "clip-0123456789abcdef01234567", title: "已剪藏", content: "仅原服务保留正文" }],
        });
      case "/api/learn/sessions":
        return Response.json([
          { id: "session-example", title: "实战课", completed: false, updatedAt: "2026-11-13T01:45:00Z" },
        ]);
      default:
        assert.fail("unexpected path " + url.pathname);
    }
  }) as typeof fetch;
  addCompanyLearnRoutes(
    app,
    (c) => {
      if (c.req.header("x-test-local") !== "human") throw new ApiError(401, "auth", "forbidden");
    },
    { configPath, writerPath, fetch: probe },
  );
  assert.equal((await app.request(endpoint)).status, 401);
  const headers = { "x-test-local": "human", "content-type": "application/json" };
  const catalog = await (await app.request(endpoint, { headers })).json();
  assert.equal(catalog.canClip, true);
  assert.equal(catalog.homeUrl, pairedOrigin + "/learn");
  assert.deepEqual(
    catalog.documents.map((d: { kind: string }) => d.kind),
    ["clip", "web"],
  );
  assert.equal(catalog.sessions[0].url, pairedOrigin + "/learn?session=session-example");
  assert.doesNotMatch(JSON.stringify(catalog), /仅原服务保留正文|credential/);
  assert.equal(writes, 0);
  const selected = originals.excerpts.find((item) => item.title === "第一篇")!;
  const post = (body: unknown, extra = {}) =>
    app.request(endpoint + "/clip", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ day, articleId: selected.id, content: "浏览器不能伪造来源" })).status, 400);
  assert.equal((await post({ day, articleId: selected.id }, { origin: "http://127.0.0.1:1234" })).status, 403);
  assert.equal(writes, 0);
  const first = await (await post({ day, articleId: selected.id, question: "想验证什么？" })).json();
  const again = await (await post({ day, articleId: selected.id, question: "想验证什么？" })).json();
  assert.equal(first.id, again.id);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(posted.size, 1);
  const payload = JSON.parse(lastBody);
  assert.equal(payload.content, "## 第一篇\n\n第一篇真实段落。\n\n### 附录\n\n保留代码。\n");
  assert.equal(payload.note, "想验证什么？");
  const source = new URL(payload.url);
  assert.equal(source.origin, "http://127.0.0.1:52328");
  assert.equal(source.pathname, "/ideas-source");
  const returned = await app.request(source);
  assert.equal(returned.status, 303);
  assert.equal(returned.headers.get("location"), "/#ideas?day=" + day + "&section=" + selected.id);
  const full = await (await post({ day, articleId: originals.article.id })).json();
  assert.notEqual(full.id, first.id);
  assert.equal(JSON.parse(lastBody).content, article);
});

test("配对不可用时学习入口独立失败，不读取任何原文", async () => {
  const app = new Hono();
  const fixturePath = join(tmpdir(), "no-such-learn-pairing-" + process.pid);
  addCompanyLearnRoutes(app, () => {}, {
    configPath: fixturePath,
    fetch: async () => {
      throw Error("network unavailable");
    },
  });
  const result = await app.request(endpoint);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    available: false,
    canClip: false,
    documents: [],
    sessions: [],
    reason: "暂时无法连接 Learn Agent。可以继续阅读日记与派研发任务。",
  });
});
