import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  AssetRecord,
  AutonomyMode,
  CompanyArchitectureSnapshot,
  GovernancePolicy,
  MainlineRecord,
  PortfolioTree,
} from "../../src/kernel/types";
import { request } from "./api";
import { OpcStoryFlow } from "./OpcStoryFlow";
import "./company-hub.css";

const AUTONOMY_MODES: Array<{
  mode: AutonomyMode;
  title: string;
  tag: string;
  desc: string;
}> = [
  {
    mode: "assisted",
    title: "人工协助模式",
    tag: "前期推荐",
    desc: "全流程由你把关：审批全停总裁信箱、情报仅打分入池不自动立项、暂停后台自动派工与静默自愈。",
  },
  {
    mode: "semi_auto",
    title: "半自动协同",
    tag: "磨合期",
    desc: "方向与派工由你拍板（不自动免审/不自动立项/不自动派活），仅保留后台自愈运维守护。",
  },
  {
    mode: "full_auto",
    title: "全自治运行",
    tag: "无人值守",
    desc: "预算内低风险免审放行、高分信号自动立项、临期配额自动派活、运维自愈全开（6 类红线仍强卡人工）。",
  },
];

interface PreferenceRule {
  id: string;
  kind: string;
  pattern: string;
  weight: number;
  mainlineId?: string | null;
  note: string;
  enabled: boolean;
  hitCount: number;
}

interface PreferenceEvent {
  id: string;
  outcome: string;
  title: string;
  note: string;
  createdAt: string;
}

interface StrategyOverview {
  rules: PreferenceRule[];
  recentEvents: PreferenceEvent[];
}

interface EvaluationPreview {
  allowed: boolean;
  blockReason?: string;
  totalScore: number;
  mainlineScore: number;
  habitScore: number;
  clarityScore: number;
  recommendation: string;
  summary: string;
}

export function CompanyHub({
  nav,
  initialTab = "architecture",
}: {
  nav?: ReactNode;
  initialTab?: "story" | "architecture" | "mainlines" | "habits";
}) {
  const [tab, setTab] = useState<"story" | "architecture" | "mainlines" | "habits">(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  const [arch, setArch] = useState<CompanyArchitectureSnapshot | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioTree | null>(null);
  const [strategy, setStrategy] = useState<StrategyOverview | null>(null);
  const [policy, setPolicy] = useState<GovernancePolicy | null>(null);
  const [notice, setNotice] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  // Mainline create state
  const [mlName, setMlName] = useState("");
  const [mlThesis, setMlThesis] = useState("");
  const [mlGoal, setMlGoal] = useState("");
  const [mlWeight, setMlWeight] = useState("85");
  const [mlQuota, setMlQuota] = useState("40");

  // Asset command edit state
  const [editingAsset, setEditingAsset] = useState<AssetRecord | null>(null);

  // Habit rule state
  const [ruleKind, setRuleKind] = useState("prefer_tag");
  const [rulePattern, setRulePattern] = useState("");
  const [ruleWeight, setRuleWeight] = useState("15");
  const [ruleNote, setRuleNote] = useState("");

  // Candidate evaluator preview state
  const [evalTitle, setEvalTitle] = useState("");
  const [evalProject, setEvalProject] = useState("opc-os");
  const [evalDesc, setEvalDesc] = useState("");
  const [evalResult, setEvalResult] = useState<EvaluationPreview | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [archRes, portRes] = await Promise.all([
        request<CompanyArchitectureSnapshot>("/api/opc/kernel/architecture"),
        request<PortfolioTree>("/api/opc/kernel/portfolio"),
      ]);
      setArch(archRes);
      setPolicy(archRes.policy);
      setPortfolio(portRes);
      try {
        const stratRes = await request<StrategyOverview>("/api/opc/domains/strategy/overview");
        setStrategy(stratRes);
      } catch {
        // Strategy domain optional fallback
      }
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "加载公司架构与主线数据失败", err: true });
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const onPolicy = (event: Event) => {
      const detail = (event as CustomEvent<GovernancePolicy>).detail;
      if (detail) setPolicy(detail);
    };
    window.addEventListener("opc:policy-updated", onPolicy);
    return () => window.removeEventListener("opc:policy-updated", onPolicy);
  }, []);

  const toggleFreeze = async (ml: MainlineRecord) => {
    setBusy(true);
    setNotice(null);
    try {
      await request(`/api/opc/kernel/mainlines/${encodeURIComponent(ml.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: ml.name,
          freezeNonMainline: !ml.freezeNonMainline,
        }),
      });
      setNotice({
        text: !ml.freezeNonMainline
          ? `已开启「${ml.name}」主线冻结令：非主线与外围基建将在选题和派工时被内核硬拦截`
          : `已解除「${ml.name}」的非主线冻结限制`,
      });
      await loadAll();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "更新主线失败", err: true });
    } finally {
      setBusy(false);
    }
  };

  const toggleMilestone = async (ml: MainlineRecord, milestoneId: string) => {
    const nextMilestones = ml.milestones.map((m) =>
      m.id === milestoneId ? { ...m, done: !m.done } : m,
    );
    try {
      await request(`/api/opc/kernel/mainlines/${encodeURIComponent(ml.id)}`, {
        method: "PUT",
        body: JSON.stringify({ name: ml.name, milestones: nextMilestones }),
      });
      await loadAll();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "更新里程碑失败", err: true });
    }
  };

  const createMainline = async (e: FormEvent) => {
    e.preventDefault();
    if (!mlName.trim() || busy) return;
    setBusy(true);
    try {
      await request("/api/opc/kernel/mainlines", {
        method: "POST",
        body: JSON.stringify({
          name: mlName.trim(),
          thesis: mlThesis.trim(),
          goal: mlGoal.trim(),
          priorityWeight: Number(mlWeight) || 75,
          quotaSharePct: Number(mlQuota) || 30,
        }),
      });
      setMlName("");
      setMlThesis("");
      setMlGoal("");
      setNotice({ text: "长期主线已创建并纳入全公司准入与配额治理" });
      await loadAll();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "创建主线失败", err: true });
    } finally {
      setBusy(false);
    }
  };

  const saveAssetPipeline = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingAsset || busy) return;
    setBusy(true);
    try {
      await request(`/api/opc/kernel/assets/${encodeURIComponent(editingAsset.id)}`, {
        method: "PUT",
        body: JSON.stringify(editingAsset),
      });
      setEditingAsset(null);
      setNotice({ text: "仓库/服务的验收、构建、部署与回滚契约已保存" });
      await loadAll();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "保存资产配置失败", err: true });
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async (patch: {
    autonomyMode?: AutonomyMode;
    autoApproveLowRisk?: boolean;
    autoApproveMaxCostUsd?: number;
    autoPromoteSignals?: boolean;
    autoHarvestQuota?: boolean;
    autoHealOps?: boolean;
  }) => {
    setBusy(true);
    try {
      const res = await request<{ policy: GovernancePolicy }>("/api/opc/kernel/decisions/policy", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setPolicy(res.policy);
      window.dispatchEvent(new CustomEvent("opc:policy-updated", { detail: res.policy }));
      const modeLabel =
        AUTONOMY_MODES.find((m) => m.mode === res.policy.autonomyMode)?.title ?? res.policy.autonomyMode;
      setNotice({ text: `自治档位与审批策略已更新：当前为「${modeLabel}」` });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "更新自治策略失败", err: true });
    } finally {
      setBusy(false);
    }
  };

  const addHabitRule = async (e: FormEvent) => {
    e.preventDefault();
    if (!rulePattern.trim() || busy) return;
    setBusy(true);
    try {
      await request("/api/opc/domains/strategy/rules", {
        method: "POST",
        body: JSON.stringify({
          kind: ruleKind,
          pattern: rulePattern.trim(),
          weight: Number(ruleWeight) || 10,
          note: ruleNote.trim(),
        }),
      });
      setRulePattern("");
      setRuleNote("");
      setNotice({ text: "个人习惯规则已写入策略库，后续新情报将自动按此加减权" });
      await loadAll();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "新增习惯规则失败", err: true });
    } finally {
      setBusy(false);
    }
  };

  const runPreviewEvaluate = async (e: FormEvent) => {
    e.preventDefault();
    if (!evalTitle.trim()) return;
    try {
      const res = await request<EvaluationPreview>("/api/opc/domains/strategy/evaluate", {
        method: "POST",
        body: JSON.stringify({
          title: evalTitle.trim(),
          projectOrAssetRef: evalProject.trim(),
          description: evalDesc.trim(),
          recordHits: false,
        }),
      });
      setEvalResult(res);
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "习惯评估失败", err: true });
    }
  };

  return (
    <section className="zo-product ch-wrap" aria-label="公司职能架构与长期主线">
      <header className="ch-header">
        <div className="ch-header-left">
          {nav}
          <div>
            <h1>一人公司组织架构与战略总控</h1>
            <p className="ch-sub">1 个微内核宪法底座 + 6 大正交职能部门 · 新增能力按职能直接落位，零全局架构冲击</p>
          </div>
        </div>
        <button type="button" className="ch-btn" onClick={() => void loadAll()}>
          刷新全景
        </button>
      </header>

      {notice && (
        <div role="status" className={notice.err ? "ch-notice err" : "ch-notice"}>
          {notice.text}
        </div>
      )}

      <div className="ch-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "story"}
          className={tab === "story" ? "ch-tab active" : "ch-tab"}
          onClick={() => setTab("story")}
        >
          来龙去脉与运作思路图谱
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "architecture"}
          className={tab === "architecture" ? "ch-tab active" : "ch-tab"}
          onClick={() => setTab("architecture")}
        >
          六大职能部门与扩展落位
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "mainlines"}
          className={tab === "mainlines" ? "ch-tab active" : "ch-tab"}
          onClick={() => setTab("mainlines")}
        >
          长期主线与资产发布契约
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "habits"}
          className={tab === "habits" ? "ch-tab active" : "ch-tab"}
          onClick={() => setTab("habits")}
        >
          创始人习惯记忆与免审策略
        </button>
      </div>

      {arch && (
        <div className="ch-kpis">
          <div className="ch-kpi">
            <span>活跃长期主线</span>
            <strong>
              {arch.counts.activeMainlines} / {arch.counts.mainlines}
            </strong>
          </div>
          <div className="ch-kpi">
            <span>纳管产品 / 仓库资产</span>
            <strong>
              {arch.counts.products} / {arch.counts.assets}
            </strong>
          </div>
          <div className="ch-kpi">
            <span>待我拍板 / 自动免审放行</span>
            <strong>
              {arch.counts.pendingDecisions} / {arch.counts.autoApprovedDecisions}
            </strong>
          </div>
          <div className="ch-kpi">
            <span>领域总线事件流</span>
            <strong>{arch.counts.domainEvents}</strong>
          </div>
        </div>
      )}

      {tab === "story" && <OpcStoryFlow mode="full" />}

      {tab === "architecture" && arch && (
        <div className="ch-dept-grid">
          {arch.departments.map((dept) => (
            <article key={dept.id} className="ch-dept-card" data-testid={`company-dept-${dept.id}`}>
              <div className="ch-dept-top">
                <div>
                  <span className="ch-dept-code">DEPT {dept.code}</span>{" "}
                  <strong>{dept.name}</strong>
                </div>
                <span className={dept.health.healthy ? "ch-badge ok" : "ch-badge warn"}>
                  {dept.health.healthy ? "运行正常" : "需关注"}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: "0.86rem" }}>{dept.mission}</p>
              <div className="ch-owns">
                {dept.owns.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <div className="ch-slot">
                <strong>新能力归位规则：</strong>
                {dept.extensionSlot}
              </div>
              <div className="ch-row">
                <small style={{ color: "var(--muted)" }}>{dept.health.summary}</small>
                <a className="ch-btn primary" href={`#${dept.primaryRoute}`}>
                  进入部门工作台 ↗
                </a>
              </div>
            </article>
          ))}
        </div>
      )}

      {tab === "mainlines" && portfolio && (
        <>
          <div className="ch-panel">
            <h2>长期主线（Mainlines）与硬准入治理</h2>
            {portfolio.mainlines.map((ml) => {
              const doneCount = ml.milestones.filter((m) => m.done).length;
              return (
                <div key={ml.id} className="ch-mainline-card" data-testid={`mainline-${ml.slug}`}>
                  <div className="ch-row">
                    <div>
                      <strong>{ml.name}</strong>{" "}
                      <span className="ch-badge ok">优先级权重 {ml.priorityWeight}</span>{" "}
                      <span className="ch-badge ok">算力配额占比 {ml.quotaSharePct}%</span>
                      {ml.freezeNonMainline && (
                        <span className="ch-badge warn" style={{ marginLeft: 6 }}>
                          已开启非主线冻结铁律
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className={ml.freezeNonMainline ? "ch-btn primary" : "ch-btn"}
                      disabled={busy}
                      onClick={() => void toggleFreeze(ml)}
                    >
                      {ml.freezeNonMainline ? "解除非主线冻结" : "开启冻结非主线与外围基建"}
                    </button>
                  </div>
                  <p style={{ margin: "8px 0 4px", fontSize: "0.86rem" }}>
                    <strong>战略主旨：</strong>
                    {ml.thesis || "—"}
                  </p>
                  <p style={{ margin: "0 0 8px", fontSize: "0.85rem", color: "var(--muted)" }}>
                    <strong>当前目标：</strong>
                    {ml.goal || "—"}
                  </p>

                  {ml.milestones.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <small style={{ fontWeight: 600 }}>
                        关键里程碑 ({doneCount}/{ml.milestones.length})：
                      </small>
                      <div className="ch-owns" style={{ marginTop: 6 }}>
                        {ml.milestones.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className="ch-btn"
                            style={{
                              textDecoration: m.done ? "line-through" : "none",
                              opacity: m.done ? 0.72 : 1,
                            }}
                            onClick={() => void toggleMilestone(ml, m.id)}
                          >
                            {m.done ? "✓ " : "○ "}
                            {m.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {ml.products.length > 0 && (
                    <div className="opc-table-scroll ch-table-scroll" role="region" aria-label={ml.name + " 的资产与交付命令"} tabIndex={0}>
                      <table className="ch-asset-table ch-pipeline-table">
                        <thead>
                          <tr>
                            <th>归属产品</th>
                            <th>仓库 / 服务资产</th>
                            <th>确定性验收命令</th>
                            <th>构建 / 部署命令</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ml.products.flatMap((prod) =>
                            prod.assets.map((asset) => (
                              <tr key={asset.id}>
                                <td>
                                  <strong>{prod.name}</strong> <small>({prod.role})</small>
                                </td>
                                <td>
                                  {asset.name}
                                  {asset.paused && <span className="ch-badge warn">已暂停</span>}
                                </td>
                                <td>
                                  <code>{asset.verifyCommand || "未配置"}</code>
                                </td>
                                <td>
                                  <code>{asset.deployCommand || asset.buildCommand || "仅合入主干"}</code>
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="ch-btn"
                                    onClick={() => setEditingAsset({ ...asset })}
                                  >
                                    配置上线契约
                                  </button>
                                </td>
                              </tr>
                            )),
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {editingAsset && (
            <form className="ch-panel ch-stack" onSubmit={saveAssetPipeline}>
              <h2>配置资产交付与真上线契约：{editingAsset.name}</h2>
              <div className="ch-form-grid">
                <label>
                  本地仓库路径 (localRepoPath)
                  <input
                    value={editingAsset.localRepoPath}
                    onChange={(e) => setEditingAsset({ ...editingAsset, localRepoPath: e.target.value })}
                    placeholder="/Users/.../repo"
                  />
                </label>
                <label>
                  外部确定性验收命令 (verifyCommand)
                  <input
                    value={editingAsset.verifyCommand}
                    onChange={(e) => setEditingAsset({ ...editingAsset, verifyCommand: e.target.value })}
                    placeholder="npm test && npm run typecheck"
                  />
                </label>
                <label>
                  发布构建命令 (buildCommand)
                  <input
                    value={editingAsset.buildCommand}
                    onChange={(e) => setEditingAsset({ ...editingAsset, buildCommand: e.target.value })}
                    placeholder="npm run build"
                  />
                </label>
                <label>
                  上线部署命令 (deployCommand)
                  <input
                    value={editingAsset.deployCommand}
                    onChange={(e) => setEditingAsset({ ...editingAsset, deployCommand: e.target.value })}
                    placeholder="launchctl kickstart -k ... 或部署脚本"
                  />
                </label>
                <label>
                  失败回滚命令 (rollbackCommand)
                  <input
                    value={editingAsset.rollbackCommand}
                    onChange={(e) => setEditingAsset({ ...editingAsset, rollbackCommand: e.target.value })}
                    placeholder="自动 git reset 外附加的重启命令"
                  />
                </label>
                <label>
                  上线后健康探针 URL (healthUrl)
                  <input
                    value={editingAsset.healthUrl}
                    onChange={(e) => setEditingAsset({ ...editingAsset, healthUrl: e.target.value })}
                    placeholder="http://127.0.0.1:8791/api/health"
                  />
                </label>
              </div>
              <div className="ch-row">
                <button type="submit" className="ch-btn primary" disabled={busy}>
                  保存上线契约
                </button>
                <button type="button" className="ch-btn" onClick={() => setEditingAsset(null)}>
                  取消
                </button>
              </div>
            </form>
          )}

          <form className="ch-panel" onSubmit={createMainline}>
            <h2>新增公司长期主线</h2>
            <div className="ch-form-grid">
              <label>
                主线名称
                <input
                  value={mlName}
                  onChange={(e) => setMlName(e.target.value)}
                  placeholder="例如：跨境自动化工具主线"
                  required
                />
              </label>
              <label>
                优先级权重 (1-100)
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={mlWeight}
                  onChange={(e) => setMlWeight(e.target.value)}
                />
              </label>
              <label>
                算力配额占比 (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={mlQuota}
                  onChange={(e) => setMlQuota(e.target.value)}
                />
              </label>
              <label>
                战略主旨 (Thesis)
                <input
                  value={mlThesis}
                  onChange={(e) => setMlThesis(e.target.value)}
                  placeholder="为什么做、核心壁垒是什么"
                />
              </label>
              <label>
                阶段目标 (Goal)
                <input
                  value={mlGoal}
                  onChange={(e) => setMlGoal(e.target.value)}
                  placeholder="本阶段可量化结果"
                />
              </label>
            </div>
            <button type="submit" className="ch-btn primary" disabled={busy}>
              添加长期主线
            </button>
          </form>
        </>
      )}

      {tab === "habits" && (
        <>
          {policy && (
            <div className="ch-panel" data-testid="autonomy-mode-panel">
              <div className="ch-row" style={{ marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>全站自治档位总开关（人工协助 / 半自动 / 全自治）</h2>
                <span className="ch-badge ok">
                  当前：{AUTONOMY_MODES.find((m) => m.mode === policy.autonomyMode)?.title ?? policy.autonomyMode}
                </span>
              </div>
              <div className="ch-mode-grid" role="group" aria-label="自治档位预设">
                {AUTONOMY_MODES.map((item) => (
                  <button
                    key={item.mode}
                    type="button"
                    className={policy.autonomyMode === item.mode ? "ch-mode-card active" : "ch-mode-card"}
                    aria-pressed={policy.autonomyMode === item.mode}
                    disabled={busy}
                    onClick={() => void savePolicy({ autonomyMode: item.mode })}
                  >
                    <strong>
                      <span>{item.title}</span>
                      <span className="ch-badge ok">{item.tag}</span>
                    </strong>
                    <small>{item.desc}</small>
                  </button>
                ))}
              </div>

              <div className="ch-policy-checks">
                <label className="ch-policy-check">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={policy.autoApproveLowRisk}
                    onChange={(e) => void savePolicy({ autoApproveLowRisk: e.target.checked })}
                  />
                  <span>
                    <strong>低风险免审自动放行</strong>：预算上限内且非红线事项由策略引擎自动批准
                  </span>
                </label>
                <label className="ch-policy-check">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={policy.autoPromoteSignals}
                    onChange={(e) => void savePolicy({ autoPromoteSignals: e.target.checked })}
                  />
                  <span>
                    <strong>高分信号自动立项</strong>：关闭后所有情报先留在「02 · 情报信号池」等你人工挑活
                  </span>
                </label>
                <label className="ch-policy-check">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={policy.autoHarvestQuota}
                    onChange={(e) => void savePolicy({ autoHarvestQuota: e.target.checked })}
                  />
                  <span>
                    <strong>临期配额后台自动派工</strong>：关闭后定时任务不静默派活（仍可去 04 部手动试算/派发）
                  </span>
                </label>
                <label className="ch-policy-check">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={policy.autoHealOps}
                    onChange={(e) => void savePolicy({ autoHealOps: e.target.checked })}
                  />
                  <span>
                    <strong>后台自愈守护自动拉起</strong>：关闭后每 5 分钟仅巡检记录，不静默重启伴生服务
                  </span>
                </label>
              </div>

              <div className="ch-row" style={{ marginTop: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.84rem" }}>
                  单次免审预算上限 (USD):
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    style={{ width: 84, padding: "4px 8px" }}
                    value={policy.autoApproveMaxCostUsd}
                    onChange={(e) =>
                      void savePolicy({ autoApproveMaxCostUsd: Number(e.target.value) || 0 })
                    }
                  />
                </label>
                <small style={{ color: "var(--muted)" }}>
                  强制人工拍板红线：{policy.redlineKinds.join(" · ")}
                </small>
              </div>
            </div>
          )}

          <div className="ch-panel">
            <h2>创始人习惯与决策偏好规则库（自动从历史拍板学习 + 手工校准）</h2>
            {strategy?.rules.length ? (
              <div className="opc-table-scroll ch-table-scroll" role="region" aria-label="创始人决策偏好规则" tabIndex={0}>
                <table className="ch-asset-table">
                  <thead>
                    <tr>
                      <th>规则类型</th>
                      <th>匹配词 / 标签</th>
                      <th>加减权分值</th>
                      <th>命中次数</th>
                      <th>备注说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strategy.rules.map((r) => (
                      <tr key={r.id}>
                        <td>{r.kind}</td>
                        <td>
                          <code>{r.pattern}</code>
                        </td>
                        <td>
                          <strong style={{ color: r.weight >= 0 ? "#1d6b43" : "#99231b" }}>
                            {r.weight >= 0 ? `+${r.weight}` : r.weight}
                          </strong>
                        </td>
                        <td>{r.hitCount}</td>
                        <td>{r.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--muted)" }}>暂无偏好规则。</p>
            )}

            <form onSubmit={addHabitRule} style={{ marginTop: 14 }}>
              <div className="ch-form-grid">
                <label>
                  偏好类型
                  <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value)}>
                    <option value="prefer_tag">偏好方向 / 关键词加权 (prefer_tag)</option>
                    <option value="avoid_keyword">反感噪音 / 关键词降权 (avoid_keyword)</option>
                    <option value="scope_rule">范围约束规则 (scope_rule)</option>
                  </select>
                </label>
                <label>
                  匹配关键词 / 标签
                  <input
                    value={rulePattern}
                    onChange={(e) => setRulePattern(e.target.value)}
                    placeholder="例如：离线优先 / 自动化测试 / 造轮子基建"
                    required
                  />
                </label>
                <label>
                  分值权重 (-40 ~ +35)
                  <input
                    type="number"
                    min={-40}
                    max={35}
                    value={ruleWeight}
                    onChange={(e) => setRuleWeight(e.target.value)}
                  />
                </label>
                <label>
                  原因说明
                  <input
                    value={ruleNote}
                    onChange={(e) => setRuleNote(e.target.value)}
                    placeholder="为什么偏好或排斥此类内容"
                  />
                </label>
              </div>
              <button type="submit" className="ch-btn primary" disabled={busy}>
                新增个人习惯规则
              </button>
            </form>
          </div>

          <form className="ch-panel ch-stack" onSubmit={runPreviewEvaluate}>
            <h2>新内容主线对齐与个人习惯试算器</h2>
            <div className="ch-form-grid">
              <label>
                候选想法 / 特性标题
                <input
                  value={evalTitle}
                  onChange={(e) => setEvalTitle(e.target.value)}
                  placeholder="输入一个新点子，看系统如何按你的主线和习惯决策"
                  required
                />
              </label>
              <label>
                目标产品 / 仓库
                <input
                  value={evalProject}
                  onChange={(e) => setEvalProject(e.target.value)}
                  placeholder="PageLens 或 opc-os"
                />
              </label>
            </div>
            <label>
              补充描述与验收方案
              <textarea
                rows={2}
                value={evalDesc}
                onChange={(e) => setEvalDesc(e.target.value)}
                placeholder="包含具体指标或测试命令会获得更高清晰度评分"
              />
            </label>
            <div style={{ marginTop: 10 }}>
              <button type="submit" className="ch-btn primary">
                执行习惯对齐评估
              </button>
            </div>
            {evalResult && (
              <div className={evalResult.allowed ? "ch-notice" : "ch-notice err"} style={{ marginTop: 12 }}>
                <strong>
                  综合得分：{evalResult.totalScore} / 100 · 决策建议：{evalResult.recommendation}
                </strong>
                <div>
                  主线分 {evalResult.mainlineScore} · 习惯偏好分 {evalResult.habitScore} · 清晰度{" "}
                  {evalResult.clarityScore}
                </div>
                <div>{evalResult.blockReason || evalResult.summary}</div>
              </div>
            )}
          </form>
        </>
      )}
    </section>
  );
}
