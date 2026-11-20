import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function checkBoardFiling(page, run, status) {
  const title = run.request.goal;
  const before = await status();
  await page.getByRole("button", { name: "标为已读", exact: true }).click();
  await expect(page.getByText("已读", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "归档此任务" }).click();
  await expect(page.getByRole("button", { name: "移回看板" })).toBeVisible();
  await page.getByRole("link", { name: "所有运行" }).click();
  await expect(page.getByRole("button", { name: /^已归档 · 1$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
  await page.getByRole("button", { name: /^已归档/ }).click();
  const archivedCard = page.getByRole("region", { name: "待人工决定" }).getByRole("link", { name: new RegExp(title) });
  await expect(archivedCard).not.toContainText("未读更新");
  await archivedCard.click();
  await expect(page.locator('[data-kind="plan"]')).toBeVisible();
  await page.getByRole("button", { name: "移回看板" }).click();
  await expect(page.getByRole("button", { name: "归档此任务" })).toBeVisible();
  // Include all versions, attempts, decisions and events in this assertion.
  assert.deepEqual(await status(), before);
}

export async function checkBoardRejection(page, run, status) {
  const returned = "请发起者明确目标后再提交。";
  await page.getByRole("region", { name: "待人工决定" }).getByRole("link", { name: new RegExp(run.request.goal) }).click();
  const plan = page.locator('[data-kind="plan"]');
  await page.getByRole("button", { name: "归档此任务" }).click();
  await expect(page.getByRole("button", { name: "移回看板" })).toBeVisible();
  await plan.getByRole("button", { name: "拒绝" }).click();
  await expect(plan.getByRole("alert")).toContainText("请填写");
  await plan.getByLabel("发回原请求的反馈").fill(returned);
  await plan.getByRole("button", { name: "拒绝" }).click();
  await expect(page.locator(".workflow-history")).toContainText(returned);
  await expect(page.locator(".workflow-state dd")).toHaveText(["计划", `发起者 · ${run.request.source}`]);
  const result = await status();
  assert.equal(result.cards[0].status, "reject");
  assert.equal(result.cards[0].note, returned);
  assert.equal(result.request.requestId, run.request.requestId);
  assert.equal(result.attempts.length, 0);
  await page.getByRole("link", { name: "所有运行" }).click();
  await expect(page.getByRole("region", { name: "待发起者修订" })).toContainText(run.request.goal);
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByRole("region", { name: "待发起者修订" })).toContainText(run.request.goal);
  assert.deepEqual((await status()).cards, result.cards);
}
