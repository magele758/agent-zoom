import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

const date = "2026-11-18";
const product = "工作投入样例";
const project = "资料导出";

export function createHubFixture(root) {
  const daily = join(root, "hub-daily");
  mkdirSync(daily);
  writeFileSync(join(daily, date + ".json"), JSON.stringify({ date, generated_by: "agent-hub", taskboard: {
    date, mainlines: [{ name: "产品研发", tasks: { done: [{ key: "fixture-work-1", title: "验收导出字段", project }] } }],
  } }));
  return daily;
}

export async function checkWorklog(page, origin) {
  await page.goto(origin + "/#projects");
  await page.getByRole("button", { name: "新建产品" }).click();
  await page.getByRole("textbox", { name: "产品名称" }).fill(product);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "登记子项目" }).click();
  await page.getByLabel("子项目名称").fill(project);
  await page.getByRole("button", { name: "保存子项目" }).click();
  await expect(page.getByRole("button", { name: project + "的项目消息" })).toBeVisible();
  await page.getByRole("button", { name: project, exact: true }).click();
  await page.getByLabel("项目层级").fill("共用服务");
  await page.getByLabel("业务领域").fill("自动化测试");
  await page.getByRole("button", { name: "保存档案" }).click();
  await expect(page.getByRole("status").filter({hasText:"已保存项目档案"})).toBeVisible();
  for (const term of ["共用服务", "自动化测试", project]) {
    await page.getByRole("searchbox", {name:"搜索目录"}).fill(term);
    await expect(page.getByRole("link", {name: /资料导出 ↗/})).toBeVisible();
  }
  await page.getByRole("link", {name: /资料导出 ↗/}).click();
  await expect(page.getByLabel("项目层级")).toHaveValue("共用服务");
  const countTasks = async () => (await (await page.request.get(origin + "/api/zoom/messages")).json()).messages.length;
  const before = await countTasks();
  const dayRequests = [];
  const record = req => { if (req.url().includes("/worklog/day?")) dayRequests.push(req.url()); };
  page.on("request", record);
  try {
    await page.getByRole("button", { name: "工作投入", exact: true }).click();
    const read = page.getByRole("button", { name: "读取当日日报" });
    await expect(read).toBeEnabled();
    assert.equal(dayRequests.length, 0);
    await page.getByLabel("日报日期").fill(date);
    await read.click();
    await page.getByRole("button", { name: "关联项目", exact: true }).click();
    await page.getByLabel("归属项目").selectOption({ label: product + " / " + project });
    await page.getByLabel("业务线（可选）").selectOption({ index: 1 });
    await page.getByRole("button", { name: "保存关联" }).click();
    await expect(page.getByRole("status")).toContainText("已关联到 " + product);
    await read.click();
    await expect(page.getByRole("button", { name: "修改关联" })).toBeVisible();
    await expect(page.getByRole("link", { name: "原日期 ↗", exact: true })).toHaveAttribute("href", "http://127.0.0.1:28790/#d=" + date);
    const { bindings } = await (await page.request.get(origin + "/api/opc/worklog")).json();
    assert.equal(bindings.length, 1);
    assert.equal(await countTasks(), before);
    // Verify project profile shows linked worklog back-links.
    await page.goto(origin + "/#projects?" + new URLSearchParams({ product, project }));
    await expect(page.getByRole("region", { name: "已关联的工作投入" })).toContainText("验收导出字段");
    await page.getByRole("region", { name: "已关联的工作投入" }).getByRole("link", { name: date }).click();
    await expect(page).toHaveURL(new RegExp("#worklog\\?date=" + date));
    await expect(page.getByRole("button", { name: "取消关联" })).toBeVisible();
    await page.getByRole("button", { name: "取消关联" }).click();
    await expect(page.getByRole("status")).toContainText("已取消工作投入关联");
    const afterUnbind = await (await page.request.get(origin + "/api/opc/worklog")).json();
    assert.equal(afterUnbind.bindings.length, 0);
  } finally { page.off("request", record); }
}
