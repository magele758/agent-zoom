import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { openDatabase } from "./server/db.ts";
import { ApiError } from "./server/logic.ts";
import { CompanyStore } from "./server/company.ts";
import { ProjectStore } from "./server/projects.ts";
import { registerSecurityDepartmentRoutes, SecurityReviews } from "./server/security-department.ts";
import { securityStatus } from "./security-department-types.ts";

const fails = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
const draft = () => ({ id: randomUUID(), product: "产品甲", project: "后台", scope: "复核成员权限变更" });

test("security reviews keep project, findings, remediation and re-review history across restarts and stale submissions", t => {
  const dir = mkdtempSync(join(tmpdir(), "opc-security-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "db.sqlite");
  const db = openDatabase(file);
  const products = new ProjectStore(db);
  const company = new CompanyStore(db);
  const reviews = new SecurityReviews(db);
  const input = draft();
  assert.throws(() => reviews.create(input), fails(404));
  products.create({ name: input.product });
  company.createProject({ product: input.product, name: input.project });
  const registered = reviews.create(input);
  assert.deepEqual(reviews.create(input), registered);
  assert.throws(() => reviews.create({ ...input, scope: "其他范围" }), fails(409));
  assert.equal(securityStatus(registered), "pending");
  const finding = { revision: 0, outcome: "changes", note: "成员撤权后缓存仍生效", evidence: "权限测试记录 A" };
  assert.throws(() => reviews.decide(input.id, { ...finding, outcome: "recheck" }), fails(409));
  reviews.decide(input.id, finding);
  assert.throws(() => reviews.decide(input.id, { ...finding, outcome: "passed" }), fails(409));
  assert.throws(() => reviews.decide(input.id, { ...finding, outcome: "passed", revision: 1 }), fails(409));
  const fixed = { revision: 1, outcome: "recheck", note: "撤权时清除缓存", evidence: "变更 B" };
  reviews.decide(input.id, fixed);
  const passed = reviews.decide(input.id, { revision: 2, outcome: "passed", note: "已核对撤权即时生效", evidence: "复核记录 C" });
  assert.deepEqual(reviews.decide(input.id, fixed), passed);
  assert.throws(() => reviews.decide(input.id, { ...finding, revision: 3 }), fails(409));
  assert.deepEqual(passed.history.map(event => event.outcome), ["changes", "recheck", "passed"]);
  db.close();
  const reopened = openDatabase(file);
  t.after(() => reopened.close());
  assert.deepEqual(new SecurityReviews(reopened).index(), { reviews: [passed], projects: [{ product: input.product, project: input.project }] });
});

test("security index and writes use the local user session", async t => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  new ProjectStore(db);
  const app = new Hono();
  const path = "/api/opc/departments/security";
  registerSecurityDepartmentRoutes(app, db, c => {
    if (!c.req.header("X-Test-User")) throw new ApiError(401, "auth", "auth");
  });
  app.onError((err, c) => c.text(err.message, err instanceof ApiError ? err.status as 400 : 500));
  assert.equal((await app.request(path)).status, 401);
  assert.equal((await app.request(path + "/reviews", { method: "POST" })).status, 401);
  assert.equal((await app.request(path + "/reviews/x/decisions", { method: "POST" })).status, 401);
  const response = await app.request(path, { headers: { "X-Test-User": "yes" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { reviews: [], projects: [] });
});
