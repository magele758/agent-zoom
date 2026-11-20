import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RepositorySnapshot } from "./project-types.ts";
import { openDatabase } from "./server/db.ts";
import { createApp } from "./server/http.ts";
import { ApiError, openStore } from "./server/logic.ts";
import { projectMessages } from "./server/project-mail.ts";
import { ProjectStore } from "./server/projects.ts";

function fixture(slug = "kernel"): RepositorySnapshot {
  const fullName = "example/" + slug;
  const url = "https://github.com/" + fullName;
  const syncedAt = "2026-09-01T13:28:00.000Z";
  return {
    owner: "example",
    fork: false,
    visibility: "public",
    fullName,
    url,
    description: "Test repository",
    openIssues: 3,
    openPullRequests: 1,
    syncedAt,
    latestRelease: { tag: "release/v1", url: url + "/releases/tag/release%2Fv1", publishedAt: syncedAt },
    items: [
      { kind: "issue", number: 3, title: "Improve onboarding", url: url + "/issues/3", updatedAt: syncedAt },
      { kind: "pull", number: 7, title: "Update settings", url: url + "/pull/7", updatedAt: syncedAt },
    ],
  };
}
const status = (code: number) => (err: unknown) => err instanceof ApiError && err.status === code;

test("a product can start empty, add multiple repositories, and retain its immutable bindings and source snapshots after restart", t => {
  const dir = mkdtempSync(join(tmpdir(), "kunlun-projects-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "projects.sqlite");
  let db = openDatabase(file);
  let projects = new ProjectStore(db);
  const name = "研发工具";
  assert.deepEqual(projects.list(), { projects: [] });
  assert.deepEqual(projects.create({ name: "  " + name + "  " }), {
    created: true,
    project: { name, repositories: [] },
  });
  assert.equal(projects.create({ name }).created, false);
  assert.equal(projectMessages(db).length, 0);

  const repository = fixture();
  const imported = projects.sync({ name, repository });
  assert.equal(imported.changed, true);
  assert.equal(imported.project.repositories[0].items[0].number, 7);
  const second = projects.sync({ name, repository: fixture("docs") });
  assert.deepEqual(
    second.project.repositories.map(r => r.fullName),
    ["example/docs", "example/kernel"]
  );
  assert.equal(projects.sync({ name: "另一个产品", repository: fixture("website") }).changed, true);
  assert.deepEqual(projects.names().sort(), ["另一个产品", name].sort());
  const original = projects.list();
  const mail = projectMessages(db);
  assert.equal(mail.length, 3);
  assert.ok(mail.every(m => m.origin === "repository" && !m.pending));
  assert.deepEqual(mail[0].repository, imported.project.repositories[0]);
  db.close();

  db = openDatabase(file);
  t.after(() => db.close());
  projects = new ProjectStore(db);
  assert.deepEqual(projects.list(), original);
  assert.deepEqual(projectMessages(db), mail);
  const same = { ...repository, items: [...repository.items].reverse() };
  assert.equal(projects.sync({ name, repository: same }).changed, false);
  assert.throws(
    () => projects.sync({ name: "争用", repository: { ...same, fullName: "EXAMPLE/Kernel" } }),
    status(409)
  );
  assert.deepEqual(projects.list(), original);
  assert.deepEqual(projectMessages(db), mail);
});

test("older snapshots, conflicting retries, and pure refreshes cannot roll back maintenance records or create duplicate mail", () => {
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db);
  const name = "Demo";
  const repository = fixture();
  projects.sync({ name, repository });
  const later = "2026-09-02T13:28:00.000Z";
  const latest = { ...repository, syncedAt: later, items: [], openIssues: 0, openPullRequests: 0 };
  const updated = projects.sync({ name, repository: latest });
  assert.equal(updated.changed, true);
  assert.equal(updated.project.repositories[0].syncedAt, later);
  assert.equal(projects.sync({ name, repository }).changed, false);
  assert.throws(() => projects.sync({ name, repository: { ...latest, openIssues: 1 } }), status(409));
  const refresh = "2026-09-03T13:28:00.000Z";
  const refreshed = projects.sync({ name, repository: { ...latest, syncedAt: refresh } });
  assert.equal(refreshed.changed, false);
  assert.equal(refreshed.project.repositories[0].syncedAt, refresh);
  assert.deepEqual(refreshed.project.repositories[0].items, []);
  const mail = projectMessages(db);
  assert.equal(mail.length, 2);
  assert.equal(mail[0].repository?.items.length, 2);
  assert.equal(mail[1].repository?.items.length, 0);
  db.close();
});

test("catalog rejects private visibility, mismatched source URLs, inconsistent counts and duplicate GitHub numbers before any writes", () => {
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db);
  const repository = fixture();
  const item = repository.items[0];
  for (const patch of [
    { visibility: "private" },
    { owner: "someone-else" },
    { url: "https://example.test/example/kernel" },
    { url: repository.url + "?x" },
    { latestRelease: { ...repository.latestRelease, url: repository.url + "/releases/tag/something-else" } },
    {
      latestRelease: { ...repository.latestRelease, tag: "../away", url: repository.url + "/releases/tag/%2E%2E/away" },
    },
    { items: [{ ...item, url: repository.url + "/pull/3" }] },
    { items: [{ ...item, url: "https://github.com/example/else/issues/3" }] },
    { items: [item, { ...item, kind: "pull", url: repository.url + "/pull/3" }] },
    { openPullRequests: 0 },
    { openIssues: -1 },
  ]) {
    assert.throws(() => projects.sync({ name: "临时", repository: { ...repository, ...patch } }), status(400));
  }
  for (const name of ["", "..", "two/levels", "two\\levels"])
    assert.throws(() => projects.create({ name }), status(400));
  assert.deepEqual(projects.names(), []);
  assert.equal(projectMessages(db).length, 0);
  db.close();
});

test("failed maintenance mail rolls back both the new product and its repository binding", t => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const projects = new ProjectStore(db);
  const snapshot = { name: "Retry", repository: fixture() };
  db.exec(`CREATE TEMP TRIGGER reject_once BEFORE INSERT ON zoom_project_mail
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  assert.throws(() => projects.sync(snapshot), /simulated write failure/);
  assert.deepEqual(projects.list(), { projects: [] });
  db.exec("DROP TRIGGER reject_once");
  assert.equal(projects.sync(snapshot).changed, true);
  assert.equal(projectMessages(db).length, 1);
});

test("an unreleased repository returns an explicit null and accepts either form on retry", t => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const projects = new ProjectStore(db);
  const { latestRelease, ...withoutRelease } = fixture();
  const input = { name: "Unreleased", repository: withoutRelease };
  const published = projects.sync(input);
  assert.equal(published.project.repositories[0].latestRelease, null);
  assert.equal(projects.sync({ ...input, repository: { ...withoutRelease, latestRelease: null } }).changed, false);
  assert.equal(projectMessages(db).length, 1);
});

test("local browser can create and read products while only trusted imports may create GitHub mail", async t => {
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const token = "projects-local-fixture-submit-token";
  const previous = process.env.WORKFLOW_SUBMIT_TOKEN;
  process.env.WORKFLOW_SUBMIT_TOKEN = token;
  let app: ReturnType<typeof createApp>["app"];
  try {
    ({ app } = createApp(store));
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_SUBMIT_TOKEN;
    else process.env.WORKFLOW_SUBMIT_TOKEN = previous;
  }
  const me = await app.request("/api/me");
  const cookie = me.headers.get("set-cookie")!.split(";")[0];
  const local = { cookie };
  const cli = { authorization: "Bearer " + token };
  const path = "/api/zoom/projects";
  const write = (url: string, headers: Record<string, string>, data: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  assert.equal((await app.request(path)).status, 401);
  assert.equal((await write(path, {}, { name: "test" })).status, 401);
  assert.equal((await write(path, local, { name: "A" })).status, 200);
  assert.equal((await write(path, cli, { name: "B" })).status, 200);
  const snapshot = { name: "A", repository: fixture() };
  assert.equal((await write(path + "/sync", local, snapshot)).status, 401);
  assert.equal((await write(path + "/sync", cli, snapshot)).status, 200);
  for (const headers of [cli, local]) {
    const response = await app.request(path, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const index = await response.json();
    assert.deepEqual(
      index.projects.map((p: { name: string }) => p.name),
      ["A", "B"]
    );
    assert.equal(index.projects[0].repositories[0].url, fixture().url);
  }
  const inbox = await (await app.request("/api/zoom/messages", { headers: local })).json();
  assert.deepEqual(inbox.products, ["A", "B"]);
  assert.equal(inbox.messages.filter((m: { pending: boolean }) => m.pending).length, 0);
  assert.equal(
    inbox.messages.find((m: { origin: string }) => m.origin === "repository").repository.fullName,
    "example/kernel"
  );
});
