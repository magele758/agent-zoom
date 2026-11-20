#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);

export const TEMP_PREFIXES = [
  "kunlun-workflow-",
  "kunlun-model-",
  "kunlun-zoom-preview-",
  "opc-os-demo-",
  "chatroom-browser-",
  "opc-index-browser-",
  "opc-agent-home-room-",
  "kunlun-test-",
  "kunlun-executor-",
  "kunlun-kept-",
  "kunlun-cleanup-",
  "opc-cli-contract-",
  "opc-delegation-cli-",
  "opc-source-test-",
  "kunlun-zoom-cli-",
  "zoom-cli-alias-",
  "kunlun-zoom-local-",
  "kunlun-taken-port-",
  "gongwei-pagelens-",
];

function cleanEnv(base = process.env) {
  const env = { ...base };
  for (const key of ["HC_SCOPE", "HC_SESSION", "HC_TERMINAL_ID", "HFLOW_WORKER", "KUNLUN_WORKFLOW_WORKER"]) {
    delete env[key];
  }
  return env;
}

function parseTerminals(raw) {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.terminals ?? []);
}

async function listTerminals(hc, args, env) {
  try {
    const { stdout } = await exec(hc, ["ls", "--all", "--json", ...args], { timeout: 5000, maxBuffer: 2_000_000, env });
    return parseTerminals(stdout);
  } catch {
    return [];
  }
}

async function listDesktopSpaces(herdrApp, env) {
  try {
    const { stdout } = await exec(herdrApp, ["ls"], { timeout: 2500, maxBuffer: 2_000_000, env });
    return JSON.parse(stdout).spaces ?? [];
  } catch {
    return [];
  }
}

async function killAndRemove(hc, rows, env) {
  const removed = [];
  let killedAny = false;
  for (const row of rows) {
    if (row.state !== "live") continue;
    try {
      await exec(hc, ["kill", row.address], { timeout: 5000, env });
      killedAny = true;
    } catch {
      // Process may already have exited.
    }
  }
  if (killedAny) await delay(120);
  for (const row of rows) {
    let ok = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await exec(hc, ["rm", row.address], { timeout: 5000, env });
        ok = true;
        break;
      } catch {
        if (attempt < 2) await delay(150);
      }
    }
    if (ok) removed.push(row.address);
  }
  return removed;
}

export async function cleanupHerdrRun(runId, options = {}) {
  if (!runId) return { removedTerminals: [], closedSpace: null };
  const hc = options.hc ?? process.env.HC_BIN ?? "hc";
  const herdrApp = options.herdrApp ?? process.env.HERDR_APP_BIN ?? "herdr-app";
  const env = cleanEnv(options.env);
  const dryRun = Boolean(options.dryRun);
  const labelArgs = ["--label", `kunlun.run=${runId}`];
  const initial = (await listTerminals(hc, labelArgs, env)).filter(
    row => row.name?.startsWith("kw-") && row.labels?.["kunlun.run"] === runId,
  );
  const matchedAddresses = new Set(initial.map(row => row.address));
  let closedSpace = null;

  if (!options.space) {
    const spaceId = `sp${runId.replaceAll("-", "")}`;
    const spaces = await listDesktopSpaces(herdrApp, env);
    const runSpace = spaces.find(item => item.id === spaceId);
    const onlyRunTerminals = runSpace && (runSpace.tabs ?? []).every(tab =>
      (tab.terminals ?? []).every(pane => !pane.terminal || matchedAddresses.has(pane.terminal)));
    if (onlyRunTerminals) {
      if (!dryRun) {
        try {
          await exec(herdrApp, ["do", "space.close", "--id", spaceId, "--confirmed", "true"], { timeout: 3000, env });
        } catch {
          // Continue with direct hc cleanup.
        }
      }
      closedSpace = spaceId;
    }
  }

  if (dryRun) {
    return { removedTerminals: [...matchedAddresses], closedSpace };
  }

  const remaining = (await listTerminals(hc, labelArgs, env)).filter(
    row => row.name?.startsWith("kw-") && row.labels?.["kunlun.run"] === runId,
  );
  const remainingSet = new Set(remaining.map(row => row.address));
  const alreadyRemoved = [...matchedAddresses].filter(address => !remainingSet.has(address));
  const removedAfterClose = await killAndRemove(hc, remaining, env);
  return {
    removedTerminals: [...new Set([...alreadyRemoved, ...removedAfterClose])],
    closedSpace,
  };
}

function tempRoots() {
  const candidates = ["/tmp", tmpdir()];
  const roots = new Set();
  for (const dir of candidates) {
    try {
      roots.add(realpathSync(dir));
    } catch {
      if (existsSync(dir)) roots.add(dir);
    }
  }
  return [...roots];
}

function isProjectTempPath(cwd, roots) {
  if (!cwd) return false;
  const normalized = cwd.startsWith("/tmp/") ? `/private${cwd}` : cwd;
  return roots.some(root => {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const matchesRoot = cwd.startsWith(prefix) || normalized.startsWith(prefix);
    if (!matchesRoot) return false;
    const remainder = (cwd.startsWith(prefix) ? cwd : normalized).slice(prefix.length);
    const top = remainder.split("/")[0];
    return TEMP_PREFIXES.some(tag => top.startsWith(tag));
  });
}

export async function cleanupStaleArtifacts(options = {}) {
  const hc = options.hc ?? process.env.HC_BIN ?? "hc";
  const herdrApp = options.herdrApp ?? process.env.HERDR_APP_BIN ?? "herdr-app";
  const env = cleanEnv(options.env);
  const dryRun = Boolean(options.dryRun);
  const allFinished = Boolean(options.allFinished);
  const roots = tempRoots();

  const allTerminals = await listTerminals(hc, [], env);
  const allByAddress = new Map(allTerminals.map(row => [row.address, row]));
  const matched = allTerminals.filter(row => {
    if (!row.name?.startsWith("kw-") || !row.labels?.["kunlun.run"]) return false;
    if (isProjectTempPath(row.cwd, roots)) return true;
    if (row.state === "finished" && (allFinished || (row.cwd && !existsSync(row.cwd)))) return true;
    return false;
  });
  const matchedAddresses = new Set(matched.map(row => row.address));

  const spaces = await listDesktopSpaces(herdrApp, env);
  const closedSpaces = [];
  for (const space of spaces) {
    if (!/^sp[0-9a-f]{32}$/.test(space.id ?? "")) continue;
    if (!/^(?:OPC OS|昆仑) · /.test(space.name ?? "")) continue;
    const panes = (space.tabs ?? []).flatMap(tab => (tab.terminals ?? []).map(pane => pane.terminal).filter(Boolean));
    const hasUnmatchedExisting = panes.some(address => !matchedAddresses.has(address) && allByAddress.has(address));
    if (hasUnmatchedExisting) continue;
    const hasMatchedOrOrphaned = panes.length === 0 || panes.some(address => matchedAddresses.has(address) || !allByAddress.has(address));
    if (!hasMatchedOrOrphaned) continue;
    if (!dryRun) {
      try {
        await exec(herdrApp, ["do", "space.close", "--id", space.id, "--confirmed", "true"], { timeout: 3000, env });
      } catch {
        continue;
      }
    }
    closedSpaces.push({ id: space.id, name: space.name });
  }

  let removedTerminals;
  if (dryRun) {
    removedTerminals = matched.map(row => ({ address: row.address, name: row.name, state: row.state, cwd: row.cwd }));
  } else {
    const afterClose = await listTerminals(hc, [], env);
    const remainingMap = new Map(afterClose.map(row => [row.address, row]));
    const remainingMatched = matched.map(row => remainingMap.get(row.address)).filter(Boolean);
    const alreadyRemoved = matched.filter(row => !remainingMap.has(row.address)).map(row => row.address);
    const killed = await killAndRemove(hc, remainingMatched, env);
    removedTerminals = [...new Set([...alreadyRemoved, ...killed])];
  }

  const removedDirs = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!TEMP_PREFIXES.some(prefix => entry.startsWith(prefix))) continue;
      const fullPath = join(root, entry);
      try {
        if (!lstatSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!dryRun) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
        } catch {
          continue;
        }
      }
      removedDirs.push(fullPath);
    }
  }

  return { dryRun, closedSpaces, removedTerminals, removedDirs };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      "all-finished": { type: "boolean", default: false },
      run: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("用法: node scripts/workflow-cleanup.mjs [--dry-run] [--all-finished] [--run <run-id>]");
  } else if (values.run) {
    console.log(JSON.stringify(await cleanupHerdrRun(values.run, { dryRun: values["dry-run"] }), null, 2));
  } else {
    console.log(JSON.stringify(await cleanupStaleArtifacts({
      dryRun: values["dry-run"],
      allFinished: values["all-finished"],
    }), null, 2));
  }
}
