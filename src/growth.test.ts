import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { GrowthEvent } from "./growth-types.ts";
import { openDatabase } from "./server/db.ts";
import { GrowthLedger } from "./server/growth.ts";
import { ApiError, openStore } from "./server/logic.ts";
import { createApp } from "./server/http.ts";

const at = (day: string) => "2026-05-" + day + "T00:00:00Z";
const event = (customerId: string, eventId: string, day: string) => ({
  product: "甲",
  customerId,
  eventId,
  at: at(day),
  reference: "source/" + eventId,
});

test("acquisition, activation and distinct paid orders form a product-scoped, first-touch customer funnel", () => {
  const db = openDatabase(":memory:");
  const ledger = new GrowthLedger(db);
  assert.deepEqual(ledger.report(), {
    products: [],
    product: null,
    total: { acquired: 0, activated: 0, firstOrder: 0, repeatOrder: 0 },
    channels: [],
    customers: [],
    excluded: [],
    eventCount: 0,
  });
  const history: GrowthEvent[] = [
    { ...event("a", "third", "11"), kind: "order", orderId: "ord3" },
    { ...event("a", "repeat", "10"), kind: "order", orderId: "ord2" },
    { ...event("a", "first", "09"), kind: "order", orderId: "ord1" },
    { ...event("a", "trial", "08"), kind: "activated" },
    { ...event("a", "search", "07"), kind: "acquired", channel: "搜索" },
    { ...event("b", "search-b", "09"), kind: "acquired", channel: "搜索" },
    { ...event("b", "past", "06"), kind: "activated" },
    { ...event("b", "premature", "07"), kind: "order", orderId: "pending" },
    { ...event("c", "visit", "03"), kind: "acquired", channel: "搜索" },
    { ...event("c", "early-order", "04"), kind: "order", orderId: "early" },
    { ...event("c", "install", "05"), kind: "activated" },
    { ...event("d", "orphan", "02"), kind: "order", orderId: "orphan" },
    { ...event("d", "install-d", "03"), kind: "activated" },
  ];
  history.forEach(record => ledger.record(record));
  assert.deepEqual(ledger.report("甲").channels, [
    { channel: "搜索", acquired: 3, activated: 2, firstOrder: 1, repeatOrder: 1 },
  ]);
  // A late, earlier acquisition moves its customer and all of their evidenced milestones together.
  ledger.record({ ...event("a", "referral", "02"), kind: "acquired", channel: "推荐" });
  ledger.record({ ...history[2], product: "乙", reference: "separate ledger" });
  const report = ledger.report("甲");
  assert.equal(report.eventCount, 14);
  assert.deepEqual(report.total, { acquired: 3, activated: 2, firstOrder: 1, repeatOrder: 1 });
  assert.deepEqual(report.channels, [
    { channel: "搜索", acquired: 2, activated: 1, firstOrder: 0, repeatOrder: 0 },
    { channel: "推荐", acquired: 1, activated: 1, firstOrder: 1, repeatOrder: 1 },
  ]);
  const customer = report.customers.find(item => item.customerId === "a")!;
  assert.deepEqual(
    [
      customer.acquired.eventId,
      customer.activated?.reference,
      customer.firstOrder?.orderId,
      customer.repeatOrder?.reference,
    ],
    ["referral", "source/trial", "ord1", "source/repeat"]
  );
  assert.deepEqual(Object.fromEntries(report.excluded.map(item => [item.event.eventId, item.reason])), {
    past: "activation_before_acquisition",
    premature: "missing_activation",
    "early-order": "order_before_activation",
    orphan: "missing_acquisition",
    "install-d": "missing_acquisition",
  });
  assert.equal(ledger.report("乙").total.acquired, 0);
  assert.equal(ledger.report("乙").excluded[0].event.reference, "separate ledger");
  assert.equal(ledger.report("unknown").eventCount, 0);
  assert.throws(() => ledger.report("  "), /有效的产品名/);
  db.close();
});

test("business receipts survive reopen and reject conflicting event IDs, orders and customers", t => {
  const dir = mkdtempSync(join(tmpdir(), "kunlun-growth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  let db = openDatabase(path);
  let ledger = new GrowthLedger(db);
  const record: GrowthEvent = {
    ...event("a", "paid", "09"),
    kind: "order",
    orderId: "source-order-42",
    at: "2026-05-09T11:30:00.000115+08:00",
  };
  assert.equal(ledger.record(record).created, true);
  db.close();
  db = openDatabase(path);
  ledger = new GrowthLedger(db);
  const utc = { ...record, at: "2026-05-09T03:30:00.0001150Z" };
  const retry = ledger.record(utc);
  assert.equal(retry.created, false);
  assert.equal(retry.event.at, "2026-05-09T03:30:00.000115Z");
  const conflict = (error: unknown) => error instanceof ApiError && error.status === 409;
  assert.throws(() => ledger.record({ ...utc, reference: "replacement" }), conflict);
  assert.throws(() => ledger.record({ ...utc, eventId: "another-source-id" }), conflict);
  assert.throws(() => ledger.record({ ...utc, eventId: "another-source-id", customerId: "b" }), conflict);
  assert.equal(ledger.report("甲").eventCount, 1);
  assert.equal(ledger.record({ ...utc, product: "乙" }).created, true);
  const invalid = (error: unknown) => error instanceof ApiError && error.status === 400;
  for (const update of [
    { reference: "" },
    { kind: "activated" },
    { orderId: "" },
    { at: "2026-05-01T00:00:00" },
    { kind: "acquired", channel: " " },
    { at: "2026-02-30T00:00:00Z" },
  ]) {
    assert.throws(() => ledger.record({ ...record, ...update }), invalid);
  }
  db.close();
});

test("equal timestamps follow funnel order; a sub-millisecond difference follows the source clock", () => {
  const db = openDatabase(":memory:");
  const ledger = new GrowthLedger(db);
  const base = { ...event("buyer", "acq", "04"), at: "2026-04-02T12:00:00.000001Z" };
  ledger.record({ ...base, kind: "order", eventId: "sale-2", orderId: "2" });
  ledger.record({ ...base, kind: "order", eventId: "sale-1", orderId: "1" });
  ledger.record({ ...base, kind: "activated", eventId: "activate" });
  ledger.record({ ...base, kind: "acquired", eventId: "z2", channel: "partner" });
  ledger.record({ ...base, kind: "acquired", eventId: "a1", channel: "organic" });
  ledger.record({ ...base, at: "2026-04-02T12:00:00.0000009Z", kind: "order", eventId: "before", orderId: "0" });
  const report = ledger.report();
  assert.deepEqual(report.channels, [{ channel: "organic", acquired: 1, activated: 1, firstOrder: 1, repeatOrder: 1 }]);
  assert.equal(report.customers[0].firstOrder?.orderId, "1");
  assert.equal(report.excluded[0].event.eventId, "before");
  db.close();
});

test("the mounted HTTP routes accept source receipts only with agent credentials and allow local browser report reads", async t => {
  const store = openStore(":memory:");
  t.after(() => store.db.close());
  const token = "growth-local-fixture-submit-token";
  const previous = process.env.WORKFLOW_SUBMIT_TOKEN;
  process.env.WORKFLOW_SUBMIT_TOKEN = token;
  let app: Hono;
  try {
    ({ app } = createApp(store));
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_SUBMIT_TOKEN;
    else process.env.WORKFLOW_SUBMIT_TOKEN = previous;
  }
  const current = await app.request("/api/me");
  const cookie = current.headers.get("set-cookie")!.split(";")[0];
  const record: GrowthEvent = { ...event("a", "signup", "05"), kind: "acquired", channel: "社区" };
  const post = (headers: Record<string, string>, data: unknown) =>
    app.request("/api/zoom/growth/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(data),
    });
  const bearer = { authorization: "Bearer " + token };
  assert.equal((await post({ cookie }, record)).status, 401);
  assert.equal((await post({}, record)).status, 401);
  assert.equal((await post(bearer, { ...record, channel: undefined })).status, 400);
  assert.equal((await (await post(bearer, record)).json()).created, true);
  assert.equal((await (await post(bearer, record)).json()).created, false);
  assert.equal((await post(bearer, { ...record, channel: "other" })).status, 409);
  const url = "/api/zoom/growth?product=" + encodeURIComponent("甲");
  assert.equal((await app.request(url)).status, 401);
  for (const headers of [bearer, { cookie }]) {
    const response = await app.request(url, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).total.acquired, 1);
  }
});
