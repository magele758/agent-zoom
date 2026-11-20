import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attemptName, HerdrExecutor, prepareAttempt, type WorkerPayload } from "./server/workflow/executor.ts";
import { evidenceSchema } from "./server/workflow/contract.ts";
import type { WorkflowAttempt } from "./workflow-types.ts";

test("fresh worktrees compose dependency deltas once and capture only the worker's own change", async t => {
  const directory = mkdtempSync(join(tmpdir(), "kunlun-executor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "project");
  execFileSync("git", ["init", "-q", workspace]);
  writeFileSync(join(workspace, "value"), "one\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"]);
  const base = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runId = randomUUID();
  const worker = fileURLToPath(new URL("../scripts/workflow-worker.mjs", import.meta.url));

  async function runNode(id: string, kind: "implement" | "review", operation: string, upstream: WorkerPayload["upstream"]) {
    const attemptId = randomUUID();
    const worktree = join(directory, attemptId, "worktree");
    const attempt: WorkflowAttempt = { id: attemptId, nodeId: id, revision: 1, worktree, state: "dispatching" };
    const program = `import { readFileSync, writeFileSync } from "node:fs";
      import assert from "node:assert/strict";
      ${operation}
      writeFileSync(process.argv[2], JSON.stringify({
        outcome: "succeeded", summary: "done", checks: [{ name: "test", exitCode: 0, output: "OK" }], artifacts: []
      }));`;
    const path = await prepareAttempt(directory, { workspace, base }, attempt, {
      runId, attemptId, revision: 1, base, worktree, boardUrl: "http://localhost", backend: "local-demo",
      node: { id, kind, title: id, instruction: id, dependsOn: [] }, feedback: [], upstream,
      request: { version: 1, requestId: "dag", source: "test", context: "dag", goal: "dag", constraints: [] },
      runner: [process.execPath, "--input-type=module", "-e", program],
    });
    execFileSync(process.execPath, [worker, path], { cwd: worktree });
    return { worktree, evidence: evidenceSchema.parse(JSON.parse(readFileSync(join(directory, attemptId, "receipt.json"), "utf8"))) };
  }

  const a = await runNode("a", "implement", 'writeFileSync("value", "two\\n")', []);
  const b = await runNode("b", "implement", 'assert.equal(readFileSync("value", "utf8"), "two\\n"); writeFileSync("value", "three\\n")', [a]);
  const c = await runNode("c", "implement", 'writeFileSync("guide", "present")', [a]);
  assert.equal(a.evidence.outcome, "succeeded");
  assert.match(b.evidence.patch, /-two\n\+three/);
  assert.doesNotMatch(c.evidence.patch, /b\/value/);

  // The mutable upstream checkout is no longer a valid source for review.
  writeFileSync(join(a.worktree, "value"), "changed after receipt");
  const review = await runNode("review", "review",
    'assert.equal(readFileSync("value", "utf8"), "three\\n"); assert.equal(readFileSync("guide", "utf8"), "present")', [a, b, a, c]);
  assert.equal(review.evidence.outcome, "succeeded");
  assert.equal(review.evidence.patch, "");

  const dirty = await runNode("dirty", "review", 'writeFileSync("value", "edited by reviewer")', [a, b, c]);
  assert.equal(dirty.evidence.outcome, "failed");
  assert.match(dirty.evidence.patch, /edited by reviewer/);

  const conflict = await runNode("conflict", "implement", 'writeFileSync("value", "conflict\\n")', []);
  await assert.rejects(runNode("conflicted-review", "review", "", [a, conflict]), /节点 conflict 的差异无法应用/);
  const failed = { ...b, evidence: { ...b.evidence, outcome: "failed" as const } };
  const repaired = await runNode("b", "implement",
    'assert.equal(readFileSync("value", "utf8"), "three\\n"); writeFileSync("value", "four\\n")', [a, failed]);
  assert.equal(repaired.evidence.outcome, "succeeded");
  assert.match(repaired.evidence.patch, /-two\n\+four/);
  assert.equal(readFileSync(join(workspace, "value"), "utf8"), "one\n");
});

test("a kept Herdr pane can be live after the original worker has been lost", async t => {
  const directory = mkdtempSync(join(tmpdir(), "kunlun-kept-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const attempt = randomUUID();
  const hc = join(directory, "hc");
  const observed = { address: "t1", name: attemptName(attempt), state: "live", labels: { "kunlun.attempt": attempt } };
  const stateFile = join(directory, "observed.json");
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("node:fs");
const row = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
console.log(JSON.stringify(process.argv[2] === "ls" ? {terminals:[row]} : row));
`, { mode: 0o700 });
  const host = new HerdrExecutor(hc);
  writeFileSync(stateFile, JSON.stringify({ ...observed, argv: ["node", "/app/workflow-worker.mjs", join(directory, attempt, "payload.json")] }));
  assert.deepEqual(await host.status(attempt), { state: "running", terminal: "t1" });
  writeFileSync(stateFile, JSON.stringify({ ...observed, argv: ["/bin/zsh", "-l"] }));
  assert.deepEqual(await host.status(attempt), { state: "finished", terminal: "t1" });
});

test("HerdrExecutor.cleanup only closes dedicated run spaces and removes matching run terminals", async t => {
  const directory = mkdtempSync(join(tmpdir(), "kunlun-cleanup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const a1 = randomUUID();
  const a2 = randomUUID();
  const spaceId = `sp${runId.replaceAll("-", "")}`;
  const stateFile = join(directory, "state.json");
  const logFile = join(directory, "calls.json");
  const hc = join(directory, "hc");
  const herdrApp = join(directory, "herdr-app");
  writeFileSync(hc, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const log = JSON.parse(fs.readFileSync(${JSON.stringify(logFile)}, "utf8"));
log.push(["hc", ...args]);
if (args[0] === "ls") {
  console.log(JSON.stringify({ terminals: state.terminals }));
} else if (args[0] === "kill") {
  for (const row of state.terminals) if (row.address === args[1]) row.state = "finished";
  console.log("{}");
} else if (args[0] === "rm") {
  state.terminals = state.terminals.filter(row => row.address !== args[1]);
  console.log("{}");
}
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(log));
`, { mode: 0o700 });
  writeFileSync(herdrApp, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const log = JSON.parse(fs.readFileSync(${JSON.stringify(logFile)}, "utf8"));
log.push(["herdr-app", ...args]);
if (args[0] === "ls") {
  console.log(JSON.stringify({ spaces: state.spaces }));
} else if (args[0] === "do" && args[1] === "space.close") {
  const id = args[args.indexOf("--id") + 1];
  state.spaces = state.spaces.filter(space => space.id !== id);
  console.log("{}");
}
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(log));
`, { mode: 0o700 });

  const seed = (spaces: unknown[]) => {
    writeFileSync(logFile, "[]");
    writeFileSync(stateFile, JSON.stringify({
      spaces,
      terminals: [
        { address: "t1", name: attemptName(a1), state: "live", labels: { "kunlun.run": runId, "kunlun.attempt": a1 } },
        { address: "t2", name: attemptName(a2), state: "finished", labels: { "kunlun.run": runId, "kunlun.attempt": a2 } },
        { address: "t9", name: "user-shell", state: "live", labels: {} },
      ],
    }));
  };

  seed([{ id: spaceId, tabs: [{ terminals: [{ terminal: "t1" }, { terminal: "t2" }] }] }]);
  const dedicated = new HerdrExecutor(hc, undefined, herdrApp);
  assert.deepEqual(await dedicated.cleanup(runId, [a1, a2]), { removedTerminals: 2, closedSpace: true });
  const afterDedicated = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.deepEqual(afterDedicated.spaces, []);
  assert.deepEqual(afterDedicated.terminals.map((row: { address: string }) => row.address), ["t9"]);

  seed([{ id: spaceId, tabs: [{ terminals: [{ terminal: "t1" }, { terminal: "t9" }] }] }]);
  assert.deepEqual(await dedicated.cleanup(runId, [a1, a2]), { removedTerminals: 2, closedSpace: false });
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).spaces.length, 1);

  seed([{ id: spaceId, tabs: [{ terminals: [{ terminal: "t1" }, { terminal: "t2" }] }] }]);
  const shared = new HerdrExecutor(hc, "shared-space", herdrApp);
  assert.deepEqual(await shared.cleanup(runId, [a1, a2]), { removedTerminals: 2, closedSpace: false });
  assert.equal(JSON.parse(readFileSync(logFile, "utf8")).some((call: string[]) => call[0] === "herdr-app"), false);
});
