import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  ExecutiveBotRuntime,
  ExecutiveDepartmentId,
  ExecutiveDepartmentView,
  ExecutiveStatus,
} from "../../src/executive-bots-types";
import type { RoleBotEnsureResult, RoleBotId, RoleBotIndex } from "../../src/role-bots-types";
import type { ZoomMessage } from "../../src/zoom-types";
import { request } from "./api";
import { chatRoomLink, decisionTarget } from "./zoom-routes";
import { messageText } from "./zoom-view";
import "./executive-office.css";

const PRESET_DIRECTIVES = [
  { label: "今日一页总裁简报", text: "请统筹五位部门 Bot 做一次快速盘点，只给我 1 页总裁简报：各部门状态灯、关键变化 Top 3、以及必须我拍板的事项与推荐方案。" },
  { label: "盘点待审批项并给建议", text: "请核查当前所有待我拍板或阻塞的事项，让对应部门 Bot 给出风险评估与明确推荐选项（批准/修改/拒绝），减少我逐条翻看细节。" },
  { label: "1号商业试点推进诊断", text: "请商业与增长部 Bot 与产研部 Bot 联合核查 1 号商业试点距离真实首单还差哪几步，列出可自治推进项与需我签字确认项。" },
  { label: "集群健康与套餐成本盘点", text: "请运维部 Bot 与资源财务部 Bot 联合检查 Tailscale 机器、部署服务健康度及 AI 订阅套餐余量/登录态，只报异常与预警项。" },
];

function botStatusLabel(status: ExecutiveBotRuntime["status"]): { text: string; tone: "good" | "info" | "warn" | "muted" } {
  switch (status) {
    case "running": return { text: "调度运行中", tone: "info" };
    case "idle": return { text: "在线待命", tone: "good" };
    case "paused": return { text: "已暂停", tone: "warn" };
    case "disabled": return { text: "已停用", tone: "warn" };
    default: return { text: "待建制", tone: "muted" };
  }
}

function taskStatusLabel(status: string): { text: string; tone: "good" | "info" | "warn" | "muted" } {
  switch (status) {
    case "completed": return { text: "已回执", tone: "good" };
    case "running":
    case "in_progress": return { text: "执行中", tone: "info" };
    case "queued":
    case "pending": return { text: "已派单", tone: "muted" };
    case "failed":
    case "error": return { text: "异常", tone: "warn" };
    case "cancelled":
    case "canceled": return { text: "已取消", tone: "muted" };
    default: return { text: status, tone: "muted" };
  }
}

function formatTime(iso: string) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ExecutiveOffice({ nav, pending }: { nav: ReactNode; pending: ZoomMessage[] }) {
  const [status, setStatus] = useState<ExecutiveStatus | null>(null);
  const [roleBots, setRoleBots] = useState<RoleBotIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string>("");
  const [directive, setDirective] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "good" | "warn"; roomId?: string } | null>(null);
  const [customOpen, setCustomOpen] = useState<Partial<Record<ExecutiveDepartmentId, boolean>>>({});
  const [customDraft, setCustomDraft] = useState<Partial<Record<ExecutiveDepartmentId, string>>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [data, roles] = await Promise.all([
        request<ExecutiveStatus>("/api/opc/executive/status", { signal }),
        request<RoleBotIndex>("/api/opc/role-bots", { signal }).catch(() => null),
      ]);
      setStatus(data);
      if (roles) setRoleBots(roles);
    } catch (err) {
      if (signal?.aborted) return;
      setNotice({ text: err instanceof Error ? err.message : "读取总裁办状态失败", tone: "warn" });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const ensureRoleBot = async (roleId: RoleBotId) => {
    setBusyAction(`role:${roleId}`);
    setNotice(null);
    try {
      const res = await request<RoleBotEnsureResult>(`/api/opc/role-bots/${encodeURIComponent(roleId)}/ensure`, {
        method: "POST",
      });
      setNotice({
        text: `${res.action === "created" ? "已按契约自动建制" : "已直接复用现有职能 Bot"}「${res.botName}」（${res.matchedBy}）。`,
        tone: "good",
        roomId: status?.room?.id,
      });
      await load();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "职能 Bot 复用/建制失败", tone: "warn" });
    } finally {
      setBusyAction("");
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const runBootstrap = async () => {
    setBusyAction("bootstrap");
    setNotice(null);
    try {
      const next = await request<ExecutiveStatus>("/api/opc/executive/bootstrap", { method: "POST" });
      setStatus(next);
      setNotice({
        text: "已完成两层组织建制：5 位大部门 VP Bot 已创建并编入「OPC 一人公司部门管理」，Super Bot 已接管总控协调群与汇报契约。",
        tone: "good",
        roomId: next.room?.id,
      });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "一键建制失败", tone: "warn" });
    } finally {
      setBusyAction("");
    }
  };

  const requestBrief = async (focusText?: string, actionKey = "brief") => {
    setBusyAction(actionKey);
    setNotice(null);
    try {
      const res = await request<{ ok: boolean; roomId: string; mode: string }>("/api/opc/executive/brief", {
        method: "POST",
        body: JSON.stringify({ focus: focusText?.trim() || undefined, mode: "room" }),
      });
      if (actionKey === "directive") setDirective("");
      setNotice({
        text: "已将总裁指令发至「OPC 总裁办 · Super Bot 总控群」并 @Super Bot，Super Bot 将按归属调度部门 Bot 并回传精简简报。",
        tone: "good",
        roomId: res.roomId,
      });
      await load();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "下发总裁指令失败", tone: "warn" });
    } finally {
      setBusyAction("");
    }
  };

  const onDirectiveSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!directive.trim()) {
      void requestBrief("", "directive");
      return;
    }
    void requestBrief(directive, "directive");
  };

  const dispatchDept = async (dept: ExecutiveDepartmentView, instruction: string) => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    setBusyAction(`dept:${dept.id}`);
    setNotice(null);
    try {
      const res = await request<{ ok: boolean; taskId: string; targetName: string }>(
        `/api/opc/executive/departments/${encodeURIComponent(dept.id)}/dispatch`,
        { method: "POST", body: JSON.stringify({ instruction: trimmed }) },
      );
      setCustomDraft(prev => ({ ...prev, [dept.id]: "" }));
      setCustomOpen(prev => ({ ...prev, [dept.id]: false }));
      setNotice({
        text: `Super Bot 已向「${res.targetName}」派发任务（${res.taskId.slice(0, 8)}），回执将显示在下方调度流中。`,
        tone: "good",
        roomId: status?.room?.id,
      });
      await load();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "部门派单失败", tone: "warn" });
    } finally {
      setBusyAction("");
    }
  };

  const toggleCron = async () => {
    if (!status?.briefCron) return;
    setBusyAction("cron");
    setNotice(null);
    try {
      const next = await request<ExecutiveStatus>("/api/opc/executive/cron/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: !status.briefCron.enabled }),
      });
      setStatus(next);
      setNotice({
        text: next.briefCron?.enabled
          ? "已开启每日 09:00 OPC 总裁晨报（Super Bot 将自动汇总五部并推送到总控群）。"
          : "已关闭每日定时总裁晨报（可随时手动一键索要简报）。",
        tone: "good",
      });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "切换定时晨报失败", tone: "warn" });
    } finally {
      setBusyAction("");
    }
  };

  const routeDelegationToSuperBot = async () => {
    if (!status?.superBot.botId) return;
    setBusyAction("route-delegation");
    setNotice(null);
    try {
      await request("/api/opc/delegations/preference", {
        method: "PUT",
        body: JSON.stringify({
          via: "agent-home",
          target: status.superBot.botId,
          instructions: "由 Super Bot 先分拣归属部门并委派对应部门 Bot 核查执行，汇总结论与明确审批建议后再向创始人汇报。",
          automatic: false,
        }),
      });
      await load();
      setNotice({ text: "已将 OPC OS 默认委派总口切换为 Super Bot。", tone: "good" });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "更新默认委派失败", tone: "warn" });
    } finally {
      setBusyAction("");
    }
  };

  const pulse = status?.companyPulse;
  const superState = botStatusLabel(status?.superBot.status ?? "missing");
  const roomHref = status?.room ? chatRoomLink({ room: status.room.id }) : "#home-room";
  const pendingCount = Math.max(pending.length, pulse?.pendingApprovals ?? 0);

  return (
    <section className="zo-product exec-office" aria-label="总裁办 Bot 架构">
      <header className="zo-product-head">
        {nav}
        <h1>总裁办 · Bot 架构</h1>
        <div className="exec-head-right">
          {status && (
            <>
              <span className="exec-pill" data-tone={status.agentHomeReachable ? "good" : "warn"}>
                {status.agentHomeReachable ? "Agent Home 在线" : "Agent Home 离线"}
              </span>
              <span className="exec-pill" data-tone={status.bootstrapped ? "good" : "warn"}>
                {status.bootstrapped ? "两层建制已就绪（1 + 5）" : "待一键建制"}
              </span>
            </>
          )}
          <button type="button" className="exec-btn-ghost" disabled={loading || !!busyAction} onClick={() => void load()}>
            刷新状态
          </button>
        </div>
      </header>

      <div className="exec-main">
        {notice && (
          <div className="exec-notice" role={notice.tone === "warn" ? "alert" : "status"} data-tone={notice.tone}>
            <span>{notice.text}</span>
            {notice.roomId && (
              <a href={chatRoomLink({ room: notice.roomId })}>前往总控群查看 ↗</a>
            )}
          </div>
        )}

        {status?.error && (
          <div className="exec-notice" role="alert" data-tone="warn">
            <span>{status.error}</span>
          </div>
        )}

        {loading && !status ? (
          <p role="status">正在连接 Agent Home 并读取五大部门 Bot 状态…</p>
        ) : status && (
          <>
            {/* 创始人极简仪表盘 + 一句话总裁命令台 */}
            <section className="exec-block" aria-label="创始人总控入口">
              <div className="exec-block-head">
                <h2>创始人一页总览与指令台</h2>
                <span className="exec-block-sub">日常只对接 Super Bot，由其分派 5 大部门 Bot 查证并挡住 90% 执行细节</span>
              </div>

              <div className="exec-kpis">
                <div className="exec-kpi" data-tone={pendingCount > 0 ? "warn" : "good"}>
                  <span>待我拍板审批</span>
                  <strong>{pendingCount} 项</strong>
                  <small>{pendingCount > 0 ? "已过滤常规进展，仅留需决策项" : "当前无需人工干预"}</small>
                </div>
                <div className="exec-kpi" data-tone={(pulse?.pilotCompletionPct ?? 0) >= 80 ? "good" : undefined}>
                  <span>1 号商业试点（{pulse?.pilotProduct || "PageLens"}）</span>
                  <strong>{pulse?.pilotCompletionPct ?? 0}%</strong>
                  <small><a href="#commercial">进入商业与治理部 ↗</a></small>
                </div>
                <div className="exec-kpi" data-tone={pulse && pulse.totalServices > 0 && pulse.healthyServices === pulse.totalServices ? "good" : "warn"}>
                  <span>基础设施与服务健康</span>
                  <strong>{pulse ? `${pulse.healthyServices}/${pulse.totalServices}` : "—"}</strong>
                  <small>{pulse ? `Tailscale 机器 ${pulse.onlineMachines}/${pulse.totalMachines} 台在线` : "读取中"}</small>
                </div>
                <div className="exec-kpi" data-tone={(pulse?.openSecurityReviews ?? 0) === 0 ? "good" : "warn"}>
                  <span>安全与合规门禁</span>
                  <strong>{(pulse?.openSecurityReviews ?? 0) === 0 ? "全绿灯" : `${pulse?.openSecurityReviews} 项待闭环`}</strong>
                  <small><a href="#security-department">查看安全部门 ↗</a></small>
                </div>
              </div>

              <div className="exec-toolbar">
                <button
                  type="button"
                  className={status.bootstrapped ? "" : "exec-btn-primary"}
                  disabled={!!busyAction || !status.agentHomeReachable}
                  onClick={() => void runBootstrap()}
                >
                  {busyAction === "bootstrap"
                    ? "正在同步建制…"
                    : status.bootstrapped
                      ? "重新同步五部契约与群成员"
                      : "一键建制（创建 5 大部门 Bot 并挂接 Super Bot）"}
                </button>
                <button
                  type="button"
                  className="exec-btn-primary"
                  disabled={!!busyAction || !status.agentHomeReachable}
                  onClick={() => void requestBrief("", "brief")}
                >
                  {busyAction === "brief" ? "正在召唤 Super Bot…" : "向 Super Bot 要今日总裁简报"}
                </button>
                {status.room && (
                  <a className="exec-toolbar-link" href={roomHref}>
                    打开「{status.room.title}」 ↗
                  </a>
                )}
                {status.briefCron && (
                  <button
                    type="button"
                    disabled={!!busyAction}
                    onClick={() => void toggleCron()}
                    title="控制 Agent Home 每日 09:00 自动汇总五部晨报"
                  >
                    {busyAction === "cron"
                      ? "切换中…"
                      : status.briefCron.enabled
                        ? "每日 09:00 总裁晨报：已开启"
                        : "每日 09:00 总裁晨报：已关闭（点此开启）"}
                  </button>
                )}
                {status.superBot.botId && !status.delegationRoutedToSuperBot && (
                  <button type="button" disabled={!!busyAction} onClick={() => void routeDelegationToSuperBot()}>
                    将默认委派总口切至 Super Bot
                  </button>
                )}
              </div>

              <form className="exec-directive" onSubmit={onDirectiveSubmit}>
                <div className="exec-directive-label">
                  <strong>向 Super Bot 下达总裁指令</strong>
                  <span>你只需说目标，Super Bot 负责拆分部门任务、核查回执并在总控群呈报结论</span>
                </div>
                <div className="exec-directive-row">
                  <input
                    type="text"
                    value={directive}
                    onChange={e => setDirective(e.target.value)}
                    placeholder="例如：排查今天哪些服务或套餐有风险，并告诉我 1 号试点下一步最该批什么…"
                    disabled={!!busyAction || !status.agentHomeReachable}
                  />
                  <button
                    type="submit"
                    className="exec-btn-dark"
                    disabled={!!busyAction || !status.agentHomeReachable}
                  >
                    {busyAction === "directive" ? "下发中…" : "发给 Super Bot 统筹"}
                  </button>
                </div>
                <div className="exec-presets" aria-label="快捷总裁指令">
                  {PRESET_DIRECTIVES.map(preset => (
                    <button
                      key={preset.label}
                      type="button"
                      disabled={!!busyAction || !status.agentHomeReachable}
                      onClick={() => void requestBrief(preset.text, `preset:${preset.label}`)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </form>
            </section>

            {/* 两层 Bot 组织架构：Tier 0 Super Bot -> Tier 1 五大部门 VP Bot */}
            <section className="exec-block" aria-label="两层 Bot 组织架构">
              <div className="exec-block-head">
                <h2>两层数字员工组织架构</h2>
                <span className="exec-block-sub">
                  第 1 层：Super Bot 总控协调与汇报 ｜ 第 2 层：五大部门 VP Bot 自治巡检、越线必报
                </span>
              </div>

              <article className="exec-super" aria-label="Super Bot 总控 COO">
                <div className="exec-super-head">
                  <div className="exec-super-title">
                    <h3>
                      <span>{status.superBot.name}</span>
                      <span className="exec-pill" data-tone={superState.tone}>{superState.text}</span>
                      <span className="exec-pill" data-tone="info">总控 COO · 创始人唯一日常接口</span>
                    </h3>
                    <small>botId: {status.superBot.botId ?? "未连接"} · 角色：{status.superBot.title}</small>
                  </div>
                  <div className="exec-dept-actions">
                    <a className="exec-toolbar-link" href={roomHref}>进入总控群对话 ↗</a>
                  </div>
                </div>
                <p className="exec-super-desc">
                  通过 <code>bot_team_status</code> / <code>bot_delegate</code> / <code>bot_task_results</code> 统筹调度下辖 5 位部门 Bot，日常过滤琐碎过程、汇总 1 页总裁简报，并把涉及资金、定价、发版、高危运维与安全红线的事项整理成「推荐选项 + 风险一句话」呈报给你拍板。
                </p>
                <div className="exec-super-meta">
                  <span>功能分组：{status.group ? <code>{status.group.name}</code> : "待建制"}</span>
                  <span>总控群模式：{status.room ? <code>{status.room.replyMode}（协调者主控）</code> : "待建制"}</span>
                  <span>默认委派总口：{status.delegationRoutedToSuperBot ? <strong style={{ color: "#245739" }}>已路由至 Super Bot</strong> : "未切换"}</span>
                  <span>历史完成：{status.superBot.completedCount} · 待处理：{status.superBot.pendingCount} · 进行中：{status.superBot.activeWorkCount}</span>
                </div>
              </article>

              <div className="exec-connector" aria-hidden="true">
                <div className="exec-connector-stem" />
                <div className="exec-connector-bar">Super Bot 向下按部门派单（bot_delegate） · 各部门 Bot 自治巡检并按红线向上汇报审批</div>
              </div>

              <div className="exec-dept-grid">
                {status.departments.map(dept => {
                  const st = botStatusLabel(dept.runtime.status);
                  const isDispatching = busyAction === `dept:${dept.id}`;
                  const showCustom = Boolean(customOpen[dept.id]);
                  return (
                    <article key={dept.id} className="exec-dept-card" data-dept={dept.id}>
                      <div className="exec-dept-head">
                        <div>
                          <h3>{dept.departmentName}</h3>
                          <div className="exec-dept-sub">{dept.runtime.name} · {dept.botTitle}</div>
                        </div>
                        <span className="exec-pill" data-tone={st.tone}>{st.text}</span>
                      </div>

                      <p className="exec-dept-summary">{dept.summary}</p>

                      {dept.liveHighlights.length > 0 && (
                        <ul className="exec-highlights" aria-label={`${dept.departmentName}实时脉搏`}>
                          {dept.liveHighlights.map((line, idx) => <li key={idx}>{line}</li>)}
                        </ul>
                      )}

                      <div className="exec-pages" aria-label="管辖界面">
                        {dept.ownedPages.map(p => (
                          <a key={p.href + p.label} className="exec-page-chip" href={p.href}>
                            {p.label} ↗
                          </a>
                        ))}
                      </div>

                      <details className="exec-contract-details">
                        <summary>自治边界（{dept.autonomousScope.length}）与审批红线（{dept.approvalRedlines.length}）</summary>
                        <h4>日常自治（不打扰创始人）</h4>
                        <ul>{dept.autonomousScope.map((item, i) => <li key={i}>{item}</li>)}</ul>
                        <div className="exec-contract-redline">
                          <h4>必须经 Super Bot 请求创始人批准</h4>
                          <ul>{dept.approvalRedlines.map((item, i) => <li key={i}>{item}</li>)}</ul>
                        </div>
                      </details>

                      <div className="exec-dept-foot">
                        <span className="exec-dept-stats" title={dept.runtime.botId ?? ""}>
                          {dept.runtime.botId
                            ? `${dept.runtime.botId.length > 14 ? dept.runtime.botId.slice(0, 12) + "…" : dept.runtime.botId} · 完${dept.runtime.completedCount}/办${dept.runtime.activeWorkCount}${dept.runtime.inRoom ? " · 在群" : ""}`
                            : "尚未建制"}
                        </span>
                        <div className="exec-dept-actions">
                          <button
                            type="button"
                            disabled={!!busyAction || !status.agentHomeReachable}
                            onClick={() => void dispatchDept(dept, dept.defaultPatrolPrompt)}
                          >
                            {isDispatching ? "派单中…" : "派单巡检"}
                          </button>
                          <button
                            type="button"
                            className="exec-btn-ghost"
                            disabled={!!busyAction || !status.agentHomeReachable}
                            onClick={() => setCustomOpen(prev => ({ ...prev, [dept.id]: !prev[dept.id] }))}
                          >
                            {showCustom ? "收起" : "定向指令"}
                          </button>
                        </div>
                      </div>

                      {showCustom && (
                        <form
                          className="exec-inline-dispatch"
                          onSubmit={e => {
                            e.preventDefault();
                            void dispatchDept(dept, customDraft[dept.id] ?? "");
                          }}
                        >
                          <input
                            type="text"
                            value={customDraft[dept.id] ?? ""}
                            onChange={e => setCustomDraft(prev => ({ ...prev, [dept.id]: e.target.value }))}
                            placeholder={`由 Super Bot 派给${dept.departmentName}的具体任务…`}
                          />
                          <button type="submit" className="exec-btn-dark" disabled={!!busyAction || !(customDraft[dept.id] ?? "").trim()}>
                            派发
                          </button>
                        </form>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>

            {/* 流程协同职能 Bot 池（Coding Agent 干活 · 职能 Bot 按需复用/建制串联） */}
            {roleBots && (
              <section className="exec-block" aria-label="流程协同职能 Bot 池">
                <div className="exec-block-head">
                  <h2>流程协同职能 Bot 池（双引擎分工 · 有则复用 / 无则建制）</h2>
                  <span className="exec-block-sub">{roleBots.principle}</span>
                </div>
                <div className="exec-dept-grid">
                  {roleBots.roles.map(role => {
                    const tone = role.resolution === "on_demand" ? "muted" : role.resolution === "reused" ? "good" : "info";
                    const label = role.resolution === "reused" ? "已复用现网 Bot" : role.resolution === "created" ? "已按契约建制" : "按需待创建";
                    return (
                      <article key={role.id} className="exec-dept-card">
                        <div className="exec-dept-top">
                          <div>
                            <h3>{role.roleName}</h3>
                            <small>{role.resolvedName ? `${role.resolvedName} (${role.botId})` : `默认名：${role.botName}`}</small>
                          </div>
                          <span className="exec-pill" data-tone={tone}>{label}</span>
                        </div>
                        <p className="exec-dept-summary">{role.engineRule}</p>
                        {role.matchedBy && <p className="exec-block-sub">{role.matchedBy}</p>}
                        <div className="exec-dept-actions">
                          <button
                            type="button"
                            disabled={!!busyAction || !roleBots.agentHomeReachable}
                            onClick={() => void ensureRoleBot(role.id)}
                          >
                            {busyAction === `role:${role.id}`
                              ? "处理中…"
                              : role.resolution === "on_demand"
                                ? "按需创建并编入总控群"
                                : "确认复用并同步群成员"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {/* 待创始人拍板（精简审批台） */}
            <section className="exec-block" aria-label="待创始人拍板审批台">
              <div className="exec-block-head">
                <h2>待我拍板 · 精简审批台</h2>
                <span className="exec-block-sub">仅聚合需要创始人签字批准、打回修改或处理的事项；不确定时可先让 Super Bot 研判给建议</span>
              </div>
              {pending.length === 0 ? (
                <div className="exec-empty-good">
                  当前 0 项待创始人拍板。五大部门日常巡检与自治任务均由 Super Bot 统筹消化，只有触发红线的事项会浮现至此。
                </div>
              ) : (
                <ul className="exec-approval-list">
                  {pending.map(item => {
                    const parsed = messageText(item);
                    const actionKey = `advise:${item.id}`;
                    return (
                      <li key={item.id} className="exec-approval-item">
                        <div className="exec-approval-main">
                          <strong>{parsed.title}</strong>
                          <small>{item.folder} · 来源：{item.source} · {formatTime(item.at)}</small>
                        </div>
                        <div className="exec-approval-actions">
                          <button
                            type="button"
                            disabled={!!busyAction || !status.agentHomeReachable}
                            onClick={() =>
                              void requestBrief(
                                `请 Super Bot 调度对应部门 Bot 快速研判待审批事项「${parsed.title}」（目录：${item.folder}，来源：${item.source}），直接给我一句风险评估与明确推荐选项（批准 / 要求修改 / 拒绝）。`,
                                actionKey,
                              )
                            }
                          >
                            {busyAction === actionKey ? "研判派发中…" : "先让 Super Bot 研判给建议"}
                          </button>
                          <a className="exec-toolbar-link" href={decisionTarget(item)}>进入拍板 ↗</a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* 最近 Super Bot 调度与部门回执流 */}
            <section className="exec-block" aria-label="Super Bot 调度与部门回执流">
              <div className="exec-block-head">
                <h2>最近 Super Bot 调度与部门回执</h2>
                <span className="exec-block-sub">实时同步自 Agent Home Bot Work 队列（{status.recentTasks.length} 条记录）</span>
              </div>
              {status.recentTasks.length === 0 ? (
                <p className="exec-block-sub">
                  暂无部门调度记录。点击上方「向 Super Bot 要今日总裁简报」或任意部门卡片的「派单巡检」即可发起首轮自动化调度。
                </p>
              ) : (
                <ul className="exec-task-list">
                  {status.recentTasks.map(task => {
                    const ts = taskStatusLabel(task.status);
                    return (
                      <li key={task.id} className="exec-task-item">
                        <div className="exec-task-top">
                          <span className="exec-task-route">
                            {task.requesterName} → {task.targetName}{" "}
                            <span className="exec-pill" data-tone={ts.tone}>{ts.text}</span>
                          </span>
                          <span className="exec-task-time">{formatTime(task.updatedAt)}</span>
                        </div>
                        <div className="exec-task-input">{task.input}</div>
                        {task.result && <div className="exec-task-result">{task.result}</div>}
                        {task.failureReason && <div className="exec-task-error">异常：{task.failureReason}</div>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
