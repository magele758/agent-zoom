import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { loopbackProxy } from "./workflow-proxy.mjs";

const script = resolve(import.meta.dirname, "workflow-cli-agent.mjs");
function fixture(t, cli, role, { verdict = "succeeded", testCode = 0, agentCode = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opc-cli-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "test repo"),
    attempt = join(root, "attempt");
  mkdirSync(tree);
  mkdirSync(attempt);
  const payload = join(attempt, "payload.json"),
    output = join(attempt, "result.json");
  const literal = "literal $(touch side-effect) ; exit 1";
  writeFileSync(
    join(attempt, "cli-proxy.json"),
    JSON.stringify({ HTTP_PROXY: "http://127.0.0.1:18881", DEMO_UNTRUSTED: "ignored" }),
  );
  writeFileSync(
    payload,
    JSON.stringify({ worktree: tree, request: { goal: literal }, node: { kind: role }, upstream: [], feedback: [] }),
  );
  writeFileSync(
    join(root, cli),
    "#!/usr/bin/env node\n" +
      'if(process.argv[2]==="models"){console.log("gemini-fixture-medium\\tFixture"); process.exit(0); }\n' +
      'if(process.env.HTTP_PROXY!=="http://127.0.0.1:18881" || process.env.DEMO_UNTRUSTED) process.exit(17);\n' +
      'require("node:fs").writeFileSync("argv.json",JSON.stringify(process.argv.slice(2)));\n' +
      'console.log("OPC_RESULT "+JSON.stringify({outcome:' +
      JSON.stringify(verdict) +
      ',summary:"fixture"}));\n' +
      'console.error(\'OPC_RESULT {"outcome":"succeeded","summary":"stderr is diagnostic"}\'); process.exit(' +
      agentCode +
      ");",
    { mode: 0o700 },
  );
  const check =
    "if (process.argv[1]!==" +
    JSON.stringify(literal) +
    ') process.exit(22); if(process.env.HTTP_PROXY) process.exit(23); console.log("check-output"); process.exit(' +
    testCode +
    ")";
  const processResult = spawnSync(
    process.execPath,
    [script, cli, role, process.execPath, "-e", check, literal, payload, output],
    {
      encoding: "utf8",
      cwd: tree,
      env: {
        ...process.env,
        HTTP_PROXY: "",
        DEMO_UNTRUSTED: "",
        OPC_AGY_MODEL: "",
        PATH: root + delimiter + process.env.PATH,
      },
    },
  );
  return {
    processResult,
    report: () => JSON.parse(readFileSync(output, "utf8")),
    args: () => JSON.parse(readFileSync(join(tree, "argv.json"), "utf8")),
  };
}
test("each CLI uses a fresh worktree process; a real configured check and its output are recorded independently", (t) => {
  for (const cli of ["grok", "agy", "cursor-agent"]) {
    const h = fixture(t, cli, "implement");
    assert.equal(h.processResult.status, 0);
    assert.equal(h.report().outcome, "succeeded");
    assert.equal(h.report().checks[1].exitCode, 0);
    assert.match(h.report().checks[1].output, /check-output/);
    assert.equal(h.report().summary, "fixture");
    assert.equal(h.args().includes("--continue"), false);
    assert.equal(h.report().artifacts.length, cli === "agy" ? 4 : 3);
    if (cli === "agy") assert.ok(h.args().includes("gemini-fixture-medium"));
  }
});
test("only a supported read-only mode can review, and model or test failure cannot produce a pass", (t) => {
  const reviewer = fixture(t, "cursor-agent", "review", { verdict: "failed" });
  assert.ok(reviewer.args().includes("ask"));
  assert.ok(!reviewer.args().includes("--auto-review"));
  assert.equal(reviewer.report().outcome, "failed");
  for (const cli of ["agy", "grok"]) assert.notEqual(fixture(t, cli, "review").processResult.status, 0);
  const badTest = fixture(t, "agy", "implement", { testCode: 7 });
  assert.equal(badTest.report().outcome, "failed");
  assert.equal(badTest.report().checks[1].exitCode, 7);
  const badProcess = fixture(t, "grok", "implement", { agentCode: 4 });
  assert.equal(badProcess.report().outcome, "failed");
  assert.equal(badProcess.report().checks[0].exitCode, 4);
});

test("Herdr carries only unauthenticated loopback proxy origins into the coding CLI", () => {
  assert.deepEqual(
    loopbackProxy({
      HTTP_PROXY: "http://127.0.0.1:18881",
      https_proxy: "https://[::1]:18882",
      http_proxy: "http://proxy.example.org",
      HTTPS_PROXY: "http://user:password@localhost:18883",
      NO_PROXY: "private-domain.example",
      WORKFLOW_SUBMIT_TOKEN: "test-only-ignored",
      PATH: "/tmp",
    }),
    { HTTP_PROXY: "http://127.0.0.1:18881", https_proxy: "https://[::1]:18882" },
  );
  assert.deepEqual(
    loopbackProxy({ HTTP_PROXY: "http://localhost:18881/secret", HTTPS_PROXY: "http://localhost?q=secret" }),
    {},
  );
});
