import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { WorkflowAttempt, WorkflowCard, WorkflowDetail, WorkflowEvent, WorkflowPlan, WorkflowRequest, WorkflowRun, WorkflowSummary } from "../../workflow-types.ts";
import { acquireClaim, finishClaim, LEASE_MS, renewClaim } from "../claims.ts";
import { composeHandoff } from "../pipeline.ts";
import { ApiError } from "../logic.ts";
import { ReuseAdmission } from "../reuse-admission.ts";
import {
  activeNodes, conflict, currentRevision, decisionSchema, evidenceSchema, gateDecision, latestAttempt,
  parse, opportunitySubmission, planGoal, recoverySchema, requestSchema, revisionSchema, runnerSchema, succeeded, validatePlan,
} from "./contract.ts";
import { fenceAttempt, prepareAttempt, readReceipt, type WorkflowExecutor, type WorkerPayload } from "./executor.ts";
import { draftWorkflowPlan } from "./planner.ts";
import { workflowMessages } from "../zoom-workflow.ts";

type Config = {
  workspace: string;
  projectWorkspaces?: Record<string, string>;
  attemptRoot: string;
  backendKey: string;
  hostKey?: string;
  boardUrl: string;
  implement: string[];
  review: string[];
  capabilities?: Record<string, string[]>;
  planner?: "local" | "coordinator";
};

const exec = promisify(execFile);
const json = (value: unknown) => JSON.stringify(value);
function isInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function runnerLabel(argv: string[]) {
  const script = basename(argv[1] ?? "");
  if (script === "workflow-cli-agent.mjs") {
    const labels: Record<string, string> = { grok: "Grok CLI", agy: "Antigravity CLI", "cursor-agent": "Cursor Agent" };
    return labels[argv[2]] ?? argv[2];
  }
  if (script === "workflow-codex.mjs") return "Codex CLI";
  if (script === "workflow-demo-implement.mjs") return "演示实现脚本";
  if (script === "workflow-demo-review.mjs") return "独立演示评审脚本";
  return /\.(?:js|mjs|ts|py|sh)$/.test(script) ? script : basename(argv[0]);
}
const inFlight = (attempt: WorkflowAttempt) => ["dispatching", "running", "unknown"].includes(attempt.state);

function event(run: WorkflowRun, kind: string, note: string, data: Partial<WorkflowEvent> = {}) {
  run.events.push({ at: new Date().toISOString(), kind, revision: currentRevision(run).number, note, ...data });
}
function addCard(run: WorkflowRun, kind: WorkflowCard["kind"], nodeId?: string) {
  const card: WorkflowCard = { id: randomUUID(), kind, revision: currentRevision(run).number, nodeId, status: "open" };
  run.cards.push(card);
  event(run, "card_opened", kind, { cardId: card.id, nodeId });
}
function currentCard(run: WorkflowRun, kind: "plan" | "final") {
  return run.cards.find(card => card.kind === kind && card.revision === currentRevision(run).number);
}
function advanceCards(run: WorkflowRun) {
  const { plan } = currentRevision(run);
  const active = activeNodes(plan);
  for (const node of plan.nodes) {
    if (node.kind === "gate" && active.has(node.id) && run.released.includes(node.id) &&
        !gateDecision(run, node.id) && node.dependsOn.every(id => succeeded(run, id))) addCard(run, "gate", node.id);
  }
  if (currentCard(run, "plan")?.status === "approve" && !currentCard(run, "final") &&
      [...active].every(id => succeeded(run, id))) addCard(run, "final");
}
function summarize(run: WorkflowRun): WorkflowSummary {
  const revision = currentRevision(run);
  const active = activeNodes(revision.plan);
  const final = currentCard(run, "final");
  const plan = currentCard(run, "plan");
  const issues = run.attempts.some(attempt => active.has(attempt.nodeId) &&
    latestAttempt(run, attempt.nodeId)?.id === attempt.id && ["failed", "unknown"].includes(attempt.state));
  const awaitingRevision = run.cards.some(card => card.revision === revision.number &&
    ["changes", "reject"].includes(card.status));
  const review = revision.plan.acceptance.some(id => latestAttempt(run, id)) ||
    revision.plan.nodes.filter(node => active.has(node.id) && node.kind === "implement").every(node => succeeded(run, node.id));
  const phase = final?.status === "approve" ? "complete" : final ? "acceptance"
    : plan?.status !== "approve" && !run.attempts.length ? "planning" : review ? "review" : "execution";
  const turn = phase === "complete" ? "done" : run.cards.some(card => card.status === "open") ? "human"
    : issues ? "recovery" : "agent";
  return { id: run.id, goal: run.request.goal, source: run.request.source, revision: revision.number, phase, eventCount: run.events.length,
    waitingForRevision: awaitingRevision && turn !== "human" && turn !== "done",
    turn: awaitingRevision && turn === "recovery" ? "agent" : turn };
}

function loadRun(db: DatabaseSync, id: string): WorkflowRun {
  const row = db.prepare("SELECT snapshot FROM workflow_runs WHERE id=?").get(id);
  if (!row) throw new ApiError(404, "workflow_missing", "找不到这条运行");
  return JSON.parse(String(row.snapshot));
}

export function readPausedWorkflow(db: DatabaseSync, id: string): WorkflowDetail {
  const run = loadRun(db, id);
  return { ...run, summary: { ...summarize(run), readOnly: true,
    blockedReason: "当前未启用工作流执行器。可以查看已保存的计划、证据和反馈，恢复原工作流配置后可继续处理。" } };
}

export class WorkflowService {
  private ticking = false;
  // The optional source queue owns project admission. Its check runs in the plan's write transaction.
  claimProjectSlot?: (runId: string) => void;
  fromOpportunity?: (id: string) => WorkflowDetail;
  private drafting = new Map<string, { request: WorkflowRequest; result: Promise<WorkflowDetail> }>();
  private snapshotCache = new Map<string, { raw: string; summary: WorkflowSummary; messages: ReturnType<typeof workflowMessages> }>();

  constructor(private db: DatabaseSync, private config: Config, private executor: WorkflowExecutor,
    private draft = draftWorkflowPlan) {}

  private atomic<T>(operation: () => T) {
    if (this.db.isTransaction) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  workspaceProjects(): string[] {
    return [...new Set([basename(this.config.workspace), ...Object.keys(this.config.projectWorkspaces ?? {})])].sort();
  }

  workspaceForProject(project: string): string | undefined {
    const bindings = this.config.projectWorkspaces;
    if (bindings && Object.hasOwn(bindings, project)) return bindings[project];
    if (project === basename(this.config.workspace)) return this.config.workspace;
  }

  private workspaceForRequest(request: WorkflowRequest) {
    return request.projectKey ? this.workspaceForProject(request.projectKey) : this.config.workspace;
  }

  private load(id: string): WorkflowRun {
    return loadRun(this.db, id);
  }

  private summary(run: WorkflowRun): WorkflowSummary {
    const summary = summarize(run);
    if (this.sameBackend(run) || summary.phase === "complete" || currentCard(run, "final")?.status === "open") return summary;
    if (!this.sameHost(run)) return { ...summary, turn: "recovery", waitingForRevision: false,
      blockedReason: "请恢复原工作区和宿主配置，才能对账或继续派发。" };
    return { ...summary, turn: "agent", waitingForRevision: true,
      blockedReason: "执行器配置已变更。正在对账已启动的尝试。请发起者基于当前版本重新提交计划，经人工确认后继续派发。" };
  }

  private change(id: string, operation: (run: WorkflowRun) => boolean): WorkflowDetail {
    return this.atomic(() => {
      const run = this.load(id);
      if (operation(run)) {
        advanceCards(run);
        this.db.prepare("UPDATE workflow_runs SET snapshot=? WHERE id=?").run(json(run), id);
      }
      return this.detail(run);
    });
  }

  get(id: string): WorkflowDetail {
    return this.detail(this.load(id));
  }

  private detail(run: WorkflowRun): WorkflowDetail {
    const runners = this.sameBackend(run) ? {
      implement: runnerLabel(this.config.implement), review: runnerLabel(this.config.review),
      capabilities: Object.entries(this.config.capabilities ?? {}).map(([id, argv]) => ({ id, label: runnerLabel(argv) })),
    } : undefined;
    return { ...run, summary: this.summary(run), ...(runners && { runners }) };
  }

  private cachedRuns() {
    const rows = this.db.prepare("SELECT id,snapshot FROM workflow_runs ORDER BY created_at DESC, id").all() as Array<{ id: string; snapshot: string }>;
    const seen = new Set<string>();
    const entries = rows.map(row => {
      seen.add(row.id);
      const cached = this.snapshotCache.get(row.id);
      if (cached && cached.raw === row.snapshot) return cached;
      const run = JSON.parse(row.snapshot) as WorkflowRun;
      const summary = this.summary(run);
      const messages = workflowMessages(run, {
        sameHost: this.sameHost(run), sameBackend: this.sameBackend(run), blockedReason: summary.blockedReason,
      });
      const entry = { raw: row.snapshot, summary, messages };
      this.snapshotCache.set(row.id, entry);
      return entry;
    });
    if (this.snapshotCache.size > seen.size) {
      for (const id of this.snapshotCache.keys()) if (!seen.has(id)) this.snapshotCache.delete(id);
    }
    return entries;
  }

  list(): WorkflowSummary[] {
    return this.cachedRuns().map(entry => entry.summary);
  }

  messages() {
    return this.cachedRuns().flatMap(entry => entry.messages);
  }

  private runs(): WorkflowRun[] {
    return this.db.prepare("SELECT snapshot FROM workflow_runs ORDER BY created_at DESC, id").all()
      .map(row => JSON.parse(String(row.snapshot)));
  }

  private existingRequest(request: WorkflowRequest) {
    const row = this.db.prepare("SELECT id FROM workflow_runs WHERE request_id=?").get(request.requestId);
    if (!row) return;
    const existing = this.get(String(row.id));
    if (json(existing.request) !== json(request)) conflict("该请求 ID 已绑定其他内容");
    return existing;
  }

  private linkedSubmission(input: unknown) {
    if (!input || typeof input !== "object" || !("opportunityId" in input)) return;
    const { opportunityId } = parse(opportunitySubmission, input);
    if (!this.fromOpportunity) return conflict("当前未启用选题目录");
    return this.fromOpportunity(opportunityId);
  }

  private assertDirect(request: WorkflowRequest, registry: ReuseAdmission) {
    if (/^opc-[0-9a-f-]{36}$/i.test(request.requestId)) conflict("研发候选请求 ID 由 OPC OS 登记");
    registry.assertDirect(request);
  }

  // Only the local source queue supplies these validated records, inside its write transaction.
  submitOpportunity(input: WorkflowRequest, policy?: WorkflowRun["reusePolicy"]): WorkflowDetail {
    const request = parse(requestSchema, input);
    if (!request.plan) return conflict("选题需要完整计划");
    return this.saveRequest(request, request.plan, "根据研发候选和登记记录起草", { policy });
  }

  async submitPlanned(input: unknown): Promise<WorkflowDetail> {
    const linked = this.linkedSubmission(input);
    if (linked) return linked;
    const request = parse(requestSchema, input);
    if (request.plan || this.config.planner !== "coordinator") return this.submit(request);
    const existing = this.existingRequest(request);
    if (existing) return existing;
    this.assertDirect(request, new ReuseAdmission(this.db));
    const pending = this.drafting.get(request.requestId);
    if (pending) {
      if (json(pending.request) !== json(request)) conflict("该请求 ID 已绑定其他内容");
      return pending.result;
    }
    const result = this.draft(request, this.config.capabilities ?? {})
      .then(({ plan, reason }) => this.saveRequest(request, plan, reason))
      .finally(() => this.drafting.delete(request.requestId));
    this.drafting.set(request.requestId, { request, result });
    return result;
  }

  submit(input: unknown): WorkflowDetail {
    const linked = this.linkedSubmission(input);
    if (linked) return linked;
    const request = parse(requestSchema, input);
    return this.saveRequest(request, request.plan ?? planGoal(request), request.plan ? "发起者提交草案" : "OPC OS按目标和约束生成两步计划");
  }

  private saveRequest(request: WorkflowRequest, plan: WorkflowPlan, reason: string, source?: { policy?: WorkflowRun["reusePolicy"] }): WorkflowDetail {
    return this.atomic(() => {
      const existing = this.existingRequest(request);
      if (existing) return existing;
      const registry = new ReuseAdmission(this.db);
      if (!source) this.assertDirect({ ...request, plan }, registry);
      const reuseCheck = registry.reviewCheck(request.goal + "\n" + plan.nodes.map(n => n.instruction).join("\n"), source?.policy);
      validatePlan(plan, new Set(), this.config.capabilities);
      const workspace = this.workspaceForRequest(request);
      if (!workspace) throw new ApiError(409, "workflow_workspace", "这个项目还没有绑定本地 Git 仓库");
      let base: string;
      try {
        base = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"],
          { cwd: workspace, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch {
        throw new ApiError(409, "workflow_workspace", "项目需要可读取的 Git 基线提交");
      }
      const id = randomUUID();
      const run: WorkflowRun = {
        id, request, workspace, base, boardUrl: `${this.config.boardUrl}/#workflows/${id}`,
        backend: this.executor.name, backendKey: this.config.backendKey, hostKey: this.config.hostKey, createdAt: new Date().toISOString(),
        ...(source?.policy && { reusePolicy: source.policy }),
        revisions: [{ number: 1, reason, reuseCheck,
          plan, gatedNodes: plan.nodes.map(node => node.id) }],
        cards: [], attempts: [], released: [], events: [],
      };
      event(run, "submitted", request.context, { actor: request.source });
      addCard(run, "plan");
      this.db.prepare("INSERT INTO workflow_runs (id,request_id,created_at,snapshot) VALUES (?,?,?,?)")
        .run(run.id, request.requestId, run.createdAt, json(run));
      return this.detail(run);
    });
  }

  selectRunner(id: string, input: unknown, actor: string) {
    const choice = parse(runnerSchema, input);
    const run = this.load(id);
    if (!this.sameBackend(run)) conflict("请先恢复此任务的执行器配置");
    const base = run.revisions.find(r => r.number === choice.baseRevision);
    const node = base?.plan.nodes.find(n => n.id === choice.nodeId);
    if (!base || !node || node.kind !== "implement") return conflict("只能为实现节点选择执行器");
    if (choice.capability !== null && !Object.hasOwn(this.config.capabilities ?? {}, choice.capability)) conflict("此执行器未配置");
    const { capability: original, ...rest } = node;
    if ((original ?? null) === choice.capability) conflict("节点已使用该执行器");
    const changed = choice.capability === null ? rest : { ...rest, capability: choice.capability };
    return this.revise(id, { baseRevision: choice.baseRevision, reason: `为 ${node.title} 选择 ${choice.capability ?? "默认执行器"}`,
      plan: { ...base.plan, nodes: base.plan.nodes.map(n => n.id === node.id ? changed : n) } }, {actor, cardId:choice.cardId});
  }

  revise(id: string, input: unknown, fromBoard?: {actor: string; cardId: string}) {
    const revision = parse(revisionSchema, input);
    return this.change(id, run => {
      const previous = currentRevision(run);
      if (fromBoard && !run.cards.some(card => card.id === fromBoard.cardId && card.kind === "plan" && card.revision === revision.baseRevision)) conflict("找不到对应的计划卡片");
      if (previous.number !== revision.baseRevision) {
        if (previous.number === revision.baseRevision + 1 && previous.reason === revision.reason &&
            json(previous.plan) === json(revision.plan)) return false;
        conflict("计划版本已更新，请刷新后重试");
      }
      const final = currentCard(run, "final");
      if (fromBoard && (currentCard(run, "plan")?.status !== "open" || !this.sameBackend(run))) conflict("这份计划已处理或执行配置已改变");
      if (final?.status === "approve") conflict("运行已验收");
      if (!this.sameHost(run)) conflict("请先恢复原工作区和宿主配置");
      const rebinding = !this.sameBackend(run);
      const started = new Set([...run.attempts.map(attempt => attempt.nodeId),
        ...run.cards.flatMap(card => card.nodeId && card.status === "approve" ? [card.nodeId] : [])]);
      if (final && ["changes", "reject"].includes(final.status) && revision.plan.acceptance.every(id => started.has(id))) {
        conflict("验收退回后需要新增 review 节点");
      }
      validatePlan(revision.plan, started, this.config.capabilities);
      const oldNodes = new Map(previous.plan.nodes.map(node => [node.id, node]));
      const newNodes = new Map(revision.plan.nodes.map(node => [node.id, node]));
      for (const nodeId of started) {
        if (json(oldNodes.get(nodeId)) !== json(newNodes.get(nodeId))) conflict(`已启动节点 ${nodeId} 的定义和依赖必须保留`);
      }
      const startedOrder = (nodes: typeof previous.plan.nodes) => nodes.filter(node => started.has(node.id)).map(node => node.id);
      if (json(startedOrder(previous.plan.nodes)) !== json(startedOrder(revision.plan.nodes))) conflict("已启动节点的顺序必须保留");
      const active = activeNodes(revision.plan);
      if ([...started].some(id => oldNodes.get(id)?.kind === "implement" && !active.has(id))) {
        conflict("已启动的实现节点必须保留在验收依赖中");
      }
      if (run.attempts.some(attempt => inFlight(attempt) && !active.has(attempt.nodeId))) {
        conflict("运行中的节点完成或对账后才可更换其验收路径");
      }
      const removedReview = previous.plan.acceptance.some(id => started.has(id) && !active.has(id));
      if (removedReview && revision.plan.acceptance.every(id => started.has(id))) {
        conflict("替换已启动的验收评审需要提供新的 review 节点");
      }
      const changed = new Set(revision.plan.nodes.filter(node =>
        json(node) !== json(oldNodes.get(node.id)) || ["changes", "reject"].includes(gateDecision(run, node.id)?.status ?? ""))
        .map(node => node.id));
      const registry = new ReuseAdmission(this.db);
      if (run.reusePolicy) {
        const scoped = run.revisions[0].plan.nodes;
        for (const node of revision.plan.nodes) {
          if (node.kind === "gate") continue;
          const allowed = scoped.find(n => n.kind === node.kind)!;
          if (node.title !== allowed.title || node.instruction !== allowed.instruction ||
              (node.kind === "implement" && node.id !== allowed.id)) {
            conflict("计划应保留已登记的集成或已批准的原仓需求范围。范围变化请另提能力需求");
          }
        }
      } else {
        const newInstructions = revision.plan.nodes.filter(n => {
          const old = oldNodes.get(n.id);
          return !old || n.instruction !== old.instruction || n.title !== old.title;
        });
        registry.assertDirect({ goal: "", context: "", constraints: [], plan: { nodes: newInstructions, acceptance: [] } });
      }
      const reuseCheck = registry.reviewCheck(run.request.goal + "\n" + revision.plan.nodes.map(n => n.instruction).join("\n"), run.reusePolicy);
      let gatedNodes = revision.plan.nodes.filter(node => active.has(node.id) &&
        (!run.released.includes(node.id) || [...activeNodes(revision.plan, [node.id])].some(id => changed.has(id))))
        .map(node => node.id);
      if (gatedNodes.some(nodeId => started.has(nodeId) && run.released.includes(nodeId))) {
        conflict("变更会影响已启动节点");
      }

      for (const card of run.cards) {
        if (card.status === "open") card.status = "superseded";
      }
      if (rebinding) {
        for (const attempt of run.attempts.filter(inFlight)) attempt.claimOwner ??= run.backendKey;
        run.backendKey = this.config.backendKey;
        run.hostKey = this.config.hostKey;
        run.released = [];
        gatedNodes = [...active].filter(nodeId => {
          const attempt = latestAttempt(run, nodeId);
          return !succeeded(run, nodeId) && !(attempt && inFlight(attempt));
        });
      } else {
        run.released = run.released.filter(nodeId => active.has(nodeId) && !gatedNodes.includes(nodeId));
      }
      this.claimProjectSlot?.(id);
      run.cleanedAt = undefined;
      run.revisions.push({ number: previous.number + 1, reason: revision.reason, plan: revision.plan, gatedNodes, reuseCheck });
      event(run, "revised", revision.reason, { actor: fromBoard?.actor ?? run.request.source });
      if (rebinding) event(run, "rebound", "本版本使用当前执行器配置，需要重新批准");
      addCard(run, "plan");
      return true;
    });
  }

  decide(id: string, input: unknown, actor: string) {
    const decision = parse(decisionSchema, input);
    return this.change(id, run => {
      if (currentRevision(run).number !== decision.revision) conflict("审批卡片版本已过时");
      const card = run.cards.find(card => card.id === decision.cardId);
      if (!card || card.revision !== decision.revision) return conflict("审批卡片版本已过时");
      if (card.status === decision.action && card.note === decision.note && card.actor === actor) return false;
      if (card.status !== "open") conflict("审批卡片已经处理");
      if (card.kind === "plan" && decision.action === "approve" && !this.sameBackend(run)) {
        conflict(this.summary(run).blockedReason ?? "执行器配置已变化，请重新提交计划");
      }
      card.status = decision.action;
      card.note = decision.note;
      card.actor = actor;
      if (card.kind === "plan" && decision.action === "approve") {
        this.claimProjectSlot?.(id);
        run.released = [...activeNodes(currentRevision(run).plan)];
      } else if (card.kind === "plan") {
        run.released = [];
        for (const open of run.cards) {
          if (open.status === "open" && open.revision === decision.revision) open.status = "superseded";
        }
      }
      event(run, `decision_${decision.action}`, decision.note, { cardId: card.id, nodeId: card.nodeId, actor });
      return true;
    });
  }

  async cleanupRun(id: string, actor: string): Promise<WorkflowDetail> {
    const run = this.load(id);
    if (run.cleanedAt) return this.detail(run);
    if (!this.sameHost(run)) conflict("请先恢复原工作区和宿主配置后再清理执行现场");
    if (run.attempts.some(inFlight)) conflict("仍有运行中或待对账的尝试，无法清理执行现场");
    const summary = summarize(run);
    const revision = currentRevision(run);
    const rejected = run.cards.some(card => card.revision === revision.number && card.status === "reject");
    if (summary.phase !== "complete" && !rejected) {
      conflict("只有已验收完成或已拒绝的运行才能清理终端与工作树");
    }
    const hostResult = (await this.executor.cleanup?.(run.id, run.attempts.map(attempt => attempt.id))) ??
      { removedTerminals: 0, closedSpace: false };
    let removedWorktrees = 0;
    for (const attempt of run.attempts) {
      if (!isInside(this.config.attemptRoot, attempt.worktree) || !existsSync(attempt.worktree)) continue;
      try {
        await exec("git", ["-C", run.workspace, "worktree", "remove", "--force", attempt.worktree], { timeout: 15_000 });
      } catch {
        // Fallback if detached git worktree metadata was already pruned.
      }
      if (existsSync(attempt.worktree)) rmSync(attempt.worktree, { recursive: true, force: true });
      removedWorktrees++;
    }
    if (run.attempts.length > 0 && existsSync(run.workspace)) {
      try {
        await exec("git", ["-C", run.workspace, "worktree", "prune"], { timeout: 10_000 });
      } catch {
        // Ignore prune errors if workspace git metadata is unavailable.
      }
    }
    return this.change(id, current => {
      if (current.cleanedAt || current.attempts.some(inFlight)) return false;
      current.cleanedAt = new Date().toISOString();
      const summaryParts = [`已清理 ${removedWorktrees} 个临时工作树`];
      if (hostResult.removedTerminals > 0) summaryParts.push(`${hostResult.removedTerminals} 个终端`);
      const note = `${summaryParts.join("、")}${hostResult.closedSpace ? "并关闭 Herdr 空间" : ""}；回执与差异已保留。`;
      event(current, "cleaned", note, { actor });
      return true;
    });
  }

  retry(id: string, input: unknown, actor: string) {
    const request = parse(recoverySchema, input);
    return this.change(id, run => {
      const previous = run.attempts.find(attempt => attempt.id === request.attemptId);
      if (!previous) return conflict("找不到原尝试");
      if (currentRevision(run).number !== request.revision) conflict("重试所用计划版本已过时");
      if (!this.sameBackend(run)) conflict(this.summary(run).blockedReason ?? "请核对执行器配置");
      const retryEvent = run.events.find(event => event.kind === "retry" && event.attemptId === previous.id);
      if (retryEvent) {
        if (retryEvent.note === request.note && retryEvent.actor === actor) return false;
        conflict("该尝试已经安排重试");
      }
      if (previous.state !== "failed" || !run.released.includes(previous.nodeId) ||
          latestAttempt(run, previous.nodeId)?.id !== previous.id) conflict("只有当前已结束的失败尝试可以重试");
      event(run, "retry", request.note, { actor, nodeId: previous.nodeId, attemptId: previous.id });
      return true;
    });
  }

  async recover(id: string, input: unknown, actor: string) {
    const request = parse(recoverySchema, input);
    const run = this.get(id);
    const attempt = run.attempts.find(attempt => attempt.id === request.attemptId);
    if (!attempt) return conflict("找不到待对账尝试");
    if (run.events.some(event => event.kind === "fenced" && event.attemptId === attempt.id &&
      event.revision === request.revision && event.note === request.note && event.actor === actor)) return run;
    if (currentRevision(run).number !== request.revision || latestAttempt(run, attempt.nodeId)?.id !== attempt.id ||
        attempt.state !== "unknown" || !this.sameHost(run)) return conflict("尝试已变化，或执行宿主不可用");
    let status;
    try { status = await this.executor.status(attempt.id); }
    catch { return conflict("执行宿主尚不可对账"); }
    if (status.state === "running") {
      await this.reconcile(run, attempt);
      return this.get(id);
    }
    let receipt: unknown;
    try { receipt = readReceipt(join(this.config.attemptRoot, attempt.id, "receipt.json")); }
    catch (error) {
      if (status.state !== "finished") return conflict(`回执仍待核查：${(error as Error).message}`);
    }
    if (receipt !== undefined) {
      try {
        return this.recordReceipt(run.id, receipt, status.state === "finished" ? status.terminal : undefined, attempt.id);
      } catch (error) {
        if (!(error instanceof ApiError) || status.state !== "finished") throw error;
      }
    }
    return this.change(run.id, current => {
      const live = latestAttempt(current, attempt.nodeId);
      if (currentRevision(current).number !== request.revision || live?.id !== attempt.id || live.state !== "unknown") {
        return conflict("对账期间尝试已更新");
      }
      if (status.state === "absent" && !fenceAttempt(this.config.attemptRoot, live.id)) {
        conflict("执行器曾领取该尝试，需要找回宿主记录或结构化回执");
      }
      live.state = "failed";
      live.problem = status.state === "finished" ? "人工核对终端已结束，未获得有效回执" : "未领取的尝试已封存";
      this.finishLease(current, live);
      event(current, "fenced", request.note, { actor, nodeId: live.nodeId, attemptId: live.id });
      return true;
    });
  }

  // The payload's revision stays with the attempt across later plan revisions.
  recordReceipt(id: string, input: unknown, terminal?: string, expectedAttemptId?: string) {
    const evidence = parse(evidenceSchema, input);
    return this.change(id, run => {
      const attempt = latestAttempt(run, evidence.nodeId);
      if (evidence.runId !== run.id || (expectedAttemptId && evidence.attemptId !== expectedAttemptId) ||
          attempt?.id !== evidence.attemptId || attempt.revision !== evidence.revision) {
        return conflict("回执不属于当前尝试");
      }
      const node = run.revisions[attempt.revision - 1].plan.nodes.find(node => node.id === attempt.nodeId);
      if (node?.kind === "review" && evidence.outcome === "succeeded" && evidence.patch) {
        conflict("独立 review 不可携带实现改动");
      }
      if (json(attempt.evidence) === json(evidence)) return false;
      if (!inFlight(attempt)) conflict("尝试已有终态");
      attempt.terminal = terminal ?? attempt.terminal;
      attempt.state = evidence.outcome;
      attempt.problem = undefined;
      attempt.evidence = evidence;
      this.finishLease(run, attempt);
      event(run, "receipt", evidence.summary, { nodeId: attempt.nodeId, attemptId: attempt.id, revision: attempt.revision });
      return true;
    });
  }

  private sameBackend(run: WorkflowRun) {
    return run.backend === this.executor.name && run.backendKey === this.config.backendKey && run.workspace === this.workspaceForRequest(run.request);
  }

  private sameHost(run: WorkflowRun) {
    // Before runner binding was introduced, backendKey identified only the host.
    return this.sameBackend(run) || (run.backend === this.executor.name && run.workspace === this.workspaceForRequest(run.request) &&
      this.config.hostKey !== undefined && (run.hostKey ?? run.backendKey) === this.config.hostKey);
  }

  private finishLease(run: WorkflowRun, attempt: WorkflowAttempt) {
    const plan = run.revisions[attempt.revision - 1].plan;
    const role = plan.nodes.find(node => node.id === attempt.nodeId)?.kind === "review" ? "reviewer" : "implementer";
    finishClaim(this.db, "workflow_claims", `${run.id}/${attempt.nodeId}`, role, attempt.claimOwner ?? run.backendKey, attempt.state);
  }

  private setState(id: string, attemptId: string, state: WorkflowAttempt["state"], problem?: string, terminal?: string) {
    this.change(id, run => {
      const attempt = run.attempts.find(item => item.id === attemptId);
      if (!attempt || !inFlight(attempt)) return false;
      const address = terminal ?? attempt.terminal;
      let renewed = false;
      if (state === "running" && (!attempt.leaseUntil || Date.parse(attempt.leaseUntil) < Date.now() + LEASE_MS / 2)) {
        const taskId = `${run.id}/${attempt.nodeId}`;
        // Older local snapshots predate the durable claim table.
        const role = run.revisions[attempt.revision - 1].plan.nodes.find(node => node.id === attempt.nodeId)?.kind;
        const owner = attempt.claimOwner ?? run.backendKey;
        attempt.leaseUntil = renewClaim(this.db, "workflow_claims", taskId, owner) ??
          acquireClaim(this.db, "workflow_claims", attempt.id, taskId, role === "review" ? "reviewer" : "implementer", owner);
        renewed = true;
      }
      if (attempt.state === state && attempt.problem === problem && attempt.terminal === address) return renewed;
      Object.assign(attempt, { state, problem, terminal: address });
      if (state === "failed") this.finishLease(run, attempt);
      event(run, state, problem ?? address ?? "", { nodeId: attempt.nodeId, attemptId, revision: attempt.revision });
      return true;
    });
  }

  private async reconcile(run: WorkflowRun, attempt: WorkflowAttempt) {
    if (!this.sameHost(run)) return;
    const path = join(this.config.attemptRoot, attempt.id, "receipt.json");
    let status;
    let issue = "未找到启动回执，等待对账";
    try {
      status = await this.executor.status(attempt.id);
    } catch (error) {
      issue = String(error);
    }
    let invalidReceipt = false;
    try {
      const evidence = readReceipt(path);
      if (evidence !== undefined) {
        this.recordReceipt(run.id, evidence, status?.state === "absent" ? undefined : status?.terminal, attempt.id);
        return;
      }
    } catch (error) {
      invalidReceipt = true;
      issue = `回执待检查：${(error as Error).message}`;
    }
    if (status?.state === "finished") {
      this.setState(run.id, attempt.id, "unknown", `终端已结束。 ${issue}`, status.terminal);
    } else if (status?.state === "running" && !invalidReceipt) {
      this.setState(run.id, attempt.id, "running", undefined, status.terminal);
    } else {
      this.setState(run.id, attempt.id, "unknown", issue);
    }
  }

  private reserve(id: string): WorkflowAttempt | undefined {
    let reserved: WorkflowAttempt | undefined;
    this.change(id, run => {
      if (!this.sameBackend(run) || currentCard(run, "final")?.status === "approve") return false;
      const revision = currentRevision(run);
      const approved = run.cards.findLast(card => card.kind === "plan" && card.status === "approve");
      if (!approved) return false;
      for (const node of revision.plan.nodes) {
        if (node.kind === "gate" || !run.released.includes(node.id) || !node.dependsOn.every(id => succeeded(run, id))) continue;
        const earlier = latestAttempt(run, node.id);
        if (earlier && (earlier.state !== "failed" ||
          !run.events.some(event => event.kind === "retry" && event.attemptId === earlier.id))) continue;
        const id = randomUUID();
        const leaseUntil = acquireClaim(this.db, "workflow_claims", id, `${run.id}/${node.id}`,
          node.kind === "review" ? "reviewer" : "implementer", run.backendKey);
        reserved = { id, nodeId: node.id, revision: approved.revision, state: "dispatching", leaseUntil, claimOwner: run.backendKey,
          worktree: join(this.config.attemptRoot, id, "worktree") };
        run.attempts.push(reserved);
        event(run, "dispatching", "", { nodeId: node.id, attemptId: id, revision: approved.revision });
        return true;
      }
      return false;
    });
    return reserved;
  }

  private async launch(run: WorkflowRun, attempt: WorkflowAttempt) {
    const revision = run.revisions[attempt.revision - 1];
    const node = revision.plan.nodes.find(node => node.id === attempt.nodeId)!;
    const upstream = activeNodes(revision.plan, [node.id]);
    const { plan, ...request } = run.request;
    const payload: WorkerPayload = {
      runId: run.id, attemptId: attempt.id, revision: attempt.revision, base: run.base, node, request,
      ...(revision.reuseCheck && { reuseCheck: revision.reuseCheck,
        reuseCatalog: new ReuseAdmission(this.db).capabilities.map(({repo, name, version, interfaceRef}) => ({repo, name, version, interfaceRef})) }),
      worktree: attempt.worktree, boardUrl: run.boardUrl, backend: this.executor.name,
      runner: node.kind === "review" ? this.config.review :
        node.capability ? this.config.capabilities![node.capability] : this.config.implement,
      upstream: run.attempts.flatMap(item => upstream.has(item.nodeId) && item.id !== attempt.id && item.evidence
        ? [{ worktree: item.worktree, evidence: item.evidence, handoff: composeHandoff({
          demand: run.request.goal, acceptance: node.instruction, role: revision.plan.nodes.find(n => n.id === item.nodeId)?.kind ?? "",
          handle: item.nodeId, ref: item.id, summary: item.evidence.summary,
          body: item.evidence.checks.map(check => `${check.name} · exit ${check.exitCode}`).join("\n"),
        }) }] : []),
      feedback: run.events.filter(event => event.kind.startsWith("decision_") || ["retry", "revised", "fenced"].includes(event.kind) ||
        (event.kind === "receipt" && run.attempts.some(a => a.id === event.attemptId && a.state === "failed"))),
    };
    let path;
    try {
      path = await prepareAttempt(this.config.attemptRoot, run, attempt, payload);
    } catch (error) {
      this.setState(run.id, attempt.id, "failed", `准备隔离工作区失败：${(error as Error).message}`);
      return;
    }
    // A second controller may have reconciled and fenced this attempt during worktree preparation.
    const latest = latestAttempt(this.load(run.id), node.id);
    if (!latest || latest.id !== attempt.id || !inFlight(latest)) return;
    try {
      await this.executor.launch({ attemptId: attempt.id, runId: run.id, nodeId: node.id, payload: path, cwd: attempt.worktree });
    } catch (error) {
      this.setState(run.id, attempt.id, "unknown", (error as Error).message);
    }
    await this.reconcile(run, attempt);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const runs = this.runs().filter(run => summarize(run).phase !== "complete");
      await Promise.all(runs.flatMap(run => run.attempts.filter(inFlight).map(attempt => this.reconcile(run, attempt))));
      for (const { id } of runs) {
        const launches: Promise<void>[] = [];
        let attempt;
        while ((attempt = this.reserve(id))) launches.push(this.launch(this.load(id), attempt));
        await Promise.all(launches);
      }
    } finally {
      this.ticking = false;
    }
  }
}
