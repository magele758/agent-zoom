import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { openDatabase } from "./server/db.ts";
import { Store } from "./server/logic.ts";
import { OpportunityStore } from "./server/autonomy.ts";
import { CommercialHubService } from "./server/commercial.ts";

function listenJson(handler: (method: string, url: string, body: Record<string, unknown>) => unknown): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const out = handler(req.method || "GET", req.url || "/", parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("CommercialHubService bootstraps 7-layer portfolio, playbooks, and runs end-to-end closed loop", async () => {
  const db = openDatabase(":memory:");
  const store = new Store(db, false);
  void store;
  const opportunities = new OpportunityStore(db);

  let ordersCount = 0;
  let licensesCount = 0;
  let costMinor = 0;
  let grossMinor = 0;
  let importedTraceCount = 0;

  const mockCommerce = await listenJson((method, url, body) => {
    if (url === "/api/health") {
      return { ok: true, stats: { orderCount: ordersCount, activeLicenses: licensesCount } };
    }
    if (url.startsWith("/api/v1/summary")) {
      const net = grossMinor - costMinor;
      return {
        orderCount: ordersCount,
        activeLicenses: licensesCount,
        currencies: grossMinor
          ? [
              {
                currency: "USD",
                grossMinor,
                refundMinor: 0,
                costMinor,
                netMinor: net,
                grossMarginPct: Math.round((net / grossMinor) * 1000) / 10,
              },
            ]
          : [],
      };
    }
    if (method === "POST" && url === "/api/v1/orders") {
      ordersCount++;
      licensesCount++;
      grossMinor += Number(body.grossMinor ?? 2900);
      costMinor += Number(body.feeMinor ?? 195);
      return {
        order: body,
        license: { licenseKey: "OPCL1.eyJwcm9kdWN0IjoiUGFnZUxlbnMifQ.sig_demo_valid_key" },
      };
    }
    if (method === "POST" && url === "/api/v1/licenses/verify") {
      return { valid: String(body.licenseKey || "").startsWith("OPCL1.") };
    }
    if (method === "POST" && url === "/api/v1/costs") {
      costMinor += Number(body.amountMinor ?? 0);
      return { ok: true };
    }
    if (url.startsWith("/api/v1/export/traces")) {
      return { records: [] };
    }
    return { ok: true };
  });

  const mockGtm = await listenJson((_method, url) => {
    if (url === "/api/health") return { ok: true, stats: { acquisitions: 1, waitlist: 2 } };
    if (url.startsWith("/api/v1/summary")) return { waitlistCount: 2, campaignCount: 1 };
    if (url.startsWith("/api/v1/export/traces")) return { records: [] };
    return { ok: true };
  });

  const mockOps = await listenJson((_method, url) => {
    if (url === "/api/health") {
      return { ok: true, stats: { tickets: { open: 0 }, telemetry: { activatedUsers: 1 } } };
    }
    if (url.startsWith("/api/v1/summary")) {
      return {
        tickets: { open: 0, pendingFollowups: 0 },
        telemetry: { activatedUsers: 1, crashFreeSessionRate: 0.998 },
      };
    }
    if (url.startsWith("/api/v1/export/traces")) return { records: [] };
    return { ok: true };
  });

  const mockDataAnalysis = await listenJson((method, url, body) => {
    if (url === "/health") return { status: "ok" };
    if (method === "POST" && url === "/api/v1/import/traces") {
      const records = Array.isArray(body.records) ? body.records : [];
      importedTraceCount = records.length;
      return { status: "success", row_count: importedTraceCount };
    }
    if (method === "POST" && url === "/api/v1/analytics/funnel") {
      return {
        steps: [
          { step_index: 1, step_name: "acquired", user_count: 1 },
          { step_index: 2, step_name: "activated", user_count: 1 },
          { step_index: 3, step_name: "order", user_count: 1 },
        ],
      };
    }
    return { status: "ok" };
  });

  try {
    const hub = new CommercialHubService(db, opportunities, {
      commerceOrigin: mockCommerce.origin,
      gtmOrigin: mockGtm.origin,
      opsOrigin: mockOps.origin,
      dataAnalysisOrigin: mockDataAnalysis.origin,
    });

    const boot = hub.bootstrapCompany();
    assert.equal(boot.ok, true);
    assert.ok(boot.projectsCount >= 16);
    assert.ok(boot.linesConfigured >= 4);

    const closed = await hub.runClosedLoopVerification({
      channel: "xiaohongshu",
      currency: "USD",
      grossMinor: 2900,
      llmCostMinor: 150,
    });
    assert.equal(closed.ok, true);
    assert.equal(closed.licenseVerified, true);
    assert.equal(importedTraceCount, 3);
    assert.equal(closed.overview.completionPct, 100);
    assert.equal(closed.overview.metrics.funnel.acquired, 1);
    assert.equal(closed.overview.metrics.funnel.activated, 1);
    assert.equal(closed.overview.metrics.funnel.firstOrder, 1);
    assert.equal(closed.overview.analytics?.overallConversionPct, 100);
  } finally {
    await Promise.all([
      mockCommerce.close(),
      mockGtm.close(),
      mockOps.close(),
      mockDataAnalysis.close(),
    ]);
    db.close();
  }
});
