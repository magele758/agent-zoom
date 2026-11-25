import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { loopbackProxy } from "../../../scripts/workflow-proxy.mjs";
import type { WorkflowAttempt, WorkflowEvent, WorkflowEvidence, WorkflowNode, WorkflowRun } from "../../workflow-types.ts";
import { resolveProjectHerdrSpace } from "../herdr-space-router.ts";

const exec = promisify(execFile);
const worker = fileURLToPath(new URL("../../../scripts/workflow-worker.mjs", import.meta.url));
const executorError = (error: unknown) => error instanceof Error ? error.message : String(error);
const childEnvironment: NodeJS.ProcessEnv = { ...process.env, HFLOW_WORKER: "1", KUNLUN_WORKFLOW_WORKER: "1" };
delete childEnvironment.WORKFLOW_SUBMIT_TOKEN;

export type ExecutionStatus = { state: "absent" } | { state: "running" | "finished"; terminal: string };
export type LaunchSpec = { attemptId: string; runId: string; nodeId: string; cwd: string; payload: string };
export type CleanupResult = { removedTerminals: number; closedSpace: boolean };
export interface WorkflowExecutor {
  readonly name: "herdr" | "local-demo";
  launch(spec: LaunchSpec): Promise<void>;
  status(attemptId: string): Promise<ExecutionStatus>;
  cleanup?(runId: string, attemptIds: string[]): Promise<CleanupResult>;
}

export function attemptName(attemptId: string) { return `kw-${attemptId.replaceAll("-", "").slice(0, 28)}`; }

const terminalRow = z.object({
  address: z.string().regex(/^t[a-z0-9]+$/),
  name: z.string(),
  state: z.enum(["live", "finished"]),
  labels: z.record(z.string(), z.string()).optional(),
});
const terminalList = z.array(terminalRow);
const terminalDetails = terminalRow.extend({ argv: z.array(z.string()).min(1) });
const recoveryShells = new Set(["sh", "zsh", "bash", "fish", "nu", "pwsh", "dash", "ksh"]);

export class HerdrExecutor implements WorkflowExecutor {
  readonly name = "herdr";

  constructor(private hc: string, private space?: string, private herdrApp = process.env.HERDR_APP_BIN ?? "herdr-app") {}

  async launch(spec: LaunchSpec) {
    const { attemptId, runId, nodeId, cwd, payload } = spec;
    let projectHint: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(payload, "utf8")) as { request?: { folder?: string } };
      if (typeof parsed.request?.folder === "string" && parsed.request.folder.trim()) {
        projectHint = parsed.request.folder.trim();
      }
    } catch {
      // Optional metadata read
    }
    const resolvedSpace = this.space
      ? { spaceId: this.space, spaceName: this.space, reused: true }
      : await resolveProjectHerdrSpace({
          workspace: cwd,
          project: projectHint,
          fallbackSpaceId: `sp${runId.replaceAll("-", "")}`,
          fallbackSpaceName: `OPC OS · ${runId.slice(0, 8)}`,
          herdrApp: this.herdrApp,
          env: childEnvironment,
        });
    const space = resolvedSpace.spaceId;
    const tab = `tb${attemptId.replaceAll("-", "")}`;
    const labels = ["--label", `kunlun.attempt=${attemptId}`, "--label", `kunlun.run=${runId}`,
      "--label", `kunlun.node=${nodeId}`, "--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`];
    await this.call(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", attemptName(attemptId),
      "--cwd", cwd, ...labels, "--", process.execPath, worker, payload]);

    // Core adopts the labelled terminal even when the desktop is closed. Naming the
    // adopted pane is presentation only and must never trigger a second launch.
    await this.nameTab(space, resolvedSpace.spaceName, resolvedSpace.reused, tab, nodeId, attemptId);
  }

  private async nameTab(space: string, spaceName: string, reusedSpace: boolean, tab: string, nodeId: string, attemptId: string) {
    const desktop = (args: string[]) => exec(this.herdrApp, args, { timeout: 1200, env: childEnvironment });
    try {
      for (let check = 0; check < 8; check++) {
        const state = JSON.parse((await desktop(["ls"])).stdout);
        const runSpace = state.spaces.find((item: { id: string }) => item.id === space);
        if (runSpace?.tabs.some((item: { id: string }) => item.id === tab)) {
          if (!this.space && !reusedSpace) await desktop(["do", "space.rename", "--id", space, "--name", spaceName]);
          await desktop(["do", "tab.rename", "--id", tab, "--name", `[OPC] ${nodeId} · ${attemptId.slice(0, 6)}`]);
          return;
        }
        await delay(100);
      }
    } catch {
      // A headless core retains both layout IDs for the desktop's next attachment.
    }
  }

  async status(attemptId: string): Promise<ExecutionStatus> {
    const output = JSON.parse(await this.call(["ls", "--all", "--json", "--label", `kunlun.attempt=${attemptId}`]));
    const rows = terminalList.parse(Array.isArray(output) ? output : output.terminals);
    if (rows.length === 0) return { state: "absent" };
    if (rows.length !== 1 || rows[0].name !== attemptName(attemptId) || (rows[0].labels && rows[0].labels["kunlun.attempt"] !== attemptId)) {
      throw new Error("Herdr 返回的 attempt 标签不唯一");
    }
    const { state, address } = rows[0];
    if (state === "finished") return { state, terminal: address };
    const detail = terminalDetails.parse(JSON.parse(await this.call(["get", address, "--json"])));
    if (detail.address !== address || detail.labels?.["kunlun.attempt"] !== attemptId || detail.name !== attemptName(attemptId)) {
      throw new Error("Herdr 会话标识已变化，需核对执行宿主");
    }
    // Desktop panes enable 'keep'. After a host crash the same live address
    // can be a replacement shell, while the original worker has already ended.
    const [, script, input] = detail.argv;
    const originalWorker = script && input && basename(script) === basename(worker) &&
      basename(input) === "payload.json" && basename(dirname(input)) === attemptId;
    if (detail.state === "finished" || recoveryShells.has(basename(detail.argv[0]))) return { state: "finished", terminal: address };
    if (!originalWorker) throw new Error("Herdr 会话的根程序无法识别，需核对执行宿主");
    return { state: "running", terminal: address };
  }

  async cleanup(runId: string, attemptIds: string[]): Promise<CleanupResult> {
    const expectedNames = new Set(attemptIds.map(attemptName));
    const expectedIds = new Set(attemptIds);
    const listRunTerminals = async () => {
      if (!expectedNames.size) return [];
      const output = JSON.parse(await this.call(["ls", "--all", "--json", "--label", `kunlun.run=${runId}`]));
      const rows = terminalList.parse(Array.isArray(output) ? output : output.terminals);
      return rows.filter(row => expectedNames.has(row.name) &&
        (!row.labels?.["kunlun.run"] || row.labels["kunlun.run"] === runId) &&
        (!row.labels?.["kunlun.attempt"] || expectedIds.has(row.labels["kunlun.attempt"])));
    };

    const initial = await listRunTerminals();
    const matchedAddresses = new Set(initial.map(row => row.address));
    let closedSpace = false;

    if (!this.space) {
      const spaceId = `sp${runId.replaceAll("-", "")}`;
      try {
        const state = JSON.parse((await exec(this.herdrApp, ["ls"], { timeout: 2000, env: childEnvironment })).stdout);
        const runSpace = (state.spaces ?? []).find((item: { id: string; tabs?: Array<{ terminals?: Array<{ terminal?: string }> }> }) =>
          item.id === spaceId);
        const onlyRunTerminals = runSpace && (runSpace.tabs ?? []).every((tab: { terminals?: Array<{ terminal?: string }> }) =>
          (tab.terminals ?? []).every(pane => !pane.terminal || matchedAddresses.has(pane.terminal)));
        if (onlyRunTerminals) {
          await exec(this.herdrApp, ["do", "space.close", "--id", spaceId, "--confirmed", "true"],
            { timeout: 3000, env: childEnvironment });
          closedSpace = true;
        }
      } catch {
        // Desktop may be closed or unreachable; still clean up terminals directly through hc.
      }
    }

    const remaining = await listRunTerminals();
    const remainingAddresses = new Set(remaining.map(row => row.address));
    const removed = new Set<string>([...matchedAddresses].filter(address => !remainingAddresses.has(address)));
    let killedAny = false;
    for (const row of remaining) {
      if (row.state !== "live") continue;
      try {
        await this.call(["kill", row.address]);
        killedAny = true;
      } catch {
        // Process may have exited between ls and kill.
      }
    }
    if (killedAny) await delay(120);
    for (const row of remaining) {
      let ok = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.call(["rm", row.address]);
          ok = true;
          break;
        } catch {
          if (attempt < 2) await delay(150);
        }
      }
      if (ok) removed.add(row.address);
    }
    return { removedTerminals: removed.size, closedSpace };
  }

  private async call(args: string[]) {
    try {
      return (await exec(this.hc, args, { timeout: 5000, maxBuffer: 512_000, env: childEnvironment })).stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`Herdr ${args[0]}: ${(stderr || executorError(error)).slice(0, 500)}`);
    }
  }
}

// Only the fixed demo runners may use this explicitly selected subprocess backend.
export class LocalDemoExecutor implements WorkflowExecutor {
  readonly name = "local-demo";

  constructor(private root: string) {}

  async launch(spec: LaunchSpec) {
    const output = openSync(join(this.root, spec.attemptId, "worker.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [worker, spec.payload], {
        cwd: spec.cwd, env: childEnvironment, detached: true, stdio: ["ignore", output, output],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      closeSync(output);
    }
  }

  async status(attemptId: string): Promise<ExecutionStatus> {
    const path = join(this.root, attemptId, "host.json");
    try {
      const { pid, finished } = JSON.parse(readFileSync(path, "utf8"));
      const terminal = `local:${pid}`;
      if (finished) return { state: "finished", terminal };
      process.kill(pid, 0);
      return { state: "running", terminal };
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return { state: "absent" };
      throw error;
    }
  }

  async cleanup(): Promise<CleanupResult> {
    return { removedTerminals: 0, closedSpace: false };
  }
}

export const MAX_RECEIPT_BYTES = 2_500_000;

export function readReceipt(path: string): unknown | undefined {
  try {
    if (statSync(path).size > MAX_RECEIPT_BYTES) throw new Error("回执文件过大");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function fenceAttempt(root: string, attemptId: string) {
  const directory = join(root, attemptId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(directory, "claim"), "fenced\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(join(directory, "claim"), "utf8") === "fenced\n";
    }
    throw error;
  }
}

export type WorkerPayload = {
  runId: string;
  attemptId: string;
  revision: number;
  base: string;
  inputTree?: string;
  reuseCheck?: WorkflowRun["revisions"][number]["reuseCheck"];
  reuseCatalog?: { repo: string; name: string; version: string; interfaceRef: string }[];
  node: WorkflowNode;
  request: Omit<WorkflowRun["request"], "plan">;
  worktree: string;
  boardUrl: string;
  backend: WorkflowExecutor["name"];
  upstream: Array<{ worktree: string; evidence: WorkflowEvidence; handoff?: string }>;
  feedback: WorkflowEvent[];
  runner: string[];
};

export async function prepareAttempt(root: string, run: Pick<WorkflowRun, "workspace" | "base">, attempt: WorkflowAttempt, payload: WorkerPayload) {
  const directory = join(root, attempt.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  await exec("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", attempt.worktree, run.base],
    { cwd: run.workspace, timeout: 20_000 });
  const applyEvidence = async (evidence: WorkflowEvidence) => {
    const patch = join(directory, `input-${evidence.attemptId}.patch`);
    writeFileSync(patch, evidence.patch, { flag: "wx", mode: 0o600 });
    try {
      await exec("git", ["apply", "--index", "--whitespace=nowarn", "--", patch], { cwd: attempt.worktree, timeout: 20_000 });
    } catch (error) {
      throw new Error(`节点 ${evidence.nodeId} 的差异无法应用到依赖工作区：${executorError(error)}`);
    }
  };
  // Attempts are reserved in dependency order. Their patches contain only the
  // changes made by that attempt, so a shared ancestor in a diamond applies once.
  const applied = new Set<string>();
  for (const { evidence } of payload.upstream) {
    if (evidence.nodeId === payload.node.id || evidence.outcome !== "succeeded" || applied.has(evidence.nodeId)) continue;
    applied.add(evidence.nodeId);
    if (evidence.patch) await applyEvidence(evidence);
  }
  const inputTree = (await exec("git", ["write-tree"], { cwd: attempt.worktree, timeout: 20_000 })).stdout.trim();
  if (payload.node.kind === "implement") {
    // Restore the last failed draft after pinning the baseline. A successful
    // replacement thus publishes one complete patch against its dependencies.
    const previous = payload.upstream.findLast(({ evidence }) => evidence.nodeId === payload.node.id)?.evidence;
    if (previous?.outcome === "failed" && previous.patch) await applyEvidence(previous);
  }
  if (payload.backend === "herdr") {
    const proxy = loopbackProxy(process.env);
    if (Object.keys(proxy).length) {
      writeFileSync(join(directory, "cli-proxy.json"), JSON.stringify(proxy), { flag: "wx", mode: 0o600 });
    }
  }
  const path = join(directory, "payload.json");
  writeFileSync(path, JSON.stringify({ ...payload, inputTree }), { flag: "wx", mode: 0o600 });
  return path;
}
