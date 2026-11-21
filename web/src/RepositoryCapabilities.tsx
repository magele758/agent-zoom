import { MessageDelegate } from "./Delegation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CapabilityIndex as RepoCapabilityIndex } from "../../src/repo-capabilities-types";
import { request } from "./api";
import { chatRoomLink } from "./zoom-routes";
import "./repository-capabilities.css";

type Project = RepoCapabilityIndex["projects"][number];
type Capability = RepoCapabilityIndex["capabilities"][number];
type Adoption = RepoCapabilityIndex["requests"][number];
const base = "/api/opc/capabilities";
const statusName = {
  reused: "已记录复用",
  pending: "待你审批",
  changes: "要求修改",
  rejected: "已拒绝",
  approved: "已交维护项目",
};
const path = (p: Record<string, string> = {}) =>
  "#capabilities" + (Object.keys(p).length ? "?" + new URLSearchParams(p) : "");
const param = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const post = <T,>(endpoint: string, input: unknown) =>
  request<T>(base + endpoint, { method: "POST", body: JSON.stringify(input) });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "请求失败");
const projectPath = (p: { product: string; project: string }) => p.product + "/" + p.project;
const profile = (p: { product: string; project: string }) =>
  "#projects?" + new URLSearchParams({ product: p.product, project: p.project });
const repoUrl = (repo: string) => "https://github.com/" + repo.split("/").map(encodeURIComponent).join("/");
function Reference({ text }: { text: string }) {
  return /^https?:\/\//i.test(text) ? (
    <a href={text} rel="noreferrer" target="_blank">
      {text} ↗
    </a>
  ) : (
    <code>{text}</code>
  );
}
function ProjectSelect({
  projects,
  initial,
  label = "使用方项目",
}: {
  projects: Project[];
  initial: string;
  label?: string;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        name="consumer"
        defaultValue={projects.some((p) => projectPath(p) === initial) ? initial : ""}
        required
      >
        <option value="">选择产品下的项目</option>
        {projects.map((p) => (
          <option key={projectPath(p)} value={projectPath(p)}>
            {p.product} / {p.project}
          </option>
        ))}
      </select>
    </label>
  );
}
function RegisterVersion({
  projects,
  onSaved,
  cancel,
}: {
  projects: Project[];
  onSaved: (item: Capability) => void;
  cancel: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const owners = projects.flatMap((p) => p.repos.map((repo) => ({ owner: p, repo })));
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget),
      match = owners.find(
        (o) => JSON.stringify([o.owner.product, o.owner.project, o.repo]) === param(data, "owner"),
      );
    if (!match) return;
    setBusy(true);
    setError("");
    try {
      onSaved(
        await post<Capability>("", {
          product: match.owner.product,
          project: match.owner.project,
          repo: match.repo,
          name: param(data, "name"),
          version: param(data, "version"),
          interfaceRef: param(data, "interfaceRef"),
          evidence: param(data, "evidence"),
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="rc-form" aria-label="登记能力版本" onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>登记能力版本</legend>
        {!owners.length ? (
          <p>
            请先在<a href="#projects">项目目录</a>为维护项目关联公开仓库，再登记它提供的能力。
          </p>
        ) : (
          <>
            <label>
              维护项目与仓库
              <select name="owner" required defaultValue="">
                <option value="">选择项目及其仓库</option>
                {owners.map(({ owner, repo }) => {
                  const id = JSON.stringify([owner.product, owner.project, repo]);
                  return (
                    <option key={id} value={id}>
                      {projectPath(owner)} · {repo}
                    </option>
                  );
                })}
              </select>
            </label>
            <div className="rc-pair">
              <label>
                能力名称
                <input name="name" required maxLength={140} placeholder="例如，商品草稿检查" />
              </label>
              <label>
                固定版本
                <input name="version" required maxLength={120} placeholder="发布标签或提交号" />
              </label>
            </div>
            <label>
              调用入口
              <input
                name="interfaceRef"
                required
                maxLength={420}
                placeholder="CLI 命令、公开接口或使用文档"
              />
            </label>
            <label>
              版本凭据
              <input
                name="evidence"
                type="url"
                maxLength={1200}
                required
                placeholder="该仓库中的发布或提交链接"
              />
            </label>
            <button className="rc-primary" type="submit">
              保存版本
            </button>
          </>
        )}
        <button type="button" onClick={cancel}>
          取消
        </button>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}

const impactPrefix = "影响范围\n";
const acceptancePrefix = "\n\n验收办法\n";
function splitGap(detail: string) {
  const parts = detail.indexOf(acceptancePrefix);
  if (!detail.startsWith(impactPrefix) || parts < 0) return { impact: detail, acceptance: "" };
  return {
    impact: detail.slice(impactPrefix.length, parts),
    acceptance: detail.slice(parts + acceptancePrefix.length),
  };
}
function RequestForm({
  cap,
  projects,
  consumer,
  mode,
  previous,
  approvedGaps = [],
  onSaved,
  cancel,
}: {
  cap: Capability;
  projects: Project[];
  consumer: string;
  mode: "reuse" | "gap";
  previous?: Adoption;
  approvedGaps?: Adoption[];
  onSaved: (r: Adoption) => void;
  cancel: () => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [satisfies, setSatisfies] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false);
  const prior = splitGap(previous?.detail ?? "");
  const sourceOpportunityId =
    new URLSearchParams(location.hash.split("?")[1]).get("opportunity") || undefined;
  const eligible = sourceOpportunityId
    ? projects.filter((p) => projectPath(p) === consumer || p.repos.includes(consumer))
    : projects;
  const suggested =
    eligible.find((p) => projectPath(p) === consumer) ??
    (eligible.length === 1 && sourceOpportunityId ? eligible[0] : undefined);
  const gap = mode === "gap";
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (sending.current) return;
    const d = new FormData(e.currentTarget);
    const owner = previous ?? projects.find((p) => projectPath(p) === param(d, "consumer"));
    if (!owner) return;
    const title = param(d, "title");
    const detail = gap
      ? impactPrefix + param(d, "impact") + acceptancePrefix + param(d, "acceptance")
      : param(d, "purpose");
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = previous
        ? await post<Adoption>(
            "/requests/" + encodeURIComponent(previous.id) + (gap ? "/revisions" : "/adopt"),
            {
              baseRevision: previous.revision,
              title,
              detail,
            },
          )
        : await post<Adoption>("/requests", {
            requestId,
            product: owner.product,
            project: owner.project,
            capabilityId: cap.id,
            mode,
            title,
            detail,
            sourceOpportunityId,
            ...(!gap &&
              satisfies && { satisfiesRequestId: satisfies, deliveryEvidence: param(d, "deliveryEvidence") }),
          });
      onSaved(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <form className="rc-form" aria-label={gap ? "补充需求" : "直接复用"} onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>
          {previous ? (gap ? "修订需求" : "改用现有版本") : gap ? "向维护方提出需求" : "直接复用这个版本"}
        </legend>
        {previous ? (
          <p>使用方　{projectPath(previous)}</p>
        ) : (
          <ProjectSelect projects={eligible} initial={suggested ? projectPath(suggested) : consumer} />
        )}
        <p>
          {gap ? "目标维护仓库" : "引用来源"}　<strong>{cap.repo}</strong> · {cap.name} {cap.version}
        </p>
        <label>
          {gap ? "还缺什么能力" : "这次用在什么地方"}
          <input
            name="title"
            required
            maxLength={180}
            defaultValue={gap ? previous?.title : undefined}
            placeholder={gap ? "现有接口还不能完成哪一步？" : "例如，在导入草稿时检查字段"}
          />
        </label>
        {!gap && approvedGaps.length > 0 && (
          <fieldset className="rc-resolution">
            <legend>核对原仓缺口</legend>
            {approvedGaps.length === 1 ? (
              <label>
                <input
                  type="checkbox"
                  checked={satisfies === approvedGaps[0].id}
                  onChange={(e) => setSatisfies(e.target.checked ? approvedGaps[0].id : "")}
                />
                此版本解决了「{approvedGaps[0].title}」· r{approvedGaps[0].revision}
              </label>
            ) : (
              <label>
                此版本解决的已批需求
                <select value={satisfies} onChange={(e) => setSatisfies(e.target.value)}>
                  <option value="">仅登记该版本的独立用途</option>
                  {approvedGaps.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title} · r{r.revision}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {satisfies && (
              <label>
                该固定版本的交付凭据
                <input
                  type="url"
                  name="deliveryEvidence"
                  defaultValue={cap.evidence}
                  required
                  maxLength={1200}
                />
              </label>
            )}
            <p>确认覆盖后，在使用说明中写明已验证的验收场景。可引用该版本的发布记录或更具体的原仓测试。</p>
          </fieldset>
        )}
        {gap ? (
          <>
            <label>
              影响范围
              <textarea
                name="impact"
                required
                rows={2}
                defaultValue={prior.impact}
                placeholder="哪些用户、项目或现有行为会受影响？"
              />
            </label>
            <label>
              验收办法
              <textarea
                name="acceptance"
                required
                rows={2}
                defaultValue={prior.acceptance}
                placeholder="维护方怎样证明需求已经满足？"
              />
            </label>
          </>
        ) : (
          <label>
            使用说明
            <textarea
              name="purpose"
              required
              maxLength={3000}
              rows={2}
              placeholder={
                previous
                  ? "记录怎样使用已有接口、仍有哪些限制，以及如何验收"
                  : "记录接入位置、使用场景或已验证的调用方式"
              }
            />
          </label>
        )}
        <p>
          {gap
            ? "提交后可在本页直接审批，同时提醒已绑定的 Agent Home 群聊。批准后需求进入维护项目的研发候选，工程计划单独确认。"
            : previous
              ? "保存后消费方按当前接口集成。原需求、审批反馈和本次采用将保存在同一条记录。"
              : "保存后可按版本追溯这次采用。跨项目复用也会写入消费项目档案。"}
        </p>
        <button className="rc-primary" type="submit">
          {gap ? "提交维护需求审批" : "记录版本复用"}
        </button>
        <button type="button" onClick={cancel}>
          取消
        </button>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}

function RequestDetail({
  record,
  cap,
  projects,
  records,
  onSaved,
}: {
  record: Adoption;
  cap: Capability;
  projects: Project[];
  records: Adoption[];
  onSaved: (r: Adoption) => void;
}) {
  const [editing, setEditing] = useState<"gap" | "reuse" | null>(null);
  const resolutions = records.filter((r) => r.satisfiesRequestId === record.id);
  const gapToConfirm =
    record.status === "reused" &&
    record.sourceOpportunityState === "queued" &&
    !record.satisfiesRequestId &&
    records.some(
      (r) =>
        r.status === "approved" &&
        r.sourceOpportunityId === record.sourceOpportunityId &&
        r.capabilityId !== cap.id &&
        r.capability.repo === cap.repo &&
        r.capability.name === cap.name &&
        r.capability.product === cap.product &&
        r.capability.project === cap.project,
    );
  return (
    <article className="rc-detail">
      <a href={path({ capability: cap.id })}>‹ 返回能力版本</a>
      <header>
        <h2>{record.title}</h2>
        <strong>{statusName[record.status]}</strong>
      </header>
      <dl>
        <dt>使用方</dt>
        <dd>
          <a href={profile(record)}>
            {record.product} / {record.project} ↗
          </a>
        </dd>
        <dt>维护方</dt>
        <dd>
          <a href={profile(cap)}>
            {cap.product} / {cap.project} ↗
          </a>
        </dd>
        <dt>目标仓库</dt>
        <dd>
          <a href={repoUrl(cap.repo)} target="_blank" rel="noreferrer">
            {cap.repo} ↗
          </a>
        </dd>
        <dt>依据的版本</dt>
        <dd>
          {cap.name} · {cap.version}
        </dd>
      </dl>
      <p className="rc-prose">{record.detail}</p>
      {record.satisfiesRequestId && (
        <section className="rc-proof">
          <h3>使用方的替代版本验证</h3>
          <a href={path({ request: record.satisfiesRequestId })}>查看已解决的原仓需求 ↗</a>
          <p className="rc-prose">{record.satisfactionEvidence}</p>
          {record.satisfactionReference && (
            <p>
              <Reference text={record.satisfactionReference} />
            </p>
          )}
          <small>
            {record.satisfactionActor}
            {record.satisfactionAt && (
              <>
                {" "}
                ·{" "}
                <time dateTime={record.satisfactionAt}>
                  {new Date(record.satisfactionAt).toLocaleString("zh-CN")}
                </time>
              </>
            )}
          </small>
        </section>
      )}
      {resolutions.length > 0 && (
        <section className="rc-proof">
          <h3>使用方已验证的版本</h3>
          <ul>
            {resolutions.map((r) => (
              <li key={r.id}>
                <a href={path({ request: r.id })}>
                  {r.capability.version} · {r.title} ↗
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {record.status === "approved" && !record.runId && (
        <p className="rc-plan-state">
          {record.opportunityState === "skipped" ? (
            <strong>维护项目已跳过此候选</strong>
          ) : (
            <>
              <strong>工程计划待生成</strong>　
              {record.planProblem || "等待维护项目的执行仓库可用或当前任务结束。"}
            </>
          )}
        </p>
      )}
      {record.status === "pending" && record.questionId && (
        <CapabilityDecision
          requestId={record.id}
          revision={record.revision}
          questionId={record.questionId}
          onSaved={onSaved}
        />
      )}
      <div className="rc-actions">
        {gapToConfirm && record.sourceOpportunityId && (
          <a
            href={path({
              capability: cap.id,
              consumer: projectPath(record),
              opportunity: record.sourceOpportunityId,
            })}
          >
            用这个版本核对已批缺口 ↗
          </a>
        )}
        {record.questionId && <MessageDelegate messageId={record.questionId} personal/>}
        <a
          href={chatRoomLink({
            project: cap.product + "/" + cap.project,
            draft: `讨论开源能力维护需求「${record.title}」\n使用方：${record.product}/${record.project} · 维护仓：${cap.repo}\n直达审批：#capabilities?request=${record.id}`,
          })}
        >
          到群聊讨论 ↗
        </a>
        {record.sourceOpportunityId && (
          <a href={"#opportunities?" + new URLSearchParams({ item: record.sourceOpportunityId })}>
            返回使用方的原候选 ↗
          </a>
        )}
        {record.status === "approved" &&
          record.sourceOpportunityId &&
          record.sourceOpportunityState === "queued" && (
            <a
              href={path({
                repo: cap.repo,
                consumer: projectPath(record),
                opportunity: record.sourceOpportunityId,
              })}
            >
              为使用方核对其他版本 ↗
            </a>
          )}
        {record.opportunityId && (
          <a href={"#opportunities?" + new URLSearchParams({ item: record.opportunityId })}>
            查看维护项目候选 ↗
          </a>
        )}
        {record.runId && <a href={"#workflows/" + encodeURIComponent(record.runId)}>查看工程计划 ↗</a>}
        {(record.status === "changes" || record.status === "rejected") && !editing && (
          <>
            <button type="button" onClick={() => setEditing("gap")}>
              修订后再提交
            </button>
            {record.sourceOpportunityId && record.sourceOpportunityState === "queued" && (
              <button type="button" onClick={() => setEditing("reuse")}>
                改用现有版本
              </button>
            )}
          </>
        )}
      </div>
      {editing && (
        <RequestForm
          cap={cap}
          mode={editing}
          previous={record}
          projects={projects}
          consumer={projectPath(record)}
          cancel={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            onSaved(r);
          }}
        />
      )}
      {(record.mode === "gap" || record.revisions.length > 1) && (
        <>
          <h3>需求与审批历史</h3>
          <ol className="rc-history">
            {record.revisions.map((v) => (
              <li key={v.revision}>
                <strong>
                  r{v.revision} · {v.title}
                </strong>
                <p>
                  {statusName[v.status]}
                  {v.actor ? " · " + v.actor : ""}
                </p>
                {v.openedAt && (
                  <small>
                    提出于 <time dateTime={v.openedAt}>{new Date(v.openedAt).toLocaleString("zh-CN")}</time>
                    {v.decidedAt && (
                      <>
                        {" "}
                        · 决定于{" "}
                        <time dateTime={v.decidedAt}>{new Date(v.decidedAt).toLocaleString("zh-CN")}</time>
                      </>
                    )}
                  </small>
                )}
                {v.feedback && <blockquote>{v.feedback}</blockquote>}
                <details>
                  <summary>该版内容</summary>
                  <p className="rc-prose">{v.detail}</p>
                </details>
              </li>
            ))}
          </ol>
        </>
      )}
    </article>
  );
}

export function RepositoryCapabilities({ nav }: { nav: ReactNode }) {
  const [data, setData] = useState<RepoCapabilityIndex>();
  const [error, setError] = useState(""),
    [register, setRegister] = useState(false),
    [mode, setMode] = useState<"reuse" | "gap" | null>(null);
  const [repo, setRepo] = useState(() => new URLSearchParams(location.hash.split("?")[1]).get("repo") ?? ""),
    [search, setSearch] = useState("");
  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const result = await request<RepoCapabilityIndex>(base);
      if (id === seq.current) {
        setData(result);
        setError("");
      }
    } catch (err) {
      if (id === seq.current) setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      seq.current++;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);
  const query = new URLSearchParams(location.hash.split("?")[1]);
  const consumer = query.get("consumer") ?? "",
    wanted = query.get("capability"),
    requestId = query.get("request");
  const source = query.get("opportunity");
  const origin = { ...(consumer ? { consumer } : {}), ...(source ? { opportunity: source } : {}) } as Record<
    string,
    string
  >;
  const makeLink = (id: string) => path({ capability: id, ...origin });
  const repos = [...new Set((data?.projects ?? []).flatMap((p) => p.repos))].sort();
  const term = search.trim().toLocaleLowerCase();
  const filtered = (data?.capabilities ?? []).filter(
    (c) =>
      (!repo || c.repo === repo) &&
      [c.name, c.repo, c.version, c.interfaceRef].some((s) => s.toLocaleLowerCase().includes(term)),
  );
  const record = data?.requests.find((r) => r.id === requestId);
  const cap =
    (data?.capabilities ?? []).find((c) => c.id === (record?.capabilityId ?? wanted)) ??
    (!wanted && !requestId ? filtered[0] : undefined);
  const selected = cap && data?.requests.filter((r) => r.capabilityId === cap.id);
  const saved = (r: Adoption) => {
    setMode(null);
    setRegister(false);
    setData((d) => d && { ...d, requests: [r, ...d.requests.filter((i) => i.id !== r.id)] });
    location.hash = path({ request: r.id });
    void load();
  };
  const reset = () => {
    setMode(null);
    setRegister(false);
    location.hash = path(origin);
  };
  const newVersion = () => {
    setMode(null);
    setRegister(true);
  };
  return (
    <section className="zo-product rc-page" aria-label="开源能力目录">
      <header className="rc-head">
        {nav}
        <div>
          <a href="#projects">项目目录 ↗</a>
          <h1>开源能力</h1>
        </div>
        <button type="button" onClick={newVersion}>
          登记版本
        </button>
      </header>
      {error && (
        <p role="alert">
          {error} <button onClick={() => void load()}>重新读取</button>
        </p>
      )}
      {!data && !error && <p role="status">正在读取能力版本…</p>}
      {data && (
        <>
          {register && (
            <RegisterVersion
              projects={data.projects}
              cancel={() => setRegister(false)}
              onSaved={(c) => {
                setRegister(false);
                setSearch("");
                setRepo("");
                setData(
                  (d) => d && { ...d, capabilities: [c, ...d.capabilities.filter((i) => i.id !== c.id)] },
                );
                location.hash = makeLink(c.id);
                void load();
              }}
            />
          )}
          <div className="rc-layout">
            <aside className="rc-list">
              <h2>可用版本</h2>
              <label>
                维护仓库
                <select
                  aria-label="维护仓库"
                  value={repo}
                  onChange={(e) => {
                    setRepo(e.target.value);
                    reset();
                  }}
                >
                  <option value="">全部仓库</option>
                  {repos.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <input
                type="search"
                aria-label="检索能力版本"
                placeholder="按能力、版本、命令查找"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  reset();
                }}
              />
              {filtered.length ? (
                <ul>
                  {filtered.map((v) => (
                    <li key={v.id}>
                      <a
                        aria-current={cap?.id === v.id ? "true" : undefined}
                        href={makeLink(v.id)}
                        onClick={() => {
                          setRegister(false);
                          setMode(null);
                        }}
                      >
                        <strong>{v.name}</strong>
                        <small>
                          {v.repo} · {v.version}
                        </small>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rc-discover">
                  <p>
                    {data.capabilities.length ? "当前条件没有匹配的版本。" : "尚未登记仓库提供的能力版本。"}
                  </p>
                  <p>要找尚未登记的库，可在终端查询 GitHub。把关键词和账号换成你的搜索条件。</p>
                  <code>opc-os capability discover '关键词' --owner 'GitHub账号'</code>
                </div>
              )}
            </aside>
            <div className="rc-main">
              {record && cap ? (
                <RequestDetail
                  key={record.id + record.revision}
                  record={record}
                  cap={cap}
                  projects={data.projects}
                  records={data.requests}
                  onSaved={saved}
                />
              ) : (requestId || wanted) && !cap ? (
                <p>
                  找不到这条记录。<button onClick={reset}>返回目录</button>
                </p>
              ) : cap ? (
                <article className="rc-detail">
                  <small>
                    维护项目　{cap.product} / {cap.project}
                  </small>
                  <header>
                    <h2>{cap.name}</h2>
                    <strong>{cap.version}</strong>
                  </header>
                  <dl>
                    <dt>维护仓库</dt>
                    <dd>
                      <a href={repoUrl(cap.repo)} target="_blank" rel="noreferrer">
                        {cap.repo} ↗
                      </a>
                    </dd>
                    <dt>调用入口</dt>
                    <dd>
                      <Reference text={cap.interfaceRef} />
                    </dd>
                    <dt>版本凭据</dt>
                    <dd>
                      <Reference text={cap.evidence} />
                    </dd>
                  </dl>
                  <div className="rc-actions">
                    <button type="button" className="rc-primary" onClick={() => setMode("reuse")}>
                      直接复用此版本
                    </button>
                    <button type="button" onClick={() => setMode("gap")}>
                      向维护项目提需求
                    </button>
                  </div>
                  {mode && (
                    <RequestForm
                      key={cap.id + mode}
                      cap={cap}
                      mode={mode}
                      consumer={consumer}
                      projects={data.projects}
                      approvedGaps={data.requests.filter(
                        (r) =>
                          mode === "reuse" &&
                          Boolean(source) &&
                          r.sourceOpportunityId === source &&
                          r.status === "approved" &&
                          r.capabilityId !== cap.id &&
                          r.capability.repo === cap.repo &&
                          r.capability.name === cap.name &&
                          r.capability.product === cap.product &&
                          r.capability.project === cap.project,
                      )}
                      onSaved={saved}
                      cancel={() => setMode(null)}
                    />
                  )}
                  <h3>复用与补充需求</h3>
                  {selected?.length ? (
                    <ul className="rc-records">
                      {selected.map((r) => (
                        <li key={r.id}>
                          <a href={path({ request: r.id })}>{r.title} ↗</a>
                          <span>
                            {projectPath(r)} · {statusName[r.status]}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>还没有项目登记使用或提出需求。</p>
                  )}
                </article>
              ) : (
                <article className="rc-detail">
                  <h2>从已有仓库开始</h2>
                  <p>登记一个可用版本、调用入口与凭据，其他项目就能在这里找到它。</p>
                  <button onClick={newVersion}>登记能力版本</button>
                </article>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function CapabilityDecision({
  requestId,
  revision,
  questionId,
  onChanged,
  onSaved,
}: {
  requestId: string;
  revision: number;
  questionId: string;
  onChanged?: (status: string) => Promise<void>;
  onSaved?: (record: Adoption) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sending = useRef(false);
  const decide = async (action: "approve" | "changes" | "reject") => {
    if (sending.current) return;
    if (action !== "approve" && !note.trim()) {
      setError("请写明给提出方的反馈。");
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await post<Adoption>("/requests/" + encodeURIComponent(requestId) + "/decisions", {
        revision,
        questionId,
        action,
        note: note.trim(),
      });
      onSaved?.(saved);
      if (onChanged) await onChanged(statusName[saved.status] + " · r" + saved.revision);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="rc-inbox-decision" aria-label="维护需求审批">
      <h3>维护需求审批 · r{revision}</h3>

      <label>
        给提出方的反馈
        <textarea
          rows={2}
          maxLength={3000}
          placeholder="要求修改或拒绝时，请说明原因。"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div>
        <button type="button" disabled={busy} onClick={() => void decide("approve")}>
          批准
        </button>
        <button type="button" disabled={busy} onClick={() => void decide("changes")}>
          要求修改
        </button>
        <button type="button" disabled={busy} onClick={() => void decide("reject")}>
          拒绝
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
