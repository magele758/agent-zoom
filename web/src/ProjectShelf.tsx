import { DelegateWork } from "./Delegation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { RepositorySnapshot, ZoomProject } from "../../src/project-types";
import { api, request } from "./api";
import type { ProjectProfile as Profile } from "../../src/project-profile-types";
import { ProjectProfile } from "./CompanyProfiles";
import "./projects.css";

const stamp = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function Time({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value} title={value}>{isNaN(date.getTime()) ? value : stamp.format(date)}</time>;
}

export function GitHubLink({ href, children }: { href: string; children: ReactNode }) {
  try {
    const url = new URL(href);
    if (url.origin === "https://github.com" && !url.username && !url.password) {
      return <a href={url.href} rel="noreferrer" target="_blank">{children}</a>;
    }
  } catch { /* A malformed saved URL can still be displayed as text. */ }
  return <>{children}</>;
}

function matchesRepo(repo: RepositorySnapshot, term: string) {
  return [repo.fullName, repo.description ?? ""].some(value => value.toLocaleLowerCase().includes(term));
}

function RepoDetails({ repo, expanded }: { repo: RepositorySnapshot; expanded: boolean }) {
  const base = repo.url.replace(/\/$/, "");
  return <details className="shelf-repo" open={expanded}>
    <summary><h3>{repo.fullName}</h3>{repo.fork && <small>Fork</small>}</summary>
    <div className="shelf-repo-content">
      {repo.description && <p className="shelf-description">{repo.description}</p>}
      <div className="shelf-repo-origin"><GitHubLink href={repo.url}>在 GitHub 打开 ↗</GitHubLink>
        <a href={"#capabilities?" + new URLSearchParams({repo:repo.fullName})}>此仓库的可用能力 ↗</a>
        <a href={"#activity-index?" + new URLSearchParams({view:"repos",repo:repo.fullName})}>浏览仓库内容 ↗</a>
        <span>维护动态每 15 分钟检查 · 上次成功 <Time value={repo.syncedAt} /></span></div>
      <dl className="shelf-stats">
        <div><dt>未结 Issue</dt><dd><GitHubLink href={base + "/issues?q=is%3Aissue+is%3Aopen"}>{repo.openIssues}</GitHubLink></dd></div>
        <div><dt>未结 PR</dt><dd><GitHubLink href={base + "/pulls?q=is%3Apr+is%3Aopen"}>{repo.openPullRequests}</GitHubLink></dd></div>
        <div><dt>最新发布</dt><dd>{repo.latestRelease ? <><GitHubLink href={repo.latestRelease.url}>{repo.latestRelease.tag}</GitHubLink>
          <small><Time value={repo.latestRelease.publishedAt} /></small></> : <span className="shelf-no-release">暂无发布</span>}</dd></div>
      </dl>
      <h4>最近事项</h4>
      {repo.items.length ? <ul className="shelf-items">{repo.items.map(item => <li key={item.kind + item.number}>
        <span className="shelf-item-kind">{item.kind === "issue" ? "Issue" : "PR"}</span>
        <div><GitHubLink href={item.url}>{item.title}</GitHubLink><small>{repo.fullName}#{item.number}</small></div>
        <Time value={item.updatedAt} />
        <DelegateWork label="委派跟进" operation={{key:"github:"+repo.fullName+"#"+item.number,title:"跟进 "+repo.fullName+"#"+item.number+" · "+item.title,href:"#activity-index?"+new URLSearchParams({view:"repos",repo:repo.fullName}),detail:item.kind+" · "+item.url+" · "+item.title}}/>
      </li>)}</ul> : <p className="shelf-note">此次同步没有返回最近事项。</p>}
    </div>
  </details>;
}

function shellArgument(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

type ProfileIndex = { profiles: Profile[]; onIndexChanged: () => void };
function CompanyProjects({ product, onInbox, profiles, onIndexChanged }: ProfileIndex & { product: string; onInbox: (path: string) => void }) {
  const names = profiles.filter(p => p.product === product).map(p => p.project);
  const [adding, setAdding] = useState(false);
  const [profile, setProfile] = useState(() => new URLSearchParams(location.hash.split("?")[1]).get("project") ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await api.createCompanyProject(product, name.trim());
      setName(""); setAdding(false); onIndexChanged();
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <section className="shelf-scopes"><div className="shelf-repo-head"><h3>产品下的项目</h3>
    <button type="button" aria-expanded={adding} onClick={() => setAdding(!adding)}>登记子项目</button></div>
    {error && <p role="alert">{error}</p>}
    {adding && <form className="shelf-form" onSubmit={add}><label>子项目名称<input value={name} required maxLength={160} onChange={e => setName(e.target.value)} /></label>
      <button disabled={busy || !name.trim()}>保存子项目</button></form>}
    {names.map(item => <div className="shelf-scope-row" key={item}>
      <button type="button" aria-label={item} aria-expanded={profile === item} onClick={() => setProfile(v => v === item ? "" : item)}>{item}</button>
      <button type="button" className="shelf-scope" aria-label={item + "的群聊"} onClick={() => onInbox(product + "/" + item)}>群聊 ↗</button>
      <a className="shelf-scope" href={"#capabilities?" + new URLSearchParams({consumer:product + "/" + item})}>查找可复用能力 ↗</a>
      {profile === item && <>
        <a className="shelf-scope" href={"#security-department?" + new URLSearchParams({product,project:item})}>项目安全评审 ↗</a>
        <a className="shelf-scope" href={"#operations-department?" + new URLSearchParams({product,project:item})}>项目服务与更新 ↗</a>
        <ProjectProfile product={product} project={item} onSaved={onIndexChanged} />
        <DelegateWork key={product+"/"+item} label="委派梳理项目待办" operation={{key:"project:"+product+"/"+item,title:"梳理项目待办 · "+item,href:"#projects?"+new URLSearchParams({product,project:item}),detail:"梳理 "+product+" / "+item+" 的任务、证据和需要负责人决定的事项。"}}/></>}
    </div>)}
    {names.length === 0 && <p className="shelf-note">登记后可以按项目归集日常投入和阶段任务。</p>}
  </section>;
}

function ProjectDetails({ project, term, onProgress, onInbox, onBack, profiles, onIndexChanged }: ProfileIndex & {
  project: ZoomProject; term: string; onProgress: (name: string) => void; onInbox: (name: string) => void; onBack: () => void;
}) {
  return <section className="shelf-detail" aria-label="产品详情">
    <button type="button" className="shelf-back" onClick={onBack}>‹ 产品列表</button>
    <header className="shelf-detail-head"><h2>{project.name}</h2><div className="shelf-actions">
      <button type="button" onClick={() => onInbox(project.name)}>群聊 ↗</button>
      <button type="button" onClick={() => onProgress(project.name)}>产品进程 ↗</button>
    </div></header>
    <CompanyProjects product={project.name} onInbox={onInbox} profiles={profiles} onIndexChanged={onIndexChanged} />
    <div className="shelf-repo-head"><h3>关联仓库</h3><span>{project.repositories.length} 个</span></div>
    {project.repositories.length ? project.repositories.map((repo, index) =>
      <RepoDetails key={repo.fullName} repo={repo} expanded={term ? matchesRepo(repo, term) || index === 0 : index === 0} />) :
      <div className="shelf-no-repo"><h3>暂无关联仓库</h3><p>可以先在产品下登记项目并安排工作。有公开仓库时，在终端同步一次即可关联。</p>
        <code>opc-os project sync owner/repo --product {shellArgument(project.name)}</code></div>}
  </section>;
}

type Props = { initialProduct?: string; nav: ReactNode; onProgress: (product: string) => void; onInbox: (folder: string) => void };

export function ProjectShelf({ nav, onProgress, onInbox, initialProduct = "" }: Props) {
  const [projects, setProjects] = useState<ZoomProject[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(initialProduct);
  const [mobileDetail, setMobileDetail] = useState(Boolean(initialProduct));
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const submitPending = useRef(false);

  useEffect(() => {
    const generation = ++version.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([api.projects(controller.signal), request<{ profiles: Profile[] }>("/api/opc/projects/profiles", { signal: controller.signal })]).then(([result, scoped]) => {
      if (generation === version.current) { setProjects(result.projects); setProfiles(scoped.profiles); }
    }).catch(reason => {
      if (generation === version.current) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (generation === version.current) setLoading(false); });
    return () => { version.current++; controller.abort(); };
  }, [revision]);
  useEffect(() => { if (formOpen) input.current?.focus(); }, [formOpen]);

  function openCreate() {
    setFormError(""); setNotice(""); setFormOpen(true);
    input.current?.focus();
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (submitPending.current) return;
    const cleanName = name.trim();
    if (!cleanName || cleanName.includes("/") || cleanName.includes("\\")) {
      setFormError("请输入一个目录名，名称中不能包含斜杠。");
      input.current?.focus();
      return;
    }
    submitPending.current = true;
    setSaving(true);
    setFormError("");
    try {
      const result = await api.createProject(cleanName);
      version.current++;
      setProjects(prev => [...(prev ?? []).filter(p => p.name !== result.project.name), result.project]
        .sort((a,b) => a.name.localeCompare(b.name, "zh-CN")));
      setRevision(value => value + 1);
      setSelected(result.project.name); setQuery(""); setMobileDetail(true);
      setNotice(result.created ? "已创建产品 " + result.project.name : "已打开现有产品 " + result.project.name);
      setFormOpen(false); setName("");
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitPending.current = false;
      setSaving(false);
    }
  }

  const term = query.trim().toLocaleLowerCase();
  const matches = term ? profiles.filter(p => [p.project, p.layer, p.domain].some(value => value.toLocaleLowerCase().includes(term))) : [];
  const visible = (projects ?? []).filter(project => matches.some(p => p.product === project.name) || project.name.toLocaleLowerCase().includes(term)
    || project.repositories.some(repo => matchesRepo(repo, term)));
  const active = visible.find(p => p.name === selected) ?? visible[0];

  return <section className="zo-product shelf-page" aria-label="项目目录">
    <header className="zo-product-head shelf-head">{nav}<h1>项目目录</h1>
      <button type="button" className="shelf-new" onClick={openCreate} aria-expanded={formOpen}>新建产品</button>
    </header>
    <div className="shelf-body"><a href="#ideas" className="shelf-scope">查看公司的信息与想法 ↗</a>　<a href="#activity-index?view=repos" className="shelf-scope">查看所有已发现仓库 ↗</a>　<a href="#capabilities" className="shelf-scope">浏览开源能力 ↗</a>
      {formOpen && <form className="shelf-form" onSubmit={create}>
        <label htmlFor="shelf-project-name">产品名称</label>
        <input id="shelf-project-name" ref={input} value={name} onChange={e => setName(e.target.value)}
          required maxLength={160} disabled={saving} autoComplete="off" />
        <button type="submit" disabled={saving}>{saving ? "创建中…" : "创建"}</button>
        <button type="button" disabled={saving} onClick={() => setFormOpen(false)}>取消</button>
        {formError && <p role="alert">{formError}</p>}
      </form>}
      {notice && <p className="shelf-notice" role="status">{notice}</p>}
      {error && <p className="shelf-error" role="alert">读取项目目录失败。{error} <button type="button" onClick={() => setRevision(v => v + 1)}>重试</button></p>}
      {projects === null && loading && <p className="shelf-note" role="status">正在读取项目目录…</p>}
      {projects && <div className="shelf-layout" data-pane={mobileDetail && active ? "detail" : "list"}>
        <section className="shelf-index" aria-label="产品列表">
          <div className="shelf-index-head"><h2>全部产品 <span>{projects.length}</span></h2>
            <button type="button" onClick={() => setRevision(v => v + 1)} disabled={loading}>刷新目录</button></div>
          {projects.length > 0 && <input className="shelf-search" type="search" aria-label="搜索目录"
            placeholder="产品、项目、仓库、层级或领域" value={query} onChange={e => setQuery(e.target.value)} />}
          {visible.length > 0 ? <ul className="shelf-projects">{visible.map(project => <li key={project.name}>
            <button type="button" aria-label={project.name} aria-pressed={project.name === active?.name} onClick={() => {
              setSelected(project.name); setMobileDetail(true); setNotice("");
            }}><strong>{project.name}</strong><span>{project.repositories.length ? project.repositories.length + " 个仓库" : "尚无仓库"}</span></button>
            {matches.filter(p => p.product === project.name).map(p => <a className="shelf-match" key={p.project}
              href={"#projects?" + new URLSearchParams({product:p.product,project:p.project})}>
              <strong>{p.project} ↗</strong><small>{[p.layer, p.domain].filter(Boolean).join(" · ")}</small></a>)}
          </li>)}</ul> : <p className="shelf-note">{term ? "没有匹配的目录项。" : "暂无产品。可点击「新建产品」添加。"}</p>}
        </section>
        {active && <ProjectDetails key={active.name} profiles={profiles} onIndexChanged={() => setRevision(n => n + 1)} project={active} term={term} onProgress={onProgress} onInbox={onInbox} onBack={() => setMobileDetail(false)} />}
      </div>}
    </div>
  </section>;
}
