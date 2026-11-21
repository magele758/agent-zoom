// Use a disposable Git checkout and browser session for both business lines.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { chromium, expect } from "@playwright/test";

const child = spawn(process.execPath, ["scripts/opc-demo.mjs", "--interactive"], {
  stdio: ["ignore", "pipe", "inherit"],
});
const closed = once(child, "exit");
const output = createInterface({ input: child.stdout });
const deadline = setTimeout(() => child.kill("SIGTERM"), 90000);
let browser;
try {
  let origin;
  for await (const line of output) {
    const match = line.match(/公司总览 (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      origin = match[1];
      break;
    }
  }
  assert.ok(origin, "临时服务未返回地址");
  const chrome = process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/#overview");
  await page
    .getByRole("region", { name: "公司业务线入口" })
    .getByRole("link", { name: /店铺运营/ })
    .click();
  await expect(page.getByRole("heading", { name: "店铺运营", exact: true })).toBeVisible();
  await page
    .locator(".bl-trial")
    .getByRole("link", { name: /ChromeGate Gateway 场景检查/ })
    .click();
  await expect(page.getByRole("heading", { name: "浏览器场景回放与失败证据", exact: true })).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "新建业务线" }).click();
  await page.getByLabel("业务线名称").fill("第二家店（浏览器测试）");
  await page.getByLabel("目标", { exact: true }).fill("验证草稿完整性");
  await page.getByRole("button", { name: "添加资产" }).click();
  await page.getByLabel("资产名称 1").fill("草稿检查插件");
  await page.getByLabel("资产出处 1").fill("测试版本 1.0");
  const choice = page.getByLabel("选用已登记的开源能力");
  await choice.selectOption({ index: 1 });
  await page.getByRole("button", { name: "保存业务线" }).click();
  await expect(page.getByRole("heading", { name: "第二家店（浏览器测试）" })).toBeVisible();
  await page.getByRole("button", { name: "新建实验" }).click();
  await page.getByLabel("实验名称").fill("样例商品草稿");
  await page.getByLabel("这次要验证什么").fill("明确插件发现的漏填字段");
  await page.getByLabel("怎样判断有效").fill("在样例中计数");
  await page.getByLabel("本轮范围与使用权限").fill("只检查虚构样例");
  await page.getByRole("button", { name: "登记实验" }).click();
  const trial = page.locator(".bl-trial", { hasText: "样例商品草稿" });
  await expect(trial.getByRole("link", { name: /浏览器场景回放与失败证据/ })).toHaveAttribute(
    "href",
    /^#capabilities\?capability=/,
  );
  await trial.getByRole("button", { name: "登记证据" }).click();
  await trial.getByLabel("观察或交易说明").fill("发现一处漏填");
  await trial.getByLabel("原始凭据").fill("fixture/sample-one");
  await trial.getByRole("button", { name: "保存凭据" }).click();
  await trial.getByRole("button", { name: "从观察提出研发特性" }).click();
  await trial.getByLabel("目标研发项目").fill("Demo/Greeting");
  await trial.getByLabel("提议开发的特性").fill("为选填规则增加回归样例");
  await trial.getByRole("button", { name: "加入研发候选" }).click();
  await trial.getByRole("link", { name: /为选填规则增加回归样例/ }).click();
  await page.getByRole("link", { name: "回到提出特性的经营实验 ↗" }).click();
  await trial.getByRole("button", { name: "提交复盘" }).click();
  await trial.getByRole("radio", { name: "调整" }).check();
  await trial.getByLabel("复盘结论与理由").fill("补两份样例，再核对误报");
  await trial.getByRole("button", { name: "保存复盘决定" }).click();
  await expect(trial).toContainText("已决定 · 调整");
  await page.setViewportSize({ width: 390, height: 820 });
  await expect(trial).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.goto(origin + "/#stage?step=testing&product=Demo");
  await page.getByLabel("所属项目").selectOption("Greeting");
  await page.getByLabel("指定 agent（可选）").fill("grok");
  await page.getByRole("button", { name: "登记阶段任务" }).click();
  await expect(page.locator(".sd-work")).toContainText("等待认领 · grok");
  await page.locator(".sd-work").getByRole("link", { name: "到群聊讨论 ↗" }).click();
  await expect(page.getByRole("heading", { name: "Agent Home 群聊", exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "通过：总览 → 新经营线 → 插件实验 → 证据 → 研发候选 → 原实验 → 页内复盘 → Agent Home 群聊。手机阶段工作单成功接入指定 coding agent 的认领队列。",
  );
} finally {
  clearTimeout(deadline);
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await closed;
}
