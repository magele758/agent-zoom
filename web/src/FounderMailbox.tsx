import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Token, Tokens } from "marked";
import type {
  ExecutiveDepartmentId,
  ExecutiveMailboxResponse,
} from "../../src/executive-bots-types";
import type {
  BatchResolveDecisionResult,
  DecisionBatchAction,
  DecisionPacket,
  GovernancePolicy,
} from "../../src/kernel/types";
import type { ZoomMessage } from "../../src/zoom-types";
import { buildMailboxIssues, type MailboxIssue, type MailboxRecord } from "../../src/executive-mailbox-issues";
import { api, request } from "./api";
import { LinkedText } from "./InternalLinks";
import { DelegateWork } from "./Delegation";
import { WorkflowMessageContent } from "./WorkflowBoard";
import { ApprovalCommands, ReceiptOverview, receiptPreview, receiptTitle, taskStateLabel } from "./ExecutiveReceipt";
import { MailboxIssueHistory, issueTaskTitle } from "./MailboxIssueHistory";
import type { WorkflowDetail } from "../../src/workflow-types";
import { decisionTarget } from "./zoom-routes";
import { messageText } from "./zoom-view";
import "./founder-mailbox.css";

type MailFilter = "pending" | "working" | "decisions" | "all" | "executive" | "handled";
type DecisionKindFilter = "all" | "feature_admission" | "production_release" | "ops" | "warning";
type BotArbitratorMode = "off" | "advisory" | "delegated_safe" | "full_delegated";

interface BotArbitratorPolicyView {
  mode: BotArbitratorMode;
  autoApproveVerifiedReleases: boolean;
  releaseMergeMode?: "merge_only" | "merge_and_deploy";
}

interface BotArbitrationLogView {
  id: string;
  targetKind: "decision" | "workflow";
  targetId: string;
  actor: string;
  verdict: string;
  executed: boolean;
  reason: string;
  nextStep?: string;
  createdAt: string;
}

interface PlannotatorStatusView {
  available: boolean;
  baseUrl: string;
  openLinksCount: number;
  lastSyncedAt?: string | null;
}

const VERDICT_LABELS: Record<string, string> = {
  approve: "批准",
  approved: "已批准",
  reject: "驳回",
  rejected: "已驳回",
  changes: "要求修改",
  snooze: "暂缓",
  snoozed: "已暂缓",
  supersede: "过期收敛",
  superseded: "已过期收敛",
  close_stale: "过期关闭",
  escalate: "上报人工",
  escalated: "已上报人工",
  advisory: "仅建议",
};

function normalizeArbitratorPolicy(raw: Record<string, unknown> | null | undefined): BotArbitratorPolicyView | null {
  if (!raw) return null;
  const modeRaw = (raw.arbitrationMode ?? raw.mode ?? "off") as string;
  const mode: BotArbitratorMode =
    modeRaw === "advisory" || modeRaw === "delegated_safe" || modeRaw === "full_delegated" ? modeRaw : "off";
  return {
    mode,
    autoApproveVerifiedReleases: Boolean(raw.autoApproveVerifiedReleases),
    releaseMergeMode: raw.releaseMergeMode === "merge_and_deploy" ? "merge_and_deploy" : "merge_only",
  };
}

function normalizeArbitrationLogs(raw: unknown): BotArbitrationLogView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .map((entry, idx) => {
      const targetKind: "decision" | "workflow" =
        entry.targetKind === "workflow" || entry.workflowId || entry.entityKind === "workflow"
          ? "workflow"
          : "decision";
      const targetId = String(
        entry.targetId ?? entry.entityId ?? entry.decisionId ?? entry.workflowId ?? entry.runId ?? "",
      );
      return {
        id: String(entry.id ?? `arb-${idx}`),
        targetKind,
        targetId,
        actor: String(entry.actor ?? "bot:super-bot"),
        verdict: String(entry.verdict ?? "advisory"),
        executed: Boolean(entry.executed),
        reason: String(entry.reason ?? ""),
        nextStep: entry.nextStep ? String(entry.nextStep) : undefined,
        createdAt: String(entry.createdAt ?? new Date().toISOString()),
      };
    })
    .filter((log) => Boolean(log.targetId));
}

function summarizeArbitrationRun(res: Record<string, unknown>, fallbackAdvisory = false): string {
  if (typeof res.skippedReason === "string" && res.skippedReason) {
    return `🤖 ${res.skippedReason}`;
  }
  const total = Number(res.totalProcessed ?? (Array.isArray(res.items) ? res.items.length : 0));
  if (total === 0) return "当前没有待 Bot 研判或拍板的审批项。";
  const approved = Number(res.approvedCount ?? 0);
  const rejected = Number(res.rejectedCount ?? 0);
  const changes = Number(res.changesRequestedCount ?? 0);
  const closedStale = Number(res.closedStaleCount ?? 0);
  const snoozed = Number(res.snoozedCount ?? 0);
  const advisory = Number(res.advisoryCount ?? 0);
  const escalated = Number(res.escalatedCount ?? 0);
  const failed = Number(res.failedCount ?? 0);
  const parts = [
    approved > 0 ? `批准 ${approved}` : "",
    rejected > 0 ? `驳回 ${rejected}` : "",
    changes > 0 ? `要求修改 ${changes}` : "",
    closedStale > 0 ? `过期收敛 ${closedStale}` : "",
    snoozed > 0 ? `暂缓 ${snoozed}` : "",
    advisory > 0 ? `研判建议 ${advisory}` : "",
    escalated > 0 ? `上报人工 ${escalated}` : "",
    failed > 0 ? `异常 ${failed}` : "",
  ].filter(Boolean);
  const prefix = fallbackAdvisory
    ? "🤖 当前为人工模式 (off)，本次按研判建议评估"
    : "🤖 Bot 已处理";
  return `${prefix} ${total} 项：${parts.join(" · ") || "均已留痕"}。`;
}

const DOMAIN_LABELS: Record<string, string> = {
  strategy: "01 · 战略部",
  product: "02 · 产品部",
  factory: "03 · 研发暗工厂",
  resources: "04 · 算力调度部",
  ops: "05 · 自愈运维部",
  commercial: "06 · 商业总账部",
};

const KIND_META: Record<string, { label: string; short: string; effect: string; tone: "info" | "warn" | "good" }> = {
  feature_admission: {
    label: "需求准入立项",
    short: "需求立项",
    effect: "批准后仅创建研发待办任务，不直接修改主分支或上线",
    tone: "info",
  },
  production_release: {
    label: "代码合入与发布",
    short: "代码发布",
    effect: "批准后合并隔离分支并执行确定性校验（失败自动回滚）",
    tone: "warn",
  },
  cli_auth_expired: {
    label: "AI CLI 登录态告警",
    short: "CLI 告警",
    effect: "确认登录恢复后重新开放调度权重，或暂缓改用备用模型",
    tone: "warn",
  },
  patrol_alert: {
    label: "任务滞留 / 失败巡检",
    short: "任务巡检",
    effect: "可重置重试、延后 7 天免打扰或归档清理",
    tone: "warn",
  },
  service_down: {
    label: "伴生服务自愈告警",
    short: "服务告警",
    effect: "重置退避窗口并尝试重新拉起本机伴生服务",
    tone: "warn",
  },
  kill_switch: {
    label: "商业止损熔断",
    short: "止损熔断",
    effect: "红线级操作：影响项目算力与发版停服状态",
    tone: "warn",
  },
  mainline_change: {
    label: "长期主线调整",
    short: "主线变更",
    effect: "红线级操作：影响全局资源配比与战略准入",
    tone: "warn",
  },
  freeze_override: {
    label: "主线冻结特批",
    short: "冻结特批",
    effect: "红线级操作：临时放行非主线或外围项目准入",
    tone: "warn",
  },
};

const RISK_LABELS: Record<string, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "红线级",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待拍板",
  approved: "已批准执行",
  rejected: "已驳回",
  snoozed: "已暂缓",
  changes_requested: "已要求修改",
  superseded: "已被替代",
};

const PRESET_BRIEFS = [
  { label: "今日一页总裁简报", text: "请统筹五位部门 Bot 做一次快速盘点，只给我 1 页总裁简报：各部门状态灯、关键变化 Top 3、以及必须我拍板的事项与推荐方案。" },
  { label: "盘点待审批项并给建议", text: "请核查当前所有待我拍板或阻塞的事项，让对应部门 Bot 给出风险评估与明确推荐选项（批准/修改/拒绝）。" },
  { label: "1号商业试点推进诊断", text: "请商业与增长部 Bot 与产研部 Bot 联合核查 1 号商业试点距离真实首单还差哪几步，列出自治项与待拍板项。" },
  { label: "集群与 AI 套餐巡检", text: "请运维部 Bot 与资源财务部 Bot 联合检查 Tailscale 机器、服务可用性及 AI 订阅套餐余量/登录态，只报异常与预警。" },
];

const DEPT_OPTIONS: Array<{ id: "" | ExecutiveDepartmentId; label: string }> = [
  { id: "", label: "Super Bot（总控 COO · 统筹调度五部）" },
  { id: "commercial", label: "经 Super Bot 转交 → 商业与增长部 Bot" },
  { id: "rd", label: "经 Super Bot 转交 → 产研与工程部 Bot" },
  { id: "operations", label: "经 Super Bot 转交 → 运维与基础设施部 Bot" },
  { id: "security", label: "经 Super Bot 转交 → 安全与合规部 Bot" },
  { id: "resources", label: "经 Super Bot 转交 → 资源与财务部 Bot" },
];

function formatTime(iso: string) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function cleanDisplayTitle(title: string): string {
  return title
    .replace(/^(?:候选需求准入评估|需求准入立项|生产发布审批)[:：]\s*/i, "")
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
}

function plainPreview(text: string, maxLen = 110): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1)}…` : stripped;
}

function packetTargetLabel(pkt: DecisionPacket): string {
  const t = pkt.targetSummary;
  if (t?.assetName) return t.repoFullName ? `${t.assetName}` : t.assetName;
  if (t?.productName) return t.productName;
  if (t?.mainlineName) return t.mainlineName;
  const m = /关联项目[:：]\s*([^\s·\n]+)/.exec(pkt.backgroundSummary);
  if (m && m[1] && m[1] !== "default") return m[1];
  return "未绑定仓库";
}

function packetFullTargetChain(pkt: DecisionPacket): string {
  const t = pkt.targetSummary;
  const parts = [t?.mainlineName, t?.productName, t?.assetName ? (t.repoFullName ? `${t.assetName} (${t.repoFullName})` : t.assetName) : null]
    .filter((v): v is string => Boolean(v));
  if (parts.length > 0) return parts.join(" → ");
  return "未绑定具体产品或代码仓库";
}

function isPacketHighRisk(pkt: DecisionPacket, policy: GovernancePolicy | null): boolean {
  const redline = pkt.targetSummary?.isRedline || Boolean(policy?.redlineKinds.includes(pkt.kind));
  return redline || pkt.riskLevel === "high" || pkt.riskLevel === "critical";
}

function matchesKindFilter(pkt: DecisionPacket, kindFilter: DecisionKindFilter): boolean {
  if (kindFilter === "all") return true;
  if (kindFilter === "warning") return Boolean(pkt.admissionWarning);
  if (kindFilter === "ops") return pkt.domain === "ops" || pkt.kind === "patrol_alert";
  return pkt.kind === kindFilter;
}

function issueHasApproval(issue: MailboxIssue) {
  return issue.decisions.length > 0 || issue.messages.some(message => message.kind === "decision" || message.requiresApproval);
}

function safeHref(value: string) {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch { /* ignore */ }
  return "";
}

function renderTokens(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>);
}

function renderToken(token: Token): ReactNode {
  const kids = () => ("tokens" in token && token.tokens ? renderTokens(token.tokens) : "text" in token ? token.text : "");
  switch (token.type) {
    case "heading": {
      const tag = (["h2", "h3", "h4", "h5", "h6"] as const)[Math.min(token.depth - 1, 4)] || "h3";
      const Tag = tag;
      return <Tag>{kids()}</Tag>;
    }
    case "paragraph": return <p>{kids()}</p>;
    case "strong": return <strong>{kids()}</strong>;
    case "em": return <em>{kids()}</em>;
    case "del": return <del>{kids()}</del>;
    case "text":
    case "escape": return kids();
    case "codespan": return <code>{token.text}</code>;
    case "code": return <pre><code>{token.text}</code></pre>;
    case "br": return <br />;
    case "hr": return <hr />;
    case "blockquote": return <blockquote>{kids()}</blockquote>;
    case "link": {
      const safe = safeHref(token.href);
      return safe ? <a href={safe} target="_blank" rel="noreferrer">{kids()}</a> : <>{kids()}</>;
    }
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item, i) => <li key={i}>{renderTokens(item.tokens)}</li>);
      return list.ordered ? <ol start={list.start || 1}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table": {
      const table = token as Tokens.Table;
      return (
        <div className="opc-table-scroll mb-markdown-table" role="region" aria-label="信件中的表格" tabIndex={0}>
          <table>
            <thead><tr>{table.header.map((c, i) => <th scope="col" key={i}>{renderTokens(c.tokens)}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderTokens(cell.tokens)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default: return null;
  }
}

function SafeMarkdown({ text }: { text: string }) {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  useEffect(() => {
    let active = true;
    import("marked")
      .then(({ marked }) => {
        if (active) setTokens(marked.lexer(text));
      })
      .catch(() => {
        if (active) setTokens(null);
      });
    return () => { active = false; };
  }, [text]);
  if (!tokens) return <div className="mb-markdown"><p style={{ whiteSpace: "pre-wrap" }}><LinkedText text={text} /></p></div>;
  return <div className="mb-markdown">{renderTokens(tokens)}</div>;
}

function MailboxWorkflowAction({ message, onChanged }: { message: ZoomMessage; onChanged: () => void }) {
  const [run, setRun] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<WorkflowDetail>(`/api/workflows/${encodeURIComponent(message.taskId)}`, { signal: controller.signal })
      .then(setRun)
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [message.taskId, attempt]);

  return <section className="mb-reply-card mb-workflow" aria-label="直接处理工作流">
    {error ? <p role="alert">{error} <button type="button" onClick={() => {
      setError("");
      setAttempt(n => n + 1);
    }}>重试读取</button></p>
      : run ? <WorkflowMessageContent
        run={run}
        message={{ ...message, pending: Boolean(message.action) }}
        onChanged={next => { setRun(next); onChanged(); }}
      /> : <p role="status">正在读取当前计划与执行记录…</p>}
  </section>;
}

export function FounderMailbox({
  nav,
  messages,
  onResolved,
  onPendingCountChange,
}: {
  nav: ReactNode;
  messages: ZoomMessage[];
  onResolved?: () => void;
  onPendingCountChange?: (count: number) => void;
}) {
  const routeParams = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const linkedDecision = routeParams.get("decision");
  const linkedMessage = routeParams.get("message");
  const linkedId = linkedDecision ? "dec:" + linkedDecision : linkedMessage ? "sys:" + linkedMessage : "";
  const [mailbox, setMailbox] = useState<ExecutiveMailboxResponse | null>(null);
  const [decisions, setDecisions] = useState<DecisionPacket[]>([]);
  const [policy, setPolicy] = useState<GovernancePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<MailFilter>(linkedDecision ? "decisions" : linkedMessage ? "all" : "pending");
  const [kindFilter, setKindFilter] = useState<DecisionKindFilter>("all");
  const [selectedId, setSelectedId] = useState<string>(linkedId);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [batchNote, setBatchNote] = useState("");
  const [pendingRedlineConfirm, setPendingRedlineConfirm] = useState<{
    action: DecisionBatchAction;
    redlineCount: number;
  } | null>(null);
  const [composing, setComposing] = useState(false);
  const [composeTarget, setComposeTarget] = useState<"" | ExecutiveDepartmentId>("");
  const [composeBody, setComposeBody] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "good" | "warn" } | null>(null);
  const [arbitratorPolicy, setArbitratorPolicy] = useState<BotArbitratorPolicyView | null>(null);
  const [arbitratorLogs, setArbitratorLogs] = useState<BotArbitrationLogView[]>([]);
  const [arbitratorBusy, setArbitratorBusy] = useState(false);
  const [botReceipt, setBotReceipt] = useState<{ text: string; tone: "good" | "warn" } | null>(null);
  const [plannotatorStatus, setPlannotatorStatus] = useState<PlannotatorStatusView | null>(null);
  const [plannotatorBusy, setPlannotatorBusy] = useState(false);
  const manualUnread = useRef<Set<string>>(new Set());
  const mailboxRequest = useRef(0);
  const packetVersions = useRef(new Map<string, string>());
  const reader = useRef<HTMLDivElement>(null);

  const loadMailbox = useCallback(async (signal?: AbortSignal) => {
    const generation = ++mailboxRequest.current;
    try {
      const [execRes, decRes] = await Promise.allSettled([
        request<ExecutiveMailboxResponse>("/api/opc/executive/mailbox", { signal }),
        request<{ packets: DecisionPacket[]; policy: GovernancePolicy }>("/api/opc/kernel/decisions", { signal }),
      ]);
      let exactPacket: DecisionPacket | undefined;
      if (linkedDecision && decRes.status === "fulfilled" && !decRes.value.packets.some(p => p.id === linkedDecision)) {
        try {
          const detail = await request<{ packet: DecisionPacket }>(
            `/api/opc/kernel/decisions/${encodeURIComponent(linkedDecision)}`, { signal },
          );
          if (detail.packet.id === linkedDecision) exactPacket = detail.packet;
        } catch { /* An unavailable exact link must not open an unrelated approval. */ }
      }
      if (!signal?.aborted && generation === mailboxRequest.current) {
        if (execRes.status === "fulfilled") setMailbox(execRes.value);
        if (decRes.status === "fulfilled") {
          const packets = exactPacket ? [...decRes.value.packets, exactPacket] : decRes.value.packets;
          setDecisions(packets);
          setPolicy(decRes.value.policy);
          const previousVersions = packetVersions.current;
          const currentVersions = new Map(packets.filter((p) => p.status === "pending" && !p.actionBlockReason)
            .map(p => [p.id, p.updatedAt]));
          packetVersions.current = currentVersions;
          setCheckedIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set([...prev].filter(id => currentVersions.has(id) &&
              previousVersions.get(id) === currentVersions.get(id)));
            return next.size === prev.size ? prev : next;
          });
        }
      }
    } catch (err) {
      if (!signal?.aborted && generation === mailboxRequest.current) {
        setNotice({ text: err instanceof Error ? err.message : "读取总裁审批网关失败", tone: "warn" });
      }
    } finally {
      if (!signal?.aborted && generation === mailboxRequest.current) setLoading(false);
    }
  }, [linkedDecision]);

  const loadArbitratorAndPlannotator = useCallback(async (signal?: AbortSignal) => {
    const [arbRes, planRes] = await Promise.allSettled([
      request<Record<string, unknown>>("/api/opc/arbitrator/status", { signal }),
      request<Record<string, unknown>>("/api/opc/plannotator/status", { signal }),
    ]);
    if (signal?.aborted) return;
    if (arbRes.status === "fulfilled") {
      const nextPolicy = normalizeArbitratorPolicy(arbRes.value.policy as Record<string, unknown> | undefined);
      if (nextPolicy) setArbitratorPolicy(nextPolicy);
      setArbitratorLogs(normalizeArbitrationLogs(arbRes.value.recentLogs ?? arbRes.value.logs));
    }
    if (planRes.status === "fulfilled") {
      const val = planRes.value;
      const health = (val.health && typeof val.health === "object" ? val.health : null) as Record<string, unknown> | null;
      const cfg = (val.config && typeof val.config === "object" ? val.config : null) as Record<string, unknown> | null;
      const countsObj = (val.counts && typeof val.counts === "object" ? val.counts : null) as Record<string, unknown> | null;
      const available = Boolean(val.available ?? health?.available ?? false);
      const baseUrl = String(health?.url ?? cfg?.baseUrl ?? val.baseUrl ?? "http://localhost:53798/");
      const links = Array.isArray(val.links) ? val.links : [];
      const openLinksCount = Number(
        countsObj?.openLinks ??
          val.openLinksCount ??
          links.filter((l) => (l as Record<string, unknown>).status === "open").length,
      );
      setPlannotatorStatus({
        available,
        baseUrl,
        openLinksCount,
        lastSyncedAt: (val.lastSyncedAt ?? cfg?.updatedAt ?? null) as string | null,
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadMailbox(controller.signal);
    void loadArbitratorAndPlannotator(controller.signal);
    return () => controller.abort();
  }, [loadMailbox, loadArbitratorAndPlannotator]);

  useEffect(() => {
    const onPolicy = (event: Event) => {
      const detail = (event as CustomEvent<GovernancePolicy>).detail;
      if (detail) setPolicy(detail);
    };
    window.addEventListener("opc:policy-updated", onPolicy);
    return () => window.removeEventListener("opc:policy-updated", onPolicy);
  }, []);

  useEffect(() => {
    const interval = mailbox?.superBotWorking ? 3500 : 10000;
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void loadMailbox();
        void loadArbitratorAndPlannotator();
      }
    }, interval);
    return () => window.clearInterval(timer);
  }, [mailbox?.superBotWorking, loadMailbox, loadArbitratorAndPlannotator]);

  const latestBotLogByTarget = useMemo(() => {
    const map = new Map<string, BotArbitrationLogView>();
    for (const log of arbitratorLogs) {
      if (!map.has(log.targetId)) map.set(log.targetId, log);
    }
    return map;
  }, [arbitratorLogs]);

  const updateArbitratorPolicy = async (patch: Partial<BotArbitratorPolicyView>) => {
    if (arbitratorBusy) return;
    setArbitratorBusy(true);
    setBotReceipt(null);
    try {
      const payload: Record<string, unknown> = {};
      if (patch.mode !== undefined) {
        payload.mode = patch.mode;
        payload.arbitrationMode = patch.mode;
      }
      if (patch.autoApproveVerifiedReleases !== undefined) {
        payload.autoApproveVerifiedReleases = patch.autoApproveVerifiedReleases;
      }
      if (patch.releaseMergeMode !== undefined) {
        payload.releaseMergeMode = patch.releaseMergeMode;
      }
      const res = await request<Record<string, unknown>>("/api/opc/arbitrator/policy", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const updated = normalizeArbitratorPolicy((res.policy as Record<string, unknown> | undefined) ?? res);
      if (updated) setArbitratorPolicy(updated);
      window.dispatchEvent(new CustomEvent("opc:arbitrator-updated"));
      setBotReceipt({ text: "Bot 代拍板策略已更新。", tone: "good" });
    } catch (err) {
      setBotReceipt({ text: err instanceof Error ? err.message : "更新 Bot 策略失败", tone: "warn" });
    } finally {
      setArbitratorBusy(false);
    }
  };

  const runBotArbitratorAll = async () => {
    if (arbitratorBusy || busy) return;
    setArbitratorBusy(true);
    setBotReceipt(null);
    const fallbackAdvisory = !arbitratorPolicy || arbitratorPolicy.mode === "off";
    try {
      const res = await request<Record<string, unknown>>("/api/opc/arbitrator/run", {
        method: "POST",
        body: JSON.stringify(fallbackAdvisory ? { mode: "advisory" } : {}),
      });
      const text = summarizeArbitrationRun(res, fallbackAdvisory);
      setBotReceipt({ text, tone: Number(res.failedCount ?? 0) > 0 ? "warn" : "good" });
      setNotice({ text, tone: Number(res.failedCount ?? 0) > 0 ? "warn" : "good" });
      await Promise.all([loadMailbox(), loadArbitratorAndPlannotator()]);
      window.dispatchEvent(new CustomEvent("opc:arbitrator-updated"));
      onResolved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "触发 Bot 代拍板失败";
      setBotReceipt({ text: msg, tone: "warn" });
      setNotice({ text: msg, tone: "warn" });
    } finally {
      setArbitratorBusy(false);
    }
  };

  const runBotArbitratorSingle = async (kind: "decision" | "workflow", id: string) => {
    if (arbitratorBusy || busy) return;
    setArbitratorBusy(true);
    setBotReceipt(null);
    setNotice(null);
    const fallbackAdvisory = !arbitratorPolicy || arbitratorPolicy.mode === "off";
    try {
      const path =
        kind === "decision"
          ? `/api/opc/arbitrator/decisions/${encodeURIComponent(id)}`
          : `/api/opc/arbitrator/workflows/${encodeURIComponent(id)}`;
      const res = await request<Record<string, unknown>>(path, {
        method: "POST",
        body: JSON.stringify(fallbackAdvisory ? { mode: "advisory" } : {}),
      });
      const record = ((res.result ?? res.log ?? res) as Record<string, unknown>) || {};
      const verdict = String(record.verdict ?? "advisory");
      const executed = Boolean(record.executed);
      const reason = String(record.reason ?? "");
      const verdictText = VERDICT_LABELS[verdict] ?? verdict;
      const summaryText = `🤖 Bot ${executed ? "已代拍板" : "研判建议"}（${verdictText}）${reason ? `：${reason}` : ""}`;
      setBotReceipt({ text: summaryText, tone: verdict === "escalate" || verdict === "escalated" ? "warn" : "good" });
      setNotice({ text: summaryText, tone: verdict === "escalate" || verdict === "escalated" ? "warn" : "good" });
      await Promise.all([loadMailbox(), loadArbitratorAndPlannotator()]);
      window.dispatchEvent(new CustomEvent("opc:arbitrator-updated"));
      onResolved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bot 单条拍板失败";
      setBotReceipt({ text: msg, tone: "warn" });
      setNotice({ text: msg, tone: "warn" });
    } finally {
      setArbitratorBusy(false);
    }
  };

  const syncPlannotatorAndReconcile = async () => {
    if (plannotatorBusy || busy) return;
    setPlannotatorBusy(true);
    setBotReceipt(null);
    try {
      const [syncRes, staleRes] = await Promise.allSettled([
        request<Record<string, unknown>>("/api/opc/plannotator/sync", { method: "POST", body: "{}" }),
        request<Record<string, unknown>>("/api/opc/plannotator/reconcile-stale", { method: "POST", body: "{}" }),
      ]);
      const synced =
        syncRes.status === "fulfilled"
          ? Number(syncRes.value.synced ?? 0) + Number(syncRes.value.resolved ?? 0) + Number(syncRes.value.superseded ?? 0)
          : 0;
      const reconciled =
        staleRes.status === "fulfilled"
          ? Number(staleRes.value.closedWorkflows ?? 0) + Number(staleRes.value.supersededDecisions ?? 0)
          : 0;
      const errParts = [
        syncRes.status === "rejected" ? `同步失败(${syncRes.reason instanceof Error ? syncRes.reason.message : "error"})` : "",
        staleRes.status === "rejected" ? `清理失败(${staleRes.reason instanceof Error ? staleRes.reason.message : "error"})` : "",
      ].filter(Boolean);
      const text = errParts.length
        ? `Plannotator 联动部分异常：${errParts.join("；")}`
        : `Plannotator 联动完成：同步回写 ${synced} 条 · 清理过期/已被覆盖项 ${reconciled} 条。`;
      setBotReceipt({ text, tone: errParts.length ? "warn" : "good" });
      setNotice({ text, tone: errParts.length ? "warn" : "good" });
      await Promise.all([loadMailbox(), loadArbitratorAndPlannotator()]);
      window.dispatchEvent(new CustomEvent("opc:plannotator-updated"));
      onResolved?.();
    } finally {
      setPlannotatorBusy(false);
    }
  };

  const unified = useMemo(() => buildMailboxIssues({
    decisions, items: mailbox?.items ?? [], messages, sourceTraces: mailbox?.sourceTraces,
  }), [decisions, mailbox?.items, mailbox?.sourceTraces, messages]);
  const batchableDecisionIds = useMemo(() => new Set(unified.flatMap(issue => issue.pendingDecisionIds)), [unified]);
  const pendingDecisionPackets = useMemo(
    () => decisions.filter(d => batchableDecisionIds.has(d.id)),
    [decisions, batchableDecisionIds],
  );

  const kindCounts = useMemo(() => ({
    all: pendingDecisionPackets.length,
    feature_admission: pendingDecisionPackets.filter((p) => p.kind === "feature_admission").length,
    production_release: pendingDecisionPackets.filter((p) => p.kind === "production_release").length,
    ops: pendingDecisionPackets.filter((p) => p.domain === "ops" || p.kind === "patrol_alert").length,
    warning: pendingDecisionPackets.filter((p) => Boolean(p.admissionWarning)).length,
  }), [pendingDecisionPackets]);

  const counts = useMemo(() => ({
    all: unified.length,
    pending: unified.filter((m) => m.pending).length,
    decisions: unified.filter(issueHasApproval).length,
    execUnread: unified.filter((m) => m.receipts.some(item => item.direction === "inbound" && !item.read)).length,
    working: unified.filter((m) => m.state === "working").length,
    handled: unified.filter((m) => m.state === "archived").length,
  }), [unified]);

  useEffect(() => {
    if (!loading && mailbox) onPendingCountChange?.(counts.pending);
  }, [loading, mailbox, counts.pending, onPendingCountChange]);

  const visible = useMemo(() => {
    let base: MailboxIssue[];
    switch (filter) {
      case "pending": base = unified.filter((m) => m.pending); break;
      case "working": base = unified.filter((m) => m.state === "working"); break;
      case "decisions": base = unified.filter(issueHasApproval); break;
      case "executive": base = unified.filter((m) => m.receipts.length > 0); break;
      case "handled": base = unified.filter((m) => m.state === "archived"); break;
      default: base = unified; break;
    }
    if ((filter === "pending" || filter === "decisions") && kindFilter !== "all") {
      return base.filter((m) => m.decisions.some(packet =>
        (filter !== "pending" || m.pendingDecisionIds.includes(packet.id)) && matchesKindFilter(packet, kindFilter)));
    }
    return base;
  }, [unified, filter, kindFilter]);

  const visiblePendingDecisions = useMemo(
    () =>
      visible.flatMap(issue => issue.decisions.filter(packet =>
        issue.pendingDecisionIds.includes(packet.id) &&
        (kindFilter === "all" || matchesKindFilter(packet, kindFilter)))),
    [visible, kindFilter],
  );

  const selectedIssue = useMemo(() => {
    if (composing) return null;
    if (selectedId) {
      const exact = visible.find((m) => m.id === selectedId || m.aliases.includes(selectedId));
      if (exact) return exact;
    }
    if (linkedId && selectedId === linkedId) return null;
    return visible[0] ?? null;
  }, [composing, selectedId, visible, linkedId]);

  const selected: MailboxRecord | null = selectedIssue
    ? selectedIssue.records.find(record => record.id === selectedId) ??
      selectedIssue.records.find(record => record.id === selectedIssue.primaryId) ?? selectedIssue
    : null;

  useEffect(() => {
    if (!linkedId) return;
    setFilter(linkedDecision ? "decisions" : "all");
    setKindFilter("all");
    setComposing(false);
    setSelectedId(linkedId);
  }, [linkedId, linkedDecision]);

  useEffect(() => {
    if (reader.current) reader.current.scrollTop = 0;
  }, [selected?.id, composing]);

  const selectMail = (id: string, preserveLink = false) => {
    setComposing(false);
    setSelectedId(id);
    setDecisionNote("");
    setReplyBody("");
    setNotice(null);
    if (linkedId && id !== linkedId && !preserveLink) location.hash = "#mailbox";
  };

  const openDecision = (id: string) => {
    if (selectedIssue?.aliases.includes("dec:" + id)) {
      selectMail("dec:" + id);
      return;
    }
    setFilter("decisions");
    setKindFilter("all");
    selectMail("dec:" + id, true);
    location.hash = "#mailbox?" + new URLSearchParams({ decision: id });
  };

  const openReceipt = (id: string) => {
    if (!selectedIssue?.aliases.includes("exec:" + id)) {
      setFilter("executive");
      setKindFilter("all");
    }
    selectMail("exec:" + id);
  };

  const openMessage = (id: string) => {
    if (selectedIssue?.aliases.includes("sys:" + id)) {
      selectMail("sys:" + id);
      return;
    }
    setFilter("all");
    setKindFilter("all");
    selectMail("sys:" + id, true);
    location.hash = "#mailbox?" + new URLSearchParams({ message: id });
  };

  const changeFilter = (next: MailFilter) => {
    setSelectedId("");
    setDecisionNote("");
    setReplyBody("");
    setNotice(null);
    setFilter(next);
    setKindFilter("all");
    if (linkedId) location.hash = "#mailbox";
  };

  const checkedPackets = useMemo(
    () => pendingDecisionPackets.filter((p) => checkedIds.has(p.id) && batchableDecisionIds.has(p.id)),
    [pendingDecisionPackets, checkedIds, batchableDecisionIds],
  );

  const checkedBreakdown = useMemo(() => {
    const redlineCount = checkedPackets.filter((p) => isPacketHighRisk(p, policy)).length;
    const warningCount = checkedPackets.filter((p) => Boolean(p.admissionWarning)).length;
    const admissionCount = checkedPackets.filter((p) => p.kind === "feature_admission").length;
    const releaseCount = checkedPackets.filter((p) => p.kind === "production_release").length;
    const hasRejectable = checkedPackets.some((p) => p.options.some((o) => o.outcome === "rejected"));
    const hasSnoozable = checkedPackets.some((p) => p.options.some((o) => o.outcome === "snoozed"));
    return { redlineCount, warningCount, admissionCount, releaseCount, hasRejectable, hasSnoozable };
  }, [checkedPackets, policy]);

  const allVisibleChecked =
    visiblePendingDecisions.length > 0 &&
    visiblePendingDecisions.every((p) => checkedIds.has(p.id));

  const toggleCheck = (packetId: string) => {
    setPendingRedlineConfirm(null);
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(packetId)) next.delete(packetId);
      else next.add(packetId);
      return next;
    });
  };

  const toggleIssueChecks = (ids: string[]) => {
    if (ids.length === 1) { toggleCheck(ids[0]); return; }
    setPendingRedlineConfirm(null);
    setCheckedIds(prev => {
      const next = new Set(prev);
      const allChecked = ids.every(id => prev.has(id));
      for (const id of ids) if (allChecked) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setPendingRedlineConfirm(null);
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleChecked) {
        for (const p of visiblePendingDecisions) next.delete(p.id);
      } else {
        for (const p of visiblePendingDecisions) next.add(p.id);
      }
      return next;
    });
  };

  const selectOnlyWarnings = () => {
    setPendingRedlineConfirm(null);
    const ids = pendingDecisionPackets.filter((p) => Boolean(p.admissionWarning) && batchableDecisionIds.has(p.id)).map((p) => p.id);
    setFilter("pending");
    setKindFilter("warning");
    setCheckedIds(new Set(ids));
  };

  const selectOnlySafe = () => {
    setPendingRedlineConfirm(null);
    const ids = visiblePendingDecisions
      .filter((p) => !isPacketHighRisk(p, policy) && !p.admissionWarning)
      .map((p) => p.id);
    setCheckedIds(new Set(ids));
  };

  const clearSelection = () => {
    setPendingRedlineConfirm(null);
    setCheckedIds(new Set());
  };

  const setMailRead = useCallback(async (mailId: string, read: boolean, manual = false) => {
    if (manual) {
      if (!read) manualUnread.current.add(mailId);
      else manualUnread.current.delete(mailId);
    }
    setMailbox((prev) =>
      prev
        ? { ...prev, items: prev.items.map((it) => (it.id === mailId ? { ...it, read } : it)) }
        : prev,
    );
    try {
      await request(`/api/opc/executive/mailbox/${encodeURIComponent(mailId)}/read`, {
        method: "PUT",
        body: JSON.stringify({ read }),
      });
    } catch { /* ignore transient */ }
  }, []);

  const selKind = selected?.kind ?? null;
  const selDecisionId = selected?.kind === "decision" ? selected.item.id : null;
  const selDecisionViewed = selected?.kind === "decision" ? Boolean(selected.item.viewedAt) : true;
  const selExecId = selected?.kind === "executive" ? selected.item.id : null;
  const selExecNeedsDecision = selected?.kind === "executive" ? selected.item.needsDecision : false;
  const selExecDirection = selected?.kind === "executive" ? selected.item.direction : "";
  const selExecRead = selected?.kind === "executive" ? selected.item.read : true;

  useEffect(() => {
    if (selKind === "decision" && selDecisionId && !selDecisionViewed) {
      void request(`/api/opc/kernel/decisions/${encodeURIComponent(selDecisionId)}/view`, {
        method: "POST",
      }).then(() => void loadMailbox()).catch(() => {});
      return;
    }
    if (selKind === "executive" && selExecId) {
      if (selExecNeedsDecision || selExecDirection !== "inbound" || selExecRead || manualUnread.current.has(selExecId)) return;
      const timer = window.setTimeout(() => {
        if (!document.hidden && !manualUnread.current.has(selExecId)) {
          void setMailRead(selExecId, true, false);
        }
      }, 1200);
      return () => window.clearTimeout(timer);
    }
  }, [selKind, selDecisionId, selDecisionViewed, selExecId, selExecNeedsDecision, selExecDirection, selExecRead, setMailRead, loadMailbox]);

  const resolveDecisionPacket = async (packet: DecisionPacket, optionId: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await request<{ packet: DecisionPacket }>(
        `/api/opc/kernel/decisions/${encodeURIComponent(packet.id)}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({ optionId, note: decisionNote.trim(), expectedUpdatedAt: packet.updatedAt }),
        },
      );
      setDecisionNote("");
      setCheckedIds((prev) => {
        if (!prev.has(packet.id)) return prev;
        const next = new Set(prev);
        next.delete(packet.id);
        return next;
      });
      setNotice({
        text: `已记录拍板决定（${STATUS_LABELS[res.packet.status] ?? res.packet.status}）。可在原审批单查看实际动作回执。`,
        tone: "good",
      });
      await loadMailbox();
      onResolved?.();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "执行审批动作失败", tone: "warn" });
      await loadMailbox();
    } finally {
      setBusy(false);
    }
  };

  const executeBatchResolve = async (action: DecisionBatchAction, allowRedline = false) => {
    if (busy || checkedPackets.length === 0) return;

    // Two-step confirmation for redline/high-risk batch approvals
    if (!allowRedline && (action === "approve" || action === "recommended")) {
      const redlinesToApprove = checkedPackets.filter((pkt) => {
        if (!isPacketHighRisk(pkt, policy)) return false;
        const rec = pkt.options.find((o) => o.id === pkt.recommendedOptionId) ?? pkt.options[0];
        if (action === "recommended") return rec?.outcome === "approved";
        return pkt.options.some((o) => o.outcome === "approved");
      });
      if (redlinesToApprove.length > 0) {
        setPendingRedlineConfirm({ action, redlineCount: redlinesToApprove.length });
        return;
      }
    }

    setBusy(true);
    setPendingRedlineConfirm(null);
    setNotice(null);
    try {
      const res = await request<BatchResolveDecisionResult>("/api/opc/kernel/decisions/batch-resolve", {
        method: "POST",
        body: JSON.stringify({
          ids: checkedPackets.map((p) => p.id),
          expectedUpdatedAtById: Object.fromEntries(checkedPackets.map(p => [p.id, p.updatedAt])),
          action,
          note: batchNote.trim(),
          allowRedline,
        }),
      });
      const actionLabel =
        action === "reject"
          ? "批量驳回"
          : action === "approve"
            ? "批量批准"
            : action === "snooze"
              ? "批量暂缓"
              : "按推荐批量处理";
      const skippedReasons = res.results
        .filter((r) => r.status !== "resolved" && r.reason)
        .slice(0, 2)
        .map((r) => `${cleanDisplayTitle(r.title).slice(0, 20)}：${r.reason}`)
        .join("；");
      setNotice({
        text: `${actionLabel}完成：成功 ${res.resolvedCount} 项${res.skippedCount ? `，跳过 ${res.skippedCount} 项` : ""}${res.failedCount ? `，失败 ${res.failedCount} 项` : ""}${skippedReasons ? `（${skippedReasons}）` : ""}。`,
        tone: res.failedCount > 0 ? "warn" : "good",
      });
      setBatchNote("");
      setCheckedIds(new Set());
      if (kindFilter === "warning" && res.resolvedCount > 0) {
        setKindFilter("all");
      }
      await loadMailbox();
      onResolved?.();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "批量审批执行失败", tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  const replySystemZoomItem = async (msg: ZoomMessage, choice?: string) => {
    const body = decisionNote.trim() || choice;
    if (busy || !body) return;
    setBusy(true);
    setNotice(null);
    try {
      if (msg.action?.kind === "channel-reply") {
        await api.post(msg.action.roomId, { body, kind: "chat", replyTo: msg.action.messageId, taskId: msg.action.taskId });
      } else {
        await api.zoomReply(msg.taskId, { questionId: msg.id, body, ...(choice ? { choice } : {}) });
      }
      setDecisionNote("");
      setNotice({ text: "已完成答复并写回对应任务。", tone: "good" });
      await loadMailbox();
      onResolved?.();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "提交答复失败", tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  const closeFailureNotice = async (message: ZoomMessage) => {
    if (busy || !message.delegation || !message.failureNotice || message.failureNotice.handledAt) return;
    setBusy(true);
    setNotice(null);
    try {
      await request(`/api/opc/delegations/${encodeURIComponent(message.delegation.id)}/failure-notice/handle`, {
        method: "POST",
        body: "{}",
      });
      onResolved?.();
        setNotice({ text: "异常通知已关闭，可在「已归档」查看。", tone: "good" });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "关闭异常通知失败", tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  const sendNewMail = async (text: string, targetDept: "" | ExecutiveDepartmentId = composeTarget) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (targetDept) {
        await request("/api/opc/executive/mailbox/reply", {
          method: "POST",
          body: JSON.stringify({ text: trimmed, departmentId: targetDept }),
        });
      } else {
        await request("/api/opc/executive/brief", {
          method: "POST",
          body: JSON.stringify({ focus: trimmed, mode: "room" }),
        });
      }
      setComposeBody("");
      setComposing(false);
      setFilter("executive");
      setNotice({
        text: "指令已送达 Super Bot，回执会自动出现在本信箱中。",
        tone: "good",
      });
      await loadMailbox();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "发送失败", tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  const onComposeSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendNewMail(composeBody, composeTarget);
  };

  const sendReply = async () => {
    if (!selected || selected.kind !== "executive" || busy || mailbox?.agentHomeReachable === false) return;
    const draft = replyBody.trim();
    const sourceTag = selected.item.source === "department_task" && selected.item.taskId
      ? `关于 Agent Home 工单 ${selected.item.taskId}（${receiptTitle(selected.item)}）：\n` : "";
    const body = draft && (sourceTag && !draft.startsWith(sourceTag) ? sourceTag + draft : draft);
    if (!body) return;
    setBusy(true);
    setNotice(null);
    try {
      await request("/api/opc/executive/mailbox/reply", {
        method: "POST",
        body: JSON.stringify({
          text: body,
          ...(selected.item.direction === "inbound" && selected.item.messageId
            ? { replyToMessageId: selected.item.messageId } : {}),
        }),
      });
      if (selected.item.needsDecision) {
        await setMailRead(selected.item.id, true, true);
      }
      setReplyBody("");
      setNotice({ text: "批示/回复已发回 Super Bot，后续进展会自动送达本信箱。", tone: "good" });
      await loadMailbox();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "回复失败", tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  const onReplyKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void sendReply();
    }
  };

  const nativeOrigin = mailbox?.agentHomeOrigin || "http://127.0.0.1:23000";

  return (
    <section className="zo-product mb-page" aria-label="总裁信箱与审批网关">
      <header className="zo-product-head mb-head">
        {nav}
        <h1>总裁审批网关与信箱</h1>
        <div className="mb-head-actions">
          {policy && (
            <a className="mb-link-btn" href="#strategy-hub?tab=habits" title="切换自治档位、免打扰策略与偏好记忆">
              {policy.autonomyMode === "assisted"
                ? "人工协助模式 · 全人工审批"
                : policy.autonomyMode === "semi_auto"
                  ? "半自动协同 · 审批由人把关"
                  : policy.autoApproveLowRisk
                    ? `全自治 · 低风险 <=$${policy.autoApproveMaxCostUsd} 自动免审`
                    : "全人工审批模式"}{" "}
              ↗
            </a>
          )}
          <button
            type="button"
            className="mb-primary"
            disabled={busy || mailbox?.agentHomeReachable === false}
            onClick={() => { setComposing(true); setNotice(null); }}
          >
            + 写信给 Super Bot
          </button>
          <button
            type="button"
            disabled={busy || mailbox?.agentHomeReachable === false}
            onClick={() => void sendNewMail(PRESET_BRIEFS[0].text, "")}
          >
            要今日总裁简报
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void loadMailbox();
              void loadArbitratorAndPlannotator();
            }}
          >
            刷新
          </button>
        </div>
      </header>

      <div className="mb-shell">
        <aside className="mb-stream" aria-label="信件与审批列表">
          <div className="mb-stream-tools">
            <section className="mb-bot-panel" aria-label="Bot 代拍板与 Plannotator 联动" data-testid="bot-arbitrator-panel">
              <div className="mb-bot-head">
                <span className="mb-bot-title">🤖 Bot 代拍板与 Plannotator 联动</span>
                <a
                  className="mb-plannotator-pill"
                  data-online={plannotatorStatus?.available ? "true" : "false"}
                  href={plannotatorStatus?.baseUrl || "http://localhost:53798/"}
                  target="_blank"
                  rel="noreferrer"
                  title={
                    plannotatorStatus?.available
                      ? `Plannotator Inbox 已连接（关联线索 ${plannotatorStatus.openLinksCount} 条），点击打开`
                      : "Plannotator Inbox 暂未连接，请确认本机 :53798 服务在线"
                  }
                >
                  <span className="mb-plannotator-dot" aria-hidden="true" />
                  {plannotatorStatus?.available ? "Plannotator :53798 已连接" : "Plannotator 未连接"}
                </a>
              </div>
              <div className="mb-bot-mode-row">
                <select
                  className="mb-bot-mode-select"
                  aria-label="Bot 代拍板策略模式"
                  value={arbitratorPolicy?.mode ?? "off"}
                  disabled={arbitratorBusy || busy}
                  onChange={(e) => void updateArbitratorPolicy({ mode: e.target.value as BotArbitratorMode })}
                >
                  <option value="off">人工拍板 (off)</option>
                  <option value="advisory">Bot 研判建议 (advisory)</option>
                  <option value="delegated_safe">Bot 安全自动拍板 (delegated_safe)</option>
                  <option value="full_delegated">全权托管 (full_delegated)</option>
                </select>
                <label className="mb-bot-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(arbitratorPolicy?.autoApproveVerifiedReleases)}
                    disabled={arbitratorBusy || busy}
                    onChange={(e) =>
                      void updateArbitratorPolicy({
                        autoApproveVerifiedReleases: e.target.checked,
                        releaseMergeMode: "merge_only",
                      })
                    }
                  />
                  <span>自动放行校验全绿的代码发布 (merge_only)</span>
                </label>
              </div>
              <div className="mb-bot-actions">
                <button
                  type="button"
                  className="mb-bot-run-btn"
                  disabled={arbitratorBusy || busy}
                  onClick={() => void runBotArbitratorAll()}
                >
                  {arbitratorBusy ? "Bot 研判执行中…" : "🤖 让 Bot 拍板并安排当前待审"}
                </button>
                <button
                  type="button"
                  className="mb-bot-sync-btn"
                  disabled={plannotatorBusy || busy}
                  onClick={() => void syncPlannotatorAndReconcile()}
                >
                  {plannotatorBusy ? "同步中…" : "同步 Plannotator / 清理过期"}
                </button>
              </div>
              {botReceipt && (
                <div className="mb-bot-receipt" data-tone={botReceipt.tone} role="status">
                  <div className="mb-bot-receipt-head">
                    <span>{botReceipt.text}</span>
                    <button
                      type="button"
                      className="mb-bot-receipt-close"
                      aria-label="关闭 Bot 回执"
                      onClick={() => setBotReceipt(null)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </section>

            <div className="mb-tabs" role="tablist" aria-label="信箱筛选">
              <button type="button" aria-pressed={filter === "pending"} onClick={() => changeFilter("pending")}>
                待我拍板 ({counts.pending})
              </button>
              <button type="button" aria-pressed={filter === "working"} onClick={() => changeFilter("working")}>
                处理中 ({counts.working})
              </button>
              <button type="button" aria-pressed={filter === "handled"} onClick={() => changeFilter("handled")}>
                已归档 ({counts.handled})
              </button>
              <button type="button" aria-pressed={filter === "decisions"} onClick={() => changeFilter("decisions")}>
                含审批 ({counts.decisions})
              </button>
              <button type="button" aria-pressed={filter === "all"} onClick={() => changeFilter("all")}>
                全部事项 ({counts.all})
              </button>
              <button type="button" aria-pressed={filter === "executive"} onClick={() => changeFilter("executive")}>
                Super Bot{counts.execUnread > 0 ? ` · ${counts.execUnread}` : ""}
              </button>
            </div>

            {(filter === "pending" || filter === "decisions") && pendingDecisionPackets.length > 0 && (
              <div className="mb-subfilters" role="group" aria-label="按审批类型筛选">
                <button type="button" aria-pressed={kindFilter === "all"} onClick={() => setKindFilter("all")}>
                  全部类型 ({kindCounts.all})
                </button>
                {kindCounts.production_release > 0 && (
                  <button
                    type="button"
                    aria-pressed={kindFilter === "production_release"}
                    onClick={() => setKindFilter("production_release")}
                  >
                    代码发布 ({kindCounts.production_release})
                  </button>
                )}
                {kindCounts.feature_admission > 0 && (
                  <button
                    type="button"
                    aria-pressed={kindFilter === "feature_admission"}
                    onClick={() => setKindFilter("feature_admission")}
                  >
                    需求立项 ({kindCounts.feature_admission})
                  </button>
                )}
                {kindCounts.ops > 0 && (
                  <button type="button" aria-pressed={kindFilter === "ops"} onClick={() => setKindFilter("ops")}>
                    运维告警 ({kindCounts.ops})
                  </button>
                )}
                {kindCounts.warning > 0 && (
                  <button
                    type="button"
                    className="mb-subfilter-warn"
                    aria-pressed={kindFilter === "warning"}
                    onClick={() => setKindFilter("warning")}
                  >
                    准入预警 ({kindCounts.warning})
                  </button>
                )}
              </div>
            )}

            {visiblePendingDecisions.length > 0 && (
              <div className="mb-batch-select-bar" aria-label="批量勾选工具">
                <label className="mb-select-all">
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    disabled={busy}
                    onChange={toggleAllVisible}
                  />
                  <span>全选当前待审 ({visiblePendingDecisions.length})</span>
                </label>
                <div className="mb-select-shortcuts">
                  {kindCounts.warning > 0 && (
                    <button type="button" disabled={busy} onClick={selectOnlyWarnings}>
                      选全部预警 ({kindCounts.warning})
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={selectOnlySafe}>
                    选低中风险
                  </button>
                  {checkedPackets.length > 0 && (
                    <button type="button" disabled={busy} onClick={clearSelection}>
                      清空 ({checkedPackets.length})
                    </button>
                  )}
                </div>
              </div>
            )}

            {mailbox?.superBotWorking && (
              <div className="mb-working-bar" role="status">
                Super Bot / 部门正在整理回执，完成后将自动出现在下方…
              </div>
            )}
            {mailbox?.agentHomeReachable === false && <div className="mb-working-bar" role="status">
              Agent Home 暂不可用，本地审批及已保存的关联回执仍可查看。
            </div>}
          </div>

          {loading && !mailbox && decisions.length === 0 ? (
            <p className="mb-empty" role="status">正在读取总裁审批网关…</p>
          ) : visible.length === 0 ? (
            <div className="mb-empty">
              {filter === "pending" ? (
                <>
                  <p style={{ marginTop: 0 }}>
                    当前没有需要你拍板的事项。执行中和已归档的事项可在对应列表查看。
                  </p>
                  <button type="button" onClick={() => { setFilter("handled"); setKindFilter("all"); }}>
                    查看已归档事项 ({counts.handled})
                  </button>
                </>
              ) : (
                "暂无符合筛选条件的信件或审批单。"
              )}
            </div>
          ) : (
            <ul className="mb-list">
              {visible.map((entry) => {
                const isSelected = !composing && selectedIssue?.id === entry.id;
                const taskTitle = issueTaskTitle(entry, mailbox?.sourceTraces);
                const historyTag = entry.records.length > 1 && <span className="mb-tag">{entry.records.length} 条记录</span>;
                const stateTag = <span className="mb-tag" data-tone={entry.pending ? "warn" : entry.state === "working" ? "info" : "good"}>
                  {entry.pending ? "待我拍板" : entry.state === "working" ? "处理中" : "已归档"}</span>;
                if (entry.kind === "decision") {
                  const pkt = entry.item;
                  const meta = KIND_META[pkt.kind];
                  const checkable = entry.pendingDecisionIds.filter(id => visiblePendingDecisions.some(packet => packet.id === id));
                  const batchable = checkable.length > 0;
                  const isChecked = batchable && checkable.every(id => checkedIds.has(id));
                  const affected = entry.receipts.find(item => item.trace?.decisionId === pkt.id)?.trace?.affectedTasks ?? [];
                  const targetLabel = affected.length ? [...new Set(affected.map(task => task.project))].join("、") : packetTargetLabel(pkt);
                  const highRisk = isPacketHighRisk(pkt, policy);
                  return (
                    <li key={entry.id} className="mb-list-row" data-checked={isChecked ? "true" : "false"}>
                      {batchable && (
                        <label
                          className="mb-row-check"
                          aria-label={`勾选审批项：${cleanDisplayTitle(pkt.title)}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={busy || !batchable}
                            onChange={() => toggleIssueChecks(checkable)}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className="mb-item"
                        data-unread={entry.pending ? "true" : "false"}
                        data-has-check={batchable ? "true" : "false"}
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => selectMail(entry.id)}
                      >
                        <div className="mb-item-meta">
                          {entry.pending && <span className="mb-unread-dot" aria-label="待审批" />}
                          <span className="mb-kind-pill" data-tone={meta?.tone ?? "info"}>
                            {meta?.short ?? pkt.kind}
                          </span>
                          <span className="mb-item-target" title={packetFullTargetChain(pkt)}>
                            {targetLabel}
                          </span>
                          <span className="mb-item-time">{formatTime(entry.at)}</span>
                        </div>
                        <div className="mb-item-subject">{taskTitle || cleanDisplayTitle(pkt.title)}</div>
                        <div className="mb-item-excerpt">{plainPreview(pkt.backgroundSummary)}</div>
                        <div className="mb-item-tags">
                          <span className="mb-tag" data-tone={highRisk ? "warn" : "info"}>
                            {RISK_LABELS[pkt.riskLevel] ?? pkt.riskLevel}
                            {pkt.targetSummary?.isRedline ? " · 红线" : ""}
                          </span>
                          {pkt.admissionWarning && (
                            <span className="mb-tag" data-tone="warn">准入预警</span>
                          )}
                          {pkt.status === "pending" ? (
                            !batchableDecisionIds.has(pkt.id) && <span className="mb-tag">历史审批范围待核对</span>
                          ) : pkt.decidedBy?.startsWith("bot:") ? (
                            <span
                              className="mb-tag mb-tag-bot"
                              title={pkt.decisionNote || `由 ${pkt.decidedBy} 代理拍板`}
                            >
                              🤖 Bot 已拍板{pkt.decisionNote ? ` · ${plainPreview(pkt.decisionNote, 20)}` : ""}
                            </span>
                          ) : pkt.autoApproved ? (
                            <span className="mb-tag" data-tone="good">免审放行</span>
                          ) : (
                            <span className="mb-tag" data-tone={pkt.status === "approved" ? "good" : undefined}>
                              {STATUS_LABELS[pkt.status] ?? pkt.status}
                            </span>
                          )}
                          {(() => {
                            const botLog = latestBotLogByTarget.get(pkt.id);
                            if (!botLog || pkt.decidedBy?.startsWith("bot:")) return null;
                            const isEscalated = botLog.verdict === "escalate" || botLog.verdict === "escalated";
                            return (
                              <span
                                className={`mb-tag ${isEscalated ? "mb-tag-bot-escalate" : "mb-tag-bot"}`}
                                title={botLog.reason}
                              >
                                {botLog.executed
                                  ? `🤖 Bot 已拍板 · ${plainPreview(botLog.reason, 18)}`
                                  : isEscalated
                                    ? "🤖 Bot 上报人工"
                                    : `🤖 Bot 建议: ${VERDICT_LABELS[botLog.verdict] ?? botLog.verdict}`}
                              </span>
                            );
                          })()}
                          {stateTag}{historyTag}
                        </div>
                      </button>
                    </li>
                  );
                }
                if (entry.kind === "executive") {
                  const it = entry.item;
                  return (
                    <li key={entry.id} className="mb-list-row">
                      <button
                        type="button"
                        className="mb-item"
                        data-unread={entry.unread ? "true" : "false"}
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => selectMail(entry.id)}
                      >
                        <div className="mb-item-meta">
                          {entry.unread && <span className="mb-unread-dot" aria-label="未读" />}
                          <span className="mb-item-sender">{it.senderName}</span>
                          <span className="mb-item-time">{formatTime(entry.at)}</span>
                        </div>
                        <div className="mb-item-subject">{taskTitle || receiptTitle(it)}</div>
                        <div className="mb-item-excerpt">{receiptPreview(it)}</div>
                        <div className="mb-item-tags">
                          <span className="mb-tag">{it.senderRole}</span>
                          {stateTag}{historyTag}
                          {it.historical && <span className="mb-tag">本地历史</span>}
                          {it.trace?.decision?.status && it.trace.decision.status !== "pending" &&
                            <span className="mb-tag" data-tone="info">原事项{STATUS_LABELS[it.trace.decision.status] ?? it.trace.decision.status}</span>}
                          {it.status === "working" && <span className="mb-tag" data-tone="info">执行中</span>}
                          {it.status === "failed" && <span className="mb-tag" data-tone="warn">异常</span>}
                          {it.status === "cancelled" && <span className="mb-tag" data-tone="warn">回执已取消</span>}
                        </div>
                      </button>
                    </li>
                  );
                }
                const msg = entry.item;
                const info = messageText(msg);
                return (
                  <li key={entry.id} className="mb-list-row">
                    <button
                      type="button"
                      className="mb-item"
                      data-unread={entry.unread ? "true" : "false"}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => selectMail(entry.id)}
                    >
                      <div className="mb-item-meta">
                        {entry.unread && <span className="mb-unread-dot" aria-label="待处理" />}
                        <span className="mb-item-sender">{msg.source}</span>
                        <span className="mb-item-time">{formatTime(entry.at)}</span>
                      </div>
                      <div className="mb-item-subject">{taskTitle || info.title}</div>
                      {info.body && info.body !== info.title && (
                        <div className="mb-item-excerpt">{info.body}</div>
                      )}
                      <div className="mb-item-tags">
                        {msg.folder && <span className="mb-tag">{msg.folder}</span>}
                        {msg.failureNotice
                          ? <span className="mb-tag" data-tone={entry.pending ? "warn" : "info"}>
                            {msg.failureNotice.handledAt ? "异常已关闭" : "执行异常"}
                          </span>
                          : null}
                        {stateTag}{historyTag}
                        {msg.origin === "workflow" && (() => {
                          const botLog = latestBotLogByTarget.get(msg.taskId);
                          if (!botLog) return null;
                          const isEscalated = botLog.verdict === "escalate" || botLog.verdict === "escalated";
                          return (
                            <span
                              className={`mb-tag ${isEscalated ? "mb-tag-bot-escalate" : "mb-tag-bot"}`}
                              title={botLog.reason}
                            >
                              {botLog.executed
                                ? `🤖 Bot 已拍板 · ${plainPreview(botLog.reason, 18)}`
                                : isEscalated
                                  ? "🤖 Bot 上报人工"
                                  : `🤖 Bot 建议: ${VERDICT_LABELS[botLog.verdict] ?? botLog.verdict}`}
                            </span>
                          );
                        })()}
                        {!entry.pending && (msg.delegation?.status === "queued" || msg.delegation?.status === "working") &&
                          <span className="mb-tag" data-tone="info">已交办</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="mb-reader" ref={reader}>
          <div className="mb-reader-inner" data-has-batch-dock={checkedPackets.length > 0 ? "true" : "false"}>
            {notice && (
              <div className="mb-notice" role={notice.tone === "warn" ? "alert" : "status"} data-tone={notice.tone}>
                <span>{notice.text}</span>
              </div>
            )}

            {!composing && selectedIssue && selected && <MailboxIssueHistory key={selectedIssue.id}
              issue={selectedIssue} selectedId={selected.id} sourceTraces={mailbox?.sourceTraces} onSelect={selectMail} />}

            {composing ? (
              <form className="mb-compose-card" onSubmit={onComposeSubmit}>
                <h2>写信给 Super Bot</h2>
                <label>
                  收件对象
                  <select
                    value={composeTarget}
                    disabled={busy}
                    onChange={(e) => setComposeTarget(e.target.value as "" | ExecutiveDepartmentId)}
                  >
                    {DEPT_OPTIONS.map((opt) => <option key={opt.id || "super"} value={opt.id}>{opt.label}</option>)}
                  </select>
                </label>
                <div className="mb-presets" aria-label="快捷总裁模板">
                  {PRESET_BRIEFS.map((p) => (
                    <button key={p.label} type="button" disabled={busy} onClick={() => setComposeBody(p.text)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <label>
                  指令内容
                  <textarea
                    rows={5}
                    required
                    value={composeBody}
                    disabled={busy}
                    onChange={(e) => setComposeBody(e.target.value)}
                    placeholder="写下你的目标、想查证的问题或审批要求…"
                  />
                </label>
                <div className="mb-form-foot">
                  <small>发送后 Super Bot 会按归属自动调度部门 Bot 并回传结构化简报</small>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" disabled={busy} onClick={() => setComposing(false)}>取消</button>
                    <button type="submit" className="mb-primary" disabled={busy || !composeBody.trim()}>
                      {busy ? "发送中…" : "发送给 Super Bot"}
                    </button>
                  </div>
                </div>
              </form>
            ) : selected?.kind === "decision" ? (() => {
              const pkt = selected.item;
              const meta = KIND_META[pkt.kind];
              const recOpt = pkt.options.find((o) => o.id === pkt.recommendedOptionId) ?? pkt.options[0];
              const isResolved = pkt.status !== "pending";
              const highRisk = isPacketHighRisk(pkt, policy);
              const linkedReceipts = (selectedIssue?.receipts ?? []).filter(item => item.trace?.decisionId === pkt.id)
                .sort((a, b) => Number(b.source === "department_task") - Number(a.source === "department_task") || b.createdAt.localeCompare(a.createdAt));
              const receipt = linkedReceipts[0];
              const originTrace = selectedIssue?.messages.map(message => mailbox?.sourceTraces?.[message.id])
                .find(trace => trace?.decisionId === pkt.id);
              return (
                <>
                  <header className="mb-letterhead">
                    <div className="mb-letterhead-top">
                      <span className="mb-letterhead-pills">
                        <span className="mb-kind-pill" data-tone={meta?.tone ?? "info"}>
                          {meta?.label ?? pkt.kind}
                        </span>
                        <span>{DOMAIN_LABELS[pkt.domain] ?? pkt.domain}</span>
                        <span className="mb-tag" data-tone={highRisk ? "warn" : "info"}>
                          {RISK_LABELS[pkt.riskLevel] ?? pkt.riskLevel}
                          {pkt.targetSummary?.isRedline ? " · 红线必审" : ""}
                        </span>
                      </span>
                      <time>{formatTime(pkt.updatedAt)}</time>
                    </div>
                    <h2>{cleanDisplayTitle(pkt.title)}</h2>
                  </header>

                  {(() => {
                    const botLog = latestBotLogByTarget.get(pkt.id);
                    const decidedByBot = pkt.decidedBy?.startsWith("bot:");
                    if (!botLog && !decidedByBot) return null;
                    const isEscalated = botLog ? (botLog.verdict === "escalate" || botLog.verdict === "escalated") : false;
                    const tone = isEscalated ? "warn" : botLog?.executed || decidedByBot ? "good" : "info";
                    return (
                      <section className="mb-bot-verdict-banner" data-tone={tone} aria-label="Bot 拍板与研判记录">
                        <div className="mb-bot-verdict-head">
                          <strong>
                            🤖 {botLog?.executed || decidedByBot ? "Bot 已代拍板" : isEscalated ? "Bot 已上报创始人裁决" : "Bot 研判建议"}
                            {botLog ? ` · ${VERDICT_LABELS[botLog.verdict] ?? botLog.verdict}` : ""}
                          </strong>
                          <small>
                            {botLog?.actor ?? pkt.decidedBy}
                            {(botLog?.createdAt || pkt.decidedAt) ? ` · ${formatTime(botLog?.createdAt ?? pkt.decidedAt ?? "")}` : ""}
                          </small>
                        </div>
                        {(botLog?.reason || pkt.decisionNote) && <div>{botLog?.reason || pkt.decisionNote}</div>}
                        {botLog?.nextStep && <div>下一步安排：{botLog.nextStep}</div>}
                      </section>
                    );
                  })()}

                  {pkt.status === "pending" && !pkt.actionBlockReason && (
                    <div className="mb-bot-quick-bar">
                      <span>不想逐行人工核对？可交给产研/总控 Bot 按安全门禁研判或直接代拍板。</span>
                      <button
                        type="button"
                        className="mb-bot-quick-btn"
                        disabled={arbitratorBusy || busy}
                        onClick={() => void runBotArbitratorSingle("decision", pkt.id)}
                      >
                        {arbitratorBusy ? "Bot 处理中…" : "🤖 交给 Bot 拍板"}
                      </button>
                    </div>
                  )}

                  {receipt ? <>
                    <ReceiptOverview item={receipt} packet={pkt} />
                    <ApprovalCommands key={pkt.id + pkt.updatedAt + receipt.id} packet={pkt} trace={receipt.trace}
                      note={decisionNote} setNote={setDecisionNote} busy={busy} onResolve={resolveDecisionPacket} />
                    <details className="mb-evidence-box">
                      <summary>查看原审批单依据</summary>
                      <SafeMarkdown text={pkt.backgroundSummary} />
                      {pkt.diffOrEvidence && <pre>{pkt.diffOrEvidence}</pre>}
                      {pkt.rollbackPlan && <p>{pkt.rollbackPlan}</p>}
                    </details>
                    <section className="mb-brief-section">
                      <h3 className="mb-section-title">关联部门回执</h3>
                      <ul className="mb-receipt-links">{linkedReceipts.map(mail =>
                        <li key={mail.id}>
                          <button type="button" onClick={() => openReceipt(mail.id)}>{mail.senderName} · {formatTime(mail.createdAt)} · 查看完整回执 ↗</button>
                        </li>)}</ul>
                    </section>
                  </> : <>
                  {/* 4-Step Approval Workflow Stepper */}
                  <ol className="mb-flow-stepper" aria-label="审批流转阶段">
                    <li data-state={pkt.admissionWarning ? "warn" : "done"}>
                      <span className="mb-step-num">1</span>
                      <div>
                        <strong>准入门禁</strong>
                        <small>{pkt.admissionWarning ? "命中准入预警" : "已对齐战略资产"}</small>
                      </div>
                    </li>
                    <li data-state={isResolved ? "done" : "active"}>
                      <span className="mb-step-num">2</span>
                      <div>
                        <strong>总裁拍板</strong>
                        <small>{isResolved ? (STATUS_LABELS[pkt.status] ?? pkt.status) : "等待你的决定"}</small>
                      </div>
                    </li>
                    <li data-state={isResolved && pkt.status === "approved" ? "done" : "idle"}>
                      <span className="mb-step-num">3</span>
                      <div>
                        <strong>确定性执行</strong>
                        <small>{meta?.short === "需求立项" ? "仅建任务不改代码" : meta?.short === "代码发布" ? "合并分支并跑测" : "自动触发回调"}</small>
                      </div>
                    </li>
                    <li data-state={isResolved ? "done" : "idle"}>
                      <span className="mb-step-num">4</span>
                      <div>
                        <strong>留痕与回滚</strong>
                        <small>沉淀偏好 · 支持回滚</small>
                      </div>
                    </li>
                  </ol>

                  {pkt.admissionWarning && (
                    <div className="mb-admission-alert" role="alert">
                      <div className="mb-admission-alert-copy">
                        <strong>⚠️ {pkt.admissionWarning}</strong>
                        <p>
                          该条目属于历史采集噪音或缺少明确开发目标，新版准入门禁已阻止同类条目再次入箱。建议直接驳回，或点击右侧按钮一次性勾选全部预警项批量清理。
                        </p>
                      </div>
                      {kindCounts.warning > 1 && pkt.status === "pending" && (
                        <button type="button" disabled={busy} onClick={selectOnlyWarnings}>
                          勾选全部 {kindCounts.warning} 条预警项
                        </button>
                      )}
                    </div>
                  )}

                  {/* Executive 4-Cell Summary Grid ("3秒看懂") */}
                  <div className="mb-fact-grid" aria-label="审批摘要总览">
                    <div className="mb-fact-cell">
                      <span className="mb-fact-label">要改动哪个产品 / 仓库</span>
                      <strong className="mb-fact-value">{packetFullTargetChain(pkt)}</strong>
                    </div>
                    <div className="mb-fact-cell">
                      <span className="mb-fact-label">批准后会发生什么</span>
                      <strong className="mb-fact-value">{meta?.effect ?? "触发对应部门后端执行回调"}</strong>
                    </div>
                    <div className="mb-fact-cell">
                      <span className="mb-fact-label">验收门禁与预估成本</span>
                      <strong className="mb-fact-value">
                        {pkt.costEstimateUsd !== null ? `$${pkt.costEstimateUsd.toFixed(2)}` : "无额外费用"}
                        {pkt.targetSummary?.verifyCommand ? ` · ${pkt.targetSummary.verifyCommand.slice(0, 48)}` : ""}
                      </strong>
                    </div>
                    <div className="mb-fact-cell">
                      <span className="mb-fact-label">系统推荐方案</span>
                      <strong className="mb-fact-value">
                        {recOpt ? recOpt.label : "请审阅后选择"}
                      </strong>
                    </div>
                  </div>

                  <section className="mb-brief-section">
                    <h3 className="mb-section-title">① 要做什么与背景上下文</h3>
                    <SafeMarkdown text={pkt.backgroundSummary} />
                  </section>

                  {pkt.whyRecommended && (
                    <div className="mb-rec-box">
                      <strong>② 推荐方案与准入评分理由</strong>
                      <p>{pkt.whyRecommended}</p>
                    </div>
                  )}

                  {pkt.diffOrEvidence && (
                    <details className="mb-evidence-box" open={pkt.kind === "production_release"}>
                      <summary>
                        ③ 验收证据 / 代码 Diff / 原始信号全文
                        <small>{pkt.kind === "production_release" ? "默认展开" : "点击展开查看原文"}</small>
                      </summary>
                      <pre>{pkt.diffOrEvidence}</pre>
                    </details>
                  )}

                  {pkt.rollbackPlan && (
                    <div className="mb-rollback-box">
                      <strong>④ 回滚与兜底方案</strong>
                      <p>{pkt.rollbackPlan}</p>
                    </div>
                  )}

                  {originTrace?.affectedTasks.length ? <section className="mb-brief-section" aria-label="原始巡检任务">
                    <h3 className="mb-section-title">巡检任务 · {originTrace.affectedTasks.length} 项</h3>
                    <div className="mb-receipt-tasks">{originTrace.affectedTasks.map(task => <article key={task.id}>
                      <small>{task.project}</small><strong>{task.title}</strong>
                      <p>巡检时 {taskStateLabel(task.observedStatus)} → 当前 {taskStateLabel(task.status)}</p>
                      {task.latestRun?.errorSummary && <p>{task.latestRun.errorSummary}</p>}
                    </article>)}</div>
                    <p>本次巡检暂无关联 Bot 回执，可按原审批单和任务状态决定。</p>
                  </section> : null}
                  <ApprovalCommands key={pkt.id + pkt.updatedAt} packet={pkt} trace={originTrace}
                    note={decisionNote} setNote={setDecisionNote} busy={busy} onResolve={resolveDecisionPacket} />
                  </>}
                </>
              );
            })() : selected?.kind === "executive" ? (() => {
              const mail = selected.item;
              const packet = selectedIssue?.decisions.find(p => p.id === mail.trace?.decisionId);
              return (
              <>
                <header className="mb-letterhead">
                  <div className="mb-letterhead-top">
                    <span>
                      <strong>{selected.item.senderName}</strong> · {selected.item.senderRole}
                      {mail.historical && <span className="mb-tag">本地历史回执</span>}
                    </span>
                    <time>{formatTime(selected.item.createdAt)}</time>
                  </div>
                  <h2>{receiptTitle(mail)}</h2>
                  <div className="mb-letterhead-actions">
                    {selected.item.direction === "inbound" && (
                      <button
                        type="button"
                        onClick={() => void setMailRead(selected.item.id, !selected.item.read, true)}
                      >
                        {selected.pending && !mail.trace?.decision && !mail.trace?.origin ? "归档此待办" : selected.item.read ? "标为未读" : "标为已读"}
                      </button>
                    )}
                    <a className="mb-link-btn" href={`${nativeOrigin}/#/bot`} target="_blank" rel="noreferrer">
                      在原生 Agent Home 查看完整会话 ↗
                    </a>
                  </div>
                </header>

                {mail.trace ? <>
                  <ReceiptOverview item={mail} packet={packet} onOpenDecision={packet && openDecision}
                    onOpenMessage={selectedIssue?.messages.some(entry => entry.id === mail.trace?.origin?.messageId)
                      ? openMessage : undefined} />
                  {packet && <ApprovalCommands key={packet.id + packet.updatedAt + mail.id} packet={packet} trace={mail.trace}
                    note={decisionNote} setNote={setDecisionNote} busy={busy} onResolve={resolveDecisionPacket} />}
                  <details className="mb-evidence-box">
                    <summary>展开原始派单与完整回执</summary>
                    <SafeMarkdown text={mail.body} />
                  </details>
                </> : <SafeMarkdown text={mail.body} />}

                <section className="mb-reply-card" aria-label="回复或批示 Super Bot">
                  <h3>{mail.trace ? "补充要求 / 追问 Super Bot" : "回复 Super Bot"}</h3>
                  <div className="mb-quick-decisions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setReplyBody(
                        `请针对「${receiptTitle(mail)}」核对原任务和现场，补齐本次实际做了什么、结论、可核验的证据及需要我批准的具体动作。若已有正式审批单，请提供原审批单编号和准确的可选项；如需变更，请先提交新方案。`
                      )}
                    >
                      生成补充核查指令
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setReplyBody(`请重新整理「${receiptTitle(mail)}」的处理方案，明确目标、范围、验收标准以及风险，整理完向我汇报。`)}
                    >
                      生成修改要求
                    </button>
                  </div>
                  <textarea
                    rows={3}
                    value={replyBody}
                    disabled={busy}
                    onChange={(e) => setReplyBody(e.target.value)}
                    onKeyDown={onReplyKeyDown}
                    placeholder="输入补充批示、追问或下一步指令…（Cmd/Ctrl + Enter 发送）"
                  />
                  <div className="mb-form-foot">
                    <small>发送后由 Super Bot 跟进，正式审批在原事项确认。</small>
                    <button
                      type="button"
                      className="mb-dark"
                      disabled={busy || !replyBody.trim() || mailbox?.agentHomeReachable === false}
                      onClick={() => void sendReply()}
                    >
                      {busy ? "发送中…" : "回复 Super Bot"}
                    </button>
                  </div>
                </section>
              </>
              );
            })() : selected?.kind === "system" ? (
              <>
                <header className="mb-letterhead">
                  <div className="mb-letterhead-top">
                    <span>
                      <strong>{selected.item.source}</strong>
                      {selected.item.folder ? ` · ${selected.item.folder}` : ""}
                    </span>
                    <time>{formatTime(selected.item.at)}</time>
                  </div>
                  <h2>{messageText(selected.item).title}</h2>
                  <div className="mb-letterhead-actions">
                    <a className="mb-link-btn" href={selected.item.id.startsWith("delegation:")
                      ? selected.item.delegation?.sourceHref || decisionTarget(selected.item)
                      : decisionTarget(selected.item)}>
                      打开关联业务页 ↗
                    </a>
                    {selected.pending && selected.item.origin === "workflow" && !selected.item.readOnly && (
                      <button
                        type="button"
                        className="mb-bot-quick-btn"
                        disabled={arbitratorBusy || busy}
                        onClick={() => void runBotArbitratorSingle("workflow", selected.item.taskId)}
                      >
                        {arbitratorBusy ? "Bot 处理中…" : "🤖 交给 Bot 拍板"}
                      </button>
                    )}
                    {selected.item.failureNotice && (
                      selected.item.failureNotice.handledAt
                        ? <span className="mb-tag" data-tone="info">异常已关闭</span>
                        : <button type="button" disabled={busy}
                          onClick={() => void closeFailureNotice(selected.item)}>关闭异常通知</button>
                    )}
                  </div>
                </header>

                {selected.item.origin === "workflow" && (() => {
                  const botLog = latestBotLogByTarget.get(selected.item.taskId);
                  if (!botLog) return null;
                  const isEscalated = botLog.verdict === "escalate" || botLog.verdict === "escalated";
                  const tone = isEscalated ? "warn" : botLog.executed ? "good" : "info";
                  return (
                    <section className="mb-bot-verdict-banner" data-tone={tone} aria-label="Bot 工作流拍板记录">
                      <div className="mb-bot-verdict-head">
                        <strong>
                          🤖 {botLog.executed ? "Bot 已代拍板" : isEscalated ? "Bot 已上报创始人裁决" : "Bot 研判建议"}
                          {" · "}
                          {VERDICT_LABELS[botLog.verdict] ?? botLog.verdict}
                        </strong>
                        <small>{botLog.actor} · {formatTime(botLog.createdAt)}</small>
                      </div>
                      {botLog.reason && <div>{botLog.reason}</div>}
                      {botLog.nextStep && <div>下一步安排：{botLog.nextStep}</div>}
                    </section>
                  );
                })()}

                {selected.pending && selected.item.origin === "workflow" && selected.item.action && !selected.item.readOnly && (
                  <MailboxWorkflowAction key={selected.item.id} message={selected.item} onChanged={() => {
                    setNotice({ text: "已写入原工作流。后续进度以执行回执为准。", tone: "good" });
                    onResolved?.();
                  }} />
                )}

                <SafeMarkdown text={messageText(selected.item).body || messageText(selected.item).title} />

                {selected.item.context && (
                  <section style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(0,0,0,0.035)" }}>
                    <strong style={{ fontSize: "0.84rem" }}>任务背景与上下文：</strong>
                    <p style={{ margin: "6px 0 0", fontSize: "0.84rem", whiteSpace: "pre-wrap" }}>
                      {selected.item.context}
                    </p>
                  </section>
                )}

                {(selected.pending || selected.item.delegation?.status === "working" || selected.item.delegation?.status === "queued") && !selected.item.id.startsWith("delegation:") && (
                  <DelegateWork key={selected.item.id} messageId={selected.item.id}
                    label={selected.item.action?.kind === "decision" || selected.item.requiresApproval
                      ? "委派核对与建议" : "委派办理"}
                    personal={selected.item.action?.kind === "decision" || selected.item.requiresApproval} />
                )}

                {selected.item.evidence && selected.item.evidence.length > 0 && (
                  <ul style={{ marginTop: 12, fontSize: "0.83rem" }}>
                    {selected.item.evidence.map((ev, idx) => (
                      <li key={idx}><LinkedText text={ev} /></li>
                    ))}
                  </ul>
                )}

                {selected.pending && (selected.item.action?.kind === "reply" || selected.item.action?.kind === "channel-reply") && (
                  <section className="mb-reply-card" style={{ marginTop: 16 }} aria-label="直接答复">
                    <h3>直接答复原事项</h3>
                    <textarea
                      aria-label="答复内容"
                      rows={2}
                      value={decisionNote}
                      disabled={busy}
                      onChange={(e) => setDecisionNote(e.target.value)}
                      placeholder="可选：补充说明或答复内容"
                    />
                    <div className="mb-quick-decisions" style={{ marginTop: 10 }}>
                      {selected.item.choices?.length ? selected.item.choices.map((choice, idx) => (
                        <button
                          key={choice}
                          type="button"
                          className={idx === 0 ? "mb-primary" : undefined}
                          disabled={busy}
                          onClick={() => void replySystemZoomItem(selected.item, choice)}
                        >
                          {choice}
                        </button>
                      )) : <button type="button" className="mb-primary" disabled={busy || !decisionNote.trim()}
                        onClick={() => void replySystemZoomItem(selected.item)}>发送答复</button>}
                    </div>
                  </section>
                )}
              </>
            ) : linkedId && selectedId === linkedId ? (
              <div className="mb-empty" role="status">
                <h2>{loading ? "正在读取关联事项…" : "暂时无法读取这条关联事项"}</h2>
                <p>请刷新后核对原记录，或从左侧选择需要查看的信件。</p>
                <button disabled={busy} onClick={() => void loadMailbox()}>重新读取</button>
              </div>
            ) : (
              <div className="mb-empty">
                <h2>欢迎使用总裁审批网关与信箱</h2>
                <p>
                  所有待开发提案与上线发布都会先经过战略准入门禁过滤，再以「目标仓库 · 执行后果 · 验收证据 · 回滚方案」四段式呈现；支持左侧多选后一键批量批准或批量驳回。
                </p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
                  <a className="mb-link-btn" href="#company-architecture">
                    配置六大部门与免审策略 ↗
                  </a>
                  <button type="button" className="mb-primary" onClick={() => setComposing(true)}>
                    + 写信给 Super Bot
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sticky Floating Batch Approval Dock */}
      {checkedPackets.length > 0 && (
        <div className="mb-batch-dock" role="region" aria-label="批量审批操作栏">
          <div className="mb-batch-dock-top">
            <div className="mb-batch-summary">
              <strong>已勾选 {checkedPackets.length} 项待审批</strong>
              <span className="mb-batch-chips">
                {checkedBreakdown.admissionCount > 0 && (
                  <span className="mb-tag" data-tone="info">需求立项 {checkedBreakdown.admissionCount}</span>
                )}
                {checkedBreakdown.releaseCount > 0 && (
                  <span className="mb-tag" data-tone="warn">代码发布 {checkedBreakdown.releaseCount}</span>
                )}
                {checkedBreakdown.warningCount > 0 && (
                  <span className="mb-tag" data-tone="warn">准入预警 {checkedBreakdown.warningCount}</span>
                )}
                {checkedBreakdown.redlineCount > 0 && (
                  <span className="mb-tag" data-tone="warn">含 {checkedBreakdown.redlineCount} 项红线</span>
                )}
              </span>
            </div>
            <input
              type="text"
              className="mb-batch-note-input"
              value={batchNote}
              disabled={busy}
              onChange={(e) => setBatchNote(e.target.value)}
              placeholder="可选：统一批注（如“资讯摘要噪音批量清理”将同步沉淀避坑规则）"
            />
          </div>

          {pendingRedlineConfirm ? (
            <div className="mb-batch-confirm" role="alert">
              <span>
                ⚠️ 所选包含 <strong>{pendingRedlineConfirm.redlineCount}</strong> 项高风险/红线批准事项（如代码合入/生产发布），确认一并放行执行？
              </span>
              <div className="mb-batch-actions">
                <button
                  type="button"
                  className="mb-primary"
                  disabled={busy}
                  onClick={() => void executeBatchResolve(pendingRedlineConfirm.action, true)}
                >
                  {busy ? "执行中…" : "确认放行红线项"}
                </button>
                <button type="button" disabled={busy} onClick={() => setPendingRedlineConfirm(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-batch-actions">
              <button
                type="button"
                className="mb-primary"
                disabled={busy}
                onClick={() => void executeBatchResolve("recommended")}
                title="按每张审批单各自的推荐方案批量执行"
              >
                {busy ? "处理中…" : `按推荐批量处理 (${checkedPackets.length})`}
              </button>
              <button
                type="button"
                className="mb-batch-approve"
                disabled={busy}
                onClick={() => void executeBatchResolve("approve")}
              >
                批量批准
              </button>
              <button
                type="button"
                className="mb-batch-reject"
                disabled={busy || !checkedBreakdown.hasRejectable}
                title={checkedBreakdown.hasRejectable ? "将所选支持驳回的审批单统一驳回丢弃" : "当前所选项均无驳回选项"}
                onClick={() => void executeBatchResolve("reject")}
              >
                批量驳回
              </button>
              {checkedBreakdown.hasSnoozable && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void executeBatchResolve("snooze")}
                >
                  批量暂缓
                </button>
              )}
              <button type="button" disabled={busy} onClick={clearSelection}>
                取消选择
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
