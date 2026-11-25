import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { DecisionPacket } from "./kernel/types.ts";
import { ApiError } from "./server/logic.ts";
import {
  CliPlannotatorTransport,
  PlannotatorBridgeService,
  PlannotatorCommandError,
  formatOpcRefAnchor,
  formatPlannotatorQuestion,
  mapRawReadThreadResponse,
  parseOpcRefAnchor,
  parsePlannotatorReply,
  registerPlannotatorBridgeRoutes,
  type PlannotatorAnswerEvent,
  type PlannotatorHealth,
  type PlannotatorListThreadsInput,
  type PlannotatorReadThreadInput,
  type PlannotatorResolveMessageInput,
  type PlannotatorSendMessageInput,
  type PlannotatorSendMessageResult,
  type PlannotatorThreadDetail,
  type PlannotatorThreadMessage,
  type PlannotatorThreadSummary,
  type PlannotatorTransport,
  type StaleDecisionSupersedeParams,
  type StaleWorkflowCloseParams,
} from "./server/plannotator-bridge.ts";
import type { WorkflowRun } from "./workflow-types.ts";

interface MockThreadState {
  threadId: string;
  subject: string;
  threadName: string | null;
  resolvedAt: string | null;
  messages: PlannotatorThreadMessage[];
  earlier?: PlannotatorThreadMessage[];
  cursor: number;
}

class InMemoryPlannotatorTransport implements PlannotatorTransport {
  available = true;
  failNextSupersedes = false;
  sendCalls: PlannotatorSendMessageInput[] = [];
  readCalls: PlannotatorReadThreadInput[] = [];
  threads = new Map<string, MockThreadState>();
  private seq = 1;

  async healthCheck(): Promise<PlannotatorHealth> {
    if (!this.available) {
      return {
        available: false,
        running: false,
        state: "stopped",
        url: null,
        port: null,
        version: null,
        cliPath: "/mock/plannotator",
        reason: "inbox_stopped",
      };
    }
    return {
      available: true,
      running: true,
      state: "running",
      url: "http://localhost:53798/",
      port: 53798,
      version: "0.29.3",
      cliPath: "/mock/plannotator",
      reason: null,
    };
  }

  async sendMessage(input: PlannotatorSendMessageInput): Promise<PlannotatorSendMessageResult> {
    this.sendCalls.push(input);
    if (this.failNextSupersedes && input.supersedes?.length) {
      this.failNextSupersedes = false;
      throw new PlannotatorCommandError("invalid_supersedes", "question already closed");
    }

    const msgId = `msg_MOCK${String(this.seq++).padStart(20, "0")}`;
    const hasQuestion = /:::question(?:-multi|-text)?\b/.test(input.body);
    const qKey = hasQuestion ? `q-mock-${this.seq}` : null;

    let targetThread: MockThreadState | undefined;
    if (input.replyTo) {
      for (const th of this.threads.values()) {
        if (th.threadId === input.replyTo || th.messages.some((m) => m.id === input.replyTo)) {
          targetThread = th;
          break;
        }
      }
    } else if (input.thread) {
      for (const th of this.threads.values()) {
        if (!th.resolvedAt && th.threadName?.toLowerCase() === input.thread.toLowerCase()) {
          targetThread = th;
          break;
        }
      }
    }

    const newThread = !targetThread;
    if (!targetThread) {
      targetThread = {
        threadId: msgId,
        subject: input.subject || "Untitled",
        threadName: input.thread ?? null,
        resolvedAt: null,
        messages: [],
        cursor: 0,
      };
      this.threads.set(targetThread.threadId, targetThread);
    }

    if (input.supersedes?.length) {
      for (const sup of input.supersedes) {
        const [supMsgId, supKey] = sup.split("/");
        for (const m of targetThread.messages) {
          if (m.id !== supMsgId || !m.questions) continue;
          for (const q of m.questions) {
            if (!supKey || q.key === supKey) {
              q.state = "superseded";
              q.supersededBy = qKey ? `${msgId}/${qKey}` : msgId;
            }
          }
        }
      }
    }

    targetThread.cursor += 1;
    const message: PlannotatorThreadMessage = {
      id: msgId,
      authorKind: "agent",
      authorName: input.agentName || "OPC OS",
      createdAt: new Date(Date.UTC(2026, 10, 24, 12, 0, this.seq)).toISOString(),
      replyTo: input.replyTo ?? null,
      body: input.body,
      questions: qKey ? [{ key: qKey, q: 1, state: "open", kind: "single" }] : undefined,
    };
    targetThread.messages.push(message);

    return {
      messageId: msgId,
      threadId: targetThread.threadId,
      newThread,
      cursor: targetThread.cursor,
      url: `http://localhost:53798/#thread=${targetThread.threadId}`,
      questions: message.questions,
    };
  }

  addPersonReply(
    threadId: string,
    opts: {
      replyTo?: string | null;
      body: string;
      createdAt?: string;
      structuredSelected?: string[];
      structuredNote?: string;
      questionKey?: string;
    },
  ): string {
    const th = this.threads.get(threadId);
    if (!th) throw new Error(`missing thread ${threadId}`);
    const msgId = `msg_PERS${String(this.seq++).padStart(20, "0")}`;
    th.cursor += 1;

    if (opts.structuredSelected && opts.replyTo) {
      const targetMsg = th.messages.find((m) => m.id === opts.replyTo);
      const q = targetMsg?.questions?.find((item) => !opts.questionKey || item.key === opts.questionKey);
      if (q) {
        q.state = "sent";
        q.answer = {
          selected: opts.structuredSelected,
          note: opts.structuredNote,
        };
      }
    }

    th.messages.push({
      id: msgId,
      authorKind: "person",
      authorName: "the person",
      createdAt: opts.createdAt || new Date(Date.UTC(2026, 10, 24, 13, 0, this.seq)).toISOString(),
      replyTo: opts.replyTo ?? null,
      body: opts.body,
    });
    return msgId;
  }

  async readThread(input: PlannotatorReadThreadInput): Promise<PlannotatorThreadDetail | null> {
    this.readCalls.push(input);
    const th = this.threads.get(input.threadId);
    if (!th) return null;

    let messages = [...th.messages];
    if (typeof input.after === "number" && input.after > 0) {
      // Simulate incremental read returning only messages after cursor
      const startIndex = Math.min(messages.length, input.after);
      messages = messages.slice(startIndex);
    }

    return {
      threadId: th.threadId,
      subject: th.subject,
      threadName: th.threadName,
      resolvedAt: th.resolvedAt,
      messageCount: th.messages.length,
      openQuestions: th.messages.flatMap((m) =>
        (m.questions ?? [])
          .filter((q) => q.state === "open")
          .map((q) => ({ ...q, messageId: m.id })),
      ),
      messages,
      earlier: input.after ? undefined : th.earlier,
      cursor: th.cursor,
      url: `http://localhost:53798/#thread=${th.threadId}`,
    };
  }

  async listThreads(input: PlannotatorListThreadsInput = {}): Promise<PlannotatorThreadSummary[]> {
    const out: PlannotatorThreadSummary[] = [];
    for (const th of this.threads.values()) {
      if (!input.includeResolved && th.resolvedAt) continue;
      const last = th.messages[th.messages.length - 1];
      const lastPerson = [...th.messages].reverse().find((m) => m.authorKind === "person");
      out.push({
        threadId: th.threadId,
        subject: th.subject,
        threadName: th.threadName,
        section: "quiet",
        messageCount: th.messages.length,
        openQuestions: th.messages.reduce(
          (acc, m) => acc + (m.questions ?? []).filter((q) => q.state === "open").length,
          0,
        ),
        lastAuthor: last?.authorKind ?? null,
        lastAt: last?.createdAt ?? null,
        lastPersonAt: lastPerson?.createdAt ?? null,
        lastPersonMessageId: lastPerson?.id ?? null,
        unread: false,
        resolvedAt: th.resolvedAt,
      });
    }
    return out;
  }

  async resolveMessage(input: PlannotatorResolveMessageInput): Promise<{ resolved: boolean; threadId?: string }> {
    for (const th of this.threads.values()) {
      if (th.threadId === input.messageId || th.messages.some((m) => m.id === input.messageId)) {
        th.resolvedAt = input.resolved === false ? null : new Date().toISOString();
        return { resolved: input.resolved !== false, threadId: th.threadId };
      }
    }
    return { resolved: false };
  }
}

function makeDecisionPacket(overrides: Partial<DecisionPacket> = {}): DecisionPacket {
  const now = "2026-11-24T10:00:00.000Z";
  return {
    id: "dec_release_001",
    dedupeKey: "factory:production_release:rel_001",
    domain: "factory",
    kind: "production_release",
    riskLevel: "high",
    mainlineId: "ml_1",
    productId: "prd_1",
    assetId: "ast_1",
    title: "生产发布审批：opc-gtm-kit · 新增投放归因接口",
    backgroundSummary: "隔离工作树已通过测试，申请合并至 main。",
    whyRecommended: "仅合并代码风险可控，可先落主干再择机部署。",
    costEstimateUsd: 0.42,
    diffOrEvidence: "3 files changed, 120 insertions(+)",
    rollbackPlan: "保留 previous_head_sha 一键回滚。",
    options: [
      {
        id: "approve_deploy",
        label: "批准合并并上线部署",
        description: "合并并执行部署探针",
        outcome: "approved",
        handlerKey: "factory.release_execute",
      },
      {
        id: "approve_merge_only",
        label: "仅合并代码（暂不部署） (recommended)",
        description: "仅合并至 main 并跑单测",
        outcome: "approved",
        handlerKey: "factory.release_merge_only",
      },
      {
        id: "reject_release",
        label: "驳回本次发布",
        description: "保持 main 不变",
        outcome: "rejected",
        handlerKey: "factory.release_reject",
      },
    ],
    recommendedOptionId: "approve_merge_only",
    tags: ["production_release", "opc-gtm-kit"],
    status: "pending",
    viewedAt: null,
    chosenOptionId: null,
    decisionNote: "",
    decidedBy: null,
    autoApproved: false,
    handlerResult: null,
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
    targetSummary: {
      mainlineName: "商业套件主线",
      productName: "OPC GTM Kit",
      assetName: "opc-gtm-kit",
      repoFullName: "magele758/opc-gtm-kit",
      verifyCommand: "npm test",
      isRedline: true,
    },
    ...overrides,
  };
}

function seedOpcTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      snapshot TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_decision_packets (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      title TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_note TEXT NOT NULL DEFAULT '',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_planning_tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opc_releases (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      project TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      target_branch TEXT NOT NULL DEFAULT 'main',
      status TEXT NOT NULL DEFAULT 'pending_approval'
    );
  `);
}

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const id = overrides.id ?? "a352119e-4c88-476b-90c5-33efa609c90d";
  const createdAt = overrides.createdAt ?? "2026-11-20T00:00:00.000Z";
  return {
    id,
    request: {
      version: 1,
      requestId: `req_${id}`,
      source: "opc-os",
      context: "Password One 返修计划",
      goal: "Password One 服务端返修 r2",
      constraints: [],
    },
    workspace: "/tmp/password-one",
    base: "abc1234567890",
    backend: "codex",
    backendKey: "bk1",
    boardUrl: `http://127.0.0.1:52328/#workflows/${id}`,
    createdAt,
    revisions: [
      {
        number: 2,
        reason: "r2",
        plan: { nodes: [], acceptance: [] },
        gatedNodes: [],
      },
    ],
    released: [],
    attempts: [],
    cards: [
      {
        id: `card_${id.slice(0, 8)}`,
        kind: "plan",
        revision: 2,
        status: "open",
      },
    ],
    events: [
      {
        at: createdAt,
        kind: "card_opened",
        revision: 2,
        note: "plan",
        cardId: `card_${id.slice(0, 8)}`,
      },
    ],
    ...overrides,
  };
}

test("formatPlannotatorQuestion keeps natural choice order, strips (recommended) from labels, and emits Recommended on its own line", () => {
  const block = formatPlannotatorQuestion({
    prompt: "如何处理这批代码发布？",
    context: "共有 3 项已过单测的分支等待合入。",
    stakes: "合入 main 后将触发下一轮回归。",
    stopped: "no", // negative Stopped value must be omitted
    holdsUp: ["nightly release", "staging smoke"],
    choices: [
      { id: "c1", label: "全部驳回", description: "维持现状" },
      { id: "c2", label: "仅合并代码 (recommended)", description: "安全落主干" },
      { id: "c3", label: "合并并部署（推荐）", description: "一步到位" },
    ],
    recommendedLabel: "c2",
    why: "先落主干观察最稳妥。",
  });

  assert.ok(block.startsWith(":::question\n如何处理这批代码发布？"));
  assert.ok(block.endsWith("\n:::"));
  assert.ok(!block.includes("Stopped:"));
  assert.ok(block.includes("Holds up: nightly release; staging smoke"));

  const idx1 = block.indexOf("- [ ] 全部驳回 — 维持现状");
  const idx2 = block.indexOf("- [ ] 仅合并代码 — 安全落主干");
  const idx3 = block.indexOf("- [ ] 合并并部署 — 一步到位");
  assert.ok(idx1 > 0 && idx2 > idx1 && idx3 > idx2, "choices must remain in natural order");
  assert.ok(!block.includes("(recommended)"), "never include (recommended) in choice labels");
  assert.ok(!block.includes("（推荐）"), "never include （推荐） in choice labels");
  assert.ok(block.includes("\n\nRecommended: 仅合并代码\n"));
  assert.ok(block.includes("\n\nWhy: 先落主干观察最稳妥。\n"));

  const anchor = formatOpcRefAnchor({
    kind: "decision",
    id: "dec_123",
    revision: 2,
    refs: [{ kind: "task", id: "tsk_1" }],
  });
  const parsed = parseOpcRefAnchor(`hello\n\n${anchor}`);
  assert.deepEqual(parsed, {
    kind: "decision",
    id: "dec_123",
    revision: 2,
    refs: [{ kind: "task", id: "tsk_1" }],
  });
});

test("outbound pushDigest groups by workstream thread and supersedes previous open question on revision update", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const transport = new InMemoryPlannotatorTransport();
  const service = new PlannotatorBridgeService(db, {
    transport,
    projectPath: "/repo/agent-chatroom",
  });
  service.updateConfig({ enabled: true });

  // 1. First push creates the daily digest thread
  const first = await service.pushDigest({
    kind: "triage_digest",
    entityId: "triage:2026-11-24",
    title: "今日任务审查摘要 r1",
    body: "自动归档 51 条资讯噪音，剩余 3 条待确认范围。",
    threadName: "OPC 每日任务审查与拍板汇总",
    revision: 1,
    question: {
      prompt: "是否按建议放行这 3 条任务？",
      choices: [
        { id: "approve_all", label: "全部放行入队" },
        { id: "hold", label: "暂缓并人工复核" },
      ],
      recommendedLabel: "approve_all",
    },
    entityRefs: [{ kind: "task", id: "tsk_a" }],
  });

  assert.equal(first.ok, true);
  assert.equal(first.newThread, true);
  assert.equal(first.supersededPrevious, false);
  assert.ok(first.threadId);
  assert.ok(first.messageId);
  assert.equal(transport.threads.size, 1);

  // 2. Different entity in the SAME workstream thread reuses threadId without superseding first entity's question
  const botSummary = await service.pushBotSummary(
    [
      {
        targetKind: "decision",
        targetId: "dec_9",
        title: "opc-ops-kit 补丁合入",
        actor: "bot:rd-vp",
        verdict: "approve",
        executed: true,
        reason: "单测全绿，无受保护路径变更",
      },
    ],
    { threadName: "OPC 每日任务审查与拍板汇总", periodLabel: "2026-11-24" },
  );

  assert.equal(botSummary.ok, true);
  assert.equal(botSummary.newThread, false);
  assert.equal(botSummary.threadId, first.threadId);
  assert.equal(botSummary.supersededPrevious, false);
  assert.equal(transport.threads.size, 1, "must not spawn duplicate threads for same workstream");

  // 3. Newer revision for triage:2026-11-24 replies in same thread AND supersedes prior open question
  const second = await service.pushDigest({
    kind: "triage_digest",
    entityId: "triage:2026-11-24",
    title: "今日任务审查摘要 r2",
    body: "复核后收敛为 2 条待确认任务。",
    threadName: "OPC 每日任务审查与拍板汇总",
    revision: 2,
    question: {
      prompt: "是否放行收敛后的 2 条任务？",
      choices: [
        { id: "approve_all", label: "全部放行入队" },
        { id: "hold", label: "暂缓并人工复核" },
      ],
      recommendedLabel: "approve_all",
    },
  });

  assert.equal(second.ok, true);
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.supersededPrevious, true);
  assert.equal(transport.sendCalls[2].replyTo, first.messageId);
  assert.deepEqual(transport.sendCalls[2].supersedes, [
    `${first.messageId}/${first.link?.questionKey}`,
  ]);

  // 4. Retry gracefully if Plannotator refuses with invalid_supersedes
  transport.failNextSupersedes = true;
  const third = await service.pushDigest({
    kind: "triage_digest",
    entityId: "triage:2026-11-24",
    title: "今日任务审查摘要 r3",
    body: "补充最后 1 条说明。",
    threadName: "OPC 每日任务审查与拍板汇总",
    revision: 3,
    question: {
      prompt: "确认最终 2 条任务？",
      choices: [{ id: "approve_all", label: "全部放行入队" }],
    },
  });
  assert.equal(third.ok, true);
  assert.equal(third.supersededPrevious, false);
  assert.equal(transport.threads.size, 1);
});

test("pushEscalatedDecision + syncReplies parses structured & markdown answers, invokes callbacks, and isolates shared threads", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const transport = new InMemoryPlannotatorTransport();

  const decisionAnswers: PlannotatorAnswerEvent[] = [];
  const workflowAnswers: PlannotatorAnswerEvent[] = [];
  const triageAnswers: PlannotatorAnswerEvent[] = [];

  const service = new PlannotatorBridgeService(db, {
    transport,
    onDecisionAnswer: (ev) => {
      decisionAnswers.push(ev);
    },
    onWorkflowAnswer: (ev) => {
      workflowAnswers.push(ev);
    },
    onTriageDigestAnswer: (ev) => {
      triageAnswers.push(ev);
    },
  });
  service.updateConfig({ enabled: true });

  // Push an escalated decision
  const packet = makeDecisionPacket();
  const pushedDec = await service.pushEscalatedDecision(packet, {
    escalationReason: "属于高风险核心发布，需创始人确认",
  });
  assert.equal(pushedDec.ok, true);
  const decBody = transport.sendCalls[0].body;
  assert.ok(!decBody.includes("(recommended)"));
  assert.ok(decBody.includes("Recommended: 仅合并代码（暂不部署）"));
  assert.ok(decBody.includes("<!-- opc-ref:"));

  // Push two distinct entities into ONE shared workstream thread to verify reply isolation
  const sharedThread = "OPC 每日任务审查与拍板汇总";
  const pushedWf = await service.pushDigest({
    kind: "workflow",
    entityId: "wf_101",
    title: "工作流计划审批 r2",
    body: "计划变更 2 个模块。",
    threadName: sharedThread,
    question: {
      prompt: "是否批准 wf_101 计划？",
      choices: [
        { id: "approve", label: "批准执行" },
        { id: "changes", label: "要求修改" },
        { id: "reject", label: "拒绝关闭" },
      ],
      recommendedLabel: "approve",
    },
  });
  const pushedTriage = await service.pushDigest({
    kind: "triage_digest",
    entityId: "triage_202",
    title: "任务池批次确认",
    body: "发现 4 条候选任务。",
    threadName: sharedThread,
    question: {
      prompt: "如何处置本批候选任务？",
      choices: [
        { id: "dispatch", label: "验证通过并自动派工" },
        { id: "demote", label: "全部降级到想法库" },
      ],
    },
  });

  // Reply 1: structured answer on escalated decision (with compressed left-out body to verify full-thread fallback!)
  transport.addPersonReply(pushedDec.threadId!, {
    replyTo: pushedDec.messageId!,
    body: "Answered 1 question.\n\n[Answers to your questions: left out here; each answer is on its question above, and expand shows this reply as sent]",
    structuredSelected: ["仅合并代码（暂不部署）"],
    structuredNote: "合并后发我结果",
    questionKey: pushedDec.link?.questionKey ?? undefined,
  });

  // Reply 2: markdown "Answers to your questions" reply specifically to wf_101 (NOT triage_202!)
  transport.addPersonReply(pushedWf.threadId!, {
    replyTo: pushedWf.messageId!,
    body: [
      "Answered 1 question.",
      "",
      "## Answers to your questions",
      "",
      "### Q1. 是否批准 wf_101 计划？ (line 10)",
      "Answer: 批准执行 (your recommendation)",
      "Note: 先跑单测再合并",
    ].join("\n"),
  });

  const sync1 = await service.syncReplies();
  assert.equal(sync1.ok, true);
  assert.equal(sync1.available, true);
  assert.equal(sync1.checked, 3);
  assert.equal(sync1.synced, 2);
  assert.equal(decisionAnswers.length, 1);
  assert.equal(decisionAnswers[0].entityId, packet.id);
  assert.equal(decisionAnswers[0].matchedOptionId, "approve_merge_only");
  assert.equal(decisionAnswers[0].note, "合并后发我结果");

  assert.equal(workflowAnswers.length, 1);
  assert.equal(workflowAnswers[0].entityId, "wf_101");
  assert.equal(workflowAnswers[0].matchedOptionId, "approve");
  assert.equal(workflowAnswers[0].note, "先跑单测再合并");

  // triage_202 in the SAME shared thread must STILL be open (not polluted by wf_101 reply!)
  assert.equal(triageAnswers.length, 0);
  assert.equal(service.getLink("triage_digest", "triage_202")?.status, "open");
  assert.equal(service.getLink("decision", packet.id)?.status, "synced");
  assert.equal(service.getLink("workflow", "wf_101")?.status, "synced");

  // Reply 3: plain-text user reply targeting triage_202 matching choice label
  transport.addPersonReply(pushedTriage.threadId!, {
    replyTo: pushedTriage.messageId!,
    body: "验证通过并自动派工，优先用 agy",
  });

  const sync2 = await service.syncReplies();
  assert.equal(sync2.checked, 1);
  assert.equal(sync2.synced, 1);
  assert.equal(triageAnswers.length, 1);
  assert.equal(triageAnswers[0].matchedOptionId, "dispatch");
  assert.equal(service.getLink("triage_digest", "triage_202")?.status, "synced");

  // Running syncReplies again is idempotent (0 open links left)
  const sync3 = await service.syncReplies();
  assert.equal(sync3.checked, 0);
  assert.equal(sync3.synced, 0);
});

test("fresh bridge stays disabled and a skipped reply leaves the link open", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const transport = new InMemoryPlannotatorTransport();
  const service = new PlannotatorBridgeService(db, { transport });
  assert.equal(service.getConfig().enabled, false);
  assert.equal(service.getConfig().autoReconcileStale, false);

  service.updateConfig({ enabled: true });
  const entityId = "dec_skip";
  const pushed = await service.pushDigest({
    kind: "decision",
    entityId,
    title: "跳过回复不应关闭链接",
    body: "请选择是否执行。",
    question: {
      prompt: "是否执行？",
      choices: [
        { id: "approve", label: "批准执行" },
        { id: "reject", label: "拒绝关闭" },
      ],
    },
  });
  assert.equal(pushed.ok, true);
  assert.equal(service.getLink("decision", entityId)?.status, "open");
  let hookCalls = 0;
  service.setHooks({
    onDecisionAnswer: () => {
      hookCalls += 1;
      return { skipped: true, reason: "no_matching_option" };
    },
  });
  transport.addPersonReply(pushed.threadId!, {
    replyTo: pushed.messageId!,
    body: "先不要执行，改为拒绝",
  });
  const synced = await service.syncReplies();
  assert.equal(hookCalls, 1);
  assert.equal(service.getLink("decision", entityId)?.status, "open");
  assert.equal(synced.items[0]?.outcome, "pending");
  assert.equal(synced.synced, 0);
});

test("reconcileStaleItems closes expired/superseded workflows and supersedes decisions with closed tasks or merged branches", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  seedOpcTables(db);

  const transport = new InMemoryPlannotatorTransport();
  const fixedNow = new Date("2026-11-24T15:00:00.000Z");

  // Seed Plannotator thread representing a superseded workstream (like msg_01M81P1C9SF92XD7K13WFN4PCA)
  const resolvedThreadId = "msg_01M81P1C9SF92XD7K13WFN4PCA";
  transport.threads.set(resolvedThreadId, {
    threadId: resolvedThreadId,
    subject: "Context Graph 与 Password One",
    threadName: "OPC 课题",
    resolvedAt: null,
    cursor: 2,
    messages: [
      {
        id: "msg_NEWERROUND000000000001",
        authorKind: "agent",
        createdAt: "2026-11-24T12:00:00.000Z",
        body: "Context Graph v0.2.4 已合入主干。",
        questions: [
          {
            key: "q-v24",
            state: "sent",
            answer: { selected: ["部署 v0.2.4"] },
          },
        ],
      },
    ],
  });

  // Workflow 1: > 72h old (created 2026-11-20) -> stale by timeout
  const wfAged = makeWorkflowRun({
    id: "a352119e-4c88-476b-90c5-33efa609c90d",
    createdAt: "2026-11-20T00:00:00.000Z",
  });
  // Workflow 2: fresh timestamp (< 72h) BUT references Plannotator thread that has newer settled round
  const wfThreadSuperseded = makeWorkflowRun({
    id: "4d781f17-ddde-439b-a6c6-9c2a67a5bfde",
    createdAt: "2026-11-23T11:00:00.000Z",
    request: {
      version: 1,
      requestId: "req_wf2",
      source: "opc-os",
      context: `关联线程 ${resolvedThreadId}`,
      goal: "Context Graph 接入架构返修 r2",
      constraints: [],
    },
  });
  // Workflow 3: fresh timestamp (< 72h) BUT gitChecker says base commit is superseded
  const wfGitSuperseded = makeWorkflowRun({
    id: "d86627a4-48fe-4b90-8c0b-1e2b50fa7f96",
    createdAt: "2026-11-24T10:00:00.000Z",
    workspace: "/tmp/repo-superseded",
    base: "deadbeef1234",
  });
  // Workflow 4: fresh & active -> MUST NOT be touched
  const wfFresh = makeWorkflowRun({
    id: "11111111-2222-3333-4444-555555555555",
    createdAt: "2026-11-24T14:00:00.000Z",
    workspace: "/tmp/repo-fresh",
    base: "cafebabe0000",
  });

  const insertWf = db.prepare(
    "INSERT INTO workflow_runs (id, request_id, created_at, snapshot) VALUES (?, ?, ?, ?)",
  );
  for (const wf of [wfAged, wfThreadSuperseded, wfGitSuperseded, wfFresh]) {
    insertWf.run(wf.id, wf.request.requestId, wf.createdAt, JSON.stringify(wf));
  }

  // Seed planning tasks
  db.prepare("INSERT INTO opc_planning_tasks (id, project, title, status) VALUES (?, ?, ?, ?)").run(
    "tsk_done_1",
    "password-one",
    "已上线修复",
    "done",
  );
  db.prepare("INSERT INTO opc_planning_tasks (id, project, title, status) VALUES (?, ?, ?, ?)").run(
    "tsk_active_1",
    "opc-gtm-kit",
    "活跃功能开发",
    "in_progress",
  );

  // Seed releases
  db.prepare(
    "INSERT INTO opc_releases (id, task_id, project, repo_path, source_branch, target_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("rel_merged", null, "opc-ops-kit", "/tmp/opc-ops-kit", "feat/already-merged", "main", "pending_approval");
  db.prepare(
    "INSERT INTO opc_releases (id, task_id, project, repo_path, source_branch, target_branch, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("rel_active", "tsk_active_1", "opc-gtm-kit", "/tmp/opc-gtm-kit", "feat/pending", "main", "pending_approval");

  const insertDec = db.prepare(`
    INSERT INTO opc_decision_packets (
      id, dedupe_key, domain, kind, risk_level, title, options_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  // Decision 1: references done task -> should be superseded
  insertDec.run(
    "dec_closed_task",
    "product:patrol:2026-11-24",
    "product",
    "patrol_alert",
    "medium",
    "滞留任务告警",
    JSON.stringify([{ id: "archive", label: "归档", outcome: "rejected", handlerKey: "h", payload: { taskIds: ["tsk_done_1"] } }]),
    "2026-11-24T08:00:00.000Z",
    "2026-11-24T08:00:00.000Z",
  );
  // Decision 2: references already-merged branch -> should be superseded
  insertDec.run(
    "dec_merged_branch",
    "factory:production_release:rel_merged",
    "factory",
    "production_release",
    "high",
    "发布审批：opc-ops-kit",
    JSON.stringify([{ id: "approve_merge_only", label: "仅合并", outcome: "approved", handlerKey: "h", payload: { releaseId: "rel_merged" } }]),
    "2026-11-24T08:00:00.000Z",
    "2026-11-24T08:00:00.000Z",
  );
  // Decision 3: active unmerged release -> MUST STAY PENDING
  insertDec.run(
    "dec_active_release",
    "factory:production_release:rel_active",
    "factory",
    "production_release",
    "high",
    "发布审批：opc-gtm-kit",
    JSON.stringify([{ id: "approve_merge_only", label: "仅合并", outcome: "approved", handlerKey: "h", payload: { releaseId: "rel_active" } }]),
    "2026-11-24T08:00:00.000Z",
    "2026-11-24T08:00:00.000Z",
  );

  const closedWorkflowCalls: StaleWorkflowCloseParams[] = [];
  const supersededDecisionCalls: StaleDecisionSupersedeParams[] = [];

  const service = new PlannotatorBridgeService(db, {
    transport,
    now: () => fixedNow,
    gitChecker: {
      isCommitSuperseded: async ({ baseCommit }) => ({
        superseded: baseCommit === "deadbeef1234",
        reason: "基线提交已被 3247ec33 覆盖",
      }),
      isBranchMerged: async ({ sourceBranch }) => ({
        merged: sourceBranch === "feat/already-merged",
        reason: `分支 ${sourceBranch} 已合入 main`,
      }),
    },
    closeStaleWorkflow: (params) => {
      closedWorkflowCalls.push(params);
    },
    supersedeDecision: (params) => {
      supersededDecisionCalls.push(params);
    },
  });

  // Dry run first: detects 3 workflows + 2 decisions, applies 0 mutations
  const dry = await service.reconcileStaleItems({ staleHours: 72, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.inspectedWorkflows, 4);
  assert.equal(dry.inspectedDecisions, 3);
  assert.equal(dry.closedWorkflows, 0);
  assert.equal(dry.supersededDecisions, 0);
  assert.equal(dry.items.length, 5);
  assert.equal(closedWorkflowCalls.length, 0);
  assert.equal(supersededDecisionCalls.length, 0);

  // Real run: executes hooks for the 3 stale workflows & 2 stale decisions, leaves fresh items intact
  const real = await service.reconcileStaleItems({ staleHours: 72, dryRun: false });
  assert.equal(real.dryRun, false);
  assert.equal(real.closedWorkflows, 3);
  assert.equal(real.supersededDecisions, 2);
  assert.deepEqual(
    closedWorkflowCalls.map((c) => c.runId).sort(),
    [wfAged.id, wfThreadSuperseded.id, wfGitSuperseded.id].sort(),
  );
  assert.deepEqual(
    supersededDecisionCalls.map((c) => c.decisionId).sort(),
    ["dec_closed_task", "dec_merged_branch"],
  );

  // Also test built-in SQLite fallback (when no custom closeStaleWorkflow/supersedeDecision hooks are injected)
  const fallbackService = new PlannotatorBridgeService(db, {
    transport,
    now: () => fixedNow,
    gitChecker: {
      isBranchMerged: async ({ sourceBranch }) => sourceBranch === "feat/already-merged",
    },
  });
  const fallbackRes = await fallbackService.reconcileStaleItems({ staleHours: 72, dryRun: false });
  assert.equal(fallbackRes.closedWorkflows, 2); // wfAged + wfThreadSuperseded
  assert.equal(fallbackRes.supersededDecisions, 2); // dec_closed_task + dec_merged_branch

  const wfAgedAfter = JSON.parse(
    String((db.prepare("SELECT snapshot FROM workflow_runs WHERE id = ?").get(wfAged.id) as { snapshot: string }).snapshot),
  ) as WorkflowRun;
  assert.equal(wfAgedAfter.cards[0].status, "reject");
  assert.match(wfAgedAfter.cards[0].note || "", /自动收敛/);

  const decClosedAfter = db
    .prepare("SELECT status, decision_note FROM opc_decision_packets WHERE id = ?")
    .get("dec_closed_task") as { status: string; decision_note: string };
  assert.equal(decClosedAfter.status, "superseded");
  assert.match(decClosedAfter.decision_note, /自动收敛/);

  const decActiveAfter = db
    .prepare("SELECT status FROM opc_decision_packets WHERE id = ?")
    .get("dec_active_release") as { status: string };
  assert.equal(decActiveAfter.status, "pending", "active release decision must remain pending");
});

test("graceful fallback when Plannotator is offline or CLI binary is missing (zero crashes)", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());

  // 1. Offline mock transport
  const offlineTransport = new InMemoryPlannotatorTransport();
  offlineTransport.available = false;
  const service = new PlannotatorBridgeService(db, { transport: offlineTransport });
  service.updateConfig({ enabled: true });

  const status = await service.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.health.running, false);

  const pushed = await service.pushDigest({
    kind: "triage_digest",
    title: "测试离线降级",
    body: "内容",
  });
  assert.equal(pushed.ok, false);
  assert.equal(pushed.available, false);
  assert.notEqual(pushed.reason, "bridge_disabled");

  const synced = await service.syncReplies();
  assert.equal(synced.ok, false);
  assert.equal(synced.available, false);

  const reconciled = await service.reconcileStaleItems({ dryRun: true });
  assert.equal(reconciled.plannotatorAvailable, false);
  assert.equal(reconciled.items.length, 0);

  // 2. Real CliPlannotatorTransport pointing to nonexistent binary never throws on healthCheck
  const missingCli = new CliPlannotatorTransport({
    cliBin: "/nonexistent/path/to/plannotator-missing",
  });
  const missingHealth = await missingCli.healthCheck();
  assert.equal(missingHealth.available, false);
  assert.equal(missingHealth.reason, "plannotator_cli_not_found");
});

test("registerPlannotatorBridgeRoutes mounts all 5 routes with auth, validation, and end-to-end payloads", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  seedOpcTables(db);

  const transport = new InMemoryPlannotatorTransport();
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  const submitToken = "secret-submit-token-for-unit-test-1234";
  registerPlannotatorBridgeRoutes(app, db, {
    transport,
    submitToken,
    user: (c) => {
      if (c.req.header("x-user") === "founder") return { id: "u1", name: "founder" };
      throw new ApiError(401, "unauthorized", "请先登录");
    },
  });

  // Unauthenticated request rejected
  assert.equal((await app.request("/api/opc/plannotator/status")).status, 401);

  const authHeaders = { authorization: `Bearer ${submitToken}` };

  // GET /api/opc/plannotator/status
  const statusRes = await app.request("/api/opc/plannotator/status", { headers: authHeaders });
  assert.equal(statusRes.status, 200);
  const statusJson = (await statusRes.json()) as {
    available: boolean;
    config: { staleWorkflowHours: number; enabled: boolean };
  };
  assert.equal(statusJson.available, true);
  assert.equal(statusJson.config.staleWorkflowHours, 72);
  assert.equal(statusJson.config.enabled, false);

  // PATCH /api/opc/plannotator/config
  const patchRes = await app.request("/api/opc/plannotator/config", {
    method: "PATCH",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ staleWorkflowHours: 48, defaultThreadName: "OPC 总裁办汇总", enabled: true }),
  });
  assert.equal(patchRes.status, 200);
  const patchJson = (await patchRes.json()) as {
    config: { staleWorkflowHours: number; defaultThreadName: string };
  };
  assert.equal(patchJson.config.staleWorkflowHours, 48);
  assert.equal(patchJson.config.defaultThreadName, "OPC 总裁办汇总");

  // Invalid config rejected with 400
  const badPatch = await app.request("/api/opc/plannotator/config", {
    method: "PATCH",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ syncIntervalSecs: 2 }),
  });
  assert.equal(badPatch.status, 400);

  // POST /api/opc/plannotator/push-digest (works with default body OR custom body)
  const pushRes = await app.request("/api/opc/plannotator/push-digest", {
    method: "POST",
    headers: { "x-user": "founder", "content-type": "application/json" },
    body: JSON.stringify({
      kind: "triage_digest",
      entityId: "digest_route_1",
      title: "路由推送测试",
      body: "测试摘要内容",
      question: {
        prompt: "确认推送？",
        choices: [{ id: "ok", label: "确认" }],
      },
    }),
  });
  assert.equal(pushRes.status, 200);
  const pushJson = (await pushRes.json()) as { ok: boolean; threadId: string; messageId: string };
  assert.equal(pushJson.ok, true);
  assert.ok(pushJson.threadId);

  // POST /api/opc/plannotator/sync
  transport.addPersonReply(pushJson.threadId, {
    replyTo: pushJson.messageId,
    body: "确认",
  });
  const syncRes = await app.request("/api/opc/plannotator/sync", {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(syncRes.status, 200);
  const syncJson = (await syncRes.json()) as { ok: boolean; synced: number };
  assert.equal(syncJson.ok, true);
  assert.equal(syncJson.synced, 1);

  // POST /api/opc/plannotator/reconcile-stale
  const staleWf = makeWorkflowRun({ createdAt: "2025-01-01T00:00:00.000Z" });
  db.prepare("INSERT INTO workflow_runs (id, request_id, created_at, snapshot) VALUES (?, ?, ?, ?)").run(
    staleWf.id,
    staleWf.request.requestId,
    staleWf.createdAt,
    JSON.stringify(staleWf),
  );
  const reconcileDryRes = await app.request("/api/opc/plannotator/reconcile-stale", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ dryRun: true }),
  });
  assert.equal(reconcileDryRes.status, 200);
  const reconcileDryJson = (await reconcileDryRes.json()) as {
    dryRun: boolean;
    items: Array<{ entityId: string }>;
    closedWorkflows: number;
  };
  assert.equal(reconcileDryJson.dryRun, true);
  assert.equal(reconcileDryJson.items.length, 1);
  assert.equal(reconcileDryJson.closedWorkflows, 0);

  const reconcileRealRes = await app.request("/api/opc/plannotator/reconcile-stale", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ dryRun: false }),
  });
  assert.equal(reconcileRealRes.status, 200);
  const reconcileRealJson = (await reconcileRealRes.json()) as { closedWorkflows: number };
  assert.equal(reconcileRealJson.closedWorkflows, 1);

  // POST /api/opc/plannotator/push-digest with empty body synthesizes default pending digest cleanly
  const defaultPushRes = await app.request("/api/opc/plannotator/push-digest", {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(defaultPushRes.status, 200);
  const defaultPushJson = (await defaultPushRes.json()) as { ok: boolean; threadId: string };
  assert.equal(defaultPushJson.ok, true);
  assert.ok(defaultPushJson.threadId);
});

test("parsePlannotatorReply handles Other, Skipped, and superseded states accurately", () => {
  const baseLink = {
    id: "plink_1",
    entityKind: "decision" as const,
    entityId: "dec_1",
    threadId: "msg_T1",
    threadName: "test",
    lastMessageId: "msg_A1",
    questionKey: "q-1",
    choices: [
      { id: "opt_a", label: "方案 A" },
      { id: "opt_b", label: "方案 B" },
    ],
    meta: {},
    status: "open" as const,
    createdAt: "2026-11-24T10:00:00.000Z",
    updatedAt: "2026-11-24T10:00:00.000Z",
  };

  // Other answer
  const otherParsed = parsePlannotatorReply({
    link: baseLink,
    thread: {
      threadId: "msg_T1",
      subject: "s",
      resolvedAt: null,
      messageCount: 2,
      openQuestions: [],
      messages: [
        { id: "msg_A1", authorKind: "agent", createdAt: "2026-11-24T10:00:00.000Z", body: "q" },
        {
          id: "msg_P1",
          authorKind: "person",
          createdAt: "2026-11-24T10:05:00.000Z",
          replyTo: "msg_A1",
          body: "## Answers to your questions\n\n### Q1. 选哪个？\nOther: 先灰度 10% 再说",
        },
      ],
    },
  });
  assert.equal(otherParsed?.kind, "answered");
  assert.equal(otherParsed?.otherText, "先灰度 10% 再说");
  assert.equal(otherParsed?.matchedOptionId, null);

  // Skipped answer
  const skippedParsed = parsePlannotatorReply({
    link: baseLink,
    thread: {
      threadId: "msg_T1",
      subject: "s",
      resolvedAt: null,
      messageCount: 2,
      openQuestions: [],
      messages: [
        { id: "msg_A1", authorKind: "agent", createdAt: "2026-11-24T10:00:00.000Z", body: "q" },
        {
          id: "msg_P2",
          authorKind: "person",
          createdAt: "2026-11-24T10:06:00.000Z",
          replyTo: "msg_A1",
          body: "## Answers to your questions\n\n### Q1. 选哪个？\nSkipped",
        },
      ],
    },
  });
  assert.equal(skippedParsed?.kind, "answered");
  assert.equal(skippedParsed?.skipped, true);

  // Superseded question
  const supersededParsed = parsePlannotatorReply({
    link: baseLink,
    thread: {
      threadId: "msg_T1",
      subject: "s",
      resolvedAt: null,
      messageCount: 2,
      openQuestions: [],
      messages: [
        {
          id: "msg_A1",
          authorKind: "agent",
          createdAt: "2026-11-24T10:00:00.000Z",
          body: "q",
          questions: [{ key: "q-1", state: "superseded", supersededBy: "msg_A2/q-2" }],
        },
      ],
    },
  });
  assert.equal(supersededParsed?.kind, "superseded");
  assert.equal(supersededParsed?.supersededBy, "msg_A2/q-2");
});

test("mapRawReadThreadResponse maps real Plannotator nested thread.{messages, earlier, open_questions} payloads", () => {
  const detail = mapRawReadThreadResponse(
    {
      thread: {
        thread_id: "msg_01M81P1C9SF92XD7K13WFN4PCA",
        subject: "Context Graph 与 Password One",
        thread_name: "OPC 课题",
        resolved_at: null,
        message_count: 10,
        open_questions: [
          {
            message_id: "msg_01M843DS5AJ6BEN4G8S3ZP7HEJ",
            key: "a-04f23d72",
            q: 1,
            state: "open",
            kind: "action",
            prompt: "批准 3 条并行返修计划",
          },
        ],
        messages: [
          {
            id: "msg_01M86EMBWZ6DWGP2NSKC3Z9Z60",
            author: { kind: "agent", name: "Antigravity" },
            created_at: "2026-11-24T12:00:00.000Z",
            reply_to: "msg_01M85V70VXDSWHT6SXSCQNS8VW",
            body: "v0.2.4 已验证达标",
            questions: [
              {
                key: "q-d8d7d087",
                q: 1,
                state: "sent",
                answer: { selected: ["部署 Ubuntu1 v0.2.4"] },
              },
            ],
          },
          {
            id: "msg_01M86QHRWQJ98K6MVXPDGDPEHM",
            author: { kind: "person" },
            created_at: "2026-11-24T12:12:36.119Z",
            reply_to: "msg_01M86EMBWZ6DWGP2NSKC3Z9Z60",
            body: "Answered 1 question.\n\n## Answers to your questions\n\n### Q1. 下一步？\nAnswer: 部署 Ubuntu1 v0.2.4 (your recommendation)",
          },
        ],
        earlier: [
          {
            id: "msg_01M81P1C9SF92XD7K13WFN4PCA",
            author: { kind: "agent", name: "Antigravity" },
            created_at: "2026-11-22T13:09:58.201Z",
            reply_to: null,
            words: "已完成原型验证",
          },
        ],
      },
      cursor: 96,
      url: "http://localhost:53798/#thread=msg_01M81P1C9SF92XD7K13WFN4PCA",
    },
    "fallback",
  );

  assert.equal(detail.threadId, "msg_01M81P1C9SF92XD7K13WFN4PCA");
  assert.equal(detail.openQuestions.length, 1);
  assert.equal(detail.openQuestions[0].key, "a-04f23d72");
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].questions?.[0]?.answer?.selected?.[0], "部署 Ubuntu1 v0.2.4");
  assert.equal(detail.earlier?.length, 1);
  assert.equal(detail.earlier?.[0]?.body, "已完成原型验证");
  assert.equal(detail.cursor, 96);
});

test("reconcileStaleItems default git branch-merged check detects real merged branch and preserves unmerged branch", async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), "opc-plannotator-git-"));
  const db = new DatabaseSync(":memory:");
  t.after(() => {
    db.close();
    rmSync(repoDir, { recursive: true, force: true });
  });
  seedOpcTables(db);

  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdio: "pipe",
    });

  git(["init", "-b", "main"]);
  writeFileSync(join(repoDir, "README.md"), "init\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);

  // Branch 1: merged into main
  git(["checkout", "-b", "feat/merged"]);
  writeFileSync(join(repoDir, "merged.txt"), "done\n");
  git(["add", "."]);
  git(["commit", "-m", "feat merged"]);
  git(["checkout", "main"]);
  git(["merge", "--ff-only", "feat/merged"]);

  // Branch 2: unmerged (1 commit ahead of main)
  git(["checkout", "-b", "feat/unmerged"]);
  writeFileSync(join(repoDir, "pending.txt"), "wip\n");
  git(["add", "."]);
  git(["commit", "-m", "feat unmerged"]);
  git(["checkout", "main"]);

  db.prepare(
    "INSERT INTO opc_releases (id, task_id, project, repo_path, source_branch, target_branch, status) VALUES (?, NULL, ?, ?, ?, 'main', 'pending_approval')",
  ).run("rel_git_merged", "demo", repoDir, "feat/merged");
  db.prepare(
    "INSERT INTO opc_releases (id, task_id, project, repo_path, source_branch, target_branch, status) VALUES (?, NULL, ?, ?, ?, 'main', 'pending_approval')",
  ).run("rel_git_unmerged", "demo", repoDir, "feat/unmerged");

  const insertDec = db.prepare(`
    INSERT INTO opc_decision_packets (
      id, dedupe_key, domain, kind, risk_level, title, options_json, status, created_at, updated_at
    ) VALUES (?, ?, 'factory', 'production_release', 'high', ?, ?, 'pending', '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')
  `);
  insertDec.run(
    "dec_git_merged",
    "factory:production_release:rel_git_merged",
    "已合入发布单",
    JSON.stringify([{ id: "approve_merge_only", label: "仅合并", outcome: "approved", handlerKey: "h", payload: { releaseId: "rel_git_merged" } }]),
  );
  insertDec.run(
    "dec_git_unmerged",
    "factory:production_release:rel_git_unmerged",
    "未合入发布单",
    JSON.stringify([{ id: "approve_merge_only", label: "仅合并", outcome: "approved", handlerKey: "h", payload: { releaseId: "rel_git_unmerged" } }]),
  );

  const transport = new InMemoryPlannotatorTransport();
  transport.available = false; // also confirms git stale check works even when Plannotator is offline
  const service = new PlannotatorBridgeService(db, { transport });

  const result = await service.reconcileStaleItems({ dryRun: false });
  assert.equal(result.supersededDecisions, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].entityId, "dec_git_merged");
  assert.equal(result.items[0].reasonCode, "branch_already_merged");

  const mergedRow = db
    .prepare("SELECT status FROM opc_decision_packets WHERE id = ?")
    .get("dec_git_merged") as { status: string };
  const unmergedRow = db
    .prepare("SELECT status FROM opc_decision_packets WHERE id = ?")
    .get("dec_git_unmerged") as { status: string };
  assert.equal(mergedRow.status, "superseded");
  assert.equal(unmergedRow.status, "pending");
});
