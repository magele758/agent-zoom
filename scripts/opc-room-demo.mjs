import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "../src/server/http.ts";
import { openStore } from "../src/server/logic.ts";

// Use the installed Agent Home implementation against two disposable databases.
// Running a bot session returns fixture text and never contacts a model provider.
const browserCheck = process.argv.includes("--browser");
const checkout = resolve(
  process.argv.slice(2).find((value) => !value.startsWith("--")) ||
    fileURLToPath(new URL("../../../self-test-grounding/ppeng-agent-core", import.meta.url)),
);
const loadHome = (path) => import(pathToFileURL(join(checkout, path)).href);
const core = "packages/core/dist/";
const [{ SqliteStateStore }, { createBot }, { createChatSession }, { BotRoomService }, { botRoomsRoutes }] =
  await Promise.all([
    loadHome(core + "storage.js"),
    loadHome(core + "bots/index.js"),
    loadHome(core + "runtime/session-facade.js"),
    loadHome(core + "rooms/index.js"),
    loadHome("apps/daemon/dist/routes/bot-rooms.js"),
  ]);
const root = mkdtempSync(join(tmpdir(), "opc-agent-home-room-"));
const home = new SqliteStateStore(join(root, "home.db"));
const local = openStore(join(root, "opc.db"));
const facade = {
  store: home,
  runImageRetention: async () => {},
  wakeAllAutonomousSessions() {},
  wakeAgentSessions() {},
};
const owner = { userId: "opc-room-demo", tenantId: "test" };
const bots = ["需求核对测试员", "旁听测试员"].map((name) => createBot(facade, { name }));
for (const bot of bots) {
  const session = home.getSession(bot.canonicalSessionId);
  home.updateSession(session.id, { metadata: { ...session.metadata, ...owner } });
}
const speakers = [];
const rooms = new BotRoomService({
  store: home,
  createChatSession: (input) => createChatSession(facade, input),
  cancelSession() {},
  runSession: async (id) => {
    speakers.push(home.getSession(id).agentId);
    const text = speakers.length === 1 ? "待我答复：这次先验证哪个项目？" : "已记录，先验证测试项目。";
    home.appendMessage(id, "assistant", [{ type: "text", text }]);
    home.updateSession(id, { status: "idle" });
  },
});
const remote = rooms.create(owner, { title: "临时讨论", botIds: bots.map((b) => b.id) });
const routes = botRoomsRoutes({ store: home, rooms });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/bot-work/status") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ bots: bots.map((bot) => ({ bot: { id: bot.id, name: bot.name } })) }));
    }
    const route = routes.find((r) => r.method === req.method && r.pattern.replace(":id", remote.id) === url.pathname);
    if (!route) {
      res.writeHead(404);
      return res.end();
    }
    await route.handler({
      url,
      request: req,
      response: res,
      auth: { user: { id: owner.userId, tenantId: owner.tenantId } },
      requireParam: () => remote.id,
      readBody: async () => {
        let data = "";
        for await (const chunk of req) data += chunk;
        return JSON.parse(data);
      },
    });
  } catch (err) {
    res.writeHead(500);
    res.end();
    console.error(err.message);
  }
});
let browser, uiServer, browserOrigin, page;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.PPENG_BASE_URL = "http://127.0.0.1:" + server.address().port;
  delete process.env.PPENG_TOKEN;
  const { app, homeRooms } = createApp(local);
  if (browserCheck) {
    const { serveStatic } = await import("@hono/node-server/serve-static");
    assert.ok(existsSync("web/dist/index.html"), "请先运行 npm run build");
    app.use("/*", serveStatic({ root: "./web/dist" }));
  }
  const cookie = (await app.request("/api/me")).headers.get("set-cookie").split(";")[0];
  async function call(path, payload) {
    const response = await app.request(path, {
      method: payload ? "POST" : "GET",
      body: payload && JSON.stringify(payload),
      headers: { cookie, "content-type": "application/json" },
    });
    const value = await response.json();
    assert.ok(response.ok, value.message || path);
    return value;
  }
  const localRoom = local.createRoom(local.localUser(), "项目讨论", "", { project: "临时测试项目" });
  const base = "/api/opc/home-rooms";
  if (browserCheck) {
    const [{ serve }, { chromium }] = await Promise.all([import("@hono/node-server"), import("@playwright/test")]);
    uiServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await once(uiServer, "listening");
    browserOrigin = "http://127.0.0.1:" + uiServer.address().port;
    const chrome = process.env.CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) && { executablePath: chrome }) });
    page = await browser.newPage();
    await page.goto(browserOrigin + "/#home-room");
    await page.getByRole("button", { name: "关联房间和 Bot" }).click();
    await page.getByLabel("OPC OS 频道").selectOption(localRoom.id);
    await page.getByLabel("Agent Home 讨论房间").selectOption(remote.id);
    await page.getByLabel("接收消息的 Bot").selectOption(bots[0].id);
    await page.getByRole("button", { name: "保存关联" }).click();
    await page.getByRole("heading", { name: remote.title }).waitFor();
  }
  const binding = await call(base, { localRoom: localRoom.id, remoteRoom: remote.id, botId: bots[0].id });
  const message = { key: "demo:round-1", body: "请列出需要我确认的项目范围。" };
  const path = base + "/" + binding.id + "/messages";
  let sent;
  if (page) {
    await page.getByRole("textbox", { name: "发给 @" + bots[0].name }).fill(message.body);
    const saving = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "POST");
    await page.getByRole("button", { name: "发送到原房间" }).click();
    const response = await saving;
    sent = await response.json();
    message.key = response.request().postDataJSON().key;
  } else {
    sent = await call(path, message);
  }
  assert.equal(sent.state, "received");
  assert.equal((await call(path, message)).id, sent.id);
  async function waitForTurns(count) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await rooms.tick();
      const turns = rooms.turns(owner, remote.id);
      if (turns.length === count && turns.every((t) => t.status === "completed")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error("测试房间的会话没有按期结束");
  }
  await waitForTurns(1);
  await homeRooms.tick();
  const question = (await call("/api/zoom/messages")).messages.find((m) => m.pending && m.roomBinding === binding.id);
  assert.ok(question, "Bot 的问题应出现在 Zoom 待处理");
  const writeBack = "/api/zoom/tasks/" + encodeURIComponent(question.taskId) + "/replies";
  const answer = { questionId: question.id, body: "先验证测试项目。" };
  let reply;
  if (page) {
    await page.goto(browserOrigin + "/#inbox?filter=pending&message=" + encodeURIComponent(question.id));
    await page.getByRole("textbox", { name: "回复原任务" }).fill(answer.body);
    const saving = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith("/replies") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送回复" }).click();
    reply = await (await saving).json();
    await page.getByRole("link", { name: "打开原讨论" }).click();
    await page.getByRole("heading", { name: remote.title }).waitFor();
  } else {
    reply = await call(writeBack, answer);
  }
  assert.equal(reply.state, "received");
  assert.equal((await call(writeBack, answer)).id, reply.id);
  await waitForTurns(2);
  await homeRooms.tick();
  const messages = rooms.messages(owner, remote.id).messages;
  const original = messages.find((m) => m.sender.type === "bot" && m.text.startsWith("待我答复"));
  const continued = messages.find((m) => m.id === reply.remoteId);
  assert.equal(continued.replyTo.messageId, original.id);
  assert.equal(continued.replyTo.botId, bots[0].id);
  assert.deepEqual(speakers, [bots[0].id, bots[0].id]);
  assert.equal((await call(path)).posts.length, 4);
  assert.equal((await call("/api/zoom/messages")).messages.filter((m) => m.pending).length, 0);
  console.log(
    "通过：Agent Home 真实房间路由、SQLite、具名 Bot、两轮对话；原帖进入 Zoom，答复引用同一条消息；重复请求保持两轮。",
  );
  if (page) {
    await page.getByText("已记录，先验证测试项目。", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    console.log("通过：Chrome 页面绑定、点名发言、Zoom 答复、打开原讨论及手机宽度布局。");
  }
  console.log("测试身份与房间目录为临时数据，Bot 推理由固定文本模拟。");
} finally {
  await browser?.close();
  uiServer?.closeAllConnections();
  uiServer?.close();
  server.closeAllConnections();
  server.close();
  local.db.close();
  home.db.close();
  rmSync(root, { recursive: true, force: true });
}
