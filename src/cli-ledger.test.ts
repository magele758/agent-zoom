import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { CliLedgerOverview, CliLedgerPromoteResult, CliSessionDetail } from "./cli-ledger-types.ts";
import { ApiError } from "./server/logic.ts";
import { CliLedgerService, redactSecrets, registerCliLedgerRoutes } from "./server/cli-ledger.ts";

const FIXED_NOW_MS = Date.parse("2026-11-23T03:00:00.000Z");

function isoAgo(mins: number): string {
  return new Date(FIXED_NOW_MS - mins * 60_000).toISOString();
}

function writeFileWithMtime(filePath: string, content: string, minsAgo: number) {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  const t = new Date(FIXED_NOW_MS - minsAgo * 60_000);
  utimesSync(filePath, t, t);
}

function buildFixtureHome(): { homeDir: string; hubDbPath: string; cleanup: () => void } {
  const homeDir = mkdtempSync(join(tmpdir(), "opc-cli-ledger-test-"));
  const hubDbPath = join(homeDir, ".agent-hub", "hub.db");
  mkdirSync(join(homeDir, ".agent-hub"), { recursive: true });

  // 0. hub.db enrichment fixture (enriches Cursor session missing cwd & tokens)
  const hubDb = new DatabaseSync(hubDbPath);
  hubDb.exec(`
    CREATE TABLE sessions(
      agent TEXT, session_id TEXT, day TEXT, project TEXT, cwd TEXT,
      tokens INTEGER, summary TEXT,
      PRIMARY KEY(agent, session_id, day)
    );
  `);
  hubDb
    .prepare("INSERT INTO sessions(agent, session_id, day, project, cwd, tokens, summary) VALUES(?,?,?,?,?,?,?)")
    .run(
      "cursor-agent",
      "cursor-agent-9001",
      "2026-11-23",
      "pagelens-pro",
      "/Users/tester/developer/ai/pagelens-pro",
      18400,
      "修复 Chrome 插件侧边栏授权缓存问题",
    );
  hubDb.close();

  // 1. Antigravity CLI fixture (multi-turn, completed, includes secrets to verify redaction + malformed JSON line)
  const agyTranscript = [
    JSON.stringify({
      step_index: 0,
      source: "SYSTEM",
      type: "SYSTEM_MESSAGE",
      created_at: isoAgo(45),
      content: "Internal system prompt",
    }),
    "{malformed json line that should be skipped cleanly",
    JSON.stringify({
      step_index: 1,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: isoAgo(40),
      content:
        "<ADDITIONAL_METADATA>os: mac</ADDITIONAL_METADATA>\n<CONTEXT_SUMMARY>prior summary</CONTEXT_SUMMARY>\n<USER_REQUEST>给 OPC OS 增加跨 CLI 会话台账，注意不要泄露 sk-proj-secret1234567890 和 https://open.feishu.cn/open-apis/bot/v2/hook/c8649a64-a37f-4c10-b81c-ee3777f0f91a</USER_REQUEST>",
    }),
    JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: isoAgo(38),
      model: "gemini-3-pro",
      input_tokens: 1500,
      output_tokens: 420,
      thinking:
        "先阅读 src/cli-ledger-types.ts 和 src/server/company-agents-index.ts，确认数据结构、路由鉴权与 Bearer secretToken123456 脱敏规则。",
      tool_calls: [
        { name: "read_file", args: { Path: "/Users/tester/developer/ai-github/agent-chatroom/src/cli-ledger-types.ts" } },
        "edit_file",
      ],
    }),
    JSON.stringify({
      step_index: 3,
      source: "MODEL",
      type: "GENERIC",
      created_at: isoAgo(36),
      content: "Made 1 replacement in /Users/tester/developer/ai-github/agent-chatroom/src/server/cli-ledger.ts",
    }),
    JSON.stringify({
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: isoAgo(35),
      model: "gemini-3-pro",
      input_tokens: 900,
      output_tokens: 300,
      content: "第一轮已完成后端服务核心代码编写并同步 src/server/cli-ledger.ts。",
    }),
    JSON.stringify({
      step_index: 5,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: isoAgo(20),
      content: "<USER_REQUEST>顺便补齐单测并跑一下 typecheck 和测试，token=my_secret_val_99</USER_REQUEST>",
    }),
    JSON.stringify({
      step_index: 6,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: isoAgo(18),
      model: "gemini-3-pro",
      input_tokens: 800,
      output_tokens: 280,
      tool_calls: [
        { name: "write_file", args: { Path: "/Users/tester/developer/ai-github/agent-chatroom/src/cli-ledger.test.ts" } },
        { name: "run_command", args: { CommandLine: "npm run typecheck && npx tsx --test src/cli-ledger.test.ts" } },
      ],
      content: "已完成单测补全，typecheck 和所有测试用例全部通过。",
    }),
  ].join("\n");
  writeFileWithMtime(
    join(homeDir, ".gemini", "antigravity-cli", "brain", "agy-conv-101", ".system_generated", "logs", "transcript.jsonl"),
    agyTranscript,
    18,
  );

  // 2. Codex CLI fixture (nested YYYY/MM/DD/rollout-*.jsonl, deduplication + boilerplate filtering + turn_aborted -> blocked)
  const codexRollout = [
    JSON.stringify({
      timestamp: isoAgo(30),
      type: "session_meta",
      payload: {
        session_id: "codex-sess-202",
        cwd: "/Users/tester/developer/ai-github/agent-chatroom",
        git: { branch: "feat/cli-ledger" },
      },
    }),
    JSON.stringify({
      timestamp: isoAgo(29),
      type: "turn_context",
      payload: { cwd: "/Users/tester/developer/ai-github/agent-chatroom", model: "gpt-5.4-codex" },
    }),
    JSON.stringify({
      timestamp: isoAgo(29),
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for repo" }] },
    }),
    JSON.stringify({
      timestamp: isoAgo(29),
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>/tmp</cwd></environment_context>" }] },
    }),
    JSON.stringify({
      timestamp: isoAgo(29),
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: "<permissions instructions>bypass</permissions>" }] },
    }),
    // Duplicate user prompt via both event_msg and response_item
    JSON.stringify({
      timestamp: isoAgo(28),
      type: "event_msg",
      payload: { type: "user_message", message: "排查暗工厂并发派工死锁问题" },
    }),
    JSON.stringify({
      timestamp: isoAgo(28),
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: "排查暗工厂并发派工死锁问题" }] },
    }),
    JSON.stringify({
      timestamp: isoAgo(27),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "npx tsx --test src/dark-factory.test.ts" }),
      },
    }),
    JSON.stringify({
      timestamp: isoAgo(26),
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/server/dark-factory.ts\n@@\n*** End Patch",
      },
    }),
    JSON.stringify({
      timestamp: isoAgo(25),
      type: "token_usage_record",
      payload: { thread_token_usage: { total_tokens: 4200 } },
    }),
    JSON.stringify({
      timestamp: isoAgo(24),
      type: "event_msg",
      payload: { type: "turn_aborted" },
    }),
    "not-valid-json",
  ].join("\n");
  writeFileWithMtime(
    join(homeDir, ".codex", "sessions", "2026", "11", "23", "rollout-2026-11-23T02-30-00-codex-sess-202.jsonl"),
    codexRollout,
    24,
  );

  // 3. Claude Code fixture (waiting_user, skips isMeta & pure tool_result user frames)
  const claudeLog = [
    JSON.stringify({
      type: "user",
      isMeta: true,
      sessionId: "claude-sess-303",
      cwd: "/Users/tester/developer/ai/web-studio",
      gitBranch: "main",
      timestamp: isoAgo(50),
      message: { role: "user", content: "meta warmup message should be ignored" },
    }),
    JSON.stringify({
      type: "user",
      isMeta: false,
      sessionId: "claude-sess-303",
      cwd: "/Users/tester/developer/ai/web-studio",
      gitBranch: "main",
      timestamp: isoAgo(48),
      message: {
        role: "user",
        content: [{ type: "text", text: "优化落地页首屏 LCP 性能并给出压缩方案" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "claude-sess-303",
      timestamp: isoAgo(46),
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        usage: { input_tokens: 2100, output_tokens: 650 },
        content: [
          { type: "thinking", thinking: "检查 hero 图片尺寸与字体预加载配置" },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/Users/tester/developer/ai/web-studio/web/src/Hero.tsx" },
          },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "npm run build" },
          },
        ],
      },
    }),
    // Pure tool_result user frame MUST be skipped (not counted as a new instruction)
    JSON.stringify({
      type: "user",
      isMeta: false,
      sessionId: "claude-sess-303",
      timestamp: isoAgo(45),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Build succeeded" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "claude-sess-303",
      timestamp: isoAgo(44),
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        usage: { input_tokens: 500, output_tokens: 180 },
        content: [
          {
            type: "text",
            text: "已将 Hero 图片转为 WebP 并开启 preload。请确认是否需要一并开启 Cloudflare 边缘缓存？",
          },
        ],
      },
    }),
  ].join("\n");
  writeFileWithMtime(
    join(homeDir, ".claude", "projects", "-Users-tester-developer-ai-web-studio", "claude-sess-303.jsonl"),
    claudeLog,
    44,
  );

  // 4. Grok CLI fixture (summary.json + updates.jsonl, multi-turn where last turn is still running with tool edits)
  const grokDir = join(homeDir, ".grok", "sessions", "encoded-opc", "grok-sess-404");
  const grokSummary = {
    info: { id: "grok-sess-404", cwd: "/Users/tester/developer/ai-github/agent-chatroom" },
    git_root_dir: "/Users/tester/developer/ai-github/agent-chatroom",
    head_branch: "feat/grok-ledger",
    git_remotes: { origin: "git@github.com:penglei/agent-chatroom.git" },
    current_model_id: "grok-4.7",
    session_summary: "为前端工作台增加 CLI 会话台账视图",
    created_at: isoAgo(15),
    updated_at: isoAgo(2),
  };
  writeFileWithMtime(join(grokDir, "summary.json"), JSON.stringify(grokSummary), 2);
  const grokUpdates = [
    JSON.stringify({
      timestamp: isoAgo(14),
      method: "session/update",
      params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "搭建 CLI 台账" } } },
    }),
    JSON.stringify({
      timestamp: isoAgo(14),
      method: "session/update",
      params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "前端卡片组件" } } },
    }),
    JSON.stringify({
      timestamp: isoAgo(13),
      method: "session/update",
      params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先分析组件结构与过滤栏状态管理。" } } },
    }),
    JSON.stringify({
      timestamp: isoAgo(12),
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已完成初版 " } } },
    }),
    JSON.stringify({
      timestamp: isoAgo(12),
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "CliLedgerPanel 组件骨架。" } } },
    }),
    JSON.stringify({
      timestamp: isoAgo(11),
      method: "session/update",
      params: { update: { sessionUpdate: "turn_completed", stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 340 } } },
    }),
    // Second turn: user asked follow-up, tool edit ran, no assistant reply yet -> running / implementing
    JSON.stringify({
      timestamp: isoAgo(3),
      method: "session/update",
      params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "补充一键复制到其他 CLI 的交接按钮" } } },
    }),
    JSON.stringify({
      timestamp: isoAgo(2),
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          kind: "edit",
          title: "Edit web/src/CliLedgerPanel.tsx",
          rawInput: { path: "/Users/tester/developer/ai-github/agent-chatroom/web/src/CliLedgerPanel.tsx" },
        },
      },
    }),
  ].join("\n");
  writeFileWithMtime(join(grokDir, "updates.jsonl"), grokUpdates, 2);

  // 5. Cursor Agent fixture (hex-encoded meta JSON + JSON message blobs + binary noise blob, enriched by hub.db)
  const cursorDbPath = join(homeDir, ".cursor", "chats", "ws-hash-001", "chat-505", "store.db");
  mkdirSync(join(cursorDbPath, ".."), { recursive: true });
  const cursorDb = new DatabaseSync(cursorDbPath);
  cursorDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
  `);
  const cursorMetaJson = JSON.stringify({
    agentId: "cursor-agent-9001",
    name: "修复侧边栏授权缓存",
    createdAt: FIXED_NOW_MS - 60 * 60_000,
    lastUsedModel: "claude-sonnet-4",
  });
  cursorDb
    .prepare("INSERT INTO meta(key, value) VALUES(?, ?)")
    .run("0", Buffer.from(cursorMetaJson, "utf8").toString("hex"));
  // Binary blob should be gracefully skipped
  cursorDb.prepare("INSERT INTO blobs(id, data) VALUES(?, ?)").run("b0", Buffer.from([0x00, 0x01, 0xff, 0x89, 0x50]));
  // Valid JSON user & assistant blobs
  cursorDb
    .prepare("INSERT INTO blobs(id, data) VALUES(?, ?)")
    .run(
      "b1",
      Buffer.from(JSON.stringify({ role: "user", content: "检查侧边栏授权缓存为何偶尔失效" }), "utf8"),
    );
  cursorDb
    .prepare("INSERT INTO blobs(id, data) VALUES(?, ?)")
    .run(
      "b2",
      Buffer.from(
        JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "edit_file",
              input: { file_path: "/Users/tester/developer/ai/pagelens-pro/src/auth-cache.ts" },
            },
            { type: "text", text: "已修复 auth-cache.ts 中的 TTL 刷新竞态问题，本地验证通过。" },
          ],
        }),
        "utf8",
      ),
    );
  cursorDb.close();
  const cursorTime = new Date(FIXED_NOW_MS - 50 * 60_000);
  utimesSync(cursorDbPath, cursorTime, cursorTime);

  // 6. OpenCode fixture (SQLite session + message + part)
  const opencodeDbPath = join(homeDir, ".local", "share", "opencode", "opencode.db");
  mkdirSync(join(opencodeDbPath, ".."), { recursive: true });
  const ocDb = new DatabaseSync(opencodeDbPath);
  ocDb.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      model TEXT,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      summary_files INTEGER DEFAULT 0
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  ocDb
    .prepare(
      "INSERT INTO session(id, title, directory, time_created, time_updated, model, tokens_input, tokens_output, summary_files) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "oc-sess-606",
      "生成周报汇总脚本",
      "/Users/tester/developer/tools/weekly-digest",
      FIXED_NOW_MS - 90 * 60_000,
      FIXED_NOW_MS - 70 * 60_000,
      "glm-5.3",
      1100,
      450,
      1,
    );
  ocDb
    .prepare("INSERT INTO message(id, session_id, time_created, data) VALUES(?,?,?,?)")
    .run("m1", "oc-sess-606", FIXED_NOW_MS - 89 * 60_000, JSON.stringify({ role: "user" }));
  ocDb
    .prepare("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES(?,?,?,?,?)")
    .run("p1", "m1", "oc-sess-606", FIXED_NOW_MS - 89 * 60_000, JSON.stringify({ type: "text", text: "写一个 Markdown 周报汇总脚本" }));
  ocDb
    .prepare("INSERT INTO message(id, session_id, time_created, data) VALUES(?,?,?,?)")
    .run("m2", "oc-sess-606", FIXED_NOW_MS - 71 * 60_000, JSON.stringify({ role: "assistant", modelID: "glm-5.3" }));
  ocDb
    .prepare("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES(?,?,?,?,?)")
    .run(
      "p2",
      "m2",
      "oc-sess-606",
      FIXED_NOW_MS - 71 * 60_000,
      JSON.stringify({
        type: "tool",
        tool: "write_file",
        state: { input: { path: "/Users/tester/developer/tools/weekly-digest/scripts/digest.mjs" } },
      }),
    );
  ocDb
    .prepare("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES(?,?,?,?,?)")
    .run(
      "p3",
      "m2",
      "oc-sess-606",
      FIXED_NOW_MS - 70 * 60_000,
      JSON.stringify({ type: "text", text: "已创建 scripts/digest.mjs 并完成本地试跑输出。" }),
    );
  ocDb.close();

  return {
    homeDir,
    hubDbPath,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  };
}

test("redactSecrets redacts API keys, JWTs, Bearer tokens, credentials and Feishu webhooks without mangling normal filenames", () => {
  const input = [
    "api=sk-proj-abc1234567890xyz",
    "pub=pk-live-9876543210abcd",
    "gh=ghp_1234567890abcdefghij",
    "slack=xoxb-1234567890-abcdef",
    "aws=AKIAIOSFODNN7EXAMPLE",
    "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
    "auth=Bearer superSecretBearerToken99",
    "kv token=abc123secret password=myPass!99",
    "hook=https://open.feishu.cn/open-apis/bot/v2/hook/c8649a64-a37f-4c10-b81c-ee3777f0f91a",
    "file=src/task-planning-types.ts",
  ].join(" | ");

  const out = redactSecrets(input);
  assert.ok(!out.includes("sk-proj-abc1234567890xyz"));
  assert.ok(!out.includes("pk-live-9876543210abcd"));
  assert.ok(!out.includes("ghp_1234567890abcdefghij"));
  assert.ok(!out.includes("xoxb-1234567890-abcdef"));
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!out.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"));
  assert.ok(!out.includes("superSecretBearerToken99"));
  assert.ok(!out.includes("abc123secret"));
  assert.ok(!out.includes("myPass!99"));
  assert.ok(!out.includes("c8649a64-a37f-4c10-b81c-ee3777f0f91a"));
  assert.ok(out.includes("Bearer [REDACTED]"));
  assert.ok(out.includes("token=[REDACTED]"));
  assert.ok(out.includes("password=[REDACTED]"));
  // Normal hyphenated filenames containing "sk-" inside "task-" must remain intact
  assert.ok(out.includes("src/task-planning-types.ts"));
});

test("CliLedgerService parses all 6 CLI families, enriches from hub.db, infers progress/status, and generates redacted handoffMarkdown", () => {
  const fx = buildFixtureHome();
  try {
    const service = new CliLedgerService({
      homeDir: fx.homeDir,
      hubDbPath: fx.hubDbPath,
      now: () => FIXED_NOW_MS,
    });

    const overview = service.getOverview({ days: 7 });
    assert.equal(overview.windowDays, 7);
    assert.equal(overview.totals.sessions, 6);
    assert.equal(overview.sources.length, 6);
    for (const src of overview.sources) {
      assert.equal(src.status, "ok", `expected source ${src.providerId} ok`);
      assert.equal(src.scanned, 1);
    }

    // 1. Antigravity: multi-turn, completed, redacted, workspace inferred
    const agySummary = overview.sessions.find((s) => s.providerId === "antigravity");
    assert.ok(agySummary);
    assert.equal(agySummary.project, "agent-chatroom");
    assert.equal(agySummary.workspace, "/Users/tester/developer/ai-github/agent-chatroom");
    assert.equal(agySummary.model, "gemini-3-pro");
    assert.equal(agySummary.status, "completed");
    assert.equal(agySummary.progressStage, "delivered");
    assert.equal(agySummary.progressPct, 100);
    assert.equal(agySummary.stats.totalTurns, 2);
    assert.equal(agySummary.stats.instructionCount, 2);
    assert.equal(agySummary.stats.commandsRun, 1);
    assert.equal(agySummary.stats.tokensTotal, 4200);
    assert.ok(agySummary.stats.filesTouched.includes("src/server/cli-ledger.ts"));
    assert.ok(agySummary.stats.filesTouched.includes("src/cli-ledger.test.ts"));
    assert.ok(!agySummary.firstInstruction.includes("sk-proj-secret1234567890"));
    assert.ok(!agySummary.firstInstruction.includes("c8649a64-a37f-4c10-b81c-ee3777f0f91a"));
    assert.ok(!agySummary.firstInstruction.includes("<ADDITIONAL_METADATA>"));
    assert.ok(!agySummary.latestInstruction.includes("my_secret_val_99"));

    const agyDetail = service.getSession(agySummary.id);
    assert.equal(agyDetail.turns.length, 2);
    assert.ok(agyDetail.turns[0].thinkingSummary?.includes("[REDACTED]"));
    assert.ok(!agyDetail.turns[0].thinkingSummary?.includes("secretToken123456"));
    assert.ok(agyDetail.handoffMarkdown.startsWith("# 跨 CLI 交接上下文："));
    assert.ok(agyDetail.handoffMarkdown.includes("## 原始指令与追问脉络"));
    assert.ok(agyDetail.handoffMarkdown.includes("## 已改动/涉及文件"));
    assert.ok(agyDetail.handoffMarkdown.includes("## 接力下一步建议"));
    assert.ok(!agyDetail.handoffMarkdown.includes("sk-proj-secret1234567890"));
    assert.ok(!agyDetail.handoffMarkdown.includes("c8649a64-a37f-4c10-b81c-ee3777f0f91a"));

    // 2. Codex: deduplicated user prompt, boilerplate excluded, turn_aborted -> blocked
    const codexSummary = overview.sessions.find((s) => s.providerId === "codex");
    assert.ok(codexSummary);
    assert.equal(codexSummary.rawSessionId, "codex-sess-202");
    assert.equal(codexSummary.branch, "feat/cli-ledger");
    assert.equal(codexSummary.model, "gpt-5.4-codex");
    assert.equal(codexSummary.stats.totalTurns, 1);
    assert.equal(codexSummary.firstInstruction, "排查暗工厂并发派工死锁问题");
    assert.equal(codexSummary.status, "blocked");
    assert.equal(codexSummary.progressStage, "blocked");
    assert.ok(codexSummary.stats.filesTouched.includes("src/server/dark-factory.ts"));
    assert.equal(codexSummary.stats.tokensTotal, 4200);

    // 3. Claude Code: skips isMeta & tool_result frames, question ending -> waiting_user
    const claudeSummary = overview.sessions.find((s) => s.providerId === "claude");
    assert.ok(claudeSummary);
    assert.equal(claudeSummary.project, "web-studio");
    assert.equal(claudeSummary.stats.totalTurns, 1);
    assert.equal(claudeSummary.status, "waiting_user");
    assert.equal(claudeSummary.progressStage, "waiting");
    assert.ok(claudeSummary.stats.filesTouched.includes("web/src/Hero.tsx"));
    assert.equal(claudeSummary.stats.commandsRun, 1);

    // 4. Grok CLI: chunk concatenation + git_remotes + second turn in progress -> running / implementing
    const grokSummary = overview.sessions.find((s) => s.providerId === "grok");
    assert.ok(grokSummary);
    assert.equal(grokSummary.repository, "penglei/agent-chatroom");
    assert.equal(grokSummary.branch, "feat/grok-ledger");
    assert.equal(grokSummary.model, "grok-4.7");
    assert.equal(grokSummary.stats.totalTurns, 2);
    assert.equal(grokSummary.firstInstruction, "搭建 CLI 台账前端卡片组件");
    assert.equal(grokSummary.latestInstruction, "补充一键复制到其他 CLI 的交接按钮");
    assert.equal(grokSummary.status, "running");
    assert.equal(grokSummary.progressStage, "implementing");
    assert.equal(grokSummary.progressPct, 65);
    assert.ok(grokSummary.stats.filesTouched.includes("web/src/CliLedgerPanel.tsx"));

    // 5. Cursor Agent: hex-decoded meta + JSON blobs + binary skipped + hub.db workspace/tokens enrichment
    const cursorSummary = overview.sessions.find((s) => s.providerId === "cursor");
    assert.ok(cursorSummary);
    assert.equal(cursorSummary.title, "修复侧边栏授权缓存");
    assert.equal(cursorSummary.model, "claude-sonnet-4");
    assert.equal(cursorSummary.workspace, "/Users/tester/developer/ai/pagelens-pro");
    assert.equal(cursorSummary.project, "pagelens-pro");
    assert.equal(cursorSummary.stats.tokensTotal, 18400);
    assert.equal(cursorSummary.status, "completed");
    assert.ok(cursorSummary.stats.filesTouched.includes("src/auth-cache.ts"));

    // 6. OpenCode: SQLite session + message + part
    const ocSummary = overview.sessions.find((s) => s.providerId === "opencode");
    assert.ok(ocSummary);
    assert.equal(ocSummary.title, "生成周报汇总脚本");
    assert.equal(ocSummary.project, "weekly-digest");
    assert.equal(ocSummary.model, "glm-5.3");
    assert.equal(ocSummary.status, "completed");
    assert.equal(ocSummary.stats.tokensTotal, 1550);
    assert.ok(ocSummary.stats.filesTouched.includes("scripts/digest.mjs"));
  } finally {
    fx.cleanup();
  }
});

test("CliLedgerService filters by provider/project/status/search, aggregates counts accurately, and supports live session enrichment", () => {
  const fx = buildFixtureHome();
  try {
    let nowMs = FIXED_NOW_MS;
    const service = new CliLedgerService({
      homeDir: fx.homeDir,
      hubDbPath: fx.hubDbPath,
      now: () => nowMs,
      hooks: {
        getLiveSessions: () => [
          // Recent live process in weekly-digest should only promote if session updated within 4m (oc-sess-606 is 70m old -> stays completed)
          {
            provider: "OpenCode",
            workspace: "/Users/tester/developer/tools/weekly-digest",
            state: "working",
            updatedAt: isoAgo(1),
          },
        ],
      },
    });

    const all = service.getOverview({ days: 7 });
    assert.equal(all.totals.sessions, 6);
    assert.equal(all.totals.running, 1);
    assert.equal(all.totals.waitingUser, 1);
    assert.equal(all.totals.blocked, 1);
    assert.equal(all.totals.completed, 3);
    assert.equal(all.byProvider.length, 6);
    assert.equal(all.byProject.length, 4);

    const agentChatroomProj = all.byProject.find((p) => p.project === "agent-chatroom");
    assert.ok(agentChatroomProj);
    assert.equal(agentChatroomProj.sessions, 3);
    assert.equal(agentChatroomProj.running, 1);
    assert.equal(agentChatroomProj.completed, 1);
    assert.deepEqual(agentChatroomProj.providers, ["Antigravity CLI", "Codex", "Grok CLI"]);

    // Filter by provider
    const onlyCodex = service.getOverview({ days: 7, provider: "codex" });
    assert.equal(onlyCodex.sessions.length, 1);
    assert.equal(onlyCodex.totals.sessions, 1);
    assert.equal(onlyCodex.sessions[0].providerId, "codex");

    // Filter by project
    const onlyWebStudio = service.getOverview({ days: 7, project: "web-studio" });
    assert.equal(onlyWebStudio.sessions.length, 1);
    assert.equal(onlyWebStudio.sessions[0].providerId, "claude");

    // Filter by status
    const onlyWaiting = service.getOverview({ days: 7, status: "waiting_user" });
    assert.equal(onlyWaiting.sessions.length, 1);
    assert.equal(onlyWaiting.sessions[0].providerId, "claude");

    // Search q across file paths and instructions
    const byFileSearch = service.getOverview({ days: 7, q: "auth-cache.ts" });
    assert.equal(byFileSearch.sessions.length, 1);
    assert.equal(byFileSearch.sessions[0].providerId, "cursor");

    // Limit works without distorting totals
    const limited = service.getOverview({ days: 7, limit: 2 });
    assert.equal(limited.sessions.length, 2);
    assert.equal(limited.totals.sessions, 6);

    // TTL cache test: updating clock by 5s serves cached result, refresh=true rescans
    nowMs += 5_000;
    const cached = service.getOverview({ days: 7 });
    assert.equal(cached.totals.sessions, 6);
    const refreshed = service.getOverview({ days: 7, refresh: true });
    assert.equal(refreshed.generatedAt, new Date(nowMs).toISOString());
  } finally {
    fx.cleanup();
  }
});

test("registerCliLedgerRoutes enforces auth, serves overview/detail/404, and promotes session to task", async () => {
  const fx = buildFixtureHome();
  try {
    const submitToken = "test-cli-ledger-submit-token-0123456789";
    const promotedPayloads: Array<{
      title: string;
      description: string;
      project: string;
      sourceRef: string;
      tags: string[];
    }> = [];

    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof ApiError) {
        return c.json({ error: err.code, message: err.message }, err.status as 400);
      }
      return c.json({ error: "internal", message: String(err) }, 500);
    });

    registerCliLedgerRoutes(
      app,
      (c) => {
        if (c.req.header("x-test-user") === "founder") return { id: "u1", name: "founder" };
        throw new ApiError(401, "auth", "unauthorized");
      },
      {
        homeDir: fx.homeDir,
        hubDbPath: fx.hubDbPath,
        submitToken,
        now: () => FIXED_NOW_MS,
        hooks: {
          promoteToTask: (input) => {
            promotedPayloads.push(input);
            return { id: "task-promoted-1", project: input.project, title: input.title };
          },
        },
      },
    );

    // 1. Unauthenticated request -> 401
    const unauthRes = await app.request("/api/opc/cli-ledger");
    assert.equal(unauthRes.status, 401);

    // 2. Bearer submitToken auth -> 200 + Cache-Control: no-store
    const listRes = await app.request("/api/opc/cli-ledger?days=7&provider=antigravity&refresh=1", {
      headers: { Authorization: `Bearer ${submitToken}` },
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get("cache-control"), "no-store");
    const overview = (await listRes.json()) as CliLedgerOverview;
    assert.equal(overview.sessions.length, 1);
    const agyId = overview.sessions[0].id;

    // 3. Session detail via user auth -> 200
    const detailRes = await app.request(`/api/opc/cli-ledger/${encodeURIComponent(agyId)}`, {
      headers: { "x-test-user": "founder" },
    });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.headers.get("cache-control"), "no-store");
    const detail = (await detailRes.json()) as CliSessionDetail;
    assert.equal(detail.id, agyId);
    assert.equal(detail.turns.length, 2);
    assert.ok(detail.handoffMarkdown.includes("# 跨 CLI 交接上下文："));

    // 4. Unknown session ID -> 404 ApiError
    const notFoundRes = await app.request("/api/opc/cli-ledger/non-existent-session", {
      headers: { "x-test-user": "founder" },
    });
    assert.equal(notFoundRes.status, 404);
    const errBody = (await notFoundRes.json()) as { error: string };
    assert.equal(errBody.error, "cli_session_not_found");

    // 5. Promote session to task -> 201
    const promoteRes = await app.request(`/api/opc/cli-ledger/${encodeURIComponent(agyId)}/promote-task`, {
      method: "POST",
      headers: {
        "x-test-user": "founder",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        note: "交接给暗工厂继续补前端 UI，注意 Bearer secretTokenShouldBeMasked",
        tags: ["handoff"],
      }),
    });
    assert.equal(promoteRes.status, 201);
    const promoted = (await promoteRes.json()) as CliLedgerPromoteResult;
    assert.equal(promoted.sessionId, agyId);
    assert.equal(promoted.taskId, "task-promoted-1");
    assert.equal(promoted.project, "agent-chatroom");
    assert.ok(promoted.href.includes("task-promoted-1"));

    assert.equal(promotedPayloads.length, 1);
    assert.equal(promotedPayloads[0].sourceRef, `cli-ledger:${agyId}`);
    assert.deepEqual(promotedPayloads[0].tags, ["cli-ledger", "antigravity", "handoff"]);
    assert.ok(!promotedPayloads[0].description.includes("secretTokenShouldBeMasked"));
    assert.ok(promotedPayloads[0].description.includes("Bearer [REDACTED]"));
  } finally {
    fx.cleanup();
  }
});

test("workspace inference prefers the nearest repository marker and rechecks it on the next scan", t => {
  const homeDir = mkdtempSync(join(tmpdir(), "opc-ledger-markers-"));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const project = join(homeDir, "checkout");
  const nested = join(project, "module");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}");
  const transcript = join(homeDir, ".gemini/antigravity-cli/brain/test/.system_generated/logs/transcript.jsonl");
  writeFileWithMtime(transcript, [
    { source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>查阅文件</USER_REQUEST>" },
    { source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [
      { name: "read_file", args: { Path: join(nested, "one.ts") } },
      { name: "read_file", args: { Path: join(nested, "two.ts") } },
    ] },
  ].map(event => JSON.stringify({ ...event, created_at: isoAgo(5) })).join("\n"), 5);
  const service = new CliLedgerService({ homeDir, now: () => FIXED_NOW_MS });
  assert.equal(service.getOverview().sessions[0]?.workspace, project);
  mkdirSync(join(nested, ".git"));
  assert.equal(service.getOverview({ refresh: true }).sessions[0]?.workspace, nested);
});
