import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

export function createJournalFixture(root) {
  const daily = join(root, "daily-review-learning");
  mkdirSync(daily);
  writeFileSync(join(daily, "2026-11-20.md"), [
    "# 早读",
    "## 研发",
    "- 用可复用模板改善测试证据",
    "## 早先资料",
    "- 演示未被引用的隔壁材料",
    '![原图](https://example.invalid/sample.png)',
    '<img src="https://example.invalid/automatic-request.png" onerror="alert(1)">',
    "[不安全地址](javascript:alert%281%29)",
    "## 今日总结",
    "全篇最后一行",
    "",
  ].join("\n"));
  writeFileSync(join(daily, "2026-11-19.md"), "# 前一天\n\n上一日的可读正文\n");
  return daily;
}

export async function checkCompanyIdeas(page, origin) {
  let clipCount = 0;
  let remoteRequests = 0;
  const guard = route => { remoteRequests++;return route.abort(); };
  await page.route("https://example.invalid/**", guard);
  await page.route("**/api/zoom/company/learn", route => route.fulfill({ json: {
    available: true, canClip: true, homeUrl: "http://127.0.0.1:4317", documents: [], sessions: [],
  }}));
  await page.route("**/api/zoom/company/learn/clip", route => {
    clipCount++;
    const data = route.request().postDataJSON();
    assert.equal(data.day, "2026-11-20");
    assert.ok(data.articleId);
    assert.equal(data.question, "了解证据模板的取舍");
    return route.fulfill({ json: { id:"fixture-clip", url:"http://127.0.0.1:4317/#clips/fixture", duplicate:false } });
  });
  await page.goto(origin + "/#ideas");
  await expect(page.getByRole("heading", { name:"信息与想法" })).toBeVisible();
  await expect(page.getByRole("heading", { name:"文章列表" })).toBeVisible();
  const article = page.getByRole("article", { name:"日读全文" });
  await expect(article).toContainText("用可复用模板改善测试证据");
  await expect(article).toContainText("全篇最后一行");
  await expect(article.getByRole("link", { name:"不安全地址" })).toHaveCount(0);
  await expect(article.getByRole("link", { name:"原图" })).toBeVisible();
  const toc = page.locator(".ci-toc");
  await toc.locator("summary").click();
  await toc.getByRole("link", { name:"研发", exact:true }).click();
  await expect(page).toHaveURL(/section=/);
  await expect(page.locator(".ci-reading-section")).toHaveText(/本次引用 · 研发/);
  await page.getByRole("button", { name:"用 Learn Agent 学习" }).click();
  await page.getByLabel(/这次想学什么/).fill("了解证据模板的取舍");
  await page.getByRole("button", { name:"送去学习" }).click();
  await expect(page.getByRole("link", { name:/打开学习资料/ })).toBeVisible();
  assert.equal(clipCount, 1);
  assert.equal(remoteRequests, 0);
  await page.getByRole("button", { name:"写下想验证的事" }).click();
  await expect(page.getByLabel("想法标题")).toHaveCount(0);
  const hypothesis = "在两个产品上验证减少复测时间。";
  await page.getByLabel("想验证什么").fill(hypothesis);
  await page.getByRole("button", { name:"保存", exact:true }).click();
  await expect(page.getByRole("heading", { name:"派给项目研发" })).toBeVisible();
  const ideaUrl = page.url();
  await page.getByText("关联产品或新建项目", { exact:true }).click();
  for (const product of ["工具产品","数据产品"]) {
    await page.getByLabel("新产品名称").fill(product);
    await page.getByRole("button", { name:"新建产品", exact:true }).click();
    await expect(page.locator(".ci-project-options")).toContainText(product);
  }
  await page.getByLabel("所属产品").selectOption("工具产品");
  await page.getByLabel("新项目名称").fill("验收工具");
  await page.getByRole("button", { name:"建立项目" }).click();
  await expect(page.getByLabel("研发项目")).toHaveValue("工具产品/验收工具");
  await page.getByRole("button", { name:"发起研发" }).click();
  await expect(page.locator(".ci-referrals").getByRole("link", { name:/项目研发记录/ })).toBeVisible();
  await page.reload();
  await expect(page.locator(".ci-referrals").getByRole("link", { name:/项目研发记录/ })).toBeVisible();
  const index = await (await page.request.get(origin + "/api/zoom/company")).json();
  const idea = index.ideas.find(i => i.body === hypothesis);
  assert.equal(idea.products.length, 2);
  assert.deepEqual(index.information.filter(n => idea.sources.includes(n.id)).map(n => n.body), ["研发"]);
  assert.ok(!JSON.stringify(index).includes("演示未被引用的隔壁材料"));
  for (let t = 0; t < 2; t++) {
    const replay = await page.request.post(origin + "/api/zoom/company/ideas/" + idea.id + "/dispatch",
      {data:{product:"工具产品",name:"验收工具"}});
    assert.ok(replay.ok());
    assert.equal((await replay.json()).status, "unbound");
  }
  const queue = await (await page.request.get(origin + "/api/opc/opportunities")).json();
  const mine = queue.opportunities.filter(o => o.sourceId.startsWith("company-idea/" + idea.id + "/"));
  assert.equal(mine.length, 1);
  await page.locator(".ci-referrals").getByRole("link", { name:/项目研发记录/ }).click();
  await expect(page).toHaveURL(new RegExp("item=" + mine[0].id));
  await page.goto(ideaUrl);
  await page.getByText("项目入口", { exact:true }).click();
  await page.getByRole("link", { name:"起草 PRD" }).click();
  await expect(page.getByLabel("所属项目")).toHaveValue("验收工具");
  await page.goto(ideaUrl);
  await page.getByRole("link", { name:/让 agent 研究这个想法/ }).click();
  await expect(page.getByLabel("公司事项")).toHaveValue(idea.id);
  await page.goto(ideaUrl);
  await page.getByRole("link", { name:/到项目讨论室提问/ }).click();
  await expect(page).toHaveURL(new RegExp("#home-room\\?idea=" + idea.id));

  const viewport = page.viewportSize();
  await page.setViewportSize({ width:390,height:850 });
  await page.goto(origin + "/#ideas");
  await expect(page.getByRole("heading", { name:"文章列表" })).toBeVisible();
  await expect(article).toBeHidden();
  await page.getByRole("link", { name:/2026 年 11 月 20 日/ }).click();
  await expect(article).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.getByRole("button", { name:/返回列表/ }).click();
  await expect(page.getByRole("heading", { name:"文章列表" })).toBeVisible();
  await page.setViewportSize(viewport);
  await page.unroute("https://example.invalid/**", guard);
  await page.unroute("**/api/zoom/company/learn");
  await page.unroute("**/api/zoom/company/learn/clip");
}
