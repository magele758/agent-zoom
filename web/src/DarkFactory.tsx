import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AGENT_PRESETS,
  type AgentPreset,
  type AgentRecord,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentType,
  type CircuitBreakerReason,
  type CleanupWorktreesResult,
  type DarkFactoryOverview,
  type FactoryAuditRecord,
  type RunLogEntry,
  type RunLogsResponse,
} from "../../src/dark-factory-types";
import { request } from "./api";
import "./dark-factory.css";

const API_BASE = "/api/opc/factory";

const AGENT_STATUS_LABELS: Record<AgentRecord["status"], string> = {
  idle: "空闲待命",
  running: "执行中",
  error: "上次异常",
  disabled: "已停用",
};

const RUN_STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  pr_open: "PR 已开启",
  completed: "已完成",
  no_output: "无产出 (no_output)",
  failed: "失败",
  cancelled: "已终止",
};

const BREAKER_LABELS: Record<CircuitBreakerReason, string> = {
  cost_limit_exceeded: "费用熔断",
  duration_limit_exceeded: "超时熔断",
  dead_loop_detected: "死循环熔断",
  protected_path_violation: "独占路径拦截",
};

const AUDIT_STATUS_LABELS: Record<FactoryAuditRecord["status"], string> = {
  passed: "审计通过",
  warning: "降级提示",
  blocked: "安全拦截",
};

function formatDurationBadge(secs: number): string {
  if (secs >= 60) {
    const mins = Math.round((secs / 60) * 10) / 10;
    return `${mins} min`;
  }
  return `${secs}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function defaultTaskId(): string {
  return `TASK-${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

interface AgentFormState {
  name: string;
  description: string;
  type: AgentType;
  cliCommand: string;
  promptTemplate: string;
  maxCostPerTask: string;
  maxDurationSecs: string;
  maxRetries: string;
  capabilities: string;
}

function emptyAgentForm(): AgentFormState {
  return {
    name: "",
    description: "",
    type: "cli",
    cliCommand: "",
    promptTemplate:
      "Task [{{task.id}}]: {{task.title}}\nWorktree: {{worktree_path}}\nBranch: {{branch_name}}\n\n{{task.description}}",
    maxCostPerTask: "5",
    maxDurationSecs: "1800",
    maxRetries: "3",
    capabilities: "coding, test",
  };
}

function presetToForm(preset: AgentPreset): AgentFormState {
  return {
    name: preset.name,
    description: preset.description,
    type: preset.type,
    cliCommand: preset.cliCommand,
    promptTemplate: preset.promptTemplate,
    maxCostPerTask: String(preset.maxCostPerTask),
    maxDurationSecs: String(preset.maxDurationSecs),
    maxRetries: String(preset.maxRetries),
    capabilities: preset.capabilities.join(", "),
  };
}

function agentToForm(agent: AgentRecord): AgentFormState {
  return {
    name: agent.name,
    description: agent.description,
    type: agent.type,
    cliCommand: agent.cliCommand,
    promptTemplate: agent.promptTemplate,
    maxCostPerTask: String(agent.maxCostPerTask),
    maxDurationSecs: String(agent.maxDurationSecs),
    maxRetries: String(agent.maxRetries),
    capabilities: agent.capabilities.join(", "),
  };
}

export function DarkFactory({ nav, initialRunId }: { nav?: ReactNode; initialRunId?: string }) {
  const [data, setData] = useState<DarkFactoryOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Agent registry form state
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentForm, setAgentForm] = useState<AgentFormState>(() => emptyAgentForm());

  // Dispatch form state
  const dispatchSectionRef = useRef<HTMLElement | null>(null);
  const [dispatchProject, setDispatchProject] = useState("opc-os");
  const [dispatchTaskId, setDispatchTaskId] = useState(() => defaultTaskId());
  const [dispatchTaskTitle, setDispatchTaskTitle] = useState("");
  const [dispatchTaskDesc, setDispatchTaskDesc] = useState("");
  const [dispatchRepoPath, setDispatchRepoPath] = useState("");
  const [dispatchVerifyCommand, setDispatchVerifyCommand] = useState("");
  const [dispatchAgentId, setDispatchAgentId] = useState("");
  const [dispatchAutoPr, setDispatchAutoPr] = useState(false);
  const [dispatchExecutionHost, setDispatchExecutionHost] = useState<"subprocess" | "herdr">("subprocess");
  const [releases, setReleases] = useState<Array<{
    id: string;
    runId: string | null;
    project: string;
    sourceBranch: string;
    targetBranch: string;
    previousHeadSha: string | null;
    releaseSha: string | null;
    mode: string;
    status: string;
    steps: Array<{ step: string; status: string; commandOrUrl: string; exitCode: number | null; durationMs: number }>;
    errorMessage: string | null;
    createdAt: string;
  }>>([]);

  // Runs filter & live SSE terminal state
  const [runFilter, setRunFilter] = useState<"all" | "active" | "delivered" | "no_output" | "failed">("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId || null);
  useEffect(() => {
    if (initialRunId) setSelectedRunId(initialRunId);
  }, [initialRunId]);
  const [streamLogs, setStreamLogs] = useState<RunLogEntry[]>([]);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "live" | "done" | "error">("idle");
  const [liveRunDetail, setLiveRunDetail] = useState<AgentRunRecord | null>(null);
  const terminalBodyRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await request<DarkFactoryOverview>(`${API_BASE}/overview`);
      setData(next);
      setError("");
      setDispatchAgentId((prev) => {
        if (prev && next.agents.some((a) => a.id === prev && a.status !== "disabled")) return prev;
        const firstEnabled = next.agents.find((a) => a.status !== "disabled");
        return firstEnabled?.id ?? "";
      });
      request<{ releases: typeof releases }>("/api/opc/domains/factory/releases")
        .then((r) => setReleases(r.releases ?? []))
        .catch(() => {});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取暗工厂总览失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh while any run is active or queued
  useEffect(() => {
    if (!data || (data.activeCount === 0 && data.queuedCount === 0)) return;
    const timer = window.setInterval(() => {
      void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [data?.activeCount, data?.queuedCount, load]);

  // Live SSE log stream subscription for the selected run
  useEffect(() => {
    if (!selectedRunId) {
      setStreamLogs([]);
      setStreamState("idle");
      setLiveRunDetail(null);
      return;
    }

    let cancelled = false;
    setStreamLogs([]);
    setStreamState("connecting");

    const seenSeq = new Set<number>();
    const appendEntries = (entries: RunLogEntry[]) => {
      if (cancelled || entries.length === 0) return;
      setStreamLogs((prev) => {
        const additions: RunLogEntry[] = [];
        for (const entry of entries) {
          if (!seenSeq.has(entry.seq)) {
            seenSeq.add(entry.seq);
            additions.push(entry);
          }
        }
        if (additions.length === 0) return prev;
        return [...prev, ...additions].sort((a, b) => a.seq - b.seq);
      });
    };

    const loadFallbackLogs = async () => {
      try {
        const res = await request<RunLogsResponse>(`${API_BASE}/runs/${encodeURIComponent(selectedRunId)}/logs`);
        if (cancelled) return;
        appendEntries(res.logs);
        setStreamState(["running", "queued"].includes(res.status) ? "error" : "done");
      } catch {
        if (!cancelled) setStreamState("error");
      }
    };

    if (typeof EventSource === "undefined") {
      void loadFallbackLogs();
      return () => {
        cancelled = true;
      };
    }

    const es = new EventSource(`${API_BASE}/runs/${encodeURIComponent(selectedRunId)}/stream`, {
      withCredentials: true,
    });

    es.onopen = () => {
      if (!cancelled) setStreamState("live");
    };

    es.addEventListener("state", (event) => {
      if (cancelled) return;
      try {
        const run = JSON.parse((event as MessageEvent).data) as AgentRunRecord;
        setLiveRunDetail(run);
        if (!["running", "queued"].includes(run.status)) {
          setStreamState("done");
        } else {
          setStreamState("live");
        }
      } catch {
        // ignore malformed frame
      }
    });

    es.addEventListener("log", (event) => {
      if (cancelled) return;
      try {
        const entry = JSON.parse((event as MessageEvent).data) as RunLogEntry;
        appendEntries([entry]);
      } catch {
        // ignore malformed frame
      }
    });

    es.addEventListener("done", (event) => {
      if (cancelled) return;
      try {
        const run = JSON.parse((event as MessageEvent).data) as AgentRunRecord;
        setLiveRunDetail(run);
      } catch {
        // ignore malformed frame
      }
      setStreamState("done");
      es.close();
      void load();
    });

    es.onerror = () => {
      if (cancelled) return;
      es.close();
      void loadFallbackLogs();
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [selectedRunId, load]);

  // Auto-scroll terminal to bottom when logs arrive
  useEffect(() => {
    const el = terminalBodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamLogs.length]);

  const presets = data?.presets?.length ? data.presets : AGENT_PRESETS;

  const knownProjects = useMemo(() => {
    const set = new Set<string>(["opc-os"]);
    for (const run of data?.runs ?? []) {
      if (run.project) set.add(run.project);
    }
    return [...set];
  }, [data?.runs]);

  const filteredRuns = useMemo(() => {
    const runs = data?.runs ?? [];
    if (runFilter === "all") return runs;
    if (runFilter === "active") return runs.filter((r) => r.status === "running" || r.status === "queued");
    if (runFilter === "delivered") return runs.filter((r) => r.status === "completed" || r.status === "pr_open");
    if (runFilter === "no_output") return runs.filter((r) => r.status === "no_output");
    return runs.filter((r) => r.status === "failed" || r.status === "cancelled");
  }, [data?.runs, runFilter]);

  const selectedRun = useMemo(() => {
    if (!selectedRunId) return null;
    const fromOverview = data?.runs.find((r) => r.id === selectedRunId) ?? null;
    if (liveRunDetail && liveRunDetail.id === selectedRunId) {
      return fromOverview && fromOverview.updatedAt > liveRunDetail.updatedAt ? fromOverview : liveRunDetail;
    }
    return fromOverview;
  }, [selectedRunId, data?.runs, liveRunDetail]);

  const openNewAgentForm = (preset?: AgentPreset) => {
    setEditingAgentId(null);
    setAgentForm(preset ? presetToForm(preset) : emptyAgentForm());
    setShowAgentForm(true);
  };

  const openEditAgentForm = (agent: AgentRecord) => {
    setEditingAgentId(agent.id);
    setAgentForm(agentToForm(agent));
    setShowAgentForm(true);
  };

  const handleSaveAgent = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice(editingAgentId ? "正在保存 Agent 配置…" : "正在注册新 Agent…");
    try {
      const payload = {
        name: agentForm.name.trim(),
        description: agentForm.description.trim(),
        type: agentForm.type,
        cliCommand: agentForm.cliCommand.trim(),
        promptTemplate: agentForm.promptTemplate,
        maxCostPerTask: Number(agentForm.maxCostPerTask) || 5,
        maxDurationSecs: Number(agentForm.maxDurationSecs) || 1800,
        maxRetries: Math.max(1, Math.floor(Number(agentForm.maxRetries) || 3)),
        capabilities: agentForm.capabilities
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      const saved = editingAgentId
        ? await request<AgentRecord>(`${API_BASE}/agents/${encodeURIComponent(editingAgentId)}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await request<AgentRecord>(`${API_BASE}/agents`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
      setShowAgentForm(false);
      setEditingAgentId(null);
      setNotice(editingAgentId ? `Agent「${saved.name}」配置已更新` : `已注册自治 Agent「${saved.name}」`);
      await load();
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "保存 Agent 失败");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAgent = async (agent: AgentRecord) => {
    setBusy(true);
    setError("");
    const nextStatus = agent.status === "disabled" ? "idle" : "disabled";
    try {
      await request<AgentRecord>(`${API_BASE}/agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setNotice(`Agent「${agent.name}」已${nextStatus === "disabled" ? "停用" : "重新启用"}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换 Agent 状态失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAgent = async (agent: AgentRecord) => {
    setBusy(true);
    setError("");
    try {
      await request<{ deleted: boolean }>(`${API_BASE}/agents/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
      });
      setNotice(`已删除 Agent「${agent.name}」`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除 Agent 失败");
    } finally {
      setBusy(false);
    }
  };

  const handleQuickTestDispatch = () => {
    setDispatchTaskId(defaultTaskId());
    setDispatchTaskTitle("暗工厂沙盒冒烟验证任务");
    setDispatchTaskDesc("验证沙盒环境变量清洗、实时终端日志流与 Token 成本统计闭环。");
    dispatchSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleDispatch = async (e: FormEvent) => {
    e.preventDefault();
    if (!dispatchAgentId) {
      setError("请先注册并选择一个可用的 Agent");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("正在派发任务至自治暗工厂队列…");
    try {
      const run = await request<AgentRunRecord>(`${API_BASE}/dispatch`, {
        method: "POST",
        body: JSON.stringify({
          taskId: dispatchTaskId.trim() || defaultTaskId(),
          taskTitle: dispatchTaskTitle.trim(),
          taskDescription: dispatchTaskDesc.trim(),
          project: dispatchProject.trim(),
          repoPath: dispatchRepoPath.trim() || undefined,
          verifyCommand: dispatchVerifyCommand.trim() || undefined,
          agentId: dispatchAgentId,
          autoCreatePr: dispatchAutoPr,
          executionHost: dispatchExecutionHost,
        }),
      });
      setDispatchTaskId(defaultTaskId());
      setDispatchTaskTitle("");
      setDispatchTaskDesc("");
      setSelectedRunId(run.id);
      setNotice(
        run.status === "queued"
          ? `任务已进入并发队列（${run.id}），等待槽位释放后自动拉起`
          : `任务已拉起执行（${run.id}），下方实时终端已接管监工`,
      );
      await load();
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "派发任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleKillRun = async (runId: string) => {
    setBusy(true);
    setError("");
    try {
      await request<AgentRunRecord>(`${API_BASE}/runs/${encodeURIComponent(runId)}/kill`, {
        method: "POST",
        body: "{}",
      });
      setNotice(`已发送终止指令给任务 ${runId}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "终止运行失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRetryRun = async (runId: string) => {
    setBusy(true);
    setError("");
    try {
      const next = await request<AgentRunRecord>(`${API_BASE}/runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST",
        body: "{}",
      });
      setSelectedRunId(next.id);
      setNotice(`已重新派发任务，新运行 ID：${next.id}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重试运行失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePr = async (runId: string) => {
    setBusy(true);
    setError("");
    setNotice("正在推送 Worktree 分支并创建 Pull Request…");
    try {
      const updated = await request<AgentRunRecord>(`${API_BASE}/runs/${encodeURIComponent(runId)}/pr`, {
        method: "POST",
        body: "{}",
      });
      setNotice(updated.prUrl ? `PR 创建成功：${updated.prUrl}` : "已完成 PR 创建请求");
      await load();
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "创建 PR 失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRequestRelease = async (runId: string) => {
    setBusy(true);
    setError("");
    setNotice("正在生成发布单并提交至总裁审批网关…");
    try {
      await request(`/api/opc/domains/factory/runs/${encodeURIComponent(runId)}/request-release`, {
        method: "POST",
        body: "{}",
      });
      setNotice("已提交真上线审批包至「总裁审批网关 (#mailbox)」，批准后将自动执行分支合入、构建、部署与探针验收。");
      await load();
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "发起发布审批失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRollbackRelease = async (releaseId: string) => {
    setBusy(true);
    setError("");
    setNotice("正在执行紧急回滚（git reset 恢复前置提交并执行回滚钩子）…");
    try {
      await request(`/api/opc/domains/factory/releases/${encodeURIComponent(releaseId)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ reason: "暗工厂工作台人工触发紧急回滚" }),
      });
      setNotice(`发布单 ${releaseId} 已回滚至上线前提交锚点。`);
      await load();
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "执行回滚失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCleanupWorktrees = async (runId?: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await request<CleanupWorktreesResult>(`${API_BASE}/worktrees/cleanup`, {
        method: "POST",
        body: JSON.stringify(runId ? { runId } : {}),
      });
      setNotice(
        `Worktree 清理完成：已移除 ${result.cleaned.length} 个，跳过 ${result.skipped.length} 个，Prune 仓库 ${result.prunedRepos.length} 个。`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清理 Worktree 失败");
    } finally {
      setBusy(false);
    }
  };

  const handleBootstrapAudit = async () => {
    setBusy(true);
    setError("");
    setNotice("正在执行分形 CI/CD 自举保护路径审计…");
    try {
      const audit = await request<FactoryAuditRecord>(`${API_BASE}/bootstrap-audit`, {
        method: "POST",
        body: "{}",
      });
      setNotice(`审计完成（${AUDIT_STATUS_LABELS[audit.status]}）：${audit.summary}`);
      await load();
    } catch (reason) {
      setNotice("");
      setError(reason instanceof Error ? reason.message : "执行自举保护审计失败");
    } finally {
      setBusy(false);
    }
  };

  const activeCount = data?.activeCount ?? 0;
  const queuedCount = data?.queuedCount ?? 0;
  const maxConcurrent = data?.maxConcurrentAgents ?? 3;
  const occupancyPct = Math.min(100, Math.round((activeCount / Math.max(1, maxConcurrent)) * 100));

  return (
    <section className="zo-product df-page" aria-label="自治 Agent 暗工厂">
      <header className="df-head">
        <div>
          <div className="df-title-row">
            {nav}
            <h1>自治 Agent 暗工厂</h1>
            <span className={`df-pulse-pill ${activeCount > 0 ? "is-active" : ""}`}>
              <span className="df-pulse-dot" aria-hidden="true" />
              运行中 {activeCount} / {maxConcurrent}
              {queuedCount > 0 ? ` · 排队 ${queuedCount}` : ""}
            </span>
          </div>
          <p className="df-sub">
            以独立 Git Worktree 沙盒并行调度编程 Agent，内置费用 / 超时 / 死循环 / 自举人类独占路径四重自动熔断与 SSE 实时监工。
          </p>
        </div>

        <div className="df-toolbar">
          <button type="button" className="df-primary" disabled={busy} onClick={() => openNewAgentForm()}>
            + 注册 Agent
          </button>
          <button type="button" className="df-accent" disabled={busy} onClick={handleQuickTestDispatch}>
            + 立即派发测试任务
          </button>
          <button type="button" disabled={busy} onClick={() => void load()}>
            刷新状态
          </button>
          <a className="df-link-btn" href="#planning">
            任务看板 ↗
          </a>
          <a className="df-link-btn" href="#metabolism?tab=providers">
            并发与路径保护 ↗
          </a>
        </div>
      </header>

      {notice && (
        <p role="status" className="df-banner">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="df-banner error">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">正在加载暗工厂状态与执行记录…</p>}

      {data && (
        <>
          <div className="df-kpis" aria-label="暗工厂运行指标">
            <div className="df-kpi">
              <span>并发调度槽位</span>
              <strong>
                {activeCount} / {maxConcurrent}
              </strong>
              <small>{queuedCount > 0 ? `FIFO 队列等待 ${queuedCount} 项` : "队列畅通，随时可派发"}</small>
            </div>
            <div className="df-kpi">
              <span>已注册自治 Agent</span>
              <strong>{data.agents.length}</strong>
              <small>
                运行 {data.agents.filter((a) => a.status === "running").length} · 可用{" "}
                {data.agents.filter((a) => a.status !== "disabled").length} · 停用{" "}
                {data.agents.filter((a) => a.status === "disabled").length}
              </small>
            </div>
            <div className="df-kpi">
              <span>30 天执行与交付</span>
              <strong>{data.metrics.totalRuns}</strong>
              <small>
                完工/PR {data.metrics.completedRuns + data.metrics.prOpenRuns} · 无产出 {data.metrics.noOutputRuns} ·
                失败 {data.metrics.failedRuns}
              </small>
            </div>
            <div className="df-kpi">
              <span>30 天算力消耗</span>
              <strong>${data.metrics.totalCostUsd.toFixed(4)}</strong>
              <small>累计 {formatTokens(data.metrics.totalTokens)} tokens</small>
            </div>
          </div>

          {/* 1. Agent Registry Grid */}
          <section className="df-section" aria-label="Agent 注册表">
            <div className="df-section-head">
              <div>
                <h2>1. Agent 注册表</h2>
                <p className="df-muted">管理可调度 CLI / API / MCP 执行器及其单任务费用、超时与死循环红线。</p>
              </div>
              <button
                type="button"
                className="df-primary"
                onClick={() => (showAgentForm ? setShowAgentForm(false) : openNewAgentForm())}
              >
                {showAgentForm ? "收起表单" : "+ 注册 Agent"}
              </button>
            </div>

            {showAgentForm && (
              <div className="df-panel df-agent-form-wrap">
                <div className="df-preset-bar">
                  <span className="df-preset-label">一键套用预置模板：</span>
                  {presets.map((preset) => (
                    <button
                      key={preset.key}
                      type="button"
                      className="df-preset-btn"
                      onClick={() => setAgentForm(presetToForm(preset))}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <form className="df-form" onSubmit={(e) => void handleSaveAgent(e)}>
                  <div className="df-form-row">
                    <label>
                      Agent 名称 *
                      <input
                        required
                        value={agentForm.name}
                        onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
                        placeholder="例如 claude-code / codex-cli"
                      />
                    </label>
                    <label>
                      执行类型
                      <select
                        value={agentForm.type}
                        onChange={(e) => setAgentForm({ ...agentForm, type: e.target.value as AgentType })}
                      >
                        <option value="cli">CLI 子进程</option>
                        <option value="api">API 执行器</option>
                        <option value="mcp">MCP 执行器</option>
                      </select>
                    </label>
                    <label>
                      能力标签（逗号分隔）
                      <input
                        value={agentForm.capabilities}
                        onChange={(e) => setAgentForm({ ...agentForm, capabilities: e.target.value })}
                        placeholder="coding, refactor, test"
                      />
                    </label>
                  </div>

                  <label>
                    简介说明
                    <input
                      value={agentForm.description}
                      onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })}
                      placeholder="擅长场景与定位"
                    />
                  </label>

                  <label>
                    CLI 执行命令 *（支持 {"{{prompt}}"} 占位符与安全拆参，不经由 shell 注入）
                    <input
                      required
                      className="df-mono-input"
                      value={agentForm.cliCommand}
                      onChange={(e) => setAgentForm({ ...agentForm, cliCommand: e.target.value })}
                      placeholder="claude -p {{prompt}} --output-format text"
                    />
                  </label>

                  <label>
                    Prompt 模板（可用变量：{"{{task.id}}"}、{"{{task.title}}"}、{"{{task.description}}"}、
                    {"{{worktree_path}}"}、{"{{branch_name}}"}）
                    <textarea
                      rows={4}
                      className="df-mono-input"
                      value={agentForm.promptTemplate}
                      onChange={(e) => setAgentForm({ ...agentForm, promptTemplate: e.target.value })}
                    />
                  </label>

                  <div className="df-form-row">
                    <label>
                      单任务费用红线 (USD)
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={agentForm.maxCostPerTask}
                        onChange={(e) => setAgentForm({ ...agentForm, maxCostPerTask: e.target.value })}
                      />
                    </label>
                    <label>
                      最长运行时间 (秒)
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={agentForm.maxDurationSecs}
                        onChange={(e) => setAgentForm({ ...agentForm, maxDurationSecs: e.target.value })}
                      />
                    </label>
                    <label>
                      stderr 错误熔断阈值 (次)
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={agentForm.maxRetries}
                        onChange={(e) => setAgentForm({ ...agentForm, maxRetries: e.target.value })}
                      />
                    </label>
                  </div>

                  <div className="df-form-actions">
                    <button type="submit" className="df-primary" disabled={busy}>
                      {editingAgentId ? "保存修改" : "确认注册"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAgentForm(false);
                        setEditingAgentId(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </form>
              </div>
            )}

            {data.agents.length === 0 ? (
              <div className="df-empty-box">
                <p>尚未注册任何自治 Agent。点击上方「+ 注册 Agent」或直接套用下方常用模板：</p>
                <div className="df-preset-bar">
                  {presets.map((preset) => (
                    <button
                      key={preset.key}
                      type="button"
                      className="df-preset-btn"
                      onClick={() => openNewAgentForm(preset)}
                    >
                      + {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="df-agent-grid">
                {data.agents.map((agent) => (
                  <article key={agent.id} className={`df-agent-card status-${agent.status}`}>
                    <div className="df-agent-top">
                      <div className="df-agent-name-wrap">
                        <h3>{agent.name}</h3>
                        <span className="df-type-chip">{agent.type.toUpperCase()}</span>
                      </div>
                      <span className={`df-badge status-${agent.status}`}>
                        {AGENT_STATUS_LABELS[agent.status]}
                      </span>
                    </div>

                    {agent.description && <p className="df-agent-desc">{agent.description}</p>}

                    <code className="df-cmd" title={agent.cliCommand}>
                      {agent.cliCommand}
                    </code>

                    <div className="df-tags">
                      {agent.capabilities.length > 0 ? (
                        agent.capabilities.map((cap) => (
                          <span key={cap} className="df-tag">
                            {cap}
                          </span>
                        ))
                      ) : (
                        <span className="df-muted">未标注能力标签</span>
                      )}
                    </div>

                    <div className="df-redline">
                      <span>熔断红线：</span>
                      <strong>
                        max ${agent.maxCostPerTask} · {formatDurationBadge(agent.maxDurationSecs)} · retry{" "}
                        {agent.maxRetries}
                      </strong>
                    </div>

                    <div className="df-card-actions">
                      <button type="button" disabled={busy} onClick={() => openEditAgentForm(agent)}>
                        编辑
                      </button>
                      <button type="button" disabled={busy} onClick={() => void handleToggleAgent(agent)}>
                        {agent.status === "disabled" ? "启用" : "停用"}
                      </button>
                      <button
                        type="button"
                        className="df-danger-btn"
                        disabled={busy}
                        onClick={() => void handleDeleteAgent(agent)}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {/* 2. Quick Dispatch Console + Concurrency Gauge */}
          <section className="df-section" ref={dispatchSectionRef} aria-label="快速派发台">
            <div className="df-section-head">
              <div>
                <h2>2. 快速派发台 & 并发调度队列</h2>
                <p className="df-muted">超额任务自动进入 FIFO 队列，待运行中槽位释放后无缝拉起。</p>
              </div>
              <span className="df-badge">
                Running {activeCount} / Max {maxConcurrent} · 排队 {queuedCount}
              </span>
            </div>

            <div className="df-panel">
              <div className="df-concurrency-bar">
                <div className="df-concurrency-meta">
                  <strong>
                    当前并发负载：{activeCount} / {maxConcurrent}
                  </strong>
                  <span className="df-muted">
                    {queuedCount > 0 ? `${queuedCount} 个任务排队待执行` : "暂无排队任务"}
                  </span>
                </div>
                <div className="df-progress-track" role="progressbar" aria-valuenow={occupancyPct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="df-progress-fill" style={{ width: `${occupancyPct}%` }} />
                </div>
              </div>

              <form className="df-form" onSubmit={(e) => void handleDispatch(e)}>
                <div className="df-form-row">
                  <label>
                    归属项目
                    <input
                      list="df-known-projects"
                      value={dispatchProject}
                      onChange={(e) => setDispatchProject(e.target.value)}
                      placeholder="例如 opc-os / pagelens"
                    />
                    <datalist id="df-known-projects">
                      {knownProjects.map((p) => (
                        <option key={p} value={p} />
                      ))}
                    </datalist>
                  </label>

                  <label>
                    任务编号 (Task ID) *
                    <input
                      required
                      value={dispatchTaskId}
                      onChange={(e) => setDispatchTaskId(e.target.value)}
                      placeholder="TASK-1024"
                    />
                  </label>

                  <label>
                    执行 Agent *
                    <select
                      required
                      value={dispatchAgentId}
                      onChange={(e) => setDispatchAgentId(e.target.value)}
                    >
                      <option value="">请选择可用 Agent</option>
                      {data.agents.map((agent) => (
                        <option key={agent.id} value={agent.id} disabled={agent.status === "disabled"}>
                          {agent.name} ({AGENT_STATUS_LABELS[agent.status]})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    执行宿主
                    <select
                      aria-label="执行宿主"
                      value={dispatchExecutionHost}
                      onChange={(e) => setDispatchExecutionHost(e.target.value as "subprocess" | "herdr")}
                    >
                      <option value="subprocess">后台子进程（默认静默）</option>
                      <option value="herdr">Herdr 项目空间（可随时切屏接管）</option>
                    </select>
                  </label>
                </div>

                <div className="df-form-row">
                  <label>
                    任务标题 *
                    <input
                      required
                      value={dispatchTaskTitle}
                      onChange={(e) => setDispatchTaskTitle(e.target.value)}
                      placeholder="例如：修复支付回调幂等校验并补充单测"
                    />
                  </label>
                  <label>
                    本地 Git 仓库路径（留空则按统一资产树解析）
                    <input
                      className="df-mono-input"
                      value={dispatchRepoPath}
                      onChange={(e) => setDispatchRepoPath(e.target.value)}
                      placeholder="/Users/you/workspace/my-repo"
                    />
                  </label>
                  <label>
                    外部确定性验收门禁 (verifyCommand，留空继承资产契约)
                    <input
                      className="df-mono-input"
                      value={dispatchVerifyCommand}
                      onChange={(e) => setDispatchVerifyCommand(e.target.value)}
                      placeholder="例如：npm test && npm run typecheck"
                    />
                  </label>
                </div>

                <label>
                  任务描述与验收标准
                  <textarea
                    rows={3}
                    value={dispatchTaskDesc}
                    onChange={(e) => setDispatchTaskDesc(e.target.value)}
                    placeholder="填写背景、改动范围与自测要求，将自动渲染进 Agent Prompt 模板。"
                  />
                </label>

                <div className="df-dispatch-foot">
                  <label className="df-checkbox">
                    <input
                      type="checkbox"
                      checked={dispatchAutoPr}
                      onChange={(e) => setDispatchAutoPr(e.target.checked)}
                    />
                    <span>完工后自动推送分支并执行 gh pr create（触碰人类独占路径时自动拦截）</span>
                  </label>
                  <button
                    type="submit"
                    className="df-primary"
                    disabled={busy || !dispatchAgentId || !dispatchTaskTitle.trim()}
                  >
                    立即派发任务
                  </button>
                </div>
              </form>
            </div>
          </section>

          {/* 3. Recent Runs Table + Real-Time Terminal Monitor */}
          <section className="df-section" aria-label="最近执行记录与实时终端">
            <div className="df-section-head">
              <div>
                <h2>3. 最近执行记录 & 实时终端监工</h2>
                <p className="df-muted">点击「▶ 实时终端」通过 SSE 实时查看 stdout/stderr 日志流与保护路径核验详情。</p>
              </div>
              <div className="df-filter-tabs" role="tablist">
                {(
                  [
                    ["all", "全部"],
                    ["active", "运行/排队"],
                    ["delivered", "完工/PR"],
                    ["no_output", "无产出"],
                    ["failed", "失败/熔断"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={runFilter === key}
                    onClick={() => setRunFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {filteredRuns.length === 0 ? (
              <div className="df-empty-box">当前筛选条件下暂无执行记录。</div>
            ) : (
              <div className="df-table-wrap opc-table-scroll" role="region" aria-label="暗工厂执行记录" tabIndex={0}>
                <table className="df-table">
                  <thead>
                    <tr>
                      <th>任务与项目</th>
                      <th>Agent 与分支</th>
                      <th>状态与熔断徽章</th>
                      <th>Token & 费用</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRuns.map((run) => (
                      <tr key={run.id} className={selectedRunId === run.id ? "is-selected" : ""}>
                        <td>
                          <div className="df-run-title">{run.taskTitle}</div>
                          <div className="df-run-meta">
                            <span>{run.taskId}</span>
                            {run.project && <span>· {run.project}</span>}
                            <span>· {formatDateTime(run.createdAt)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="df-run-agent">{run.agentName}</div>
                          <div className="df-run-branch" title={run.branchName ?? run.worktreePath ?? ""}>
                            {run.branchName || "非 Git 沙盒"}
                          </div>
                          {(run.executionHost === "herdr" || run.herdrTerminal) && (
                            <span
                              className="df-tag"
                              style={{ marginTop: 4, display: "inline-block" }}
                              title={`Herdr Space: ${run.herdrSpace ?? "默认"} · 终端: ${run.herdrTerminal ?? "等待分配"}`}
                            >
                              Herdr · {run.herdrTerminal || "挂载中"}
                              {run.herdrSpace ? ` (${run.herdrSpace})` : ""}
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="df-status-stack">
                            <span className={`df-badge run-${run.status}`}>{RUN_STATUS_LABELS[run.status]}</span>
                            {run.verification && (
                              <span className={`df-badge ${run.verification.passed ? "audit-passed" : "run-failed"}`}>
                                {run.verification.passed ? "✓ 外部校验通过" : `✗ 校验失败 (${run.verification.exitCode})`}
                              </span>
                            )}
                            {run.circuitBreakerReason && (
                              <span className={`df-badge breaker-${run.circuitBreakerReason}`}>
                                {run.circuitBreakerReason === "protected_path_violation" ? "🛡 " : "⚡ "}
                                {BREAKER_LABELS[run.circuitBreakerReason]}
                              </span>
                            )}
                          </div>
                          {run.errorSummary && (
                            <div className="df-run-err" title={run.errorSummary}>
                              {run.errorSummary}
                            </div>
                          )}
                        </td>
                        <td className="df-mono-cell">
                          <div>{formatTokens(run.tokenUsed)} tok</div>
                          <small>${run.costUsd.toFixed(4)}</small>
                        </td>
                        <td>
                          <div className="df-row-actions">
                            {run.prUrl && (
                              <a className="df-pr-link" href={run.prUrl} target="_blank" rel="noreferrer">
                                PR ↗
                              </a>
                            )}
                              {!run.prUrl &&
                              run.status === "completed" &&
                              run.branchName &&
                              run.worktreePath &&
                              run.protectedViolations.length === 0 && (
                                <button type="button" disabled={busy} onClick={() => void handleCreatePr(run.id)}>
                                  生成 PR
                                </button>
                              )}
                            {(run.status === "completed" || run.status === "pr_open") &&
                              run.branchName &&
                              run.protectedViolations.length === 0 && (
                                <button
                                  type="button"
                                  className="df-primary"
                                  disabled={busy}
                                  onClick={() => void handleRequestRelease(run.id)}
                                >
                                  🚀 申请合入真上线
                                </button>
                              )}
                            {(run.status === "running" || run.status === "queued") && (
                              <button
                                type="button"
                                className="df-danger-btn"
                                disabled={busy}
                                onClick={() => void handleKillRun(run.id)}
                              >
                                Kill
                              </button>
                            )}
                            {run.status !== "running" && run.status !== "queued" && (
                              <button type="button" disabled={busy} onClick={() => void handleRetryRun(run.id)}>
                                重试
                              </button>
                            )}
                            <button
                              type="button"
                              className={selectedRunId === run.id ? "df-primary" : ""}
                              onClick={() => setSelectedRunId(selectedRunId === run.id ? null : run.id)}
                            >
                              {selectedRunId === run.id ? "■ 收起终端" : "▶ 实时终端"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selectedRun && (
              <div className="df-terminal-wrap" aria-label="实时终端监工面板">
                <div className="df-terminal-head">
                  <div className="df-terminal-title">
                    <span
                      className={`df-term-dot ${streamState === "live" || selectedRun.status === "running" ? "live" : "done"}`}
                      aria-hidden="true"
                    />
                    <strong>
                      {selectedRun.taskTitle} ({selectedRun.id})
                    </strong>
                    <span className="df-term-sub">
                      {selectedRun.agentName} ·{" "}
                      {streamState === "live"
                        ? "SSE 实时流监工中"
                        : streamState === "connecting"
                          ? "连接日志流…"
                          : streamState === "done"
                            ? "历史回放完成"
                            : "已切换日志快照"}
                    </span>
                  </div>
                  <div className="df-terminal-actions">
                    {(selectedRun.status === "running" || selectedRun.status === "queued") && (
                      <button
                        type="button"
                        className="df-danger-btn"
                        disabled={busy}
                        onClick={() => void handleKillRun(selectedRun.id)}
                      >
                        SIGKILL 终止
                      </button>
                    )}
                    <button type="button" onClick={() => setSelectedRunId(null)}>
                      关闭面板
                    </button>
                  </div>
                </div>

                <div className="df-terminal-body" ref={terminalBodyRef}>
                  {streamLogs.length === 0 ? (
                    <div className="df-term-empty">等待子进程输出日志…</div>
                  ) : (
                    streamLogs.map((entry) => (
                      <div key={entry.seq} className={`df-term-line stream-${entry.stream}`}>
                        <span className="df-term-ts">{formatTime(entry.timestamp)}</span>
                        <span className="df-term-tag">{entry.stream.toUpperCase()}</span>
                        <span className="df-term-text">{entry.line}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="df-terminal-meta">
                  {selectedRun.protectedViolations.length > 0 && (
                    <div className="df-violation-alert" role="alert">
                      <strong>🛡 自举人类独占路径拦截告警（已禁止自动创建 PR）</strong>
                      <p>本次执行触碰了以下受保护路径，须由人类开发者审查处理：</p>
                      <ul>
                        {selectedRun.protectedViolations.map((file) => (
                          <li key={file}>
                            <code>{file}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selectedRun.errorSummary && selectedRun.protectedViolations.length === 0 && (
                    <div className="df-meta-note warn">
                      <strong>诊断摘要：</strong> {selectedRun.errorSummary}
                    </div>
                  )}

                  <div className="df-changed-files">
                    <strong>变更文件 ({selectedRun.changedFiles.length})：</strong>
                    {selectedRun.changedFiles.length === 0 ? (
                      <span className="df-muted">无文件改动</span>
                    ) : (
                      <div className="df-file-chips">
                        {selectedRun.changedFiles.map((file) => (
                          <code
                            key={file}
                            className={selectedRun.protectedViolations.includes(file) ? "is-violated" : ""}
                          >
                            {file}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 4. Git Worktrees & Self-Bootstrap Protection Audit */}
          <section className="df-section" aria-label="Git Worktree 与自举保护审计">
            <div className="df-split-grid">
              <div className="df-panel">
                <div className="df-subhead">
                  <div>
                    <h3>4A. Git Worktree 隔离池</h3>
                    <p className="df-muted">当前活跃或残留在磁盘上的隔离工作树 ({data.worktrees.length})。</p>
                  </div>
                  <button
                    type="button"
                    disabled={busy || data.worktrees.filter((w) => w.cleanable).length === 0}
                    onClick={() => void handleCleanupWorktrees()}
                  >
                    一键清理已完成 Worktree
                  </button>
                </div>

                {data.worktrees.length === 0 ? (
                  <p className="df-muted">当前无活跃或残留 Worktree，磁盘洁净。</p>
                ) : (
                  <ul className="df-wt-list">
                    {data.worktrees.map((wt) => (
                      <li key={wt.runId} className="df-wt-item">
                        <div className="df-wt-main">
                          <div className="df-wt-top">
                            <strong>{wt.branchName || wt.runId}</strong>
                            <span className={`df-badge run-${wt.runStatus}`}>{RUN_STATUS_LABELS[wt.runStatus]}</span>
                          </div>
                          <div className="df-wt-task">
                            {wt.taskTitle} · {wt.agentName}
                          </div>
                          <code className="df-wt-path">{wt.worktreePath}</code>
                        </div>
                        {wt.cleanable && (
                          <button type="button" disabled={busy} onClick={() => void handleCleanupWorktrees(wt.runId)}>
                            清理
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="df-panel">
                <div className="df-subhead">
                  <div>
                    <h3>4B. 自举人类独占路径保护 & 审计</h3>
                    <p className="df-muted">防止自治 Agent 在自举循环中篡改核心控制面与安全底座。</p>
                  </div>
                  <button type="button" className="df-primary" disabled={busy} onClick={() => void handleBootstrapAudit()}>
                    执行自举保护审计
                  </button>
                </div>

                <div className="df-protected-list">
                  <span className="df-muted">受保护路径规则 ({data.protectedPaths.length})：</span>
                  <div className="df-file-chips">
                    {data.protectedPaths.map((rule) => (
                      <code key={rule} className="df-protected-chip">
                        🔒 {rule}
                      </code>
                    ))}
                  </div>
                </div>

                {data.audits.length === 0 ? (
                  <p className="df-muted">尚无自举审计记录，点击右上角立即检查当前仓库工作区。</p>
                ) : (
                  <ul className="df-audit-list">
                    {data.audits.map((audit) => (
                      <li key={audit.id} className={`df-audit-item audit-${audit.status}`}>
                        <div className="df-audit-top">
                          <span className={`df-badge audit-${audit.status}`}>{AUDIT_STATUS_LABELS[audit.status]}</span>
                          <time>{formatDateTime(audit.createdAt)}</time>
                        </div>
                        <p>{audit.summary}</p>
                        {audit.details.violations.length > 0 && (
                          <div className="df-file-chips">
                            {audit.details.violations.map((v) => (
                              <code key={v} className="is-violated">
                                {v}
                              </code>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {/* 5. Real Release Pipeline & Auto-Rollback Ledger */}
          <section className="df-section" aria-label="真发布上线与回滚流水线">
            <div className="df-section-head">
              <div>
                <h2>5. 真发布上线管线 & 自动回滚台账 (ReleasePipeline)</h2>
                <p className="df-muted">
                  在总裁审批网关批准后，按「前置校验 → 分支合入 → 确定性测试 → 构建 → 部署命令 → 健康探针 → 失败自动 git reset 回滚」真实执行。
                </p>
              </div>
              <a className="df-pr-link" href="#mailbox">
                前往总裁审批网关拍板 ↗
              </a>
            </div>
            {releases.length === 0 ? (
              <div className="df-empty-box">暂无发布记录。在上方完工任务点击「🚀 申请合入真上线」即可发起。</div>
            ) : (
              <div className="df-table-wrap opc-table-scroll" role="region" aria-label="项目发布记录" tabIndex={0}>
                <table className="df-table">
                  <thead>
                    <tr>
                      <th>项目与分支</th>
                      <th>状态与模式</th>
                      <th>提交锚点 (前 → 后)</th>
                      <th>真实步骤轨迹</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {releases.map((rel) => (
                      <tr key={rel.id}>
                        <td>
                          <div className="df-run-title">{rel.project}</div>
                          <div className="df-run-meta">
                            <code>{rel.sourceBranch}</code> → <code>{rel.targetBranch}</code>
                          </div>
                        </td>
                        <td>
                          <span className={`df-badge ${rel.status === "succeeded" ? "audit-passed" : rel.status === "pending_approval" ? "run-queued" : "run-failed"}`}>
                            {rel.status}
                          </span>
                          <div className="df-run-meta">{rel.mode}</div>
                        </td>
                        <td className="df-mono-cell">
                          <small>
                            {rel.previousHeadSha ? rel.previousHeadSha.slice(0, 7) : "—"} →{" "}
                            {rel.releaseSha ? rel.releaseSha.slice(0, 7) : "—"}
                          </small>
                        </td>
                        <td>
                          <div className="df-file-chips">
                            {rel.steps.map((st, idx) => (
                              <code key={idx} className={st.status === "failed" ? "is-violated" : ""}>
                                {st.status === "passed" ? "✓" : st.status === "failed" ? "✗" : "·"} {st.step}
                              </code>
                            ))}
                          </div>
                          {rel.errorMessage && <div className="df-run-err">{rel.errorMessage}</div>}
                        </td>
                        <td>
                          {rel.status === "succeeded" && rel.previousHeadSha && (
                            <button
                              type="button"
                              className="df-danger-btn"
                              disabled={busy}
                              onClick={() => void handleRollbackRelease(rel.id)}
                            >
                              紧急回滚
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
