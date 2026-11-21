export type AgentType = "cli" | "api" | "mcp";

export type AgentRegistryStatus = "idle" | "running" | "error" | "disabled";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "pr_open"
  | "completed"
  | "no_output"
  | "failed"
  | "cancelled";

export type CircuitBreakerReason =
  | "cost_limit_exceeded"
  | "duration_limit_exceeded"
  | "dead_loop_detected"
  | "protected_path_violation";

export type LogStreamKind = "stdout" | "stderr" | "system";

export type AuditStatus = "passed" | "warning" | "blocked";

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  type: AgentType;
  cliCommand: string;
  promptTemplate: string;
  maxCostPerTask: number;
  maxDurationSecs: number;
  maxRetries: number;
  status: AgentRegistryStatus;
  capabilities: string[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPreset {
  key: string;
  label: string;
  name: string;
  description: string;
  type: AgentType;
  cliCommand: string;
  promptTemplate: string;
  maxCostPerTask: number;
  maxDurationSecs: number;
  maxRetries: number;
  capabilities: string[];
  config?: Record<string, unknown>;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  type?: AgentType;
  cliCommand: string;
  promptTemplate?: string;
  maxCostPerTask?: number;
  maxDurationSecs?: number;
  maxRetries?: number;
  status?: AgentRegistryStatus;
  capabilities?: string[];
  config?: Record<string, unknown>;
}

export type UpdateAgentInput = Partial<CreateAgentInput>;

export interface AgentRunRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  project: string;
  agentId: string;
  agentName: string;
  repoPath: string | null;
  worktreePath: string | null;
  branchName: string | null;
  status: AgentRunStatus;
  pid: number | null;
  tokenUsed: number;
  costUsd: number;
  retryCount: number;
  logFilePath: string | null;
  errorSummary: string | null;
  prUrl: string | null;
  changedFiles: string[];
  protectedViolations: string[];
  circuitBreakerReason: CircuitBreakerReason | null;
  autoCreatePr: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchRunInput {
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  project?: string;
  repoPath?: string;
  agentId: string;
  autoCreatePr?: boolean;
}

export interface RunLogEntry {
  seq: number;
  timestamp: string;
  stream: LogStreamKind;
  line: string;
}

export interface RunLogsResponse {
  runId: string;
  status: AgentRunStatus;
  logFilePath: string | null;
  logs: RunLogEntry[];
}

export type RunStreamEvent =
  | { type: "log"; entry: RunLogEntry }
  | { type: "state"; run: AgentRunRecord }
  | { type: "done"; run: AgentRunRecord };

export interface FactoryWorktreeEntry {
  runId: string;
  taskId: string;
  taskTitle: string;
  project: string;
  agentName: string;
  repoPath: string | null;
  worktreePath: string;
  branchName: string | null;
  runStatus: AgentRunStatus;
  existsOnDisk: boolean;
  cleanable: boolean;
  createdAt: string;
}

export interface CleanupWorktreesResult {
  cleaned: Array<{ runId: string; worktreePath: string; branchName: string | null }>;
  skipped: Array<{ runId: string; worktreePath: string; reason: string }>;
  prunedRepos: string[];
}

export interface FactoryAuditDetails {
  repoRoot: string;
  protectedPaths: string[];
  changedFiles: string[];
  violations: string[];
  isGitRepo: boolean;
  recentViolationsCount: number;
}

export interface FactoryAuditRecord {
  id: string;
  kind: string;
  status: AuditStatus;
  summary: string;
  details: FactoryAuditDetails;
  createdAt: string;
}

export interface FactoryDayMetric {
  date: string;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  noOutputRuns: number;
  tokenUsed: number;
  costUsd: number;
}

export interface FactoryProjectMonthMetric {
  project: string;
  month: string;
  runs: number;
  tokenUsed: number;
  costUsd: number;
}

export interface FactoryMetrics {
  days: number;
  totalRuns: number;
  completedRuns: number;
  prOpenRuns: number;
  noOutputRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  activeRuns: number;
  queuedRuns: number;
  totalTokens: number;
  totalCostUsd: number;
  byDay: FactoryDayMetric[];
  byProjectMonth: FactoryProjectMonthMetric[];
}

export interface DarkFactoryOverview {
  agents: AgentRecord[];
  presets: AgentPreset[];
  runs: AgentRunRecord[];
  activeCount: number;
  queuedCount: number;
  maxConcurrentAgents: number;
  worktrees: FactoryWorktreeEntry[];
  protectedPaths: string[];
  audits: FactoryAuditRecord[];
  metrics: FactoryMetrics;
}

export const DEFAULT_PROMPT_TEMPLATE = [
  "Task [{{task.id}}]: {{task.title}}",
  "Worktree: {{worktree_path}}",
  "Branch: {{branch_name}}",
  "",
  "{{task.description}}",
].join("\n");

export const AGENT_PRESETS: AgentPreset[] = [
  {
    key: "claude-code",
    label: "Claude Code",
    name: "claude-code",
    description: "Anthropic Claude Code CLI，擅长复杂架构实现、深度重构与测试编写。",
    type: "cli",
    cliCommand: "claude -p {{prompt}} --output-format text",
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    maxCostPerTask: 5,
    maxDurationSecs: 1800,
    maxRetries: 3,
    capabilities: ["coding", "architecture", "refactor", "test"],
  },
  {
    key: "codex-cli",
    label: "Codex CLI",
    name: "codex-cli",
    description: "OpenAI Codex CLI 非交互执行模式，适合精准排障与自动化代码交付。",
    type: "cli",
    cliCommand: "codex exec {{prompt}}",
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    maxCostPerTask: 5,
    maxDurationSecs: 1800,
    maxRetries: 3,
    capabilities: ["coding", "bugfix", "test", "review"],
  },
  {
    key: "grok-cli",
    label: "Grok CLI",
    name: "grok-cli",
    description: "Grok CLI 通用主力模型，适合全栈功能交付与快速原型验证。",
    type: "cli",
    cliCommand: "grok -p {{prompt}}",
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    maxCostPerTask: 4,
    maxDurationSecs: 1500,
    maxRetries: 3,
    capabilities: ["coding", "fullstack", "research"],
  },
  {
    key: "antigravity-cli",
    label: "Antigravity CLI",
    name: "antigravity-cli",
    description: "Antigravity (agy) 自主工程 Agent，适合多文件协作与端到端交付。",
    type: "cli",
    cliCommand: "agy -p {{prompt}}",
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    maxCostPerTask: 5,
    maxDurationSecs: 1800,
    maxRetries: 3,
    capabilities: ["coding", "fullstack", "automation", "test"],
  },
  {
    key: "cursor-agent",
    label: "Cursor Agent",
    name: "cursor-agent",
    description: "Cursor CLI Agent，适合前端界面打磨与中大型代码库编辑。",
    type: "cli",
    cliCommand: "cursor-agent -p {{prompt}}",
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    maxCostPerTask: 4,
    maxDurationSecs: 1500,
    maxRetries: 3,
    capabilities: ["coding", "ui", "refactor"],
  },
  {
    key: "local-node-script",
    label: "本地测试脚本模板",
    name: "local-smoke-runner",
    description: "轻量 Node 本地沙盒验证脚本，零外部依赖，适合冒烟与暗工厂链路测试。",
    type: "cli",
    cliCommand:
      'node -e "console.log(\'[smoke] task=\'+process.env.OPC_TASK_ID+\' worktree=\'+process.env.OPC_WORKTREE); console.log(\'total_tokens: 1200 cost_usd: 0.006\');"',
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    maxCostPerTask: 1,
    maxDurationSecs: 120,
    maxRetries: 2,
    capabilities: ["local-test", "smoke", "sandbox"],
  },
];
