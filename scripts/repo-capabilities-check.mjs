import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function checkRepoCapabilities(page, origin, submitToken) {
  const api = async (path, payload, headers) => {
    const args = { data: payload, headers };
    const response =
      payload === undefined
        ? await page.request.get(origin + path)
        : await page.request.post(origin + path, args);
    const record = await response.json();
    assert.ok(response.ok(), JSON.stringify(record));
    return record;
  };
  const repo = "example/draft-lint",
    url = "https://github.com/" + repo;
  await api(
    "/api/zoom/projects/sync",
    {
      name: "能力库样例",
      repository: {
        owner: "example",
        fullName: repo,
        url,
        description: "公开仓库测试样本",
        visibility: "public",
        fork: false,
        openIssues: 0,
        openPullRequests: 0,
        latestRelease: null,
        items: [],
        syncedAt: "2026-11-01T00:00:00.000Z",
      },
    },
    { authorization: "Bearer " + submitToken },
  );
  await api("/api/zoom/projects", { name: "店铺样例" });
  await api("/api/zoom/company/projects", { product: "店铺样例", name: "草稿验收" });
  await page.goto(origin + "/#capabilities?repo=" + encodeURIComponent(repo));
  await page.getByRole("button", { name: "登记版本", exact: true }).click();
  const register = page.getByRole("form", { name: "登记能力版本" });
  await register.getByLabel("维护项目与仓库").selectOption({ label: "能力库样例/draft-lint · " + repo });
  await register.getByLabel("能力名称").fill("草稿校验");
  await register.getByLabel("固定版本").fill("v1.2.0");
  await register.getByLabel("调用入口").fill("draft-lint check");
  await register.getByLabel("版本凭据").fill(url + "/releases/tag/v1.2.0");
  await register.getByRole("button", { name: "保存版本" }).click();
  await expect(page.getByRole("heading", { name: "草稿校验", exact: true })).toBeVisible();
  await page.goto(origin + "/#opportunities?" + new URLSearchParams({ project: "店铺样例/草稿验收" }));
  await page.getByRole("button", { name: "记录线索", exact: true }).click();
  const lead = page.getByRole("form", { name: "记录研发线索" });
  await lead.getByLabel("希望解决什么问题").fill("检查草稿字段");
  await lead.getByLabel("为什么值得做").fill("店铺录入规格时要有现成的校验反馈");
  await lead.getByLabel("来源标识").fill("demo/capabilities/manual");
  await lead.getByLabel(/依据（/).fill("本地样本草稿清单");
  await lead.locator("summary").filter({ hasText: "引用已有能力版本" }).click();
  await lead.getByRole("checkbox", { name: /example\/draft-lint/ }).check();
  await lead.getByRole("button", { name: "保存线索" }).click();
  await expect(page.getByRole("heading", { name: "先评估已有能力" })).toBeVisible();
  await page
    .locator(".opc-reuse")
    .getByRole("link", { name: /草稿校验/ })
    .click();
  await page.getByRole("button", { name: "直接复用此版本" }).click();
  let form = page.getByRole("form", { name: "直接复用", exact: true });
  await form.getByLabel("使用方项目").selectOption("店铺样例/草稿验收");
  await form.getByLabel("这次用在什么地方").fill("导入时检查规格");
  await form.getByLabel("使用说明").fill("先检查本地草稿，再将结果展示给测试员。");
  await form.getByRole("button", { name: "记录版本复用" }).click();
  await expect(page.getByText("已记录复用", { exact: true })).toBeVisible();
  const reused = (await api("/api/opc/capabilities")).requests.find((r) => r.status === "reused");
  assert.equal(reused.taskId, null);
  assert.ok(reused.sourceOpportunityId);
  await expect(page.getByRole("link", { name: "返回使用方的原候选" })).toBeVisible();
  await page.getByRole("link", { name: "返回能力版本" }).click();
  await page.getByRole("button", { name: "向维护项目提需求" }).click();
  form = page.getByRole("form", { name: "补充需求", exact: true });
  await form.getByLabel("使用方项目").selectOption("店铺样例/草稿验收");
  await form.getByLabel("还缺什么能力").fill("增加规格编号检查");
  await form.getByLabel("影响范围").fill("影响导入多规格草稿的店铺。");
  await form.getByLabel("验收办法").fill("错误规格编号时返回具体行号。");
  await form.getByRole("button", { name: "提交到 Zoom 审批" }).click();
  await page.getByRole("link", { name: /在 Zoom 审批 · r1/ }).click();
  let decision = page.getByRole("region", { name: "维护需求审批" });
  await decision.getByLabel("给提出方的反馈").fill("请明确空编号的处理。");
  await decision.getByRole("button", { name: "要求修改" }).click();
  await page.getByRole("link", { name: "返回能力需求与版本记录" }).click();
  await expect(page.locator(".rc-history blockquote")).toHaveText("请明确空编号的处理。");
  await page.getByRole("button", { name: "修订后再提交" }).click();
  await page.getByLabel("验收办法").fill("空编号和非法编号都返回具体行号。");
  await page.getByRole("button", { name: "提交到 Zoom 审批" }).click();
  await page.getByRole("link", { name: /在 Zoom 审批 · r2/ }).click();
  decision = page.getByRole("region", { name: "维护需求审批" });
  await decision.getByRole("button", { name: "批准", exact: true }).click();
  await page.getByRole("link", { name: "返回能力需求与版本记录" }).click();
  await expect(page.getByRole("link", { name: "查看维护项目候选" })).toBeVisible();
  const records = (await api("/api/opc/capabilities")).requests;
  const requirement = records.find((r) => r.status === "approved");
  assert.equal(requirement.revisions.length, 2);
  assert.equal(requirement.revisions[0].status, "changes");
  await page.getByRole("link", { name: "查看维护项目候选" }).click();
  await expect(page.locator(".opc-detail h2")).toHaveText("增加规格编号检查");
  await page.getByRole("link", { name: "回到原能力需求" }).click();
  await expect(page.getByRole("heading", { name: "增加规格编号检查", exact: true })).toBeVisible();

  const fallback = await api("/api/opc/opportunities", {
    project: "店铺样例/草稿验收",
    kind: "feature",
    sourceId: "demo/fallback",
    title: "草稿缺省值检查",
    rationale: "兼容旧草稿",
    evidence: ["规范样例"],
    capabilityRefs: [reused.capabilityId],
  });
  const proposal = await api("/api/opc/capabilities/requests", {
    requestId: "example-fallback",
    product: "店铺样例",
    project: "草稿验收",
    sourceOpportunityId: fallback.id,
    capabilityId: reused.capabilityId,
    mode: "gap",
    title: "补充默认值",
    detail: "验收需要旧草稿通过",
  });
  await page.goto(origin + "/#capabilities?request=" + proposal.id);
  await page.getByRole("link", { name: /在 Zoom 审批 · r1/ }).click();
  decision = page.getByRole("region", { name: "维护需求审批" });
  await decision.getByLabel("给提出方的反馈").fill("现有接口已支持在参数中显式指定默认值。");
  await decision.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByRole("link", { name: "返回能力需求与版本记录" }).click();
  await page.getByRole("button", { name: "改用现有版本", exact: true }).click();
  form = page.getByRole("form", { name: "直接复用", exact: true });
  await form.getByLabel("这次用在什么地方").fill("通过显式参数兼容旧草稿");
  await form.getByLabel("使用说明").fill("接受当前接口限制，测试草稿保留原值。");
  await form.getByRole("button", { name: "记录版本复用", exact: true }).click();
  await expect(page.locator(".rc-detail > header")).toContainText("已记录复用");
  await expect(page.locator(".rc-history blockquote")).toHaveText("现有接口已支持在参数中显式指定默认值。");
  const converted = (await api("/api/opc/capabilities")).requests.find((r) => r.id === proposal.id);
  assert.deepEqual(
    converted.revisions.map((r) => r.status),
    ["rejected", "reused"],
  );
  assert.equal(converted.opportunityId, null);

  const pinned = await api("/api/opc/opportunities", {
    project: "店铺样例/草稿验收",
    kind: "feature",
    sourceId: "demo/version-change",
    title: "沿用已验收的草稿校验",
    rationale: "保持已有版本保证",
    evidence: ["旧版接口检查"],
    capabilityRefs: [reused.capabilityId],
  });
  const gap = await api("/api/opc/capabilities/requests", {
    requestId: "example-pinned-gap",
    product: "店铺样例",
    project: "草稿验收",
    sourceOpportunityId: pinned.id,
    capabilityId: reused.capabilityId,
    mode: "gap",
    title: "在结果中区分多种错误",
    detail: "校验结果含独立错误代码",
  });
  await api("/api/opc/capabilities/requests/" + gap.id + "/decisions", {
    revision: 1,
    questionId: gap.questionId,
    action: "approve",
  });
  const registerRevision = (version) =>
    api("/api/opc/capabilities", {
      product: gap.capability.product,
      project: gap.capability.project,
      repo,
      name: gap.capability.name,
      version,
      interfaceRef: "draft-lint check",
      evidence: url + "/releases/tag/" + version,
    });
  const old = await registerRevision("v1.0.0");
  await api("/api/opc/capabilities/requests", {
    requestId: "example-independent-use",
    product: gap.product,
    project: gap.project,
    sourceOpportunityId: pinned.id,
    capabilityId: old.id,
    mode: "reuse",
    title: "对照历史兼容性",
    detail: "旧草稿仍用历史接口。",
  });
  const inspect = async () =>
    (await api("/api/opc/opportunities")).opportunities.find((r) => r.id === pinned.id);
  assert.equal((await inspect()).reuse.status, "needs_decision");
  const fixed = await registerRevision("v1.3.0");
  await page.goto(origin + "/#capabilities?request=" + gap.id);
  await page.getByRole("link", { name: "为使用方核对其他版本" }).click();
  await page.locator(".rc-list li a").filter({ hasText: fixed.version }).click();
  await page.getByRole("button", { name: "直接复用此版本" }).click();
  form = page.getByRole("form", { name: "直接复用", exact: true });
  await form.getByLabel("这次用在什么地方").fill("按独立错误代码分类");
  await form.getByRole("checkbox", { name: /此版本解决了/ }).check();
  const verificationUrl = url + "/blob/v1.3.0/tests/error-codes.mjs";
  await form.getByLabel("该固定版本的交付凭据").fill(verificationUrl);
  await form.getByLabel("使用说明").fill("签收样本中的两个错误分别返回 E01、E02。");
  await form.getByRole("button", { name: "记录版本复用" }).click();
  await expect(page.locator(".rc-detail > header")).toContainText("已记录复用");
  assert.equal((await inspect()).reuse.status, "adopted");
  await expect(page.locator(".rc-proof")).toContainText("两个错误分别返回 E01、E02");
  await expect(
    page.locator(".rc-proof").getByRole("link", { name: verificationUrl + " ↗" }),
  ).toHaveAttribute("href", verificationUrl);
  await page.getByRole("link", { name: "查看已解决的原仓需求" }).click();
  await expect(page.getByRole("heading", { name: "使用方已验证的版本" })).toBeVisible();
  await expect(page.locator(".rc-proof")).toContainText("v1.3.0");
  await page.goto(origin + "/#capabilities?request=" + requirement.id);
  await expect(page.getByRole("heading", { name: requirement.title, exact: true })).toBeVisible();
}
