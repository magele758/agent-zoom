import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Token, Tokens } from "marked";
import type {
  ExecutiveDepartmentId,
  ExecutiveMailboxResponse,
  ExecutiveMailItem,
} from "../../src/executive-bots-types";
import type { DecisionPacket, GovernancePolicy } from "../../src/kernel/types";
import type { ZoomMessage } from "../../src/zoom-types";
import { api, request } from "./api";
import { LinkedText } from "./InternalLinks";
import { decisionTarget } from "./zoom-routes";
import { messageText } from "./zoom-view";
import "./founder-mailbox.css";

type MailFilter = "all" | "pending" | "decisions" | "executive" | "handled";

type UnifiedMail =
  | { kind: "decision"; id: string; at: string; pending: boolean; unread: boolean; item: DecisionPacket }
  | { kind: "executive"; id: string; at: string; pending: boolean; unread: boolean; item: ExecutiveMailItem }
  | { kind: "system"; id: string; at: string; pending: boolean; unread: boolean; item: ZoomMessage };

const DOMAIN_LABELS: Record<string, string> = {
  strategy: "01 · 战略部",
  product: "02 · 产品部",
  factory: "03 · 研发暗工厂",
  resources: "04 · 算力调度部",
  ops: "05 · 自愈运维部",
  commercial: "06 · 商业总账部",
};

const RISK_LABELS: Record<string, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "红线级",
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
        <table>
          <thead><tr>{table.header.map((c, i) => <th key={i}>{renderTokens(c.tokens)}</th>)}</tr></thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderTokens(cell.tokens)}</td>)}</tr>
            ))}
          </tbody>
        </table>
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

export function FounderMailbox({
  nav,
  messages,
  onResolved,
}: {
  nav: ReactNode;
  messages: ZoomMessage[];
  onResolved?: () => void;
}) {
  const [mailbox, setMailbox] = useState<ExecutiveMailboxResponse | null>(null);
  const [decisions, setDecisions] = useState<DecisionPacket[]>([]);
  const [policy, setPolicy] = useState<GovernancePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<MailFilter>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [composing, setComposing] = useState(false);
  const [composeTarget, setComposeTarget] = useState<"" | ExecutiveDepartmentId>("");
  const [composeBody, setComposeBody] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "good" | "warn" } | null>(null);
  const manualUnread = useRef<Set<string>>(new Set());

  const loadMailbox = useCallback(async (signal?: AbortSignal) => {
    try {
      const [execRes, decRes] = await Promise.allSettled([
        request<ExecutiveMailboxResponse>("/api/opc/executive/mailbox", { signal }),
        request<{ packets: DecisionPacket[]; policy: GovernancePolicy }>("/api/opc/kernel/decisions", { signal }),
      ]);
      if (!signal?.aborted) {
        if (execRes.status === "fulfilled") setMailbox(execRes.value);
        if (decRes.status === "fulfilled") {
          setDecisions(decRes.value.packets);
          setPolicy(decRes.value.policy);
        }
      }
    } catch (err) {
      if (!signal?.aborted) {
        setNotice({ text: err instanceof Error ? err.message : "读取总裁审批网关失败", tone: "warn" });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadMailbox(controller.signal);
    return () => controller.abort();
  }, [loadMailbox]);

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
      if (!document.hidden) void loadMailbox();
    }, interval);
    return () => window.clearInterval(timer);
  }, [mailbox?.superBotWorking, loadMailbox]);

  const unified = useMemo<UnifiedMail[]>(() => {
    const decisionMails: UnifiedMail[] = decisions.map((pkt) => ({
      kind: "decision",
      id: `dec:${pkt.id}`,
      at: pkt.updatedAt,
      pending: pkt.status === "pending",
      unread: pkt.status === "pending" && !pkt.viewedAt,
      item: pkt,
    }));

    // Deduplicate echoed '[待审批 · ...]' notices copied into Agent Home room
    const execMails: UnifiedMail[] = (mailbox?.items ?? [])
      .filter((item) => !item.body.startsWith("[待审批 ·"))
      .map((item) => ({
        kind: "executive",
        id: `exec:${item.id}`,
        at: item.createdAt,
        pending: item.needsDecision && !item.read,
        unread: item.direction === "inbound" && !item.read,
        item,
      }));

    // Skip legacy patrol/kill-switch duplicates if already represented in DecisionGateway
    const hasPatrolDecision = decisions.some((d) => d.kind === "patrol_alert" && d.status === "pending");
    const hasKillDecision = decisions.some((d) => d.kind === "kill_switch" && d.status === "pending");

    const systemMails: UnifiedMail[] = messages
      .filter((m) => {
        if (m.id.startsWith("home-room:")) return false;
        if (hasPatrolDecision && m.source.includes("后台巡检卫士")) return false;
        if (hasKillDecision && m.source.includes("商业熔断卫士")) return false;
        return true;
      })
      .map((item) => ({
        kind: "system",
        id: `sys:${item.id}`,
        at: item.at,
        pending: item.pending,
        unread: item.pending,
        item,
      }));

    return [...decisionMails, ...execMails, ...systemMails].sort(
      (a, b) => Number(b.pending) - Number(a.pending) || b.at.localeCompare(a.at),
    );
  }, [decisions, mailbox?.items, messages]);

  const counts = useMemo(() => ({
    all: unified.length,
    pending: unified.filter((m) => m.pending).length,
    decisions: unified.filter((m) => m.kind === "decision").length,
    decisionsPending: unified.filter((m) => m.kind === "decision" && m.pending).length,
    executive: unified.filter((m) => m.kind === "executive").length,
    execUnread: unified.filter((m) => m.kind === "executive" && m.unread).length,
    handled: unified.filter((m) => !m.pending).length,
  }), [unified]);

  const visible = useMemo(() => {
    switch (filter) {
      case "pending": return unified.filter((m) => m.pending || m.id === selectedId);
      case "decisions": return unified.filter((m) => m.kind === "decision");
      case "executive": return unified.filter((m) => m.kind === "executive");
      case "handled": return unified.filter((m) => !m.pending);
      default: return unified;
    }
  }, [unified, filter, selectedId]);

  const selected = useMemo(() => {
    if (composing) return null;
    if (selectedId) {
      const exact = unified.find((m) => m.id === selectedId);
      if (exact) return exact;
    }
    return visible[0] ?? null;
  }, [composing, selectedId, unified, visible]);

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

  // Viewing a DecisionPacket ONLY records viewedAt; NEVER drops pending items!
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
    // IMPORTANT FIX: Only auto-mark informational executive mail (!needsDecision) as read!
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

  const resolveDecisionPacket = async (packetId: string, optionId: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await request<{ packet: DecisionPacket }>(
        `/api/opc/kernel/decisions/${encodeURIComponent(packetId)}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({ optionId, note: decisionNote.trim() }),
        },
      );
      setDecisionNote("");
      setNotice({
        text: `已执行拍板决定（状态：${res.packet.status}），动作回调已完成并记入个人偏好记忆库。`,
        tone: "good",
      });
      await loadMailbox();
      onResolved?.();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "执行审批动作失败", tone: "warn" });
    } finally {
      setBusy(false);
    }
  };

  const replySystemZoomItem = async (msg: ZoomMessage, choice?: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.zoomReply(msg.taskId, {
        questionId: msg.id,
        ...(choice ? { choice } : {}),
        body: decisionNote.trim() || choice || "已确认处理",
      });
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

  const sendReply = async (action?: "approve" | "changes" | "reject", presetText?: string) => {
    if (!selected || selected.kind !== "executive" || busy) return;
    const body = (presetText ?? replyBody).trim();
    if (!body) return;
    setBusy(true);
    setNotice(null);
    try {
      await request("/api/opc/executive/mailbox/reply", {
        method: "POST",
        body: JSON.stringify({
          text: body,
          ...(selected.item.messageId ? { replyToMessageId: selected.item.messageId } : {}),
          ...(action ? { action } : {}),
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

  const nativeOrigin = mailbox?.agentHomeOrigin || "http://127.0.0.1:37070";

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
          <button type="button" disabled={busy} onClick={() => void loadMailbox()}>刷新</button>
        </div>
      </header>

      <div className="mb-shell">
        <aside className="mb-stream" aria-label="信件与审批列表">
          <div className="mb-stream-tools">
            <div className="mb-tabs" role="tablist" aria-label="信箱筛选">
              <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                全部 ({counts.all})
              </button>
              <button type="button" aria-pressed={filter === "pending"} onClick={() => setFilter("pending")}>
                待我拍板{counts.pending > 0 ? ` (${counts.pending})` : ""}
              </button>
              <button type="button" aria-pressed={filter === "decisions"} onClick={() => setFilter("decisions")}>
                可执行审批单{counts.decisionsPending > 0 ? ` (${counts.decisionsPending})` : ` (${counts.decisions})`}
              </button>
              <button type="button" aria-pressed={filter === "executive"} onClick={() => setFilter("executive")}>
                Super Bot{counts.execUnread > 0 ? ` · ${counts.execUnread}` : ""}
              </button>
              <button type="button" aria-pressed={filter === "handled"} onClick={() => setFilter("handled")}>
                已处理
              </button>
            </div>
            {mailbox?.superBotWorking && (
              <div className="mb-working-bar" role="status">
                Super Bot / 部门正在整理回执，完成后将自动出现在下方…
              </div>
            )}
          </div>

          {loading && !mailbox && decisions.length === 0 ? (
            <p className="mb-empty" role="status">正在读取总裁审批网关…</p>
          ) : visible.length === 0 ? (
            <div className="mb-empty">
              {filter === "pending"
                ? "当前没有需要你介入拍板的事项（低风险常规事项已由策略引擎自治处理）。"
                : "暂无往来信件或审批单。"}
            </div>
          ) : (
            <ul className="mb-list">
              {visible.map((entry) => {
                const isSelected = !composing && selected?.id === entry.id;
                if (entry.kind === "decision") {
                  const pkt = entry.item;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="mb-item"
                        data-unread={entry.pending ? "true" : "false"}
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => { setComposing(false); setSelectedId(entry.id); setDecisionNote(""); }}
                      >
                        <div className="mb-item-meta">
                          {entry.pending && <span className="mb-unread-dot" aria-label="待审批" />}
                          <span className="mb-item-sender">{DOMAIN_LABELS[pkt.domain] ?? pkt.domain}</span>
                          <span className="mb-item-time">{formatTime(pkt.updatedAt)}</span>
                        </div>
                        <div className="mb-item-subject">{pkt.title}</div>
                        <div className="mb-item-excerpt">{pkt.backgroundSummary}</div>
                        <div className="mb-item-tags">
                          <span className="mb-tag" data-tone={pkt.riskLevel === "high" || pkt.riskLevel === "critical" ? "warn" : "info"}>
                            {RISK_LABELS[pkt.riskLevel] ?? pkt.riskLevel}
                          </span>
                          {pkt.status === "pending" ? (
                            <span className="mb-tag" data-tone="warn">待拍板执行</span>
                          ) : pkt.autoApproved ? (
                            <span className="mb-tag">策略免审放行</span>
                          ) : (
                            <span className="mb-tag">{pkt.status}</span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                }
                if (entry.kind === "executive") {
                  const it = entry.item;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="mb-item"
                        data-unread={entry.unread ? "true" : "false"}
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => { setComposing(false); setSelectedId(entry.id); setReplyBody(""); }}
                      >
                        <div className="mb-item-meta">
                          {entry.unread && <span className="mb-unread-dot" aria-label="未读" />}
                          <span className="mb-item-sender">{it.senderName}</span>
                          <span className="mb-item-time">{formatTime(it.createdAt)}</span>
                        </div>
                        <div className="mb-item-subject">{it.subject}</div>
                        <div className="mb-item-excerpt">{it.excerpt}</div>
                        <div className="mb-item-tags">
                          <span className="mb-tag">{it.senderRole}</span>
                          {it.needsDecision && !it.read && <span className="mb-tag" data-tone="warn">待拍板</span>}
                          {it.status === "working" && <span className="mb-tag" data-tone="info">执行中</span>}
                          {it.status === "failed" && <span className="mb-tag" data-tone="warn">异常</span>}
                        </div>
                      </button>
                    </li>
                  );
                }
                const msg = entry.item;
                const info = messageText(msg);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="mb-item"
                      data-unread={entry.unread ? "true" : "false"}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => { setComposing(false); setSelectedId(entry.id); setDecisionNote(""); }}
                    >
                      <div className="mb-item-meta">
                        {entry.unread && <span className="mb-unread-dot" aria-label="待处理" />}
                        <span className="mb-item-sender">{msg.source}</span>
                        <span className="mb-item-time">{formatTime(msg.at)}</span>
                      </div>
                      <div className="mb-item-subject">{info.title}</div>
                      {info.body && info.body !== info.title && (
                        <div className="mb-item-excerpt">{info.body}</div>
                      )}
                      <div className="mb-item-tags">
                        {msg.folder && <span className="mb-tag">{msg.folder}</span>}
                        {msg.pending && <span className="mb-tag" data-tone="warn">待我拍板</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="mb-reader">
          <div className="mb-reader-inner">
            {notice && (
              <div className="mb-notice" role={notice.tone === "warn" ? "alert" : "status"} data-tone={notice.tone}>
                <span>{notice.text}</span>
              </div>
            )}

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
            ) : selected?.kind === "decision" ? (
              <>
                <header className="mb-letterhead">
                  <div className="mb-letterhead-top">
                    <span>
                      <strong>{DOMAIN_LABELS[selected.item.domain] ?? selected.item.domain}</strong>
                      {` · ${selected.item.kind} · ${RISK_LABELS[selected.item.riskLevel] ?? selected.item.riskLevel}`}
                      {selected.item.costEstimateUsd !== null && ` · 预估成本 $${selected.item.costEstimateUsd.toFixed(2)}`}
                    </span>
                    <time>{formatTime(selected.item.updatedAt)}</time>
                  </div>
                  <h2>{selected.item.title}</h2>
                </header>

                <section style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: "0.92rem", marginBottom: 6 }}>背景与上下文（了解来龙去脉）</h3>
                  <SafeMarkdown text={selected.item.backgroundSummary} />
                </section>

                {selected.item.whyRecommended && (
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      background: "rgba(34, 120, 75, 0.08)",
                      borderLeft: "3px solid #1d6b43",
                      marginBottom: 14,
                      fontSize: "0.88rem",
                    }}
                  >
                    <strong>推荐方案与理由：</strong>
                    {selected.item.whyRecommended}
                  </div>
                )}

                {selected.item.diffOrEvidence && (
                  <details style={{ marginBottom: 14 }} open>
                    <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.88rem" }}>
                      验收证据 / 变更摘要
                    </summary>
                    <pre
                      style={{
                        marginTop: 8,
                        padding: 12,
                        borderRadius: 8,
                        background: "rgba(0,0,0,0.045)",
                        overflowX: "auto",
                        fontSize: "0.8rem",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {selected.item.diffOrEvidence}
                    </pre>
                  </details>
                )}

                {selected.item.rollbackPlan && (
                  <p style={{ fontSize: "0.84rem", color: "var(--muted)", marginBottom: 14 }}>
                    <strong>回滚与兜底方案：</strong>
                    {selected.item.rollbackPlan}
                  </p>
                )}

                {selected.item.status === "pending" ? (
                  <section className="mb-reply-card" aria-label="一键拍板执行">
                    <h3>一键拍板（点击后后端立即自动执行对应动作）</h3>
                    <textarea
                      rows={2}
                      value={decisionNote}
                      disabled={busy}
                      onChange={(e) => setDecisionNote(e.target.value)}
                      placeholder="可选：填写批示备注（将同步记入你的个人偏好记忆库，用于后续自动评估加减权）"
                    />
                    <div className="mb-quick-decisions" style={{ marginTop: 10 }}>
                      {selected.item.options.map((opt) => {
                        const isRec = opt.id === selected.item.recommendedOptionId;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            className={isRec ? "mb-primary" : undefined}
                            disabled={busy}
                            title={opt.description || opt.label}
                            onClick={() => void resolveDecisionPacket(selected.item.id, opt.id)}
                          >
                            {opt.label}
                            {isRec ? " · 推荐" : ""}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : (
                  <div className="mb-notice" data-tone="good">
                    <span>
                      处理结果：<strong>{selected.item.status}</strong>
                      {selected.item.autoApproved ? "（策略引擎低风险自动放行）" : `（拍板人：${selected.item.decidedBy ?? "founder"}）`}
                      {selected.item.decisionNote ? ` · 批注：${selected.item.decisionNote}` : ""}
                    </span>
                  </div>
                )}
              </>
            ) : selected?.kind === "executive" ? (
              <>
                <header className="mb-letterhead">
                  <div className="mb-letterhead-top">
                    <span>
                      <strong>{selected.item.senderName}</strong> · {selected.item.senderRole}
                    </span>
                    <time>{formatTime(selected.item.createdAt)}</time>
                  </div>
                  <h2>{selected.item.subject}</h2>
                  <div className="mb-letterhead-actions">
                    {selected.item.direction === "inbound" && (
                      <button
                        type="button"
                        onClick={() => void setMailRead(selected.item.id, !selected.item.read, true)}
                      >
                        {selected.item.read ? "标为未处理" : "标为已读"}
                      </button>
                    )}
                    <a className="mb-link-btn" href={`${nativeOrigin}/#/bot`} target="_blank" rel="noreferrer">
                      在原生 Agent Home 查看完整会话 ↗
                    </a>
                  </div>
                </header>

                <SafeMarkdown text={selected.item.body} />

                <section className="mb-reply-card" aria-label="回复或批示 Super Bot">
                  <h3>创始人批示 / 回复 Super Bot</h3>
                  <div className="mb-quick-decisions">
                    <button
                      type="button"
                      className="mb-primary"
                      disabled={busy}
                      onClick={() => void sendReply("approve", replyBody.trim() || "批准按推荐方案执行，完成后汇报结果。")}
                    >
                      批准执行
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (replyBody.trim()) void sendReply("changes", replyBody);
                        else setReplyBody("请按以下意见修改后再提交审批：");
                      }}
                    >
                      要求修改
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void sendReply("reject", replyBody.trim() || "暂缓/拒绝此项，请先保持现状。")}
                    >
                      暂缓拒绝
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
                    <small>回复将直接发给 @Super Bot，并在此信箱自动接收后续回执</small>
                    <button
                      type="button"
                      className="mb-dark"
                      disabled={busy || !replyBody.trim()}
                      onClick={() => void sendReply()}
                    >
                      {busy ? "发送中…" : "回复 Super Bot"}
                    </button>
                  </div>
                </section>
              </>
            ) : selected?.kind === "system" ? (
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
                    <a className="mb-link-btn" href={decisionTarget(selected.item)}>
                      打开关联业务页 ↗
                    </a>
                    <button
                      type="button"
                      disabled={busy || mailbox?.agentHomeReachable === false}
                      onClick={() => {
                        const ctx = [
                          messageText(selected.item).body,
                          selected.item.context ? `任务背景：${selected.item.context}` : "",
                          selected.item.evidence?.length ? `证据：${selected.item.evidence.join("；")}` : "",
                        ].filter(Boolean).join("\n");
                        void sendNewMail(
                          `请 Super Bot 调度对应部门 Bot 研判待处理事项「${messageText(selected.item).title}」（目录：${selected.item.folder}，来源：${selected.item.source}）。\n完整上下文：\n${ctx.slice(0, 1500)}\n请直接给我风险评估与明确推荐选项。`,
                          "",
                        );
                      }}
                    >
                      先让 Super Bot 带上下文研判
                    </button>
                  </div>
                </header>

                <SafeMarkdown text={messageText(selected.item).body || messageText(selected.item).title} />

                {selected.item.context && (
                  <section style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(0,0,0,0.035)" }}>
                    <strong style={{ fontSize: "0.84rem" }}>任务背景与上下文：</strong>
                    <p style={{ margin: "6px 0 0", fontSize: "0.84rem", whiteSpace: "pre-wrap" }}>
                      {selected.item.context}
                    </p>
                  </section>
                )}

                {selected.item.delegation?.result && (
                  <section style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(34, 120, 75, 0.08)" }}>
                    <strong style={{ fontSize: "0.84rem" }}>委派前置研判结论：</strong>
                    <p style={{ margin: "6px 0 0", fontSize: "0.84rem", whiteSpace: "pre-wrap" }}>
                      {selected.item.delegation.result}
                    </p>
                  </section>
                )}

                {selected.item.evidence && selected.item.evidence.length > 0 && (
                  <ul style={{ marginTop: 12, fontSize: "0.83rem" }}>
                    {selected.item.evidence.map((ev, idx) => (
                      <li key={idx}><LinkedText text={ev} /></li>
                    ))}
                  </ul>
                )}

                {selected.item.pending && selected.item.origin === "external" && !selected.item.id.startsWith("delegation:") && (
                  <section className="mb-reply-card" style={{ marginTop: 16 }} aria-label="直接内联审批答复">
                    <h3>直接在此拍板 / 答复（无需跳转页面）</h3>
                    <textarea
                      rows={2}
                      value={decisionNote}
                      disabled={busy}
                      onChange={(e) => setDecisionNote(e.target.value)}
                      placeholder="可选：补充说明或答复内容"
                    />
                    <div className="mb-quick-decisions" style={{ marginTop: 10 }}>
                      {(selected.item.choices && selected.item.choices.length > 0
                        ? selected.item.choices
                        : ["批准继续", "暂缓处理"]
                      ).map((choice, idx) => (
                        <button
                          key={choice}
                          type="button"
                          className={idx === 0 ? "mb-primary" : undefined}
                          disabled={busy}
                          onClick={() => void replySystemZoomItem(selected.item, choice)}
                        >
                          {choice}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <div className="mb-empty">
                <h2>欢迎使用总裁审批网关与信箱</h2>
                <p>
                  低风险且预算可控的事项已由微内核策略引擎自治放行；只有触及红线（生产上线、主线调整、亏损熔断、超预算事项）才携带完整上下文汇总至此，点击选项即可驱动后端确定性执行。
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
    </section>
  );
}
