// Isolated browser regression for index drill-downs and routing a decision to an executor.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

const directory = await mkdtemp(join(tmpdir(), "opc-index-browser-"));
let browser;
let server;
try {
  await build({ build: { outDir: directory }, logLevel: "warn" });
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const name = path === "/" ? "/index.html" : path;
      const body = await readFile(join(directory, name));
      res.setHeader(
        "Content-Type",
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp" }[
          extname(name)
        ] ?? "application/octet-stream",
      );
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const executablePath =
    process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, ...(existsSync(executablePath) ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1250, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const at = new Date().toISOString();
  const repo = {
    fullName: "owner/example",
    url: "https://github.com/owner/example",
    visibility: "private",
    description: "项目仓",
    relations: ["我的", "已纳管"],
    paths: ["/work/example"],
    language: "TypeScript",
    pushedAt: at,
    defaultBranch: "main",
    managed: [{ product: "产品甲", project: "项目甲" }],
  };
  const local = {
    ...repo,
    fullName: "/work/local-only",
    url: "",
    managed: [],
    paths: ["/work/local-only"],
    relations: ["本地检出"],
    visibility: "unknown",
  };
  const agent = {
    id: "fixture-session",
    provider: "测试执行器",
    label: "整理资料",
    state: "working",
    sources: ["Herdr"],
    workspace: "/work/example",
    repository: repo.fullName,
    updatedAt: at,
  };
  const index = {
    agents: [agent],
    repositories: [repo, local],
    sources: [{ name: "GitHub", status: "partial", asOf: at, detail: "一处暂不可用" }],
  };
  const channelRoom = {
    id: "local-room",
    org_id: "local-org",
    name: "产品维护",
    topic: "",
    currentTopic: "",
    general: true,
    archived: false,
    direct: false,
    project: "产品甲",
    directories: [],
    branch: "",
    created_at: at,
  };
  const task = {
    id: "local-task",
    title: "开发通知功能",
    body: "核对发布准备",
    status: "working",
    acceptance: "保存测试依据",
    claims: [],
    updatedAt: at,
    evidence: [{ id: "test", handle: "tester", kind: "test", body: "验收依据文本", createdAt: at }],
  };
  const message = {
    id: "review-original",
    origin: "external",
    kind: "question",
    source: "维护方",
    at,
    folder: "产品甲/项目甲",
    taskId: "seed",
    taskTitle: "确认依赖",
    body: "选择可采用的版本？",
    action: { kind: "reply" },
    choices: ["v1", "v2"],
    pending: true,
  };
  let preference = null;
  const items = [];
  const messages = [message];
  const submissions = [];
  let searches = 0;
  const ideaId = "11111111-2222-4333-8444-555555555555";
  const bindingId = "22222222-3333-4444-8555-666666666666";
  const postId = "33333333-4444-4555-8666-777777777777";
  const roomBinding = {
    id: bindingId,
    localRoom: "local-room",
    remoteRoom: "remote-room",
    project: "产品甲",
    roomTitle: "产品讨论室",
    botId: "real-bot-id",
    botName: "项目管家",
    problem: null,
  };
  const roomPosts = [];
  const chatMessages = [];
  let chatLinks = [];
  let stageWorkItem = {
    id: "stage-reconcile-1",
    requestId: "req-stage-1",
    product: "",
    companyItemId: ideaId,
    stage: "idea",
    templateId: "idea-check",
    title: "核实想法验证方案",
    goal: "核实来源",
    inputs: "日记原文",
    deliverable: "结论",
    acceptance: "附链接",
    target: "coding-agent",
    requestedAgent: "grok-cli",
    createdAt: at,
    status: "reconcile",
    owner: "grok-cli",
    leaseUntil: "2020-03-04T01:00:00.000Z",
    evidence: [],
    messageId: message.id,
  };
  const companyData = {
    information: [{ id: "note-1", title: "日记摘录", body: "用固定样例复现字段校验", reference: "daily-review-learning/2026-11-20.md › 研发" }],
    ideas: [{ id: ideaId, title: "日记到讨论室双向定位", body: "验证想法与房间讨论互相跳转", reference: "", sources: ["note-1"], products: ["产品甲"] }],
    products: ["产品甲"],
    projects: [{ product: "产品甲", name: "项目甲", repos: [] }],
    referrals: [],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      path = u.pathname;
    let data;
    if (path === "/api/me")
      data = {
        user: { id: "a", name: "test" },
        orgs: [{ id: "local-org", name: "公司", role: "owner" }],
        rooms: [channelRoom],
        agents: [],
      };
    else if (path === "/api/rooms/local-room")
      data = { room: channelRoom, members: { agents: [], users: [] }, messages: [], tasks: [task], locks: [] };
    else if (path === "/api/workflows/enabled") data = { enabled: true };
    else if (path === "/api/opc/business/catalog") data = { lines: [] };
    else if (path === "/api/zoom/messages") data = { messages, products: ["产品甲"] };
    else if (path === "/api/opc/activity-index" || path === "/api/opc/activity-index/refresh") data = index;
    else if (path === "/api/opc/activity-index/content")
      data = {
        fullName: u.searchParams.get("repo"),
        ref: "f00ba4",
        files: [{ name: "main.ts", url: "", directory: false }],
        source: "Git commit",
        readme: { text: "<script>private</script>", url: "", truncated: false },
        issuesUrl: "",
        pullsUrl: "",
        note: "",
      };
    else if (path === "/api/opc/activity-index/search") {
      searches++;
      assert.equal(u.searchParams.get("q"), "find");
      data = { items: [{ path: "main.ts", url: "", line: 7 }], source: "本地 HEAD", note: "" };
    } else if (path === "/api/opc/delegations/agents")
      data = { agents: [{ handle: "grok-cli", runtime: "Grok", online: true }] };
    else if (path === "/api/zoom/stage-home/bots")
      data = { available: true, bots: [{ id: "real-bot-id", name: "项目管家" }] };
    else if (path === "/api/opc/delegations/preference") {
      preference = req.postDataJSON();
      data = preference;
    } else if (path === "/api/opc/delegations" && req.method() === "GET") data = { items, preference };
    else if (path === "/api/opc/delegations" && req.method() === "POST") {
      const body = req.postDataJSON();
      submissions.push(body);
      const item = {
        id: "delegation-" + items.length,
        workId: "order-" + items.length,
        workMessageId: "work-msg-" + items.length,
        status: "queued",
        sourceId: body.messageId ?? body.operation.key,
        title: body.operation?.title ?? message.taskTitle,
        sourceHref: body.operation?.href ?? "#inbox?message=" + message.id,
        method: body.method,
        result: "",
        evidence: [],
        requiresApproval: !!body.messageId,
      };
      items.push(item);
      if (body.messageId) {
        message.delegation = item;
        message.pending = false;
      }
      data = item;
    } else if (path === "/api/zoom/company") {
      data = companyData;
    } else if (path === "/api/zoom/company/days") {
      data = { days: [] };
    } else if (path === "/api/zoom/company/learn") {
      data = { available: false, reason: "test" };
    } else if (path === "/api/opc/opportunities") {
      data = { projects: [], opportunities: [] };
    } else if (path === "/api/opc/home-chat/overview") {
      data = {
        available: true,
        origin: "http://127.0.0.1:37070",
        rooms: [
          {
            id: "chat-room-1",
            title: "OPC 总控群",
            status: "active",
            botIds: ["real-bot-id", "arch-bot-id"],
            hostBotId: "real-bot-id",
            replyMode: "coordinator",
          },
        ],
        bots: [
          { id: "real-bot-id", name: "项目管家" },
          { id: "arch-bot-id", name: "架构师" },
        ],
        links: chatLinks,
      };
    } else if (path === "/api/opc/home-chat/links" && req.method() === "PUT") {
      const body = req.postDataJSON();
      chatLinks = [...chatLinks.filter((l) => l.scopeKey !== body.scopeKey), { ...body, roomTitle: body.roomTitle ?? "OPC 总控群", updatedAt: at }];
      data = { links: chatLinks };
    } else if (path === "/api/opc/home-chat/links" && req.method() === "DELETE") {
      const key = u.searchParams.get("scopeKey");
      chatLinks = chatLinks.filter((l) => l.scopeKey !== key);
      data = { links: chatLinks };
    } else if (path === "/api/opc/home-chat/rooms/chat-room-1/messages" && req.method() === "GET") {
      data = {
        room: {
          id: "chat-room-1",
          title: "OPC 总控群",
          status: "active",
          botIds: ["real-bot-id", "arch-bot-id"],
          hostBotId: "real-bot-id",
          replyMode: "coordinator",
        },
        messages: chatMessages,
        hasMore: false,
        nextCursor: null,
        bots: [
          { id: "real-bot-id", name: "项目管家" },
          { id: "arch-bot-id", name: "架构师" },
        ],
        turns: [],
      };
    } else if (path === "/api/opc/home-chat/rooms/chat-room-1/messages" && req.method() === "POST") {
      const body = req.postDataJSON();
      const msg = {
        id: "chat-msg-" + (chatMessages.length + 1),
        roomId: "chat-room-1",
        seq: chatMessages.length + 1,
        text: body.text,
        createdAt: at,
        sender: { type: "user", id: "founder", name: "创始人" },
        mentions: body.mentions ?? [],
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      };
      chatMessages.push(msg);
      data = { message: msg, turn: { id: "turn-c-" + msg.seq, roomId: "chat-room-1", messageId: msg.id, botIds: body.mentions ?? ["real-bot-id"] } };
    } else if (path === "/api/opc/home-rooms" && req.method() === "GET") {
      data = { bindings: [roomBinding], localRooms: [{ id: "local-room", name: "产品维护", project: "产品甲" }] };
    } else if (path === "/api/opc/home-rooms/references") {
      const targetIdea = u.searchParams.get("idea");
      const fromChat = chatMessages
        .filter((m) => m.text.includes("#ideas?idea=" + targetIdea))
        .map((m) => ({
          bindingId: "",
          postId: m.id,
          roomId: "chat-room-1",
          project: "Agent Home 群聊",
          roomTitle: "OPC 总控群",
          botName: "群聊讨论",
          direction: "out",
          excerpt: m.text.slice(0, 120),
          createdAt: m.createdAt,
        }));
      const fromLegacy = roomPosts
        .filter((p) => p.body.includes("#ideas?idea=" + targetIdea))
        .map((p) => ({
          bindingId: roomBinding.id,
          postId: p.id,
          project: roomBinding.project,
          roomTitle: roomBinding.roomTitle,
          botName: roomBinding.botName,
          direction: p.direction,
          excerpt: p.body.slice(0, 120),
          createdAt: p.createdAt,
        }));
      data = { references: [...fromChat, ...fromLegacy] };
    } else if (path === `/api/opc/home-rooms/${bindingId}/messages` && req.method() === "GET") {
      data = { posts: roomPosts };
    } else if (path === `/api/opc/home-rooms/${bindingId}/messages` && req.method() === "POST") {
      const body = req.postDataJSON();
      const post = {
        id: postId,
        binding: bindingId,
        direction: "out",
        body: body.body,
        state: "received",
        remoteId: "remote-1",
        turnId: "turn-1",
        parent: body.parent ?? null,
        question: 0,
        createdAt: at,
      };
      roomPosts.push(post);
      data = post;
    } else if (path === `/api/opc/home-rooms/${bindingId}/messages/${postId}`) {
      data = { binding: roomBinding, post: roomPosts.find((p) => p.id === postId) };
    } else if (path === "/api/zoom/stage-work" && req.method() === "GET") {
      data = { items: [stageWorkItem] };
    } else if (path === `/api/zoom/stage-work/${stageWorkItem.id}` && req.method() === "GET") {
      data = { work: stageWorkItem, messages: [] };
    } else if (path === `/api/zoom/stage-work/${stageWorkItem.id}/reopen` && req.method() === "POST") {
      const body = req.postDataJSON();
      assert.equal(body.expectedLeaseUntil, stageWorkItem.leaseUntil);
      assert.ok(body.reason.includes("确认停止"));
      stageWorkItem = { ...stageWorkItem, status: "open", owner: undefined, leaseUntil: undefined };
      data = { work: stageWorkItem };
    } else return route.fulfill({ status: 404, json: { message: "unexpected API " + path } });
    await route.fulfill({ json: data });
  });
  await page.goto(origin + "/#overview");
  const scene = page.getByRole("region", { name: "正在工作的 agent 与仓库索引" });
  await expect(scene.getByRole("link", { name: /1\s*执行中/ })).toBeVisible();
  await scene.getByRole("link", { name: /个仓库/ }).click();
  await page.getByRole("searchbox", { name: "查找仓库" }).fill("local-only");
  const list = page.getByRole("list", { name: "仓库列表" });
  await expect(list.locator("li")).toHaveCount(1);
  await list.getByRole("link", { name: /local-only/ }).click();
  await expect(page.locator(".idx-readme pre")).toHaveText("<script>private</script>");
  await expect(page.locator(".idx-filetree a")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "仓库内搜索" }).fill("find");
  assert.equal(searches, 0);
  await page.getByRole("button", { name: "搜索内容" }).click();
  await expect(page.getByText("main.ts · 第 7 行")).toBeVisible();
  await page.goto(origin + "/#activity-index?view=repos&repo=owner%2Fexample");
  await expect(page.getByRole("link", { name: "产品甲 / 项目甲 ↗" })).toHaveAttribute("href", /#projects\?/);
  await page.getByRole("link", { name: /查看关联的/ }).click();
  await expect(page.getByRole("list", { name: "会话列表" }).locator("li")).toHaveCount(1);
  await page.getByRole("link", { name: "整理资料" }).click();
  await page.getByRole("button", { name: "委派核对这次工作的进展" }).click();
  await page.getByLabel("执行者名称").fill("grok-cli");
  await page.getByLabel("办理方式", { exact: true }).fill("按 Herdr 工作流核对进展");
  await page.getByRole("button", { name: "确认委派" }).click();
  await expect(page.getByRole("region", { name: "委派进展" })).toContainText("待执行者接单");
  assert.equal(submissions[0].operation.key, "agent:" + agent.id);
  assert.equal(submissions[0].method.target, "grok-cli");
  await page.getByRole("button", { name: "委派台", exact: true }).click();
  await page.getByRole("button", { name: "设置默认方式" }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByLabel("交给谁").selectOption("agent-home");
  await page.getByLabel("Agent Home 的 Bot").selectOption("real-bot-id");
  await page.getByRole("button", { name: "保存默认方式" }).click();
  await expect(page.getByText("已保存默认办理方式。")).toBeVisible();
  assert.equal(preference.automatic, false);
  // Check DelegationDesk filters and refresh without Zoom inbox.
  await page.goto(origin + "/#delegations");
  const delFilters = page.getByRole("navigation", { name: "按委派状态筛选" });
  await expect(delFilters).toBeVisible();
  await delFilters.getByRole("button", { name: /^已交回/ }).click();
  await expect(page.getByText("当前筛选下没有委派记录。")).toBeVisible();
  await delFilters.getByRole("button", { name: /^全部/ }).click();
  // A fresh ordinary round has a stable successor key shared by every browser.
  items[0].status = "completed";
  items[0].result = "第一轮已交回";
  items[0].evidence = ["test:1"];
  await page.goto(origin + "/#activity-index?view=agents&agent=fixture-session");
  await page.reload();
  await page.getByRole("button", { name: "再委派一项" }).click();
  await page.getByLabel("这次要办什么").fill("核对新的发布记录");
  await page.getByLabel("交给谁").selectOption("coding-agent");
  await page.getByLabel("执行者名称").fill("custom-cli");
  await expect(page.getByText("opc-os stage list --agent 'custom-cli' --wait")).toBeVisible();
  await page.getByRole("button", { name: "确认委派" }).evaluate((btn) => {
    btn.click();
    btn.click();
  });
  await expect(page.getByRole("region", { name: "委派进展" })).toContainText("custom-cli");
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].operation.key, submissions[0].operation.key + "/next/" + items[0].id);
  assert.equal(submissions[1].operation.title, "核对新的发布记录");
  await page.reload();
  await expect(page.getByRole("region", { name: "委派进展" })).toContainText("custom-cli");
  await expect(page.getByRole("button", { name: "再委派一项" })).toHaveCount(0);
  await page.goto(origin + "/#channels?room=local-room&task=local-task");
  await page.getByRole("button", { name: "委派核对这项任务" }).click();
  await page.getByRole("button", { name: "确认委派" }).click();
  await expect(page.getByRole("region", { name: "委派进展" })).toBeVisible();
  assert.equal(submissions[2].operation.href, "#channels?room=local-room&task=local-task");
  assert.match(submissions[2].operation.detail, /验收依据文本/);
  // Direct Agent Home Group Chat + Idea <-> Group Chat <-> StageDesk and StageWork reopen UI.
  await page.goto(origin + "/#ideas?idea=" + ideaId);
  await page.getByRole("link", { name: "到 Agent Home 群聊讨论 ↗" }).click();
  await expect(page.getByRole("heading", { name: "Agent Home 群聊", exact: true })).toBeVisible();
  await expect(page.getByText("引用想法 · 日记到讨论室双向定位")).toBeVisible();
  await page.getByRole("button", { name: "设为默认提醒群" }).click();
  await expect(page.getByText("取消默认提醒群")).toBeVisible();
  await page.getByRole("button", { name: "@架构师" }).click();
  await page.getByRole("button", { name: "发送到群聊" }).click();
  await expect(page.getByRole("link", { name: "查看来源想法 ↗" })).toHaveAttribute("href", "#ideas?idea=" + ideaId);
  await page.getByRole("link", { name: "查看来源想法 ↗" }).click();
  await expect(page.getByRole("region", { name: "相关项目讨论" })).toContainText("OPC 总控群");
  await page.getByRole("region", { name: "相关项目讨论" }).getByRole("link").click();
  await expect(page.getByRole("heading", { name: "OPC 总控群", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "转为阶段任务 ↗" }).click();
  await page.getByRole("button", { name: "核对后重新开放认领" }).click();
  await page.getByLabel("核对说明").fill("已确认停止原执行会话");
  await page.getByRole("button", { name: "确认重新开放" }).click();
  await expect(page.getByText("等待认领 · grok-cli")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/#activity-index?view=repos");
  await expect(page.getByRole("heading", { name: "会话与仓库索引" })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: index, local README, search, related sessions, scoped and message delegation, Bot defaults, scoped repeat, channel action, and mobile.",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
