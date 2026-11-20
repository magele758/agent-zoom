import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { dailyOpportunity, githubOpportunities, runSources } from "./opc-sources.mjs";
import { readGithubRepository } from "./zoom-github.mjs";

const file = "/notes/2026-11-20.md";
const markdown = "# 日记\n## 上午\n### 研究\n- 私人上下文 A\n- [ ] **导出账本** [原始说明](https://example.org/export)\n## 下午\n### 研究\n- 私人上下文 B\n";
const project = "个人应用/账本";
const registry = { projects: [{ name: "账本", repositories: [{ fullName: "example/ledger" }] }] };

function snapshot(name) {
  const base = "https://github.com/" + name;
  return {
    fullName: name, items: [
      { number: 7, kind: "issue", title: "Regression in export", url: base + "/issues/7" },
      { number: 8, kind: "pull", title: "Open PR", url: base + "/pull/8" },
    ], latestRelease: { tag: "v3", url: base + "/releases/tag/v3", notes: "## Changes\n- Add TSV output\n- Optional formatting" },
  };
}

test("daily sources quote just the selection and retain identity across insertions and new batches", () => {
  const first = dailyOpportunity({ file, markdown, line: "5", project });
  assert.equal(first.kind, "feature");
  assert.equal(first.project, project);
  assert.match(first.evidence[0], /2026-11-20\.md#L5.*上午.*研究/);
  assert.ok(first.evidence.includes("https://example.org/export"));
  assert.doesNotMatch(JSON.stringify(first), /私人上下文/);
  const moved = dailyOpportunity({ file, markdown: "\n" + markdown + "## 晚班\n", line: "6", project });
  assert.equal(first.sourceId, moved.sourceId);
  assert.throws(() => dailyOpportunity({ file, markdown, heading: "研究", project }), /重复/);
  const heading1 = dailyOpportunity({ file, markdown, line: "3", project });
  const heading2 = dailyOpportunity({ file, markdown, line: "7", project });
  assert.notEqual(heading1.sourceId, heading2.sourceId);
  assert.throws(() => dailyOpportunity({ file, markdown: "```md\n## 忽略\n```\n", heading: "忽略", project }), /没有找到/);
  assert.throws(() => dailyOpportunity({ file: "/notes/2026-11-20-brief.md", markdown, line: "5", project }), /原文件/);
});

test("GitHub keys survive renamed issues; upstream releases stay attached to the chosen target", () => {
  const original = snapshot("example/ledger");
  const candidates = githubOpportunities(original, project);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].impact, 4);
  original.items[0].title = "Renamed request";
  const again = githubOpportunities(original, project);
  assert.equal(again[0].sourceId, candidates[0].sourceId);
  assert.equal(again[1].sourceId, candidates[1].sourceId);
  const upstream = githubOpportunities(snapshot("other/upstream"), project, true);
  assert.deepEqual(upstream.map(item => [item.kind, item.project]), [["upgrade", project]]);
  assert.match(upstream[0].rationale, /Add TSV output/);
  assert.equal(upstream[0].evidence[0], "https://github.com/other/upstream/releases/tag/v3");
});

test("rich source reads preserve the existing registered repository snapshot schema", async () => {
  const remote = {
    nameWithOwner: "example/ledger", owner: { login: "example" }, visibility: "PUBLIC",
    isFork: false, url: "https://github.com/example/ledger",
    latestRelease: { tagName: "v1", url: "https://github.com/example/ledger/releases/tag/v1", description: "An enhancement" },
    issues: { totalCount: 1, nodes: [{ number: 2, title: "Export digest", updatedAt: "2026-11-20T01:01:01Z",
      url: "https://github.com/example/ledger/issues/2", labels: { nodes: [{ name: "enhancement" }] } }] },
    pullRequests: { totalCount: 0, nodes: [] },
  };
  const normal = await readGithubRepository("example/ledger", async () => remote);
  assert.ok(!Object.hasOwn(normal.latestRelease, "notes"));
  assert.ok(!Object.hasOwn(normal.items[0], "labels"));
  const rich = await readGithubRepository("example/ledger", async () => remote, true);
  const candidates = githubOpportunities(rich, "example/ledger");
  assert.match(candidates[0].rationale, /enhancement/);
  assert.match(candidates[1].rationale, /An enhancement/);
});

test("CLI import batches by stable sources, checks registered repos, and supports local daily preview", async t => {
  const dir = await mkdtemp(join(tmpdir(), "opc-source-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const request = async (path, payload) => {
    if (path === "/api/zoom/projects") return registry;
    assert.equal(path, "/api/opc/opportunities/import");
    requests.push(payload.items);
    return { opportunities: payload.items };
  };
  const options = { request, github: async repo => snapshot(repo) };
  await runSources(["github", "--repo", "example/ledger", "--project", project], options);
  await runSources(["github", "--repo", "example/ledger", "--project", project], options);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[0].length, 2);
  await assert.rejects(runSources(["github", "--repo", "unknown/repo"], options), /未登记/);
  await assert.rejects(runSources(["github", "--upstream", "other/repo"], options), /需要 --repo/);
  const inputs = join(dir, "2026-11-20.md");
  await writeFile(inputs, markdown);
  const result = await runSources(["daily", inputs, "--project", project, "--heading", "上午", "--dry-run"], {
    request: () => assert.fail("daily previews never make a network request"),
  });
  assert.equal(result.opportunities[0].project, project);
  assert.equal(requests.length, 2);
});

test("one failed repository does not starve unrelated repositories", async () => {
  let imported;
  const options = {
    request: async (path, body) => {
      if (path === "/api/zoom/projects") return { projects: [{ name: "portfolio", repositories: [
        { fullName: "a/failing" }, { fullName: "b/working" },
      ] }] };
      imported = body.items;
    },
    github: async repo => {
      if (repo === "a/failing") throw new Error("rate limited");
      return snapshot(repo);
    },
    log: () => {},
  };
  await assert.rejects(runSources(["github"], options), /部分 GitHub/);
  assert.equal(imported.length, 2);
  assert.equal(imported[0].project, "b/working");
});
