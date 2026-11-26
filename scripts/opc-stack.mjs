#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dirname, "..");
const zoomLocalDir = resolve(process.env.KUNLUN_LOCAL_DIR || join(root, "data", "zoom-local"));
const serviceFile = join(zoomLocalDir, "service.env");
const submitFile = join(zoomLocalDir, "submit.env");
const pidsFile = join(root, "data", "companion-runtime", "pids.json");

function resolveConfiguredPgUrl() {
  if (process.env.OPC_PG_URL) return process.env.OPC_PG_URL.trim();
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  if (existsSync(serviceFile)) {
    try {
      const env = parseEnv(readFileSync(serviceFile, "utf8"));
      return (env.OPC_PG_URL || env.DATABASE_URL || "").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function checkOrStartPostgres(ensureRunning = false) {
  const pgUrl = resolveConfiguredPgUrl();
  const container = (process.env.OPC_PG_CONTAINER || "opc-postgres").trim();
  if (!pgUrl) return { enabled: false, container, ready: false };

  const inspect = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", container], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  let running = inspect.status === 0 && inspect.stdout.trim() === "true";

  if (ensureRunning && inspect.status === 0 && !running) {
    const start = spawnSync("docker", ["start", container], { encoding: "utf8", stdio: "ignore" });
    running = start.status === 0;
  }

  let ready = false;
  if (running) {
    const readyCheck = spawnSync("docker", ["exec", container, "pg_isready", "-U", "opc", "-d", "opc_os"], {
      encoding: "utf8",
      stdio: "ignore",
    });
    ready = readyCheck.status === 0;
  }
  return { enabled: true, container, running, ready };
}

const usage = `用法: node scripts/opc-stack.mjs <up|status|verify|stop>
  up      启动或连接本机 OPC OS，自动拉起 Commerce / GTM / Ops / Data Analysis 服务并纳管公司 7 层全景
  status  查看全部服务健康状态、1 号变现试点进度与核心经营指标
  verify  执行一次端到端首单商业闭环自检（UTM获客 -> 激活 -> 离线License发码验签 -> DuckDB漏斗）
  stop    停止由 stack 自动拉起的附属后台服务`;

function readSubmit() {
  if (!existsSync(submitFile)) return null;
  const env = parseEnv(readFileSync(submitFile, "utf8"));
  if (!env.WORKFLOW_SUBMIT_TOKEN) return null;
  return {
    origin: env.OPC_URL || env.KUNLUN_URL || "http://127.0.0.1:52328",
    token: env.WORKFLOW_SUBMIT_TOKEN,
  };
}

async function api(conn, path, payload) {
  const res = await fetch(new URL(path, conn.origin), {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${conn.token}`,
      "content-type": "application/json",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
}

async function ensureOpcOsRunning() {
  const existing = readSubmit();
  if (existing) {
    try {
      const h = await fetch(new URL("/api/health", existing.origin), { signal: AbortSignal.timeout(1500) });
      if (h.ok) return existing;
    } catch {
      // Not running yet
    }
  }
  mkdirSync(zoomLocalDir, { mode: 0o700, recursive: true });
  const child = spawn(process.execPath, ["scripts/zoom-local.mjs"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const conn = readSubmit();
    if (conn) {
      try {
        const h = await fetch(new URL("/api/health", conn.origin), { signal: AbortSignal.timeout(1500) });
        if (h.ok) return conn;
      } catch {
        // wait
      }
    }
    await delay(400);
  }
  throw new Error("启动本机 OPC OS 超时，请检查 npm run opc:start 输出");
}

function connectZoomCli() {
  if (existsSync(submitFile)) {
    spawnSync(process.execPath, ["scripts/zoom.mjs", "connect", submitFile], {
      cwd: root,
      stdio: "ignore",
    });
  }
}

function stopCompanions() {
  if (!existsSync(pidsFile)) return { stopped: [] };
  const pids = JSON.parse(readFileSync(pidsFile, "utf8"));
  const stopped = [];
  for (const [id, pid] of Object.entries(pids)) {
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        stopped.push({ id, pid });
      } catch {
        // already exited
      }
    }
  }
  rmSync(pidsFile, { force: true });
  return { stopped };
}

const cmd = process.argv[2] || "up";
if (!["up", "status", "verify", "stop"].includes(cmd)) {
  console.log(usage);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}

try {
  if (cmd === "stop") {
    console.log(JSON.stringify(stopCompanions(), null, 2));
    process.exit(0);
  }

  const postgres = checkOrStartPostgres(cmd === "up");
  const conn = await ensureOpcOsRunning();
  connectZoomCli();

  if (cmd === "up") {
    const bootstrap = await api(conn, "/api/opc/commercial/bootstrap", {});
    const ensured = await api(conn, "/api/opc/commercial/services/ensure", {});
    const overview = await api(conn, "/api/opc/commercial/overview");
    console.log(
      JSON.stringify(
        {
          ok: true,
          opcOsOrigin: conn.origin,
          cockpitUrl: `${conn.origin}/#commercial`,
          businessLinesUrl: `${conn.origin}/#business-lines`,
          inboxUrl: `${conn.origin}/#inbox`,
          postgres,
          bootstrap,
          startedServices: ensured.started,
          completionPct: overview.completionPct,
          services: overview.services.map((s) => ({
            id: s.id,
            healthy: s.healthy,
            origin: s.origin,
            summary: s.summary,
          })),
        },
        null,
        2,
      ),
    );
  } else if (cmd === "status") {
    const overview = await api(conn, "/api/opc/commercial/overview");
    console.log(
      JSON.stringify(
        {
          opcOsOrigin: conn.origin,
          cockpitUrl: `${conn.origin}/#commercial`,
          postgres,
          pilot: overview.pilot,
          completionPct: overview.completionPct,
          metrics: overview.metrics,
          analytics: overview.analytics,
          services: overview.services.map((s) => ({
            id: s.id,
            healthy: s.healthy,
            origin: s.origin,
            summary: s.summary,
          })),
        },
        null,
        2,
      ),
    );
  } else if (cmd === "verify") {
    const verified = await api(conn, "/api/opc/commercial/actions/closed-loop", {});
    console.log(
      JSON.stringify(
        {
          ok: verified.ok,
          product: verified.product,
          customerId: verified.customerId,
          orderId: verified.orderId,
          licenseKeyPreview: verified.licenseKeyPreview,
          licenseVerified: verified.licenseVerified,
          completionPct: verified.overview?.completionPct,
          analytics: verified.analytics,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
