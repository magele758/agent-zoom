import { DelegateWork } from "./Delegation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActivityIndex, IndexedAgent, IndexedRepo, IndexSource } from "../../src/activity-index-types";
import { request } from "./api";
import { RepositoryIndexContent } from "./RepositoryIndexContent";
import "./activity-index.css";

const endpoint = "/api/opc/activity-index";
const stateNames = { working: "执行中", waiting: "等待中", idle: "空闲", recent: "近期活动", unknown: "状态未知" };
const stateOrder = { working: 0, waiting: 1, unknown: 2, idle: 3, recent: 4 };
const visibilityNames = { public: "公开", private: "私有", internal: "组织内部", unknown: "" };
const sourceNames = { ok: "已读取", partial: "部分可读", unavailable: "暂时不可用", refreshing: "正在更新" };
const stamp = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const pageSize = 40;
const failure = (error: unknown) => (error instanceof Error ? error.message : "无法读取索引");
const basename = (s: string) => s.split(/[\\/]/).filter(Boolean).at(-1) || s;
const repoKey = (s: string) => (s.startsWith("/") ? s : s.toLowerCase());
const displayRepo = (s: string) => (s.startsWith("/") ? basename(s) : s);
export const activityLink = (view: "agents" | "repos", filter: Record<string, string> = {}) =>
  "#activity-index?" + new URLSearchParams({ view, ...filter });

const ACTIVITY_CACHE_KEY = "opc_activity_index_v1";
function readCachedActivity(): ActivityIndex | null {
  try {
    const raw = sessionStorage.getItem(ACTIVITY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActivityIndex;
    return Array.isArray(parsed?.agents) && Array.isArray(parsed?.repositories) ? parsed : null;
  } catch {
    return null;
  }
}

export function useActivityIndex(enabled: boolean) {
  const [data, setData] = useState<ActivityIndex | null>(() => readCachedActivity());
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(async (force = false) => {
    if (active.current && !force) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    if (force) setRefreshing(true);
    try {
      const result = await request<ActivityIndex>(endpoint + (force ? "/refresh" : ""), {
        method: force ? "POST" : "GET",
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setData(result);
        setError("");
        try { sessionStorage.setItem(ACTIVITY_CACHE_KEY, JSON.stringify(result)); } catch { /* ignore quota */ }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(failure(cause));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    setRefreshing(false);
    const update = () => {
      if (!document.hidden) void load();
    };
    void load();
    const timer = window.setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      active.current?.abort();
      active.current = null;
    };
  }, [enabled, load]);
  return { data, error, refreshing, load };
}
type IndexState = ReturnType<typeof useActivityIndex>;

function Updated({ date }: { date: string | null }) {
  const value = date ? new Date(date) : null;
  return date && value && Number.isFinite(value.getTime()) ? (
    <time dateTime={date} title={date}>
      {stamp.format(value)}
    </time>
  ) : (
    <>时间未知</>
  );
}
function AgentState({ state }: { state: IndexedAgent["state"] }) {
  return (
    <span className="idx-state" data-state={state}>
      {stateNames[state]}
    </span>
  );
}
function SourceNotes({ sources }: { sources: IndexSource[] }) {
  const warnings = sources.filter((s) => s.status === "partial" || s.status === "unavailable").length;
  return (
    <details className="idx-sources">
      <summary>索引来源与采集时间{warnings > 0 && <span> · {warnings} 个来源读取受限</span>}</summary>
      {sources.map((s) => (
        <div key={s.name}>
          <strong>{s.name}</strong>
          <span>
            {sourceNames[s.status]} · <Updated date={s.asOf} />
          </span>
          <p>{s.detail}</p>
        </div>
      ))}
    </details>
  );
}
function LoadingOrError({ index }: { index: IndexState }) {
  if (index.error)
    return (
      <p role="alert" className="idx-warning">
        索引读取失败。{index.error}{" "}
        <button type="button" onClick={() => void index.load()}>
          重试
        </button>
      </p>
    );
  if (!index.data)
    return (
      <p role="status" className="idx-muted">
        正在读取会话与仓库…
      </p>
    );
  return null;
}

export function ActivitySummary({ index }: { index: IndexState }) {
  const { data } = index;
  const working = data?.agents.filter((a) => a.state === "working") ?? [];
  const waiting = data?.agents.filter((a) => a.state === "waiting") ?? [];
  const active = [...working, ...waiting];
  const preview = (active.length ? active : data?.agents ?? []).slice(0, 3);
  return (
    <section className="overview-index" aria-label="正在工作的 agent 与仓库索引">
      <header>
        <h2>工作现场</h2>
        <a href={activityLink("agents")}>打开完整索引 ↗</a>
      </header>
      <LoadingOrError index={index} />
      {data && (
        <>
          <div className="idx-overview-totals">
            <a href={activityLink("agents", { state: "working" })}>
              <strong>{working.length}</strong>执行中
            </a>
            <a href={activityLink("agents", { state: "waiting" })}>
              <strong>{waiting.length}</strong>等待中
            </a>
            <a href={activityLink("agents")}>
              <strong>{data.agents.length}</strong>会话及进程
            </a>
            <a href={activityLink("repos")}>
              <strong>{data.repositories.length}</strong>个仓库
            </a>
          </div>
          {preview.length > 0 && (
            <ul aria-label={active.length ? "正在执行或等待的会话" : "已发现的会话与进程"}>
              {preview.map((agent) => (
                <li key={agent.id}>
                  <a href={activityLink("agents", { agent: agent.id })}>
                    <AgentState state={agent.state} />
                    <span>
                      <b>{agent.provider}</b> · {agent.label}
                    </span>
                    <small>
                      {agent.repository
                        ? displayRepo(agent.repository)
                        : agent.workspace
                          ? basename(agent.workspace)
                          : agent.sources.join(" / ")}{" "}
                      ↗
                    </small>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <SourceNotes sources={data.sources} />
        </>
      )}
    </section>
  );
}

function ManagedProjects({ repo }: { repo: IndexedRepo }) {
  return repo.managed.length ? (
    <>
      {repo.managed.map(({ product, project }) => (
        <a
          key={product + "/" + project}
          className="idx-manage"
          href={"#projects?" + new URLSearchParams({ product, project })}
        >
          {product} / {project} ↗
        </a>
      ))}
    </>
  ) : (
    <>已索引 · 未纳管</>
  );
}
function AgentRow({
  agent,
  repo,
  selected,
}: {
  agent: IndexedAgent;
  repo: IndexedRepo | undefined;
  selected: boolean;
}) {
  return (
    <li className="idx-agentrow" data-selected={selected || undefined}>
      <AgentState state={agent.state} />
      <div className="idx-col">
        <a href={activityLink("agents", { agent: agent.id })}>
          <strong>{agent.label || agent.provider}</strong>
        </a>
        <span>
          {agent.provider} · {agent.sources.join(" / ")}
        </span>
      </div>
      <div className="idx-col">
        {repo ? (
          <a href={activityLink("repos", { repo: repo.fullName })}>{displayRepo(repo.fullName)} ↗</a>
        ) : agent.repository ? (
          <span>{displayRepo(agent.repository)}</span>
        ) : (
          <span>仓库未识别</span>
        )}
        {agent.workspace && <code>{agent.workspace}</code>}
        {repo && repo.managed.length > 0 && (
          <small>
            <ManagedProjects repo={repo} />
          </small>
        )}
      </div>
      <small>
        <Updated date={agent.updatedAt} />
      </small>
      {selected && (
        <DelegateWork
          key={agent.id}
          label="委派核对这次工作的进展"
          operation={{
            key: "agent:" + agent.id,
            title: "核对进展 · " + (agent.label || agent.provider),
            href: activityLink("agents", { agent: agent.id }),
            detail: [agent.id, agent.provider, agent.workspace, agent.repository, ...agent.sources]
              .filter(Boolean)
              .join("\n"),
          }}
        />
      )}
    </li>
  );
}
function RepoRow({ repo, agents }: { repo: IndexedRepo; agents: number }) {
  return (
    <li className="idx-reporow">
      <div className="idx-col">
        <a className="idx-repo-name" href={activityLink("repos", { repo: repo.fullName })}>
          {displayRepo(repo.fullName)} ↗
        </a>
        <span>
          {[repo.language, visibilityNames[repo.visibility], ...repo.relations.filter((r) => r !== "已纳管")]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {repo.description && <p>{repo.description}</p>}
      </div>
      <div className="idx-col idx-attribution">
        <ManagedProjects repo={repo} />
        {repo.paths.length > 0 && <small>{repo.paths.length} 个本地目录</small>}
        {agents > 0 && <a href={activityLink("agents", { repo: repo.fullName })}>{agents} 个关联会话或进程 ↗</a>}
      </div>
    </li>
  );
}

export function ActivityPage({
  index,
  nav,
  params,
}: {
  index: IndexState;
  nav: ReactNode;
  params: URLSearchParams;
}) {
  const view = params.get("view") === "repos" ? "repos" : "agents";
  const repo = params.get("repo") ?? "",
    id = params.get("agent") ?? "";
  const stateParam = params.get("state");
  const state = stateParam && Object.hasOwn(stateNames, stateParam) ? stateParam : "";
  const [agentQuery, setAgentQuery] = useState(""),
    [repoQuery, setRepoQuery] = useState("");
  const [relation, setRelation] = useState("");
  const [page, setPage] = useState(0);
  const query = view === "repos" ? repoQuery : agentQuery;
  const term = query.trim().toLowerCase();
  const repositoryByName = useMemo(
    () => new Map(index.data?.repositories.map((r) => [repoKey(r.fullName), r])),
    [index.data],
  );
  const matchingRepo = repositoryByName.get(repoKey(repo));
  const rows = useMemo(() => {
    const rows = (index.data?.agents ?? []).filter(
      (a) =>
        (!id || a.id === id) &&
        (!repo || repoKey(a.repository ?? "") === repoKey(repo)) &&
        (!state || a.state === state),
    );
    return rows
      .filter((a) =>
        [a.label, a.provider, a.repository, a.workspace, ...a.sources, stateNames[a.state]].some((v) =>
          v?.toLowerCase().includes(term),
        ),
      )
      .sort(
        (a, b) =>
          stateOrder[a.state] - stateOrder[b.state] ||
          (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
          a.id.localeCompare(b.id),
      );
  }, [index.data, id, repo, state, term]);
  const repos = useMemo(
    () =>
      (index.data?.repositories ?? []).filter(
        (r) =>
          (!relation || r.relations.includes(relation)) &&
          [
            r.fullName,
            r.description,
            r.language,
            ...r.paths,
            ...r.relations,
            ...r.managed.map((p) => p.product + "/" + p.project),
          ].some((v) => v?.toLowerCase().includes(term)),
      ),
    [index.data, relation, term],
  );
  const agentsByRepo = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of index.data?.agents ?? [])
      if (agent.repository) {
        const name = repoKey(agent.repository);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    return counts;
  }, [index.data]);
  const relations = [...new Set(index.data?.repositories.flatMap((r) => r.relations))];
  const total = view === "repos" ? repos.length : rows.length;
  const pages = Math.ceil(total / pageSize);
  const position = Math.min(page, Math.max(0, pages - 1));
  const start = pageSize * position;
  useEffect(() => {
    setPage(0);
  }, [view, state, repo, id, term, relation]);
  useEffect(() => {
    setAgentQuery("");
  }, [id, repo]);
  return (
    <section className="zo-product idx-page" aria-label="会话与仓库索引">
      <header className="idx-heading">
        {nav}
        <h1>会话与仓库索引</h1>
        <button type="button" disabled={index.refreshing} onClick={() => void index.load(true)}>
          {index.refreshing ? "正在刷新…" : "刷新来源"}
        </button>
      </header>
      <nav className="idx-tabs" aria-label="索引视图">
        <a href={activityLink("agents")} aria-current={view === "agents" ? "page" : undefined}>
          Coding agent <b>{index.data?.agents.length ?? "—"}</b>
        </a>
        <a href={activityLink("repos")} aria-current={view === "repos" ? "page" : undefined}>
          仓库 <b>{index.data?.repositories.length ?? "—"}</b>
        </a>
      </nav>
      <LoadingOrError index={index} />
      {index.data && (
        <>
          <p className="idx-timing">
            会话每 15 秒刷新。仓库目录每 15 分钟刷新。纳管项目可从仓库进入公司项目档案。
          </p>
          {view === "repos" && repo ? (
            <>
              <a className="idx-return" href={activityLink("repos")}>
                ‹ 返回仓库索引
              </a>
              {matchingRepo ? (
                <div className="idx-repodetail">
                  <h2>{displayRepo(matchingRepo.fullName)}</h2>
                  <p>
                    {[visibilityNames[matchingRepo.visibility], ...matchingRepo.relations, matchingRepo.language]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {matchingRepo.description && <p>{matchingRepo.description}</p>}
                  <p>
                    <ManagedProjects repo={matchingRepo} />
                  </p>
                  {!!matchingRepo.paths.length && (
                    <details className="idx-paths">
                      <summary>本地目录 · {matchingRepo.paths.length}</summary>
                      {matchingRepo.paths.map((p) => (
                        <code key={p}>{p}</code>
                      ))}
                    </details>
                  )}
                  {!!agentsByRepo.get(repoKey(repo)) && (
                    <a href={activityLink("agents", { repo })}>
                      查看关联的 {agentsByRepo.get(repoKey(repo))} 个会话或进程 ↗
                    </a>
                  )}
                  <DelegateWork
                    key={matchingRepo.fullName}
                    label="委派检查仓库"
                    operation={{
                      key: "repository:" + matchingRepo.fullName,
                      title: "检查仓库 · " + displayRepo(matchingRepo.fullName),
                      href: activityLink("repos", { repo: matchingRepo.fullName }),
                      detail: [matchingRepo.fullName, matchingRepo.description, ...matchingRepo.paths]
                        .filter(Boolean)
                        .join("\n"),
                    }}
                  />
                  <RepositoryIndexContent key={matchingRepo.fullName} repo={matchingRepo} />
                </div>
              ) : (
                <p>当前索引中没有这个仓库。</p>
              )}
            </>
          ) : (
            <>
              {view === "agents" && (repo || id) && (
                <p className="idx-scope">
                  {repo ? "仓库 · " + displayRepo(repo) : "指定会话或进程"}　
                  <a href={activityLink("agents")}>查看所有会话 ↗</a>
                </p>
              )}
              <div className="idx-search">
                <label>
                  {view === "repos" ? "查找仓库" : "查找会话"}
                  <input
                    type="search"
                    value={query}
                    onChange={(event) =>
                      view === "repos" ? setRepoQuery(event.target.value) : setAgentQuery(event.target.value)
                    }
                    placeholder={view === "repos" ? "仓库名称、路径、领域或项目" : "agent、工作目录、仓库或来源"}
                  />
                </label>
                {view === "repos" ? (
                  <label>
                    仓库归属
                    <select value={relation} onChange={(event) => setRelation(event.target.value)}>
                      <option value="">全部关系</option>
                      {relations.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    工作状态
                    <select
                      value={state}
                      onChange={(event) => {
                        const p: Record<string, string> = {};
                        if (repo) p.repo = repo;
                        if (id) p.agent = id;
                        if (event.target.value) p.state = event.target.value;
                        location.hash = activityLink("agents", p);
                      }}
                    >
                      <option value="">全部状态</option>
                      {Object.entries(stateNames).map(([v, text]) => (
                        <option key={v} value={v}>
                          {text}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <p className="idx-count">
                {total} {view === "repos" ? "个仓库" : "个会话及进程"}
                {pages > 1 && " · 当前 " + (start + 1) + "–" + Math.min(start + pageSize, total)}
              </p>
              {total === 0 ? (
                <p>当前筛选下没有记录。</p>
              ) : view === "repos" ? (
                <ul className="idx-results" aria-label="仓库列表">
                  {repos.slice(start, start + pageSize).map((r) => (
                    <RepoRow key={r.fullName} repo={r} agents={agentsByRepo.get(repoKey(r.fullName)) ?? 0} />
                  ))}
                </ul>
              ) : (
                <ul className="idx-results" aria-label="会话列表">
                  {rows.slice(start, start + pageSize).map((a) => (
                    <AgentRow
                      key={a.id}
                      agent={a}
                      selected={a.id === id}
                      repo={a.repository ? repositoryByName.get(repoKey(a.repository)) : undefined}
                    />
                  ))}
                </ul>
              )}
              {pages > 1 && (
                <nav className="idx-pager" aria-label="索引分页">
                  <button type="button" disabled={position === 0} onClick={() => setPage(position - 1)}>
                    上一页
                  </button>
                  <span>
                    {position + 1} / {pages}
                  </span>
                  <button type="button" disabled={position + 1 >= pages} onClick={() => setPage(position + 1)}>
                    下一页
                  </button>
                </nav>
              )}
            </>
          )}
          <SourceNotes sources={index.data.sources} />
        </>
      )}
    </section>
  );
}
